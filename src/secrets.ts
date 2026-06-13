import { readFile, writeFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type EbayEnvironment = "sandbox" | "production";

/**
 * Seller app credentials, read from the operator-owned credentials file.
 * The `cert_id` is the client secret — it never leaves this file.
 *
 * `ru_name` is eBay's redirect identifier (NOT the literal callback URL): it is
 * the value passed as `redirect_uri` in both the authorize request and the
 * code-exchange request. `redirect_url` is the human-facing HTTPS endpoint the
 * RuName maps to, recorded here only for documentation/diagnostics.
 */
export interface SellerCredentials {
  client_id: string;
  cert_id: string;
  ru_name: string;
  redirect_url?: string;
  environment: EbayEnvironment;
}

/**
 * The seller's OAuth user token, auto-managed by the plugin. Persisted at
 * `userTokenPath` with 0600 perms. `refresh_token` is long-lived (eBay: ~18
 * months); `access_token` is short-lived (~2h) and refreshed on demand.
 */
export interface UserToken {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** ISO timestamp when the access token expires. */
  expires_at: string;
  /** ISO timestamp when the refresh token expires (re-auth required after). */
  refresh_expires_at: string;
  scopes: string[];
  environment: EbayEnvironment;
  /** eBay seller username, when known (filled lazily; optional). */
  seller_username?: string;
}

/** Expand a leading `~` / `~/` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Read + validate the seller credentials file. Throws a clear error naming the
 * missing field so the operator knows exactly what to add.
 */
export async function readCredentials(
  credentialsPath: string
): Promise<SellerCredentials> {
  const raw = await readFile(expandHome(credentialsPath), "utf8");
  const parsed = JSON.parse(raw) as Partial<SellerCredentials>;
  const missing = (["client_id", "cert_id", "ru_name"] as const).filter(
    (k) => !parsed[k]
  );
  if (missing.length > 0) {
    throw new Error(
      `Credentials file at ${credentialsPath} is missing required key(s): ${missing.join(", ")}. ` +
        `Expected { client_id, cert_id, ru_name, redirect_url, environment }.`
    );
  }
  const environment: EbayEnvironment =
    parsed.environment === "production" ? "production" : "sandbox";
  return {
    client_id: parsed.client_id!,
    cert_id: parsed.cert_id!,
    ru_name: parsed.ru_name!,
    redirect_url: parsed.redirect_url,
    environment,
  };
}

/** Read the cached user token, or null if it doesn't exist yet. */
export async function readUserToken(
  tokenPath: string
): Promise<UserToken | null> {
  try {
    const raw = await readFile(expandHome(tokenPath), "utf8");
    return JSON.parse(raw) as UserToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write the user token with 0600 perms. `writeFile`'s `mode` only applies when
 * creating the file, so an explicit `chmod` follows to tighten any pre-existing
 * looser permissions (a refresh-token leak is the worst-case here).
 */
export async function writeUserToken(
  tokenPath: string,
  token: UserToken
): Promise<void> {
  const path = expandHome(tokenPath);
  await writeFile(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Return true if the file's permissions are 0600-or-tighter, false if looser,
 * null if the file can't be stat'd. Used to warn the operator about a
 * world-readable secrets file.
 */
export async function fileModeIsRestrictive(
  filePath: string
): Promise<boolean | null> {
  try {
    const s = await stat(expandHome(filePath));
    return (s.mode & 0o077) === 0;
  } catch {
    return null;
  }
}
