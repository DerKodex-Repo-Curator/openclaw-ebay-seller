# Changelog

All notable changes to `openclaw-ebay-seller` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
