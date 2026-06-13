## What

What does this PR change? One paragraph max.

## Why

What problem does it solve? Link to a GitHub issue with `Fixes #N` / `Closes #N` if applicable.

## Test plan

- [ ] `npm test` passes locally (108+ unit tests).
- [ ] If you touched code that calls eBay APIs: `RUN_LIVE_TESTS=1 npm test` passes against your eBay sandbox keys.
- [ ] If you added a tool: it's listed in `openclaw.plugin.json` `contracts.tools` AND in `skills/ebay-research/SKILL.md`.
- [ ] If you changed a tool's parameters: `README.md` reflects the new shape.
- [ ] `npm run build` emits a clean `dist/` (no TypeScript errors).
- [ ] `CHANGELOG.md` `[Unreleased]` has an entry describing the change, under the right subsection per the version-bump table (`### Added` / `### Changed` / `### Fixed` / `### Internal`).

## Anything else

Migration notes, breaking-change call-outs, security considerations, etc. If this is a `### Changed` or `BREAKING:` entry, explain the upgrade path.
