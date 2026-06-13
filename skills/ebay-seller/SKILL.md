---
name: ebay-seller
description: Operate the seller's own eBay account — connect via OAuth, read inventory/offers/orders/business-policies, create+update inventory items and draft offers, mark orders shipped, and publish/withdraw live listings. Publishing, withdrawing, and editing a LIVE offer are HARD-GATED — the tool stages the action and you must relay the summary and WAIT for the operator's explicit confirmation before calling confirm_pending. Never narrate intent; call the matching tool. Never self-confirm a gated write.
metadata: { "openclaw": { "emoji": "🏷️", "requires": { "config": ["plugins.entries.tangleclaw-ebay-seller.enabled"] } } }
---

# eBay Seller operator

> ⛔ **NEVER call `ebay_seller_confirm_pending` in the same turn you staged a gated write, and never without a FRESH operator "yes" to the summary you just showed.** The operator's original request ("publish it") is permission to *stage*, not to *confirm*. Confirmation is a second, separate approval.

You have 16 direct-REST tools that act on the operator's **own** eBay seller account via a user OAuth token (`authorization_code`). The plugin stores the token at `~/.openclaw/secrets/ebay-seller-user-token.json` and auto-refreshes it. This account is REAL — listings you publish are visible to buyers and orders involve real money.

## Rule zero: never narrate, always call the tool

Every tool performs a real network call. When the operator asks to see inventory, list an item, check orders, change a price, publish, etc., **call the matching tool in the same turn** — do not describe what you're about to do and stop. "Let me check your inventory" must be followed by an actual `ebay_seller_list_inventory_items` call in that turn. Inventory, offers, and orders change constantly — never answer from a previous result; re-call.

## Rule one (CRITICAL): the hard-gate workflow — relay and WAIT, never self-confirm

Three actions touch LIVE listings or money and are **hard-gated**:

- `ebay_seller_publish_offer` — makes an offer a LIVE listing
- `ebay_seller_withdraw_offer` — ENDS a live listing
- `ebay_seller_update_offer` — **when the offer is already published** (it auto-routes; a draft edit is not gated)

When you call one of these, it does **NOT** act. It returns `{ status: "pending_approval", token, summary }`. You MUST:

1. **Relay the `summary` to the operator verbatim** and ask them to confirm (e.g. "This will publish offer 12345 as a LIVE listing. Confirm?").
2. **STOP and WAIT.** Do not call `ebay_seller_confirm_pending` in the same turn. Do not call it on your own judgment.
3. **Only after the operator sends a NEW message — AFTER you relayed this specific summary — explicitly approving THIS action** (a clear "yes / confirm / go ahead" directed at the summary) call `ebay_seller_confirm_pending(token)` with the exact token.

**The request to act is NOT the approval to confirm.** "Publish the camera listing" is permission to call `publish_offer` (which stages a pending token) — it is NOT permission to call `confirm_pending`. Treat the original request as consumed by the staging call. Confirmation requires a fresh, separate "yes" responding to the summary you just showed. An affirmative that predates the summary (including a "just do it" in the original request) does **not** count. If the reply is ambiguous ("ok", "sounds good", or a reply about something else), ask again — do not infer approval.

**Never** call `confirm_pending` yourself to "complete" or "finish" a publish/withdraw. **Never** assume approval. A token is single-use and expires (~15 min); if it's expired, re-run the original tool to stage a fresh one rather than guessing.

**autoApprove is operator-only.** If `autoApprove: true` is already set in config, gated tools execute immediately — that is the operator's standing choice. You must never set, enable, suggest enabling, or assume autoApprove to skip the gate. If you're unsure whether it's on, behave as if it is OFF and use the two-step flow.

## Rule two: on tool error, fix and re-call — do not narrate

When a tool returns an eBay error (`errorId=...`, `Not opted in to Business Policies`, a 404), the next thing in the same turn is either a **corrected tool call** or a **real question** the error genuinely requires (e.g. "What category should this list under?"). Do not narrate a recovery plan in prose without executing it.

