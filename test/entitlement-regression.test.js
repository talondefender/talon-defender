import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TRIAL_PERIOD_MS,
  TRIAL_REMINDER_INITIAL_DELAY_MS,
  TRIAL_REMINDER_INTERVAL_MS,
  computeEntitlementState,
  getTrialReminderWhen,
  isHardDenyErrorCode,
  normalizeAndValidateLicenseKey,
  shouldEnablePaywallForStatus,
  shouldRecordTrialReminderShown,
} from '../js/entitlement-logic.js';

test('trial transitions to expired when trial window elapses', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const trialStartMs = now - (DEFAULT_TRIAL_PERIOD_MS - 60_000);

  const trialState = computeEntitlementState({ trialStartMs }, { now });
  assert.equal(trialState.status, 'trial');

  const expiredNow = trialStartMs + DEFAULT_TRIAL_PERIOD_MS + 1;
  const expiredState = computeEntitlementState({ trialStartMs }, { now: expiredNow });
  assert.equal(expiredState.status, 'expired');
});

test('paid entitlement becomes expired on hard deny codes (MAX_DEVICES, REVOKED)', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const baseStored = {
    trialStartMs: now - (DEFAULT_TRIAL_PERIOD_MS * 2),
    entitledUntilMs: now + (24 * 60 * 60 * 1000),
    graceUntilMs: now + (24 * 60 * 60 * 1000),
  };

  const paidState = computeEntitlementState({
    ...baseStored,
    lastErrorCode: '',
  }, { now });
  assert.equal(paidState.status, 'paid');

  const maxDevicesState = computeEntitlementState({
    ...baseStored,
    lastErrorCode: 'MAX_DEVICES',
  }, { now });
  assert.equal(maxDevicesState.status, 'expired');

  const revokedState = computeEntitlementState({
    ...baseStored,
    lastErrorCode: 'REVOKED',
  }, { now });
  assert.equal(revokedState.status, 'expired');
});

test('hard deny code classifier includes MAX_DEVICES and REVOKED', () => {
  assert.equal(isHardDenyErrorCode('MAX_DEVICES'), true);
  assert.equal(isHardDenyErrorCode('REVOKED'), true);
  assert.equal(isHardDenyErrorCode(' max_devices '), true);
  assert.equal(isHardDenyErrorCode('revoked'), true);
  assert.equal(isHardDenyErrorCode('TEMP_UNAVAILABLE'), false);
});

test('trial-expired reminder timing uses 2-minute initial delay and 7-day cooldown', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);

  const firstWhen = getTrialReminderWhen({
    status: { status: 'expired' },
    now,
    lastShownMs: 0,
  });
  assert.equal(firstWhen, now + TRIAL_REMINDER_INITIAL_DELAY_MS);

  const shownAt = now - (60 * 60 * 1000); // one hour ago
  const cooldownWhen = getTrialReminderWhen({
    status: { status: 'expired' },
    now,
    lastShownMs: shownAt,
  });
  assert.equal(cooldownWhen, shownAt + TRIAL_REMINDER_INTERVAL_MS);

  const nonExpired = getTrialReminderWhen({
    status: { status: 'trial' },
    now,
    lastShownMs: 0,
  });
  assert.equal(nonExpired, null);
});

test('trial-expired reminder recovers from stale/invalid lastShown values', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);

  const whenWithBadValue = getTrialReminderWhen({
    status: { status: 'expired' },
    now,
    lastShownMs: 'not-a-number',
  });
  assert.equal(whenWithBadValue, now + TRIAL_REMINDER_INITIAL_DELAY_MS);

  const shownInFuture = now + (60 * 60 * 1000);
  const whenWithFutureShown = getTrialReminderWhen({
    status: { status: 'expired' },
    now,
    lastShownMs: shownInFuture,
  });
  assert.equal(whenWithFutureShown, shownInFuture + TRIAL_REMINDER_INTERVAL_MS);
});

test('trial-expired reminder "shown" marker is recorded only when tab open succeeds', () => {
  assert.equal(shouldRecordTrialReminderShown(true), true);
  assert.equal(shouldRecordTrialReminderShown(false), false);
  assert.equal(shouldRecordTrialReminderShown(undefined), false);
});

test('setLicenseKey validation trims valid keys and rejects invalid payloads', () => {
  const ok = normalizeAndValidateLicenseKey('  TD-ABCD-EFGH-IJKL-MNOP  ', { maxLength: 512 });
  assert.equal(ok.ok, true);
  assert.equal(ok.key, 'TD-ABCD-EFGH-IJKL-MNOP');

  const empty = normalizeAndValidateLicenseKey('   ', { maxLength: 512 });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'invalid_license_key');

  const tooLong = normalizeAndValidateLicenseKey('x'.repeat(513), { maxLength: 512 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.error, 'invalid_license_key');

  const boundary = normalizeAndValidateLicenseKey('x'.repeat(512), { maxLength: 512 });
  assert.equal(boundary.ok, true);
  assert.equal(boundary.key.length, 512);
});

test('paywall toggles only for expired status', () => {
  assert.equal(shouldEnablePaywallForStatus({ status: 'trial' }), false);
  assert.equal(shouldEnablePaywallForStatus({ status: 'paid' }), false);
  assert.equal(shouldEnablePaywallForStatus({ status: 'expired' }), true);
  assert.equal(shouldEnablePaywallForStatus(null), false);
});

test('grace period keeps paid status active even after entitledUntilMs', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const state = computeEntitlementState({
    trialStartMs: now - (DEFAULT_TRIAL_PERIOD_MS * 2),
    entitledUntilMs: now - (60 * 1000),
    graceUntilMs: now + (60 * 60 * 1000),
    lastErrorCode: '',
  }, { now });
  assert.equal(state.status, 'paid');
});

test('fresh install without trial start or license is expired by default', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const state = computeEntitlementState({}, { now });
  assert.equal(state.status, 'expired');
  assert.equal(state.licenseKeyPresent, false);
});
