## Third-Party Notices

Last updated: 2026-02-26

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

### Inter font (`css/fonts/Inter`)
- Source: https://github.com/rsms/inter
- License: SIL Open Font License 1.1

### Country flags (`img/flags-of-the-world/*`)
- Source: https://flagpedia.net/
- License note: public-domain/commercial-use statement in `img/flags-of-the-world/README`

## Bundled Filter Lists In Distributed Extension Packages

Only the following compiled rulesets are bundled in release packages:

| Ruleset ID | Upstream Source | License |
| --- | --- | --- |
| `ublock-filters` | https://github.com/uBlockOrigin/uAssets | GPL-3.0-or-later |
| `easylist` | https://easylist.to/ | GPL-3.0-or-later OR CC-BY-SA-3.0 |
| `easyprivacy` | https://easylist.to/ | GPL-3.0-or-later OR CC-BY-SA-3.0 |
| `annoyances-overlays` | https://github.com/easylist/easylist#fanboy-lists | GPL-3.0-or-later OR CC-BY-SA-3.0 |
| `ublock-badware` | https://github.com/uBlockOrigin/uAssets | GPL-3.0-or-later |
| `urlhaus-full` | https://gitlab.com/malware-filter/urlhaus-filter | MIT |

License-policy gate file: `rulesets/ruleset-license-policy.json`

## Corresponding Source

For every released extension version `X.Y.Z`, corresponding source is published at:
- `https://github.com/talondefender/talon-defender/tree/vX.Y.Z`
- `https://github.com/talondefender/talon-defender/archive/refs/tags/vX.Y.Z.tar.gz`

