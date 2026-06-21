# Current State

The extension is an MV3 blocker with a trial-plus-license entitlement model built on top of the uBOL codebase.

Runtime behavior now:
- `runtime.onInstalled` opens `https://talondefender.com/welcome/?source=install` on fresh install.
- the first popup flow can open `https://talondefender.com/welcome-live/?source=first_popup_open`.
- the uninstall URL is always set to `https://talondefender.com/uninstall/` with `source` and `version` query parameters.
- expired users can be reminded with `https://talondefender.com/trial-expired/` and a `trial_expired_reminder` source.
- YouTube now uses a Talon-owned MV3 playback guard and narrowed ad-skip lane on `youtube.com` and `youtube-nocookie.com`. The guard is installed at document start, leaves YouTube player response ad metadata intact, shields only targeted playback enforcement storage signals and named abnormality callbacks, accelerates YouTube's native 17-second detector timer, uses bounded scheduled playback-wall checks instead of broad mutation-driven body scans, and keeps DOM append and Array push hooks opt-in rather than default. The ad-skip lane no longer performs synthetic skip-button clicks, broad YouTube ad-surface hiding, or whole-document mutation observation; it detects the player's native ad-showing state, temporarily mutes and accelerates native ad video playback, restores the user's video mute/playback-rate state after the ad clears, watches only the player class for fast ad-state transitions, and suppresses YouTube's matching "Experiencing interruptions" notice through timer and navigation checks.
- host grouping for auto-promotion and heuristic site comparisons now uses a packaged fail-closed site-key resolver so ccTLD hosts do not broaden to bare public suffixes such as `co.uk`.
- automation hide directives now apply across every matched selector in a directive, mirror their marker-based hide styles into discovered shadow roots and related fallback frames, and use a bounded retry backoff with inactivity reset instead of permanently stopping after three successful applies.
- automation directives can now declare required bundled rulesets, so popup and consent fixes track the user-facing protection toggles instead of running outside the selected popup/overlay posture, and Guardian article pages now have exact-host automation coverage for the Sourcepoint consent wall, the inline `#sign-in-gate` registration interrupt, the sticky bottom `StickyBottomBanner` reader-revenue prompt, and the article-end `#slot-body-end` contribution ask, with those curated Guardian nuisance prompts now suppressed by direct selector CSS so article-surface mutation guards do not block them.
- prepaint cosmetic timing now applies the low-risk ad-shell stylesheet synchronously at document start, marks matched shells for later parent-gap cleanup, excludes backed-off hosts from ad-shell registration, and starts conservative post-hide cleanup at document start while keeping mutation decisions behind the existing breakage guard.
- custom filter hostname walks now sanitize missing and non-string hostnames before slicing labels, preventing popup-panel and filtering lookups from crashing on `indexOf('.')` when a caller passes no hostname.
- picker and unpicker overlay startup now uses a one-time background capability claim before the web-accessible overlay page accepts its `MessagePort`.

Entitlement behavior now:
- the free trial is `7` days from first initialization
- remote license verification defaults to `https://api.talondefender.com/v1/license/verify`
- remote verification is cached for `24` hours when the last check succeeded
- a remote license gets a `72` hour grace window after a successful verification
- offline signed license keys are also supported through the embedded Ed25519 public key set
- worker startup now initializes cached entitlement before the first early injectable registration, so expired profiles enter paywall and warning-icon state before popup reads instead of briefly looking active
- popup and options license actions now bypass slow background startup gating and use bounded runtime waits so activation and `use this device` do not sit indefinitely on `Activating`
- popup and options now also apply the entitlement status returned by `setLicenseKey`, `replaceDevice`, and `clearLicenseKey` immediately, then fall back to a fresh entitlement read only when the runtime action fails
- when status transitions from expired/paywalled back to trial or paid, the worker clears the paywall, restores injectables, queues an async forced community sync, and defers the expensive open-tab runtime refresh so the activation response is not blocked

Expired behavior now:
- when status becomes `expired`, the extension enables a paywall override with `dnr.setAllowAllRules(..., true, ...)`
- registered content scripts and registered user scripts are unregistered while the paywall is active
- the toolbar icon switches to the warning shield and the badge shows `!`
- picker mode and other entitled behavior are blocked while the paywall is active
- in practice, expired status suspends blocking until the user restores entitlement

