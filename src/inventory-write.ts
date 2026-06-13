import { sellApiSend, type SellApiConfig, type SellApiSendResult } from "./api.js";

/** Input for creating/replacing an inventory item (SKU-level product record). */
export interface InventoryItemInput {
  sku: string;
  /** eBay condition enum, e.g. NEW, USED_EXCELLENT, USED_GOOD. */
  condition: string;
  /** Available quantity at the ship-to location. */
  quantity: number;
  title: string;
  description?: string;
  imageUrls?: string[];
  /** Item specifics, e.g. { Brand: ["Nikon"], Model: ["D750"] }. */
  aspects?: Record<string, string[]>;
  /** Defaults to en-US; required by eBay on the inventory_item PUT. */
  contentLanguage?: string;
}

/**
 * Create or replace an inventory item by SKU (eBay PUT `/inventory_item/{sku}`).
 *
 * This is a full-replace PUT and is **idempotent** — sending it for an existing
 * SKU updates the record and returns 200/204 rather than erroring, so the
 * "already exists" case is handled by eBay itself. The inventory item is NOT a
 * live listing; nothing is visible to buyers until an offer is published.
 */
export async function createOrReplaceInventoryItem(
  config: SellApiConfig,
  input: InventoryItemInput,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  const body = {
    availability: {
      shipToLocationAvailability: { quantity: input.quantity },
    },
    condition: input.condition,
    product: {
      title: input.title,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.imageUrls?.length ? { imageUrls: input.imageUrls } : {}),
      ...(input.aspects ? { aspects: input.aspects } : {}),
    },
  };
  return sellApiSend(
    config,
    {
      method: "PUT",
      path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(input.sku)}`,
      body,
      contentLanguage: input.contentLanguage ?? "en-US",
    },
    options
  );
}

/** Input for creating an (unpublished) offer for a SKU. */
export interface OfferInput {
  sku: string;
  marketplaceId: string;
  /** Leaf category id (from ebay_research category tools). */
  categoryId: string;
  /** Listing price, e.g. 249.99. */
  price: number;
  /** Price currency; defaults to USD. */
  currency?: string;
  availableQuantity?: number;
  listingDescription?: string;
  /** Listing format; defaults to FIXED_PRICE. */
  format?: string;
  /** Where the item ships from (a merchant location key the seller has set up). */
  merchantLocationKey?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  fulfillmentPolicyId?: string;
}

/**
 * Create an offer for a SKU (eBay POST `/offer`). The offer is created
 * **unpublished (draft)** — it is NOT a live listing until `publish_offer`
 * (a hard-gated S6 tool) is called. Returns eBay's `{ offerId }`.
 */
export async function createOffer(
  config: SellApiConfig,
  input: OfferInput,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  const listingPolicies: Record<string, string> = {};
  if (input.paymentPolicyId) listingPolicies.paymentPolicyId = input.paymentPolicyId;
  if (input.returnPolicyId) listingPolicies.returnPolicyId = input.returnPolicyId;
  if (input.fulfillmentPolicyId)
    listingPolicies.fulfillmentPolicyId = input.fulfillmentPolicyId;

  const body = {
    sku: input.sku,
    marketplaceId: input.marketplaceId,
    format: input.format ?? "FIXED_PRICE",
    availableQuantity: input.availableQuantity ?? 1,
    categoryId: input.categoryId,
    ...(input.listingDescription !== undefined
      ? { listingDescription: input.listingDescription }
      : {}),
    ...(Object.keys(listingPolicies).length ? { listingPolicies } : {}),
    ...(input.merchantLocationKey
      ? { merchantLocationKey: input.merchantLocationKey }
      : {}),
    pricingSummary: {
      price: {
        value: String(input.price),
        currency: input.currency ?? "USD",
      },
    },
  };
  return sellApiSend(
    config,
    {
      method: "POST",
      path: "/sell/inventory/v1/offer",
      body,
      contentLanguage: "en-US",
    },
    options
  );
}
