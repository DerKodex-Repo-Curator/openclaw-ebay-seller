import { sellApiGet, type SellApiConfig } from "./api.js";

/** A page of orders (eBay Sell Fulfillment `/order`). */
export interface OrdersPage {
  total?: number;
  limit?: number;
  offset?: number;
  href?: string;
  next?: string;
  prev?: string;
  orders?: unknown[];
}

/**
 * List the seller's orders, newest first.
 *
 * ⚠️ Order records contain BUYER PII (name, shipping address, contact). The
 * plugin only reads + returns them to the operator's agent; it does not persist
 * them. Once this plugin is used in production against real orders, eBay's
 * Marketplace Account Deletion notification obligation applies — see the build
 * plan's deletion-endpoint note.
 *
 * `filter` accepts eBay's order filter syntax, e.g.
 * `creationdate:[2026-01-01T00:00:00.000Z..]` or `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`.
 */
export async function getOrders(
  config: SellApiConfig,
  params: {
    filter?: string;
    orderIds?: string;
    limit?: number;
    offset?: number;
  } = {},
  options: { fetchImpl?: typeof fetch } = {}
): Promise<OrdersPage> {
  return sellApiGet<OrdersPage>(
    config,
    "/sell/fulfillment/v1/order",
    {
      filter: params.filter,
      orderIds: params.orderIds,
      limit: params.limit,
      offset: params.offset,
    },
    options
  );
}

/**
 * Fetch one order by its eBay order id. Surfaces eBay's 404 message if the
 * order id isn't found.
 */
export async function getOrder(
  config: SellApiConfig,
  params: { orderId: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<unknown> {
  return sellApiGet(
    config,
    `/sell/fulfillment/v1/order/${encodeURIComponent(params.orderId)}`,
    {},
    options
  );
}
