---
name: Bug report
about: Something broken — a tool errors unexpectedly, a result is wrong, or behavior diverges from docs.
title: "[bug] "
labels: bug
---

## Summary

One sentence: what's broken.

## Reproduction

1. Configuration (`plugins.entries.tangleclaw-ebay-research.config.*` values, redacted of any secrets):
2. Tool call(s) you made (tool name + parameters):
3. What happened (exact error / wrong value):
4. What you expected to happen:

## Environment

- Plugin version (from `package.json` or `openclaw plugins list`):
- OpenClaw gateway version:
- Node version inside the gateway container:
- eBay environment (`sandbox` / `production`):
- Marketplace (default `EBAY_US`):
- Marketplace Insights enabled? (`enableInsights: true` / `false`):

## Logs

Paste relevant gateway logs (redact tokens / secrets first). The eBay `errorId` from the error message is especially useful.

## Anything else

Workarounds you've tried, related issues, screenshots, etc.
