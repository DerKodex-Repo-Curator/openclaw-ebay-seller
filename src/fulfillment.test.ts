import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrders, getOrder } from "./fulfillment.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-ful-"));
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

function captureFetch(json: unknown): { fetch: typeof fetch; url: () => string } {
  let seen = "";
  const f = (async (u: string) => {
    seen = u as string;
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as Response;
  }) as unknown as typeof fetch;
  return { fetch: f, url: () => seen };
}

describe("getOrders", () => {
  it("passes filter + paging as query params (filter value is URL-encoded)", async () => {
    const cap = captureFetch({ total: 0, orders: [] });
    await getOrders(
      config,
      { filter: "orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}", limit: 50, offset: 0 },
      { fetchImpl: cap.fetch }
    );
    const u = new URL(cap.url());
    expect(u.origin + u.pathname).toBe(
      "https://api.ebay.com/sell/fulfillment/v1/order"
    );
    expect(u.searchParams.get("filter")).toBe(
      "orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}"
    );
    expect(u.searchParams.get("limit")).toBe("50");
  });

  it("omits the query string when no params are given", async () => {
    const cap = captureFetch({ total: 0 });
    await getOrders(config, {}, { fetchImpl: cap.fetch });
    expect(cap.url()).toBe("https://api.ebay.com/sell/fulfillment/v1/order");
  });
});

describe("getOrder", () => {
  it("URL-encodes the order id into the path", async () => {
    const cap = captureFetch({ orderId: "12-345" });
    await getOrder(config, { orderId: "12 34/567" }, { fetchImpl: cap.fetch });
    expect(cap.url()).toBe(
      "https://api.ebay.com/sell/fulfillment/v1/order/12%2034%2F567"
    );
  });
});
