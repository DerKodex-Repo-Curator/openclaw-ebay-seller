import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBusinessPolicies } from "./account.js";
import type { SellApiConfig } from "./api.js";
import { writeUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellApiConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-acct-"));
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
    scopes: ["https://api.ebay.com/oauth/api_scope/sell.account.readonly"],
    environment: "production",
  };
  config = { credentialsPath: credsPath, userTokenPath: join(dir, "token.json") };
  await writeUserToken(config.userTokenPath, token);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("getBusinessPolicies", () => {
  it("fetches all three policy types for the marketplace and groups them", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (u: string) => {
      seen.push(u as string);
      // Return a body keyed by which policy endpoint was hit.
      const kind = (u as string).includes("payment_policy")
        ? { paymentPolicies: [{ id: "pay-1" }] }
        : (u as string).includes("return_policy")
          ? { returnPolicies: [{ id: "ret-1" }] }
          : { fulfillmentPolicies: [{ id: "ful-1" }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(kind) } as Response;
    }) as unknown as typeof fetch;

    const out = await getBusinessPolicies(
      config,
      { marketplaceId: "EBAY_US" },
      { fetchImpl: fakeFetch }
    );

    expect(seen.sort()).toEqual([
      "https://api.ebay.com/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US",
      "https://api.ebay.com/sell/account/v1/payment_policy?marketplace_id=EBAY_US",
      "https://api.ebay.com/sell/account/v1/return_policy?marketplace_id=EBAY_US",
    ]);
    expect(out.marketplaceId).toBe("EBAY_US");
    expect(out.paymentPolicies).toEqual({ paymentPolicies: [{ id: "pay-1" }] });
    expect(out.returnPolicies).toEqual({ returnPolicies: [{ id: "ret-1" }] });
    expect(out.fulfillmentPolicies).toEqual({
      fulfillmentPolicies: [{ id: "ful-1" }],
    });
  });

  it("surfaces an eBay error (e.g. not opted into Business Policies) from any policy call", async () => {
    const fakeFetch = (async (u: string) => {
      if ((u as string).includes("return_policy")) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () =>
            JSON.stringify({
              errors: [{ errorId: 20403, longMessage: "Not opted in to Business Policies" }],
            }),
        } as Response;
      }
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;

    await expect(
      getBusinessPolicies(config, { marketplaceId: "EBAY_US" }, { fetchImpl: fakeFetch })
    ).rejects.toThrow(/\[20403\] Not opted in to Business Policies/);
  });
});
