import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMUNITY_HEURISTIC_LABEL_REGEX_MAX,
  COMMUNITY_SYNC_DEFAULT_TTL_HOURS,
  COMMUNITY_SYNC_FAILURE_RETRY_MS,
  countCommunityCosmeticSelectors,
  countCommunityHeuristicLabelRegexes,
  computeCommunitySyncState,
  hasCommunityInjectableStateChanged,
  normalizeCommunityHeuristicLabelRegexes,
} from '../js/community-sync-logic.js';

test('community sync respects success TTL until it expires', () => {
  const now = Date.UTC(2026, 2, 25, 18, 0, 0, 0);
  const lastSuccess = now - (2 * 60 * 60 * 1000);
  const state = computeCommunitySyncState({
    now,
    lastSuccess,
    ttlHours: COMMUNITY_SYNC_DEFAULT_TTL_HOURS,
  });

  assert.equal(state.due, false);
  assert.equal(state.reason, 'ttl');
  assert.equal(state.periodMs, COMMUNITY_SYNC_DEFAULT_TTL_HOURS * 60 * 60 * 1000);
});

test('community sync failures retry after 15 minutes without consuming success TTL', () => {
  const now = Date.UTC(2026, 2, 25, 18, 0, 0, 0);
  const lastSuccess = now - (30 * 60 * 1000);
  const lastAttempt = now - (5 * 60 * 1000);

  const backoffState = computeCommunitySyncState({
    now,
    lastAttempt,
    lastSuccess,
    lastError: 'signature invalid',
  });
  assert.equal(backoffState.due, false);
  assert.equal(backoffState.reason, 'retry-backoff');
  assert.equal(backoffState.nextDelayMs, COMMUNITY_SYNC_FAILURE_RETRY_MS - (5 * 60 * 1000));

  const retryState = computeCommunitySyncState({
    now: lastAttempt + COMMUNITY_SYNC_FAILURE_RETRY_MS,
    lastAttempt,
    lastSuccess,
    lastError: 'signature invalid',
  });
  assert.equal(retryState.due, true);
  assert.equal(retryState.reason, 'retry');
});

test('community sync treats first-time failures as retry-backed attempts', () => {
  const now = Date.UTC(2026, 2, 25, 18, 0, 0, 0);
  const lastAttempt = now - (COMMUNITY_SYNC_FAILURE_RETRY_MS + 1);
  const state = computeCommunitySyncState({
    now,
    lastAttempt,
    lastError: 'http 503',
  });

  assert.equal(state.due, true);
  assert.equal(state.reason, 'retry');
});

test('heuristic label regex sanitization keeps only valid bounded patterns', () => {
  const regexes = normalizeCommunityHeuristicLabelRegexes([
    '  sponsored\\s+content  ',
    '(',
    '',
    'sponsored\\s+content',
    'x'.repeat(300),
  ]);

  assert.deepEqual(regexes, ['sponsored\\s+content']);
});

test('heuristic label regex sanitization enforces the maximum count', () => {
  const input = Array.from({ length: COMMUNITY_HEURISTIC_LABEL_REGEX_MAX + 5 }, (_, index) =>
    `promo-${index}`
  );
  const regexes = normalizeCommunityHeuristicLabelRegexes(input);

  assert.equal(regexes.length, COMMUNITY_HEURISTIC_LABEL_REGEX_MAX);
  assert.equal(regexes.at(-1), `promo-${COMMUNITY_HEURISTIC_LABEL_REGEX_MAX - 1}`);
});

test('community cosmetic counts include host-scoped selectors', () => {
  const count = countCommunityCosmeticSelectors({
    all: ['.global-banner'],
    hosts: {
      'example.com': ['.ad-slot', '.sponsored-card'],
      'news.example': ['.inline-promo'],
    },
  });

  assert.equal(count, 4);
});

test('community heuristic regex counts reflect stored label regexes', () => {
  const count = countCommunityHeuristicLabelRegexes({
    labelRegexes: ['sponsored', 'promoted'],
    minScore: 4,
  });

  assert.equal(count, 2);
});

test('injectable state comparison treats empty and null states as equivalent', () => {
  assert.equal(
    hasCommunityInjectableStateChanged(
      {
        cosmetics: { all: [], hosts: {} },
        heuristics: {},
        directives: [],
        scriptlets: [],
      },
      null
    ),
    false
  );
});

test('injectable state comparison detects remote proof-state cleanup', () => {
  assert.equal(
    hasCommunityInjectableStateChanged(
      {
        cosmetics: null,
        heuristics: null,
        directives: [{ id: 'consent' }],
        scriptlets: [{ rulesetId: 'ublock-filters', token: 'set-constant' }],
      },
      {
        cosmetics: null,
        heuristics: null,
        directives: null,
        scriptlets: null,
      }
    ),
    true
  );
});

test('injectable state comparison preserves heuristic selector tuning', () => {
  assert.equal(
    hasCommunityInjectableStateChanged(
      {
        cosmetics: null,
        heuristics: {
          labelSelectors: ['.sponsored-label'],
          widgetSelectors: ['ins.adsbygoogle'],
        },
        directives: null,
        scriptlets: null,
      },
      {
        cosmetics: null,
        heuristics: {
          widgetSelectors: ['ins.adsbygoogle'],
          labelSelectors: ['.sponsored-label'],
        },
        directives: null,
        scriptlets: null,
      }
    ),
    false
  );

  assert.equal(
    hasCommunityInjectableStateChanged(
      {
        cosmetics: null,
        heuristics: {
          labelSelectors: ['.sponsored-label'],
          widgetSelectors: ['ins.adsbygoogle'],
        },
        directives: null,
        scriptlets: null,
      },
      {
        cosmetics: null,
        heuristics: {
          labelSelectors: ['.sponsored-label'],
          widgetSelectors: ['.taboola-widget'],
        },
        directives: null,
        scriptlets: null,
      }
    ),
    true
  );
});
