# Operations

Setup:
- Use Node `24.19.0` from `.node-version` and npm `11.1.0`, then `npm ci`

Core verification:
- `npm run verify:ci` runs the shared required Chrome/Edge artifact verification without requiring a release tag
- `npm test`
- `npm run audit:public-content`
- `npm run audit:public-safe`
- `npm run audit:release-hygiene`
- `npm run parity:watch -- --baseline-tag <current-upstream-tag>` for read-only latest uBO Lite release detection
- `npm run parity:audit -- --upstream-dir <path-to-pinned-ubol-chromium>` for read-only uBO Lite drift reports
- `npm run parity:status -- --report <audit-report.json>` for non-developer ship/no-ship parity summaries
- `npm run generate:reload-sensitive-artifacts` after changing packaged static or signed-token scriptlet JavaScript; `npm test` and MV3 package validation reject stale generated hashes
- update `public-safe-allowlist.txt` whenever a new tracked public file is intentionally added

Packaging:
- `npm run package:extension`
- `npm run validate:mv3-package`
- `npm run package:extension:edge`
- `npm run validate:mv3-package:edge`
- `npm run package:public-source`

Release commands:
- `npm run release:archive-current`
- `npm run release:extension`
- `npm run release:extension:edge`
- `npm run release:extension:all`

Working directories and outputs:
- local build output lands in `dist/`
- Chrome unpacked build lands in `dist/extension`
- Edge unpacked build lands in `dist/edge-extension`
- current handoff artifacts are copied into `../Talon Defender Latest/chrome`, `../Talon Defender Latest/edge`, and `../Talon Defender Latest/source`

Operational rules:
- Community response limits are 4 MiB of decoded UTF-8 bytes for both baseline and overlay. Publish only payloads validated against this shared bound; enable publisher enforcement before API and Extension rollout. Preserve the signed last-known-good generation on timeout, oversize, parse, verification, or activation failure.
- do not add private operational files here
- keep `source-code.json` and the public source archive tied to the public repository tag
- store handoff artifacts require a clean working tree and a matching `v<manifest.version>` tag at `HEAD`
- if you add a top-level file or folder, update the public-safe audit and source-package allowlists in the same change
- public GitHub sync happens from this workspace; `../Talon Defender Latest/` is only the handoff artifact workspace
- public tests may only use the explicit `.test.js` files and placeholder or product-owned URLs
- parity imports must use pinned uBO Lite Chromium release artifacts, never floating upstream branches
- YouTube is a Talon-owned runtime exception: do not import uBO Lite's YouTube scriptlet/runtime strategy onto YouTube hosts, and do not overwrite `js/scripting/youtube-ad-skip.js` during parity work
- run parity watching from a private scheduler or backend control plane; update the baseline only after the pinned release is reviewed
- backend hotfix payloads are signed data only; do not add remote JavaScript, remote scriptlet code, arbitrary procedural logic, or command interpreters
