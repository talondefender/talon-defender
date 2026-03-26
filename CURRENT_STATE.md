# Current State

The extension is an MV3 blocker with a trial-plus-license entitlement model built on top of the uBOL codebase.

Runtime behavior now:
- `runtime.onInstalled` opens `https://talondefender.com/welcome/?source=install` on fresh install.
- the first popup flow can open `https://talondefender.com/welcome-live/?source=first_popup_open`.
- the uninstall URL is always set to `https://talondefender.com/uninstall/` with `source` and `version` query parameters.
- expired users can be reminded with `https://talondefender.com/trial-expired/` and a `trial_expired_reminder` source.
- YouTube watch pages still have a manifest-declared `document_start` MAIN-world bootstrap script, but the public default now keeps its host-scoped enable cookie off unless an internal/private proof lane explicitly opts in.
- YouTube watch pages now also support an internal owner-profile switch for private proofing, so Talon can compare `talon-current`, `upstream-core`, and `upstream-core+talon-wins` ownership without changing the public product surface.
- Edge same-tab YouTube follow-up watch clicks now prep the tab, hop through a neutral `about:blank` document, and then re-enter the target watch URL so the next watch document is not bootstrapped directly from the prior watch page context.
- same-tab YouTube follow-up watch prep now caches a clean donor bootstrap envelope from a donor watch tab and seeds that envelope back into the target watch page at `document_start` before YouTube consumes the follow-up bootstrap state.
- host grouping for auto-promotion and heuristic site comparisons now uses a packaged fail-closed site-key resolver so ccTLD hosts do not broaden to bare public suffixes such as `co.uk`.
- automation hide directives now apply across every matched selector in a directive, mirror their marker-based hide styles into discovered shadow roots and related fallback frames, and use a bounded retry backoff with inactivity reset instead of permanently stopping after three successful applies.

Entitlement behavior now:
- the free trial is `7` days from first initialization
- remote license verification defaults to `https://api.talondefender.com/v1/license/verify`
- remote verification is cached for `24` hours when the last check succeeded
- a remote license gets a `72` hour grace window after a successful verification
- offline signed license keys are also supported through the embedded Ed25519 public key set
- when status transitions from expired/paywalled back to trial or paid, the worker clears the paywall, restores injectables, and queues an async forced community sync without blocking the activation response

Expired behavior now:
- when status becomes `expired`, the extension enables a paywall override with `dnr.setAllowAllRules(..., true, ...)`
- registered content scripts are unregistered while the paywall is active
- the toolbar icon switches to the warning shield and the badge shows `!`
- picker mode and other entitled behavior are blocked while the paywall is active
- in practice, expired status suspends blocking until the user restores entitlement

Bundled filtering surface now:
- default rulesets enabled in the manifest are `ublock-filters`, `easylist`, `easyprivacy`, `annoyances-overlays`, `ublock-badware`, and `urlhaus-full`
- entering complete mode now auto-enables the full bundled annoyance family: `annoyances-cookies`, `annoyances-notifications`, `annoyances-others`, `annoyances-overlays`, `annoyances-social`, and `annoyances-widgets`
- the public Settings page now exposes an `Extra protection` toggle for the five non-default annoyance packs, so users no longer need to understand the hidden complete-mode concept
- the public package now also bundles a public-safe regional language ruleset family disabled by default and auto-enables locale-matched entries on fresh installs and untouched profiles
- release packaging prunes unbundled ruleset artifacts so the shipped package only contains manifest-backed resources

