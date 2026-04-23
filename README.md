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
- it ships five default DNR rulesets enabled by default
- it also bundles five additional annoyance rulesets disabled by default and auto-enables that full annoyance family in complete mode
- it also bundles a public-safe regional language ruleset family disabled by default and auto-enables locale-matched entries on untouched profiles
- it now exposes a plain-language `Extra protection` toggle in Settings for the stronger non-default annoyance packs
- it verifies paid licenses against the API
- it falls into paywall mode when entitlement expires
- while entitled, it can fetch signed JSON community data from the API: a baseline bundle plus signed site-keyed overlay hotfixes derived from the same community base URL. The public store package does not fetch or execute remote JavaScript, WASM, or remote command payloads; signed community data can only select packaged DNR rules, packaged redirect resources, packaged cosmetics/heuristics/directives, and packaged scriptlet tokens. The lane uses SHA-256 integrity, Ed25519 signatures, rollback to the last-known-good compiled state, authoritative cleanup when disabled or invalid, Talon-owned first-party host rejection, packaged compatibility exclusions, quota bounds, and retry/negative-cache handling.

Store review notes:
- public Chrome and Edge packages and the public source archive exclude the non-shipped tactic interpreter artifacts
- package and source-release validation fail if tactic interpreter artifacts, runtime registration IDs, or public tactic storage keys appear in public artifacts
- license keys are stored locally only; sync storage accepts only sync-safe activation token metadata when the API provides it

Key commands:
- `npm test`
- `npm run audit:public-content`
- `npm run audit:public-safe` (`public-safe-allowlist.txt` is the exact release manifest)
- `npm run audit:release-hygiene`
- `npm run package:extension`
- `npm run validate:mv3-package`
- `npm run package:extension:edge`
- `npm run validate:mv3-package:edge`
- `npm run package:public-source`
- `npm run test:chrome-smoke`
- `npm run release:gate`
- `npm run release:extension`
- `npm run release:extension:edge`

GitHub rule:
- manage the public GitHub repo from this workspace only
- do not create a separate GitHub-only source folder
- use `GITHUB_PUBLISHING.md` for the public push and tag workflow
- public tests are limited to the explicit release-gate `.test.js` files only
