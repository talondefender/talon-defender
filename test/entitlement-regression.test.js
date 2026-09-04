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
  runDurableEntitlementEffects,
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
    { activationTokenClearedAtMs: now - 1 }
  );
});

test('activation-token tombstones reject stale tokens and admit only newer tokens', () => {
  const now = Date.UTC(2026, 2, 4, 16, 0, 0, 0);
  const expiresAt = now + 60_000;

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      activationToken: 'stale-token',
      activationTokenExpiresAtMs: expiresAt,
      activationTokenUpdatedMs: now,
      activationTokenClearedAtMs: now,
    }, { now }),
    { activationTokenClearedAtMs: now }
  );

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      activationToken: 'new-token',
      activationTokenExpiresAtMs: expiresAt,
      activationTokenUpdatedMs: now + 1,
      activationTokenClearedAtMs: now,
    }, { now }),
    {
      activationTokenClearedAtMs: now,
      activationToken: 'new-token',
      activationTokenExpiresAtMs: expiresAt,
      activationTokenUpdatedMs: now + 1,
    }
  );

  assert.deepEqual(
    sanitizeEntitlementSyncState({
      activationToken: 'legacy-token-without-revision',
      activationTokenExpiresAtMs: expiresAt,
      activationTokenClearedAtMs: now,
    }, { now }),
    { activationTokenClearedAtMs: now }
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
    { activationTokenClearedAtMs: now }
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

test('durable entitlement effects keep the marker through failure and clear it after retry', async () => {
  let dirty = false;
  let attempts = 0;
  let retrySchedules = 0;
  let retryClears = 0;
  const run = () => runDurableEntitlementEffects({
    markDirty: async () => { dirty = true; },
    applyEffects: async () => {
      attempts += 1;
      if (attempts === 1) { throw new Error('registration verification failed'); }
      return { verified: true };
    },
    clearDirty: async () => { dirty = false; },
    scheduleRetry: async () => { retrySchedules += 1; },
    clearRetry: async () => { retryClears += 1; },
  });

  await assert.rejects(run(), /registration verification failed/);
  assert.equal(dirty, true);
  assert.equal(retrySchedules, 1);
  assert.equal(retryClears, 0);

  assert.deepEqual(await run(), { verified: true });
  assert.equal(dirty, false);
  assert.equal(retrySchedules, 1);
  assert.equal(retryClears, 1);
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
  const setLicenseSource = source.slice(
    source.indexOf("case 'setLicenseKey':"),
    source.indexOf("case 'replaceDevice':")
  );
  const replaceDeviceSource = source.slice(
    source.indexOf("case 'replaceDevice':"),
    source.indexOf("case 'clearLicenseKey':")
  );

  assert.match(source, /if \( runtimeOnly !== true \)/);
  assert.match(source, /shouldForceCommunitySyncAfterEntitlementRefresh/);
  assert.match(source, /function queueEntitlementOpenTabRefresh\(\)/);
  assert.match(replaceDeviceSource, /enqueueEntitlementAction\(async \(\) => \{/);
  assert.match(replaceDeviceSource, /await verifyLicense\(\{ force: true, replaceDevice: true \}\);/);
  assert.match(replaceDeviceSource, /refreshEntitlement\(\{ verify: false \}\)/);
  assert.match(replaceDeviceSource, /refreshOpenTabsOnEntitled: false,/);
  assert.match(replaceDeviceSource, /queueEntitlementOpenTabRefresh\(\)/);
  assert.match(setLicenseSource, /enqueueEntitlementAction\(async \(\) => \{/);
  assert.match(setLicenseSource, /await storeLicenseKey\(parsed\.key\);/);
  assert.match(setLicenseSource, /refreshEntitlement\(\{\s*verify: true,\s*forceVerify: true,\s*\}\)/);
  assert.match(setLicenseSource, /refreshOpenTabsOnEntitled: false,/);
  assert.match(setLicenseSource, /queueEntitlementOpenTabRefresh\(\)/);
  assert.match(source, /error: 'entitlement_runtime_effects_failed'/);
  assert.match(source, /const ENTITLEMENT_EFFECTS_DIRTY_KEY = 'entitlementEffectsDirtyV1';/);
  assert.match(source, /case 'getInjectableSyncDiagnostics'/);
});

test('background entitlement cleanup clears stale paywall allow-all rules for entitled users', async () => {
  const source = await readText('../js/background.js');
  const cleanupStart = source.indexOf('async function clearPaywallAllowAllRulesNow()');
  const cleanupEnd = source.indexOf('async function disablePaywallNow', cleanupStart);
  const cleanupSource = source.slice(cleanupStart, cleanupEnd);
  const effectsStart = source.indexOf('async function applyEntitlementStatusEffects');
  const effectsEnd = source.indexOf('async function enforceEntitlement', effectsStart);
  const effectsSource = source.slice(effectsStart, effectsEnd);
  const startSource = source.slice(
    source.indexOf('async function startNow({ forcePermissionSync = false } = {}) {'),
    source.indexOf('/******************************************************************************/', source.indexOf('async function startNow({ forcePermissionSync = false } = {}) {'))
  );

  assert.match(cleanupSource, /dnr\.setAllowAllRules\(\s*PAYWALL_RULE_BASE_ID,\s*\[\],\s*\[\],\s*false,\s*PAYWALL_RULE_PRIORITY\s*\)/);
  assert.match(effectsSource, /const reconcileLatePaywallMutation =[\s\S]*prepareEntitledRestoreAfterPaywallMutations\(\)/);
  assert.match(effectsSource, /if \( paywallWasActive \|\| paywallActive \) \{[\s\S]*?await disablePaywall\(\{ broadcast \}\);[\s\S]*?\} else if \( repairAllowAllRules \|\| reconcileLatePaywallMutation \) \{[\s\S]*?await clearPaywallAllowAllRules\(\);[\s\S]*?\}/);
  assert.match(effectsSource, /return runDurableEntitlementEffects\(\{/);
  assert.match(effectsSource, /ensureEntitledRegistrationEffects\(\{/);
  assert.match(
    effectsSource,
    /clearDirty: async \(\) => \{[\s\S]*effectsRevision !== entitlementEffectsRevision[\s\S]*clearEntitlementEffectsDirty\(\)/
  );
  assert.match(effectsSource, /scheduleRetry: scheduleEntitlementEffectsRetry/);
  assert.match(startSource, /const startupNeedsEntitledRegistration =[\s\S]*shouldEnablePaywallForStatus\(entitlementStatus\) === false/);
  assert.match(startSource, /startupNeedsEntitledRegistration === false[\s\S]*applyEntitlementStatusEffects\(entitlementStatus/);
  assert.match(startSource, /await markEntitlementEffectsDirty\(\);[\s\S]*await clearPaywallAllowAllRules\(\);/);
  assert.match(startSource, /startupCoreReady = startupInjectableResultIsReady\(startupInjectableResult\);[\s\S]*await clearEntitlementEffectsDirty\(\);/);
});

test('background paywall cleanup propagates and verifies lifecycle failures', async () => {
  const source = await readText('../js/background.js');
  const contentCleanup = source.slice(
    source.indexOf('async function unregisterAllContentScripts()'),
    source.indexOf('async function unregisterAllUserScripts(')
  );
  const userCleanup = source.slice(
    source.indexOf('async function unregisterAllUserScripts('),
    source.indexOf('function suspendRegistrationMutationsForPaywall()')
  );
  const enablePaywallSource = source.slice(
    source.indexOf('async function enablePaywallNow'),
    source.indexOf('async function clearPaywallAllowAllRulesNow')
  );
  const stopControllersSource = source.slice(
    source.indexOf('function stopIsolatedRuntimeControllers()'),
    source.indexOf('const isFrenchStreamSiteFixHostname')
  );

  assert.match(contentCleanup, /unregisterAndVerifyManagedRegistrations\(\{/);
  assert.match(contentCleanup, /unregisterContentScripts\(\{ ids \}\)/);
  assert.doesNotMatch(contentCleanup, /catch\s*\(/);
  assert.match(userCleanup, /unregisterAndVerifyManagedRegistrations\(\{/);
  assert.match(userCleanup, /isUserScriptsAvailable\(\) === false/);
  assert.doesNotMatch(userCleanup, /supportsUserScripts !== true/);
  assert.match(userCleanup, /userScripts\.unregister\(\{ ids \}\)/);
  assert.match(userCleanup, /catch \(reason\) \{[\s\S]*isUserScriptsAvailable\(\) === false[\s\S]*throw reason;/);
  assert.doesNotMatch(userCleanup, /userScripts\.unregister\(\{ ids \}\)\.catch/);
  assert.match(enablePaywallSource, /suspendRegistrationMutationsForPaywall\(\);/);
  assert.match(enablePaywallSource, /const openTabCleanup = stopRuntimeStateForOpenTabs\(\)\.then\(stopped => \{[\s\S]*stopped !== true[\s\S]*paywall open-tab cleanup was not verified/);
  assert.match(enablePaywallSource, /const preparationResults = await Promise\.allSettled\(\[[\s\S]*boundedRegistrationDrain/);
  assert.match(enablePaywallSource, /const unregistrationResults = await Promise\.allSettled\(\[[\s\S]*trackPaywallMutation\(unregisterAllContentScripts\(\)\)[\s\S]*trackPaywallMutation\(unregisterAllUserScriptsSingleFlight\(\)\)/);
  assert.match(enablePaywallSource, /const runtimeCleanupResults = await Promise\.allSettled\(\[[\s\S]*trackPaywallMutation\(openTabCleanup\)/);
  assert.ok(
    enablePaywallSource.indexOf('const unregistrationResults =') <
      enablePaywallSource.indexOf('const openTabCleanup ='),
    'paywall must unregister every injection lane before snapshotting documents for cleanup'
  );
  assert.match(enablePaywallSource, /PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS/);
  assert.match(enablePaywallSource, /paywall cleanup verification failed/);
  assert.doesNotMatch(enablePaywallSource, /paywall\/stopOpenTabs/);
  assert.doesNotMatch(stopControllersSource, /try \{ jobs\.push\(Promise\.resolve\(controller/);
  assert.match(source, /setInjectableRegistrationSuspended\(true\);/);
  assert.match(source, /setSandboxFilterRegistrationSuspended\(true\);/);
  assert.match(source, /waitForInjectableRegistrationIdle\(\)/);
  assert.match(source, /waitForSandboxFilterOperations\(\)/);
  assert.match(source, /hasTimedOutRegistrationOperations\(\)/);
  assert.match(source, /const ENTITLEMENT_EFFECTS_RETRY_ALARM = 'entitlement-effects-retry';/);
  assert.match(source, /alarm\?\.name === ENTITLEMENT_EFFECTS_RETRY_ALARM[\s\S]*forceEffects: true/);
});

test('paywall user-script cleanup stays frequent, durable, and single-flight', async () => {
  const source = await readText('../js/background.js');
  const constantsSource = source.slice(
    source.indexOf("const USER_SCRIPTS_CLEANUP_PENDING_KEY"),
    source.indexOf('const AUTO_ANNOYANCES_BASELINE_KEY')
  );
  const cleanupSource = source.slice(
    source.indexOf('async function unregisterAllUserScripts('),
    source.indexOf('function suspendRegistrationMutationsForPaywall()')
  );
  const alarmSource = source.slice(
    source.indexOf('async function onAlarmAfterStartup'),
    source.indexOf('async function handleStartupProcessRetryAlarm')
  );

  assert.match(
    constantsSource,
    /const USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES = 1;/
  );
  assert.doesNotMatch(constantsSource, /USER_SCRIPTS_CLEANUP_RETRY_DELAYS_MINUTES/);
  assert.match(
    cleanupSource,
    /readLocalStrict\(USER_SCRIPTS_CLEANUP_PENDING_KEY\)\.catch\(\(\) => true\)/
  );
  assert.match(
    cleanupSource,
    /localWrite\(USER_SCRIPTS_CLEANUP_PENDING_KEY,[\s\S]*nextAttemptAt:[\s\S]*USER_SCRIPTS_CLEANUP_OPPORTUNISTIC_PROBE_INTERVAL_MS/
  );
  assert.match(
    cleanupSource,
    /browser\.alarms\.create\(USER_SCRIPTS_CLEANUP_RETRY_ALARM,[\s\S]*delayInMinutes: USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES/
  );
  assert.ok(
    cleanupSource.indexOf('localWrite(USER_SCRIPTS_CLEANUP_PENDING_KEY') <
      cleanupSource.indexOf('await browser.userScripts.unregister();'),
    'cleanup intent must be durable before Chrome registration state is mutated'
  );
  assert.ok(
    cleanupSource.indexOf('await browser.userScripts.unregister();') <
      cleanupSource.indexOf('localRemove(USER_SCRIPTS_CLEANUP_PENDING_KEY)'),
    'durable cleanup evidence must survive until unregistration and verification finish'
  );
  assert.match(
    cleanupSource,
    /function unregisterAllUserScriptsSingleFlight[\s\S]*userScriptsPaywallCleanupPromise instanceof Promise[\s\S]*userScriptsPaywallCleanupPromise = operation/
  );
  assert.match(
    cleanupSource,
    /async function opportunisticallyCleanupPaywalledUserScripts[\s\S]*paywallActive === false[\s\S]*readLocalStrict\(USER_SCRIPTS_CLEANUP_PENDING_KEY\)[\s\S]*isUserScriptsAvailable\(\) === false[\s\S]*unregisterAllUserScriptsSingleFlight/
  );
  assert.match(
    cleanupSource,
    /function observePendingUserScriptsPaywallCleanup[\s\S]*enqueueEntitlementAction\([\s\S]*opportunisticallyCleanupPaywalledUserScripts/
  );
  assert.match(
    alarmSource,
    /alarm\?\.name === USER_SCRIPTS_CLEANUP_RETRY_ALARM[\s\S]*enqueueEntitlementAction\(async \(\) => \{[\s\S]*unregisterAllUserScriptsSingleFlight[\s\S]*delayInMinutes: USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES/
  );
  assert.match(
    source,
    /browser\.tabs\?\.onUpdated\?\.addListener\([\s\S]*observePendingUserScriptsPaywallCleanup\(\)/
  );
  assert.match(
    source,
    /runtime\.onMessage\.addListener\([\s\S]*observePendingUserScriptsPaywallCleanup\(\)/
  );
});

test('license storage keeps raw keys local and clears sync-safe activation tokens', async () => {
  const entitlementSource = await readText('../js/entitlement.js');
  const optionsSource = await readText('../options/options.js');

  assert.match(entitlementSource, /export const ENTITLEMENT_STORAGE_KEY = 'talonEntitlement';/);
  assert.match(entitlementSource, /export const ENTITLEMENT_SYNC_STORAGE_KEY = 'talonEntitlementSync';/);
  assert.match(entitlementSource, /export async function clearLicenseKey\(\) \{/);
  assert.match(
    entitlementSource,
    /const clearedAtMs = nextActivationTokenMutationMs\(stored, now\);[\s\S]*licenseKey: '',[\s\S]*licenseRevision,[\s\S]*lastVerifiedMs: 0,[\s\S]*licensePlan: '',[\s\S]*activationToken: '',[\s\S]*activationTokenExpiresAtMs: 0,[\s\S]*activationTokenClearedAtMs: clearedAtMs/
  );
  assert.match(
    entitlementSource,
    /afterWrite: stored => clearActivationTokenWhileLocked\([\s\S]*stored,[\s\S]*activationTokenClearAtMs/
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

const createEntitlementRuntimeHarness = async () => {
  const previousChrome = globalThis.chrome;
  const previousSelf = globalThis.self;
  const local = {};
  const sync = {};
  const failures = {
    localGet: false,
    localSet: false,
    syncGet: false,
    syncSet: false,
  };
  const hooks = {
    localSet: null,
    syncSet: null,
  };
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const createStorageArea = (store, prefix) => ({
    async get(key) {
      if (failures[`${prefix}Get`]) {
        throw new Error(`${prefix}-get-failed`);
      }
      if (key === null || key === undefined) {
        return clone(store);
      }
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map(name => [name, clone(store[name])]));
      }
      return { [key]: clone(store[key]) };
    },
    async set(patch) {
      if (failures[`${prefix}Set`]) {
        throw new Error(`${prefix}-set-failed`);
      }
      if (typeof hooks[`${prefix}Set`] === 'function') {
        await hooks[`${prefix}Set`](patch);
      }
      for (const [key, value] of Object.entries(patch || {})) {
        store[key] = clone(value);
      }
    },
    async remove(key) {
      for (const name of Array.isArray(key) ? key : [key]) {
        delete store[name];
      }
    },
    async getKeys() {
      return Object.keys(store);
    },
  });

  globalThis.self = globalThis;
  globalThis.chrome = {
    i18n: {},
    runtime: {
      getURL: path => `chrome-extension://entitlement-test/${path || ''}`,
      getManifest: () => ({
        version: '0.0.0-test',
        homepage_url: 'https://talondefender.com/',
      }),
      getPlatformInfo(callback) {
        const value = { os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' };
        callback?.(value);
        return Promise.resolve(value);
      },
      sendMessage: async () => undefined,
    },
    storage: {
      local: createStorageArea(local, 'local'),
      sync: createStorageArea(sync, 'sync'),
    },
    tabs: { TAB_ID_NONE: -1 },
  };

  const entitlement = await import(
    `../js/entitlement.js?entitlement-regression=${Date.now()}`
  );
  const reset = () => {
    for (const key of Object.keys(local)) { delete local[key]; }
    for (const key of Object.keys(sync)) { delete sync[key]; }
    for (const key of Object.keys(failures)) { failures[key] = false; }
    for (const key of Object.keys(hooks)) { hooks[key] = null; }
  };
  const restoreGlobals = () => {
    if (previousChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
    if (previousSelf === undefined) {
      delete globalThis.self;
    } else {
      globalThis.self = previousSelf;
    }
  };
  return { entitlement, failures, hooks, local, reset, restoreGlobals, sync };
};

test('entitlement persistence resists stale verification and token resurrection', async t => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const harness = await createEntitlementRuntimeHarness();
  const {
    ENTITLEMENT_STORAGE_KEY,
    ENTITLEMENT_SYNC_STORAGE_KEY,
    LICENSE_VERIFY_RETRY_BASE_MS,
    LICENSE_VERIFY_RETRY_MAX_MS,
    clearLicenseKey,
    initEntitlement,
    readEntitlement,
    setLicenseKey,
    verifyLicense,
  } = harness.entitlement;
  const expiredTrialStart = Date.now() - (DEFAULT_TRIAL_PERIOD_MS * 2);
  const baseLocalState = overrides => ({
    trialStartMs: expiredTrialStart,
    deviceId: 'device-12345678',
    licenseKey: 'TD-OLD-KEY',
    licenseKeyUpdatedMs: 100,
    licenseRevision: 1,
    ...overrides,
  });
  const reset = () => {
    harness.reset();
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
  };

  t.after(() => {
    reset();
    harness.restoreGlobals();
  });

  await t.test('changing a key tombstones the previous activation token', async () => {
    reset();
    const tokenUpdatedMs = Date.now() + 10_000;
    const tokenExpiresAtMs = tokenUpdatedMs + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: tokenExpiresAtMs,
      graceUntilMs: tokenExpiresAtMs,
      licenseKind: 'remote',
      activationToken: 'old-local-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    });
    harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY] = {
      trialStartMs: expiredTrialStart,
      activationToken: 'old-sync-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    };

    await setLicenseKey('TD-NEW-KEY');
    const afterChange = await readEntitlement();
    assert.equal(afterChange.licenseKey, 'TD-NEW-KEY');
    assert.equal(afterChange.entitledUntilMs, 0);
    assert.equal(afterChange.graceUntilMs, 0);
    assert.equal(afterChange.activationToken, '');
    assert.ok(afterChange.activationTokenClearedAtMs > tokenUpdatedMs);
    assert.equal(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY].activationToken,
      undefined
    );
    assert.ok(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY].activationTokenClearedAtMs >
        tokenUpdatedMs
    );

    const status = await initEntitlement({ now: Date.now() });
    assert.equal(status.status, 'expired');
    assert.equal((await readEntitlement()).activationToken, '');
  });

  await t.test('accepted license keys are not silently truncated at 256 characters', async () => {
    reset();
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: 0,
      graceUntilMs: 0,
    });
    const acceptedKey = 'K'.repeat(300);

    await setLicenseKey(acceptedKey);
    assert.equal((await readEntitlement()).licenseKey, acceptedKey);
  });

  await t.test('a sync write failure cannot undo a local license clear', async () => {
    reset();
    const tokenUpdatedMs = Date.now() + 10_000;
    const tokenExpiresAtMs = tokenUpdatedMs + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: tokenExpiresAtMs,
      graceUntilMs: tokenExpiresAtMs,
      licenseKind: 'remote',
      activationToken: 'old-local-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    });
    harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY] = {
      trialStartMs: expiredTrialStart,
      activationToken: 'old-sync-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    };
    harness.failures.syncSet = true;

    await clearLicenseKey();
    const cleared = await readEntitlement();
    assert.equal(cleared.licenseKey, '');
    assert.equal(cleared.entitledUntilMs, 0);
    assert.equal(cleared.activationToken, '');
    assert.ok(cleared.activationTokenClearedAtMs > tokenUpdatedMs);

    harness.failures.syncSet = false;
    const status = await initEntitlement({ now: Date.now() });
    assert.equal(status.status, 'expired');
    assert.equal((await readEntitlement()).activationToken, '');
  });

  await t.test('a newer sync tombstone revokes activation-token-only entitlement', async () => {
    reset();
    const now = Date.now();
    const tokenUpdatedMs = now - 1_000;
    const tokenExpiresAtMs = now + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = {
      trialStartMs: expiredTrialStart,
      deviceId: 'device-12345678',
      licenseKey: '',
      licenseKeyUpdatedMs: 100,
      licenseRevision: 1,
      entitledUntilMs: tokenExpiresAtMs,
      graceUntilMs: tokenExpiresAtMs,
      licenseKind: 'activation-token',
      activationToken: 'local-activation-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    };
    harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY] = {
      trialStartMs: expiredTrialStart,
      activationTokenClearedAtMs: tokenUpdatedMs + 1,
    };

    const status = await initEntitlement({ now });
    assert.equal(status.status, 'expired');
    const stored = await readEntitlement();
    assert.equal(stored.activationToken, '');
    assert.equal(stored.entitledUntilMs, 0);
    assert.equal(stored.graceUntilMs, 0);
    assert.equal(stored.licenseKind, '');
  });

  await t.test('an old verification response cannot overwrite a newer key', async () => {
    reset();
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: 0,
      graceUntilMs: 0,
    });
    let resolveResponse;
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
    globalThis.fetch = () => {
      fetchStartedResolve();
      return new Promise(resolve => { resolveResponse = resolve; });
    };
    const now = Date.now();
    const oldVerification = verifyLicense({ force: true, now });
    await fetchStarted;
    await setLicenseKey('TD-NEW-KEY');
    resolveResponse({
      ok: true,
      status: 200,
      json: async () => ({
        active: true,
        entitledUntil: now + 86_400_000,
        activationToken: 'stale-response-token',
        activationTokenExpiresAtMs: now + 86_400_000,
      }),
    });

    assert.deepEqual(await oldVerification, { ok: false, skipped: 'stale' });
    const stored = await readEntitlement();
    assert.equal(stored.licenseKey, 'TD-NEW-KEY');
    assert.equal(stored.entitledUntilMs, 0);
    assert.equal(stored.activationToken, '');
    assert.equal(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY]?.activationToken,
      undefined
    );
  });

  await t.test('verification publishes sync state before a newer key mutation', async () => {
    reset();
    const now = Date.now();
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: 0,
      graceUntilMs: 0,
    });
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        active: true,
        entitledUntil: now + 86_400_000,
        activationToken: 'old-key-token',
        activationTokenExpiresAtMs: now + 86_400_000,
      }),
    });
    let releaseSyncWrite;
    let syncWriteStartedResolve;
    let blockFirstSyncWrite = true;
    const syncWriteStarted = new Promise(resolve => {
      syncWriteStartedResolve = resolve;
    });
    const syncWriteGate = new Promise(resolve => { releaseSyncWrite = resolve; });
    harness.hooks.syncSet = async () => {
      if (blockFirstSyncWrite === false) { return; }
      blockFirstSyncWrite = false;
      syncWriteStartedResolve();
      await syncWriteGate;
    };

    const oldVerification = verifyLicense({ force: true, now });
    await syncWriteStarted;
    let newerKeyResolved = false;
    const newerKeyWrite = setLicenseKey('TD-NEW-KEY').then(value => {
      newerKeyResolved = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(newerKeyResolved, false);

    releaseSyncWrite();
    assert.equal((await oldVerification).ok, true);
    await newerKeyWrite;
    const stored = await readEntitlement();
    assert.equal(stored.licenseKey, 'TD-NEW-KEY');
    assert.equal(stored.activationToken, '');
    assert.equal(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY].activationToken,
      undefined
    );
  });

  await t.test('retry backoff is persisted, bypassable, and capped', async () => {
    reset();
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: 0,
      graceUntilMs: 0,
    });
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      throw new TypeError('network unavailable');
    };
    Math.random = () => 1;
    const now = Date.now();

    assert.equal((await verifyLicense({ force: true, now })).ok, false);
    const firstFailure = await readEntitlement();
    assert.equal(firstFailure.verifyFailureCount, 1);
    assert.ok(
      firstFailure.nextVerifyAttemptMs - now >=
        Math.floor(LICENSE_VERIFY_RETRY_BASE_MS * 0.85)
    );
    assert.ok(
      firstFailure.nextVerifyAttemptMs - now <=
        Math.ceil(LICENSE_VERIFY_RETRY_BASE_MS * 1.15)
    );

    const skipped = await verifyLicense({ now: now + 1 });
    assert.equal(skipped.skipped, 'backoff');
    assert.equal(fetchCount, 1);

    harness.local[ENTITLEMENT_STORAGE_KEY].verifyFailureCount = 16;
    harness.local[ENTITLEMENT_STORAGE_KEY].nextVerifyAttemptMs = 0;
    const laterNow = now + 1_000;
    await verifyLicense({ force: true, now: laterNow });
    const capped = await readEntitlement();
    assert.equal(capped.verifyFailureCount, 16);
    assert.ok(capped.nextVerifyAttemptMs - laterNow <= LICENSE_VERIFY_RETRY_MAX_MS);
    assert.equal(fetchCount, 2);
  });

  await t.test('malformed success responses preserve the last known paid state', async () => {
    reset();
    const now = Date.now();
    const paidUntil = now + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: paidUntil,
      graceUntilMs: paidUntil + 86_400_000,
      licenseKind: 'remote',
    });
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ active: 'false', entitledUntil: paidUntil }),
    });

    const result = await verifyLicense({ force: true, now });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid-response');
    const stored = await readEntitlement();
    assert.equal(stored.entitledUntilMs, paidUntil);
    assert.equal(stored.licenseKind, 'remote');
    assert.equal(stored.verifyFailureCount, 1);
  });

  await t.test('local storage read failures do not synthesize a fresh trial', async () => {
    reset();
    const paidUntil = Date.now() + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      entitledUntilMs: paidUntil,
      graceUntilMs: paidUntil,
      licenseKind: 'remote',
    });
    const before = structuredClone(harness.local[ENTITLEMENT_STORAGE_KEY]);
    harness.failures.localGet = true;

    await assert.rejects(initEntitlement(), /local-get-failed/);
    harness.failures.localGet = false;
    assert.deepEqual(harness.local[ENTITLEMENT_STORAGE_KEY], before);
  });

  await t.test('sync read failures preserve synced state and recover on retry', async () => {
    reset();
    const now = Date.now();
    const localTrialStartMs = now - (2 * 24 * 60 * 60 * 1000);
    const syncedTrialStartMs = now - (6 * 24 * 60 * 60 * 1000);
    const tokenUpdatedMs = now - 1_000;
    const tokenExpiresAtMs = now + 86_400_000;
    harness.local[ENTITLEMENT_STORAGE_KEY] = baseLocalState({
      trialStartMs: localTrialStartMs,
      licenseKey: '',
      entitledUntilMs: 0,
      graceUntilMs: 0,
      licenseKind: '',
    });
    harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY] = {
      trialStartMs: syncedTrialStartMs,
      activationToken: 'existing-sync-token',
      activationTokenExpiresAtMs: tokenExpiresAtMs,
      activationTokenUpdatedMs: tokenUpdatedMs,
    };
    const syncBeforeFailure = structuredClone(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY]
    );
    harness.failures.syncGet = true;

    const localStatus = await initEntitlement({ now });
    assert.equal(localStatus.status, 'trial');
    assert.equal(
      harness.local[ENTITLEMENT_STORAGE_KEY].trialStartMs,
      localTrialStartMs
    );
    assert.deepEqual(
      harness.sync[ENTITLEMENT_SYNC_STORAGE_KEY],
      syncBeforeFailure
    );

    harness.failures.syncGet = false;
    const recoveredStatus = await initEntitlement({ now });
    assert.equal(recoveredStatus.status, 'paid');
    const recovered = await readEntitlement();
    assert.equal(recovered.trialStartMs, syncedTrialStartMs);
    assert.equal(recovered.activationToken, 'existing-sync-token');
    assert.equal(recovered.entitledUntilMs, tokenExpiresAtMs);
  });

  await t.test('an unavailable authoritative local API fails closed', async () => {
    reset();
    const localArea = globalThis.chrome.storage.local;
    delete globalThis.chrome.storage.local;
    try {
      await assert.rejects(
        readEntitlement(),
        /entitlement local storage API unavailable/
      );
    } finally {
      globalThis.chrome.storage.local = localArea;
    }
  });
});
