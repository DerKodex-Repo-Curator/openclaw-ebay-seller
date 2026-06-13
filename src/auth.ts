import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";
import {
  type EbayEnvironment,
  type SellerCredentials,
  type UserToken,
  expandHome,
  readCredentials,
  readUserToken,
  writeUserToken,
  fileModeIsRestrictive,
} from "./secrets.js";

export interface SellerAuthConfig {
  credentialsPath: string;
  userTokenPath: string;
  httpTimeoutMs?: number;
  tokenRefreshSafetyWindowMs?: number;
}

/** The five OAuth scopes this plugin's tools require (v0.1 surface). */
export const SELLER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
];

const SANDBOX_API = "https://api.sandbox.ebay.com";
const PRODUCTION_API = "https://api.ebay.com";
const SANDBOX_AUTHORIZE = "https://auth.sandbox.ebay.com/oauth2/authorize";
const PRODUCTION_AUTHORIZE = "https://auth.ebay.com/oauth2/authorize";

export const REFRESH_SAFETY_WINDOW_MS = 60_000;
export const HTTP_TIMEOUT_MS = 30_000;
/** How long an issued OAuth `state` stays valid for the round-trip. */
export const STATE_TTL_MS = 15 * 60_000;

export function apiBaseUrl(env: EbayEnvironment): string {
  return env === "sandbox" ? SANDBOX_API : PRODUCTION_API;
}

export function authorizeBaseUrl(env: EbayEnvironment): string {
  return env === "sandbox" ? SANDBOX_AUTHORIZE : PRODUCTION_AUTHORIZE;
}

/**
 * Redact Basic/Bearer credential material before it can reach an error message
 * or log. eBay token-error bodies can echo request material back.
 */
export function redactAuthHeaders(text: string): string {
  return text
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [REDACTED]")
    // Also scrub bare credential-bearing form fields, in case eBay echoes the
    // request body back in an error (refresh-token leakage is the worst case).
    .replace(
      /\b(refresh_token|access_token|code)=[^\s&"]+/gi,
      "$1=[REDACTED]"
    );
}

/** Cryptographically-random, URL-safe CSRF state token. */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Build the eBay authorization URL the operator opens in a browser to grant
 * the plugin access to their seller account.
 *
 * Note: eBay's `redirect_uri` parameter takes the **RuName** value, not the
 * literal HTTPS callback URL — that's an eBay-specific quirk.
 */
export function buildAuthorizeUrl(
  creds: SellerCredentials,
  scopes: string[],
  state: string
): string {
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: creds.ru_name,
    response_type: "code",
    scope: scopes.join(" "),
    state,
  });
  return `${authorizeBaseUrl(creds.environment)}?${params.toString()}`;
}

/**
 * Parse the code + state out of whatever the operator (or the live callback
 * route) hands back: a full redirect URL, a bare `?code=...&state=...` query
 * string, or a pre-split object. Returns null fields when absent.
 */
export function parseCallbackInput(input: string): {
  code: string | null;
  state: string | null;
} {
  const trimmed = input.trim();
  let query = trimmed;
  // Full URL → take the query string.
  const qIdx = trimmed.indexOf("?");
  if (/^https?:\/\//i.test(trimmed) && qIdx >= 0) {
    query = trimmed.slice(qIdx + 1);
  } else if (qIdx >= 0) {
    query = trimmed.slice(qIdx + 1);
  }
  const params = new URLSearchParams(query);
  return {
    code: params.get("code"),
    state: params.get("state"),
  };
}

// ── Pending-state persistence ────────────────────────────────────────────────
// The state issued by auth_start must survive until auth_callback runs in a
// later turn. Persist it next to the token file with an issued-at timestamp so
// stale states (>STATE_TTL_MS) are rejected.

interface PendingState {
  state: string;
  issued_at: string;
  scopes: string[];
}

function statePath(userTokenPath: string): string {
  return expandHome(userTokenPath) + ".oauth-state.json";
}

