# GitHub Publishing

This workspace is the only source workspace used for the public GitHub repo.

Public repo:
- `https://github.com/talondefender/talon-defender`

Do not create a separate GitHub-only source folder.

Use this model:
- `Talon Defender Extension` is the working source repo for public code
- `Talon Defender Latest` is the artifact handoff workspace only
- Website, API, Tracking, Operations, and the Control Center root stay private

Normal update flow:
1. Make extension changes in this workspace.
2. Run the relevant release command:
   - `npm run release:extension`
   - `npm run release:extension:edge`
   - or `npm run release:extension:all`
3. Verify `dist/` and `../Talon Defender Latest/` contain the expected current artifacts.
4. Commit the change in this workspace.
5. Push `main` to `https://github.com/talondefender/talon-defender`.

Public-review guard:
- `npm run audit:public-safe` is the pre-push gate for this workspace
- the public `test/` surface is limited to the explicit release-gate `.test.js` files
- ad hoc corpora, captures, and live third-party content URLs do not belong in the public repo

Version tag rule:
- `v<manifest.version>` is the public source tag for the shipped extension version
- update that tag only when you are publishing the source snapshot for that version
- `source-code.json` and `source-release.json` must match that tag and tarball URL

Working rule:
- if you only need to update the public GitHub repo, work here
- do not copy source into another folder first
- if you add a new top-level file or folder, update the public-safe audit and source-package allowlists in the same change
