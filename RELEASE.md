# Release

Chrome release:
- `npm run release:extension`

Edge release:
- `npm run release:extension:edge`

Both store targets:
- `npm run release:extension:all`

Full release readiness gate:
- `npm run release:gate`

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
