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
import {
  runSoftGated,
  runGated,
  confirmPending,
  type GateConfig,
  type MutationRegistry,
} from "./gate.js";
import {
  createOrReplaceInventoryItem,
  createOffer,
  type InventoryItemInput,
  type OfferInput,
} from "./inventory-write.js";
import {
  createShippingFulfillment,
  type ShippingFulfillmentInput,
} from "./fulfillment-write.js";
import {
  updateOffer,
  publishOffer,
  withdrawOffer,
  getOfferStatus,
  type UpdateOfferInput,
} from "./offer-write.js";
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
 * gate (soft path, autoApprove path, and confirm_pending) dispatches through
 * this — the single source of truth for what writes exist. S5 adds the
 * soft-gated writes; S6 adds the hard-gated ones.
 */
const MUTATIONS: MutationRegistry = {
  create_or_update_inventory_item: async (params, config) => {
    const input = params as InventoryItemInput;
    const r = await createOrReplaceInventoryItem(config, input);
    return {
      result: r.data ?? { sku: input.sku, status: "saved" },
      status: r.status,
      ebayRequestId: r.requestId,
    };
  },
  create_offer: async (params, config) => {
    const r = await createOffer(config, params as OfferInput);
    return { result: r.data, status: r.status, ebayRequestId: r.requestId };
  },
  create_shipping_fulfillment: async (params, config) => {
    const input = params as ShippingFulfillmentInput;
    const r = await createShippingFulfillment(config, input);
    return {
      result: r.data ?? { orderId: input.orderId, status: "fulfillment_created" },
      status: r.status,
      ebayRequestId: r.requestId,
    };
  },
  update_offer: async (params, config) => {
    const input = params as UpdateOfferInput;
    const r = await updateOffer(config, input);
    return {
      result: r.data ?? { offerId: input.offerId, status: "updated" },
      status: r.status,
      ebayRequestId: r.requestId,
    };
  },
  publish_offer: async (params, config) => {
    const input = params as { offerId: string };
    const r = await publishOffer(config, input);
    return {
      result: r.data ?? { offerId: input.offerId, status: "published" },
      status: r.status,
      ebayRequestId: r.requestId,
    };
  },
  withdraw_offer: async (params, config) => {
    const input = params as { offerId: string };
    const r = await withdrawOffer(config, input);
    return {
      result: r.data ?? { offerId: input.offerId, status: "withdrawn" },
      status: r.status,
      ebayRequestId: r.requestId,
    };
  },
};

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
      name: "ebay_seller_create_or_update_inventory_item",
      label: "Create/Update eBay Inventory Item",
      description:
        "CREATE or UPDATE an eBay inventory item (a SKU-level product record). Call this — do not narrate — when the operator wants to add/create/update a product or SKU in their eBay inventory (e.g. 'add this item to my ebay inventory', 'create a SKU for X', 'update the quantity on SKU Y'). This is a soft-gated write: it executes immediately and is audit-logged, but it is NOT a live listing — nothing is visible to buyers until an offer is created (ebay_seller_create_offer) and published (ebay_seller_publish_offer). Idempotent: re-sending for an existing SKU replaces the record. Provide a leaf-category-appropriate title and item specifics (aspects) for best results.",
      parameters: Type.Object({
        sku: Type.String({
          description: "The seller's SKU (their own product identifier).",
        }),
        title: Type.String({
          description: "Listing title (max 80 chars on most categories).",
        }),
        condition: Type.String({
          description:
            "eBay condition enum, e.g. NEW, USED_EXCELLENT, USED_GOOD, USED_ACCEPTABLE, FOR_PARTS_OR_NOT_WORKING.",
        }),
        quantity: Type.Integer({
          minimum: 0,
          description: "Available quantity.",
        }),
        description: Type.Optional(
          Type.String({ description: "Full item description (HTML allowed)." })
        ),
        imageUrls: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Publicly-reachable HTTPS image URLs (eBay requires at least one to publish later).",
          })
        ),
        aspects: Type.Optional(
          Type.Record(Type.String(), Type.Array(Type.String()), {
            description:
              "Item specifics as name → values, e.g. { \"Brand\": [\"Nikon\"], \"Model\": [\"D750\"] }.",
          })
        ),
        contentLanguage: Type.Optional(
          Type.String({ description: "Content language; defaults to en-US." })
        ),
      }),
      async execute(params, config) {
        return runSoftGated(
          gateConfig(config),
          {
            toolName: "ebay_seller_create_or_update_inventory_item",
            action: "create_or_update_inventory_item",
            summary: `Create/replace inventory item SKU '${params.sku}' (qty ${params.quantity}, ${params.condition})`,
            params: {
              sku: params.sku,
              title: params.title,
              condition: params.condition,
              quantity: params.quantity,
              description: params.description,
              imageUrls: params.imageUrls,
              aspects: params.aspects,
              contentLanguage: params.contentLanguage,
            } satisfies InventoryItemInput,
          },
          MUTATIONS
        );
      },
    }),
    tool({
      name: "ebay_seller_create_offer",
      label: "Create eBay Offer (draft)",
      description:
        "CREATE an offer for one of the seller's SKUs — the marketplace-specific listing data (price, category, policies). Call this — do not narrate — when the operator wants to make a listing / set a price / prepare to sell an existing SKU (e.g. 'create a listing for SKU X at $250', 'make an offer for this item'). Soft-gated: executes immediately and is audit-logged, but the offer is created UNPUBLISHED (a draft) — it does NOT go live until ebay_seller_publish_offer (hard-gated). Requires the SKU to already exist (ebay_seller_create_or_update_inventory_item) and a leaf categoryId (use the ebay_research category tools). Returns the offerId.",
      parameters: Type.Object({
        sku: Type.String({ description: "The SKU this offer is for (must exist)." }),
        categoryId: Type.String({
          description:
            "eBay leaf category id (from ebay_research_get_category_suggestions / _subtree).",
        }),
        price: Type.Number({
          minimum: 0,
          description: "Listing price in the marketplace currency.",
        }),
        currency: Type.Optional(
          Type.String({ description: "ISO currency code; defaults to USD." })
        ),
        availableQuantity: Type.Optional(
          Type.Integer({ minimum: 1, default: 1, description: "Offer quantity (default 1)." })
        ),
        listingDescription: Type.Optional(
          Type.String({ description: "Listing description for this offer." })
        ),
        marketplaceId: Type.Optional(
          Type.String({ description: "Marketplace id; defaults to the plugin default." })
        ),
        merchantLocationKey: Type.Optional(
          Type.String({ description: "Merchant location key the item ships from." })
        ),
        paymentPolicyId: Type.Optional(
          Type.String({ description: "Payment policy id (from get_business_policies)." })
        ),
        returnPolicyId: Type.Optional(
          Type.String({ description: "Return policy id (from get_business_policies)." })
        ),
        fulfillmentPolicyId: Type.Optional(
          Type.String({ description: "Fulfillment policy id (from get_business_policies)." })
        ),
      }),
      async execute(params, config) {
        const marketplaceId =
          params.marketplaceId ?? config.defaultMarketplaceId ?? "EBAY_US";
        return runSoftGated(
          gateConfig(config),
          {
            toolName: "ebay_seller_create_offer",
            action: "create_offer",
            summary: `Create DRAFT offer for SKU '${params.sku}' at ${params.currency ?? "USD"} ${params.price} (${marketplaceId})`,
            params: {
              sku: params.sku,
              marketplaceId,
              categoryId: params.categoryId,
              price: params.price,
              currency: params.currency,
              availableQuantity: params.availableQuantity,
              listingDescription: params.listingDescription,
              merchantLocationKey: params.merchantLocationKey,
              paymentPolicyId: params.paymentPolicyId,
              returnPolicyId: params.returnPolicyId,
              fulfillmentPolicyId: params.fulfillmentPolicyId,
            } satisfies OfferInput,
          },
          MUTATIONS
        );
      },
    }),
    tool({
      name: "ebay_seller_create_shipping_fulfillment",
      label: "Mark eBay Order Shipped",
      description:
        "MARK an eBay order (or specific line items) as shipped by creating a shipping fulfillment, optionally with tracking. Call this — do not narrate — when the operator says they shipped an order or wants to add tracking (e.g. 'mark order X shipped', 'add tracking 1Z... to order Y'). Soft-gated: executes immediately and is audit-logged. Get the orderId and lineItemIds from ebay_seller_get_orders / ebay_seller_get_order.",
      parameters: Type.Object({
        orderId: Type.String({ description: "The eBay order id." }),
        lineItems: Type.Array(
          Type.Object({
            lineItemId: Type.String({ description: "Order line item id." }),
            quantity: Type.Integer({ minimum: 1, description: "Quantity shipped." }),
          }),
          { description: "The line items shipped in this fulfillment." }
        ),
        trackingNumber: Type.Optional(
          Type.String({ description: "Carrier tracking number." })
        ),
        shippingCarrierCode: Type.Optional(
          Type.String({ description: "eBay carrier code, e.g. USPS, FedEx, UPS." })
        ),
      }),
      async execute(params, config) {
        return runSoftGated(
          gateConfig(config),
          {
            toolName: "ebay_seller_create_shipping_fulfillment",
            action: "create_shipping_fulfillment",
            summary: `Mark order '${params.orderId}' shipped (${params.lineItems.length} line item(s))${params.trackingNumber ? ` tracking ${params.trackingNumber}` : ""}`,
            params: {
              orderId: params.orderId,
              lineItems: params.lineItems,
              trackingNumber: params.trackingNumber,
              shippingCarrierCode: params.shippingCarrierCode,
            } satisfies ShippingFulfillmentInput,
          },
          MUTATIONS
        );
      },
    }),
    tool({
      name: "ebay_seller_update_offer",
      label: "Update eBay Offer",
      description:
        "UPDATE an existing offer's fields (price, quantity, description, category, policies). Call this — do not narrate — when the operator wants to change a listing/offer (e.g. 'change the price of offer X to $200', 'update the quantity', 'lower the price'). GATING IS CONDITIONAL: if the offer is still a draft (unpublished), the change is soft-gated (applies immediately). If the offer is already PUBLISHED (live listing), the change is HARD-gated — it returns { status: 'pending_approval', token, summary } and you must relay the summary and wait for the operator to confirm before calling ebay_seller_confirm_pending. Get the offerId from ebay_seller_get_offers.",
      parameters: Type.Object({
        offerId: Type.String({ description: "The offer id to update." }),
        price: Type.Optional(
          Type.Number({ minimum: 0, description: "New price." })
        ),
        currency: Type.Optional(Type.String({ description: "Currency; defaults USD." })),
        availableQuantity: Type.Optional(
          Type.Integer({ minimum: 0, description: "New available quantity." })
        ),
        listingDescription: Type.Optional(
          Type.String({ description: "New listing description." })
        ),
        categoryId: Type.Optional(Type.String({ description: "New leaf category id." })),
        paymentPolicyId: Type.Optional(Type.String()),
        returnPolicyId: Type.Optional(Type.String()),
        fulfillmentPolicyId: Type.Optional(Type.String()),
      }),
      async execute(params, config) {
        const input: UpdateOfferInput = {
          offerId: params.offerId,
          price: params.price,
          currency: params.currency,
          availableQuantity: params.availableQuantity,
          listingDescription: params.listingDescription,
          categoryId: params.categoryId,
          paymentPolicyId: params.paymentPolicyId,
          returnPolicyId: params.returnPolicyId,
          fulfillmentPolicyId: params.fulfillmentPolicyId,
        };
        // Route by published-state: live offers are hard-gated, drafts soft.
        // An unknown status fails safe to the hard gate.
        const status = await getOfferStatus(apiConfig(config), params.offerId);
        const isLive = status === "PUBLISHED" || status === "UNKNOWN";
        const descriptor = {
          toolName: "ebay_seller_update_offer",
          action: "update_offer",
          summary: `Update offer '${params.offerId}'${params.price !== undefined ? ` price→${params.currency ?? "USD"} ${params.price}` : ""}${params.availableQuantity !== undefined ? ` qty→${params.availableQuantity}` : ""}${isLive ? " — offer is LIVE" : " (draft)"}`,
          params: input,
        };
        return isLive
          ? runGated(gateConfig(config), descriptor, MUTATIONS)
          : runSoftGated(gateConfig(config), descriptor, MUTATIONS);
      },
    }),
    tool({
      name: "ebay_seller_publish_offer",
      label: "Publish eBay Offer (go LIVE)",
      description:
        "PUBLISH an offer — this makes it a LIVE eBay listing visible to buyers. HARD-GATED: this tool does NOT publish immediately. It returns { status: 'pending_approval', token, summary }. You MUST relay the summary to the operator and WAIT — do NOT call ebay_seller_confirm_pending yourself. Only after the operator explicitly says to confirm/approve/go ahead do you call ebay_seller_confirm_pending with the token. Call this tool when the operator says to publish/list/go live with an offer; get the offerId from ebay_seller_create_offer or ebay_seller_get_offers. (If autoApprove is enabled in config, it publishes immediately — but default is the two-step flow.)",
      parameters: Type.Object({
        offerId: Type.String({ description: "The draft offer id to publish (go live)." }),
      }),
      async execute(params, config) {
        return runGated(
          gateConfig(config),
          {
            toolName: "ebay_seller_publish_offer",
            action: "publish_offer",
            summary: `PUBLISH offer '${params.offerId}' — this creates a LIVE eBay listing visible to buyers`,
            params: { offerId: params.offerId },
          },
          MUTATIONS
        );
      },
    }),
    tool({
      name: "ebay_seller_withdraw_offer",
      label: "Withdraw eBay Offer (end listing)",
      description:
        "WITHDRAW a published offer — this ENDS the live eBay listing so buyers can no longer purchase it. HARD-GATED: does NOT act immediately. Returns { status: 'pending_approval', token, summary }. Relay the summary and WAIT — do NOT call ebay_seller_confirm_pending yourself; only after the operator explicitly confirms do you call it with the token. Call this when the operator says to end/withdraw/take down/unpublish a listing; get the offerId from ebay_seller_get_offers.",
      parameters: Type.Object({
        offerId: Type.String({ description: "The published offer id to withdraw (end)." }),
      }),
      async execute(params, config) {
        return runGated(
          gateConfig(config),
          {
            toolName: "ebay_seller_withdraw_offer",
            action: "withdraw_offer",
            summary: `WITHDRAW offer '${params.offerId}' — this ENDS the live eBay listing`,
            params: { offerId: params.offerId },
          },
          MUTATIONS
        );
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
