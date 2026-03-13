# Current State

The extension is an MV3 blocker with a trial-plus-license entitlement model built on top of the uBOL codebase.

Runtime behavior now:
- `runtime.onInstalled` opens `https://talondefender.com/welcome/?source=install` on fresh install.
- the first popup flow can open `https://talondefender.com/welcome-live/?source=first_popup_open`.
- the uninstall URL is always set to `https://talondefender.com/uninstall/` with `source` and `version` query parameters.
- expired users can be reminded with `https://talondefender.com/trial-expired/` and a `trial_expired_reminder` source.

Entitlement behavior now:
- the free trial is `7` days from first initialization
- remote license verification defaults to `https://api.talondefender.com/v1/license/verify`
- remote verification is cached for `24` hours when the last check succeeded
- a remote license gets a `72` hour grace window after a successful verification
- offline signed license keys are also supported through the embedded Ed25519 public key set

Expired behavior now:
- when status becomes `expired`, the extension enables a paywall override with `dnr.setAllowAllRules(..., true, ...)`
- registered content scripts are unregistered while the paywall is active
- the toolbar icon switches to the warning shield and the badge shows `!`
- picker mode and other entitled behavior are blocked while the paywall is active
- in practice, expired status suspends blocking until the user restores entitlement

Bundled filtering surface now:
- default rulesets enabled in the manifest are `ublock-filters`, `easylist`, `easyprivacy`, `annoyances-overlays`, `ublock-badware`, and `urlhaus-full`
- release packaging prunes unbundled ruleset artifacts so the shipped package only contains manifest-backed resources

Community bundle behavior now:
- the default bundle URL is `https://api.talondefender.com/v1/community/latest.bundle.json`
- the bundle must pass SHA-256 integrity validation and Ed25519 signature verification
- community sync only runs while the extension is entitled
- when remote fetch fails, the extension falls back to stored rules or the packaged fallback bundle

Release posture now:
- this workspace is the only public-safe source surface
- Chrome and Edge release scripts also refresh `../Talon Defender Latest/`
