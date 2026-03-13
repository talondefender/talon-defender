# Change Process

1. Make extension runtime, asset, or test changes in this workspace only.
2. Keep the workspace public-safe. Do not add website code, backend code, deploy scripts, infra files, private runbooks, or business material.
3. If the change affects welcome pages, uninstall flow, trial reminders, tracking contracts, or license verification contracts, update the matching Website, API, or Tracking workspace in the same pass.
4. Update these docs whenever extension behavior, release flow, or public boundary rules change.
5. Run `npm test` and `npm run audit:public-safe`.
6. Repackage and validate the affected store target before considering the change complete.
