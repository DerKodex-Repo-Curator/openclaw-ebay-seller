import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  startAuth,
  completeAuth,
  getAuthStatus,
  type SellerAuthConfig,
} from "./auth.js";
import {
  listInventoryItems,
  getInventoryItem,
  getOffers,
} from "./inventory.js";
import { getOrders, getOrder } from "./fulfillment.js";
import { getBusinessPolicies } from "./account.js";
import { confirmPending, type GateConfig, type MutationRegistry } from "./gate.js";
import type { SellApiConfig } from "./api.js";

interface PluginConfig {
  credentialsPath: string;
  userTokenPath: string;
  defaultMarketplaceId?: string;
  autoApprove?: boolean;
  pendingApprovalTtlMs?: number;
  opsLogPath?: string;
  httpTimeoutMs?: number;
  tokenRefreshSafetyWindowMs?: number;
}

/**
 * Registry of executable write actions, keyed by action name. The approval
 * gate (autoApprove path and confirm_pending) dispatches through this. Empty
 * until the write tools land in S5+; each write tool registers its executor.
 */
const MUTATIONS: MutationRegistry = {};

/** Project the plugin config down to the auth layer's config shape. */
function authConfig(config: PluginConfig): SellerAuthConfig {
  return {
    credentialsPath: config.credentialsPath,
    userTokenPath: config.userTokenPath,
    httpTimeoutMs: config.httpTimeoutMs,
    tokenRefreshSafetyWindowMs: config.tokenRefreshSafetyWindowMs,
  };
}

/** Auth config plus the default marketplace, for the Sell API read tools. */
function apiConfig(config: PluginConfig): SellApiConfig {
  return {
    ...authConfig(config),
    defaultMarketplaceId: config.defaultMarketplaceId,
  };
}

/** API config plus the approval-gate knobs, for the write tools + confirm. */
function gateConfig(config: PluginConfig): GateConfig {
  return {
    ...apiConfig(config),
    autoApprove: config.autoApprove,
    pendingApprovalTtlMs: config.pendingApprovalTtlMs,
    opsLogPath: config.opsLogPath,
  };
}

/**
 * Plugin configuration schema for the eBay Seller plugin.
 *
 * Mirrors the manifest `configSchema` in openclaw.plugin.json. Credentials and
 * the seller OAuth user token live in operator-owned secret files (never in
 * config); the config only points at their paths and tunes runtime behavior.
 *
 * S0 scaffold: this schema is stable, but the plugin exposes ZERO tools yet.
 * OAuth round-trip and the read/write tool surface arrive in S1+.
 */
const configSchema = Type.Object({
  credentialsPath: Type.String({
    default: "~/.openclaw/secrets/ebay-seller-credentials.json",
    description:
      "Path to the eBay seller app credentials JSON. Required keys: client_id, cert_id, ru_name, redirect_url, environment ('sandbox' or 'production').",
  }),
  userTokenPath: Type.String({
    default: "~/.openclaw/secrets/ebay-seller-user-token.json",
    description:
      "Path where the seller's OAuth user token (access + refresh) is read + written. Auto-managed by the plugin; never hand-edited.",
  }),
  opsLogPath: Type.Optional(
    Type.String({
      default: "~/.openclaw/secrets/ebay-seller-ops.jsonl",
      description:
        "Append-only operations log. One JSON object per write attempt (ts, tool_name, user_approved_at, request_summary, response_status, ebay_request_id).",
    })
  ),
  defaultMarketplaceId: Type.Optional(
    Type.String({
      default: "EBAY_US",
      description:
        "Marketplace used when a tool doesn't specify one (e.g., EBAY_US, EBAY_GB, EBAY_DE).",
    })
  ),
  autoApprove: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "When true, collapses the two-step hard-gate (pending_approval → confirm_pending) into immediate execution, logged with user_approved_at='auto'. Leave false for interactive operation; enable only in trusted automation contexts.",
    })
  ),
  pendingApprovalTtlMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 900000,
      description:
        "How long a hard-gate pending-approval token stays redeemable, in milliseconds. Default 900000 (15 min).",
    })
  ),
  httpTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      default: 30000,
      description:
        "HTTP request timeout in milliseconds (applies to every eBay REST call + the token endpoint). Default 30000 (30s).",
    })
  ),
  tokenRefreshSafetyWindowMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 60000,
      description:
        "How many milliseconds before user-token expiry to proactively refresh. Default 60000 (60s).",
    })
  ),
});

