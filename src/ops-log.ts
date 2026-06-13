import { appendFile, chmod } from "node:fs/promises";
import { expandHome } from "./secrets.js";

/**
 * One line in the append-only operations log. Written for every write that
 * actually executes (whether via the two-step gate or autoApprove). The log is
 * the audit trail for anything that touched the seller's account.
 */
export interface OpsLogEntry {
  /** ISO timestamp of execution. */
  ts: string;
  tool_name: string;
  action: string;
  /** ISO timestamp the operator confirmed, or "auto" when autoApprove fired. */
  user_approved_at: string;
  request_summary: string;
  response_status?: number;
  ebay_request_id?: string;
  /** Present when the executor threw — the write attempt failed. */
  error?: string;
}

/**
 * Append one entry as a JSON line. Creates the file 0600 if absent and
 * re-tightens permissions after every write (append doesn't reset mode, but a
 * pre-existing loose file would otherwise stay loose).
 */
export async function appendOpsLog(
  opsLogPath: string,
  entry: OpsLogEntry
): Promise<void> {
  const path = expandHome(opsLogPath);
  await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}
