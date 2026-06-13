# Changelog

All notable changes to `openclaw-ebay-seller` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- **Smoke test** (`src/index.test.ts`): asserts plugin id, zero-tool surface,
  and manifest↔registration drift guard.

### Internal

- **Callback strategy locked: Option B (live callback).** Plugin registers an
  HTTP route at `/ebay-seller/callback` on the gateway via Tailscale Serve,
  rather than the paste-the-URL flow. OpenClaw's plugin SDK exposes
  `registerPluginHttpRoute`, confirming feasibility. The same HTTPS endpoint is
  reused for eBay's mandatory account-deletion notification once order-reading
  (buyer PII) lands. Decision recorded in the build plan.
