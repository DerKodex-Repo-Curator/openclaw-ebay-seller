import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listInventoryItems,
  getInventoryItem,
  getOffers,
} from "./inventory.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-inv-"));
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

/** Capture the requested URL and return a canned JSON body. */
function captureFetch(json: unknown): { fetch: typeof fetch; url: () => string } {
  let seen = "";
  const f = (async (u: string) => {
    seen = u as string;
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, url: () => seen };
}

describe("listInventoryItems", () => {
  it("hits /inventory_item with limit + offset and returns the page", async () => {
    const cap = captureFetch({ total: 0, inventoryItems: [] });
    const out = await listInventoryItems(
      config,
      { limit: 50, offset: 100 },
      { fetchImpl: cap.fetch }
    );
    expect(cap.url()).toBe(
      "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=50&offset=100"
    );
    expect(out.total).toBe(0);
  });

  it("works with no paging params (empty account → total 0)", async () => {
    const cap = captureFetch({ total: 0 });
    const out = await listInventoryItems(config, {}, { fetchImpl: cap.fetch });
    expect(cap.url()).toBe(
      "https://api.ebay.com/sell/inventory/v1/inventory_item"
    );
    expect(out.total).toBe(0);
  });
});

describe("getInventoryItem", () => {
  it("URL-encodes the SKU into the path", async () => {
    const cap = captureFetch({ sku: "A/B 1" });
    await getInventoryItem(config, { sku: "A/B 1" }, { fetchImpl: cap.fetch });
    expect(cap.url()).toBe(
      "https://api.ebay.com/sell/inventory/v1/inventory_item/A%2FB%201"
    );
  });
});

describe("getOffers", () => {
  it("requires sku and passes marketplace_id + paging as query params", async () => {
    const cap = captureFetch({ total: 1, offers: [{ offerId: "o1" }] });
    const out = await getOffers(
      config,
      { sku: "SKU-1", marketplaceId: "EBAY_US", limit: 10, offset: 0 },
      { fetchImpl: cap.fetch }
    );
    expect(cap.url()).toBe(
      "https://api.ebay.com/sell/inventory/v1/offer?sku=SKU-1&marketplace_id=EBAY_US&limit=10&offset=0"
    );
    expect(out.offers).toHaveLength(1);
  });
});
