import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { sanitizeCommunityRules } from '../js/community-rule-sanitizer.js';
import { sanitizeCommunityTactics } from '../js/community-tactics.js';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('remote data contract sanitizes DNR and tactic payloads before packaged activation', () => {
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
  const tactics = sanitizeCommunityTactics([
    {
      id: 'prune-player-ads',
      kind: 'jsonPrune',
      hosts: ['news.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.ads'],
    },
    {
      id: 'drop-executable-value',
      kind: 'jsonSet',
      hosts: ['news.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.ads'],
      value: 'alert(1)',
    },
    {
      id: 'drop-protected-tactic',
      kind: 'jsonPrune',
      hosts: ['accounts.google.com'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.ads'],
    },
  ], {
    schemaVersion: 5,
  });

  assert.deepEqual(ruleResult.rules.map(rule => rule.action.type), ['allow']);
  assert.equal(ruleResult.dropped.unsafeScope, 2);
  assert.equal(ruleResult.dropped.unsupportedRedirectPath, 1);
  assert.deepEqual(tactics.map(entry => entry.id), ['prune-player-ads']);
  assert.equal(JSON.stringify(tactics).includes('alert(1)'), false);
  assert.equal(JSON.stringify(tactics).includes('accounts.google.com'), false);
});

test('remote extras remain JSON selectors for packaged behavior, not executable source', async () => {
  const source = await readSource('js/community-sync.js');

  assert.match(source, /const sanitizeCommunityPayloadForStorage = \(/);
  assert.match(source, /rules: sanitizedRules\.rules/);
  assert.match(source, /cosmetics: sanitizeCommunityCosmetics\(input\?\.cosmetics/);
  assert.match(source, /heuristics: sanitizeCommunityHeuristics\(input\?\.heuristics/);
  assert.match(source, /publicDirectives: sanitizeCommunityDirectives\(input\?\.directives/);
  assert.match(source, /publicScriptlets: sanitizeCommunityScriptlets\(input\?\.scriptlets/);
  assert.match(source, /publicTactics: sanitizeCommunityTacticsForStorage\(/);
  assert.match(source, /input\?\.tactics \?\? input\?\.publicTactics/);
  assert.match(source, /if \( patternCouldMatchInternalUnfilteredDomain\(normalizedHost\) \) \{ continue; \}/);
  assert.match(source, /if \( patternCouldMatchProtectedDomain\(normalizedHost\) \) \{ continue; \}/);
  assert.match(source, /rulesetId: bucket\.rulesetId/);
  assert.match(source, /token: bucket\.token/);
  assert.match(source, /hosts,/);
  assert.match(source, /world: bucket\.world/);
  assert.doesNotMatch(source, /entry\.code/);
  assert.doesNotMatch(source, /entry\.source/);
  assert.doesNotMatch(source, /entry\.javascript/);
});
