# Release

Chrome release:
- `npm run release:extension`

Edge release:
- `npm run release:extension:edge`

Both store targets:
- `npm run release:extension:all`

What each release script does:
- runs the quality gate for the target store
- packages the extension from source
- validates the unpacked MV3 package
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