export default defineToolPlugin({
  id: "tangleclaw-ebay-seller",
  name: "TangleClaw eBay Seller",
  description:
    "OpenClaw plugin for eBay seller automation — connect your own eBay seller account via authorization_code OAuth, read inventory/offers/orders/business-policies, and draft + publish listings behind a two-step approval gate. Direct REST against the eBay Sell APIs; the seller user token is stored locally and auto-refreshed. Hard-gated writes protect anything that touches live listings or money.",
  configSchema,
  // S1: OAuth authorization_code round-trip (3 auth tools). Read tools (S2-S3)
  // and gated writes (S4-S6) land in later chunks.
  tools: (tool) => [
    tool({
      name: "ebay_seller_auth_start",
      label: "Connect eBay Seller Account (start)",
      description:
        "BEGIN connecting / linking / authorizing the operator's eBay SELLER account. Call this — do not narrate — when the operator says: connect my ebay (seller) account, link ebay, authorize ebay selling, log in to ebay, set up ebay selling, reconnect ebay. Returns an `authorizeUrl` the operator must open in a browser and approve. After approving, eBay redirects to the configured callback; the operator passes that redirect URL (or the captured code) to ebay_seller_auth_callback to finish. Requests the five Sell scopes (inventory, account, fulfillment). Safe to re-run; it issues a fresh single-use state each time.",
      parameters: Type.Object({}),
      async execute(_params, config) {
        const result = await startAuth(authConfig(config));
        return {
          authorizeUrl: result.authorizeUrl,
          scopes: result.scopes,
          instructions:
            "Open authorizeUrl in a browser, sign in to the eBay seller account, and approve. eBay will redirect to the configured callback URL with a code. Then call ebay_seller_auth_callback with that full redirect URL.",
        };
      },
    }),
    tool({
      name: "ebay_seller_auth_callback",
      label: "Connect eBay Seller Account (finish)",
      description:
        "FINISH connecting the eBay seller account by redeeming the authorization code from the post-approval redirect. Call this — do not narrate — right after the operator approves in the browser and provides the redirect URL (or a raw code+state). Pass the FULL redirect URL the browser landed on (it contains ?code=...&state=...) as `callback`. Validates the CSRF state issued by ebay_seller_auth_start, exchanges the code for the seller's user token, and stores it locally (0600). Returns connection status. If state is missing/expired, re-run ebay_seller_auth_start first.",
      parameters: Type.Object({
        callback: Type.String({
          description:
            "The full redirect URL the browser landed on after approval (e.g. 'https://<host>/ebay-seller/callback?code=v%5E1...&state=...'). A bare '?code=...&state=...' query string is also accepted.",
        }),
      }),
      async execute(params, config) {
        return completeAuth(authConfig(config), params.callback);
      },
    }),
    tool({
      name: "ebay_seller_auth_status",
      label: "eBay Seller Auth Status",
      description:
        "READ / CHECK / SHOW whether the eBay SELLER account is connected. Call this when the operator asks: is ebay (selling) connected, check ebay seller status, am I logged in to ebay, what ebay scopes do I have, when does my ebay token expire, or to debug a failing seller tool. Returns connected state, environment (sandbox/production), granted scopes, access- and refresh-token expiry, and any file-permission warnings. Never echoes the token itself.",
      parameters: Type.Object({}),
      async execute(_params, config) {
        return getAuthStatus(authConfig(config));
      },
    }),
    tool({
      name: "ebay_seller_list_inventory_items",
      label: "List eBay Inventory Items",
      description:
        "LIST / SHOW / READ the seller's own eBay inventory items (SKU-level product records). Call this — do not narrate — when the operator asks: list my ebay inventory, what do I have listed, show my SKUs, what items are in my ebay account, how many products do I have. Returns a page of inventory items plus `total`. An empty account returns total 0 (that's success, not an error). Use `limit`/`offset` to page. NOTE: inventory items are the product data; the live-listing/price data lives on their offers — pair with ebay_seller_get_offers for a given SKU.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 200,
            default: 25,
            description: "Items per page (1-200). Default 25.",
          })
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 0,
            description: "Pagination offset (default 0).",
          })
        ),
      }),
      async execute(params, config) {
        return listInventoryItems(apiConfig(config), {
          limit: params.limit,
          offset: params.offset,
        });
      },
    }),
    tool({
      name: "ebay_seller_get_inventory_item",
      label: "Get eBay Inventory Item",
      description:
        "READ / VIEW / FETCH one of the seller's inventory items by its SKU. Call this — do not narrate — when the operator asks to see / view / get details on a specific SKU, or references one of their own products by SKU. Returns the full inventory_item record (product details, condition, quantity/availability, package weight/dimensions). Get the SKU from ebay_seller_list_inventory_items. Surfaces eBay's 404 message verbatim if the SKU doesn't exist.",
      parameters: Type.Object({
        sku: Type.String({
          description:
            "The seller's SKU for the inventory item (the operator's own product identifier).",
        }),
      }),
      async execute(params, config) {
        return getInventoryItem(apiConfig(config), { sku: params.sku });
      },
    }),
    tool({
      name: "ebay_seller_get_offers",
      label: "Get eBay Offers for a SKU",
      description:
        "LIST / SHOW / READ the offers attached to one of the seller's SKUs. Call this — do not narrate — when the operator asks: is this SKU listed, what's the offer/price for this item, show the listing for SKU X, what offers do I have for this product, is it published. eBay's offer endpoint is always scoped to a single SKU, so `sku` is required. Each offer carries the marketplace-specific listing data: price, category, listing status (PUBLISHED/UNPUBLISHED), offerId, and listingId when live. Get the SKU from ebay_seller_list_inventory_items.",
      parameters: Type.Object({
        sku: Type.String({
          description: "The SKU whose offers to list (required by eBay).",
        }),
        marketplaceId: Type.Optional(
          Type.String({
            description:
              "eBay marketplace id (e.g., EBAY_US, EBAY_GB). Defaults to the plugin's defaultMarketplaceId.",
          })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            default: 25,
            description: "Offers per page (1-100). Default 25.",
          })
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 0,
            description: "Pagination offset (default 0).",
          })
        ),
      }),
      async execute(params, config) {
        const marketplaceId =
          params.marketplaceId ?? config.defaultMarketplaceId ?? "EBAY_US";
        return getOffers(apiConfig(config), {
          sku: params.sku,
          marketplaceId,
          limit: params.limit,
          offset: params.offset,
        });
      },
    }),
    tool({
      name: "ebay_seller_get_orders",
      label: "List eBay Orders",
      description:
        "LIST / SHOW / READ the seller's eBay orders (sales). Call this — do not narrate — when the operator asks: show my orders, what sold, recent sales, what do I need to ship, unfulfilled orders, orders from the last week. Returns a page of orders plus `total`. Each order has line items, pricing, fulfillment status, and buyer/shipping details. Use `filter` for eBay's order filter syntax (e.g. creationdate range, or orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS} for what still needs shipping). NOTE: order data includes buyer personal information — handle accordingly.",
      parameters: Type.Object({
        filter: Type.Optional(
          Type.String({
            description:
              "eBay order filter expression. Examples: 'orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}' (unshipped), 'creationdate:[2026-06-01T00:00:00.000Z..]' (since a date). Omit for all recent orders.",
          })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 200,
            default: 50,
            description: "Orders per page (1-200). Default 50.",
          })
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 0,
            description: "Pagination offset (default 0).",
          })
        ),
      }),
      async execute(params, config) {
        return getOrders(apiConfig(config), {
          filter: params.filter,
          limit: params.limit,
          offset: params.offset,
        });
      },
    }),
    tool({
      name: "ebay_seller_get_order",
      label: "Get eBay Order",
      description:
        "READ / VIEW / FETCH one eBay order in full by its order id. Call this — do not narrate — when the operator asks to see / view / get details on a specific order, or references an order id. Returns the complete order: line items, pricing/taxes, payment + fulfillment status, shipping address, and buyer info. Get the order id from ebay_seller_get_orders. NOTE: includes buyer personal information.",
      parameters: Type.Object({
        orderId: Type.String({
          description:
            "The eBay order id (from a get_orders result, e.g. '12-34567-89012').",
        }),
      }),
      async execute(params, config) {
        return getOrder(apiConfig(config), { orderId: params.orderId });
      },
    }),
    tool({
      name: "ebay_seller_get_business_policies",
      label: "Get eBay Business Policies",
      description:
        "READ / SHOW / LIST the seller's eBay business policies — payment, return, and fulfillment (shipping) — for a marketplace, all in one call. Call this — do not narrate — when the operator asks: show my business policies, what shipping/return/payment policies do I have, list my eBay policies, what's my policy id for X. Returns the three policy sets grouped. These policy ids are what a published offer references, so this is a prerequisite for the listing-creation tools (later). Requires the seller to be opted into eBay's Business Policies program; if not, eBay's error is surfaced per policy type.",
      parameters: Type.Object({
        marketplaceId: Type.Optional(
          Type.String({
            description:
              "eBay marketplace id (e.g., EBAY_US, EBAY_GB). Defaults to the plugin's defaultMarketplaceId.",
          })
        ),
      }),
      async execute(params, config) {
        const marketplaceId =
          params.marketplaceId ?? config.defaultMarketplaceId ?? "EBAY_US";
        return getBusinessPolicies(apiConfig(config), { marketplaceId });
      },
    }),
    tool({
      name: "ebay_seller_confirm_pending",
      label: "Confirm Pending eBay Action",
      description:
        "CONFIRM / APPROVE / EXECUTE a previously-staged eBay write action by its token. Call this — do not narrate — when the operator confirms they want a pending action to proceed (e.g. 'yes, publish it', 'confirm', 'go ahead', 'approve token X'). A hard-gated write tool returns `{ status: 'pending_approval', token, summary }` instead of acting; pass that token here to actually execute it. Tokens are single-use and expire (default 15 min). If the token is unknown or expired, re-run the original tool to stage a fresh one. Only confirm after the operator has seen and agreed to the summary.",
      parameters: Type.Object({
        token: Type.String({
          description:
            "The approval token from a prior tool's pending_approval response.",
        }),
      }),
      async execute(params, config) {
        return confirmPending(gateConfig(config), params.token, MUTATIONS);
      },
    }),
  ],
});
