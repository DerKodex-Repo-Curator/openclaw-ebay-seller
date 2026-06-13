import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

/**
 * Plugin configuration schema for the eBay Seller plugin.
 *
 * Mirrors the manifest `configSchema` in openclaw.plugin.json. Credentials and
 * the seller OAuth user token live in operator-owned secret files (never in
 * config); the config only points at their paths and tunes runtime behavior.
 *
 * S0 scaffold: this schema is stable, but the plugin exposes ZERO tools yet.
 * OAuth round-trip and the read/write tool surface arrive in S1+.
 */
const configSchema = Type.Object({
  credentialsPath: Type.String({
    default: "~/.openclaw/secrets/ebay-seller-credentials.json",
    description:
      "Path to the eBay seller app credentials JSON. Required keys: client_id, cert_id, ru_name, redirect_url, environment ('sandbox' or 'production').",
  }),
  userTokenPath: Type.String({
    default: "~/.openclaw/secrets/ebay-seller-user-token.json",
    description:
      "Path where the seller's OAuth user token (access + refresh) is read + written. Auto-managed by the plugin; never hand-edited.",
  }),
  opsLogPath: Type.Optional(
    Type.String({
      default: "~/.openclaw/secrets/ebay-seller-ops.jsonl",
      description:
        "Append-only operations log. One JSON object per write attempt (ts, tool_name, user_approved_at, request_summary, response_status, ebay_request_id).",
    })
  ),
  defaultMarketplaceId: Type.Optional(
    Type.String({
      default: "EBAY_US",
      description:
        "Marketplace used when a tool doesn't specify one (e.g., EBAY_US, EBAY_GB, EBAY_DE).",
    })
  ),
  autoApprove: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "When true, collapses the two-step hard-gate (pending_approval → confirm_pending) into immediate execution, logged with user_approved_at='auto'. Leave false for interactive operation; enable only in trusted automation contexts.",
    })
  ),
  pendingApprovalTtlMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 900000,
      description:
        "How long a hard-gate pending-approval token stays redeemable, in milliseconds. Default 900000 (15 min).",
    })
  ),
  httpTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      default: 30000,
      description:
        "HTTP request timeout in milliseconds (applies to every eBay REST call + the token endpoint). Default 30000 (30s).",
    })
  ),
  tokenRefreshSafetyWindowMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 60000,
      description:
        "How many milliseconds before user-token expiry to proactively refresh. Default 60000 (60s).",
    })
  ),
});

export default defineToolPlugin({
  id: "tangleclaw-ebay-seller",
  name: "TangleClaw eBay Seller",
  description:
    "OpenClaw plugin for eBay seller automation — connect your own eBay seller account via authorization_code OAuth, read inventory/offers/orders/business-policies, and draft + publish listings behind a two-step approval gate. Direct REST against the eBay Sell APIs; the seller user token is stored locally and auto-refreshed. Hard-gated writes protect anything that touches live listings or money.",
  configSchema,
  // S0 scaffold: zero tools. OAuth (S1) + read tools (S2-S3) + gated writes
  // (S4-S6) land in later chunks. The empty surface still builds and loads,
  // proving the manifest + entry point are wired correctly.
  tools: () => [],
});
