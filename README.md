# openclaw-ebay-seller

eBay seller automation for your OpenClaw agent — connect **your own** eBay seller account via OAuth, read inventory / offers / orders / business-policies, and draft + publish listings behind an approval gate.

Direct REST against the eBay **Sell** APIs via `authorization_code` OAuth. Your seller token is stored locally on the host and auto-refreshed. Every write that touches a live listing or money is **hard-gated** behind a two-step confirm.

> **Status: in development (S1 — auth).** The plugin connects to your eBay seller account via OAuth (three `ebay_seller_auth_*` tools). Read tools (inventory/orders/policies) land in S2–S3; gated writes (draft/publish/withdraw offers) in S4–S6. See the build plan in the companion Volta project.

This is the higher-stakes sibling of [`openclaw-ebay-research`](https://github.com/Jason-Vaughan/openclaw-ebay-research) (read-only market research, app-token only). The research plugin is a hard prerequisite — this plugin's listing workflow uses its category lookup and price research.

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

> **S1 today:** you paste the redirect URL into `auth_callback`. A **live callback** handler (an HTTP route at `/ebay-seller/callback` registered on the gateway via Tailscale Serve, capturing the code automatically — no copy-paste) is planned for a later chunk. The same HTTPS endpoint will then also serve eBay's mandatory **Marketplace Account Deletion** notification, required once the plugin reads orders (buyer PII).

### Write gating

| Gate | Behavior |
|---|---|
| **Soft** | Logs to the ops log, executes immediately (e.g. create draft offer, attach shipment). |
| **Hard** | Returns `{ status: "pending_approval", token, summary }`. You call `confirm_pending(token)` in a separate turn to execute. Tokens expire (default 15 min). Covers offer publish/withdraw and updates to published offers. |

Set `autoApprove: true` in config to collapse hard gates into immediate execution (logged with `user_approved_at: "auto"`) — for trusted automation only.

Every write attempt is recorded append-only at `~/.openclaw/secrets/ebay-seller-ops.jsonl`.

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
