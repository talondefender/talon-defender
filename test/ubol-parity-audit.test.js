import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildParityReport } from '../scripts/ubol-parity-audit.mjs';

const writeJson = async (root, relativePath, value) => {
  const absPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeText = async (root, relativePath, value) => {
  const absPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, value, 'utf8');
};

const encodedCaptchaPayload =
  'html(window.atob(\\"PGRpdiBjbGFzcz0idGV4dC1kYW5nZXIgZm9udC13ZWlnaHQtYm9sZCBoNSBtdC0xIj5DYXB0Y2hhIGltYWdlIGZhaWxlZCB0byBsb2FkLjxicj48YSBvbmNsaWNrPSJsb2NhdGlvbi5yZWxvYWQoKSIgc3R5bGU9ImNvbG9yOiM2MjcwZGE7Y3Vyc29yOnBvaW50ZXIiIGNsYXNzPSJ0ZXh0LWRlY29yYXRpb25lLW5vbmUiPlBsZWFzZSByZWZyZXNoIHRoZSBwYWdlLiA8aSBjbGFzcz0iZmEgZmEtcmVmcmVzaCI+PC9pPjwvYT48L2Rpdj4=\\"))';
const readableCaptchaPayload =
  'html(\'<div class=\\"text-danger font-weight-bold h5 mt-1\\">Captcha image failed to load.<br><a onclick=\\"location.reload()\\" style=\\"color:#6270da;cursor:pointer\\" class=\\"text-decoratione-none\\">Please refresh the page. <i class=\\"fa fa-refresh\\"></i></a></div>\')';

const upstreamCssSpecificProceduralLoader = [
  'await self.ProceduralFiltererAPI;',
  'self.listsProceduralFiltererAPI = new self.ProceduralFiltererAPI();',
].join('\n');

const talonCssSpecificProceduralLoader = [
  'if ( self.ProceduralFiltererAPI instanceof Promise ) {',
  '    try {',
  '        await self.ProceduralFiltererAPI;',
  '    } catch {',
  '    }',
  '}',
  '',
  "if ( typeof self.ProceduralFiltererAPI !== 'function' ) {",
  '    self.ProceduralFiltererAPI = undefined;',
  '    return;',
  '}',
  '',
  'try {',
  '    self.listsProceduralFiltererAPI = new self.ProceduralFiltererAPI();',
  '} catch {',
  '    self.listsProceduralFiltererAPI = undefined;',
  '    return;',
  '}',
].join('\n');

const makeFixture = async ({
  permissions = ['declarativeNetRequest', 'scripting', 'storage'],
  minimumChromeVersion = '122.0',
  rulesets = ['easylist'],
  detailsOverrides = {},
  licensePolicyRulesets = { easylist: { commercialUse: 'allowed' } },
  licensePolicyExtras = {},
  extraFiles = {},
} = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'talon-ubol-parity-'));
  await writeJson(root, 'manifest.json', {
    manifest_version: 3,
    version: '1.0.0',
    minimum_chrome_version: minimumChromeVersion,
    permissions,
    host_permissions: ['<all_urls>'],
    declarative_net_request: {
      rule_resources: rulesets.map(id => ({
        id,
        enabled: id === 'easylist',
        path: `rulesets/main/${id}.json`,
      })),
    },
    web_accessible_resources: [
      {
        resources: ['rulesets/main/easylist.json'],
        matches: ['<all_urls>'],
      },
    ],
  });
  await writeJson(root, 'rulesets/ruleset-details.json', rulesets.map(id => ({
    id,
    enabled: id === 'easylist',
    filters: { accepted: 10 },
    rules: { total: 2, plain: 2, regex: 0, strictblock: 0, urlskip: 0, rejected: 0 },
    css: { generic: 1, specific: 1 },
    ...detailsOverrides[id],
  })));
  await writeJson(root, 'rulesets/ruleset-license-policy.json', {
    rulesets: licensePolicyRulesets,
    ...licensePolicyExtras,
  });
  for (const id of rulesets) {
    await writeJson(root, `rulesets/main/${id}.json`, [
      { id: 1, action: { type: 'block' }, condition: { urlFilter: `||${id}.invalid^` } },
    ]);
    await writeText(root, `rulesets/scripting/generic/${id}.js`, `self.${id.replace(/-/g, '_')} = true;\n`);
  }
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    if (typeof content === 'string') {
      await writeText(root, relativePath, content);
    } else {
      await writeJson(root, relativePath, content);
    }
  }
  return root;
};

