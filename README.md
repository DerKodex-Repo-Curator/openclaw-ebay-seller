# openclaw-ebay-seller

eBay seller automation for your OpenClaw agent — connect **your own** eBay seller account via OAuth, read inventory / offers / orders / business-policies, and draft + publish listings behind an approval gate.

Direct REST against the eBay **Sell** APIs via `authorization_code` OAuth. Your seller token is stored locally on the host and auto-refreshed. Every write that touches a live listing or money is **hard-gated** behind a two-step confirm.

> **Status: v0.1.0 — 16 tools, deployed and smoke-tested against eBay production.** OAuth login, read tools (inventory / offers / orders / business policies), soft-gated writes (create inventory item, create draft offer, mark shipped), and hard-gated writes (publish / withdraw / update live offer) behind a two-step approval gate — plus a SKILL.md that biases the agent to relay-and-wait, never self-confirm. 104 tests; the OAuth flow, the approval gate, and the write surface were each independently adversarially reviewed.

This is the higher-stakes sibling of [`openclaw-ebay-research`](https://github.com/Jason-Vaughan/openclaw-ebay-research) (read-only market research, app-token only). The research plugin is a recommended companion — this plugin's listing workflow uses its category lookup and price research.

## Tools at a glance

| Group | Tools | Gate |
|---|---|---|
| **Auth** | `auth_start`, `auth_callback`, `auth_status` | — |
| **Read** | `list_inventory_items`, `get_inventory_item`, `get_offers`, `get_orders`, `get_order`, `get_business_policies` | — |
| **Soft writes** | `create_or_update_inventory_item`, `create_offer` (draft), `create_shipping_fulfillment` | execute + audit |
| **Hard writes** | `publish_offer`, `withdraw_offer`, `update_offer` (when live) | two-step confirm |
| **Approval** | `confirm_pending` | — |

(All tool names are prefixed `ebay_seller_`.)

## Why two plugins?

- **Research** (`client_credentials`, app token): public market data, no seller account, no user OAuth. Read-only and low-risk.
- **Seller** (`authorization_code`, user token): holds your seller refresh token, can publish and end live listings, touches money. The approval gate is the trust boundary.

Splitting them keeps the read-only surface installable without ever granting write access to your account.

## How it works

### Authentication (OAuth `authorization_code`)

eBay requires a registered HTTPS redirect URL (a RuName). Connecting is a three-step round-trip:

1. **`ebay_seller_auth_start`** → returns an `authorizeUrl`. Open it in a browser (signed in to your seller account) and approve the requested scopes.
2. eBay redirects back to your registered callback URL with `?code=...&state=...`. **`ebay_seller_auth_callback`** → pass that full redirect URL; the plugin validates the CSRF `state`, exchanges the code, and stores the token locally (0600).
3. **`ebay_seller_auth_status`** → confirms connected state, environment, granted scopes, and token expiry.

> **Today the code handoff is manual** (you paste the post-approval redirect URL into `auth_callback`). A **live callback** handler — an HTTP route at `/ebay-seller/callback` registered on the gateway (via Tailscale Serve or equivalent) that captures the code automatically — is planned. That same HTTPS endpoint will also serve eBay's **Marketplace Account Deletion** notification, which becomes required once you read orders (buyer PII) on a non-exempt application.

### Write gating

| Gate | Behavior |
|---|---|
| **Soft** | Logs to the ops log, executes immediately (e.g. create draft offer, attach shipment). |
| **Hard** | Returns `{ status: "pending_approval", token, summary }`. You call `confirm_pending(token)` in a separate turn to execute. Tokens expire (default 15 min). Covers offer publish/withdraw and updates to published offers. |

Set `autoApprove: true` in config to collapse hard gates into immediate execution (logged with `user_approved_at: "auto"`) — for trusted automation only.

Every write attempt is recorded append-only at `~/.openclaw/secrets/ebay-seller-ops.jsonl`.

## Security & safety

This plugin acts on a **real** eBay seller account, so the trust model is deliberate:

- **You bring your own eBay application.** The plugin ships no credentials. You register your own eBay developer app + keyset and your own RuName redirect. Nothing about anyone else's account is in this repo or the package.
- **Secrets never leave your host.** Your `client_id`, `cert_id`, and the OAuth user/refresh token live only in `~/.openclaw/secrets/` on your machine (written `0600`). They are never committed, never transmitted anywhere except eBay's own OAuth/token endpoints, and are redacted from error messages.
- **No unconfirmed live writes.** Publishing a listing, ending a listing, and editing a *published* offer are hard-gated: the tool stages the action and returns a summary + token; nothing happens until you confirm in a separate step. The bundled SKILL.md instructs the agent to relay the summary and **wait** — it must not self-confirm, and the agent's original request ("publish it") is treated as permission to *stage*, not to *execute*. `autoApprove` (off by default) is the only way to collapse that step, and it's an operator-only setting.
- **Full audit trail.** Every executed write — soft or hard, success or failure — is appended to the ops log with what ran, when, and whether it was operator- or auto-approved.
- **Reviewed.** The OAuth flow, the approval gate (under concurrency/crash), and the write surface were each put through an independent adversarial review; findings were fixed before release.

The read-only [`openclaw-ebay-research`](https://github.com/Jason-Vaughan/openclaw-ebay-research) plugin is intentionally separate, so you can install market research without ever granting write access to a seller account.

## Install

```
openclaw plugins install @jason-vaughan/openclaw-ebay-seller
openclaw plugins enable tangleclaw-ebay-seller
```

Then provide your eBay seller app credentials at `~/.openclaw/secrets/ebay-seller-credentials.json` (mode 0600):

```json
{
  "client_id": "...",
  "cert_id": "...",
  "ru_name": "...",
  "redirect_url": "https://<your-host>.<tailnet>.ts.net/ebay-seller/callback",
  "environment": "production"
}
```

You bring your own eBay developer application and keyset. The `cert_id` is a secret — keep it only in this file.

## Configuration

| Key | Default | Description |
|---|---|---|
| `credentialsPath` | `~/.openclaw/secrets/ebay-seller-credentials.json` | App credentials + redirect URL. |
| `userTokenPath` | `~/.openclaw/secrets/ebay-seller-user-token.json` | Auto-managed OAuth user token. |
| `opsLogPath` | `~/.openclaw/secrets/ebay-seller-ops.jsonl` | Append-only write-operations log. |
| `defaultMarketplaceId` | `EBAY_US` | Default marketplace. |
| `autoApprove` | `false` | Collapse hard gates into one-step (trusted automation only). |
| `pendingApprovalTtlMs` | `900000` | Hard-gate token lifetime (15 min). |
| `httpTimeoutMs` | `30000` | Per-request HTTP timeout. |
| `tokenRefreshSafetyWindowMs` | `60000` | Refresh the user token this far ahead of expiry. |

## OAuth scopes requested

- `sell.inventory`
- `sell.account` (+ `sell.account.readonly`)
- `sell.fulfillment` (+ `sell.fulfillment.readonly`)

## Development

```
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run plugin:validate
```

## License

MIT © 2026 Jason Vaughan
