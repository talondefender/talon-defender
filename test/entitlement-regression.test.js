import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  DEFAULT_TRIAL_PERIOD_MS,
  TRIAL_REMINDER_INITIAL_DELAY_MS,
  TRIAL_REMINDER_INTERVAL_MS,
  buildActivationTokenSyncPatch,
  computeEntitlementState,
  getTrialReminderWhen,
  isHardDenyErrorCode,
  normalizeAndValidateLicenseKey,
  sanitizeEntitlementSyncState,
  shouldForceCommunitySyncAfterEntitlementRefresh,
  shouldEnablePaywallForStatus,
  shouldRecordTrialReminderShown,
} from '../js/entitlement-logic.js';

const readText = async relativePath => {
  const absUrl = new URL(relativePath, import.meta.url);
  return fs.readFile(absUrl, 'utf8');
};

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

test('entitlement sync state strips raw license keys and keeps valid activation tokens only', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      trialStartMs: now - 1000,
      licenseKey: 'TD-RAW-SHOULD-NOT-SYNC',
      licenseKeyUpdatedMs: now,
      activationToken: ' activation-token ',
      activationTokenExpiresAtMs: now + 60_000,
      activationTokenUpdatedMs: now,
      deviceId: 'device-1',
      deviceLabel: 'Desktop',
    }, { now }),
    {
      trialStartMs: now - 1000,
      activationToken: 'activation-token',
      activationTokenExpiresAtMs: now + 60_000,
      activationTokenUpdatedMs: now,
      deviceId: 'device-1',
      deviceLabel: 'Desktop',
    }
  );

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      licenseKey: 'TD-RAW-SHOULD-NOT-SYNC',
      activationToken: 'expired-token',
      activationTokenExpiresAtMs: now - 1,
    }, { now }),
    {}
  );
});

test('verify responses can produce sync-safe activation token patches', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);

  assert.deepEqual(
    buildActivationTokenSyncPatch({
      activationToken: 'token-1',
      activationTokenExpiresAtMs: now + 3600_000,
      deviceId: 'device-1',
      deviceLabel: 'Laptop',
    }, { now }),
    {
      activationToken: 'token-1',
      activationTokenExpiresAtMs: now + 3600_000,
      activationTokenUpdatedMs: now,
      deviceId: 'device-1',
      deviceLabel: 'Laptop',
    }
  );

  assert.deepEqual(
    buildActivationTokenSyncPatch({
      activationToken: 'token-1',
      activationTokenExpiresAtMs: now - 1,
    }, { now }),
    {}
  );
});

test('paywall toggles only for expired status', () => {
  assert.equal(shouldEnablePaywallForStatus({ status: 'trial' }), false);
  assert.equal(shouldEnablePaywallForStatus({ status: 'paid' }), false);
  assert.equal(shouldEnablePaywallForStatus({ status: 'expired' }), true);
  assert.equal(shouldEnablePaywallForStatus(null), false);
});

test('forced community sync only triggers on expired-to-entitled transitions', () => {
  assert.equal(shouldForceCommunitySyncAfterEntitlementRefresh({
    status: { status: 'paid' },
    wasPaywalled: true,
    wasStatusExpired: true,
  }), true);
  assert.equal(shouldForceCommunitySyncAfterEntitlementRefresh({
    status: { status: 'trial' },
    wasPaywalled: false,
    wasStatusExpired: true,
  }), true);
  assert.equal(shouldForceCommunitySyncAfterEntitlementRefresh({
    status: { status: 'paid' },
    wasPaywalled: false,
    wasStatusExpired: false,
  }), false);
  assert.equal(shouldForceCommunitySyncAfterEntitlementRefresh({
    status: { status: 'expired' },
    wasPaywalled: true,
    wasStatusExpired: true,
  }), false);
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

test('ruleset and parity updates do not reset paid, trial, expired, or unlicensed state', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const unrelatedUpdateMetadata = {
    rulesetConfigVersion: '2026.529.1448',
    upstreamBaseline: 'uBOLite_2026.529.1448',
    enabledRulesets: ['default', 'ublock-filters'],
  };
  const trialStartMs = now - (2 * 24 * 60 * 60 * 1000);
  const trialEndMs = now + (5 * 24 * 60 * 60 * 1000);

  const paidState = computeEntitlementState({
    ...unrelatedUpdateMetadata,
    trialStartMs: now - (DEFAULT_TRIAL_PERIOD_MS * 2),
    licenseKey: 'TD-PAID-KEY',
    entitledUntilMs: now + (30 * 24 * 60 * 60 * 1000),
    graceUntilMs: now + (33 * 24 * 60 * 60 * 1000),
  }, { now });
  assert.equal(paidState.status, 'paid');
  assert.equal(paidState.licenseKeyPresent, true);

  const trialState = computeEntitlementState({
    ...unrelatedUpdateMetadata,
    trialStartMs,
    trialEndMs,
  }, { now });
  assert.equal(trialState.status, 'trial');
  assert.equal(trialState.trialStartMs, trialStartMs);
  assert.equal(trialState.trialEndMs, trialEndMs);

  const expiredTrialState = computeEntitlementState({
    ...unrelatedUpdateMetadata,
    trialStartMs: now - (DEFAULT_TRIAL_PERIOD_MS * 2),
    trialEndMs: now - 1,
  }, { now });
  assert.equal(expiredTrialState.status, 'expired');
  assert.equal(expiredTrialState.trialEndMs, now - 1);

  const unlicensedState = computeEntitlementState({
    ...unrelatedUpdateMetadata,
  }, { now });
  assert.equal(unlicensedState.status, 'expired');
  assert.equal(unlicensedState.licenseKeyPresent, false);
});

test('sync-safe entitlement state preserves existing trial window during update migrations', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const trialStartMs = now - (2 * 24 * 60 * 60 * 1000);
  const trialEndMs = now + (5 * 24 * 60 * 60 * 1000);

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      trialStartMs,
      trialEndMs,
      rulesetConfigVersion: '2026.529.1448',
      upstreamBaseline: 'uBOLite_2026.529.1448',
    }, { now }),
    {
      trialStartMs,
      trialEndMs,
    }
  );
});

