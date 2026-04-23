# Release

Chrome release:
- `npm run release:extension`

Edge release:
- `npm run release:extension:edge`

Both store targets:
- `npm run release:extension:all`

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

Phase 2B release gate:
- schema `4` community payloads with `tactics` are backward-incompatible with older store builds, so do not publish live production tactic payloads until the Chrome and Edge Phase 2B releases are live enough in user hands
- until both stores are live enough, keep production community publishes on schema `2` or `3` payloads without `tactics`
- after both store builds are live enough, tactic publishes must still stay inside the bounded public contract: exact-host only, same-origin JSON responses only, and packaged `jsonPrune` / `jsonSet` behavior only, with `jsonSet` limited to the approved empty-safe values
