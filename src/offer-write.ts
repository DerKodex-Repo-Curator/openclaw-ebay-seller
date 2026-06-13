import {
  sellApiGet,
  sellApiSend,
  type SellApiConfig,
  type SellApiSendResult,
} from "./api.js";

/** Input for patching an existing offer (only provided fields are changed). */
export interface UpdateOfferInput {
  offerId: string;
  price?: number;
  currency?: string;
  availableQuantity?: number;
  listingDescription?: string;
  categoryId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  fulfillmentPolicyId?: string;
}

/**
 * Read an offer's publish status ("PUBLISHED" | "UNPUBLISHED"). Used to route
 * `update_offer` to the soft gate (draft) or hard gate (live). Returns
 * "UNKNOWN" if eBay doesn't report a status, which the caller treats as
 * live (fail-safe → hard gate).
 */
export async function getOfferStatus(
  config: SellApiConfig,
  offerId: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const offer = await sellApiGet<{ status?: string }>(
    config,
    `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
    {},
    options
  );
  return offer?.status ?? "UNKNOWN";
}

/** Patch an existing offer (eBay PATCH `/offer/{offerId}`). Only the provided
 *  fields are sent. */
export async function updateOffer(
  config: SellApiConfig,
  input: UpdateOfferInput,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  const listingPolicies: Record<string, string> = {};
  if (input.paymentPolicyId) listingPolicies.paymentPolicyId = input.paymentPolicyId;
  if (input.returnPolicyId) listingPolicies.returnPolicyId = input.returnPolicyId;
  if (input.fulfillmentPolicyId)
    listingPolicies.fulfillmentPolicyId = input.fulfillmentPolicyId;

  const body: Record<string, unknown> = {};
  if (input.availableQuantity !== undefined)
    body.availableQuantity = input.availableQuantity;
  if (input.categoryId !== undefined) body.categoryId = input.categoryId;
  if (input.listingDescription !== undefined)
    body.listingDescription = input.listingDescription;
  if (Object.keys(listingPolicies).length) body.listingPolicies = listingPolicies;
  if (input.price !== undefined) {
    body.pricingSummary = {
      price: { value: String(input.price), currency: input.currency ?? "USD" },
    };
  }
  return sellApiSend(
    config,
    {
      method: "PATCH",
      path: `/sell/inventory/v1/offer/${encodeURIComponent(input.offerId)}`,
      body,
      contentLanguage: "en-US",
    },
    options
  );
}

/**
 * Publish an offer — this makes it a LIVE eBay listing (eBay POST
 * `/offer/{offerId}/publish`). Hard-gated at the tool layer. Returns the
 * `{ listingId }`.
 */
export async function publishOffer(
  config: SellApiConfig,
  input: { offerId: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  return sellApiSend(
    config,
    {
      method: "POST",
      path: `/sell/inventory/v1/offer/${encodeURIComponent(input.offerId)}/publish`,
    },
    options
  );
}

/**
 * Withdraw a published offer — this ENDS the live eBay listing (eBay POST
 * `/offer/{offerId}/withdraw`). Hard-gated at the tool layer.
 */
export async function withdrawOffer(
  config: SellApiConfig,
  input: { offerId: string },
  options: { fetchImpl?: typeof fetch } = {}
): Promise<SellApiSendResult> {
  return sellApiSend(
    config,
    {
      method: "POST",
      path: `/sell/inventory/v1/offer/${encodeURIComponent(input.offerId)}/withdraw`,
    },
    options
  );
}
