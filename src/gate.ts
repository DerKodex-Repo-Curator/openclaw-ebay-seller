import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { expandHome } from "./secrets.js";
import { appendOpsLog } from "./ops-log.js";
import type { SellApiConfig } from "./api.js";

/**
 * Config for the approval gate: the Sell API config plus the gate knobs.
 * `autoApprove` collapses the two-step flow into immediate execution;
 * `pendingApprovalTtlMs` bounds how long a staged token stays redeemable;
 * `opsLogPath` is where executed writes are recorded.
 */
export interface GateConfig extends SellApiConfig {
  autoApprove?: boolean;
  pendingApprovalTtlMs?: number;
  opsLogPath?: string;
}

export const DEFAULT_PENDING_TTL_MS = 15 * 60_000;

/** Describes a write the caller wants to perform, gated. */
export interface MutationDescriptor {
  /** The tool surfacing the write (for the audit log). */
  toolName: string;
  /** Stable action key — maps to an executor in the registry. */
  action: string;
  /** Human-readable summary shown to the operator at the approval step. */
  summary: string;
  /** Opaque params persisted with the staged action and replayed on execute. */
  params: unknown;
}

export interface ExecutorResult {
  result: unknown;
  /** HTTP status from eBay, for the audit log. */
  status?: number;
  /** eBay's request id (X-EBAY-C-REQUEST-ID / rlogid), for the audit log. */
  ebayRequestId?: string;
}

export type MutationExecutor = (
  params: unknown,
  config: GateConfig
) => Promise<ExecutorResult>;

/** action key → executor. Write tools (S5+) populate this; empty until then. */
export type MutationRegistry = Record<string, MutationExecutor>;

interface PendingRecord {
  token: string;
  toolName: string;
  action: string;
  summary: string;
  params: unknown;
  created_at: string;
  expires_at: string;
}

// ── In-process serialization of the pending-file read-modify-write ────────────
// All mutations of the pending store run through this lock so two concurrent
// confirm_pending calls (or a stage racing a confirm) can't double-execute a
// token or clobber the file. One gateway process owns the file, so an
// in-process chain is sufficient (no cross-process locking needed).
let pendingLock: Promise<unknown> = Promise.resolve();
function withPendingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = pendingLock.then(fn, fn);
  pendingLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function pendingPath(config: GateConfig): string {
  return expandHome(config.userTokenPath) + ".pending.json";
}

