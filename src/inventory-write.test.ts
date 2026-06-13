import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrReplaceInventoryItem, createOffer } from "./inventory-write.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-invw-"));
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

/** Capture method/url/headers/body and return a canned response. */
function captureSend(status: number, json?: unknown) {
  const seen: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {};
  const f = (async (url: string, init: RequestInit) => {
    seen.method = init.method;
    seen.url = url as string;
    seen.headers = init.headers as Record<string, string>;
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

describe("createOrReplaceInventoryItem", () => {
  it("PUTs to /inventory_item/{sku} with Content-Language and an assembled body", async () => {
    const cap = captureSend(204);
    const r = await createOrReplaceInventoryItem(
      config,
      {
        sku: "CAM-001",
        title: "Nikon D750 Body",
        condition: "USED_EXCELLENT",
        quantity: 2,
        description: "Great shape",
        imageUrls: ["https://img/1.jpg"],
        aspects: { Brand: ["Nikon"], Model: ["D750"] },
      },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.method).toBe("PUT");
    expect(cap.seen.url).toBe(
      "https://api.ebay.com/sell/inventory/v1/inventory_item/CAM-001"
    );
    expect(cap.seen.headers!["Content-Language"]).toBe("en-US");
    expect(cap.seen.body).toEqual({
      availability: { shipToLocationAvailability: { quantity: 2 } },
      condition: "USED_EXCELLENT",
      product: {
        title: "Nikon D750 Body",
        description: "Great shape",
        imageUrls: ["https://img/1.jpg"],
        aspects: { Brand: ["Nikon"], Model: ["D750"] },
      },
    });
    expect(r.status).toBe(204);
    expect(r.data).toBeUndefined(); // 204 = no body, handled cleanly (idempotent replace)
  });

  it("omits optional product fields when not provided", async () => {
    const cap = captureSend(200);
    await createOrReplaceInventoryItem(
      config,
      { sku: "S1", title: "T", condition: "NEW", quantity: 1 },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.body).toEqual({
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: "NEW",
      product: { title: "T" },
    });
  });
});

describe("createOffer", () => {
  it("POSTs an unpublished offer with price + policies and returns the offerId", async () => {
    const cap = captureSend(201, { offerId: "9988" });
    const r = await createOffer(
      config,
      {
        sku: "CAM-001",
        marketplaceId: "EBAY_US",
        categoryId: "31388",
        price: 749.95,
        availableQuantity: 1,
        paymentPolicyId: "pp-1",
        returnPolicyId: "rp-1",
        fulfillmentPolicyId: "fp-1",
      },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.method).toBe("POST");
    expect(cap.seen.url).toBe("https://api.ebay.com/sell/inventory/v1/offer");
    expect(cap.seen.body).toMatchObject({
      sku: "CAM-001",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      categoryId: "31388",
      availableQuantity: 1,
      listingPolicies: {
        paymentPolicyId: "pp-1",
        returnPolicyId: "rp-1",
        fulfillmentPolicyId: "fp-1",
      },
      pricingSummary: { price: { value: "749.95", currency: "USD" } },
    });
    expect(r.data).toEqual({ offerId: "9988" });
  });

  it("omits listingPolicies entirely when no policy ids are given", async () => {
    const cap = captureSend(201, { offerId: "1" });
    await createOffer(
      config,
      { sku: "S", marketplaceId: "EBAY_US", categoryId: "1", price: 10 },
      { fetchImpl: cap.fetch }
    );
    expect(cap.seen.body).not.toHaveProperty("listingPolicies");
    expect((cap.seen.body as { availableQuantity: number }).availableQuantity).toBe(1);
  });
});