test('parity auditor reports no drift for identical fixtures', async () => {
  const root = await makeFixture();
  const report = await buildParityReport({ extensionDir: root, upstreamDir: root });

  assert.deepEqual(report.driftClasses, []);
  assert.equal(report.automationBlocked, false);
  assert.deepEqual(report.changedFiles, []);
});

test('parity auditor classifies ruleset data drift without runtime or permission drift', async () => {
  const extensionDir = await makeFixture();
  const upstreamDir = await makeFixture({
    detailsOverrides: {
      easylist: {
        filters: { accepted: 12 },
        rules: { total: 3, plain: 3, regex: 0, strictblock: 0, urlskip: 0, rejected: 0 },
      },
    },
    extraFiles: {
      'rulesets/main/easylist.json': [
        { id: 1, action: { type: 'block' }, condition: { urlFilter: '||easylist.invalid^' } },
        { id: 2, action: { type: 'block' }, condition: { urlFilter: '||ads.invalid^' } },
      ],
    },
  });
  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.driftClasses, ['rules-data-only']);
  assert.equal(report.automationBlocked, false);
  assert.equal(report.rulesetCountDeltas.some(delta => delta.path === 'filters.accepted'), true);
});

test('parity auditor blocks permission and browser support drift', async () => {
  const extensionDir = await makeFixture();
  const upstreamDir = await makeFixture({
    permissions: ['activeTab', 'declarativeNetRequest', 'offscreen', 'scripting', 'storage', 'userScripts'],
    minimumChromeVersion: '130.0',
  });
  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.equal(report.driftClasses.includes('manifest-permission'), true);
  assert.equal(report.driftClasses.includes('browser-support'), true);
  assert.equal(report.automationBlocked, true);
});

test('parity auditor honors documented manifest and resource exceptions', async () => {
  const extensionDir = await makeFixture({
    permissions: [
      'alarms',
      'declarativeNetRequest',
      'scripting',
      'storage',
      'webNavigation',
    ],
  });
  const upstreamDir = await makeFixture();
  const ownershipMapPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'talon-ownership-')), 'map.json');
  await fs.writeFile(
    ownershipMapPath,
    `${JSON.stringify({
      version: 1,
      upstreamOwnedPaths: ['rulesets/**'],
      talonOwnedPaths: [],
      rulesetOnlyAllowedPaths: ['rulesets/**'],
      manifestPermissionExceptions: {
        localExtra: {
          alarms: 'fixture Talon-owned alarm permission',
          webNavigation: 'fixture Talon-owned navigation permission',
        },
        upstreamExtra: {},
      },
      webAccessibleResourceExceptions: {
        localExtra: {
          'automation/directives.json': 'fixture Talon-owned automation data',
        },
        upstreamExtra: {
          'zapper-ui.html': 'fixture omitted upstream UI',
        },
      },
    }, null, 2)}\n`,
    'utf8'
  );
  const extensionManifestPath = path.join(extensionDir, 'manifest.json');
  const upstreamManifestPath = path.join(upstreamDir, 'manifest.json');
  const extensionManifest = JSON.parse(await fs.readFile(extensionManifestPath, 'utf8'));
  const upstreamManifest = JSON.parse(await fs.readFile(upstreamManifestPath, 'utf8'));
  extensionManifest.web_accessible_resources[0].resources.push('automation/directives.json');
  upstreamManifest.web_accessible_resources[0].resources.push('zapper-ui.html');
  await fs.writeFile(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(upstreamManifestPath, `${JSON.stringify(upstreamManifest, null, 2)}\n`, 'utf8');

  const report = await buildParityReport({ extensionDir, upstreamDir, ownershipMapPath });

  assert.deepEqual(report.manifestDiffs.permissions.removed, []);
  assert.deepEqual(report.manifestDiffs.resources.added, []);
  assert.deepEqual(report.manifestDiffs.resources.removed, []);
  assert.deepEqual(report.manifestDiffExceptions.permissions.removed, ['alarms', 'webNavigation']);
  assert.deepEqual(report.manifestDiffExceptions.resources.added, ['zapper-ui.html']);
  assert.equal(report.driftClasses.includes('manifest-permission'), false);
  assert.equal(report.driftClasses.includes('store-packaging'), false);
});

