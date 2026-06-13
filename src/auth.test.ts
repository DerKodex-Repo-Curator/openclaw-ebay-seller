import { describe, it, expect } from "vitest";
import {
  SELLER_SCOPES,
  STATE_TTL_MS,
  apiBaseUrl,
  authorizeBaseUrl,
  buildAuthorizeUrl,
  parseCallbackInput,
  generateState,
  isStateValid,
  redactAuthHeaders,
  exchangeCodeForToken,
  refreshUserToken,
  refreshTokenExpired,
} from "./auth.js";
import type { SellerCredentials, UserToken } from "./secrets.js";

const CREDS: SellerCredentials = {
  client_id: "App-Id-123",
  cert_id: "secret-cert",
  ru_name: "Jason-Vaughan-RuName-abc",
  redirect_url: "https://volta.example.ts.net/ebay-seller/callback",
  environment: "sandbox",
};

describe("environment base URLs", () => {
  it("maps sandbox vs production for api + authorize", () => {
    expect(apiBaseUrl("sandbox")).toBe("https://api.sandbox.ebay.com");
    expect(apiBaseUrl("production")).toBe("https://api.ebay.com");
    expect(authorizeBaseUrl("sandbox")).toBe(
      "https://auth.sandbox.ebay.com/oauth2/authorize"
    );
    expect(authorizeBaseUrl("production")).toBe(
      "https://auth.ebay.com/oauth2/authorize"
    );
  });
});

describe("buildAuthorizeUrl", () => {
  it("uses the RuName as redirect_uri and includes all scopes + state", () => {
    const url = new URL(buildAuthorizeUrl(CREDS, SELLER_SCOPES, "state-xyz"));
    expect(url.origin + url.pathname).toBe(
      "https://auth.sandbox.ebay.com/oauth2/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("App-Id-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "Jason-Vaughan-RuName-abc"
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toBe(SELLER_SCOPES.join(" "));
  });
});

describe("generateState", () => {
  it("returns distinct, non-trivial url-safe tokens", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("parseCallbackInput", () => {
  it("extracts code + state from a full redirect URL", () => {
    const r = parseCallbackInput(
      "https://host/ebay-seller/callback?code=ABC123&state=st-1&extra=x"
    );
    expect(r).toEqual({ code: "ABC123", state: "st-1" });
  });

  it("extracts from a bare query string", () => {
    expect(parseCallbackInput("?code=ZZ&state=qq")).toEqual({
      code: "ZZ",
      state: "qq",
    });
  });

  it("url-decodes encoded codes", () => {
    const r = parseCallbackInput("https://h/cb?code=v%5E1.1%23abc&state=s");
    expect(r.code).toBe("v^1.1#abc");
  });

  it("returns nulls when code/state absent", () => {
    expect(parseCallbackInput("https://h/cb?error=access_denied")).toEqual({
      code: null,
      state: null,
    });
  });
});

describe("isStateValid", () => {
  const now = 1_000_000_000_000;
  const pending = {
    state: "good",
    issued_at: new Date(now).toISOString(),
    scopes: SELLER_SCOPES,
  };

  it("accepts a matching state within the TTL", () => {
    expect(isStateValid(pending, "good", now + 60_000)).toBe(true);
  });

  it("rejects a mismatched state", () => {
    expect(isStateValid(pending, "bad", now)).toBe(false);
  });

  it("rejects an expired state", () => {
    expect(isStateValid(pending, "good", now + STATE_TTL_MS + 1)).toBe(false);
  });
});

describe("redactAuthHeaders", () => {
  it("scrubs Basic and Bearer material", () => {
    const out = redactAuthHeaders("Authorization: Basic QWxhZGRpbg== / Bearer v^1.x");
    expect(out).not.toContain("QWxhZGRpbg==");
    expect(out).not.toContain("v^1.x");
    expect(out).toContain("[REDACTED]");
  });
});

describe("exchangeCodeForToken", () => {
  it("posts authorization_code with the RuName and maps the response", async () => {
    const now = 1_700_000_000_000;
    let captured: { url: string; body: string; auth: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = {
        url: url as string,
        body: (init.body as URLSearchParams).toString(),
        auth: (init.headers as Record<string, string>).Authorization,
      };
      return {
        ok: true,
        json: async () => ({
          access_token: "AT",
          expires_in: 7200,
          refresh_token: "RT",
          refresh_token_expires_in: 47304000,
          token_type: "User Access Token",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const token = await exchangeCodeForToken(CREDS, "CODE", fakeFetch, 5000, now);

    expect(captured!.url).toBe(
      "https://api.sandbox.ebay.com/identity/v1/oauth2/token"
    );
    expect(captured!.body).toContain("grant_type=authorization_code");
    expect(captured!.body).toContain("code=CODE");
    expect(captured!.body).toContain("redirect_uri=Jason-Vaughan-RuName-abc");
    expect(captured!.auth).toMatch(/^Basic /);
    expect(token.access_token).toBe("AT");
    expect(token.refresh_token).toBe("RT");
    expect(token.environment).toBe("sandbox");
    expect(token.scopes).toEqual(SELLER_SCOPES);
    expect(Date.parse(token.expires_at)).toBe(now + 7200 * 1000);
    expect(Date.parse(token.refresh_expires_at)).toBe(now + 47304000 * 1000);
  });

  it("throws a redacted error on a non-OK response", async () => {
    const fakeFetch = (async () =>
      ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () =>
          JSON.stringify({ error: "invalid_grant", error_description: "bad code" }),
      }) as Response) as unknown as typeof fetch;
    await expect(exchangeCodeForToken(CREDS, "x", fakeFetch)).rejects.toThrow(
      /invalid_grant: bad code/
    );
  });
});

describe("refreshUserToken", () => {
  const existing: UserToken = {
    access_token: "old-AT",
    refresh_token: "RT",
    token_type: "User Access Token",
    expires_at: new Date(0).toISOString(),
    refresh_expires_at: new Date(9_999_999_999_999).toISOString(),
    scopes: SELLER_SCOPES,
    environment: "sandbox",
  };

  it("mints a new access token and carries the refresh token forward", async () => {
    const now = 1_700_000_500_000;
    let body = "";
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = (init.body as URLSearchParams).toString();
      return {
        ok: true,
        json: async () => ({
          access_token: "new-AT",
          expires_in: 7200,
          token_type: "User Access Token",
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const out = await refreshUserToken(CREDS, existing, fakeFetch, 5000, now);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=RT");
    expect(out.access_token).toBe("new-AT");
    expect(out.refresh_token).toBe("RT"); // unchanged
    expect(out.refresh_expires_at).toBe(existing.refresh_expires_at); // unchanged
    expect(Date.parse(out.expires_at)).toBe(now + 7200 * 1000);
  });
});

describe("refreshTokenExpired", () => {
  it("is true once the refresh expiry has passed", () => {
    const t = { refresh_expires_at: new Date(1000).toISOString() } as UserToken;
    expect(refreshTokenExpired(t, 2000)).toBe(true);
    expect(refreshTokenExpired(t, 500)).toBe(false);
  });
});
