import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOpsLog, type OpsLogEntry } from "./ops-log.js";

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-ops-"));
  logPath = join(dir, "ops.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry: OpsLogEntry = {
  ts: "2026-06-12T22:00:00.000Z",
  tool_name: "ebay_seller_publish_offer",
  action: "publish_offer",
  user_approved_at: "auto",
  request_summary: "Publish offer o-1",
  response_status: 200,
  ebay_request_id: "req-1",
};

describe("appendOpsLog", () => {
  it("writes one JSON line per entry and accumulates", async () => {
    await appendOpsLog(logPath, entry);
    await appendOpsLog(logPath, { ...entry, action: "withdraw_offer" });
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe("publish_offer");
    expect(JSON.parse(lines[1]).action).toBe("withdraw_offer");
  });

  it("creates the log file with 0600 permissions", async () => {
    await appendOpsLog(logPath, entry);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  });
});