Bundled filtering surface now:
- default rulesets enabled in the manifest are `ublock-filters`, `talon-youtube-allow`, `easylist`, `easyprivacy`, `pgl`, `ublock-badware`, and `urlhaus-full`
- entering complete mode now auto-enables the full bundled annoyance family: `annoyances-ai`, `annoyances-cookies`, `annoyances-overlays`, `annoyances-social`, `annoyances-widgets`, `annoyances-others`, and `annoyances-notifications`
- the public Settings page now exposes an `Extra protection` toggle for the seven non-default annoyance packs, so users no longer need to understand the hidden complete-mode concept
- legacy or markerless ruleset selections now reset once to the canonical install defaults so reused Chrome storage cannot leave the public protection checkboxes blank, while later user checkbox changes persist normally across refreshes and restarts
- the public Options page now bootstraps its protection checkboxes from a canonical background snapshot through the trusted early-message path, loads ruleset state in parallel with entitlement state, starts from a neutral `Loading...` row state instead of a fake all-disabled render, listens for runtime ruleset broadcasts, and renders multi-ruleset toggles as `active`, `partial`, or `disabled` so early startup races cannot falsely show all protections unchecked
- the public popup now exposes a current-tab `Allowed Sites` control that adds the active hostname to no-filtering mode and can turn protection back on for that site, while Settings keeps the manual Allowed Sites list for arbitrary host entry and removal
- the public package now also bundles a public-safe regional language ruleset family disabled by default and auto-enables locale-matched entries on fresh installs and untouched profiles
- packaged uBO Lite-derived rulesets are aligned to reviewed stable Chromium baseline `2026.614.1502` for the 51 public-safe uBO Lite-derived manifest-backed rulesets, including the current compiled specific-cosmetic JSON layout
- upstream `bgr-0`, `dpollock-0`, and `pol-0` are documented exclusions in `rulesets/ruleset-license-policy.json`; they are not bundled because their license status is unknown or non-commercial
- obsolete split `generichigh` and per-ruleset `procedural` generated cosmetic directories have been removed from the public source surface; specific cosmetic registration now stores compiled `rulesets/scripting/specific/*.json` data before registering the uBO Lite specific cosmetic content scripts
- uBO Lite's packaged popup-prevention runtime is now wired for manifest-backed rulesets with popup metadata, using packaged `rulesets/scripting/popup/*.js` data and the upstream `prevent-popup` content scripts
- uBO Lite's packaged static scriptlet runtime now uses the compiled `rulesets/scripting/scriptlet/main/*.js` and `rulesets/scripting/scriptlet/isolated/*.js` bundle layout; Talon's signed community scriptlet hotfix lane keeps packaged-token compatibility under `js/scripting/scriptlet-token/`
- approved parity normalizations keep Talon's fail-closed `css-specific` procedural API guard and decode upstream scriptlet HTML that would otherwise trip Chrome Web Store readability checks, while hashing those forms as equivalent to the pinned uBO Lite source
- YouTube is an explicit parity exception: upstream uBO Lite scriptlets are excluded from YouTube hosts, and Talon's `js/scripting/youtube-ad-skip.js` and `js/scripting/youtube-player-guard.js` lanes must remain Talon-owned rather than copied from uBO Lite or another YouTube ad blocker.
- uBO Lite's `offscreen` and `userScripts` custom-filter compiler lane is now packaged and entitlement-gated, including the upstream offscreen compiler, scriptlet resource library, and regex analyzer support files
- release packaging and source hygiene both prune unbundled ruleset artifacts so the shipped package and public source surface only carry manifest-backed public-safe ruleset resources, plus explicitly preserved scriptlet aliases
- remaining manifest/resource parity differences are documented Talon product exceptions: entitlement alarms, frame-aware navigation diagnostics, packaged automation vocabulary, and omission of uBO Lite's zapper UI

