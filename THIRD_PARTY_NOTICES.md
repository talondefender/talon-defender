## Third-Party Notices

Last updated: 2026-06-01

Talon Defender is distributed under `GPL-3.0-or-later` and includes third-party code and data.

## Core Code And Assets

### uBlock Origin / uBlock Origin Lite derived code
- Source:
  - https://github.com/gorhill/uBlock
  - https://github.com/uBlockOrigin/uBOL-home
- License: GPL-3.0-or-later
- Notes:
  - GPL notices are preserved in relevant source files.

### CodeMirror bundle (`lib/codemirror/cm6.bundle.ubol.min.js`)
- Source: `lib/codemirror/README.md`
- License: MIT

### CSS Tree (`lib/csstree/css-tree.js`)
- Source package: `css-tree`
- License: MIT

### RegexAnalyzer (`lib/regexanalyzer/regex.js`)
- Source and license note: `lib/regexanalyzer/README.md`
- Notes:
  - Used by the packaged uBO Lite offscreen custom-filter compiler.

### Inter font (`css/fonts/Inter`)
- Source: https://github.com/rsms/inter
- License: SIL Open Font License 1.1

### Country flags (`img/flags-of-the-world/*`)
- Source: https://flagpedia.net/
- License note: public-domain/commercial-use statement in `img/flags-of-the-world/README`

## Bundled Filter Lists In Distributed Extension Packages

Compiled rulesets bundled in release packages are the manifest-backed set in `manifest.json`:
- the six default public rulesets
- additional non-default privacy, mobile, LAN, and annoyance rulesets
- the public-safe regional language rulesets declared for locale auto-enable
- documented upstream exclusions in `rulesets/ruleset-license-policy.json` are not bundled

The authoritative upstream source and license map for every bundled ruleset is:
- `rulesets/ruleset-license-policy.json`

License-policy gate file: `rulesets/ruleset-license-policy.json`

## Corresponding Source

For every released extension version `X.Y.Z`, corresponding source is published at:
- `https://github.com/talondefender/talon-defender/tree/vX.Y.Z`
- `https://github.com/talondefender/talon-defender/archive/refs/tags/vX.Y.Z.tar.gz`
