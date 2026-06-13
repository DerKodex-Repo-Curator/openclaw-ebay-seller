import { sellApiGet, type SellApiConfig } from "./api.js";

/** A page of inventory items (eBay Sell Inventory `/inventory_item`). */
export interface InventoryItemsPage {
  total?: number;
  size?: number;
  limit?: number;
  offset?: number;
  href?: string;
  next?: string;
  prev?: string;
  inventoryItems?: unknown[];
}

/** A page of offers for a SKU (eBay Sell Inventory `/offer`). */
export interface OffersPage {
  total?: number;
  size?: number;
  limit?: number;
  offset?: number;
  href?: string;
  next?: string;
  prev?: string;
  offers?: unknown[];
}

/**
 * List the seller's inventory items, newest page first. `inventory_item`
 * records are the SKU-level product data (independent of any marketplace
 * offer). An empty account returns `{ total: 0 }` — that's success, not an
 * error.
 */
export async function listInventoryItems(
  config: SellApiConfig,
  params: { limit?: number; offset?: number } = {},
  options: { fetchImpl?: typeof fetch } = {}
): Promise<InventoryItemsPage> {
  return sellApiGet<InventoryItemsPage>(
    config,
    "/sell/inventory/v1/inventory_item",
    { limit: params.limit, offset: params.offset },
    options
  );
}

/**
 * Fetch a single inventory item by SKU. Throws (surfacing eBay's 404 message)
 * if no inventory item exists for that SKU.
 */
export async function getInventoryItem(
  config: SellApiConfig,
  params: { sku: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<unknown> {
  return sellApiGet(
    config,
    `/sell/inventory/v1/inventory_item/${encodeURIComponent(params.sku)}`,
    {},
    options
  );
}

/**
 * List the offers tied to a SKU. eBay's `/offer` endpoint requires a `sku`, so
 * this is always scoped to one product. Offers carry the marketplace-specific
 * listing data (price, category, listing status).
 */
export async function getOffers(
  config: SellApiConfig,
  params: {
    sku: string;
    marketplaceId?: string;
    limit?: number;
    offset?: number;
  },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<OffersPage> {
  return sellApiGet<OffersPage>(
    config,
    "/sell/inventory/v1/offer",
    {
      sku: params.sku,
      marketplace_id: params.marketplaceId,
      limit: params.limit,
      offset: params.offset,
    },
    options
  );
}