Community bundle behavior now:
- the default bundle URL is `https://api.talondefender.com/v1/community/latest.bundle.json`
- community bundles are signed JSON data only: public store packages do not carry executable JavaScript, WASM, or remote command payloads, and signed community data can only select packaged DNR behavior, packaged redirect resources, packaged cosmetics/heuristics/directives, and packaged scriptlet tokens
- the extension now treats `latest.bundle.json` as the signed baseline lane and derives signed site-keyed overlay requests from the same community base URL, compiling `baseline + active overlays` back into the existing `communityBundle*` effective state consumed by DNR and injectables
- schema `v4` community payloads can still be verified for signature compatibility, but public store builds ignore tactic payloads and do not persist public tactic storage keys
- the bundle must pass SHA-256 integrity validation and Ed25519 signature verification
- community sync only runs while the extension is entitled
- successful community sync now defaults to a `6` hour refresh cadence, accepts signed bundle TTLs only within `1..24` hours, and still retries failures after `15` minutes
- baseline community sync now runs through a single-flight lane, and a forced post-activation baseline sync queues one follow-up run if another sync is already in flight
- emergency and breakage-triggered hotfix recovery now targets per-site overlays first, coalesces in-flight work per site key, preserves the current overlay on fetch failure, and only recompiles the effective bundle through one serialized apply lane so baseline and overlay writes cannot race each other
- schema `v2` community bundles can now ship tightly scoped MV3-safe exception rules using exact-host `allow`, exact-host `allowAllRequests`, third-party packaged-resource `redirect` actions, and exact-host first-party path-scoped packaged redirects
- signed public bundles can now also ship host-scoped directives and bundled-allowlist scriptlets in normal store builds without developer mode
- signed remote DNR rules, cosmetics, heuristics, directives, and scriptlets now all reject Talon-owned first-party host scopes so community hotfixes cannot target `talondefender.com` pages
- remote scriptlet registration uses the packaged public compatibility path and intentionally excludes YouTube hosts, which are handled by the Talon-owned YouTube ad-skip and player guard lanes
- signed remote extras now activate with rollback semantics: the worker snapshots the prior community state, stages the candidate bundle, and restores the last-known-good rules and extras if injectable registration fails
- active overlays survive restart, can be removed by signed `404`/`410` overlay responses, negative-cache missing or revoked site keys for `30` minutes, retry fetch failures after `5` minutes, and keep the previous overlay active until a replacement compiles successfully
- overlay merge precedence now keeps more recent overlays ahead of older overlays, keeps overlays ahead of the baseline within each quota class, dedupes merged cosmetics and heuristic arrays, replaces directives by `id`, and re-canonicalizes merged scriptlets by `rulesetId` + `token` + `world`
- public store builds now ignore signed tactic entries rather than registering page-world response mutators, and the non-shipped tactic interpreter source is not kept in the public extension/source-release surface
- when community sync is disabled or the configured bundle URL is invalid, the extension clears active community DNR rules plus stored remote cosmetics, heuristics, directives, scriptlets, and sync diagnostics state
- public package and public source validation now fail if tactic interpreter files, registration IDs, or public tactic storage keys appear in public artifacts
- public startup now scrubs only proof-lane directives, scriptlets, and breakage-audit overrides before injectable registration, while preserving active public signed hotfix extras
- successful sync and private-state cleanup now trigger an immediate full injectable refresh when remote cosmetics, heuristics, directives, or scriptlets changed
- signed remote cosmetics can now carry both global selectors and host-scoped selectors without a store update
- remote heuristics can now carry signed `labelRegexes`, `labelSelectors`, and `widgetSelectors` so the native ad-marker vocabulary and selector tuning can expand without a store update
- remote scriptlet authoring now canonicalizes duplicate `rulesetId` + `token` + `world` entries by merging and sorting hosts before storage and registration, so public and proof lanes cannot collide on content-script ids
- when remote fetch or remote apply fails, the extension falls back to stored rules or a non-empty packaged DNR fallback bundle, clears stale private proof-lane state, and retries after `15` minutes without treating the failed attempt as a successful sync
- emergency community sync now tracks last attempt separately from last successful apply, uses a short attempt debounce before retrying the same domain, and only burns the full cooldown after a real remote apply succeeds
- the allow-all DNR helper now self-heals partial dynamic/session mismatches, verifies the final paired state, rolls back on partial update failure, and reports both repairs and rollbacks through troubleshooting diagnostics
- injectable registration now retries once after a full reset of extension-managed content scripts and persists the latest sync result for troubleshooting
- troubleshooting/report output now exposes compiled community bundle version, baseline version and last baseline attempt/success/error state, active overlay and negative-cache counts, last overlay site/version/reason/status, last emergency-sync attempt versus success state, cleanup reason, activation rollback state, public versus proof hotfix counts, dropped quota classes, partial DNR repair state, allow-all rollback state, active exception counts, remote heuristic regex counts, host-scoped cosmetic counts, ignored public tactic counts, and injectable sync recovery errors for operator diagnostics

Release posture now:
- this workspace is the only public-safe source surface
- the manifest keeps `<all_urls>` because blocking, cosmetic filtering, strict-block navigation, picker/unpicker, and per-site protection checks must apply on arbitrary user-visited pages.
- the Chrome source manifest now pins the Chrome Web Store public key so unpacked Chrome loads keep the published extension id and storage namespace
- release hygiene now blocks versioned store handoffs from a dirty or untagged tree, so `source-code.json` and the public source archive cannot point at a `v<version>` tag that does not contain the package contents
- Chrome and Edge release scripts also refresh `../Talon Defender Latest/`
- `npm run release:gate` runs unit tests, public-safe and release-hygiene audits, production/dependency audits, Chrome and Edge package validation, public source packaging, and the Chrome smoke test when Chrome is available
