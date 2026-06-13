import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sellApiGet, formatEbayErrors, type SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-api-"));
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
  // A fresh, far-from-expiry token so getValidAccessToken never tries to refresh.
  const token: UserToken = {
    access_token: "LIVE-AT",
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

describe("formatEbayErrors", () => {
  it("surfaces eBay's longMessage with the errorId", () => {
    const body = JSON.stringify({
      errors: [{ errorId: 25001, message: "short", longMessage: "the long one" }],
    });
    expect(formatEbayErrors(body)).toBe("[25001] the long one");
  });

  it("joins multiple errors", () => {
    const body = JSON.stringify({
      errors: [{ errorId: 1, message: "a" }, { errorId: 2, message: "b" }],
    });
    expect(formatEbayErrors(body)).toBe("[1] a; [2] b");
  });

  it("falls back to raw text for non-JSON bodies", () => {
    expect(formatEbayErrors("upstream 502")).toBe("upstream 502");
  });
});

describe("sellApiGet", () => {
  it("targets the production host, sets the bearer token, and encodes query params", async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: url as string,
        headers: init.headers as Record<string, string>,
      };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ total: 0 }),
      } as Response;
    }) as unknown as typeof fetch;

    const out = await sellApiGet(
      config,
      "/sell/inventory/v1/inventory_item",
      { limit: 25, offset: 0, empty: undefined },
      { fetchImpl: fakeFetch }
    );

    expect(captured!.url).toBe(
      "https://api.ebay.com/sell/inventory/v1/inventory_item?limit=25&offset=0"
    );
    expect(captured!.headers.Authorization).toBe("Bearer LIVE-AT");
    expect(out).toEqual({ total: 0 });
  });

  it("omits the query string entirely when there are no params", async () => {
    let url = "";
    const fakeFetch = (async (u: string) => {
      url = u as string;
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;
    await sellApiGet(config, "/sell/inventory/v1/inventory_item/ABC", {}, {
      fetchImpl: fakeFetch,
    });
    expect(url).toBe("https://api.ebay.com/sell/inventory/v1/inventory_item/ABC");
  });

  it("sets the marketplace header when provided", async () => {
    let headers: Record<string, string> = {};
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;
    await sellApiGet(config, "/x", {}, {
      fetchImpl: fakeFetch,
      marketplaceId: "EBAY_US",
    });
    expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
  });

  it("returns undefined for a 204", async () => {
    const fakeFetch = (async () =>
      ({ ok: true, status: 204, text: async () => "" }) as Response) as unknown as typeof fetch;
    expect(
      await sellApiGet(config, "/x", {}, { fetchImpl: fakeFetch })
    ).toBeUndefined();
  });

  it("throws with eBay's error message on a non-OK response", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () =>
          JSON.stringify({ errors: [{ errorId: 1100, longMessage: "Access denied" }] }),
      }) as Response) as unknown as typeof fetch;
    await expect(
      sellApiGet(config, "/sell/inventory/v1/offer", {}, { fetchImpl: fakeFetch })
    ).rejects.toThrow(/403 Forbidden.*\[1100\] Access denied/);
  });
});
