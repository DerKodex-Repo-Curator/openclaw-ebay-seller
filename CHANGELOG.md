# Changelog

All notable changes to `openclaw-ebay-seller` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-12

First release. A complete eBay seller automation surface (16 tools) for OpenClaw:
OAuth login to your own seller account, read inventory/offers/orders/business
policies, soft-gated writes (create inventory items + draft offers, mark orders
shipped), and hard-gated writes (publish/withdraw/edit live offers) behind a
two-step approval gate with a full audit log. Deployed and smoke-tested against
eBay production; OAuth, the gate, the write surface, and the SKILL.md were each
independently adversarially reviewed.

### Fixed

- **Sell API requests now send `Accept-Language`** (derived from the marketplace,
  e.g. EBAY_US → en-US). Without it, eBay's Sell Inventory reads 400 with
  errorId 25709 ("Invalid value for header Accept-Language"). **Caught by the
  live Volta production smoke** — mocked-fetch unit tests couldn't surface it.
  Added `localeForMarketplace` + a regression test.

### Added

- **S8 — deployed to Volta + production smoke (read & write).** Plugin deployed
  to `~/.openclaw/extensions/tangleclaw-ebay-seller` against eBay production,
  enabled in `openclaw.json`, gateway restarted (loaded cleanly, 16 tools). Live
  smoke: `auth_status` connected/production/5 scopes; `list_inventory_items`
  200/total 0; full write CRUD validated reversibly — created a throwaway
  inventory item (204), read it back, deleted it (204), confirmed gone (404). No
  listing published; no residue.

- **S7 — operator SKILL.md + cross-plugin recipes.**
  `skills/ebay-seller/SKILL.md` (wired via the manifest `skills` field): rule-zero
  (never narrate, call the tool), the **hard-gate workflow** (relay the summary
  and WAIT — never self-confirm; the original request is permission to *stage*,
  not to *confirm*; a fresh post-summary "yes" is required), a 16-tool decision
  table with soft/hard labels, and cross-plugin recipes (list-from-spreadsheet
  and price-check-before-publish using `openclaw-ebay-research` +
  `openclaw-google-oauth`). `docs/AGENTS-snippet.md`: the hard-gate rule to inline
  into the Volta workspace AGENTS.md at deploy (unconditional load on small models).
- **S7 SKILL Critic fixes:** closed the "operator's original 'publish it' is
  standing approval" loophole (request ≠ confirmation; approval must be a NEW
  message responding to the relayed summary), hardened `autoApprove` to
  operator-only (never set/assume), tightened batch-publish (never confirm
  multiple tokens from one "yes"), and added a top-of-file ⛔ banner for small
  models. Critic found no blockers.
- **Tests:** +4 (103 total) — `src/skills.test.ts` doc-parity: SKILL.md exists,
  teaches the relay-and-wait / never-self-confirm rule, names every hard-gated
  tool, and documents all 16 registered tools.

- **S6 — hard-gated write tools (full v0.1 surface, 16 tools).**
  `ebay_seller_publish_offer` (makes an offer a LIVE listing) and
  `ebay_seller_withdraw_offer` (ends a live listing) are hard-gated: they return
  `{ status: 'pending_approval', token, summary }` and only execute via
  `confirm_pending` (or immediately when `autoApprove=true`).
  `ebay_seller_update_offer` is **conditionally gated** — it reads the offer's
  published state and routes to the soft gate (draft) or hard gate (live).
- **`src/offer-write.ts`** — PATCH/publish/withdraw client + `getOfferStatus`
  (an unknown status fails safe to the hard gate). Executors registered in the
  gate's `MUTATIONS` registry.
- **Tests:** +7 (97 total) including the core safety property end-to-end:
  `publish_offer` does NOT publish on the first call, publishes exactly once
  only after `confirm_pending`; `autoApprove=true` publishes immediately;
  PATCH-only-provided-fields; publish/withdraw endpoint routing.