test('background entitlement handlers keep runtime-only refresh and replace-device activation wired correctly', async () => {
  const source = await readText('../js/background.js');

  assert.match(source, /if \( runtimeOnly !== true \)/);
  assert.match(source, /shouldForceCommunitySyncAfterEntitlementRefresh/);
  assert.match(source, /function queueEntitlementOpenTabRefresh\(\)/);
  assert.match(
    source,
    /case 'replaceDevice':[\s\S]*?refreshEntitlement\(\{ verify: false \}\)[\s\S]*?refreshOpenTabsOnEntitled: false,[\s\S]*?queueEntitlementOpenTabRefresh\(\)/
  );
  assert.match(
    source,
    /case 'setLicenseKey':[\s\S]*?refreshEntitlement\(\{ verify: true, forceVerify: true \}\)[\s\S]*?refreshOpenTabsOnEntitled: false,[\s\S]*?queueEntitlementOpenTabRefresh\(\)/
  );
  assert.match(source, /callback\(await formatEntitlementStatusResponse\(status\)\);/);
  assert.match(source, /case 'getInjectableSyncDiagnostics'/);
});

test('license storage keeps raw keys local and clears sync-safe activation tokens', async () => {
  const entitlementSource = await readText('../js/entitlement.js');
  const optionsSource = await readText('../options/options.js');

  assert.match(entitlementSource, /export const ENTITLEMENT_STORAGE_KEY = 'talonEntitlement';/);
  assert.match(entitlementSource, /export const ENTITLEMENT_SYNC_STORAGE_KEY = 'talonEntitlementSync';/);
  assert.match(entitlementSource, /export async function clearLicenseKey\(\) \{/);
  assert.match(
    entitlementSource,
    /const next = await writeEntitlement\(\{[\s\S]*licenseKey: '',[\s\S]*licenseKeyUpdatedMs: now,[\s\S]*lastVerifiedMs: 0,[\s\S]*licensePlan: '',[\s\S]*activationToken: '',[\s\S]*activationTokenExpiresAtMs: 0,[\s\S]*\}\);/
  );
  assert.match(
    entitlementSource,
    /writeEntitlementSync\(\{[\s\S]*activationToken: '',[\s\S]*activationTokenExpiresAtMs: 0,[\s\S]*activationTokenUpdatedMs: now,[\s\S]*\}\)\.catch\(\(\) => \{ \}\);/
  );
  assert.doesNotMatch(entitlementSource, /writeEntitlementSync\(\{[\s\S]*licenseKey:/);
  assert.match(entitlementSource, /sanitizeEntitlementSyncState/);
  assert.match(optionsSource, /let licenseKeyRevealed = false;/);
  assert.match(optionsSource, /licenseKeyLockedEl\.value = licenseKeyRevealed\s*\? storedLicenseKey\s*: maskLicenseKey\(storedLicenseKey\);/);
  assert.match(optionsSource, /licenseRevealButton\.addEventListener\("click", \(\) => \{[\s\S]*licenseKeyRevealed = !licenseKeyRevealed;[\s\S]*updateLockedKeyDisplay\(\);/);
});

test('background startup message policy keeps popup warmup startup-safe without abandoned lab overrides', async () => {
  const source = await readText('../js/background.js');

  assert.match(source, /let startupCoreReady = false;/);
  assert.match(source, /function isStartupCoreReady\(\)/);
  assert.match(source, /const STARTUP_SAFE_MESSAGE_TYPES = new Set\(\[/);
  assert.match(source, /'popupWarmup'/);
  assert.match(source, /const POST_STARTUP_ONLY_MESSAGE_TYPES = new Set\(\[/);
  assert.doesNotMatch(source, new RegExp(`setYouTubeWatch|YouTubeWatch|${'youtube' + '-watch'}`, 'i'));
  assert.match(source, /function shouldHandlePostStartupOnlyMessage\(request, sender\)/);
  assert.match(source, /function shouldRejectPostStartupOnlyMessage\(request, sender\)/);
  assert.match(source, /safeCallback\(buildPostStartupOnlyResponse\(\)\);/);
  assert.match(source, /if \( shouldHandlePostStartupOnlyMessage\(request, sender\) \) \{/);
});
