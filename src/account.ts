import { sellApiGet, type SellApiConfig } from "./api.js";

/**
 * The seller's three business-policy sets for a marketplace, fetched together.
 * Each field is the raw eBay response for that policy type (e.g.
 * `{ paymentPolicies: [...], total, href }`).
 */
export interface BusinessPolicies {
  marketplaceId: string;
  paymentPolicies: unknown;
  returnPolicies: unknown;
  fulfillmentPolicies: unknown;
}

/**
 * Fetch the seller's payment, return, and fulfillment policies for a
 * marketplace in parallel. Business policies are what an offer references when
 * it's published, so the seller (and the offer-drafting tools, later) needs
 * their ids.
 *
 * Note: the seller account must be opted into eBay's Business Policies program;
 * if not, eBay returns an error per policy type, which is surfaced verbatim.
 */
export async function getBusinessPolicies(
  config: SellApiConfig,
  params: { marketplaceId: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<BusinessPolicies> {
  const mp = params.marketplaceId;
  const [paymentPolicies, returnPolicies, fulfillmentPolicies] =
    await Promise.all([
      sellApiGet(config, "/sell/account/v1/payment_policy", { marketplace_id: mp }, options),
      sellApiGet(config, "/sell/account/v1/return_policy", { marketplace_id: mp }, options),
      sellApiGet(config, "/sell/account/v1/fulfillment_policy", { marketplace_id: mp }, options),
    ]);
  return { marketplaceId: mp, paymentPolicies, returnPolicies, fulfillmentPolicies };
}
