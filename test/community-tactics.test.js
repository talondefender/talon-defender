import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCommunityTacticsToJsonValue,
  COMMUNITY_TACTIC_BASELINE_MAX,
  COMMUNITY_TACTIC_COMPILED_MAX,
  filterCommunityTacticsByHostname,
  normalizeCommunityTacticJsonPath,
  sanitizeCommunityTactics,
} from '../js/community-tactics.js';

test('community tactics sanitizer accepts bounded prune and set tactics with exact-host normalization', () => {
  const tactics = sanitizeCommunityTactics([
    {
      id: 'prune-ads',
      kind: 'jsonPrune',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['contents.[].adPlacements', 'metadata.promotions'],
    },
    {
      id: 'set-flag',
      kind: 'jsonSet',
      hosts: ['=video.example'],
      transport: 'both',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['player.adsEnabled'],
      value: false,
    },
  ]);

  assert.equal(tactics.length, 2);
  assert.deepEqual(tactics[0].hosts, ['=video.example']);
  assert.deepEqual(tactics[0].jsonPaths, ['contents.[].adPlacements', 'metadata.promotions']);
  assert.equal(tactics[1].value, false);
});

test('community tactics sanitizer rejects unsafe hosts, malformed paths, bad values, and caps entry counts', () => {
  const tactics = sanitizeCommunityTactics([
    {
      id: 'protected-host',
      kind: 'jsonPrune',
      hosts: ['accounts.google.com'],
      transport: 'fetch',
      urlPathPrefixes: ['/api'],
      jsonPaths: ['payload.ads'],
    },
    {
      id: 'internal-host',
      kind: 'jsonPrune',
      hosts: ['talondefender.com'],
      transport: 'fetch',
      urlPathPrefixes: ['/api'],
      jsonPaths: ['payload.ads'],
    },
    {
      id: 'bad-prefix',
      kind: 'jsonPrune',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['api/player'],
      jsonPaths: ['payload.ads'],
    },
    {
      id: 'bad-path',
      kind: 'jsonPrune',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.[*].ads'],
    },
    {
      id: 'bad-value',
      kind: 'jsonSet',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.adsEnabled'],
      value: true,
    },
    ...Array.from({ length: COMMUNITY_TACTIC_BASELINE_MAX + 2 }, (_, index) => ({
      id: `ok-${index}`,
      kind: 'jsonPrune',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['payload.ads'],
    })),
  ], {
    maxEntries: COMMUNITY_TACTIC_BASELINE_MAX,
  });

  assert.equal(tactics.length, COMMUNITY_TACTIC_BASELINE_MAX);
  assert.equal(tactics.some(entry => entry.id === 'protected-host'), false);
  assert.equal(tactics.some(entry => entry.id === 'internal-host'), false);
  assert.equal(tactics.some(entry => entry.id === 'bad-prefix'), false);
  assert.equal(tactics.some(entry => entry.id === 'bad-path'), false);
  assert.equal(tactics.some(entry => entry.id === 'bad-value'), false);
  assert.equal(normalizeCommunityTacticJsonPath('payload.[*].ads'), '');
  assert.equal(COMMUNITY_TACTIC_COMPILED_MAX >= COMMUNITY_TACTIC_BASELINE_MAX, true);
});

test('community tactics filtering returns exact-host entries only', () => {
  const filtered = filterCommunityTacticsByHostname([
    {
      id: 'kept',
      kind: 'jsonPrune',
      hosts: ['=video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api'],
      jsonPaths: ['payload.ads'],
    },
    {
      id: 'dropped',
      kind: 'jsonPrune',
      hosts: ['=news.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api'],
      jsonPaths: ['payload.ads'],
    },
  ], 'video.example');

  assert.deepEqual(filtered.map(entry => entry.id), ['kept']);
});

test('community tactics apply prune and set mutations for fetch payloads', () => {
  const tactics = sanitizeCommunityTactics([
    {
      id: 'prune-ads',
      kind: 'jsonPrune',
      hosts: ['video.example'],
      transport: 'fetch',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['contents.[].adPlacements', 'metadata.promotions'],
    },
    {
      id: 'set-flag',
      kind: 'jsonSet',
      hosts: ['video.example'],
      transport: 'both',
      urlPathPrefixes: ['/api/player'],
      jsonPaths: ['player.adsEnabled'],
      value: false,
    },
  ]);
  const input = {
    contents: [
      { adPlacements: [{ id: 1 }], keep: true },
      { adPlacements: [{ id: 2 }], keep: true },
    ],
    metadata: {
      promotions: { inline: true },
    },
    player: {
      adsEnabled: true,
    },
  };

  const result = applyCommunityTacticsToJsonValue(input, tactics, {
    hostname: 'video.example',
    transport: 'fetch',
    pathname: '/api/player/v1',
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.value, {
    contents: [
      { keep: true },
      { keep: true },
    ],
    metadata: {},
    player: {
      adsEnabled: false,
    },
  });
  assert.equal(input.contents[0].adPlacements.length, 1);
});

test('community tactics apply xhr mutations only on matching exact hosts and path prefixes', () => {
  const tactics = sanitizeCommunityTactics([
    {
      id: 'set-empty',
      kind: 'jsonSet',
      hosts: ['video.example'],
      transport: 'xhr',
      urlPathPrefixes: ['/xhr/player'],
      jsonPaths: ['payload.adBreakId'],
      value: '',
    },
  ]);
  const input = {
    payload: {
      adBreakId: 'ad-123',
    },
  };

  const matched = applyCommunityTacticsToJsonValue(input, tactics, {
    hostname: 'video.example',
    transport: 'xhr',
    pathname: '/xhr/player/v2',
  });
  const unmatched = applyCommunityTacticsToJsonValue(input, tactics, {
    hostname: 'news.example',
    transport: 'xhr',
    pathname: '/xhr/player/v2',
  });

  assert.equal(matched.applied, true);
  assert.equal(matched.value.payload.adBreakId, '');
  assert.equal(unmatched.applied, false);
  assert.equal(unmatched.value, input);
});
