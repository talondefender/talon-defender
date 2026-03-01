# Talon Defender

Talon Defender is a Manifest V3 Chrome extension focused on simple, automatic ad and tracker blocking.
It is designed for non-technical users and ships with a minimal, senior-friendly UI.

## Feature Snapshot
- MV3-compliant filtering via `declarativeNetRequest`.
- Curated default protection lists for ads, privacy, pop-ups, and security.
- Signed community updates fetched over HTTPS.
- Allowlist for trusted sites.
- Auto-backoff to reduce site breakage after blocked navigation errors.
- Subscription and trial licensing with offline key support and remote verification.
- No telemetry or analytics collection.

## Settings Overview
- Block most ads (ublock-filters, easylist)
- Stop tracking (easyprivacy)
- Hide pop-ups and banners (annoyances-overlays)
- Block known dangerous sites (ublock-badware, urlhaus-full)
- Allowed Sites manager

## Project Structure
- `manifest.json` - MV3 manifest and static ruleset declarations
- `js/` - service worker, entitlement, ruleset manager, and content script registration
- `popup/` - popup UI
- `options/` - settings UI
- `rulesets/` - compiled MV3 rulesets and metadata
- `automation/` - heuristics and automation directives
- `shared/` - shared UI constants and links
- `icons/`, `css/`, `img/` - assets

## Getting Started
1. Open `chrome://extensions` and enable Developer mode.
2. Click **Load unpacked** and select the repo root.

## Packaging Workflow
- Source of truth for extension code is always the repo root.
- Build a fresh release package (unpacked + zip):
  - `npm run release:extension`
- Run package build + MV3 validation:
  - `npm run lint`

## Community Rules
When a valid subscription is active, Talon Defender fetches signed community bundles from:
`https://api.talondefender.com/v1/community/latest.bundle.json`

The public key for signature verification lives in `js/community-sync.js`.

## GPL And Corresponding Source
- Extension code is licensed as `GPL-3.0-or-later`.
- For every released extension version `X.Y.Z`, the corresponding source is published at:
  - `https://github.com/talondefender/talon-defender/tree/vX.Y.Z`
  - `https://github.com/talondefender/talon-defender/archive/refs/tags/vX.Y.Z.tar.gz`
- Packaged builds include `source-code.json` and the extension UI links to "Source code for this version".
- Backend services (for example `api.talondefender.com`) are separate infrastructure, are not conveyed as part of the browser extension package, and are not covered by this extension GPL license.
- Paid subscriptions cover convenience/services/support (for example signed community updates), not GPL rights restrictions.
- Recipients may run, study, modify, and redistribute the GPL-covered extension under GPL terms.

## License
Talon Defender is licensed under the GNU GPL v3.0 or later.
See `LICENSE.txt` and `ATTRIBUTION.md`.
