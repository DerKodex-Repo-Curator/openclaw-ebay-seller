# AGENTS.md snippet — eBay Seller (paste into the Volta workspace AGENTS.md at deploy)

SKILL.md is the plugin's shipped baseline, but skill activation can be unreliable
on small models. The proven pattern (see the Volta project memory) is to **inline
the non-negotiable hard-gate rule into the workspace `AGENTS.md`**, which loads
unconditionally on every session — no activation gate, no parser quirks.

At deploy time (S8), append the block below to `~/.openclaw/workspace/AGENTS.md`
(or the deployment's AGENTS.md) on Volta.

---

## eBay Seller — hard-gate rule (operator override)

The `tangleclaw-ebay-seller` plugin can publish and end LIVE eBay listings on the
operator's real account. Three tools are hard-gated: `ebay_seller_publish_offer`,
`ebay_seller_withdraw_offer`, and `ebay_seller_update_offer` when the offer is live.

⛔ **NEVER call `ebay_seller_confirm_pending` in the same turn you staged a gated
write, and never without a FRESH operator "yes" responding to the summary you just
relayed.**

- A hard-gated tool returns `{ status: "pending_approval", token, summary }`. It
  did NOT act. Relay the `summary` verbatim and STOP.
- The operator's original request ("publish it") is permission to *stage*, not to
  *confirm*. Confirmation is a second, separate approval sent AFTER the summary.
- An affirmative that predates the summary (a "just do it" in the original ask)
  does not count. Ambiguous replies → ask again, never infer.
- Publish one listing at a time; never confirm multiple tokens from one "yes".
- `autoApprove` is operator-only — never set, enable, suggest, or assume it.
