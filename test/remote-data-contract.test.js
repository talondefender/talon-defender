import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { sanitizeCommunityRules } from '../js/community-rule-sanitizer.js';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('remote data contract sanitizes DNR payloads before packaged activation', () => {
  const ruleResult = sanitizeCommunityRules([
    {
      action: { type: 'allow' },
      condition: {
        initiatorDomains: ['news.example'],
        requestDomains: ['cdn.news.example'],
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'block' },
      condition: {
        requestDomains: ['talondefender.com'],
        resourceTypes: ['script'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: { url: 'https://example.com/remote.js' },
      },
      condition: {
        initiatorDomains: ['news.example'],
        requestDomains: ['cdn.news.example'],
        resourceTypes: ['script'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: { extensionPath: 'web_accessible_resources/noop.js' },
      },
      condition: {
        initiatorDomains: ['checkout.shopify.com'],
        requestDomains: ['checkout.shopify.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlPathPrefix: '/assets/',
      },
    },
  ], {
    schemaVersion: 5,
  });

  assert.deepEqual(ruleResult.rules.map(rule => rule.action.type), ['allow']);
  assert.equal(ruleResult.dropped.unsafeScope, 2);
  assert.equal(ruleResult.dropped.unsupportedRedirectPath, 1);
});

test('remote extras remain JSON selectors for packaged behavior and public sync ignores tactics', async () => {
  const source = await readSource('js/community-sync.js');
  const packageSource = await readSource('scripts/package-extension.mjs');
  const sourceRelease = await readSource('scripts/package-public-source.ps1');

  assert.match(source, /const sanitizeCommunityPayloadForStorage = \(/);
  assert.match(source, /rules: sanitizedRules\.rules/);
  assert.match(source, /cosmetics: sanitizeCommunityCosmetics\(input\?\.cosmetics/);
  assert.match(source, /heuristics: sanitizeCommunityHeuristics\(input\?\.heuristics/);
  assert.match(source, /publicDirectives: sanitizeCommunityDirectives\(input\?\.directives/);
  assert.match(source, /publicScriptlets: sanitizeCommunityScriptlets\(input\?\.scriptlets/);
  assert.doesNotMatch(source, /publicTactics: sanitizeCommunityTacticsForStorage\(/);
  assert.doesNotMatch(source, /input\?\.tactics \?\? input\?\.publicTactics/);
  assert.doesNotMatch(source, /communityBundlePublicTactics/);
  assert.match(source, /if \( patternCouldMatchInternalUnfilteredDomain\(normalizedHost\) \) \{ continue; \}/);
  assert.match(source, /if \( patternCouldMatchProtectedDomain\(normalizedHost\) \) \{ continue; \}/);
  assert.match(source, /rulesetId: bucket\.rulesetId/);
  assert.match(source, /token: bucket\.token/);
  assert.match(source, /hosts,/);
  assert.match(source, /world: bucket\.world/);
  assert.doesNotMatch(source, /entry\.code/);
  assert.doesNotMatch(source, /entry\.source/);
  assert.doesNotMatch(source, /entry\.javascript/);
  assert.match(packageSource, /const EXCLUDE = \[/);
  assert.doesNotMatch(packageSource, /remote-tactics-bootstrap\.js/);
  assert.match(sourceRelease, /Public source archive must not include non-shipped tactic source/);
});