test('parity auditor detects recursive compiled scriptlet layout drift', async () => {
  const extensionDir = await makeFixture({
    extraFiles: {
      'rulesets/scripting/scriptlet/easylist.set-constant.js': '// old token bundle\n',
    },
  });
  const upstreamDir = await makeFixture({
    extraFiles: {
      'rulesets/scripting/scriptlet/main/easylist.js': '// main-world bundle\n',
      'rulesets/scripting/scriptlet/isolated/easylist.js': '// isolated-world bundle\n',
    },
  });

  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.equal(report.driftClasses.includes('compiled-layout'), true);
  assert.equal(report.automationBlocked, true);
  assert.equal(report.scriptingLayoutDiff.added.includes('scriptlet/main'), true);
  assert.equal(report.scriptingLayoutDiff.added.includes('scriptlet/isolated'), true);
  assert.equal(report.scriptingLayoutDiff.removed.includes('scriptlet/*.js'), true);
});

test('parity auditor excludes upstream test and experimental rulesets by default', async () => {
  const extensionDir = await makeFixture();
  const upstreamDir = await makeFixture({
    rulesets: ['easylist', 'ubol-tests', 'ublock-experimental'],
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'ubol-tests': { commercialUse: 'allowed' },
      'ublock-experimental': { commercialUse: 'allowed' },
    },
  });
  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.excludedUpstreamRuleIds, ['ublock-experimental', 'ubol-tests']);
  assert.equal(report.rulesetIdDiff.added.includes('ubol-tests'), false);
  assert.equal(report.rulesetIdDiff.added.includes('ublock-experimental'), false);
});

test('parity auditor honors documented local-only ruleset exceptions', async () => {
  const extensionDir = await makeFixture({
    rulesets: ['easylist', 'talon-youtube-allow'],
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'talon-youtube-allow': { commercialUse: 'allowed' },
    },
  });
  const upstreamDir = await makeFixture();
  const ownershipMapPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'talon-ownership-')), 'map.json');
  await fs.writeFile(
    ownershipMapPath,
    `${JSON.stringify({
      version: 1,
      upstreamOwnedPaths: ['rulesets/**'],
      talonOwnedPaths: [],
      rulesetOnlyAllowedPaths: ['rulesets/**'],
      rulesetIdExceptions: {
        localExtra: {
          'talon-youtube-allow': 'fixture Talon-owned YouTube ruleset',
        },
        upstreamExtra: {},
      },
    }, null, 2)}\n`,
    'utf8'
  );

  const report = await buildParityReport({ extensionDir, upstreamDir, ownershipMapPath });

  assert.deepEqual(report.localOnlyRuleIds, ['talon-youtube-allow']);
  assert.deepEqual(report.rulesetIdDiff.added, []);
  assert.deepEqual(report.rulesetIdDiff.removed, []);
  assert.equal(report.hashDeltas.removed.includes('rulesets/main/talon-youtube-allow.json'), false);
  assert.equal(report.driftClasses.includes('rules-data-only'), false);
});

test('parity auditor treats readable scriptlet payloads as equivalent to upstream encoding', async () => {
  const scriptletPath = 'rulesets/scripting/scriptlet/isolated/ublock-filters.js';
  const extensionDir = await makeFixture({
    extraFiles: {
      [scriptletPath]: `const args = ["${readableCaptchaPayload}"];\n`,
    },
  });
  const upstreamDir = await makeFixture({
    extraFiles: {
      [scriptletPath]: `const args = ["${encodedCaptchaPayload}"];\n`,
    },
  });

  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.hashDeltas.changed, []);
  assert.deepEqual(report.driftClasses, []);
});