Community bundle behavior now:
- the default bundle URL is `https://api.talondefender.com/v1/community/latest.bundle.json`
- the extension now treats `latest.bundle.json` as the signed baseline lane and derives signed site-keyed overlay requests from the same community base URL, compiling `baseline + active overlays` back into the existing `communityBundle*` effective state consumed by DNR and injectables
- schema `v4` community payloads can now also carry signed public `tactics`, stored as `communityBundlePublicTactics`, with baseline + overlay precedence merged by tactic `id`
- the bundle must pass SHA-256 integrity validation and Ed25519 signature verification
- community sync only runs while the extension is entitled
- successful community sync now defaults to a `6` hour refresh cadence, accepts signed bundle TTLs only within `1..24` hours, and still retries failures after `15` minutes
- baseline community sync now runs through a single-flight lane, and a forced post-activation baseline sync queues one follow-up run if another sync is already in flight
- emergency and breakage-triggered hotfix recovery now targets per-site overlays first, coalesces in-flight work per site key, preserves the current overlay on fetch failure, and only recompiles the effective bundle through one serialized apply lane so baseline and overlay writes cannot race each other
- schema `v2` community bundles can now ship tightly scoped MV3-safe exception rules using exact-host `allow`, exact-host `allowAllRequests`, third-party packaged-resource `redirect` actions, and exact-host first-party path-scoped packaged redirects
- signed public bundles can now also ship host-scoped directives and bundled-allowlist scriptlets in normal store builds without developer mode
- signed remote DNR rules, cosmetics, heuristics, directives, and scriptlets now all reject Talon-owned first-party host scopes so community hotfixes cannot target `talondefender.com` pages
- remote scriptlet registration now applies the same packaged compatibility host exclusions, including YouTube owner-profile fences, before host matches are registered
- signed remote extras now activate with rollback semantics: the worker snapshots the prior community state, stages the candidate bundle, and restores the last-known-good rules and extras if injectable registration fails
- active overlays survive restart, can be removed by signed `404`/`410` overlay responses, negative-cache missing or revoked site keys for `30` minutes, retry fetch failures after `5` minutes, and keep the previous overlay active until a replacement compiles successfully
- overlay merge precedence now keeps more recent overlays ahead of older overlays, keeps overlays ahead of the baseline within each quota class, dedupes merged cosmetics and heuristic arrays, replaces directives by `id`, and re-canonicalizes merged scriptlets by `rulesetId` + `token` + `world`
- signed public tactics now accept only exact-host `jsonPrune` and `jsonSet` entries for same-origin JSON `fetch` or `XMLHttpRequest` responses, allow `jsonSet` writes only for bounded empty-safe values including `[]` and `{}`, reject Talon-owned and protected-domain targets, cap baseline/overlay/compiled counts, and drop compiled overflow from the tail after overlay-first precedence
- when community sync is disabled or the configured bundle URL is invalid, the extension clears active community DNR rules plus stored remote cosmetics, heuristics, directives, scriptlets, and sync diagnostics state
- the packaged remote-tactics lane now registers one isolated-world bootstrap plus one MAIN-world interpreter at `document_start` only on the compiled exact-host tactic union, mirrors that exact-host scope during open-tab runtime refresh, installs wrappers before page code runs, bridges exact-host tactic config by `CustomEvent`, reports tactic host counts through diagnostics, and fails closed back to the original response on parse, bridge, or tactic errors
- public startup now scrubs only proof-lane directives, scriptlets, and breakage-audit overrides before injectable registration, while preserving active public signed hotfix extras
- successful sync and private-state cleanup now trigger an immediate full injectable refresh when remote cosmetics, heuristics, directives, or scriptlets changed
- signed remote cosmetics can now carry both global selectors and host-scoped selectors without a store update
- remote heuristics can now carry signed `labelRegexes`, `labelSelectors`, and `widgetSelectors` so the native ad-marker vocabulary and selector tuning can expand without a store update
- remote scriptlet authoring now canonicalizes duplicate `rulesetId` + `token` + `world` entries by merging and sorting hosts before storage and registration, so public and proof lanes cannot collide on content-script ids
- when remote fetch or remote apply fails, the extension falls back to stored rules or a non-empty packaged DNR fallback bundle, clears stale private proof-lane state, and retries after `15` minutes without treating the failed attempt as a successful sync
- emergency community sync now tracks last attempt separately from last successful apply, uses a short attempt debounce before retrying the same domain, and only burns the full cooldown after a real remote apply succeeds
- the allow-all DNR helper now self-heals partial dynamic/session mismatches, verifies the final paired state, rolls back on partial update failure, and reports both repairs and rollbacks through troubleshooting diagnostics
- injectable registration now retries once after a full reset of extension-managed content scripts and persists the latest sync result for troubleshooting
- troubleshooting/report output now exposes compiled community bundle version, baseline version and last baseline attempt/success/error state, active overlay and negative-cache counts, last overlay site/version/reason/status, last emergency-sync attempt versus success state, cleanup reason, activation rollback state, public versus proof hotfix counts, dropped quota classes, partial DNR repair state, allow-all rollback state, active exception counts, remote heuristic regex counts, host-scoped cosmetic counts, public tactic counts and dropped tactic overflow, `remoteTactics` subsystem state, and injectable sync recovery errors for operator diagnostics

Release posture now:
- this workspace is the only public-safe source surface
- the Chrome source manifest now pins the Chrome Web Store public key so unpacked Chrome loads keep the published extension id and storage namespace
- Chrome and Edge release scripts also refresh `../Talon Defender Latest/`
