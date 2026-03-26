# Talon Defender Extension

This workspace is the browser extension repo and the only Talon Defender workspace that is safe to publish publicly.

Public GitHub repo:
- `https://github.com/talondefender/talon-defender`

It owns:
- MV3 extension runtime code
- extension assets, locales, and bundled rulesets
- extension tests
- Chrome and Edge packaging and validation
- GPL and source-release handoff files
- public-safe documentation for the extension

It does not own:
- website pages or website deploy logic
- backend routes, Stripe, email, or Firestore logic
- nginx, VM, or Cloud Run operations
- private tracking control docs
- business or support operations material

Current product summary:
- the extension starts a 7-day trial on first use
- it ships six default DNR rulesets enabled by default
- it also bundles five additional annoyance rulesets disabled by default and auto-enables that full annoyance family in complete mode
- it also bundles a public-safe regional language ruleset family disabled by default and auto-enables locale-matched entries on untouched profiles
- it now exposes a plain-language `Extra protection` toggle in Settings for the stronger non-default annoyance packs
- it verifies paid licenses against the API
- it falls into paywall mode when entitlement expires
- while entitled, it can fetch a signed baseline community bundle from the API plus signed site-keyed overlay hotfixes derived from the same community base URL, with a 6-hour baseline success TTL, a 15-minute baseline failure retry path, per-site emergency overlay retries and negative-cache handling, stored-rule or packaged-fallback recovery when remote apply fails, rollback to the last-known-good compiled community state when remote extras cannot be activated cleanly, authoritative cleanup when the lane is disabled or invalid, immediate injectable refresh for signed cosmetics, heuristics, public directives, public scriptlets, and packaged bounded JSON-response tactics, uniform rejection of Talon-owned first-party host scopes across every remote lane, packaged-equivalent compatibility exclusions for remote scriptlets, proof-only state scrubbing when developer mode is off, recoverable content-script registration with persisted diagnostics, collision-safe remote scriptlet canonicalization, exact-host registration plus exact-host live refresh for the remote-tactics lane, a packaged `fetch`/`XMLHttpRequest` interpreter for signed `jsonPrune` and `jsonSet` tactics including empty array/object writes, and a narrow MV3-safe exception lane for `allow`, `allowAllRequests`, third-party packaged redirects, and exact-host first-party path-scoped packaged redirects

Key commands:
- `npm test`
- `npm run audit:public-content`
- `npm run audit:public-safe` (`public-safe-allowlist.txt` is the exact release manifest)
- `npm run package:extension`
- `npm run validate:mv3-package`
- `npm run package:extension:edge`
- `npm run validate:mv3-package:edge`
- `npm run release:extension`
- `npm run release:extension:edge`

GitHub rule:
- manage the public GitHub repo from this workspace only
- do not create a separate GitHub-only source folder
- use `GITHUB_PUBLISHING.md` for the public push and tag workflow
- public tests are limited to the explicit release-gate `.test.js` files only
