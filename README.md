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
- it verifies paid licenses against the API
- it falls into paywall mode when entitlement expires
- while entitled, it can fetch a signed community rules bundle from the API

Key commands:
- `npm test`
- `npm run audit:public-content`
- `npm run audit:public-safe`
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
