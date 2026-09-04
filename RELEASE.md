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
- YouTube is a Talon-owned exception: parity work must not copy uBO Lite's YouTube scriptlet/runtime method or overwrite `js/scripting/youtube-ad-skip.js`; upstream scriptlets remain excluded from YouTube hosts
- any minimum Chrome version increase, new permission, unknown drift, or Talon-owned path overwrite requires explicit human approval

What each release script does:
- runs `scripts/verify-release.mjs --release --target <store>`: unit tests, both public audits, dependency audits, packaging, MV3 validation, and required artifact-specific browser smoke
- fails when the git working tree is dirty or when the matching `v<manifest.version>` source tag does not point at `HEAD`
- fails if packageable runtime files are untracked or missing from the public-safe release manifest
- packages the extension from source
- validates the unpacked MV3 package
- keeps the Chrome package on the published extension id while the Edge package strips store-specific `key` and `update_url`
- verifies every packaged file against browser-tested SHA-256 evidence immediately before zip creation; missing, stale, tampered, or non-release evidence fails closed
- verifies ZIP entry hashes against the browser-tested directory and public source ZIP entries against the exact public allowlist; records whole package/source ZIP SHA-256 values in release evidence, build info, and source metadata before handoff
- verifies critical packaged files still match source hashes
- verifies compliance files are present in the packaged output
- creates the store zip in `dist/`
- rebuilds the public source archive and `source-release.json`
- syncs current handoff files into `../Talon Defender Latest/`
- pass `-StageOnly` to either PowerShell release entry point to keep the fully verified ZIP/source handoff in `dist/` for review before Latest promotion; it skips only the final sync, and all release/browser/archive checks still run

Current artifact names:
- Chrome zip: `dist/talon-defender-extension.zip`
- Chrome build info: `dist/extension-build-info.json`
- Edge zip: `dist/talon-defender-edge-extension.zip`
- Edge build info: `dist/edge-extension-build-info.json`
- public source archive: `dist/talon-defender-extension-source-v<version>.zip`
- public source manifest: `dist/source-release.json`

Store handoff rule:
- release from this workspace
- commit the release source and create the matching `v<manifest.version>` tag before generating store handoff artifacts
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
- `npm run verify:ci` runs the shared gate on local changes and in public CI; it does not create store handoff artifacts or require a release tag
- `npm run test:chrome-smoke` and `npm run test:edge-smoke` are standalone development checks; the release gate always requires browsers and cannot accept a skip
- browser verification copies the selected unpacked artifact into a disposable profile directory, preserving the hashed package. It checks startup/options, DNR, entitlement expiry/restoration, worker wake, registration repair, Allowed Sites, quota messaging, and synthetic YouTube early execution, live teardown, and legacy-document migration
- use `TALON_CHROME_PATH` and `TALON_EDGE_PATH` to select current browser binaries; the shared gate requires an explicit current Chrome path. CI installs official Stable Chrome for Testing and Microsoft Edge
- `TALON_CHROME_MIN_PATH` is mandatory for the shared gate and must point to Chrome for Testing `122.0.6261.128`; the smoke checks the actual browser major, and both store artifacts also run on this minimum Chromium build
- run `scripts/install-minimum-chrome.ps1 -DestinationDirectory <absolute-private-directory>` to download and verify the single version/URL/SHA-256 pin in `scripts/minimum-chrome.json`; the installer prints the executable path. Public and integrated CI use this same installer
- use `scripts/install-current-chrome.ps1 -DestinationDirectory <absolute-private-directory>` for the official current Stable Chrome for Testing; set its returned executable as `TALON_CHROME_PATH`. The installer records the official channel timestamp, version, download URL and archive SHA-256 outside public source. Public CI uses this current-browser installer rather than a bundled Playwright Chromium version
- all smoke pages use local or intercepted synthetic fixtures with external DNS blocked; minimum Chromium testing does not establish historical Edge 122 compatibility. Keep that limitation explicit until an authentic Microsoft binary is available
- development and release evidence includes a digest of the public source tree, so changes at the same HEAD cannot reuse old evidence
- retain `dist/release-verification-chrome.json` and `dist/release-verification-edge.json` with the matching artifact until rollout is monitored

Compatibility and rollout:
- keep the manifest minimum at Chrome 122 and preserve all entitlement, trial, device, custom-filter, and site-mode state
- deploy the shared 4 MiB decoded-body publisher prevalidation before API enforcement and Extension rollout. Existing signed schemas and verification keys are unchanged
- use the store staged rollout controls where available, verify real playback and Allowed Sites in the private browser lab, and expand only after the existing paid/trial and browser gates pass
- legacy YouTube documents keep their old controller until natural navigation; do not force reloads or clear user playback/storage state
- rollback requires a new higher extension version built from the known-good source and fresh browser evidence. Preserve storage schemas and independently revoke faulty signed overlays through the backend controls

License and trial preservation gate:
- parity releases must preserve `talonEntitlement` and `talonEntitlementSync` state
- paid, grace-period, trial, expired-trial, and unlicensed states must survive extension update without reset
- no store submission is allowed when entitlement, paid status, grace status, trial start, or trial expiry changes unexpectedly
