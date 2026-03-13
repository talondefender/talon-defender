import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_BACKOFF_SIGNAL_MIN_COUNT,
  mergeBreakageEvidenceEntry,
  normalizeHttpHostname,
  sanitizeBreakageDetails,
  shouldTriggerSignalBackoff,
  updateSignalCounter,
} from '../js/auto-backoff.js';

test('normalizeHttpHostname accepts only http and https URLs', () => {
  assert.equal(normalizeHttpHostname('https://example.com/path'), 'example.com');
  assert.equal(normalizeHttpHostname('http://example.com/path'), 'example.com');
  assert.equal(normalizeHttpHostname('chrome://extensions'), '');
  assert.equal(normalizeHttpHostname('not a url'), '');
});

test('breakage evidence stores counts and recent entries', () => {
  const first = mergeBreakageEvidenceEntry(undefined, {
    signal: 'primary-content-hidden',
    details: { reason: 'test', beforeHeight: 100, afterHeight: 0 },
  }, 1000);

  assert.equal(first.counts['primary-content-hidden'], 1);
  assert.equal(first.recent.length, 1);
  assert.equal(first.recent[0].details.reason, 'test');

  const second = mergeBreakageEvidenceEntry(first, {
    signal: 'scroll-lock-persisted',
    details: { source: 'audit' },
  }, 2000);
  assert.equal(second.counts['scroll-lock-persisted'], 1);
  assert.equal(second.recent.length, 2);
});

test('signal counters trigger immediate backoff for severe signals and threshold for repeated mild ones', () => {
  assert.equal(shouldTriggerSignalBackoff('primary-content-hidden', { count: 1 }), true);

  const counters = new Map();
  const first = updateSignalCounter(counters, 'example.com', 'scroll-lock-persisted', 1000);
  assert.equal(shouldTriggerSignalBackoff('scroll-lock-persisted', first), false);

  const second = updateSignalCounter(counters, 'example.com', 'scroll-lock-persisted', 1500);
  assert.equal(second.count, AUTO_BACKOFF_SIGNAL_MIN_COUNT);
  assert.equal(shouldTriggerSignalBackoff('scroll-lock-persisted', second), true);
});

test('sanitizeBreakageDetails keeps only bounded scalar fields', () => {
  const sanitized = sanitizeBreakageDetails({
    category: 'news/article',
    reason: 'shell-target',
    selector: '#root',
    source: 'native-heuristics',
    beforeHeight: 1200,
    afterHeight: 10,
    nested: { nope: true },
  });

  assert.deepEqual(sanitized, {
    category: 'news/article',
    reason: 'shell-target',
    selector: '#root',
    source: 'native-heuristics',
    beforeHeight: 1200,
    afterHeight: 10,
  });
});
