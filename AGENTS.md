# Extension Startup

Read these files first and treat them as the active source of truth for this workspace:
1. `README.md`
2. `CURRENT_STATE.md`
3. `OPERATIONS.md`
4. `CHANGE_PROCESS.md`
5. `RELEASE.md`
6. `PUBLIC_RELEASE_BOUNDARY.md`
7. `GITHUB_PUBLISHING.md` for public GitHub source work

Workspace rules:
- This workspace owns extension runtime code, extension tests, packaging, MV3 validation, and the public source-release handoff.
- This is the only public-safe Talon Defender repo.
- This workspace does not own website pages, backend services, deployment scripts, nginx config, private tracking docs, or business operations material.
- If a change affects welcome, uninstall, trial reminder, or license verification contracts, update the matching Website, API, or Tracking workspace in the same pass.
- Before adding a new top-level file or folder, make sure `scripts/audit-public-safe.mjs` and `scripts/package-public-source.ps1` still allow the intended public surface.

Before changing anything, summarize:
1. what this workspace owns
2. what it does not own
3. the commands and checks that apply
4. any public-release risk for the request
