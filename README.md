# openclaw-ebay-seller

eBay seller automation for your OpenClaw agent — connect **your own** eBay seller account via OAuth, read inventory / offers / orders / business-policies, and draft + publish listings behind an approval gate.

Direct REST against the eBay **Sell** APIs via `authorization_code` OAuth. Your seller token is stored locally on the host and auto-refreshed. Every write that touches a live listing or money is **hard-gated** behind a two-step confirm.

> **Status: in development (S0 — scaffold).** The plugin currently builds and loads but exposes **zero tools**. OAuth round-trip lands in S1; read tools in S2–S3; gated writes in S4–S6. See the build plan in the companion Volta project.

This is the higher-stakes sibling of [`openclaw-ebay-research`](https://github.com/Jason-Vaughan/openclaw-ebay-research) (read-only market research, app-token only). The research plugin is a hard prerequisite — this plugin's listing workflow uses its category lookup and price research.

## Why two plugins?

- **Research** (`client_credentials`, app token): public market data, no seller account, no user OAuth. Read-only and low-risk.
- **Seller** (`authorization_code`, user token): holds your seller refresh token, can publish and end live listings, touches money. The approval gate is the trust boundary.

Splitting them keeps the read-only surface installable without ever granting write access to your account.

## How it works

### Authentication (OAuth `authorization_code`)

eBay requires a registered HTTPS redirect URL (a RuName). This plugin uses a **live callback** handler: it registers an HTTP route at `/ebay-seller/callback` on the OpenClaw gateway, exposed over HTTPS via Tailscale Serve. You approve once in the browser; eBay redirects to the callback; the plugin captures the code and exchanges it for tokens — no copy-pasting URLs.

The same HTTPS endpoint later serves eBay's mandatory **Marketplace Account Deletion** notification (required once the plugin reads orders, which contain buyer PII).

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