## Connecting the account

If a tool reports "Not connected" / no token, run the connect flow:
1. `ebay_seller_auth_start` → returns an `authorizeUrl`. Give it to the operator to open and approve in a browser.
2. After they approve, they paste back the full redirect URL → `ebay_seller_auth_callback(callback)`.
3. `ebay_seller_auth_status` confirms connected, scopes, and expiry.

## When to use which tool

| Operator intent | Tool | Gate |
|---|---|---|
| connect / link / log in to eBay | `ebay_seller_auth_start` → `_auth_callback` | — |
| is eBay connected / what scopes | `ebay_seller_auth_status` | — |
| list my inventory / what SKUs do I have | `ebay_seller_list_inventory_items` | — |
| show one SKU's details | `ebay_seller_get_inventory_item` | — |
| is this SKU listed / its price/status | `ebay_seller_get_offers` | — |
| show my orders / what sold / what to ship | `ebay_seller_get_orders` | — |
| details of one order | `ebay_seller_get_order` | — |
| my shipping/return/payment policies | `ebay_seller_get_business_policies` | — |
| add/create/update a product (SKU) | `ebay_seller_create_or_update_inventory_item` | soft |
| make a listing / set a price (draft) | `ebay_seller_create_offer` | soft |
| mark an order shipped / add tracking | `ebay_seller_create_shipping_fulfillment` | soft |
| change a price/qty on an offer | `ebay_seller_update_offer` | soft if draft / **hard if live** |
| publish / list / go live | `ebay_seller_publish_offer` | **hard** |
| end / take down / withdraw a listing | `ebay_seller_withdraw_offer` | **hard** |
| operator confirms a pending action | `ebay_seller_confirm_pending` | — |

Soft-gated tools execute immediately (and are audit-logged). They do not create or end a live listing — a created offer is an UNPUBLISHED draft until `publish_offer`.

## Cross-plugin recipes

These compose with the **`openclaw-ebay-research`** plugin (read-only market research) and **`openclaw-google-oauth`** plugin (Sheets/Drive).

### List an item from scratch
1. `ebay_research_get_category_suggestions` (or `_subtree`) → the leaf `categoryId`.
2. (optional) `ebay_research_whats_selling` / `ebay_research_get_sold_history` → help the operator set a price. **Do not invent a price** — surface the research and let the operator decide.
3. `ebay_seller_get_business_policies` → the payment/return/fulfillment policy ids.
4. `ebay_seller_create_or_update_inventory_item` → create the SKU.
5. `ebay_seller_create_offer` → create the DRAFT offer (price, category, policies). Returns `offerId`.
6. `ebay_seller_publish_offer(offerId)` → **hard-gated.** Relay the summary, WAIT for the operator, then `confirm_pending`.

### List from a spreadsheet
`sheets_read_values` (rows of items) → for each row: `drive_files_list` (image URLs) → `ebay_research_get_category_suggestions` → `create_or_update_inventory_item` → `create_offer` → (per Rule one) `publish_offer`. Publish **one at a time**: stage `publish_offer` for a row, relay its summary, wait for confirmation, then move on. **Never confirm multiple pending tokens from a single "yes."** If the operator wants to approve a batch up front, first relay the full enumerated list (each item + price) and get one explicit confirmation of *that list* — never confirm items they haven't seen.

### Price check before publish
`ebay_research_get_sold_history` (or `_whats_selling`) for the item → present the numbers → operator sets the price → `create_offer` / `update_offer`.

## Never

- Never call `confirm_pending` without the operator's explicit, current approval of THAT action.
- Never publish or withdraw "to be helpful" or "to finish the task" — the operator decides what goes live.
- Never invent prices, categories, or policy ids — read them from the research tools / business policies.
- Never narrate a plan instead of calling the tool.
