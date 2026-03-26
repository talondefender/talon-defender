import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMUNITY_EMERGENCY_SYNC_ATTEMPT_DEBOUNCE_MS,
  COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS,
  getCommunityEmergencySyncDiagnostics,
  recordCommunityEmergencySyncAttempt,
  recordCommunityEmergencySyncSuccess,
  shouldTriggerCommunityEmergencySync,
} from '../js/community-emergency-sync.js';

test('community emergency sync separates attempt debounce from success cooldown and records diagnostics', () => {
  let state = {};
  const firstGate = shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 1000,
  });
  assert.equal(firstGate.allowed, true);

  state = recordCommunityEmergencySyncAttempt({
    state,
    domain: 'example.com',
    reason: 'severe-signal:page-shell-hidden',
    now: 1000,
  });

  const debounceGate = shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 1000 + COMMUNITY_EMERGENCY_SYNC_ATTEMPT_DEBOUNCE_MS - 1,
  });
  assert.equal(debounceGate.allowed, false);
  assert.equal(debounceGate.reason, 'attempt-debounce');

  const postDebounceGate = shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 1000 + COMMUNITY_EMERGENCY_SYNC_ATTEMPT_DEBOUNCE_MS,
  });
  assert.equal(postDebounceGate.allowed, true);

  state = recordCommunityEmergencySyncSuccess({
    state,
    domain: 'example.com',
    reason: 'severe-signal:page-shell-hidden',
    now: 2000,
  });

  const cooldownGate = shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 2000 + COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS - 1,
  });
  assert.equal(cooldownGate.allowed, false);
  assert.equal(cooldownGate.reason, 'cooldown');

  const reopenedGate = shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 2000 + COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS,
  });
  assert.equal(reopenedGate.allowed, true);

  const diagnostics = getCommunityEmergencySyncDiagnostics(state, { now: 2000 });
  assert.equal(diagnostics.lastAttemptAt, 1000);
  assert.equal(diagnostics.lastSuccessAt, 2000);
  assert.equal(diagnostics.lastSyncAt, 2000);
  assert.equal(diagnostics.lastDomain, 'example.com');
  assert.equal(diagnostics.lastReason, 'severe-signal:page-shell-hidden');
  assert.equal(diagnostics.rollingCount, 1);
});

test('community emergency sync blocks invalid lane states and keeps rolling counts', () => {
  let state = {};
  state = recordCommunityEmergencySyncAttempt({
    state,
    domain: 'example.com',
    reason: 'signal-threshold:scroll-lock-persisted',
    now: 1000,
  });
  state = recordCommunityEmergencySyncAttempt({
    state,
    domain: 'shop.example.net',
    reason: 'blocked-navigation-threshold',
    now: 2000,
  });

  assert.equal(shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: false,
    communityRulesEnabled: true,
    communityUrlValid: true,
    now: 4000,
  }).reason, 'not-entitled');
  assert.equal(shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: false,
    communityUrlValid: true,
    now: 4000,
  }).reason, 'disabled');
  assert.equal(shouldTriggerCommunityEmergencySync({
    state,
    domain: 'example.com',
    entitled: true,
    communityRulesEnabled: true,
    communityUrlValid: false,
    now: 4000,
  }).reason, 'invalid-url');

  const diagnostics = getCommunityEmergencySyncDiagnostics(state, { now: 4000 });
  assert.equal(diagnostics.lastDomain, 'shop.example.net');
  assert.equal(diagnostics.lastReason, 'blocked-navigation-threshold');
  assert.equal(diagnostics.rollingCount, 2);
});

test('background wires emergency sync triggers into breakage and blocked-navigation recovery', async () => {
  const source = await readFile(resolve('js/background.js'), 'utf8');

  assert.equal(source.includes('triggerEmergencyCommunitySync('), true);
  assert.equal(source.includes('recordCommunityEmergencySyncAttempt('), true);
  assert.equal(source.includes('recordCommunityEmergencySyncSuccess('), true);
  assert.equal(source.includes("'blocked-navigation-threshold'"), true);
  assert.equal(source.includes('severe-signal:${normalizedSignal}'), true);
  assert.equal(source.includes('signal-threshold:${normalizedSignal}'), true);
});
