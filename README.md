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
- native heuristics reads packaged configuration through the extension background rather than fetching a dynamic resource URL from the visited page
- active YouTube protection hides mealbar promotional offers while preserving ordinary dialogs and player controls
- the 540 px popup places subscription and license actions beside protection/site details, keeps the CTA visible without scrolling in supported default layouts, and puts optional reviews in the footer; colors, icons, wording, and typography are preserved
- the popup offers localized 1-5-star feedback below its main controls: 1-3 thanks the user, while 4-5 opens Talon's appropriate store page in a new tab; a local responded flag hides the card on subsequent openings without saving the score or submitting a store rating
- popup dependencies preload together, and usable saved state unlocks the protection toggle before background panel refresh completes on reopening
- the extension starts a 7-day trial on first use
- it ships default blocker DNR rulesets enabled by default, plus Talon-owned YouTube and site compatibility rulesets
- it also bundles seven non-default annoyance rulesets: one owned by the `Pop-ups` control and six owned by `Extra protection`, with the full family auto-enabled in complete mode
- it also bundles a public-safe regional language ruleset family disabled by default and auto-enables locale-matched entries on untouched profiles
- it now exposes a plain-language `Extra protection` toggle in Settings for the stronger non-default annoyance packs
- it verifies paid licenses against the API
- it falls into paywall mode when entitlement expires
- YouTube respects entitlement, Allowed Sites, and subsystem backoff through policy-scoped persistent document-start registration. Live policy changes stop and restore owned hooks, media state, styles, listeners, and queued work without reloading or seeking. Documents containing the older irreversible guard migrate on their next natural navigation.
- YouTube displays a centered Talon status message throughout ad acceleration and native Skip handoffs, keeps its expanded layout until handling ends, and hides modern in-player ad cards and companion slots without hiding Skip. A presentation-only expired-protection message remains subject to authoritative site and entitlement policy; it never enables ad blocking or changes playback while protection is expired.
- YouTube uses a Talon-owned playback guard and narrowed ad-skip lane on YouTube hosts only. The guard leaves YouTube player response ad metadata intact, shields only known playback enforcement/reset signals, keeps playback-wall reload recovery disabled, clicks bounded native Skip/Skip Ads controls when present, and temporarily speeds/mutes detected ad playback without seeking the timeline. uBO Lite scriptlet/runtime parity is intentionally excluded on YouTube hosts so Talon does not copy uBO Lite's YouTube method.
- while entitled, it can fetch signed JSON community data from the API: a baseline bundle plus signed site-keyed overlay hotfixes derived from the same community base URL. The public store package does not fetch or execute remote JavaScript, WASM, or remote command payloads; signed community data can only select packaged DNR rules, packaged redirect resources, packaged cosmetics/heuristics/directives, and packaged scriptlet tokens. The lane uses SHA-256 integrity, Ed25519 signatures, rollback to the last-known-good compiled state, authoritative cleanup when disabled or invalid, Talon-owned first-party host rejection, packaged compatibility exclusions, quota bounds, and retry/negative-cache handling.

Store review notes:
- public Chrome and Edge packages and the public source archive exclude the non-shipped tactic interpreter artifacts
- package and source-release validation fail if tactic interpreter artifacts, runtime registration IDs, or public tactic storage keys appear in public artifacts
- remote community bundles are signed JSON configuration only; they cannot deliver remote JavaScript, WASM, or arbitrary command payloads
- `<all_urls>` is required for the reviewed blocker surface: DNR blocking, cosmetic filtering, strict-block navigation, picker/unpicker, and per-site protection checks on user-visited pages
- picker and unpicker web-accessible overlay pages must claim a one-time background capability before accepting a `MessagePort`
- license keys are stored locally only; sync storage accepts only sync-safe activation token metadata when the API provides it
- `unlimitedStorage` protects versioned compiled cosmetic data and last-known-good rollback generations from Chrome's default local-storage quota; it is not used for browsing history or remote executable code
- `Allowed Sites` is reviewer-visible from the popup for the current tab and from Settings for manually entered hosts; it uses the existing filtering-mode allow-all DNR path and does not require the `cookies` permission

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
- `npm run verify:ci`
- `npm run test:chrome-smoke`
- `npm run test:edge-smoke`
- `npm run release:gate`
- `npm run release:extension`
- `npm run release:extension:edge`

GitHub rule:
- manage the public GitHub repo from this workspace only
- do not create a separate GitHub-only source folder
- use `GITHUB_PUBLISHING.md` for the public push and tag workflow
- public tests are limited to the explicit release-gate `.test.js` files only