test('parity auditor treats Talon css-specific fail-closed guard as upstream-equivalent', async () => {
  const cssSpecificPath = 'js/scripting/css-specific.js';
  const extensionDir = await makeFixture({
    extraFiles: {
      [cssSpecificPath]: `${talonCssSpecificProceduralLoader}\n`,
    },
  });
  const upstreamDir = await makeFixture({
    extraFiles: {
      [cssSpecificPath]: `${upstreamCssSpecificProceduralLoader}\n`,
    },
  });

  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.hashDeltas.changed, []);
  assert.deepEqual(report.driftClasses, []);
});

test('parity auditor blocks unapproved upstream rulesets', async () => {
  const extensionDir = await makeFixture();
  const upstreamDir = await makeFixture({
    rulesets: ['easylist', 'new-region'],
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'new-region': { commercialUse: 'allowed' },
    },
  });
  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.licenseBlockedRuleIds, ['new-region']);
  assert.equal(report.driftClasses.includes('license-blocked'), true);
  assert.equal(report.automationBlocked, true);
});

test('parity auditor does not treat invalid license policy entries as approved', async () => {
  const extensionDir = await makeFixture({
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'new-region': { commercialUse: 'non-commercial', proof: 'fixture-license-proof' },
      'unknown-region': { commercialUse: 'unknown' },
    },
  });
  const upstreamDir = await makeFixture({
    rulesets: ['easylist', 'new-region', 'unknown-region'],
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'new-region': { commercialUse: 'allowed' },
      'unknown-region': { commercialUse: 'allowed' },
    },
  });

  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.licenseBlockedRuleIds, ['new-region', 'unknown-region']);
  assert.equal(report.driftClasses.includes('license-blocked'), true);
  assert.equal(report.automationBlocked, true);
});

test('parity auditor honors documented upstream ruleset exclusions', async () => {
  const extensionDir = await makeFixture({
    licensePolicyExtras: {
      excludedUpstreamRulesets: {
        'non-commercial-region': {
          reason: 'non-commercial-license',
          proof: 'fixture-license-proof',
        },
      },
    },
  });
  const upstreamDir = await makeFixture({
    rulesets: ['easylist', 'non-commercial-region'],
    licensePolicyRulesets: {
      easylist: { commercialUse: 'allowed' },
      'non-commercial-region': { commercialUse: 'allowed' },
    },
  });

  const report = await buildParityReport({ extensionDir, upstreamDir });

  assert.deepEqual(report.excludedUpstreamRuleIds, ['non-commercial-region']);
  assert.equal(report.rulesetIdDiff.added.includes('non-commercial-region'), false);
  assert.equal(report.licenseBlockedRuleIds.includes('non-commercial-region'), false);
  assert.equal(report.driftClasses.includes('license-blocked'), false);
});

test('parity auditor reports Talon-owned overwrite attempts', async () => {
  const extensionDir = await makeFixture({
    extraFiles: {
      'js/background.js': 'export const talon = true;\n',
    },
  });
  const upstreamDir = await makeFixture({
    extraFiles: {
      'js/background.js': 'export const upstream = true;\n',
    },
  });
  const ownershipMapPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'talon-ownership-')), 'map.json');
  await fs.writeFile(
    ownershipMapPath,
    `${JSON.stringify({
      version: 1,
      upstreamOwnedPaths: ['rulesets/**', 'js/background.js'],
      talonOwnedPaths: ['js/background.js'],
      rulesetOnlyAllowedPaths: ['rulesets/**'],
    }, null, 2)}\n`,
    'utf8'
  );
  const report = await buildParityReport({ extensionDir, upstreamDir, ownershipMapPath });

  assert.deepEqual(report.ownershipViolations, ['js/background.js']);
  assert.equal(report.automationBlocked, true);
});