export async function writePendingState(
  userTokenPath: string,
  pending: PendingState
): Promise<void> {
  const path = statePath(userTokenPath);
  await writeFile(path, JSON.stringify(pending, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readPendingState(
  userTokenPath: string
): Promise<PendingState | null> {
  try {
    const raw = await readFile(statePath(userTokenPath), "utf8");
    return JSON.parse(raw) as PendingState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function clearPendingState(userTokenPath: string): Promise<void> {
  try {
    await unlink(statePath(userTokenPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function isStateValid(
  pending: PendingState,
  state: string,
  now: number = Date.now()
): boolean {
  if (pending.state !== state) return false;
  const issued = Date.parse(pending.issued_at);
  if (Number.isNaN(issued)) return false;
  return now - issued <= STATE_TTL_MS;
}

// ── Token endpoint calls ─────────────────────────────────────────────────────

interface CodeExchangeResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  token_type: string;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  // eBay does not rotate the refresh token on refresh, so it's omitted here.
  refresh_token?: string;
  scope?: string;
}

interface TokenError {
  error: string;
  error_description?: string;
}

async function postToken(
  creds: SellerCredentials,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const tokenUrl = `${apiBaseUrl(creds.environment)}/identity/v1/oauth2/token`;
  const basic = Buffer.from(`${creds.client_id}:${creds.cert_id}`).toString(
    "base64"
  );
  const res = await withTimeout(
    fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }),
    "ebay.identity.oauth2.token",
    timeoutMs
  );
  if (!res.ok) {
    const text = await res.text();
    let parsed: TokenError | undefined;
    try {
      parsed = JSON.parse(text) as TokenError;
    } catch {
      parsed = undefined;
    }
    const detail = parsed
      ? redactAuthHeaders(
          `${parsed.error}${parsed.error_description ? `: ${parsed.error_description}` : ""}`
        )
      : redactAuthHeaders(text).slice(0, 200);
    throw new Error(
      `eBay token request failed (${res.status} ${res.statusText}): ${detail}`
    );
  }
  return res.json();
}

/** Exchange an authorization code for a fresh user token (access + refresh). */
export async function exchangeCodeForToken(
  creds: SellerCredentials,
  code: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HTTP_TIMEOUT_MS,
  now: number = Date.now()
): Promise<UserToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.ru_name,
  });
  const data = (await postToken(
    creds,
    body,
    fetchImpl,
    timeoutMs
  )) as CodeExchangeResponse;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: data.token_type,
    expires_at: new Date(now + data.expires_in * 1000).toISOString(),
    refresh_expires_at: new Date(
      now + data.refresh_token_expires_in * 1000
    ).toISOString(),
    scopes: SELLER_SCOPES,
    environment: creds.environment,
  };
}

/**
 * Use the refresh token to mint a new access token. The refresh token itself is
 * carried forward unchanged (eBay doesn't rotate it on refresh), as is its
 * expiry — re-auth is only needed once the refresh token itself expires.
 */
export async function refreshUserToken(
  creds: SellerCredentials,
  existing: UserToken,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = HTTP_TIMEOUT_MS,
  now: number = Date.now()
): Promise<UserToken> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existing.refresh_token,
    scope: existing.scopes.join(" "),
  });
  const data = (await postToken(
    creds,
    body,
    fetchImpl,
    timeoutMs
  )) as RefreshResponse;
  return {
    ...existing,
    access_token: data.access_token,
    token_type: data.token_type,
    expires_at: new Date(now + data.expires_in * 1000).toISOString(),
    refresh_token: data.refresh_token ?? existing.refresh_token,
    // A refresh does not change the grant — we asked for exactly the stored
    // scopes — so carry them forward rather than trusting the response echo,
    // which could otherwise silently shrink what auth_status reports.
    scopes: existing.scopes,
  };
}

function accessTokenFresh(
  token: UserToken,
  safetyWindowMs: number,
  now: number = Date.now()
): boolean {
  const expiresAt = Date.parse(token.expires_at);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - now > safetyWindowMs;
}

export function refreshTokenExpired(
  token: UserToken,
  now: number = Date.now()
): boolean {
  const exp = Date.parse(token.refresh_expires_at);
  if (Number.isNaN(exp)) return false;
  return exp <= now;
}

// ── High-level operations (what the tools call) ──────────────────────────────

/** Begin the OAuth round-trip: persist a fresh state, return the authorize URL. */
export async function startAuth(
  config: SellerAuthConfig,
  now: number = Date.now()
): Promise<{ authorizeUrl: string; state: string; scopes: string[] }> {
  const creds = await readCredentials(config.credentialsPath);
  const state = generateState();
  await writePendingState(config.userTokenPath, {
    state,
    issued_at: new Date(now).toISOString(),
    scopes: SELLER_SCOPES,
  });
  return {
    authorizeUrl: buildAuthorizeUrl(creds, SELLER_SCOPES, state),
    state,
    scopes: SELLER_SCOPES,
  };
}

/**
 * Complete the OAuth round-trip from the redirect the operator pasted (or the
 * callback route captured): validate state, exchange the code, persist the
 * token, clear pending state.
 */
