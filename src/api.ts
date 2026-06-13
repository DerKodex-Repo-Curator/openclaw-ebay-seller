import {
  getValidAccessToken,
  apiBaseUrl,
  withTimeout,
  HTTP_TIMEOUT_MS,
  type SellerAuthConfig,
} from "./auth.js";

/** Auth config plus the default marketplace the tools fall back to. */
export interface SellApiConfig extends SellerAuthConfig {
  defaultMarketplaceId?: string;
}

interface EbayError {
  errorId?: number;
  domain?: string;
  message?: string;
  longMessage?: string;
  parameters?: { name: string; value: string }[];
}

/**
 * Turn an eBay Sell API error body into a single readable line. eBay returns
 * `{ "errors": [ { errorId, message, longMessage, ... } ] }`; we surface the
 * longMessage (or message) verbatim so the operator sees exactly what eBay
 * objected to rather than a generic HTTP status.
 */
export function formatEbayErrors(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errors?: EbayError[] };
    if (parsed.errors?.length) {
      return parsed.errors
        .map(
          (e) =>
            `[${e.errorId ?? "?"}] ${e.longMessage ?? e.message ?? "unknown error"}`
        )
        .join("; ");
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return body.slice(0, 300);
}

/**
 * Authenticated GET against the eBay Sell APIs. Fetches a valid user token
 * (auto-refreshing if near expiry), builds the URL with query params, and
 * surfaces eBay's own error messages on failure. Returns the parsed JSON body,
 * or undefined for a 204.
 */
export async function sellApiGet<T = unknown>(
  config: SellApiConfig,
  path: string,
  query: Record<string, string | number | undefined> = {},
  options: { fetchImpl?: typeof fetch; marketplaceId?: string } = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await getValidAccessToken(config, { fetchImpl });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const url = `${apiBaseUrl(token.environment)}${path}${
    qs.toString() ? `?${qs.toString()}` : ""
  }`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (options.marketplaceId) {
    headers["X-EBAY-C-MARKETPLACE-ID"] = options.marketplaceId;
  }
  const res = await withTimeout(
    fetchImpl(url, { method: "GET", headers }),
    `ebay.sell.GET ${path}`,
    config.httpTimeoutMs ?? HTTP_TIMEOUT_MS
  );
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `eBay Sell API GET ${path} failed (${res.status} ${res.statusText}): ${formatEbayErrors(text)}`
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
