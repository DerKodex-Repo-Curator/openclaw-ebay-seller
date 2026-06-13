import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShippingFulfillment } from "./fulfillment-write.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-fulw-"));
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
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.fulfillment"],
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

describe("createShippingFulfillment", () => {
  it("POSTs to /order/{id}/shipping_fulfillment with line items + tracking", async () => {
    const cap = captureSend(201);
    await createShippingFulfillment(
      config,
      {
        orderId: "12-34567-89012",
        lineItems: [{ lineItemId: "li-1", quantity: 1 }],
        trackingNumber: "1Z999",
        shippingCarrierCode: "UPS",
      },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.method).toBe("POST");
    expect(cap.seen.url).toBe(
      "https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment"
    );
    expect(cap.seen.body).toEqual({
      lineItems: [{ lineItemId: "li-1", quantity: 1 }],
      trackingNumber: "1Z999",
      shippingCarrierCode: "UPS",
    });
  });

  it("omits tracking fields when not provided", async () => {
    const cap = captureSend(201);
    await createShippingFulfillment(
      config,
      { orderId: "o1", lineItems: [{ lineItemId: "li-1", quantity: 2 }] },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.body).toEqual({
      lineItems: [{ lineItemId: "li-1", quantity: 2 }],
    });
  });
});
