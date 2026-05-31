# Release

Chrome release:
- `npm run release:extension`

Edge release:
- `npm run release:extension:edge`

Both store targets:
- `npm run release:extension:all`

Full release readiness gate:
- `npm run release:gate`

Known-good backup gate:
- before parity or store-submission work, run `npm run release:archive-current`
- the backup script copies the current `../Talon Defender Latest/` Chrome, Edge, and source handoff artifacts into `dist/release-backups/`
- keep the generated `release-backup.json` with the package hashes and rollback notes until the new store rollout is monitored
- Chrome and Edge rollback normally require a new version number and store resubmission; disable signed backend overlays separately through the backend kill switch when needed

uBO Lite parity gate:
- use a private scheduler or backend control plane as the daily tripwire for new stable upstream Chromium releases
- run `npm run parity:audit -- --upstream-dir <path-to-pinned-ubol-chromium>` before importing upstream rulesets or runtime code
- run `npm run parity:status -- --report <audit-report.json>` after the audit to produce a ship/no-ship summary
- the audit is read-only and must classify drift before any import work starts
- ruleset-only PRs must not change runtime code, permissions, entitlement, backend behavior, or user-state migration logic
- any minimum Chrome version increase, new permission, unknown drift, or Talon-owned path overwrite requires explicit human approval

What each release script does:
- runs the quality gate for the target store
- fails if packageable runtime files are untracked or missing from the public-safe release manifest
- packages the extension from source
- validates the unpacked MV3 package
- keeps the Chrome package on the published extension id while the Edge package strips store-specific `key` and `update_url`
- verifies critical packaged files still match source hashes
- verifies compliance files are present in the packaged output
- creates the store zip in `dist/`
- rebuilds the public source archive and `source-release.json`
- syncs current handoff files into `../Talon Defender Latest/`

Current artifact names:
- Chrome zip: `dist/talon-defender-extension.zip`
- Chrome build info: `dist/extension-build-info.json`
- Edge zip: `dist/talon-defender-edge-extension.zip`
- Edge build info: `dist/edge-extension-build-info.json`
- public source archive: `dist/talon-defender-extension-source-v<version>.zip`
- public source manifest: `dist/source-release.json`

Store handoff rule:
- release from this workspace
- submit store artifacts from `../Talon Defender Latest/`

Public GitHub rule:
- the public repository is `https://github.com/talondefender/talon-defender`
- this workspace is the source of truth for that repo
- do not create or use a separate GitHub-only working folder
- use `GITHUB_PUBLISHING.md` when updating `main` or the `v<version>` tag

Phase 2A release gate:
- the production API overlay route is additive, so backend rollout may happen first without breaking older store builds
- the next required release step after backend rollout is `npm run release:extension` so the Chrome Web Store package actually contains the overlay-capable extension runtime
- submit the Chrome upload zip from `../Talon Defender Latest/chrome/`
- until that Chrome store rollout is live enough, treat the signed baseline bundle as the required hotfix lane and do not depend on overlay-only fixes for production users

Store-safe public package gate:
- public Chrome and Edge packages and the public source archive must not include tactic interpreter files, tactic registration ids, or public tactic storage keys
- schema `4` community payloads may be verified for signature compatibility, but public store builds ignore tactic entries
- `npm run validate:mv3-package`, `npm run validate:mv3-package:edge`, and `npm run package:public-source` are release blockers for accidental tactic artifact reintroduction

Smoke gate:
- `npm run test:chrome-smoke` packages the Chrome extension, loads it with the pinned extension id, checks startup/options data, default rulesets, entitlement paywall recovery, and quota messaging
- set `TALON_CHROME_SMOKE_REQUIRED=1` when Chrome/Chromium must be present instead of allowing a local skip

License and trial preservation gate:
- parity releases must preserve `talonEntitlement` and `talonEntitlementSync` state
- paid, grace-period, trial, expired-trial, and unlicensed states must survive extension update without reset
- no store submission is allowed when entitlement, paid status, grace status, trial start, or trial expiry changes unexpectedly
