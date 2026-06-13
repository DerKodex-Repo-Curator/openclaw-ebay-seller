import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updateOffer,
  publishOffer,
  withdrawOffer,
  getOfferStatus,
} from "./offer-write.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";
import {
  runGated,
  confirmPending,
  type GateConfig,
  type MutationRegistry,
} from "./gate.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-offw-"));
  const credsPath = join(dir, "creds.json");
  await writeFile(
    credsPath,
    JSON.stringify({
      client_id: "App-Id",
      cert_id: "cert",
      ru_name: "Ru-Name",
      environment: "production",
    })
  );
  const token: UserToken = {
    access_token: "AT",
    refresh_token: "RT",
    token_type: "User Access Token",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 47304000_000).toISOString(),
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
    environment: "production",
  };
  config = { credentialsPath: credsPath, userTokenPath: join(dir, "token.json") };
  await writeUserToken(config.userTokenPath, token);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function captureSend(status: number, json?: unknown) {
  const seen: { method?: string; url?: string; body?: unknown } = {};
  const f = (async (url: string, init: RequestInit) => {
    seen.method = init.method;
    seen.url = url as string;
    seen.body = init.body ? JSON.parse(init.body as string) : undefined;
    return {
      ok: status < 400,
      status,
      statusText: "",
      headers: { get: () => null },
      text: async () => (json !== undefined ? JSON.stringify(json) : ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}

describe("getOfferStatus", () => {
  it("returns the offer's status", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "PUBLISHED" }),
      }) as Response) as unknown as typeof fetch;
    expect(await getOfferStatus(config, "o-1", { fetchImpl: f })).toBe("PUBLISHED");
  });

  it("returns UNKNOWN when eBay omits a status (caller treats as live)", async () => {
    const f = (async () =>
      ({ ok: true, status: 200, text: async () => "{}" }) as Response) as unknown as typeof fetch;
    expect(await getOfferStatus(config, "o-1", { fetchImpl: f })).toBe("UNKNOWN");
  });
});

describe("updateOffer", () => {
  it("PATCHes only the provided fields", async () => {
    const cap = captureSend(204);
    await updateOffer(
      config,
      { offerId: "o-9", price: 199.99, availableQuantity: 3 },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.method).toBe("PATCH");
    expect(cap.seen.url).toBe("https://api.ebay.com/sell/inventory/v1/offer/o-9");
    expect(cap.seen.body).toEqual({
      availableQuantity: 3,
      pricingSummary: { price: { value: "199.99", currency: "USD" } },
    });
  });
});

describe("publishOffer / withdrawOffer", () => {
  it("publishOffer POSTs to /publish and returns the listingId", async () => {
    const cap = captureSend(200, { listingId: "L-1" });
    const r = await publishOffer(config, { offerId: "o-1" }, { fetchImpl: cap.fetch });
    expect(cap.seen.method).toBe("POST");
    expect(cap.seen.url).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/o-1/publish"
    );
    expect(r.data).toEqual({ listingId: "L-1" });
  });

  it("withdrawOffer POSTs to /withdraw", async () => {
    const cap = captureSend(200, { listingId: "L-1" });
    await withdrawOffer(config, { offerId: "o-1" }, { fetchImpl: cap.fetch });
    expect(cap.seen.url).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer/o-1/withdraw"
    );
  });
});

describe("publish_offer hard-gate, end to end (the core safety property)", () => {
  it("does NOT publish on the first call; publishes only after confirm_pending", async () => {
    let publishCalls = 0;
    const publishFetch = (async (url: string) => {
      if ((url as string).endsWith("/publish")) publishCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ listingId: "L-1" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const registry: MutationRegistry = {
      publish_offer: async (params, cfg) => {
        const r = await publishOffer(cfg, params as { offerId: string }, {
          fetchImpl: publishFetch,
        });
        return { result: r.data, status: r.status };
      },
    };
    const gcfg: GateConfig = { ...config, opsLogPath: join(dir, "ops.jsonl") };
    const descriptor = {
      toolName: "ebay_seller_publish_offer",
      action: "publish_offer",
      summary: "PUBLISH offer o-1 — goes LIVE",
      params: { offerId: "o-1" },
    };

    // First call: staged, NOT published.
    const staged = await runGated(gcfg, descriptor, registry);
    expect(staged.status).toBe("pending_approval");
    expect(publishCalls).toBe(0); // <-- nothing went live

    // Confirm: now it publishes, exactly once.
    const token = staged.status === "pending_approval" ? staged.token : "";
    const out = await confirmPending(gcfg, token, registry);
    expect(out.status).toBe("executed");
    expect(out.result).toEqual({ listingId: "L-1" });
    expect(publishCalls).toBe(1);
  });

  it("autoApprove=true publishes immediately (no token)", async () => {
    let publishCalls = 0;
    const publishFetch = (async () => {
      publishCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ listingId: "L-2" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const registry: MutationRegistry = {
      publish_offer: async (params, cfg) => {
        const r = await publishOffer(cfg, params as { offerId: string }, {
          fetchImpl: publishFetch,
        });
        return { result: r.data, status: r.status };
      },
    };
    const gcfg: GateConfig = {
      ...config,
      autoApprove: true,
      opsLogPath: join(dir, "ops.jsonl"),
    };
    const out = await runGated(
      gcfg,
      {
        toolName: "ebay_seller_publish_offer",
        action: "publish_offer",
        summary: "PUBLISH offer o-1 — goes LIVE",
        params: { offerId: "o-1" },
      },
      registry
    );
    expect(out.status).toBe("executed");
    expect(publishCalls).toBe(1);
  });
});