- **S6 Critic fix:** `update_offer` routing is now **fail-closed**
  (`updateRequiresApproval`) — only a definitively `UNPUBLISHED` offer takes the
  soft path; PUBLISHED / UNKNOWN / any unexpected or mis-cased status hard-gates
  (was fail-open on unanticipated values). Added a tested unit for the decision,
  documented the accepted soft-path TOCTOU, and made the approval summary list
  every field being changed. (Critic found no blockers; verified
  no-unconfirmed-live-write holds end to end.) +2 tests (99 total).

- **S5 — soft-gated write tools.** Three writes that execute immediately and are
  audit-logged (no approval step — they don't touch live listings or money):
  `ebay_seller_create_or_update_inventory_item` (idempotent PUT — re-sending a
  SKU replaces it; not a live listing), `ebay_seller_create_offer` (POST,
  created UNPUBLISHED/draft — returns offerId), and
  `ebay_seller_create_shipping_fulfillment` (mark order line items shipped, with
  optional tracking).
- **`src/api.ts` `sellApiSend`** — authenticated POST/PUT/PATCH/DELETE client:
  JSON body, Content-Language header, captures eBay's request id for the audit
  log, surfaces eBay errors. **`src/inventory-write.ts`** + **`src/fulfillment-write.ts`**
  — the write clients. Executors registered in the gate's `MUTATIONS` registry
  and dispatched through `runSoftGated` (execute + audit, always).
- **Tests:** +8 (90 total) — `sellApiSend` (method/body/Content-Language/request-id
  capture/204/error), inventory-item PUT body assembly + idempotent 204, draft
  offer POST body + policy grouping, shipping fulfillment body, optional-field
  omission across all three.

- **S4 — approval gate + ops log + `confirm_pending`.** The safety machinery
  every write tool (S5+) sits behind. `src/gate.ts`: staged pending-action store
  with TTL, single-use redemption, and crash-safe persistence; `runGated()`
  branches on `autoApprove` (execute-now) vs stage (`pending_approval` envelope);
  `confirmPending()` redeems + executes via an injectable mutation registry.
  `src/ops-log.ts`: append-only JSONL audit (0600). `ebay_seller_confirm_pending`
  tool (registry empty until S5).
- **S4 gate hardening (Independent Critic checkpoint).** Fixed two blockers the
  Critic found before any write tool builds on the gate:
  - **No concurrent double-execute:** all pending-file read-modify-writes are
    serialized through an in-process lock, so two parallel `confirm_pending`
    calls on one token execute exactly once (was a double-publish risk on
    non-idempotent eBay writes).
  - **Crash-safe atomic writes:** pending store is written temp-then-`rename`; a
    corrupt store is treated as empty (fail-closed) instead of bricking the gate.
  - `autoApprove` is now strict `=== true` (the string `"false"` and other
    truthy non-booleans no longer bypass the gate — default-deny).
  - Executor failures are logged to the audit trail (token stays consumed — no
    retry of a maybe-partial write); a malformed TTL fails closed; an unset
    `opsLogPath` surfaces an `audit_warning` instead of silently skipping audit.
- **Tests:** +25 (82 total) including adversarial cases — concurrent-confirm
  executes once, stage-racing-confirm can't resurrect a token, strict-truthiness
  matrix, failure-path audit logging, corrupt-file resilience.

- **S3 — fulfillment + account read tools.** Three tools:
  `ebay_seller_get_orders` (orders/sales, eBay filter syntax, paged),
  `ebay_seller_get_order` (one order by id), and
  `ebay_seller_get_business_policies` (payment + return + fulfillment policies
  for a marketplace, fetched in parallel and grouped — the ids a published
  offer references).
- **`src/fulfillment.ts`** (Sell Fulfillment read client) + **`src/account.ts`**
  (Sell Account policy reads) over the shared `api.ts` client.
- **Tests:** +5 (57 total) — order filter/paging query construction, order-id
  path encoding, the parallel three-policy fetch + grouping, and eBay-error
  surfacing when a policy call fails (e.g. not opted into Business Policies).
- **Compliance note:** order records carry buyer PII. The plugin reads but does
  not persist them; once used against real orders this triggers eBay's
  Marketplace Account Deletion notification obligation (see build plan's
  deletion-endpoint note).

- **S2 — inventory read tools.** Three tools: `ebay_seller_list_inventory_items`
  (SKU-level product records, paged, empty account → total 0),
  `ebay_seller_get_inventory_item` (one item by SKU), and
  `ebay_seller_get_offers` (offers for a SKU — marketplace listing/price/status).
- **`src/api.ts`** — shared authenticated Sell-API GET client: pulls a valid
  user token (auto-refresh), builds the URL + query, sets the bearer token and
  optional marketplace header, surfaces eBay's own error messages verbatim,
  handles 204. **`src/inventory.ts`** — the three read functions over it.
- **Tests:** +12 (52 total) — `formatEbayErrors`, URL/query/header construction,
  204 handling, error surfacing, SKU path-encoding, and each inventory function's
  request shape, all via injected fetch.
- **Live-proven:** the auth chain + `/sell/inventory/v1/inventory_item` endpoint
  were validated against eBay production during S1 (HTTP 200, total 0 on the
  empty `great_gifts_4_less` account).

- **S1 — OAuth `authorization_code` round-trip.** Three auth tools:
  `ebay_seller_auth_start` (builds the eBay authorize URL with all five Sell
  scopes + a CSRF state), `ebay_seller_auth_callback` (validates state,
  exchanges the code for the seller user token, persists it 0600), and
  `ebay_seller_auth_status` (read-only connection/scope/expiry report, never
  echoes the token).
- **`src/auth.ts`** — authorization_code flow: authorize-URL builder (RuName as
  `redirect_uri`), callback parser (full URL / bare query / encoded codes),
  file-backed CSRF state with a 15-minute TTL, code exchange, refresh-token
  flow (refresh token carried forward unchanged), `getValidAccessToken`
  (auto-refresh ahead of expiry, with actionable re-auth errors), and
  credential-redacting error paths.
- **`src/secrets.ts`** — credentials reader (names every missing key), user-token
  read/write enforced to 0600 (chmod after write), permission-restrictiveness
  check.
- **Tests:** 33 passing across auth (URL build, state validation, parsing,
  code-exchange + refresh via injected fetch), secrets (file I/O, perms), and a
  file-backed round-trip (start → callback → status, plus failure paths).

### Internal

- **S0 — project scaffold.** Repo skeleton mirroring `openclaw-ebay-research`:
  `package.json` (`@jason-vaughan/openclaw-ebay-seller`), `tsconfig.json`,
  `vitest.config.ts`, `.gitignore`, MIT `LICENSE`, `README.md`.
- **Plugin manifest + entry point** (`openclaw.plugin.json`, `src/index.ts`)
  registering plugin id `tangleclaw-ebay-seller` with the full config schema
  (credentials/token/ops-log paths, `autoApprove`, `pendingApprovalTtlMs`,
  timeouts) and **zero tools** — the empty surface builds and loads, proving
  the wiring before any OAuth or tool code lands.
- **Smoke test** (`src/index.test.ts`): asserts plugin id, tool surface, and
  manifest↔registration drift guard.
- **Callback strategy locked: Option B (live callback).** OpenClaw's plugin SDK
  exposes `registerPluginHttpRoute`, so a later chunk will register an HTTP
  route at `/ebay-seller/callback` (via Tailscale Serve) that captures the OAuth
  code automatically — replacing the S1 paste-the-URL flow. The same HTTPS
  endpoint is reused for eBay's mandatory account-deletion notification once
  order-reading (buyer PII) lands. Decision recorded in the build plan.
