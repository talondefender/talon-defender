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
- release packaging prunes unbundled ruleset artifacts so the shipped package only contains manifest-backed resources

Community bundle behavior now:
- the default bundle URL is `https://api.talondefender.com/v1/community/latest.bundle.json`
- the bundle must pass SHA-256 integrity validation and Ed25519 signature verification
- community sync only runs while the extension is entitled
- community sync now runs through a single-flight lane, and a forced post-activation sync queues one follow-up run if another sync is already in flight
- schema `v2` community bundles can now ship tightly scoped MV3-safe exception rules using exact-host `allow`, exact-host `allowAllRequests`, and packaged-resource `redirect` actions
- when community sync is disabled or the configured bundle URL is invalid, the extension clears active community DNR rules plus stored remote cosmetics, heuristics, directives, scriptlets, and sync diagnostics state
- public startup now scrubs private proof-lane directives, scriptlets, and breakage-audit overrides before injectable registration can reuse stale state from a prior private session
- successful sync and private-state cleanup now trigger an immediate injectable refresh when remote cosmetics, heuristics, directives, or scriptlets changed
- signed remote cosmetics can now carry both global selectors and host-scoped selectors without a store update
- remote heuristics can now carry signed `labelRegexes`, `labelSelectors`, and `widgetSelectors` so the native ad-marker vocabulary and selector tuning can expand without a store update
- when remote fetch or remote apply fails, the extension falls back to stored rules or a non-empty packaged DNR fallback bundle, clears stale private proof-lane state, and retries after `15` minutes without treating the failed attempt as a successful sync
- injectable registration now retries once after a full reset of extension-managed content scripts and persists the latest sync result for troubleshooting
- troubleshooting/report output now exposes community bundle version, schema version, last success/error state, cleanup reason, active exception counts, remote heuristic regex counts, host-scoped cosmetic counts, and injectable sync recovery errors for operator diagnostics

Release posture now:
- this workspace is the only public-safe source surface
- the Chrome source manifest now pins the Chrome Web Store public key so unpacked Chrome loads keep the published extension id and storage namespace
- Chrome and Edge release scripts also refresh `../Talon Defender Latest/`
