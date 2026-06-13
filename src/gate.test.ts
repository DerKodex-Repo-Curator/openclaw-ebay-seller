import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGated,
  confirmPending,
  stagePending,
  redeemPending,
  DEFAULT_PENDING_TTL_MS,
  type GateConfig,
  type MutationRegistry,
  type MutationDescriptor,
} from "./gate.js";

let dir: string;
let config: GateConfig;
let calls: unknown[];
let registry: MutationRegistry;

const descriptor: MutationDescriptor = {
  toolName: "ebay_seller_publish_offer",
  action: "publish_offer",
  summary: "Publish offer o-1 (SKU SKU-1) — goes LIVE",
  params: { offerId: "o-1" },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-gate-"));
  config = {
    credentialsPath: join(dir, "creds.json"), // unused by the gate
    userTokenPath: join(dir, "token.json"),
    opsLogPath: join(dir, "ops.jsonl"),
  };
  calls = [];
  registry = {
    publish_offer: async (params) => {
      calls.push(params);
      return { result: { listingId: "L-123" }, status: 200, ebayRequestId: "req-1" };
    },
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function opsLines(): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(config.opsLogPath!, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("runGated — default (autoApprove off): stages, does not execute", () => {
  it("returns a pending_approval token and does NOT run the executor", async () => {
    const out = await runGated(config, descriptor, registry);
    expect(out.status).toBe("pending_approval");
    expect(calls).toHaveLength(0); // <-- nothing executed
    if (out.status === "pending_approval") {
      expect(out.token).toBeTruthy();
      expect(out.summary).toContain("goes LIVE");
    }
    expect(await opsLines()).toHaveLength(0); // no write happened → no log
  });
});

describe("confirmPending — gate-pass within TTL", () => {
  it("redeems the token, runs the executor, and logs the execution", async () => {
    const staged = await runGated(config, descriptor, registry);
    const token = staged.status === "pending_approval" ? staged.token : "";
    const now = Date.now();
    const out = await confirmPending(config, token, registry, now);
    expect(out.status).toBe("executed");
    expect(out.result).toEqual({ listingId: "L-123" });
    expect(calls).toEqual([{ offerId: "o-1" }]);
    const log = await opsLines();
    expect(log).toHaveLength(1);
    expect(log[0].tool_name).toBe("ebay_seller_publish_offer");
    expect(log[0].user_approved_at).toBe(new Date(now).toISOString()); // not "auto"
    expect(log[0].response_status).toBe(200);
    expect(log[0].ebay_request_id).toBe("req-1");
  });
});

describe("autoApprove — gate-bypass", () => {
  it("executes immediately and logs with user_approved_at='auto', no token", async () => {
    const out = await runGated(
      { ...config, autoApprove: true },
      descriptor,
      registry
    );
    expect(out.status).toBe("executed");
    expect(calls).toEqual([{ offerId: "o-1" }]);
    const log = await opsLines();
    expect(log).toHaveLength(1);
    expect(log[0].user_approved_at).toBe("auto");
  });

  it("throws if no executor is registered for the action", async () => {
    await expect(
      runGated({ ...config, autoApprove: true }, descriptor, {})
    ).rejects.toThrow(/No executor registered/);
  });
});

describe("gate-reject — expired token", () => {
  it("rejects confirmation after the TTL and does not execute", async () => {
    const now = 1_900_000_000_000;
    const staged = await stagePending(config, descriptor, now);
    await expect(
      confirmPending(config, staged.token, registry, now + DEFAULT_PENDING_TTL_MS + 1)
    ).rejects.toThrow(/expired/i);
    expect(calls).toHaveLength(0);
  });
});

describe("single-use — double redeem", () => {
  it("a token confirmed once cannot be confirmed again", async () => {
    const staged = await runGated(config, descriptor, registry);
    const token = staged.status === "pending_approval" ? staged.token : "";
    await confirmPending(config, token, registry);
    await expect(confirmPending(config, token, registry)).rejects.toThrow(
      /No pending action found/i
    );
    expect(calls).toHaveLength(1); // executed exactly once
  });

  it("an expired token is also consumed (cannot be retried after expiry)", async () => {
    const now = 1_900_000_000_000;
    const staged = await stagePending(config, descriptor, now);
    await expect(
      redeemPending(config, staged.token, now + DEFAULT_PENDING_TTL_MS + 1)
    ).rejects.toThrow(/expired/i);
    // second attempt: gone entirely
    await expect(
      redeemPending(config, staged.token, now + DEFAULT_PENDING_TTL_MS + 1)
    ).rejects.toThrow(/No pending action found/i);
  });
});

describe("confirmPending — unknown token / missing executor", () => {
  it("rejects an unknown token", async () => {
    await expect(confirmPending(config, "nope", registry)).rejects.toThrow(
      /No pending action found/i
    );
  });

  it("rejects when the staged action has no registered executor", async () => {
    const staged = await runGated(config, descriptor, registry);
    const token = staged.status === "pending_approval" ? staged.token : "";
    await expect(confirmPending(config, token, {})).rejects.toThrow(
      /No executor registered/
    );
  });
});

describe("multiple staged actions coexist", () => {
  it("confirming one leaves the other redeemable", async () => {
    const a = await stagePending(config, { ...descriptor, params: { offerId: "A" } });
    const b = await stagePending(config, { ...descriptor, params: { offerId: "B" } });
    await confirmPending(config, a.token, registry);
    const out = await confirmPending(config, b.token, registry);
    expect(out.status).toBe("executed");
    expect(calls).toEqual([{ offerId: "A" }, { offerId: "B" }]);
  });

  it("a stage racing a confirm does not resurrect the redeemed token", async () => {
    const staged = await runGated(config, descriptor, registry);
    const token = staged.status === "pending_approval" ? staged.token : "";
    // Fire a new stage and the confirm concurrently — the lock must serialize
    // them so the confirmed token isn't written back by the racing stage.
    await Promise.all([
      stagePending(config, { ...descriptor, params: { offerId: "X" } }),
      confirmPending(config, token, registry),
    ]);
    // The original token is now consumed and must not be redeemable again.
    await expect(confirmPending(config, token, registry)).rejects.toThrow(
      /No pending action found/i
    );
  });
});

describe("BLOCKER: concurrent confirm of the same token executes exactly once", () => {
  it("two parallel confirmPending calls → one executes, one rejects", async () => {
    const staged = await runGated(config, descriptor, registry);
    const token = staged.status === "pending_approval" ? staged.token : "";
    const results = await Promise.allSettled([
      confirmPending(config, token, registry),
      confirmPending(config, token, registry),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(calls).toHaveLength(1); // <-- executed exactly once, no double-publish
  });
});

describe("autoApprove is strict === true (default-deny against truthy garbage)", () => {
  for (const bad of ["false", "true", "no", "yes", 1, 0, null] as const) {
    it(`treats autoApprove=${JSON.stringify(bad)} as NOT enabled → stages`, async () => {
      const out = await runGated(
        { ...config, autoApprove: bad as unknown as boolean },
        descriptor,
        registry
      );
      expect(out.status).toBe("pending_approval");
      expect(calls).toHaveLength(0);
    });
  }

  it("only boolean true executes immediately", async () => {
    const out = await runGated({ ...config, autoApprove: true }, descriptor, registry);
    expect(out.status).toBe("executed");
  });
});

describe("audit trail on executor failure", () => {
  it("logs a failed attempt (with error) and consumes the token (no retry)", async () => {
    const failing: MutationRegistry = {
      publish_offer: async () => {
        throw new Error("eBay 500");
      },
    };
    const staged = await runGated(config, descriptor, failing);
    const token = staged.status === "pending_approval" ? staged.token : "";
    await expect(confirmPending(config, token, failing)).rejects.toThrow(/eBay 500/);
    const log = await opsLines();
    expect(log).toHaveLength(1);
    expect(log[0].error).toMatch(/eBay 500/);
    // token consumed — cannot retry a possibly-partial non-idempotent write
    await expect(confirmPending(config, token, failing)).rejects.toThrow(
      /No pending action found/i
    );
  });

  it("surfaces an audit_warning when opsLogPath is unset but still executes", async () => {
    const noLog = { ...config, opsLogPath: undefined };
    const out = await runGated({ ...noLog, autoApprove: true }, descriptor, registry);
    expect(out.status).toBe("executed");
    if (out.status === "executed") {
      expect(out.audit_warning).toMatch(/not audit-logged/i);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("corrupt pending file does not brick the gate", () => {
  it("a non-JSON pending file is treated as empty (fail-closed)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(config.userTokenPath + ".pending.json", "{ this is not json");
    // staging still works (corrupt store dropped, not thrown)
    const out = await runGated(config, descriptor, registry);
    expect(out.status).toBe("pending_approval");
  });
});
