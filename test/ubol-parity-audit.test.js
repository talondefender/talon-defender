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

const makeFixture = async ({
  permissions = ['declarativeNetRequest', 'scripting', 'storage'],
  minimumChromeVersion = '122.0',
  rulesets = ['easylist'],
  detailsOverrides = {},
  licensePolicyRulesets = { easylist: { commercialUse: 'allowed' } },
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
