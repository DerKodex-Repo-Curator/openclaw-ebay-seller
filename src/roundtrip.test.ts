import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startAuth,
  completeAuth,
  getValidAccessToken,
  getAuthStatus,
  type SellerAuthConfig,
} from "./auth.js";
import { readUserToken, type UserToken } from "./secrets.js";

let dir: string;
let config: SellerAuthConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ebay-seller-rt-"));
  const credsPath = join(dir, "creds.json");
  await writeFile(
    credsPath,
    JSON.stringify({
      client_id: "App-Id",
      cert_id: "cert",
      ru_name: "Ru-Name",
      environment: "sandbox",
    })
  );
  config = {
    credentialsPath: credsPath,
    userTokenPath: join(dir, "token.json"),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fetchReturning(json: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => json }) as Response) as unknown as typeof fetch;
}

const exchangeJson = {
  access_token: "AT",
  expires_in: 7200,
  refresh_token: "RT",
  refresh_token_expires_in: 47304000,
  token_type: "User Access Token",
};

describe("OAuth round-trip (file-backed)", () => {
  it("start → callback persists a token and status reports connected", async () => {
    const { authorizeUrl, state } = await startAuth(config);
    expect(authorizeUrl).toContain("state=" + state);

    const result = await completeAuth(
      config,
      `https://host/cb?code=THECODE&state=${state}`,
      { fetchImpl: fetchReturning(exchangeJson) }
    );
    expect(result.connected).toBe(true);

    const saved = await readUserToken(config.userTokenPath);
    expect(saved?.access_token).toBe("AT");
    expect(saved?.refresh_token).toBe("RT");

    const status = await getAuthStatus(config);
    expect(status.connected).toBe(true);
    expect(status.environment).toBe("sandbox");
  });

  it("rejects a callback whose state doesn't match the issued one", async () => {
    await startAuth(config);
    await expect(
      completeAuth(config, "https://host/cb?code=X&state=WRONG", {
        fetchImpl: fetchReturning(exchangeJson),
      })
    ).rejects.toThrow(/state mismatch/i);
  });

  it("rejects a callback when no auth was started", async () => {
    await expect(
      completeAuth(config, "https://host/cb?code=X&state=Y", {
        fetchImpl: fetchReturning(exchangeJson),
      })
    ).rejects.toThrow(/No pending OAuth request/i);
  });

  it("rejects a callback with no code", async () => {
    const { state } = await startAuth(config);
    await expect(
      completeAuth(config, `https://host/cb?state=${state}`, {
        fetchImpl: fetchReturning(exchangeJson),
      })
    ).rejects.toThrow(/No authorization code/i);
  });
});

describe("getValidAccessToken", () => {
  it("refreshes a near-expiry access token and writes it back", async () => {
    const now = 2_000_000_000_000;
    const stale: UserToken = {
      access_token: "old",
      refresh_token: "RT",
      token_type: "User Access Token",
      expires_at: new Date(now - 1000).toISOString(), // already expired
      refresh_expires_at: new Date(now + 47304000_000).toISOString(),
      scopes: ["https://api.ebay.com/oauth/api_scope/sell.inventory"],
      environment: "sandbox",
    };
    const { writeUserToken } = await import("./secrets.js");
    await writeUserToken(config.userTokenPath, stale);

    const refreshed = await getValidAccessToken(config, {
      now,
      fetchImpl: fetchReturning({
        access_token: "fresh",
        expires_in: 7200,
        token_type: "User Access Token",
      }),
    });
    expect(refreshed.access_token).toBe("fresh");
    expect((await readUserToken(config.userTokenPath))?.access_token).toBe(
      "fresh"
    );
  });

  it("throws actionable errors when not connected / refresh expired", async () => {
    await expect(getValidAccessToken(config)).rejects.toThrow(/Not connected/i);

    const expired: UserToken = {
      access_token: "x",
      refresh_token: "RT",
      token_type: "User Access Token",
      expires_at: new Date(0).toISOString(),
      refresh_expires_at: new Date(1000).toISOString(),
      scopes: [],
      environment: "sandbox",
    };
    const { writeUserToken } = await import("./secrets.js");
    await writeUserToken(config.userTokenPath, expired);
    await expect(getValidAccessToken(config, { now: 5000 })).rejects.toThrow(
      /refresh token has expired/i
    );
  });
});
