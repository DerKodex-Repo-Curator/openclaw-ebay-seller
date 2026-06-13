# Changelog

All notable changes to `openclaw-ebay-seller` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
