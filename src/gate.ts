import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod } from "node:fs/promises";
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
    throw err;
  }
}

async function writePending(
  config: GateConfig,
  records: PendingRecord[]
): Promise<void> {
  const path = pendingPath(config);
  await writeFile(path, JSON.stringify(records, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Cryptographically-random, URL-safe approval token. */
export function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * Stage a write for later confirmation. Persists the action (crash-safe) with a
 * TTL and returns the token + summary the operator confirms with. Prunes
 * already-expired records while it's here.
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
  const live = (await readPending(config)).filter(
    (r) => Date.parse(r.expires_at) > now
  );
  live.push(record);
  await writePending(config, live);
  return {
    status: "pending_approval",
    token: record.token,
    summary: record.summary,
    expires_at: record.expires_at,
  };
}

/**
 * Redeem a staged token: single-use (removed whether or not it's still valid),
 * then validated for expiry. Throws an actionable error if the token is unknown
 * or expired.
 */
export async function redeemPending(
  config: GateConfig,
  token: string,
  now: number = Date.now()
): Promise<PendingRecord> {
  const records = await readPending(config);
  const idx = records.findIndex((r) => r.token === token);
  if (idx === -1) {
    throw new Error(
      "No pending action found for that token (already confirmed, expired, or never issued). Re-run the original tool to stage a new one."
    );
  }
  const [record] = records.splice(idx, 1);
  // Single-use: persist the removal before deciding validity, so an expired or
  // about-to-execute token can never be redeemed twice.
  await writePending(config, records);
  if (Date.parse(record.expires_at) <= now) {
    throw new Error(
      `Pending action expired at ${record.expires_at}. Re-run the original tool to stage a new one.`
    );
  }
  return record;
}

async function logExecution(
  config: GateConfig,
  d: { toolName: string; action: string; summary: string },
  approvedAt: string,
  res: ExecutorResult,
  now: number
): Promise<void> {
  if (!config.opsLogPath) return;
  await appendOpsLog(config.opsLogPath, {
    ts: new Date(now).toISOString(),
    tool_name: d.toolName,
    action: d.action,
    user_approved_at: approvedAt,
    request_summary: d.summary,
    response_status: res.status,
    ebay_request_id: res.ebayRequestId,
  });
}

/**
 * The entry point write tools call. With `autoApprove`, runs the executor
 * immediately and logs it as auto-approved. Otherwise stages the action and
 * returns a pending-approval envelope for the operator to confirm.
 */
export async function runGated(
  config: GateConfig,
  descriptor: MutationDescriptor,
  registry: MutationRegistry,
  now: number = Date.now()
): Promise<
  | { status: "executed"; action: string; autoApproved: true; result: unknown }
  | { status: "pending_approval"; token: string; summary: string; expires_at: string }
> {
  if (config.autoApprove) {
    const exec = registry[descriptor.action];
    if (!exec) {
      throw new Error(
        `No executor registered for action '${descriptor.action}'.`
      );
    }
    const res = await exec(descriptor.params, config);
    await logExecution(config, descriptor, "auto", res, now);
    return {
      status: "executed",
      action: descriptor.action,
      autoApproved: true,
      result: res.result,
    };
  }
  return stagePending(config, descriptor, now);
}

/**
 * Redeem a token and execute the staged write. Called by the
 * `ebay_seller_confirm_pending` tool.
 */
export async function confirmPending(
  config: GateConfig,
  token: string,
  registry: MutationRegistry,
  now: number = Date.now()
): Promise<{ status: "executed"; action: string; confirmed: true; result: unknown }> {
  const record = await redeemPending(config, token, now);
  const exec = registry[record.action];
  if (!exec) {
    throw new Error(
      `No executor registered for action '${record.action}'. The tool that stages it may not be loaded.`
    );
  }
  const res = await exec(record.params, config);
  await logExecution(config, record, new Date(now).toISOString(), res, now);
  return {
    status: "executed",
    action: record.action,
    confirmed: true,
    result: res.result,
  };
}