async function readPending(config: GateConfig): Promise<PendingRecord[]> {
  try {
    const raw = await readFile(pendingPath(config), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PendingRecord[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A corrupt pending file (e.g. crash mid-write before atomic rename landed)
    // must NOT brick the gate. Fail closed: drop the unreadable store — pending
    // tokens are short-lived and re-stageable — rather than throwing on every
    // future gated write.
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

/** Atomic write: temp file at 0600 then rename, so a crash mid-write can't
 *  leave a truncated/corrupt store (rename is atomic on POSIX). */
async function writePending(
  config: GateConfig,
  records: PendingRecord[]
): Promise<void> {
  const path = pendingPath(config);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/** Cryptographically-random, URL-safe approval token. */
export function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

function isExpired(record: PendingRecord, now: number): boolean {
  const exp = Date.parse(record.expires_at);
  // A malformed expiry must fail CLOSED (treat as expired), never fail open.
  return Number.isNaN(exp) || exp <= now;
}

/**
 * Stage a write for later confirmation. Persists the action (crash-safe) with a
 * TTL and returns the token + summary the operator confirms with. Prunes
 * already-expired records while it's here. Serialized via the pending lock.
 */
export async function stagePending(
  config: GateConfig,
  descriptor: MutationDescriptor,
  now: number = Date.now()
): Promise<{
  status: "pending_approval";
  token: string;
  summary: string;
  expires_at: string;
}> {
  const ttl = config.pendingApprovalTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const record: PendingRecord = {
    token: generateToken(),
    toolName: descriptor.toolName,
    action: descriptor.action,
    summary: descriptor.summary,
    params: descriptor.params,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
  };
  await withPendingLock(async () => {
    const live = (await readPending(config)).filter((r) => !isExpired(r, now));
    live.push(record);
    await writePending(config, live);
  });
  return {
    status: "pending_approval",
    token: record.token,
    summary: record.summary,
    expires_at: record.expires_at,
  };
}

/**
 * Redeem a staged token: single-use (removed under the lock, whether or not
 * still valid), then validated for expiry. Throws an actionable error if the
 * token is unknown or expired. The whole read-remove-write is serialized, so
 * two concurrent redemptions of the same token can never both succeed.
 */
export async function redeemPending(
  config: GateConfig,
  token: string,
  now: number = Date.now()
): Promise<PendingRecord> {
  return withPendingLock(async () => {
    const records = await readPending(config);
    const idx = records.findIndex((r) => r.token === token);
    if (idx === -1) {
      throw new Error(
        "No pending action found for that token (already confirmed, expired, or never issued). Re-run the original tool to stage a new one."
      );
    }
    const [record] = records.splice(idx, 1);
    // Persist the removal (single-use) before deciding validity, so an expired
    // or about-to-execute token can never be redeemed twice.
    await writePending(config, records);
    if (isExpired(record, now)) {
      throw new Error(
        `Pending action expired at ${record.expires_at}. Re-run the original tool to stage a new one.`
      );
    }
    return record;
  });
}

/**
 * Record an execution to the ops log. NEVER throws — a post-execution logging
 * failure must not masquerade as an execution failure (which would prompt a
 * retry and double-write a non-idempotent eBay op). Returns a warning string
 * when the write couldn't be audited so the caller can surface it.
 */
async function logExecution(
  config: GateConfig,
  d: { toolName: string; action: string; summary: string },
  approvedAt: string,
  res: { status?: number; ebayRequestId?: string },
  now: number,
  error?: string
): Promise<string | undefined> {
  if (!config.opsLogPath) {
    return "no opsLogPath configured — this execution was NOT audit-logged";
  }
  try {
    await appendOpsLog(config.opsLogPath, {
      ts: new Date(now).toISOString(),
      tool_name: d.toolName,
      action: d.action,
      user_approved_at: approvedAt,
      request_summary: d.summary,
      response_status: res.status,
      ebay_request_id: res.ebayRequestId,
      error,
    });
    return undefined;
  } catch (err) {
    return `ops-log write failed (${err instanceof Error ? err.message : String(err)}) — execution succeeded but was not audited`;
  }
}

/** Run an executor, logging both success and failure to the audit trail. The
 *  token is already consumed by the caller, so a throw here does not allow a
 *  retry (correct for non-idempotent eBay writes — no accidental double-write). */
async function executeAndLog(
  config: GateConfig,
  d: MutationDescriptor,
  approvedAt: string,
  registry: MutationRegistry,
  now: number
): Promise<{ result: unknown; audit_warning?: string }> {
  const exec = registry[d.action];
  if (!exec) {
    throw new Error(
      `No executor registered for action '${d.action}'. The tool that stages it may not be loaded.`
    );
  }
  let res: ExecutorResult;
  try {
    res = await exec(d.params, config);
  } catch (err) {
    // Log the failed attempt (token already consumed) before re-throwing, so a
    // write that eBay may have partially performed still leaves an audit trace.
    await logExecution(
      config,
      d,
      approvedAt,
      {},
      now,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
  const warning = await logExecution(config, d, approvedAt, res, now);
  return { result: res.result, ...(warning ? { audit_warning: warning } : {}) };
}

/**
 * The entry point write tools call. With `autoApprove === true`, runs the
 * executor immediately and logs it as auto-approved. ANY other value (false,
 * undefined, the string "false", 0, null, …) falls through to staging —
 * default-deny, never trusting external coercion of the flag.
 */
export async function runGated(
  config: GateConfig,
  descriptor: MutationDescriptor,
  registry: MutationRegistry,
  now: number = Date.now()
): Promise<
  | {
      status: "executed";
      action: string;
      autoApproved: true;
      result: unknown;
      audit_warning?: string;
    }
  | { status: "pending_approval"; token: string; summary: string; expires_at: string }
> {
  if (config.autoApprove === true) {
    const { result, audit_warning } = await executeAndLog(
      config,
      descriptor,
      "auto",
      registry,
      now
    );
    return {
      status: "executed",
      action: descriptor.action,
      autoApproved: true,
      result,
      ...(audit_warning ? { audit_warning } : {}),
    };
  }
  return stagePending(config, descriptor, now);
}

/**
 * Redeem a token and execute the staged write. Called by the
 * `ebay_seller_confirm_pending` tool. Redemption is single-use + serialized, so
 * concurrent confirmations of one token resolve to exactly one execution.
 */
export async function confirmPending(
  config: GateConfig,
  token: string,
  registry: MutationRegistry,
  now: number = Date.now()
): Promise<{
  status: "executed";
  action: string;
  confirmed: true;
  result: unknown;
  audit_warning?: string;
}> {
  const record = await redeemPending(config, token, now);
  const { result, audit_warning } = await executeAndLog(
    config,
    record,
    new Date(now).toISOString(),
    registry,
    now
  );
  return {
    status: "executed",
    action: record.action,
    confirmed: true,
    result,
    ...(audit_warning ? { audit_warning } : {}),
  };
}
