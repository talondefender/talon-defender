import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMUNITY_HEURISTIC_LABEL_REGEX_MAX,
  COMMUNITY_SYNC_MAX_TTL_HOURS,
  COMMUNITY_SYNC_DEFAULT_TTL_HOURS,
  COMMUNITY_SYNC_FAILURE_RETRY_MS,
  COMMUNITY_SYNC_MIN_TTL_HOURS,
  countCommunityCosmeticSelectors,
  countCommunityHeuristicLabelRegexes,
  computeCommunitySyncState,
  hasCommunityInjectableStateChanged,
  normalizeCommunityHeuristicLabelRegexes,
  normalizeCommunitySyncTtlHours,
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

test('community sync clamps bundle TTLs into the public hotfix window', () => {
  assert.equal(normalizeCommunitySyncTtlHours(undefined), COMMUNITY_SYNC_DEFAULT_TTL_HOURS);
  assert.equal(normalizeCommunitySyncTtlHours(0.5), COMMUNITY_SYNC_MIN_TTL_HOURS);
  assert.equal(normalizeCommunitySyncTtlHours(48), COMMUNITY_SYNC_MAX_TTL_HOURS);
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


test('community transport keeps its deadline through streamed JSON and releases a stalled body', async () => {
  const { fetchCommunityResponse } = await import('../js/community-fetch.js');
  let cancelled = false;
  let signal;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"rules":')); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchCommunityResponse('https://example.com/bundle', {}, {
    timeoutMs: 25,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Response(body); },
  }), error => error.code === 'community_fetch_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('community transport enforces elapsed time even while buffered reads starve timers', async () => {
  const { fetchCommunityResponse } = await import('../js/community-fetch.js');
  let cancelled = false;
  await assert.rejects(fetchCommunityResponse('https://example.com/bundle', {}, {
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true, status: 200,
      body: { getReader: () => ({
        async read() {
          const until = Date.now() + 15;
          while (Date.now() < until) { /* Simulate a busy buffered stream. */ }
          return { value: Uint8Array.of(32), done: false };
        },
        async cancel() { cancelled = true; },
        releaseLock() {},
      }) },
    }),
  }), error => error.code === 'community_fetch_timeout');
  assert.equal(cancelled, true);
});

test('community transport preserves chunked Unicode JSON and status-only overlay responses', async () => {
  const { fetchCommunityResponse } = await import('../js/community-fetch.js');
  const bytes = new TextEncoder().encode(JSON.stringify({ rules: [], version: '\u00e9\u96ea\ud83d\udee1' }));
  const response = await fetchCommunityResponse('https://example.com/bundle', {}, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    })),
  });
  assert.deepEqual(await response.json(), { rules: [], version: '\u00e9\u96ea\ud83d\udee1' });
  for (const status of [204, 404, 410, 503]) {
    const result = await fetchCommunityResponse('https://example.com/bundle', {}, {
      fetchImpl: async () => new Response(null, { status }),
    });
    assert.equal(result.status, status);
  }
  await assert.rejects(fetchCommunityResponse('https://example.com/bundle', {}, {
    fetchImpl: async () => new Response('{incomplete'),
  }), SyntaxError);
});

test('community transport accepts exactly the decoded byte limit and cancels a chunk beyond it', async () => {
  const { fetchCommunityResponse, COMMUNITY_MAX_RESPONSE_BYTES } = await import('../js/community-fetch.js');
  const exact = JSON.stringify('x'.repeat(COMMUNITY_MAX_RESPONSE_BYTES - 2));
  const response = await fetchCommunityResponse('https://example.com/bundle', {}, {
    fetchImpl: async () => new Response(exact),
  });
  assert.equal((await response.json()).length, COMMUNITY_MAX_RESPONSE_BYTES - 2);
  let cancelled = false;
  let reads = 0;
  await assert.rejects(fetchCommunityResponse('https://example.com/bundle', {}, {
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    })),
  }), error => error.code === 'community_response_too_large');
  assert.equal(cancelled, true);
  assert.ok(reads <= 6, `read too many chunks: ${reads}`);
  await assert.rejects(fetchCommunityResponse('https://example.com/bundle', {}, {
    fetchImpl: async () => new Response(exact + ' '),
  }), error => error.code === 'community_response_too_large');
});

test('community transport counts decoded bytes of compressed HTTP responses', async () => {
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const { fetchCommunityResponse } = await import('../js/community-fetch.js');
  const body = gzipSync(JSON.stringify('x'.repeat(2048)));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': body.length });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchCommunityResponse('http:' + `//127.0.0.1:${server.address().port}/bundle`, {}, {
      maxBytes: 1024,
    }), error => error.code === 'community_response_too_large');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
