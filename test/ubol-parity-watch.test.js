import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareStableTags,
  latestStableChromiumTagFromLsRemote,
  parseStableChromiumTag,
} from '../scripts/ubol-parity-watch.mjs';

test('stable tag parser accepts Chromium release tags and rejects beta or Safari tags', () => {
  assert.deepEqual(parseStableChromiumTag('refs/tags/2026.529.1448'), {
    tag: '2026.529.1448',
    year: 2026,
    dateCode: 529,
    timeCode: 1448,
  });
  assert.equal(parseStableChromiumTag('refs/tags/2026.408.1806-beta'), null);
  assert.equal(parseStableChromiumTag('refs/tags/2025.804.1931-safari'), null);
  assert.equal(parseStableChromiumTag('refs/tags/not-a-release'), null);
});

test('stable tag comparator orders by date and time code', () => {
  const older = parseStableChromiumTag('2026.516.1652');
  const newer = parseStableChromiumTag('2026.529.1448');
  assert.equal(compareStableTags(newer, older) > 0, true);
  assert.equal(compareStableTags(older, newer) < 0, true);
});

test('latest tag discovery ignores beta, Safari, and non-release refs', () => {
  const latest = latestStableChromiumTagFromLsRemote([
    '1111111111111111111111111111111111111111\trefs/tags/2026.516.1652',
    '2222222222222222222222222222222222222222\trefs/tags/2026.529.1448',
    '3333333333333333333333333333333333333333\trefs/tags/2026.601.1111-beta',
    '4444444444444444444444444444444444444444\trefs/tags/2026.602.1111-safari',
    '5555555555555555555555555555555555555555\trefs/tags/other',
  ].join('\n'));

  assert.equal(latest.tag, '2026.529.1448');
  assert.equal(latest.commit, '2222222222222222222222222222222222222222');
});