export async function completeAuth(
  config: SellerAuthConfig,
  callbackInput: string,
  options: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<{ connected: true; scopes: string[]; expires_at: string }> {
  const now = options.now ?? Date.now();
  const creds = await readCredentials(config.credentialsPath);
  const { code, state } = parseCallbackInput(callbackInput);
  if (!code) {
    throw new Error(
      "No authorization code found in the callback input. Paste the full redirect URL (it contains ?code=...&state=...)."
    );
  }
  const pending = await readPendingState(config.userTokenPath);
  if (!pending) {
    throw new Error(
      "No pending OAuth request found. Run ebay_seller_auth_start first, then approve in the browser."
    );
  }
  if (!state || !isStateValid(pending, state, now)) {
    throw new Error(
      "OAuth state mismatch or expired (possible CSRF, or the authorization took longer than 15 minutes). Run ebay_seller_auth_start again."
    );
  }
  // Consume the state BEFORE the exchange: a state's job ends the moment it's
  // matched. If the exchange then fails (bad code, network), the state must not
  // remain replayable for the rest of its TTL — the operator re-runs auth_start.
  await clearPendingState(config.userTokenPath);
  const token = await exchangeCodeForToken(
    creds,
    code,
    options.fetchImpl ?? fetch,
    config.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
    now
  );
  await writeUserToken(config.userTokenPath, token);
  return { connected: true, scopes: token.scopes, expires_at: token.expires_at };
}

/**
 * Return a valid access token for the seller's account, refreshing if the
 * cached one is near expiry. Every read/write tool calls this first. Throws a
 * clear, actionable error when re-auth is required.
 */
export async function getValidAccessToken(
  config: SellerAuthConfig,
  options: { fetchImpl?: typeof fetch; now?: number } = {}
): Promise<UserToken> {
  const now = options.now ?? Date.now();
  const creds = await readCredentials(config.credentialsPath);
  const token = await readUserToken(config.userTokenPath);
  if (!token) {
    throw new Error(
      "Not connected to eBay. Run ebay_seller_auth_start, approve in the browser, then ebay_seller_auth_callback."
    );
  }
  if (token.environment !== creds.environment) {
    throw new Error(
      `Stored token is for the ${token.environment} environment but credentials are set to ${creds.environment}. Re-run ebay_seller_auth_start.`
    );
  }
  if (Number.isNaN(Date.parse(token.refresh_expires_at))) {
    throw new Error(
      "Stored eBay token is missing a valid refresh-token expiry (file may be corrupt). Re-run ebay_seller_auth_start to reconnect."
    );
  }
  if (refreshTokenExpired(token, now)) {
    throw new Error(
      "eBay refresh token has expired (these last ~18 months). Re-run ebay_seller_auth_start to reconnect."
    );
  }
  const safetyWindow =
    config.tokenRefreshSafetyWindowMs ?? REFRESH_SAFETY_WINDOW_MS;
  if (accessTokenFresh(token, safetyWindow, now)) {
    return token;
  }
  const refreshed = await refreshUserToken(
    creds,
    token,
    options.fetchImpl ?? fetch,
    config.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
    now
  );
  await writeUserToken(config.userTokenPath, refreshed);
  return refreshed;
}

/** Read-only connection status for the auth_status tool. Never echoes tokens. */
export async function getAuthStatus(config: SellerAuthConfig): Promise<{
  connected: boolean;
  environment: EbayEnvironment | null;
  scopes: string[];
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  seller_username: string | null;
  credentials_present: boolean;
  warnings: string[];
  reason?: string;
}> {
  let creds: SellerCredentials;
  try {
    creds = await readCredentials(config.credentialsPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      environment: null,
      scopes: [],
      access_expires_at: null,
      refresh_expires_at: null,
      seller_username: null,
      credentials_present: false,
      warnings: [],
      reason: `Credentials not configured: ${message}`,
    };
  }
  const warnings: string[] = [];
  for (const [label, path] of [
    ["Credentials", config.credentialsPath],
    ["User-token", config.userTokenPath],
  ] as const) {
    const restrictive = await fileModeIsRestrictive(path);
    if (restrictive === false) {
      warnings.push(
        `${label} file at ${path} has permissions wider than 0600. Run: chmod 600 ${path}`
      );
    }
  }
  const token = await readUserToken(config.userTokenPath);
  if (!token) {
    return {
      connected: false,
      environment: creds.environment,
      scopes: [],
      access_expires_at: null,
      refresh_expires_at: null,
      seller_username: null,
      credentials_present: true,
      warnings,
      reason:
        "No seller token yet. Run ebay_seller_auth_start, approve in the browser, then ebay_seller_auth_callback.",
    };
  }
  if (refreshTokenExpired(token)) {
    return {
      connected: false,
      environment: token.environment,
      scopes: token.scopes,
      access_expires_at: token.expires_at,
      refresh_expires_at: token.refresh_expires_at,
      seller_username: token.seller_username ?? null,
      credentials_present: true,
      warnings,
      reason:
        "Refresh token expired. Re-run ebay_seller_auth_start to reconnect.",
    };
  }
  return {
    connected: true,
    environment: token.environment,
    scopes: token.scopes,
    access_expires_at: token.expires_at,
    refresh_expires_at: token.refresh_expires_at,
    seller_username: token.seller_username ?? null,
    credentials_present: true,
    warnings,
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms: number = HTTP_TIMEOUT_MS
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
