import { sellApiSend, type SellApiConfig, type SellApiSendResult } from "./api.js";

/** Input for attaching a shipping fulfillment (tracking) to an order. */
export interface ShippingFulfillmentInput {
  orderId: string;
  /** The order line items being shipped in this fulfillment. */
  lineItems: { lineItemId: string; quantity: number }[];
  trackingNumber?: string;
  /** eBay shipping carrier code, e.g. USPS, FedEx, UPS. */
  shippingCarrierCode?: string;
}

/**
 * Mark order line items as shipped by creating a shipping fulfillment
 * (eBay POST `/order/{orderId}/shipping_fulfillment`). Optionally records the
 * tracking number + carrier. Soft-gated: it informs the buyer/marketplace but
 * doesn't create or end a listing. Returns eBay's 201 (the fulfillment id is in
 * the Location header).
 */
export async function createShippingFulfillment(
  config: SellApiConfig,
  input: ShippingFulfillmentInput,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  const body = {
    lineItems: input.lineItems,
    ...(input.trackingNumber ? { trackingNumber: input.trackingNumber } : {}),
    ...(input.shippingCarrierCode
      ? { shippingCarrierCode: input.shippingCarrierCode }
      : {}),
  };
  return sellApiSend(
    config,
    {
      method: "POST",
      path: `/sell/fulfillment/v1/order/${encodeURIComponent(input.orderId)}/shipping_fulfillment`,
      body,
    },
    options
  );
}
