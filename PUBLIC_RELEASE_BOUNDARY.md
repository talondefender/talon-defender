# Public Release Boundary

This workspace is the only Talon Defender workspace intended for public GitHub and GPL source release.

Allowed here:
- extension runtime source
- extension assets, locales, and bundled rulesets
- extension tests that are part of the release gate
- packaging and validation scripts
- license, attribution, and third-party notice files
- public-safe docs needed to understand and release the extension

Forbidden here:
- website source
- backend source
- deployment scripts
- nginx, VM, or Cloud Run files
- support runbooks
- project logs
- private tracking control docs
- reviewer paperwork
- internal generated inventories
- business operations material

Release rules:
- `npm run audit:public-safe` must pass before release
- `source-code.json` must point to the public extension repository tag and tarball
- the public source archive must be built from this workspace only
- the public GitHub repo for this workspace is `https://github.com/talondefender/talon-defender`
- ad hoc corpora, captures, and live-content fixtures do not belong in the public `test/` surface
