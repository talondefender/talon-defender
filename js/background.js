/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    MODE_NONE,
    MODE_BASIC,
    MODE_COMPLETE,
    MODE_OPTIMAL,
    defaultFilteringModes,
    getDefaultFilteringMode,
    getFilteringMode,
    getFilteringModeDetails,
    reconcileFilteringModeDetails as reconcileFilteringModeDetailsRaw,
    setDefaultFilteringMode as setDefaultFilteringModeRaw,
    setFilteringMode as setFilteringModeRaw,
    setFilteringModeDetails as setFilteringModeDetailsRaw,
    syncWithBrowserPermissions as syncWithBrowserPermissionsRaw,
} from './mode-manager.js';

import {
    MANAGED_USER_SCRIPTS_MAY_EXIST_KEY,
    SANDBOX_COMPILED_FINGERPRINT_KEY,
    SANDBOX_DNR_DIRTY_KEY,
    SANDBOX_REGISTRATION_APPLIED_REVISION_KEY,
    SANDBOX_REGISTRATION_DIRTY_KEY,
    SANDBOX_REGISTRATION_REVISION_KEY,
    SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY,
    acknowledgeSandboxUserScriptLiveReload,
    addCustomFilters,
    customFiltersFromHostname,
    getAllCustomFilters,
    fingerprintManagedUserScriptRegistrations,
    getSandboxFilters,
    hasTimedOutSandboxFilterOperations,
    hasCustomFilters,
    injectCustomFilters,
    markSandboxRegistrationDirty,
    prepareCustomFilterDetails,
    reconcileSandboxFilters,
    registerSandboxFilters,
    removeAllCustomFilters,
    removeCustomFilters,
    setSandboxFilters,
    setSandboxFilterRegistrationSuspended,
    startCustomFilters,
    terminateCustomFilters,
    waitForSandboxFilterOperations,
    waitForTimedOutSandboxFilterOperations,
} from './filter-manager.js';

import {
    adminReadEx,
    getAdminRulesets,
    loadAdminConfig,
    setAdminDeveloperModeDisabler,
    setAdminRuntimeReconciler,
} from './admin.js';

import {
    broadcastMessage,
    createOverlaySessionStore,
    gotoURL,
    hasBroadHostPermissions,
    hostnamesFromMatches,
    ignoreRuntimeError,
    ignoreRuntimeLastError,
    isIgnorableRuntimeError,
} from './utils.js';
import {
    getTrialReminderWhen,
    normalizeAndValidateLicenseKey,
    runDurableEntitlementEffects,
    shouldForceCommunitySyncAfterEntitlementRefresh,
    shouldEnablePaywallForStatus,
    shouldRecordTrialReminderShown,
} from './entitlement-logic.js';
import {
    AUTO_BACKOFF_SIGNAL_WINDOW_MS,
    BREAKAGE_SUBSYSTEM_IDS,
    getDowngradedFilteringMode,
    isSevereBreakageSignal,
    mergeBreakageEvidenceEntry,
    normalizeBreakageSubsystem,
    normalizeHttpHostname,
    sanitizeBreakageDetails,
    shouldTriggerSignalBackoff,
    updateSignalCounter,
} from './auto-backoff.js';
import {
    BREAKAGE_AUDIT_OVERRIDES_KEY,
    sanitizeBreakageAuditOverrides,
} from './breakage-policy.js';
import {
    normalizeAutoPromotedHostname,
    normalizeSiteKeyHostname,
} from './site-key.js';
import {
    RULESET_SELECTION_STATE_VERSION,
} from './default-rulesets.js';
import {
    PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,
    REMOTE_SCRIPTLET_RELOAD_REASON,
    isRemoteScriptletDirectiveId,
    mergeRemoteScriptletReloadHints,
    normalizeRemoteScriptletReloadHint,
    shouldReloadForFrameUrls,
} from './remote-scriptlet-hotfix.js';
import {
    AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY,
    REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
    getAutoRegionalRulesetIds,
    getPreferredLanguageTags,
    getPublicSafeRegionalRulesetIds,
    reconcileAutoRegionalRulesetPatch,
    reconcileRegionalRulesetOptOutPatch,
} from './regional-rulesets.js';

const AUTO_BACKOFF_STORAGE_KEY = 'autoBackoffHostsV1';
const AUTO_BACKOFF_EVIDENCE_STORAGE_KEY = 'autoBackoffEvidenceV1';
const AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY = 'autoBackoffSubsystemsV1';
const AUTO_BACKOFF_ALARM = 'auto-backoff-restore';
const AUTO_BACKOFF_TTL_MS = 60 * 60 * 1000;
const AUTO_BACKOFF_WINDOW_MS = 2 * 60 * 1000;
const AUTO_BACKOFF_MIN_ERRORS = 2;
const AUTO_BACKOFF_ERROR_RE = /ERR_BLOCKED_BY_CLIENT/i;
const AUTO_PROMOTION_STATE_KEY = 'autoPromotionStateV2';
const AUTO_PROMOTION_ALARM = 'auto-promotion-expire';
const AUTO_PROMOTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RULESET_IDS_STORAGE_KEY = 'defaultRulesetIds';
const PENDING_INSTALL_RULESET_RESET_KEY = 'pendingInstallRulesetResetV1';
const INJECTABLE_RUNTIME_STATE_KEY = 'injectableRuntimeStateV1';
const ENTITLEMENT_EFFECTS_DIRTY_KEY = 'entitlementEffectsDirtyV1';
const ENTITLEMENT_EFFECTS_RETRY_ALARM = 'entitlement-effects-retry';
const ENTITLEMENT_EFFECTS_RETRY_DELAY_MINUTES = 1;
const DNR_RECONCILIATION_ALARM = 'dnr-reconciliation-retry';
const INJECTABLE_STARTUP_RETRY_ALARM = 'injectable-startup-retry';
const INJECTABLE_STARTUP_RETRY_DELAY_MINUTES = 1;
const DEFERRED_RUNTIME_RETRY_ALARM = 'deferred-runtime-retry';
const DEFERRED_RUNTIME_RETRY_DELAY_MINUTES = 1;
const DEFERRED_RUNTIME_RETRY_DELAYS_MINUTES = Object.freeze([ 1, 5, 15, 60 ]);
const MAX_AUTOMATIC_DEFERRED_REFRESH_FAILURES = 3;
const DEFERRED_RUNTIME_MANUAL_RELOAD_REASON = 'runtime_repair_failed';
const STARTUP_PROCESS_RETRY_ALARM = 'startup-process-retry';
const START_SESSION_COMMIT_KEY = 'startupSessionCommitV1';
const STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY =
    'startupDocumentRuntimeDirtyV1';
const USER_SCRIPTS_CLEANUP_PENDING_KEY = 'userScriptsCleanupPendingV1';
const USER_SCRIPTS_CLEANUP_RETRY_ALARM = 'user-scripts-cleanup-retry';
// Chrome retains dynamic user-script registrations while the user-controlled
// Allow User Scripts toggle is off, then makes them live again immediately
// when it is re-enabled. Never grow this paywall cleanup gap to an hour.
const USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES = 1;
const USER_SCRIPTS_CLEANUP_OPPORTUNISTIC_PROBE_INTERVAL_MS =
    USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES * 60 * 1000;
const AUTO_ANNOYANCES_BASELINE_KEY = 'autoAnnoyancesBaselineRulesets';
const AUTO_ANNOYANCES_DISABLED_KEY = 'autoAnnoyancesDisabledInComplete';
const REMOTE_COSMETICS_RUNTIME_STATS_KEY = 'remoteCosmeticsRuntimeStatsV1';
const REMOTE_COSMETICS_RUNTIME_STATS_TTL_MS = 24 * 60 * 60 * 1000;
const REMOTE_COSMETICS_RUNTIME_STATS_REFRESH_MS = 6 * 60 * 60 * 1000;
const REMOTE_COSMETICS_STORAGE_KEY = 'communityBundleCosmetics';
const OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY = 4;
const MAX_OPAQUE_CHILD_ORIGIN_PROBES = 16;
const OPAQUE_ORIGIN_PROBE_TIMEOUT_MS = 750;
const MAX_LIVE_RUNTIME_FRAME_TARGETS = 32;
const RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE = 8;
const CORE_COSMETIC_TERMINATOR_PATH = '/js/scripting/css-core-terminate.js';
const CORE_COSMETIC_REGISTRATION_IDS = Object.freeze([
    'css-specific',
    'css-procedural',
    'css-generic-all',
    'css-generic-some',
]);
const CORE_COSMETIC_REGISTRATION_ID_SET = new Set(
    CORE_COSMETIC_REGISTRATION_IDS
);
const BASIC_TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/js/scripting/breakage-guard.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/ad-shell-styles.js',
]);
const TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/public-suffix-data.js',
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/cooperative-scheduler.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/native-heuristics.js',
    '/js/scripting/automation.js',
    '/js/scripting/post-hide-cleanup.js',
    '/js/scripting/ad-shell-styles.js',
]);
const REMOTE_COSMETICS_GLOBAL_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/public-suffix-data.js',
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/cooperative-scheduler.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/remote-cosmetics.js',
    '/js/scripting/remote-cosmetics-global.js',
]);
const REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/public-suffix-data.js',
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/cooperative-scheduler.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/remote-cosmetics.js',
    '/js/scripting/remote-cosmetics-host.js',
]);
const FRENCH_STREAM_SITE_FIX_MAIN_PATH =
    '/rulesets/scripting/scriptlet/main/talon-site-fixes.js';
const FRENCH_STREAM_SITE_FIX_HOSTNAMES = Object.freeze([
    'french-stream.one',
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
]);
const DEFAULT_ACTION_TITLE = 'Talon Defender';
const HOTFIX_RELOAD_ACTION_TITLE = 'Talon Defender: Reload tab to apply hotfix';
const RUNTIME_RELOAD_ACTION_TITLE =
    'Talon Defender: Reload tab to finish protection update';
const HOTFIX_RELOAD_BADGE_COLOR = '#f59e0b';
const PUBLIC_SAFE_REGIONAL_RULESET_ID_SET = new Set(getPublicSafeRegionalRulesetIds());

const autoBackoffCounts = new Map();
const autoBackoffSignalCounts = new Map();
let autoBackoffState = new Map();
let autoBackoffEvidence = new Map();
let autoBackoffSubsystemState = new Map();
let autoPromotionState = {
    complete: new Map(),
};
const reloadNeededTabs = new Map();
const RELOAD_NEEDED_TABS_STORAGE_KEY = 'reloadNeededTabsV1';
const SANDBOX_USER_SCRIPT_RELOAD_REASON = 'sandbox_user_script_changed';
const RELOAD_NEEDED_STORAGE_SCHEMA = 2;
const MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB = 8;
const MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB = 16;
const RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX = 'reloadSafeDocumentsV1:';
const PRERENDER_DOCUMENTS_SESSION_KEY_PREFIX = 'prerenderDocumentsV1:';
const RELOAD_WILDCARD_TTL_MS = 24 * 60 * 60 * 1000;
let reloadNeededTabsHydrationPromise;
let reloadNeededTabsPersistenceTail = Promise.resolve();

const createReloadNeededTabRecord = () => ({
    documents: new Map(),
    safeDocumentIds: new Set(),
    wildcardReason: '',
    wildcardUpdatedAt: 0,
    wildcardAllDocuments: false,
    wildcardReloadHint: null,
    revision: 0,
});

const getOrCreateReloadNeededTabRecord = tabId => {
    let record = reloadNeededTabs.get(tabId);
    if ( record === undefined ) {
        record = createReloadNeededTabRecord();
        reloadNeededTabs.set(tabId, record);
    }
    return record;
};

const pruneReloadNeededTabRecord = record => {
    const documents = Array.from(record.documents.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB);
    record.documents = new Map(documents.map(entry => [
        entry.documentId,
        entry,
    ]));
    record.safeDocumentIds = new Set(
        Array.from(record.safeDocumentIds)
            .slice(-MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB)
    );
};

const reloadSafeDocumentsSessionKey = tabId =>
    `${RELOAD_SAFE_DOCUMENTS_SESSION_KEY_PREFIX}${tabId}`;

const prerenderDocumentsSessionKey = tabId =>
    `${PRERENDER_DOCUMENTS_SESSION_KEY_PREFIX}${tabId}`;

const reloadSafeDocumentsPersistenceTails = new Map();
const prerenderDocumentRecords = new Map();
const prerenderDocumentPersistenceTails = new Map();
const prerenderTabMigrationPromises = new Map();
const prerenderTabMigrationFailures = new Map();
const prerenderDocumentRecordKey = (tabId, documentId) =>
    `${tabId}|${documentId}`;

const enqueuePrerenderDocumentPersistence = (tabId, operation) => {
    const previous = prerenderDocumentPersistenceTails.get(tabId) ||
        Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    prerenderDocumentPersistenceTails.set(tabId, run);
    run.finally(() => {
        if ( prerenderDocumentPersistenceTails.get(tabId) === run ) {
            prerenderDocumentPersistenceTails.delete(tabId);
        }
    }).catch(() => {});
    return run;
};

const persistReloadSafeDocumentsForTab = (tabId, record) => {
    const previous = reloadSafeDocumentsPersistenceTails.get(tabId) ||
        Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
        const storage = browser.storage?.session;
        if (
            typeof storage?.set !== 'function' ||
            typeof storage?.remove !== 'function'
        ) {
            return false;
        }
        const key = reloadSafeDocumentsSessionKey(tabId);
        if (
            record?.wildcardReason === '' ||
            record?.safeDocumentIds?.size === 0
        ) {
            await storage.remove(key);
            return true;
        }
        await storage.set({
            [key]: {
                wildcardUpdatedAt: record.wildcardUpdatedAt,
                documentIds: Array.from(record.safeDocumentIds)
                    .slice(-MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB),
            },
        });
        return true;
    });
    reloadSafeDocumentsPersistenceTails.set(tabId, run);
    run.finally(() => {
        if ( reloadSafeDocumentsPersistenceTails.get(tabId) === run ) {
            reloadSafeDocumentsPersistenceTails.delete(tabId);
        }
    }).catch(() => {});
    return run;
};

const readSessionPrerenderRecords = async key => {
    const storage = browser.storage?.session;
    if ( typeof storage?.get !== 'function' ) { return []; }
    const bin = await storage.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid session document state for ${key}`);
    }
    if ( Array.isArray(bin[key]) === false ) { return []; }
    return bin[key].map(value => {
        if ( typeof value === 'string' && value !== '' ) {
            return { documentId: value, committedAt: 0 };
        }
        if (
            typeof value?.documentId !== 'string' ||
            value.documentId === ''
        ) {
            return null;
        }
        return {
            documentId: value.documentId,
            committedAt: Math.max(0, Number(value.committedAt) || 0),
        };
    }).filter(value => value !== null);
};

const rememberPrerenderDocument = (tabId, documentId, committedAt = Date.now()) => {
    if (
        Number.isInteger(tabId) === false || tabId < 0 ||
        typeof documentId !== 'string' || documentId === ''
    ) {
        return Promise.resolve(false);
    }
    const record = {
        documentId,
        committedAt: Math.max(0, Number(committedAt) || Date.now()),
    };
    // Record synchronously so an activation event cannot overtake the storage
    // round-trip in this worker.
    prerenderDocumentRecords.set(
        prerenderDocumentRecordKey(tabId, documentId),
        record
    );
    const storage = browser.storage?.session;
    if ( typeof storage?.set !== 'function' ) { return Promise.resolve(false); }
    return enqueuePrerenderDocumentPersistence(tabId, async () => {
        const key = prerenderDocumentsSessionKey(tabId);
        const records = await readSessionPrerenderRecords(key);
        const next = records.filter(value => value.documentId !== documentId);
        next.push(record);
        await storage.set({
            [key]: next.slice(-MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB),
        });
        return true;
    });
};

const consumePrerenderDocument = async (tabId, documentId) => {
    const migration = prerenderTabMigrationPromises.get(tabId);
    let migrationFailed = false;
    if ( migration instanceof Promise ) {
        try {
            await migration;
        } catch {
            migrationFailed = true;
        }
    }
    const failedRemovedTabId = prerenderTabMigrationFailures.get(tabId);
    if ( Number.isInteger(failedRemovedTabId) ) {
        try {
            await Promise.all([
                beginPrerenderTabMigration(tabId, failedRemovedTabId),
                migrateRuntimeLifecycleTabState(tabId, failedRemovedTabId),
            ]);
            prerenderTabMigrationFailures.delete(tabId);
            migrationFailed = false;
        } catch (reason) {
            migrationFailed = true;
            ubolErr(`prerender lifecycle migration retry/${reason}`);
        }
    }
    const storage = browser.storage?.session;
    if ( typeof storage?.remove !== 'function' ) { return false; }
    const memoryKey = prerenderDocumentRecordKey(tabId, documentId);
    const memoryRecord = prerenderDocumentRecords.get(memoryKey);
    prerenderDocumentRecords.delete(memoryKey);
    return enqueuePrerenderDocumentPersistence(tabId, async () => {
        const key = prerenderDocumentsSessionKey(tabId);
        const records = await readSessionPrerenderRecords(key);
        const storedRecord = records.find(value =>
            value.documentId === documentId
        );
        const remaining = records.filter(value =>
            value.documentId !== documentId
        );
        if ( remaining.length === 0 ) {
            await storage.remove(key);
        } else {
            await storage.set({ [key]: remaining });
        }
        return memoryRecord || storedRecord || (
            migrationFailed
                ? { documentId, committedAt: 0 }
                : null
        );
    }).catch(reason => {
        if ( memoryRecord ) { return memoryRecord; }
        if ( migrationFailed ) { return { documentId, committedAt: 0 }; }
        throw reason;
    });
};

const beginPrerenderTabMigration = (addedTabId, removedTabId) => {
    for ( const [ key, record ] of Array.from(prerenderDocumentRecords) ) {
        const prefix = `${removedTabId}|`;
        if ( key.startsWith(prefix) === false ) { continue; }
        prerenderDocumentRecords.delete(key);
        const movedKey = prerenderDocumentRecordKey(
            addedTabId,
            record.documentId
        );
        const before = prerenderDocumentRecords.get(movedKey);
        if (
            before === undefined ||
            Number(before.committedAt) < Number(record.committedAt)
        ) {
            prerenderDocumentRecords.set(movedKey, record);
        }
    }
    const oldTail = prerenderDocumentPersistenceTails.get(removedTabId) ||
        Promise.resolve();
    const newTail = prerenderDocumentPersistenceTails.get(addedTabId) ||
        Promise.resolve();
    const migration = (async () => {
        await Promise.all([
            oldTail.catch(() => {}),
            newTail.catch(() => {}),
        ]);
        const session = browser.storage?.session;
        if (
            typeof session?.get !== 'function' ||
            typeof session?.set !== 'function' ||
            typeof session?.remove !== 'function'
        ) {
            return false;
        }
        const oldKey = prerenderDocumentsSessionKey(removedTabId);
        const newKey = prerenderDocumentsSessionKey(addedTabId);
        const bin = await session.get([ oldKey, newKey ]);
        const mergedByDocument = new Map();
        for ( const value of [
            ...(Array.isArray(bin?.[newKey]) ? bin[newKey] : []),
            ...(Array.isArray(bin?.[oldKey]) ? bin[oldKey] : []),
        ] ) {
            const record = typeof value === 'string'
                ? { documentId: value, committedAt: 0 }
                : value;
            if (
                typeof record?.documentId !== 'string' ||
                record.documentId === ''
            ) { continue; }
            const before = mergedByDocument.get(record.documentId);
            if (
                before === undefined ||
                Number(before.committedAt) < Number(record.committedAt)
            ) {
                mergedByDocument.set(record.documentId, {
                    documentId: record.documentId,
                    committedAt: Math.max(0, Number(record.committedAt) || 0),
                });
            }
        }
        const merged = Array.from(mergedByDocument.values())
            .sort((a, b) => a.committedAt - b.committedAt)
            .slice(-MAX_RELOAD_NEEDED_DOCUMENTS_PER_TAB);
        if ( merged.length !== 0 ) {
            await session.set({ [newKey]: merged });
        }
        await session.remove(oldKey);
        return true;
    })();
    prerenderTabMigrationPromises.set(addedTabId, migration);
    prerenderDocumentPersistenceTails.set(addedTabId, migration);
    migration.finally(() => {
        if ( prerenderTabMigrationPromises.get(addedTabId) === migration ) {
            prerenderTabMigrationPromises.delete(addedTabId);
        }
        if ( prerenderDocumentPersistenceTails.get(addedTabId) === migration ) {
            prerenderDocumentPersistenceTails.delete(addedTabId);
        }
    }).catch(() => {});
    return migration;
};
const DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY = 'deferredRuntimeDocumentsV1';
const SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY =
    'suspendedOpenTabRuntimeRefreshV1';
const deferredRuntimeDocuments = new Map();
const deferredFrozenRuntimeTabIds = new Set();
let deferredRuntimeDocumentsHydrationPromise;
let deferredRuntimeDocumentsPersistenceTail = Promise.resolve();
const pendingTimedOutRuntimeScripts = new Map();
const pendingRuntimeScriptOperations = new Set();
let remoteCosmeticsRuntimeStats = {};
let remoteCosmeticsRuntimeStatsMutationTail = Promise.resolve();
let communityEmergencySyncState = {};
let autoBackoffAlarmWhen = 0;
let autoPromotionAlarmWhen = 0;
let lastInjectableRuntimeFingerprint = '';
let automationRuntimeRegistered = false;

const setActionBadgeTextColor = options => {
    const setter = browser.action?.setBadgeTextColor;
    if ( typeof setter !== 'function' ) { return Promise.resolve(); }
    return Promise.resolve(setter(options)).catch(() => {});
};

const setActionBadgeBackgroundColor = options => {
    const setter = browser.action?.setBadgeBackgroundColor;
    if ( typeof setter !== 'function' ) { return Promise.resolve(); }
    return Promise.resolve(setter(options)).catch(() => {});
};

const setActionBadgeText = options => {
    const setter = browser.action?.setBadgeText;
    if ( typeof setter !== 'function' ) { return Promise.resolve(); }
    return Promise.resolve(setter(options)).catch(() => {});
};

const setActionTitle = options => {
    const setter = browser.action?.setTitle;
    if ( typeof setter !== 'function' ) { return Promise.resolve(); }
    return Promise.resolve(setter(options)).catch(() => {});
};

const ensureReloadNeededTabsHydrated = () => {
    if ( reloadNeededTabsHydrationPromise instanceof Promise ) {
        return reloadNeededTabsHydrationPromise;
    }
    const hydration = (async () => {
        const storage = browser.storage?.local;
        if ( typeof storage?.get !== 'function' ) {
            throw new Error('local storage API unavailable');
        }
        const bin = await storage.get(RELOAD_NEEDED_TABS_STORAGE_KEY);
        if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
            throw new Error('invalid reload-needed local state');
        }
        const stored = bin[RELOAD_NEEDED_TABS_STORAGE_KEY];
        if ( stored === undefined ) { return true; }
        if ( stored === null || typeof stored !== 'object' || Array.isArray(stored) ) {
            await storage.remove(RELOAD_NEEDED_TABS_STORAGE_KEY);
            return true;
        }
        const storedTabs = stored.version === RELOAD_NEEDED_STORAGE_SCHEMA &&
            stored.tabs instanceof Object &&
            Array.isArray(stored.tabs) === false
            ? stored.tabs
            : stored;
        for ( const [ rawTabId, rawEntry ] of Object.entries(storedTabs) ) {
            const tabId = Number(rawTabId);
            if ( Number.isInteger(tabId) === false || tabId < 0 ) { continue; }
            const record = createReloadNeededTabRecord();
            const rawDocuments = Array.isArray(rawEntry?.documents)
                ? rawEntry.documents
                : [ rawEntry ];
            for ( const rawDocument of rawDocuments ) {
                const reason = typeof rawDocument?.reason === 'string'
                    ? rawDocument.reason.trim()
                    : '';
                const documentId = typeof rawDocument?.documentId === 'string'
                    ? rawDocument.documentId
                    : '';
                if ( reason === '' || documentId === '' ) { continue; }
                record.documents.set(documentId, {
                    reason,
                    documentId,
                    updatedAt: Math.max(0, Number(rawDocument?.updatedAt) || 0),
                    active: rawDocument?.active !== false,
                });
            }
            record.wildcardReason = typeof rawEntry?.wildcardReason === 'string'
                ? rawEntry.wildcardReason.trim()
                : '';
            record.wildcardUpdatedAt = Math.max(
                0,
                Number(rawEntry?.wildcardUpdatedAt) || 0
            );
            record.wildcardReloadHint =
                rawEntry?.wildcardReloadHint instanceof Object
                    ? structuredClone(rawEntry.wildcardReloadHint)
                    : null;
            record.wildcardAllDocuments =
                typeof rawEntry?.wildcardAllDocuments === 'boolean'
                    ? rawEntry.wildcardAllDocuments
                    : record.wildcardReason !== '' &&
                        record.wildcardReloadHint === null;
            record.revision = Math.max(0, Number(rawEntry?.revision) || 0);
            record.safeDocumentIds = new Set(
                Array.isArray(rawEntry?.safeDocumentIds)
                    ? rawEntry.safeDocumentIds.filter(value =>
                        typeof value === 'string' && value !== ''
                    )
                    : []
            );
            pruneReloadNeededTabRecord(record);
            if (
                record.documents.size !== 0 ||
                record.wildcardReason !== ''
            ) {
                reloadNeededTabs.set(tabId, record);
            }
        }
        const sessionStorage = browser.storage?.session;
        if (
            reloadNeededTabs.size !== 0 &&
            typeof sessionStorage?.get === 'function'
        ) {
            const keys = Array.from(reloadNeededTabs.keys(),
                reloadSafeDocumentsSessionKey);
            const safeBin = await sessionStorage.get(keys);
            if (
                safeBin !== null &&
                typeof safeBin === 'object' &&
                Array.isArray(safeBin) === false
            ) {
                for ( const [ tabId, record ] of reloadNeededTabs ) {
                    const storedSafe = safeBin[
                        reloadSafeDocumentsSessionKey(tabId)
                    ];
                    if (
                        storedSafe?.wildcardUpdatedAt !==
                            record.wildcardUpdatedAt ||
                        Array.isArray(storedSafe?.documentIds) === false
                    ) {
                        continue;
                    }
                    record.safeDocumentIds = new Set(
                        storedSafe.documentIds.filter(value =>
                            typeof value === 'string' && value !== ''
                        ).slice(-MAX_RELOAD_SAFE_DOCUMENTS_PER_TAB)
                    );
                }
            }
        }
        return true;
    })();
    reloadNeededTabsHydrationPromise = hydration.catch(reason => {
        reloadNeededTabsHydrationPromise = undefined;
        throw reason;
    });
    return reloadNeededTabsHydrationPromise;
};

const persistReloadNeededTabs = () => {
    const run = reloadNeededTabsPersistenceTail.catch(() => {}).then(async () => {
        await ensureReloadNeededTabsHydrated();
        const storage = browser.storage?.local;
        if ( typeof storage?.set !== 'function' || typeof storage?.remove !== 'function' ) {
            throw new Error('local storage API unavailable');
        }
        if ( reloadNeededTabs.size === 0 ) {
            await storage.remove(RELOAD_NEEDED_TABS_STORAGE_KEY);
            return true;
        }
        const serialized = { version: RELOAD_NEEDED_STORAGE_SCHEMA, tabs: {} };
        for ( const [ tabId, record ] of Array.from(reloadNeededTabs)
            .sort((a, b) => a[0] - b[0]) ) {
            pruneReloadNeededTabRecord(record);
            serialized.tabs[tabId] = {
                wildcardReason: record.wildcardReason,
                wildcardUpdatedAt: record.wildcardUpdatedAt,
                wildcardAllDocuments: record.wildcardAllDocuments,
                wildcardReloadHint: record.wildcardReloadHint,
                revision: record.revision,
                documents: Array.from(record.documents.values()).map(entry => ({
                    reason: entry.reason,
                    documentId: entry.documentId,
                    updatedAt: entry.updatedAt,
                    active: entry.active === true,
                })),
            };
        }
        await storage.set({
            [RELOAD_NEEDED_TABS_STORAGE_KEY]: serialized,
        });
        return true;
    });
    reloadNeededTabsPersistenceTail = run;
    return run;
};

const deferredRuntimeDocumentKey = entry =>
    `${entry.tabId}|${entry.topDocumentId}|${entry.operation}`;

const refreshDeferredRuntimeTabIndex = () => {
    deferredFrozenRuntimeTabIds.clear();
    for ( const entry of deferredRuntimeDocuments.values() ) {
        if ( entry.waitForUnfreeze !== true || entry.manual === true ) {
            continue;
        }
        deferredFrozenRuntimeTabIds.add(entry.tabId);
    }
};

const ensureDeferredRuntimeDocumentsHydrated = () => {
    if ( deferredRuntimeDocumentsHydrationPromise instanceof Promise ) {
        return deferredRuntimeDocumentsHydrationPromise;
    }
    const hydration = (async () => {
        const storage = browser.storage?.local;
        if ( typeof storage?.get !== 'function' ) {
            throw new Error('local storage API unavailable');
        }
        const bin = await storage.get(DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY);
        if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
            throw new Error('invalid deferred runtime local state');
        }
        const stored = bin[DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY];
        if ( stored === undefined ) { return true; }
        if ( Array.isArray(stored) === false ) {
            await storage.remove(DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY);
            return true;
        }
        for ( const rawEntry of stored ) {
            const tabId = Number(rawEntry?.tabId);
            const topDocumentId = typeof rawEntry?.topDocumentId === 'string'
                ? rawEntry.topDocumentId
                : '';
            const operation = rawEntry?.operation === 'stop'
                ? 'stop'
                : (rawEntry?.operation === 'refresh' ? 'refresh' : '');
            if (
                Number.isInteger(tabId) === false || tabId < 0 ||
                topDocumentId === '' || operation === ''
            ) {
                continue;
            }
            const entry = {
                tabId,
                topDocumentId,
                operation,
                desiredFingerprint:
                    typeof rawEntry?.desiredFingerprint === 'string'
                        ? rawEntry.desiredFingerprint
                        : '',
                updatedAt: Number(rawEntry?.updatedAt) || 0,
                failureCount: Math.max(0, Number(rawEntry?.failureCount) || 0),
                nextRetryAt: Math.max(0, Number(rawEntry?.nextRetryAt) || 0),
                waitForUnfreeze: rawEntry?.waitForUnfreeze === true,
                manual: rawEntry?.manual === true,
                promotionPending: rawEntry?.promotionPending === true,
                lastError: typeof rawEntry?.lastError === 'string'
                    ? rawEntry.lastError.slice(0, 512)
                    : '',
            };
            deferredRuntimeDocuments.set(
                deferredRuntimeDocumentKey(entry),
                entry
            );
        }
        refreshDeferredRuntimeTabIndex();
        return true;
    })();
    deferredRuntimeDocumentsHydrationPromise = hydration.catch(reason => {
        deferredRuntimeDocumentsHydrationPromise = undefined;
        throw reason;
    });
    return deferredRuntimeDocumentsHydrationPromise;
};

const persistDeferredRuntimeDocuments = () => {
    const run = deferredRuntimeDocumentsPersistenceTail
        .catch(() => {})
        .then(async () => {
            await ensureDeferredRuntimeDocumentsHydrated();
            const storage = browser.storage?.local;
            if (
                typeof storage?.set !== 'function' ||
                typeof storage?.remove !== 'function'
            ) {
                throw new Error('local storage API unavailable');
            }
            if ( deferredRuntimeDocuments.size === 0 ) {
                await storage.remove(DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY);
                return true;
            }
            const serialized = Array.from(deferredRuntimeDocuments.values())
                .sort((a, b) =>
                    a.tabId - b.tabId ||
                    a.topDocumentId.localeCompare(b.topDocumentId) ||
                    a.operation.localeCompare(b.operation)
                );
            await storage.set({
                [DEFERRED_RUNTIME_DOCUMENTS_STORAGE_KEY]: serialized,
            });
            return true;
        });
    deferredRuntimeDocumentsPersistenceTail = run;
    return run;
};

const deferRuntimeDocuments = async entries => {
    await ensureDeferredRuntimeDocumentsHydrated();
    const deferred = [];
    const committed = [];
    for ( const rawEntry of entries || [] ) {
        const tabId = Number(rawEntry?.tabId);
        const topDocumentId = typeof rawEntry?.topDocumentId === 'string'
            ? rawEntry.topDocumentId
            : '';
        const operation = rawEntry?.operation === 'stop'
            ? 'stop'
            : (rawEntry?.operation === 'refresh' ? 'refresh' : '');
        const expectedTabGeneration = Number.isInteger(
            rawEntry?.expectedTabGeneration
        ) ? rawEntry.expectedTabGeneration : undefined;
        if (
            Number.isInteger(tabId) === false || tabId < 0 ||
            topDocumentId === '' || operation === ''
        ) {
            throw new Error('invalid deferred runtime document');
        }
        if (
            runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false
        ) {
            continue;
        }
        let previousUpdatedAt = 0;
        let previousForDocument;
        for ( const [ key, entry ] of deferredRuntimeDocuments ) {
            if ( entry.tabId === tabId ) {
                previousUpdatedAt = Math.max(
                    previousUpdatedAt,
                    Number(entry.updatedAt) || 0
                );
                if (
                    entry.topDocumentId === topDocumentId &&
                    entry.operation === operation
                ) {
                    previousForDocument = entry;
                }
                deferredRuntimeDocuments.delete(key);
            }
        }
        const waitForUnfreeze = rawEntry?.waitForUnfreeze === true;
        const incrementFailure = rawEntry?.incrementFailure !== false &&
            waitForUnfreeze === false;
        const previousFailureCount = Math.max(
            0,
            Number(previousForDocument?.failureCount) || 0
        );
        const failureCount = incrementFailure
            ? previousFailureCount + 1
            : previousFailureCount;
        const promotionRequired = operation === 'refresh' &&
            failureCount >= MAX_AUTOMATIC_DEFERRED_REFRESH_FAILURES;
        const manual = previousForDocument?.manual === true;
        const promotionPending = promotionRequired && manual === false;
        const delayIndex = Math.min(
            Math.max(0, failureCount - 1),
            DEFERRED_RUNTIME_RETRY_DELAYS_MINUTES.length - 1
        );
        const entry = {
            tabId,
            topDocumentId,
            operation,
            desiredFingerprint:
                typeof rawEntry?.desiredFingerprint === 'string'
                    ? rawEntry.desiredFingerprint
                    : '',
            updatedAt: Math.max(Date.now(), previousUpdatedAt + 1),
            failureCount,
            nextRetryAt: waitForUnfreeze || manual
                ? 0
                : Date.now() + (promotionPending
                    ? DEFERRED_RUNTIME_RETRY_DELAY_MINUTES
                    : DEFERRED_RUNTIME_RETRY_DELAYS_MINUTES[delayIndex]) *
                    60 * 1000,
            waitForUnfreeze,
            manual,
            promotionPending,
            lastError: typeof rawEntry?.lastError === 'string'
                ? rawEntry.lastError.slice(0, 512)
                : (previousForDocument?.lastError || ''),
        };
        deferredRuntimeDocuments.set(deferredRuntimeDocumentKey(entry), entry);
        deferred.push({ ...entry });
        committed.push({ entry, expectedTabGeneration });
    }
    refreshDeferredRuntimeTabIndex();
    await persistDeferredRuntimeDocuments();
    let rolledBack = false;
    for ( const { entry, expectedTabGeneration } of committed ) {
        if ( runtimeTabLifecycleMatches(
            entry.tabId,
            expectedTabGeneration
        ) ) { continue; }
        const key = deferredRuntimeDocumentKey(entry);
        if ( deferredRuntimeDocuments.get(key)?.updatedAt !== entry.updatedAt ) {
            continue;
        }
        deferredRuntimeDocuments.delete(key);
        rolledBack = true;
    }
    if ( rolledBack ) {
        refreshDeferredRuntimeTabIndex();
        await persistDeferredRuntimeDocuments();
    }
    await ensureDeferredManualPromotions(deferred);
    return deferred.filter(entry => deferredRuntimeDocuments.get(
        deferredRuntimeDocumentKey(entry)
    )?.updatedAt === entry.updatedAt);
};

async function ensureDeferredManualPromotions(candidates) {
    const source = Array.isArray(candidates)
        ? candidates
        : Array.from(deferredRuntimeDocuments.values());
    let changed = false;
    for ( const candidate of source ) {
        const key = deferredRuntimeDocumentKey(candidate);
        const entry = deferredRuntimeDocuments.get(key);
        if (
            entry?.promotionPending !== true ||
            entry.operation !== 'refresh'
        ) {
            continue;
        }
        try {
            const marked = await markReloadNeededForTab(
                entry.tabId,
                DEFERRED_RUNTIME_MANUAL_RELOAD_REASON,
                entry.topDocumentId,
                { updateWildcard: false }
            );
            if ( marked === false ) { continue; }
            const current = deferredRuntimeDocuments.get(key);
            if ( current !== entry ) { continue; }
            current.manual = true;
            current.promotionPending = false;
            current.nextRetryAt = 0;
            changed = true;
        } catch (reason) {
            ubolErr(`deferred runtime manual notice/${reason}`);
        }
    }
    if ( changed ) {
        refreshDeferredRuntimeTabIndex();
        await persistDeferredRuntimeDocuments();
    }
    return changed;
}

const clearDeferredRuntimeDocuments = async ({
    tabId,
    topDocumentId = '',
    operation = '',
    expectedUpdatedAt,
} = {}) => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    await ensureDeferredRuntimeDocumentsHydrated();
    let changed = false;
    for ( const [ key, entry ] of deferredRuntimeDocuments ) {
        if ( entry.tabId !== tabId ) { continue; }
        if ( topDocumentId !== '' && entry.topDocumentId !== topDocumentId ) {
            continue;
        }
        if ( operation !== '' && entry.operation !== operation ) { continue; }
        if (
            expectedUpdatedAt !== undefined &&
            entry.updatedAt !== expectedUpdatedAt
        ) {
            continue;
        }
        deferredRuntimeDocuments.delete(key);
        changed = true;
    }
    refreshDeferredRuntimeTabIndex();
    if ( changed ) { await persistDeferredRuntimeDocuments(); }
    return changed;
};

const clearReplacedDeferredRuntimeDocuments = async (
    tabId,
    currentDocumentId
) => {
    if (
        Number.isInteger(tabId) === false || tabId < 0 ||
        typeof currentDocumentId !== 'string' || currentDocumentId === ''
    ) {
        return false;
    }
    await ensureDeferredRuntimeDocumentsHydrated();
    let changed = false;
    for ( const [ key, entry ] of deferredRuntimeDocuments ) {
        if (
            entry.tabId === tabId &&
            entry.topDocumentId !== currentDocumentId
        ) {
            deferredRuntimeDocuments.delete(key);
            changed = true;
        }
    }
    refreshDeferredRuntimeTabIndex();
    if ( changed ) { await persistDeferredRuntimeDocuments(); }
    return changed;
};

const migrateRuntimeLifecycleTabState = async (addedTabId, removedTabId) => {
    if (
        Number.isInteger(addedTabId) === false || addedTabId < 0 ||
        Number.isInteger(removedTabId) === false || removedTabId < 0 ||
        addedTabId === removedTabId
    ) {
        return false;
    }
    invalidateRuntimeTabLifecycle(removedTabId);
    invalidateRuntimeTabLifecycle(addedTabId);
    await Promise.all([
        ensureReloadNeededTabsHydrated(),
        ensureDeferredRuntimeDocumentsHydrated(),
    ]);
    await ensureDeferredManualPromotions();
    let reloadChanged = false;
    const removedRecord = reloadNeededTabs.get(removedTabId);
    if ( removedRecord ) {
        const addedRecord = reloadNeededTabs.get(addedTabId);
        if ( addedRecord === undefined ) {
            reloadNeededTabs.set(addedTabId, removedRecord);
        } else {
            for ( const [ documentId, entry ] of removedRecord.documents ) {
                const before = addedRecord.documents.get(documentId);
                if ( before === undefined || before.updatedAt < entry.updatedAt ) {
                    addedRecord.documents.set(documentId, entry);
                }
            }
            const addedHasWildcard = addedRecord.wildcardReason !== '';
            const removedHasWildcard = removedRecord.wildcardReason !== '';
            if ( addedHasWildcard === false && removedHasWildcard ) {
                addedRecord.wildcardReason = removedRecord.wildcardReason;
                addedRecord.wildcardUpdatedAt = removedRecord.wildcardUpdatedAt;
                addedRecord.wildcardAllDocuments =
                    removedRecord.wildcardAllDocuments;
                addedRecord.wildcardReloadHint =
                    removedRecord.wildcardReloadHint;
                addedRecord.safeDocumentIds = new Set(
                    removedRecord.safeDocumentIds
                );
            } else if ( addedHasWildcard && removedHasWildcard ) {
                const latest = removedRecord.wildcardUpdatedAt >
                    addedRecord.wildcardUpdatedAt
                    ? removedRecord
                    : addedRecord;
                if (
                    addedRecord.wildcardAllDocuments ||
                    removedRecord.wildcardAllDocuments
                ) {
                    const globalRecord = addedRecord.wildcardAllDocuments
                        ? addedRecord
                        : removedRecord;
                    addedRecord.wildcardReason = globalRecord.wildcardReason;
                    addedRecord.wildcardAllDocuments = true;
                    addedRecord.wildcardReloadHint = null;
                } else if (
                    addedRecord.wildcardReason ===
                        REMOTE_SCRIPTLET_RELOAD_REASON &&
                    removedRecord.wildcardReason ===
                        REMOTE_SCRIPTLET_RELOAD_REASON
                ) {
                    addedRecord.wildcardReason = REMOTE_SCRIPTLET_RELOAD_REASON;
                    addedRecord.wildcardAllDocuments = false;
                    addedRecord.wildcardReloadHint =
                        mergeRemoteScriptletReloadHints(
                            addedRecord.wildcardReloadHint,
                            removedRecord.wildcardReloadHint
                        );
                } else {
                    addedRecord.wildcardReason = latest.wildcardReason;
                    addedRecord.wildcardAllDocuments =
                        latest.wildcardAllDocuments;
                    addedRecord.wildcardReloadHint =
                        latest.wildcardReloadHint;
                }
                addedRecord.wildcardUpdatedAt = Math.max(
                    addedRecord.wildcardUpdatedAt,
                    removedRecord.wildcardUpdatedAt
                );
                // Safe evidence was scoped to one pre-merge wildcard. Clear it
                // whenever requirements are unioned or broadened.
                addedRecord.safeDocumentIds.clear();
            }
            addedRecord.revision = Math.max(
                addedRecord.revision,
                removedRecord.revision
            ) + 1;
            pruneReloadNeededTabRecord(addedRecord);
        }
        reloadNeededTabs.delete(removedTabId);
        reloadChanged = true;
    }
    let deferredChanged = false;
    for ( const [ key, entry ] of Array.from(deferredRuntimeDocuments) ) {
        if ( entry.tabId !== removedTabId ) { continue; }
        deferredRuntimeDocuments.delete(key);
        const moved = { ...entry, tabId: addedTabId };
        const movedKey = deferredRuntimeDocumentKey(moved);
        const before = deferredRuntimeDocuments.get(movedKey);
        if ( before === undefined || before.updatedAt < moved.updatedAt ) {
            deferredRuntimeDocuments.set(movedKey, moved);
        }
        deferredChanged = true;
    }
    refreshDeferredRuntimeTabIndex();
    const writes = [];
    if ( reloadChanged ) {
        writes.push(
            persistReloadNeededTabs(),
            persistReloadSafeDocumentsForTab(
                addedTabId,
                reloadNeededTabs.get(addedTabId)
            ),
            persistReloadSafeDocumentsForTab(removedTabId, undefined)
        );
    }
    if ( deferredChanged ) { writes.push(persistDeferredRuntimeDocuments()); }
    await Promise.all(writes);
    await Promise.all([
        refreshReloadNeededBadgeForTab(removedTabId),
        refreshReloadNeededBadgeForTab(addedTabId),
    ]);
    return reloadChanged || deferredChanged;
};

const pruneDurableRuntimeLifecycleState = async () => {
    await Promise.all([
        ensureReloadNeededTabsHydrated(),
        ensureDeferredRuntimeDocumentsHydrated(),
    ]);
    await ensureDeferredManualPromotions();
    if (
        reloadNeededTabs.size === 0 &&
        deferredRuntimeDocuments.size === 0
    ) {
        return [];
    }
    if ( typeof browser.tabs?.query !== 'function' ) {
        throw new Error('tab query API unavailable');
    }
    const reloadSnapshot = Array.from(reloadNeededTabs.entries()).map(
        ([ tabId, record ]) => [ tabId, record, record.revision ]
    );
    const deferredSnapshot = Array.from(deferredRuntimeDocuments.entries());
    const tabs = await browser.tabs.query({});
    const tabsById = new Map((tabs || [])
        .filter(tab => Number.isInteger(tab?.id))
        .map(tab => [ tab.id, tab ]));
    const tabIds = new Set([
        ...reloadSnapshot.map(([ tabId ]) => tabId),
        ...deferredSnapshot.map(([, entry ]) => entry.tabId),
    ]);
    const identities = new Map();
    await Promise.all(Array.from(tabIds, async tabId => {
        const tab = tabsById.get(tabId);
        if ( tab === undefined || tab.discarded === true ) {
            identities.set(tabId, { gone: true });
            return;
        }
        try {
            identities.set(
                tabId,
                await getActiveTopDocumentIdentity(tabId, tab?.url || '')
            );
        } catch (reason) {
            if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                identities.set(tabId, { unavailable: true });
                return;
            }
            throw reason;
        }
    }));
    let reloadChanged = false;
    const safeSessionRecordsChanged = [];
    for ( const [ tabId, record, expectedRevision ] of reloadSnapshot ) {
        if (
            reloadNeededTabs.get(tabId) !== record ||
            record.revision !== expectedRevision
        ) { continue; }
        const identity = identities.get(tabId);
        if ( identity?.gone === true ) {
            reloadNeededTabs.delete(tabId);
            reloadChanged = true;
            safeSessionRecordsChanged.push([ tabId, undefined ]);
            continue;
        }
        if (
            record.wildcardReason !== '' &&
            Date.now() - record.wildcardUpdatedAt > RELOAD_WILDCARD_TTL_MS
        ) {
            record.wildcardReason = '';
            record.wildcardUpdatedAt = 0;
            record.wildcardAllDocuments = false;
            record.wildcardReloadHint = null;
            record.safeDocumentIds.clear();
            record.revision += 1;
            reloadChanged = true;
            safeSessionRecordsChanged.push([ tabId, record ]);
        }
        if (
            record.wildcardReason === '' &&
            record.documents.size === 0
        ) {
            reloadNeededTabs.delete(tabId);
            continue;
        }
        if ( identity === null || identity?.unavailable === true ) { continue; }
        let recordChanged = false;
        const activeDocumentId = identity?.documentId || '';
        const wildcardApplies = record.wildcardReason !== '' && (
            record.wildcardAllDocuments ||
            record.wildcardReloadHint === null ||
            shouldReloadForFrameUrls(
                Array.isArray(identity?.frameUrls)
                    ? identity.frameUrls
                    : [ identity?.url || '' ],
                record.wildcardReloadHint
            )
        );
        for ( const entry of record.documents.values() ) {
            const active = entry.documentId === activeDocumentId;
            if ( entry.active !== active ) {
                entry.active = active;
                recordChanged = true;
            }
        }
        if (
            activeDocumentId !== '' &&
            record.wildcardReason !== '' &&
            wildcardApplies &&
            record.documents.has(activeDocumentId) === false &&
            record.safeDocumentIds.has(activeDocumentId) === false
        ) {
            record.documents.set(activeDocumentId, {
                reason: record.wildcardReason,
                documentId: activeDocumentId,
                updatedAt: Math.max(Date.now(), record.wildcardUpdatedAt),
                active: true,
            });
            pruneReloadNeededTabRecord(record);
            recordChanged = true;
        } else if (
            activeDocumentId !== '' &&
            record.wildcardReason !== '' &&
            wildcardApplies === false &&
            record.safeDocumentIds.has(activeDocumentId) === false
        ) {
            // Session-safe evidence is intentionally separate from the local
            // BFCache wildcard. Rebuild it after a browser restart without
            // turning a host-scoped scriptlet hint into a reload notice on an
            // unrelated active page.
            record.safeDocumentIds.add(activeDocumentId);
            safeSessionRecordsChanged.push([ tabId, record ]);
        }
        if ( recordChanged ) {
            record.revision += 1;
            reloadChanged = true;
        }
    }
    let deferredChanged = false;
    for ( const [ key, entry ] of deferredSnapshot ) {
        if ( deferredRuntimeDocuments.get(key) !== entry ) { continue; }
        const identity = identities.get(entry.tabId);
        if ( identity === null || identity?.unavailable === true ) { continue; }
        if (
            identity?.gone === true ||
            identity?.documentId !== entry.topDocumentId
        ) {
            deferredRuntimeDocuments.delete(key);
            deferredChanged = true;
        }
    }
    refreshDeferredRuntimeTabIndex();
    if ( reloadChanged ) { await persistReloadNeededTabs(); }
    if ( safeSessionRecordsChanged.length !== 0 ) {
        await Promise.all(safeSessionRecordsChanged.map(([ tabId, record ]) =>
            persistReloadSafeDocumentsForTab(tabId, record)
        ));
    }
    if ( deferredChanged ) { await persistDeferredRuntimeDocuments(); }
    const activeDeferredTabIds = [];
    const now = Date.now();
    for ( const entry of deferredRuntimeDocuments.values() ) {
        if ( tabsById.get(entry.tabId)?.frozen === true ) { continue; }
        if ( entry.manual === true || entry.waitForUnfreeze === true ) { continue; }
        if ( Math.max(0, Number(entry.nextRetryAt) || 0) > now ) { continue; }
        activeDeferredTabIds.push(entry.tabId);
    }
    return Array.from(new Set(activeDeferredTabIds));
};

const getReloadNeededState = tabId => {
    const record = reloadNeededTabs.get(tabId);
    const entry = record instanceof Object
        ? Array.from(record.documents.values()).find(
            value => value.active === true
        )
        : undefined;
    if ( entry instanceof Object === false ) {
        return { reason: '' };
    }
    return {
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        documentId: typeof entry.documentId === 'string'
            ? entry.documentId
            : '',
        updatedAt: Number(entry.updatedAt) || 0,
    };
};

const readPopupPanelData = async ({
    tabId = -1,
    hostname = '',
} = {}) => {
    await ensureReloadNeededTabsHydrated();
    const sanitizedHostname = sanitizeModeHostname(hostname);
    const [
        defaultMode,
        storedStatus,
        storedEntitlement,
        hasOmnipotence,
        disabledFeatures,
    ] = await Promise.all([
        getDefaultFilteringMode().catch(() => MODE_OPTIMAL),
        getEntitlementStatusFromStorage().catch(() => entitlementStatus),
        readEntitlement().catch(() => ({})),
        hasBroadHostPermissions().catch(() => false),
        adminReadEx('disabledFeatures').catch(() => []),
    ]);
    const reloadNeededState =
        Number.isInteger(tabId) && tabId >= 0
            ? getReloadNeededState(tabId)
            : { reason: '' };
    const baseStatus = storedStatus instanceof Object
        ? storedStatus
        : (entitlementStatus instanceof Object ? entitlementStatus : { status: 'error' });
    const level = sanitizedHostname !== ''
        ? await getFilteringMode(sanitizedHostname).catch(() => defaultMode)
        : defaultMode;
    const hasCustomFiltersForHost = sanitizedHostname !== ''
        ? await hasCustomFilters(sanitizedHostname).catch(() => 0)
        : 0;
    return {
        defaultFilteringMode: Number.isInteger(defaultMode) ? defaultMode : MODE_OPTIMAL,
        hasOmnipotence,
        level,
        autoReload: rulesetConfig.autoReload,
        isSideloaded,
        developerMode: rulesetConfig.developerMode,
        disabledFeatures: Array.isArray(disabledFeatures) ? disabledFeatures : [],
        hasCustomFilters: hasCustomFiltersForHost,
        entitlementStatus: Object.assign({}, baseStatus, {
            lastError: typeof storedEntitlement.lastError === 'string' ? storedEntitlement.lastError : '',
            lastErrorCode: typeof storedEntitlement.lastErrorCode === 'string' ? storedEntitlement.lastErrorCode : '',
            lastErrorMessage: typeof storedEntitlement.lastErrorMessage === 'string' ? storedEntitlement.lastErrorMessage : '',
            lastErrorAction: typeof storedEntitlement.lastErrorAction === 'string' ? storedEntitlement.lastErrorAction : '',
        }),
        reloadNeededState,
        compatibilityMode: getActiveCompatibilityModeForHostname(sanitizedHostname),
    };
};

const refreshReloadNeededBadgeForTab = async (
    tabId,
    expectedTabGeneration
) => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return false;
    }
    if ( paywallActive ) { return false; }
    const state = getReloadNeededState(tabId);
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return false;
    }
    if ( state.reason === '' ) {
        await Promise.all([
            setActionBadgeText({ tabId, text: '' }),
            setActionTitle({ tabId, title: DEFAULT_ACTION_TITLE }),
        ]);
        return false;
    }
    await Promise.all([
        setActionBadgeBackgroundColor({ tabId, color: HOTFIX_RELOAD_BADGE_COLOR }),
        setActionBadgeTextColor({ tabId, color: '#111827' }),
        setActionBadgeText({ tabId, text: '!' }),
        setActionTitle({
            tabId,
            title: state.reason === REMOTE_SCRIPTLET_RELOAD_REASON
                ? HOTFIX_RELOAD_ACTION_TITLE
                : RUNTIME_RELOAD_ACTION_TITLE,
        }),
    ]);
    return true;
};

const refreshReloadNeededBadges = async () => {
    if ( paywallActive ) { return false; }
    const jobs = [];
    for ( const tabId of reloadNeededTabs.keys() ) {
        jobs.push(refreshReloadNeededBadgeForTab(tabId));
    }
    await Promise.all(jobs);
    return jobs.length !== 0;
};

async function getActiveTopDocumentIdentity(tabId, fallbackUrl = '') {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return null; }
    const getAllFrames = browser.webNavigation?.getAllFrames;
    if ( typeof getAllFrames !== 'function' ) {
        throw new Error('top-document enumeration unavailable');
    }
    const frames = await getAllFrames({ tabId });
    if ( Array.isArray(frames) === false ) {
        throw new Error('invalid top-document enumeration response');
    }
    const top = frames.find(frame =>
        frame?.frameId === 0 &&
        typeof frame?.documentId === 'string' &&
        frame.documentId !== '' &&
        (
            typeof frame?.documentLifecycle !== 'string' ||
            frame.documentLifecycle === 'active'
        )
    );
    if ( top === undefined ) { return null; }
    return {
        tabId,
        documentId: top.documentId,
        url: typeof top.url === 'string' && top.url !== ''
            ? top.url
            : fallbackUrl,
        frameUrls: Array.from(new Set(frames
            .map(frame => typeof frame?.url === 'string' ? frame.url : '')
            .filter(url => /^https?:/i.test(url)))),
    };
}

const clearReloadNeededStateForTab = async (
    tabId,
    {
        currentDocumentId = '',
        currentUrl = '',
        transitionType = '',
        forwardBack = false,
        outermostPrerender = false,
        prerenderCommittedAt = 0,
    } = {}
) => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    await ensureReloadNeededTabsHydrated();
    if ( currentDocumentId === '' ) {
        const deleted = reloadNeededTabs.delete(tabId);
        if ( deleted ) {
            await Promise.all([
                persistReloadNeededTabs(),
                persistReloadSafeDocumentsForTab(tabId, undefined),
            ]);
        }
        await refreshReloadNeededBadgeForTab(tabId);
        return deleted;
    }
    const record = reloadNeededTabs.get(tabId);
    if ( record === undefined ) {
        await refreshReloadNeededBadgeForTab(tabId);
        return false;
    }
    let changed = false;
    let durableChanged = false;
    let safeDocumentsChanged = false;
    if ( transitionType === 'reload' ) {
        for ( const [ documentId, entry ] of record.documents ) {
            if ( entry.active !== true ) { continue; }
            record.documents.delete(documentId);
            changed = true;
            durableChanged = true;
        }
    }
    for ( const entry of record.documents.values() ) {
        const active = entry.documentId === currentDocumentId;
        if ( entry.active !== active ) {
            entry.active = active;
            changed = true;
            if ( forwardBack || outermostPrerender || transitionType === 'reload' ) {
                durableChanged = true;
            }
        }
    }
    if ( record.wildcardReason !== '' ) {
        const existing = record.documents.get(currentDocumentId);
        const wildcardApplies = record.wildcardAllDocuments ||
            record.wildcardReloadHint === null ||
            shouldReloadForFrameUrls(
                [ typeof currentUrl === 'string' ? currentUrl : '' ],
                record.wildcardReloadHint
            );
        const stalePrerender = outermostPrerender && (
            Math.max(0, Number(prerenderCommittedAt) || 0) === 0 ||
            prerenderCommittedAt <= record.wildcardUpdatedAt
        );
        const mustReload = existing !== undefined ||
            ((forwardBack || stalePrerender) &&
                wildcardApplies &&
                record.safeDocumentIds.has(currentDocumentId) === false);
        if (
            mustReload &&
            existing === undefined &&
            record.safeDocumentIds.has(currentDocumentId) === false
        ) {
            record.documents.set(currentDocumentId, {
                reason: record.wildcardReason,
                documentId: currentDocumentId,
                updatedAt: Math.max(Date.now(), record.wildcardUpdatedAt),
                active: true,
            });
            changed = true;
            durableChanged = true;
        } else if ( mustReload === false ) {
            if ( record.safeDocumentIds.has(currentDocumentId) === false ) {
                record.safeDocumentIds.add(currentDocumentId);
                changed = true;
                safeDocumentsChanged = true;
            }
        }
    }
    pruneReloadNeededTabRecord(record);
    if ( durableChanged ) { record.revision += 1; }
    if (
        record.documents.size === 0 &&
        record.wildcardReason === ''
    ) {
        reloadNeededTabs.delete(tabId);
        changed = true;
        durableChanged = true;
        safeDocumentsChanged = true;
    }
    const writes = [];
    if ( durableChanged ) { writes.push(persistReloadNeededTabs()); }
    if ( safeDocumentsChanged ) {
        writes.push(persistReloadSafeDocumentsForTab(
            tabId,
            reloadNeededTabs.get(tabId)
        ));
    }
    if ( writes.length !== 0 ) { await Promise.all(writes); }
    await refreshReloadNeededBadgeForTab(tabId);
    return changed;
};

const markReloadNeededForTab = async (
    tabId,
    reason,
    documentId = '',
    {
        persist = true,
        updateBadge = true,
        updateWildcard = true,
    } = {}
) => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const tabGeneration = getRuntimeTabLifecycleGeneration(tabId);
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if ( normalizedReason === '' ) { return false; }
    await ensureReloadNeededTabsHydrated();
    let normalizedDocumentId = typeof documentId === 'string'
        ? documentId
        : '';
    if ( normalizedDocumentId === '' ) { return false; }
    const identity = await getActiveTopDocumentIdentity(tabId).catch(reason => {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return null; }
        throw reason;
    });
    if (
        normalizedDocumentId === '' ||
        identity?.documentId !== normalizedDocumentId ||
        runtimeTabLifecycleMatches(tabId, tabGeneration) === false
    ) {
        return false;
    }
    const record = getOrCreateReloadNeededTabRecord(tabId);
    const previousUpdatedAt = Math.max(
        Number(record.documents.get(normalizedDocumentId)?.updatedAt) || 0,
        Number(record.wildcardUpdatedAt) || 0
    );
    const entry = {
        reason: normalizedReason,
        documentId: normalizedDocumentId,
        updatedAt: Math.max(Date.now(), previousUpdatedAt + 1),
        active: true,
    };
    for ( const existing of record.documents.values() ) {
        existing.active = false;
    }
    record.documents.set(normalizedDocumentId, entry);
    if ( updateWildcard ) {
        record.wildcardReason = normalizedReason;
        record.wildcardUpdatedAt = entry.updatedAt;
        record.wildcardAllDocuments = true;
        record.wildcardReloadHint = null;
        record.safeDocumentIds.clear();
    }
    record.revision += 1;
    pruneReloadNeededTabRecord(record);
    if ( persist ) {
        const writes = [ persistReloadNeededTabs() ];
        if ( updateWildcard ) {
            writes.push(persistReloadSafeDocumentsForTab(tabId, record));
        }
        await Promise.all(writes);
    }
    if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
        // The marked document can now be dormant in BFCache, while the
        // navigation handler may already have added safe/current-document
        // evidence to this same record. The exact marker and wildcard are
        // durable at this point; deleting the shared record would erase both
        // the dormant-document requirement and the newer navigation state.
        // Skip only the stale badge update and let lifecycle cleanup classify
        // the new active document.
        return true;
    }
    if ( updateBadge ) {
        await refreshReloadNeededBadgeForTab(tabId, tabGeneration);
    }
    return true;
};

const markReloadNeededWildcardForTabs = async (
    tabIds,
    reason,
    { allDocuments = true, reloadHint = null, refresh = false } = {}
) => {
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if ( normalizedReason === '' ) { return false; }
    await ensureReloadNeededTabsHydrated();
    let changed = false;
    const safeRecordsChanged = [];
    const now = Date.now();
    const normalizedReloadHint = reloadHint instanceof Object
        ? structuredClone(reloadHint)
        : null;
    for ( const tabId of new Set(tabIds) ) {
        if ( Number.isInteger(tabId) === false || tabId < 0 ) { continue; }
        const record = getOrCreateReloadNeededTabRecord(tabId);
        if ( record.wildcardAllDocuments && allDocuments === false ) {
            continue;
        }
        const effectiveReloadHint =
            allDocuments === false &&
            normalizedReason === REMOTE_SCRIPTLET_RELOAD_REASON &&
            record.wildcardReason === REMOTE_SCRIPTLET_RELOAD_REASON &&
            record.wildcardAllDocuments === false
                ? mergeRemoteScriptletReloadHints(
                    record.wildcardReloadHint,
                    normalizedReloadHint
                )
                : normalizedReloadHint;
        const sameWildcard =
            record.wildcardReason === normalizedReason &&
            record.wildcardAllDocuments === (allDocuments === true) &&
            JSON.stringify(record.wildcardReloadHint) ===
                JSON.stringify(effectiveReloadHint);
        if ( sameWildcard && refresh === false ) { continue; }
        const updatedAt = Math.max(now, record.wildcardUpdatedAt + 1);
        record.wildcardReason = normalizedReason;
        record.wildcardUpdatedAt = updatedAt;
        record.wildcardAllDocuments = allDocuments === true;
        record.wildcardReloadHint = allDocuments
            ? null
            : effectiveReloadHint;
        record.safeDocumentIds.clear();
        for ( const entry of record.documents.values() ) {
            entry.reason = normalizedReason;
            entry.updatedAt = Math.max(entry.updatedAt, updatedAt);
        }
        record.revision += 1;
        safeRecordsChanged.push([ tabId, record ]);
        changed = true;
    }
    if ( changed ) {
        await persistReloadNeededTabs();
        await Promise.all(safeRecordsChanged.map(([ tabId, record ]) =>
            persistReloadSafeDocumentsForTab(tabId, record)
        ));
    }
    return changed;
};

const getTabFrameSnapshot = async (tabId, fallbackUrl = '') => {
    const urls = new Set();
    let topDocumentId = '';
    if ( typeof fallbackUrl === 'string' && fallbackUrl !== '' ) {
        urls.add(fallbackUrl);
    }
    const getAllFrames = browser.webNavigation?.getAllFrames;
    if ( typeof getAllFrames !== 'function' ) {
        return { urls: Array.from(urls), topDocumentId };
    }
    try {
        const frames = await getAllFrames({ tabId });
        for ( const frame of frames || [] ) {
            if ( typeof frame?.url !== 'string' || frame.url === '' ) { continue; }
            urls.add(frame.url);
            if (
                frame?.frameId === 0 &&
                typeof frame?.documentId === 'string' &&
                frame.documentId !== '' &&
                (
                    typeof frame?.documentLifecycle !== 'string' ||
                    frame.documentLifecycle === 'active'
                )
            ) {
                topDocumentId = frame.documentId;
            }
        }
    } catch (reason) {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
            return { urls: [], topDocumentId: '' };
        }
        throw new Error(`reloadNeeded/getAllFrames/${reason}`);
    }
    return { urls: Array.from(urls), topDocumentId };
};

const listTabFrameUrls = async (tabId, fallbackUrl = '') =>
    (await getTabFrameSnapshot(tabId, fallbackUrl)).urls;

const tabMatchesHostnameSet = async (
    tabId,
    {
        fallbackUrl = '',
        hostname = '',
        hostnames = new Set(),
    } = {}
) => {
    if ( hostnames instanceof Set === false || hostnames.size === 0 ) {
        return false;
    }
    if ( hostname !== '' && hostnames.has(hostname) ) {
        return true;
    }
    const frameUrls = await listTabFrameUrls(tabId, fallbackUrl);
    return frameUrls.some(url => hostnames.has(normalizeHttpHostname(url)));
};

const collectStoredRemoteCosmeticHostnames = cosmetics => {
    const out = new Set();
    if ( cosmetics?.hosts instanceof Object === false ) { return out; }
    for ( const [ pattern, selectors ] of Object.entries(cosmetics.hosts) ) {
        if ( Array.isArray(selectors) === false || selectors.length === 0 ) { continue; }
        const normalized = `${pattern || ''}`.trim().toLowerCase();
        if ( normalized.startsWith('=') === false ) { continue; }
        const hostname = normalized.slice(1);
        if ( hostname === '' ) { continue; }
        out.add(hostname);
    }
    return out;
};

const markTabsForRemoteScriptletReload = async (
    reloadHint,
    { refreshWildcard = false } = {}
) => {
    if ( reloadHint instanceof Object === false || browser.tabs?.query === undefined ) {
        return [];
    }
    let tabs = [];
    try {
        tabs = await browser.tabs.query({});
    } catch (reason) {
        throw new Error(`reloadNeeded/queryTabs/${reason}`);
    }
    const liveTabs = (tabs || []).filter(tab =>
        tab?.discarded !== true && Number.isInteger(tab?.id)
    );
    // Seed every live tab before enumerating active frames. A matching page can
    // be dormant in BFCache and therefore absent from getAllFrames(). The hint
    // is evaluated against its URL only when that document becomes active.
    await markReloadNeededWildcardForTabs(
        liveTabs.map(tab => tab.id),
        REMOTE_SCRIPTLET_RELOAD_REASON,
        {
            allDocuments: false,
            reloadHint,
            refresh: refreshWildcard,
        }
    );
    const candidates = (await Promise.all(liveTabs.map(async tab => {
        const tabId = Number.isInteger(tab?.id) ? tab.id : -1;
        if ( tabId < 0 ) { return null; }
        const frameSnapshot = await getTabFrameSnapshot(tabId, tab?.url || '');
        if ( shouldReloadForFrameUrls(frameSnapshot.urls, reloadHint) === false ) {
            return null;
        }
        return { tabId, topDocumentId: frameSnapshot.topDocumentId };
    }))).filter(entry => entry !== null);
    const markedTabIds = [];
    const unresolvedTabIds = [];
    await Promise.all(candidates.map(async candidate => {
        if ( candidate.topDocumentId === '' ) {
            const currentTab = await browser.tabs.get(candidate.tabId).catch(() => null);
            if (
                currentTab &&
                shouldReloadForFrameUrls([ currentTab.url || '' ], reloadHint)
            ) {
                unresolvedTabIds.push(candidate.tabId);
            }
            return;
        }
        const marked = await markReloadNeededForTab(
            candidate.tabId,
            REMOTE_SCRIPTLET_RELOAD_REASON,
            candidate.topDocumentId,
            {
                persist: false,
                updateBadge: false,
                updateWildcard: false,
            }
        );
        if ( marked ) {
            markedTabIds.push(candidate.tabId);
            return;
        }
        const current = await getTabFrameSnapshot(candidate.tabId);
        if (
            current.topDocumentId !== '' &&
            shouldReloadForFrameUrls(current.urls, reloadHint) &&
            await markReloadNeededForTab(
            candidate.tabId,
            REMOTE_SCRIPTLET_RELOAD_REASON,
            current.topDocumentId,
            {
                persist: false,
                updateBadge: false,
                updateWildcard: false,
            }
        )
        ) {
            markedTabIds.push(candidate.tabId);
        } else {
            const currentTab = await browser.tabs.get(candidate.tabId).catch(() => null);
            if (
                currentTab &&
                shouldReloadForFrameUrls([ currentTab.url || '' ], reloadHint)
            ) {
                unresolvedTabIds.push(candidate.tabId);
            }
        }
    }));
    if ( markedTabIds.length !== 0 ) {
        await persistReloadNeededTabs();
        await Promise.all(markedTabIds.map(refreshReloadNeededBadgeForTab));
    }
    if ( unresolvedTabIds.length !== 0 ) {
        throw new Error(
            `reloadNeeded/unresolvedRemoteTabs/${unresolvedTabIds.join(',')}`
        );
    }
    return markedTabIds;
};

const markOpenTabsForSandboxUserScriptReload = async () => {
    if ( browser.tabs?.query === undefined ) { return []; }
    let tabs;
    try {
        tabs = await browser.tabs.query({});
    } catch (reason) {
        throw new Error(`sandboxReloadNeeded/queryTabs/${reason}`);
    }
    const fileSchemeAccessAllowed = (tabs || []).some(
        tab => /^file:/i.test(tab?.url || '')
    ) ? await isFileSchemeAccessAllowed() : false;
    const liveTabs = (tabs || []).filter(tab =>
        tab?.discarded !== true &&
        Number.isInteger(tab?.id)
    );
    const candidates = liveTabs.filter(tab =>
        tabUrlMayHostExtensionRuntime(
            tab?.url || '',
            fileSchemeAccessAllowed
        )
    ).sort((a, b) => Number(b?.active === true) - Number(a?.active === true));
    await markReloadNeededWildcardForTabs(
        liveTabs.map(tab => tab.id),
        SANDBOX_USER_SCRIPT_RELOAD_REASON,
        { allDocuments: true }
    );
    const markedTabIds = [];
    const unresolvedTabIds = [];
    let nextIndex = 0;
    const markNext = async () => {
        while ( nextIndex < candidates.length ) {
            const tab = candidates[nextIndex++];
            const frameSnapshot = await getTabFrameSnapshot(
                tab.id,
                tab?.url || ''
            );
            if ( frameSnapshot.topDocumentId === '' ) {
                const currentTab = await browser.tabs.get(tab.id).catch(() => null);
                if (
                    currentTab &&
                    tabUrlMayHostExtensionRuntime(
                        currentTab.url || '',
                        fileSchemeAccessAllowed
                    )
                ) {
                    unresolvedTabIds.push(tab.id);
                }
                continue;
            }
            const marked = await markReloadNeededForTab(
                tab.id,
                SANDBOX_USER_SCRIPT_RELOAD_REASON,
                frameSnapshot.topDocumentId,
                {
                    persist: false,
                    updateBadge: false,
                    updateWildcard: false,
                }
            );
            if ( marked ) {
                markedTabIds.push(tab.id);
                continue;
            }
            const current = await getTabFrameSnapshot(tab.id, tab?.url || '');
            if ( current.topDocumentId !== '' && await markReloadNeededForTab(
                tab.id,
                SANDBOX_USER_SCRIPT_RELOAD_REASON,
                current.topDocumentId,
                {
                    persist: false,
                    updateBadge: false,
                    updateWildcard: false,
                }
            ) ) {
                markedTabIds.push(tab.id);
            } else {
                const currentTab = await browser.tabs.get(tab.id).catch(() => null);
                if (
                    currentTab &&
                    tabUrlMayHostExtensionRuntime(
                        currentTab.url || '',
                        fileSchemeAccessAllowed
                    )
                ) {
                    unresolvedTabIds.push(tab.id);
                }
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        candidates.length
    );
    await Promise.all(Array.from({ length: workerCount }, markNext));
    if ( markedTabIds.length !== 0 ) {
        await persistReloadNeededTabs();
        await Promise.all(markedTabIds.map(refreshReloadNeededBadgeForTab));
    }
    if ( unresolvedTabIds.length !== 0 ) {
        throw new Error(
            `sandboxReloadNeeded/unresolvedTabs/${unresolvedTabIds.join(',')}`
        );
    }
    return markedTabIds;
};

const serializeAutoBackoffState = () => {
    const out = {};
    for (const [hostname, entry] of autoBackoffState) {
        out[hostname] = entry;
    }
    return out;
};

const serializeAutoBackoffEvidence = () => {
    const out = {};
    for (const [hostname, entry] of autoBackoffEvidence) {
        out[hostname] = entry;
    }
    return out;
};

const serializeAutoBackoffSubsystemState = ({ activeOnly = false } = {}) => {
    const now = Date.now();
    const out = {};
    for ( const [hostname, subsystems] of autoBackoffSubsystemState ) {
        if ( subsystems instanceof Map === false || subsystems.size === 0 ) { continue; }
        const serialized = {};
        for ( const [subsystemId, entry] of subsystems ) {
            const expiresAt = Number(entry?.expiresAt) || 0;
            if ( activeOnly && expiresAt <= now ) { continue; }
            serialized[subsystemId] = { expiresAt };
        }
        if ( Object.keys(serialized).length === 0 ) { continue; }
        out[hostname] = serialized;
    }
    return out;
};

const storedRemoteCosmeticsHaveGlobalSelectors = cosmetics => {
    if ( Array.isArray(cosmetics?.all) && cosmetics.all.length !== 0 ) {
        return true;
    }
    if ( cosmetics?.hosts instanceof Object === false ) { return false; }
    for ( const [ pattern, selectors ] of Object.entries(cosmetics.hosts) ) {
        if ( Array.isArray(selectors) === false || selectors.length === 0 ) { continue; }
        if ( `${pattern || ''}`.trim().startsWith('=') === false ) { return true; }
    }
    return false;
};

const getActiveCompatibilityModeForHostname = hostname => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) { return { active: false }; }
    const now = Date.now();
    const hostBackoff = autoBackoffState.get(normalizedHostname);
    const activeHostBackoff = Number(hostBackoff?.expiresAt) > now
        ? {
            previousLevel: Number(hostBackoff.previousLevel) || MODE_NONE,
            downgradedLevel: Number(hostBackoff.downgradedLevel) || MODE_NONE,
            expiresAt: Number(hostBackoff.expiresAt) || 0,
        }
        : null;
    const subsystemBackoffs = {};
    const subsystemMap = autoBackoffSubsystemState.get(normalizedHostname);
    if ( subsystemMap instanceof Map ) {
        for ( const [subsystemId, entry] of subsystemMap ) {
            const expiresAt = Number(entry?.expiresAt) || 0;
            if ( expiresAt <= now ) { continue; }
            subsystemBackoffs[subsystemId] = { expiresAt };
        }
    }
    const activeExpiresAt = [
        activeHostBackoff?.expiresAt,
        ...Object.values(subsystemBackoffs).map(entry => entry.expiresAt),
    ].filter(value => Number(value) > now);
    return {
        active: activeHostBackoff !== null || Object.keys(subsystemBackoffs).length !== 0,
        hostname: normalizedHostname,
        hostBackoff: activeHostBackoff,
        subsystemBackoffs,
        expiresAt: activeExpiresAt.length === 0 ? 0 : Math.max(...activeExpiresAt),
    };
};

const serializeAutoPromotionState = () => {
    const serializePromotionMap = map => {
        const out = {};
        for ( const [hostname, entry] of map ) {
            const lastHitAt = Number(entry?.lastHitAt) || 0;
            if ( lastHitAt <= 0 ) { continue; }
            out[hostname] = { lastHitAt };
        }
        return out;
    };
    return {
        complete: serializePromotionMap(autoPromotionState.complete),
    };
};

const createEmptyAutoPromotionState = () => ({
    complete: new Map(),
});

const scheduleAutoBackoffAlarm = async () => {
    if (browser?.alarms?.create === undefined) { return; }
    let nextExpiry = Infinity;
    for (const entry of autoBackoffState.values()) {
        const expiresAt = Number(entry?.expiresAt) || 0;
        if (expiresAt > 0 && expiresAt < nextExpiry) {
            nextExpiry = expiresAt;
        }
    }
    for ( const subsystems of autoBackoffSubsystemState.values() ) {
        if ( subsystems instanceof Map === false ) { continue; }
        for ( const entry of subsystems.values() ) {
            const expiresAt = Number(entry?.expiresAt) || 0;
            if ( expiresAt > 0 && expiresAt < nextExpiry ) {
                nextExpiry = expiresAt;
            }
        }
    }
    if (Number.isFinite(nextExpiry) === false) {
        await browser.alarms?.clear?.(AUTO_BACKOFF_ALARM);
        autoBackoffAlarmWhen = 0;
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
    if ( when === autoBackoffAlarmWhen ) { return; }
    await browser.alarms.create(AUTO_BACKOFF_ALARM, { when });
    autoBackoffAlarmWhen = when;
};

const scheduleAutoPromotionAlarm = async () => {
    if ( browser?.alarms?.create === undefined ) { return; }
    let nextExpiry = Infinity;
    for ( const entry of autoPromotionState.complete.values() ) {
        const lastHitAt = Number(entry?.lastHitAt) || 0;
        if ( lastHitAt <= 0 ) { continue; }
        const expiresAt = lastHitAt + AUTO_PROMOTION_TTL_MS;
        if ( expiresAt < nextExpiry ) {
            nextExpiry = expiresAt;
        }
    }
    if ( Number.isFinite(nextExpiry) === false ) {
        await browser.alarms?.clear?.(AUTO_PROMOTION_ALARM);
        autoPromotionAlarmWhen = 0;
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
    if ( when === autoPromotionAlarmWhen ) { return; }
    await browser.alarms.create(AUTO_PROMOTION_ALARM, { when });
    autoPromotionAlarmWhen = when;
};

const persistAutoBackoffState = async () => {
    if (autoBackoffState.size === 0) {
        await localRemove(AUTO_BACKOFF_STORAGE_KEY);
        return;
    }
    await localWrite(AUTO_BACKOFF_STORAGE_KEY, serializeAutoBackoffState());
};

const persistAutoBackoffEvidence = async () => {
    if (autoBackoffEvidence.size === 0) {
        await localRemove(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY);
        return;
    }
    await localWrite(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY, serializeAutoBackoffEvidence());
};

const persistAutoBackoffSubsystemState = async () => {
    const serialized = serializeAutoBackoffSubsystemState();
    if ( Object.keys(serialized).length === 0 ) {
        autoBackoffSubsystemState = new Map();
        await localRemove(AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY);
        return;
    }
    await localWrite(AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY, serialized);
};

const persistAutoPromotionState = async () => {
    const serialized = serializeAutoPromotionState();
    const hasComplete = Object.keys(serialized.complete).length !== 0;
    if ( hasComplete === false ) {
        await Promise.all([
            localRemove(AUTO_PROMOTION_STATE_KEY),
            localRemove(AUTO_GENERIC_HIGH_KEY),
        ]);
        return;
    }
    await Promise.all([
        localWrite(AUTO_PROMOTION_STATE_KEY, serialized),
        localRemove(AUTO_GENERIC_HIGH_KEY),
    ]);
};

const persistRemoteCosmeticsRuntimeStats = async () => {
    const entries = Object.entries(remoteCosmeticsRuntimeStats || {});
    if ( entries.length === 0 ) {
        await localRemove(REMOTE_COSMETICS_RUNTIME_STATS_KEY);
        return;
    }
    await localWrite(REMOTE_COSMETICS_RUNTIME_STATS_KEY, remoteCosmeticsRuntimeStats);
};

const persistCommunityEmergencySyncState = async () => {
    communityEmergencySyncState = normalizeCommunityEmergencySyncState(
        communityEmergencySyncState
    );
    if ( Object.keys(communityEmergencySyncState).length === 0 ) {
        await localRemove(COMMUNITY_EMERGENCY_SYNC_STATE_KEY);
        return;
    }
    await localWrite(COMMUNITY_EMERGENCY_SYNC_STATE_KEY, communityEmergencySyncState);
};

const loadAutoBackoffState = async () => {
    const stored = await readLocalStrict(AUTO_BACKOFF_STORAGE_KEY);
    autoBackoffState = new Map();
    if (stored instanceof Object) {
        for (const [hostname, entry] of Object.entries(stored)) {
            if (typeof hostname !== 'string' || hostname.trim() === '') { continue; }
            if (entry instanceof Object === false) { continue; }
            const expiresAt = Number(entry.expiresAt) || 0;
            const previousLevel = Number(entry.previousLevel);
            const downgradedLevel = Number(entry.downgradedLevel);
            if (Number.isFinite(previousLevel) === false ||
                Number.isFinite(downgradedLevel) === false ||
                Number.isFinite(expiresAt) === false) {
                continue;
            }
            autoBackoffState.set(hostname, {
                previousLevel,
                downgradedLevel,
                expiresAt,
            });
        }
    }
    await scheduleAutoBackoffAlarm();
};

const loadAutoBackoffEvidence = async () => {
    const stored = await readLocalStrict(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY);
    autoBackoffEvidence = new Map();
    if (stored instanceof Object === false) { return; }
    for (const [hostname, entry] of Object.entries(stored)) {
        if (typeof hostname !== 'string' || hostname.trim() === '') { continue; }
        if (entry instanceof Object === false) { continue; }
        autoBackoffEvidence.set(hostname, {
            counts: entry.counts instanceof Object ? { ...entry.counts } : {},
            recent: Array.isArray(entry.recent) ? entry.recent.slice(0, 10) : [],
            lastSignalAt: Number(entry.lastSignalAt) || 0,
        });
    }
};

const loadAutoBackoffSubsystemState = async () => {
    const stored = await readLocalStrict(AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY);
    autoBackoffSubsystemState = new Map();
    if ( stored instanceof Object === false ) { return; }
    for ( const [hostname, subsystems] of Object.entries(stored) ) {
        if ( typeof hostname !== 'string' || hostname.trim() === '' ) { continue; }
        if ( subsystems instanceof Object === false ) { continue; }
        const normalizedHostname = hostname.trim().toLowerCase();
        const hostMap = new Map();
        for ( const subsystemId of BREAKAGE_SUBSYSTEM_IDS ) {
            const expiresAt = Number(subsystems?.[subsystemId]?.expiresAt) || 0;
            if ( Number.isFinite(expiresAt) === false || expiresAt <= 0 ) { continue; }
            hostMap.set(subsystemId, { expiresAt });
        }
        if ( hostMap.size === 0 ) { continue; }
        autoBackoffSubsystemState.set(normalizedHostname, hostMap);
    }
};

const loadAutoPromotionState = async () => {
    const [
        storedState,
        legacyGenericHighHosts,
    ] = await Promise.all([
        readLocalStrict(AUTO_PROMOTION_STATE_KEY),
        readLocalStrict(AUTO_GENERIC_HIGH_KEY),
    ]);
    autoPromotionState = createEmptyAutoPromotionState();
    const loadPromotionMap = (input, targetMap) => {
        if ( input instanceof Object === false ) { return; }
        for ( const [hostname, entry] of Object.entries(input) ) {
            const normalizedHostname = normalizeAutoPromotedHostname(hostname);
            if ( normalizedHostname === '' ) { continue; }
            const lastHitAt = Number(entry?.lastHitAt ?? entry?.ts ?? entry);
            if ( Number.isFinite(lastHitAt) === false || lastHitAt <= 0 ) { continue; }
            targetMap.set(normalizedHostname, { lastHitAt });
        }
    };
    loadPromotionMap(storedState?.complete, autoPromotionState.complete);
    if ( storedState?.genericHigh !== undefined || Array.isArray(legacyGenericHighHosts) ) {
        await persistAutoPromotionState();
    }
    await scheduleAutoPromotionAlarm();
};

const loadRemoteCosmeticsRuntimeStats = async () => {
    const stored = await readLocalStrict(REMOTE_COSMETICS_RUNTIME_STATS_KEY);
    remoteCosmeticsRuntimeStats = stored instanceof Object
        ? { ...stored }
        : {};
};

const loadCommunityEmergencySyncState = async () => {
    const stored = await readLocalStrict(COMMUNITY_EMERGENCY_SYNC_STATE_KEY);
    communityEmergencySyncState = normalizeCommunityEmergencySyncState(stored);
};

const triggerEmergencyCommunitySync = async (hostname, reason) => {
    const domain = normalizeAutoPromotedHostname(hostname);
    const gate = shouldTriggerCommunityEmergencySync({
        state: communityEmergencySyncState,
        domain,
        entitled: isEntitled(),
        communityRulesEnabled: rulesetConfig.communityRulesEnabled === true,
        communityUrlValid: normalizeCommunityURL(
            rulesetConfig.communityRulesURL || COMMUNITY_URL_DEFAULT
        ) !== '',
    });
    communityEmergencySyncState = gate.state;
    if ( gate.allowed !== true ) { return gate.reason; }
    communityEmergencySyncState = recordCommunityEmergencySyncAttempt({
        state: communityEmergencySyncState,
        domain: gate.domain,
        reason,
    });
    await persistCommunityEmergencySyncState();
    runCommunityOverlaySync({
        siteKey: gate.domain,
        reason,
    }).then(result => {
        if ( result?.rolledBack === true ) { return; }
        if (
            result?.source !== 'overlay' &&
            result?.source !== 'overlay-not-modified'
        ) {
            return;
        }
        communityEmergencySyncState = recordCommunityEmergencySyncSuccess({
            state: communityEmergencySyncState,
            domain: gate.domain,
            reason,
        });
        return persistCommunityEmergencySyncState();
    }).catch(ubolErr);
    return 'queued';
};

const pruneExpiredSubsystemBackoffEntries = async (now = Date.now()) => {
    let changed = false;
    for ( const [hostname, subsystems] of Array.from(autoBackoffSubsystemState.entries()) ) {
        if ( subsystems instanceof Map === false ) {
            autoBackoffSubsystemState.delete(hostname);
            changed = true;
            continue;
        }
        for ( const [subsystemId, entry] of Array.from(subsystems.entries()) ) {
            const expiresAt = Number(entry?.expiresAt) || 0;
            if ( expiresAt > now ) { continue; }
            subsystems.delete(subsystemId);
            changed = true;
        }
        if ( subsystems.size !== 0 ) { continue; }
        autoBackoffSubsystemState.delete(hostname);
        changed = true;
    }
    if ( changed ) {
        await persistAutoBackoffSubsystemState();
    }
    return changed;
};

const restoreExpiredAutoBackoffs = async () => {
    const now = Date.now();
    let hostBackoffChanged = false;
    for (const [hostname, entry] of Array.from(autoBackoffState.entries())) {
        const expiresAt = Number(entry?.expiresAt) || 0;
        if (expiresAt > now) { continue; }
        const currentLevel = await getFilteringMode(hostname);
        if (Number(currentLevel) === Number(entry.downgradedLevel)) {
            await setFilteringMode(hostname, entry.previousLevel);
        }
        autoBackoffState.delete(hostname);
        hostBackoffChanged = true;
    }
    if (hostBackoffChanged) {
        await persistAutoBackoffState();
    }
    const subsystemChanged = await pruneExpiredSubsystemBackoffEntries(now);
    await scheduleAutoBackoffAlarm();
    if ( hostBackoffChanged || subsystemChanged ) {
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    }
};

const pruneStaleAutoBackoffEvidence = async () => {
    if (autoBackoffEvidence.size === 0) { return; }
    const cutoff = Date.now() - (AUTO_BACKOFF_TTL_MS * 2);
    let changed = false;
    for (const [hostname, entry] of Array.from(autoBackoffEvidence.entries())) {
        if ((Number(entry?.lastSignalAt) || 0) >= cutoff) { continue; }
        autoBackoffEvidence.delete(hostname);
        changed = true;
    }
    if (changed) {
        await persistAutoBackoffEvidence();
    }
};

const pruneExpiredAutoPromotions = async (now = Date.now()) => {
    let completeChanged = false;
    for ( const [hostname, entry] of Array.from(autoPromotionState.complete.entries()) ) {
        const lastHitAt = Number(entry?.lastHitAt) || 0;
        if ( lastHitAt > 0 && (lastHitAt + AUTO_PROMOTION_TTL_MS) > now ) { continue; }
        autoPromotionState.complete.delete(hostname);
        completeChanged = true;
        const currentLevel = await getFilteringMode(hostname);
        if ( currentLevel === MODE_COMPLETE ) {
            await setFilteringMode(hostname, MODE_OPTIMAL);
        }
    }
    if ( completeChanged ) {
        await persistAutoPromotionState();
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    }
    await scheduleAutoPromotionAlarm();
    return completeChanged;
};

const pruneStaleRemoteCosmeticsRuntimeStats = async (now = Date.now()) => {
    let changed = false;
    const next = {};
    for ( const [hostname, entry] of Object.entries(remoteCosmeticsRuntimeStats || {}) ) {
        const updatedAt = Number(entry?.updatedAt) || 0;
        if ( updatedAt > 0 && (now - updatedAt) <= REMOTE_COSMETICS_RUNTIME_STATS_TTL_MS ) {
            next[hostname] = entry;
            continue;
        }
        changed = true;
    }
    remoteCosmeticsRuntimeStats = next;
    if ( changed ) {
        await persistRemoteCosmeticsRuntimeStats();
    }
};

const getSubsystemBackoffMap = hostname => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) { return null; }
    let hostMap = autoBackoffSubsystemState.get(normalizedHostname);
    if ( hostMap instanceof Map ) { return hostMap; }
    hostMap = new Map();
    autoBackoffSubsystemState.set(normalizedHostname, hostMap);
    return hostMap;
};

const hasActiveSubsystemBackoff = (hostname, subsystemId, now = Date.now()) => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    const normalizedSubsystem = normalizeBreakageSubsystem(subsystemId);
    if ( normalizedHostname === '' || normalizedSubsystem === '' ) { return false; }
    const hostMap = autoBackoffSubsystemState.get(normalizedHostname);
    const entry = hostMap instanceof Map ? hostMap.get(normalizedSubsystem) : undefined;
    return (Number(entry?.expiresAt) || 0) > now;
};

const enqueueRemoteCosmeticsRuntimeStatsMutation = operation => {
    const run = remoteCosmeticsRuntimeStatsMutationTail
        .catch(() => {})
        .then(operation);
    remoteCosmeticsRuntimeStatsMutationTail = run.catch(() => {});
    return run;
};

const resetRemoteCosmeticsRuntimeStats = () => {
    return enqueueRemoteCosmeticsRuntimeStatsMutation(async () => {
        remoteCosmeticsRuntimeStats = {};
        await localRemove(REMOTE_COSMETICS_RUNTIME_STATS_KEY);
    });
};

const recordRemoteCosmeticsRuntimeStatsNow = async ({
    hostname,
    laneScope = 'global',
    chunkCount = 0,
    selectorCount = 0,
    hostSpecificSelectorCount = 0,
    droppedAtApply = 0,
} = {}) => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) { return; }
    const normalizedLaneScope = laneScope === 'host' ? 'host' : 'global';
    await pruneStaleRemoteCosmeticsRuntimeStats();
    const previous = remoteCosmeticsRuntimeStats[normalizedHostname];
    const scopes = previous?.scopes instanceof Object
        ? { ...previous.scopes }
        : {};
    const now = Date.now();
    const nextScope = {
        chunkCount: Math.max(0, Math.floor(Number(chunkCount) || 0)),
        selectorCount: Math.max(0, Math.floor(Number(selectorCount) || 0)),
        hostSpecificSelectorCount: Math.max(0, Math.floor(Number(hostSpecificSelectorCount) || 0)),
        droppedAtApply: Math.max(0, Math.floor(Number(droppedAtApply) || 0)),
        updatedAt: now,
    };
    const previousScope = scopes[normalizedLaneScope];
    if (
        previousScope?.chunkCount === nextScope.chunkCount &&
        previousScope?.selectorCount === nextScope.selectorCount &&
        previousScope?.hostSpecificSelectorCount === nextScope.hostSpecificSelectorCount &&
        previousScope?.droppedAtApply === nextScope.droppedAtApply &&
        now - (Number(previousScope.updatedAt) || 0) <
            REMOTE_COSMETICS_RUNTIME_STATS_REFRESH_MS
    ) {
        return false;
    }
    scopes[normalizedLaneScope] = nextScope;
    const aggregate = {
        chunkCount: 0,
        selectorCount: 0,
        hostSpecificSelectorCount: 0,
        droppedAtApply: 0,
    };
    for ( const entry of Object.values(scopes) ) {
        aggregate.chunkCount += Math.max(0, Math.floor(Number(entry?.chunkCount) || 0));
        aggregate.selectorCount += Math.max(0, Math.floor(Number(entry?.selectorCount) || 0));
        aggregate.hostSpecificSelectorCount += Math.max(
            0,
            Math.floor(Number(entry?.hostSpecificSelectorCount) || 0)
        );
        aggregate.droppedAtApply += Math.max(0, Math.floor(Number(entry?.droppedAtApply) || 0));
    }
    remoteCosmeticsRuntimeStats[normalizedHostname] = {
        ...aggregate,
        scopes,
        updatedAt: now,
    };
    await persistRemoteCosmeticsRuntimeStats();
    return true;
};

const recordRemoteCosmeticsRuntimeStats = payload =>
    enqueueRemoteCosmeticsRuntimeStatsMutation(
        () => recordRemoteCosmeticsRuntimeStatsNow(payload)
    );

const touchAutoPromotionState = async (kind, hostname) => {
    if ( kind !== 'complete' ) { return ''; }
    const normalizedHostname = normalizeAutoPromotedHostname(hostname);
    if ( normalizedHostname === '' ) { return ''; }
    const targetMap = autoPromotionState.complete;
    targetMap.set(normalizedHostname, { lastHitAt: Date.now() });
    await persistAutoPromotionState();
    await scheduleAutoPromotionAlarm();
    return normalizedHostname;
};

const clearAutoPromotionStateForHostname = async (
    hostname,
    { revertComplete = false } = {}
) => {
    const normalizedHostname = normalizeAutoPromotedHostname(hostname);
    if ( normalizedHostname === '' ) { return false; }
    let changed = false;
    const hadComplete = autoPromotionState.complete.delete(normalizedHostname);
    changed = changed || hadComplete;
    if ( hadComplete && revertComplete ) {
        const currentLevel = await getFilteringMode(normalizedHostname);
        if ( currentLevel === MODE_COMPLETE ) {
            await setFilteringMode(normalizedHostname, MODE_OPTIMAL);
        }
    }
    if ( changed ) {
        await persistAutoPromotionState();
        await scheduleAutoPromotionAlarm();
    }
    return changed;
};

const applySubsystemBackoff = async (hostname, subsystemId) => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    const normalizedSubsystem = normalizeBreakageSubsystem(subsystemId);
    if ( normalizedHostname === '' || normalizedSubsystem === '' ) { return 'invalid'; }
    const now = Date.now();
    const hostMap = getSubsystemBackoffMap(normalizedHostname);
    const existing = hostMap?.get(normalizedSubsystem);
    if ( existing && Number(existing.expiresAt) > now ) {
        existing.expiresAt = now + AUTO_BACKOFF_TTL_MS;
        hostMap.set(normalizedSubsystem, existing);
        await persistAutoBackoffSubsystemState();
        await scheduleAutoBackoffAlarm();
        return hostMap.size >= BREAKAGE_SUBSYSTEM_IDS.length
            ? 'escalate'
            : 'handled';
    }
    hostMap.set(normalizedSubsystem, {
        expiresAt: now + AUTO_BACKOFF_TTL_MS,
    });
    await persistAutoBackoffSubsystemState();
    await scheduleAutoBackoffAlarm();
    await clearAutoPromotionStateForHostname(normalizedHostname, {
        revertComplete: true,
    });
    await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    return 'handled';
};

const applyAutoBackoff = async (hostname) => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if (normalizedHostname === '') { return; }
    const now = Date.now();
    const existing = autoBackoffState.get(normalizedHostname);
    if (existing && Number(existing.expiresAt) > now) {
        existing.expiresAt = now + AUTO_BACKOFF_TTL_MS;
        autoBackoffState.set(normalizedHostname, existing);
        await persistAutoBackoffState();
        await scheduleAutoBackoffAlarm();
        await clearAutoPromotionStateForHostname(normalizedHostname);
        return;
    }

    const beforeLevel = Number(await getFilteringMode(normalizedHostname));
    const targetLevel = getDowngradedFilteringMode(
        beforeLevel,
        MODE_COMPLETE,
        MODE_OPTIMAL,
        MODE_BASIC
    );
    if (targetLevel === beforeLevel) { return; }

    const afterLevel = await setFilteringMode(normalizedHostname, targetLevel);
    if (afterLevel !== targetLevel) { return; }

    autoBackoffState.set(normalizedHostname, {
        previousLevel: beforeLevel,
        downgradedLevel: targetLevel,
        expiresAt: now + AUTO_BACKOFF_TTL_MS,
    });
    await persistAutoBackoffState();
    await scheduleAutoBackoffAlarm();
    await clearAutoPromotionStateForHostname(normalizedHostname);
    await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
};

const restoreCompatibilityModeForHostname = async hostname => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) {
        return { ok: false, error: 'invalid_hostname' };
    }
    const now = Date.now();
    let changed = false;
    const hostBackoff = autoBackoffState.get(normalizedHostname);
    if ( hostBackoff instanceof Object ) {
        const expiresAt = Number(hostBackoff.expiresAt) || 0;
        if ( expiresAt > now ) {
            const currentLevel = await getFilteringMode(normalizedHostname);
            if ( Number(currentLevel) === Number(hostBackoff.downgradedLevel) ) {
                await setFilteringMode(normalizedHostname, hostBackoff.previousLevel);
            }
        }
        autoBackoffState.delete(normalizedHostname);
        await persistAutoBackoffState();
        changed = true;
    }
    const subsystemMap = autoBackoffSubsystemState.get(normalizedHostname);
    if ( subsystemMap instanceof Map && subsystemMap.size !== 0 ) {
        autoBackoffSubsystemState.delete(normalizedHostname);
        await persistAutoBackoffSubsystemState();
        changed = true;
    }
    if ( changed ) {
        await scheduleAutoBackoffAlarm();
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    }
    return {
        ok: true,
        changed,
        compatibilityMode: getActiveCompatibilityModeForHostname(normalizedHostname),
    };
};

const recordBlockedNavigation = (hostname) => {
    if (hostname === '') { return; }
    const now = Date.now();
    const current = autoBackoffCounts.get(hostname);
    if (current && (now - current.firstTs) <= AUTO_BACKOFF_WINDOW_MS) {
        current.count += 1;
        autoBackoffCounts.set(hostname, current);
    } else {
        autoBackoffCounts.set(hostname, { count: 1, firstTs: now });
    }
    const updated = autoBackoffCounts.get(hostname);
    if (updated && updated.count >= AUTO_BACKOFF_MIN_ERRORS) {
        autoBackoffCounts.delete(hostname);
        triggerEmergencyCommunitySync(
            hostname,
            'blocked-navigation-threshold'
        ).catch(ubolErr);
        // A blocked top-frame navigation only triggers hotfix recovery here.
        // Compatibility backoff waits for direct page breakage evidence.
    }
};

const recordBreakageSignal = async (hostname, signal, details = {}) => {
    if (hostname === '' || typeof signal !== 'string' || signal.trim() === '') { return; }
    const normalizedSignal = signal.trim();
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) { return; }
    const normalizedDetails = sanitizeBreakageDetails(details);
    const subsystem = normalizeBreakageSubsystem(
        details?.subsystem ?? normalizedDetails.subsystem
    );
    const now = Date.now();
    autoBackoffEvidence.set(
        normalizedHostname,
        mergeBreakageEvidenceEntry(autoBackoffEvidence.get(normalizedHostname), {
            signal: normalizedSignal,
            details: normalizedDetails,
        }, now)
    );
    await persistAutoBackoffEvidence();
    const counter = updateSignalCounter(
        autoBackoffSignalCounts,
        normalizedHostname,
        normalizedSignal,
        now,
        subsystem
    );
    const shouldBackoff = shouldTriggerSignalBackoff(normalizedSignal, counter);
    if ( shouldBackoff ) {
        const emergencyReason = isSevereBreakageSignal(normalizedSignal)
            ? `severe-signal:${normalizedSignal}`
            : `signal-threshold:${normalizedSignal}`;
        triggerEmergencyCommunitySync(
            normalizedHostname,
            emergencyReason
        ).catch(ubolErr);
    }
    if ( shouldBackoff ) {
        if ( subsystem !== '' ) {
            const subsystemResult = await applySubsystemBackoff(
                normalizedHostname,
                subsystem
            );
            if ( subsystemResult !== 'escalate' ) { return; }
        }
        await applyAutoBackoff(normalizedHostname);
    }
};

const initAutoBackoff = async () => {
    await loadAutoBackoffState();
    await loadAutoBackoffEvidence();
    await loadAutoBackoffSubsystemState();
    await restoreExpiredAutoBackoffs();
    await pruneStaleAutoBackoffEvidence();
};

const initAutoPromotionState = async () => {
    await loadAutoPromotionState();
    await pruneExpiredAutoPromotions();
};

const initRuntimeDiagnosticsState = async () => {
    await loadRemoteCosmeticsRuntimeStats();
    await pruneStaleRemoteCosmeticsRuntimeStats();
};

const initCommunityEmergencySyncState = async () => {
    await loadCommunityEmergencySyncState();
    await persistCommunityEmergencySyncState();
};

if (chrome.webNavigation?.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener((details) => {
        if (details?.frameId !== 0) { return; }
        if (AUTO_BACKOFF_ERROR_RE.test(details?.error || '') === false) { return; }
        const hostname = normalizeHttpHostname(details?.url || '');
        if (hostname === '') { return; }
        isFullyInitialized
            .then(() => recordBlockedNavigation(hostname))
            .catch(ubolErr);
    });
}

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
    sessionAccessLevel,
    isUserScriptsAvailable,
    supportsUserScripts,
    webextFlavor,
} from './ext.js';

import {
    INITIAL_SETUP_PENDING_KEY,
    defaultConfig,
    getEffectiveStrictBlockMode,
    isDeveloperModeAllowed,
    loadRulesetConfig,
    process,
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import {
    enableRulesets,
    excludeFromStrictBlock,
    getDefaultRulesetsFromEnv,
    getEffectiveDynamicRules,
    getEffectiveSessionRules,
    getEffectiveUserRules,
    getRulesetDetails,
    patchDefaultRulesets,
    repairDnrReconciliation,
    setStrictBlockMode,
    updateSessionRules,
    updateUserRules,
} from './ruleset-manager.js';

import { normalizeContentScriptRegistration } from './injectable-registration.js';

import {
    ALARM_NAME as COMMUNITY_ALARM_NAME,
    COMMUNITY_URL_DEFAULT,
    finalizeCommunityActivationSuccess,
    normalizeCommunityURL,
    rollbackCommunityActivation,
    scrubPrivateCommunityState,
    syncCommunityRules,
    syncCommunityOverlayRules,
} from './community-sync.js';
import {
    COMMUNITY_EMERGENCY_SYNC_STATE_KEY,
    getCommunityEmergencySyncDiagnostics,
    normalizeCommunityEmergencySyncState,
    recordCommunityEmergencySyncAttempt,
    recordCommunityEmergencySyncSuccess,
    shouldTriggerCommunityEmergencySync,
} from './community-emergency-sync.js';
import {
    COMMUNITY_SYNC_FAILURE_RETRY_MS,
    countCommunityCosmeticSelectors,
    countCommunityHeuristicLabelRegexes,
    countHostSpecificCommunityCosmeticSelectors,
    normalizeCommunitySyncTtlHours,
} from './community-sync-logic.js';

import {
    getConsoleOutput,
    getMatchedRules,
    isSideloaded,
    toggleDeveloperMode,
    ubolErr,
    ubolLog,
} from './debug.js';

import {
    ALLOW_ALL_RULES_DIAGNOSTICS_KEY,
    dnr,
} from './ext-compat.js';
import {
    CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY,
    readInjectableSyncDiagnostics,
    registerInjectables,
    setInjectableRegistrationSuspended,
    waitForInjectableRegistrationIdle,
} from './scripting-manager.js';
import {
    hasTimedOutRegistrationOperations,
    recordPackagedStaticScriptletReloadTransition,
    unregisterAndVerifyManagedRegistrations,
    waitForTimedOutRegistrationOperations,
} from './injectable-registration.js';
import { setToolbarIcon, toggleToolbarIcon } from './action.js';
import { createSingleFlightRunner } from './single-flight.js';

import {
    ENTITLEMENT_CHECK_ALARM,
    ENTITLEMENT_EXPIRE_ALARM,
    clearLicenseKey,
    getEntitlementStatus as getEntitlementStatusFromStorage,
    initEntitlement,
    readEntitlement,
    setLicenseKey as storeLicenseKey,
    verifyLicense,
} from './entitlement.js';

/******************************************************************************/

const UBOL_ORIGIN = runtime.getURL('').replace(/\/$/, '').toLowerCase();
const INSTALL_WELCOME_URL = 'https://talondefender.com/welcome/?source=install';
const FIRST_POPUP_WELCOME_BASE_URL = 'https://talondefender.com/welcome-live/';
const UNINSTALL_PAGE_BASE_URL = 'https://talondefender.com/uninstall/';
const TRIAL_EXPIRED_REMINDER_BASE_URL = 'https://talondefender.com/trial-expired/';
const FIRST_POPUP_WELCOME_SOURCE = 'first_popup_open';
const TRIAL_EXPIRED_REMINDER_SOURCE = 'trial_expired_reminder';
const FIRST_POPUP_WELCOME_PENDING_KEY = 'firstPopupWelcomePending';
const FIRST_POPUP_WELCOME_SEEN_KEY = 'firstPopupWelcomeSeenAt';
const TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY = 'trialExpiredReminderLastShownMs';
const TRIAL_EXPIRED_REMINDER_ALARM = 'trial-expired-reminder';
const TRIAL_EXPIRED_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const TRIAL_EXPIRED_REMINDER_INITIAL_DELAY_MS = 2 * 60 * 1000;
const TRIAL_EXPIRED_REMINDER_PERIOD_MINUTES = 12 * 60;

const buildFirstPopupWelcomeURL = (source = FIRST_POPUP_WELCOME_SOURCE) => {
    const params = new URLSearchParams();
    params.set('source', source);
    return `${FIRST_POPUP_WELCOME_BASE_URL}?${params.toString()}`;
};

const buildUninstallURL = (source = 'extension_uninstall') => {
    const params = new URLSearchParams();
    params.set('source', source);
    const version = runtime?.getManifest?.()?.version;
    if (typeof version === 'string' && version !== '') {
        params.set('version', version);
    }
    return `${UNINSTALL_PAGE_BASE_URL}?${params.toString()}`;
};

const buildTrialExpiredReminderURL = (
    source = TRIAL_EXPIRED_REMINDER_SOURCE
) => {
    const params = new URLSearchParams();
    params.set('source', source);
    const version = runtime?.getManifest?.()?.version;
    if (typeof version === 'string' && version !== '') {
        params.set('version', version);
    }
    return `${TRIAL_EXPIRED_REMINDER_BASE_URL}?${params.toString()}`;
};

const configureUninstallURL = (source = 'extension_uninstall') => {
    if (typeof runtime?.setUninstallURL !== 'function') { return; }
    const url = buildUninstallURL(source);
    try {
        runtime.setUninstallURL(url, () => {
            ignoreRuntimeLastError(runtime);
        });
    } catch (reason) {
        ubolErr(`setUninstallURL/${reason}`);
    }
};

async function openFirstPopupWelcomeOnce() {
    const [pending, seenAt] = await Promise.all([
        readLocalStrict(FIRST_POPUP_WELCOME_PENDING_KEY),
        readLocalStrict(FIRST_POPUP_WELCOME_SEEN_KEY),
    ]);
    if (pending !== true && pending instanceof Object === false) {
        return { opened: false };
    }
    const seenTs = Number(seenAt) || 0;
    if (seenTs > 0) {
        await localRemove(FIRST_POPUP_WELCOME_PENDING_KEY);
        return { opened: false };
    }
    const url = buildFirstPopupWelcomeURL();
    await localWrite(FIRST_POPUP_WELCOME_SEEN_KEY, Date.now());
    await localRemove(FIRST_POPUP_WELCOME_PENDING_KEY);
    await gotoURL(url);
    return { opened: true };
}

const runFirstPopupWelcomeOpen = createSingleFlightRunner(openFirstPopupWelcomeOnce);

const senderOriginFrom = sender => {
    if (typeof sender?.origin === 'string' && sender.origin !== '') {
        return sender.origin;
    }
    if (typeof sender?.url === 'string' && sender.url !== '') {
        try {
            return new URL(sender.url).origin;
        } catch {
        }
    }
    return '';
};

const isExtensionRuntimeSender = sender => {
    const senderId = typeof sender?.id === 'string' ? sender.id : '';
    return senderId === '' || senderId === runtime.id;
};

const isTrustedExtensionSender = sender => {
    if (isExtensionRuntimeSender(sender) === false) { return false; }
    const origin = senderOriginFrom(sender);
    if (origin === '') { return false; }
    return origin.toLowerCase() === UBOL_ORIGIN;
};

self.addEventListener('unhandledrejection', event => {
    if ( isIgnorableRuntimeError(event?.reason) ) {
        event.preventDefault();
    }
});

const canShowBlockedCount = typeof dnr.setExtensionActionOptions === 'function';

let pendingPermissionRequest;

const PAYWALL_RULE_BASE_ID = 8500000;
const PAYWALL_RULE_PRIORITY = 3000000;
let entitlementStatus = { status: 'trial' };
let entitlementInitialized = false;
let paywallActive = false;
let registrationMutationsSuspendedForPaywall = false;
let lifecycleRuntimeRefreshSuspendedForPaywall = false;
let livePageMutationGeneration = 0;
const pendingLivePageMutations = new Set();
let runtimeTabLifecycleGeneration = 0;
const runtimeTabLifecycleGenerations = new Map();
const suspendedRuntimeReconcileRequests = new Map();
const pendingSuspendedRuntimeReconcileOperations = new Set();
let suspendedRuntimeReconcileRevision = 0;
let suspendedOpenTabRuntimeRefreshRequest;
let suspendedOpenTabRuntimeRefreshRevision = 0;
let suspendedOpenTabRuntimeRefreshHydrationPromise;
let suspendedOpenTabRuntimeRefreshPersistenceTail = Promise.resolve();
let lastCommunityCleanupReason = '';
let communityBaselineSyncInFlight;
let communityBaselineForceQueued = false;
let communityApplyQueue = Promise.resolve();
let entitlementOpenTabRefreshPromise;
let entitlementActionTail = Promise.resolve();
let entitlementEffectsRevision = 0;
let startupMutationBarrierGeneration = 0;
let startupMutationBarrierSettled = true;
let startupMutationBarrierRejected = false;
let resolveStartupMutationBarrierPromise;
let rejectStartupMutationBarrierPromise;
let startupMutationBarrier = Promise.resolve();

const installStartupMutationBarrier = () => {
    if ( startupMutationBarrierSettled === false ) {
        startupMutationBarrierSettled = true;
        startupMutationBarrierRejected = true;
        rejectStartupMutationBarrierPromise(
            new Error('startup mutation generation superseded')
        );
    }
    startupMutationBarrierGeneration += 1;
    startupMutationBarrierSettled = false;
    startupMutationBarrierRejected = false;
    startupMutationBarrier = new Promise((resolve, reject) => {
        resolveStartupMutationBarrierPromise = resolve;
        rejectStartupMutationBarrierPromise = reject;
    });
    startupMutationBarrier.catch(() => {});
    return startupMutationBarrierGeneration;
};

const resolveStartupMutationBarrierGeneration = expectedGeneration => {
    if (
        expectedGeneration !== startupMutationBarrierGeneration ||
        startupMutationBarrierSettled
    ) { return false; }
    startupMutationBarrierSettled = true;
    startupMutationBarrierRejected = false;
    resolveStartupMutationBarrierPromise();
    return true;
};

const rejectStartupMutationBarrierGeneration = (
    expectedGeneration,
    reason
) => {
    if (
        expectedGeneration !== startupMutationBarrierGeneration ||
        startupMutationBarrierSettled
    ) { return false; }
    startupMutationBarrierSettled = true;
    startupMutationBarrierRejected = true;
    rejectStartupMutationBarrierPromise(reason);
    return true;
};

installStartupMutationBarrier();
let startupDocumentRuntimeReadySettled = false;
let startupDocumentRuntimeGateState = 'pending';
let startupDocumentRuntimeGateEpoch = 1;
let startupDocumentRuntimeOperationalEpoch = 0;
let startupDocumentRuntimeAttemptRequiresRepair = false;
let resolveStartupDocumentRuntimeReady;
let startupDocumentRuntimeReady = new Promise(resolve => {
    resolveStartupDocumentRuntimeReady = resolve;
});

const replaceStartupDocumentRuntimeGate = () => {
    const previousEpoch = startupDocumentRuntimeGateEpoch;
    if ( startupDocumentRuntimeReadySettled === false ) {
        startupDocumentRuntimeReadySettled = true;
        resolveStartupDocumentRuntimeReady({
            operational: false,
            reason: 'superseded',
            epoch: previousEpoch,
        });
    }
    startupDocumentRuntimeGateEpoch += 1;
    startupDocumentRuntimeOperationalEpoch = 0;
    startupDocumentRuntimeGateState = 'pending';
    startupDocumentRuntimeReadySettled = false;
    startupDocumentRuntimeReady = new Promise(resolve => {
        resolveStartupDocumentRuntimeReady = resolve;
    });
};

const prepareStartupDocumentRuntimeGate = () => {
    const invalidatedOperationalRuntime =
        startupDocumentRuntimeGateState === 'operational';
    if ( startupDocumentRuntimeGateState !== 'pending' ) {
        replaceStartupDocumentRuntimeGate();
    }
    startupDocumentRuntimeOperationalEpoch = 0;
    return invalidatedOperationalRuntime;
};

const beginStartupDocumentRuntimeAttempt = () => {
    startupDocumentRuntimeAttemptRequiresRepair =
        prepareStartupDocumentRuntimeGate() ||
        startupDocumentRuntimeAttemptRequiresRepair;
};

const markStartupDocumentRuntimeReady = async () => {
    if ( startupDocumentRuntimeGateState === 'operational' ) {
        return startupDocumentRuntimeOperationalEpoch;
    }
    if ( startupDocumentRuntimeGateState !== 'pending' ) {
        replaceStartupDocumentRuntimeGate();
    }
    // This must be durable before content-script requests can cross the gate.
    // A worker killed on the next line will be repaired by the next start.
    await localWrite(STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY, {
        version: 1,
        epoch: startupDocumentRuntimeGateEpoch,
        updatedAt: Date.now(),
    });
    startupDocumentRuntimeGateState = 'operational';
    startupDocumentRuntimeOperationalEpoch = startupDocumentRuntimeGateEpoch;
    startupDocumentRuntimeAttemptRequiresRepair = true;
    if ( startupDocumentRuntimeReadySettled === false ) {
        startupDocumentRuntimeReadySettled = true;
        resolveStartupDocumentRuntimeReady({
            operational: true,
            reason: '',
            epoch: startupDocumentRuntimeOperationalEpoch,
        });
    }
    return startupDocumentRuntimeOperationalEpoch;
};

const settleStartupDocumentRuntimeUnavailable = (reason = 'startup_failed') => {
    if ( startupDocumentRuntimeGateState !== 'pending' ) {
        replaceStartupDocumentRuntimeGate();
    }
    startupDocumentRuntimeOperationalEpoch = 0;
    startupDocumentRuntimeGateState = reason === 'not_entitled'
        ? 'unavailable'
        : 'failed';
    if ( startupDocumentRuntimeReadySettled === false ) {
        startupDocumentRuntimeReadySettled = true;
        resolveStartupDocumentRuntimeReady({
            operational: false,
            reason,
            epoch: startupDocumentRuntimeGateEpoch,
        });
    }
};

const invalidateStartupDocumentRuntimeAttempt = () => {
    const requiresRepair = startupDocumentRuntimeAttemptRequiresRepair ||
        startupDocumentRuntimeGateState === 'operational';
    prepareStartupDocumentRuntimeGate();
    startupDocumentRuntimeAttemptRequiresRepair = requiresRepair;
    return requiresRepair;
};

const awaitStartupDocumentRuntimeGate = async () => {
    for (;;) {
        const observed = startupDocumentRuntimeReady;
        const result = await observed;
        if (
            observed !== startupDocumentRuntimeReady ||
            result?.reason === 'superseded'
        ) {
            continue;
        }
        if (
            result?.operational === true &&
            result.epoch !== startupDocumentRuntimeOperationalEpoch
        ) {
            continue;
        }
        return result;
    }
};

let paywallTransitionTail = Promise.resolve();
let timedOutPaywallCleanupPromise;
let userScriptsPaywallCleanupPromise;
let opportunisticUserScriptsCleanupPromise;
let userScriptsCleanupPendingKnown;
let nextOpportunisticUserScriptsCleanupProbeAt = 0;
const pendingPaywallMutations = new Set();
let paywallMutationReconciliationRequired = false;
let rulesetMutationTail = Promise.resolve();
const communityOverlaySyncInFlight = new Map();
let startupComplete = false;
let startupCoreReady = false;
let popupWarmupRecoveryPromise;
let startupRecoveryPromise;
let installWelcomeAllowlistReadyPromise;
const overlaySessions = createOverlaySessionStore();

const AUTO_GENERIC_HIGH_KEY = 'autoGenericHighHosts'; // legacy cleanup only
const AUTO_PROMOTE_ENABLED = true;
const STARTUP_SAFE_MESSAGE_TYPES = new Set([
    'popupWarmup',
    'popupPanelData',
    'getTabReloadNeededState',
    'getEntitlementStatus',
    'setLicenseKey',
    'replaceDevice',
    'clearLicenseKey',
    'gotoURL',
    'removeCSS',
]);
const STARTUP_DOCUMENT_RUNTIME_MESSAGE_TYPES = new Set([
    'insertCSS',
    'injectCSSProceduralAPI',
    'injectCustomFilters',
]);
const POST_STARTUP_ONLY_MESSAGE_TYPES = new Set([
]);
const MAX_MESSAGE_CSS_LENGTH = 120000;
const MAX_NAVIGATION_URL_LENGTH = 4096;
const MAX_LICENSE_KEY_LENGTH = 512;
const MAX_RULESETS_PER_REQUEST = 256;
const MAX_MODE_HOSTS_PER_LEVEL = 4096;
const POPUP_WARMUP_RECOVERY_TIMEOUT_MS = 4000;
const PAYWALL_REGISTRATION_SETTLE_TIMEOUT_MS = 10000;
const PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS = 10000;
const RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS = 10000;
const RULESET_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const sanitizeModeHostname = value => {
    if (typeof value !== 'string') { return ''; }
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized.length > 253) { return ''; }
    if (normalized === 'all-urls' || normalized === '*') { return 'all-urls'; }
    try {
        const parsed = new URL(`https://${normalized}`);
        return parsed.hostname.toLowerCase();
    } catch {
    }
    return '';
};

const sanitizeFilteringLevel = value => {
    const level = Number(value);
    if (Number.isInteger(level) === false) { return null; }
    if (level < MODE_NONE || level > MODE_COMPLETE) { return null; }
    return level;
};

const sanitizeNavigationRequestURL = value => {
    if (typeof value !== 'string') { return ''; }
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_NAVIGATION_URL_LENGTH) { return ''; }
    return trimmed;
};

const sanitizeCssPayload = value => {
    if (typeof value !== 'string') { return ''; }
    if (value === '' || value.length > MAX_MESSAGE_CSS_LENGTH) { return ''; }
    return value;
};

const sanitizeRulesetIds = value => {
    if (Array.isArray(value) === false) { return null; }
    const out = [];
    const seen = new Set();
    for (const raw of value) {
        if (typeof raw !== 'string') { continue; }
        const id = raw.trim().toLowerCase();
        if (RULESET_ID_RE.test(id) === false) { continue; }
        if (seen.has(id)) { continue; }
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_RULESETS_PER_REQUEST) { break; }
    }
    return out;
};

const sanitizeFilteringModesPayload = value => {
    if (value instanceof Object === false) { return null; }
    const keys = [ 'none', 'basic', 'optimal', 'complete' ];
    const out = {};
    for (const key of keys) {
        const source = value[key];
        if (Array.isArray(source) === false) { return null; }
        const items = [];
        const seen = new Set();
        for (const entry of source) {
            const hostname = sanitizeModeHostname(entry);
            if (hostname === '') { continue; }
            if (seen.has(hostname)) { continue; }
            seen.add(hostname);
            items.push(hostname);
            if (items.length >= MAX_MODE_HOSTS_PER_LEVEL) { break; }
        }
        out[key] = items;
    }
    return out;
};

function isEntitled() {
    return shouldEnablePaywallForStatus(entitlementStatus) === false;
}

function setEntitlementStatusForRuntime(nextStatus) {
    const nextEntitled = shouldEnablePaywallForStatus(nextStatus) === false;
    const currentEntitled = isEntitled();
    if (
        nextEntitled && (
            currentEntitled === false ||
            paywallActive ||
            registrationMutationsSuspendedForPaywall ||
            lifecycleRuntimeRefreshSuspendedForPaywall
        )
    ) {
        prepareStartupDocumentRuntimeGate();
    }
    entitlementStatus = nextStatus;
    if ( nextEntitled === false ) {
        settleStartupDocumentRuntimeUnavailable('not_entitled');
    }
    return entitlementStatus;
}

const getRuntimeTabLifecycleGeneration = tabId => {
    let generation = runtimeTabLifecycleGenerations.get(tabId);
    if ( generation === undefined ) {
        generation = ++runtimeTabLifecycleGeneration;
        runtimeTabLifecycleGenerations.set(tabId, generation);
    }
    return generation;
};

const invalidateRuntimeTabLifecycle = tabId => {
    const generation = ++runtimeTabLifecycleGeneration;
    runtimeTabLifecycleGenerations.set(tabId, generation);
    return generation;
};

const runtimeTabLifecycleMatches = (tabId, expectedGeneration) =>
    expectedGeneration === undefined ||
    getRuntimeTabLifecycleGeneration(tabId) === expectedGeneration;

function livePageMutationMayDispatch(
    generation,
    { cleanup = false, startupDocumentEpoch = 0 } = {}
) {
    if ( generation !== livePageMutationGeneration ) { return false; }
    if ( cleanup ) {
        // Cleanup remains available to expired documents, but an entitled
        // restore owns its suspension epoch so an old remover cannot strip
        // freshly restored runtime state.
        return isEntitled() === false || (
            paywallActive === false &&
            registrationMutationsSuspendedForPaywall === false &&
            lifecycleRuntimeRefreshSuspendedForPaywall === false
        );
    }
    const startupDocumentRuntimeAuthorized =
        Number.isSafeInteger(startupDocumentEpoch) &&
        startupDocumentEpoch > 0 &&
        startupDocumentEpoch === startupDocumentRuntimeOperationalEpoch &&
        startupDocumentRuntimeGateState === 'operational' &&
        entitlementInitialized;
    return (startupCoreReady === true || startupDocumentRuntimeAuthorized) &&
        isEntitled() &&
        paywallActive === false &&
        registrationMutationsSuspendedForPaywall === false &&
        lifecycleRuntimeRefreshSuspendedForPaywall === false;
}

function trackLivePageMutation(operation, options = {}) {
    const generation = livePageMutationGeneration;
    if ( livePageMutationMayDispatch(generation, options) === false ) {
        return Promise.resolve(false);
    }
    const stillCurrent = () => livePageMutationMayDispatch(generation, options);
    const task = Promise.resolve().then(() => {
        if ( stillCurrent() === false ) { return false; }
        return operation(stillCurrent);
    });
    pendingLivePageMutations.add(task);
    task.finally(() => {
        pendingLivePageMutations.delete(task);
    }).catch(() => {});
    return task;
}

async function waitForLivePageMutations() {
    while ( pendingLivePageMutations.size !== 0 ) {
        await Promise.allSettled(Array.from(pendingLivePageMutations));
    }
}

const isDurableDirtyMarker = value => value !== undefined && value !== false;

function isStartupCoreReady() {
    return startupCoreReady === true;
}

const startupInjectableResultIsReady = result =>
    result?.skipped === 'unchanged' ||
    result?.skipped === 'not_entitled' ||
    result?.ok === true;

const scheduleStartupInjectableRetry = async ({
    delayInMinutes = INJECTABLE_STARTUP_RETRY_DELAY_MINUTES,
} = {}) => {
    if ( typeof browser.alarms?.create !== 'function' ) {
        throw new Error('alarms API unavailable for injectable retry');
    }
    await browser.alarms.create(INJECTABLE_STARTUP_RETRY_ALARM, {
        delayInMinutes,
    });
};

async function scheduleDeferredRuntimeRetry() {
    if ( typeof browser.alarms?.create !== 'function' ) {
        throw new Error('alarms API unavailable for deferred runtime retry');
    }
    await ensureDeferredRuntimeDocumentsHydrated();
    const now = Date.now();
    const retryableEntries = Array.from(deferredRuntimeDocuments.values())
        .filter(entry =>
            entry.manual !== true && entry.waitForUnfreeze !== true
        );
    if (
        deferredRuntimeDocuments.size !== 0 &&
        retryableEntries.length === 0
    ) {
        await browser.alarms?.clear?.(DEFERRED_RUNTIME_RETRY_ALARM);
        return false;
    }
    const scheduledTime = retryableEntries.length === 0
        ? now + DEFERRED_RUNTIME_RETRY_DELAY_MINUTES * 60 * 1000
        : Math.max(
            now + 1000,
            Math.min(...retryableEntries.map(entry =>
                Math.max(now, Number(entry.nextRetryAt) || now)
            ))
        );
    const existing = typeof browser.alarms?.get === 'function'
        ? await browser.alarms.get(DEFERRED_RUNTIME_RETRY_ALARM)
        : null;
    if (
        Number(existing?.scheduledTime) > 0 &&
        existing.scheduledTime <= scheduledTime
    ) {
        return true;
    }
    await browser.alarms.create(DEFERRED_RUNTIME_RETRY_ALARM, {
        when: scheduledTime,
    });
    return true;
}

function raceWithTimeout(task, timeoutMs, reason) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = self.setTimeout(() => {
            if ( settled ) { return; }
            settled = true;
            reject(new Error(reason));
        }, timeoutMs);
        Promise.resolve(task).then(result => {
            if ( settled ) { return; }
            settled = true;
            self.clearTimeout(timeoutId);
            resolve(result);
        }, error => {
            if ( settled ) { return; }
            settled = true;
            self.clearTimeout(timeoutId);
            reject(error);
        });
    });
}

function observePromiseWithTimeout(task, timeoutMs) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if ( settled ) { return; }
            settled = true;
            self.clearTimeout(timeoutId);
            resolve(result);
        };
        const timeoutId = self.setTimeout(() => {
            if ( settled ) { return; }
            settled = true;
            resolve({ status: 'timeout' });
        }, timeoutMs);
        Promise.resolve(task).then(
            value => finish({ status: 'fulfilled', value }),
            reason => finish({ status: 'rejected', reason })
        );
    });
}

function observeBestEffortOperation(operation, label, timeoutMs = 5000) {
    let task;
    try {
        task = operation();
    } catch (reason) {
        ubolErr(`${label}/${reason}`);
        return;
    }
    observePromiseWithTimeout(task, timeoutMs).then(result => {
        if ( result.status === 'fulfilled' ) { return; }
        const reason = result.status === 'timeout'
            ? 'timed out'
            : result.reason;
        ubolErr(`${label}/${reason}`);
    }).catch(reason => {
        ubolErr(`${label}/${reason}`);
    });
}

const runtimeScriptTargetKeys = details => {
    const target = details?.target;
    const tabId = Number(target?.tabId);
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return []; }
    const documentIds = Array.isArray(target?.documentIds)
        ? Array.from(new Set(target.documentIds.filter(
            value => typeof value === 'string' && value !== ''
        )))
        : [];
    if ( documentIds.length !== 0 ) {
        return documentIds.sort().map(value => `${tabId}|document:${value}`);
    }
    const frameIds = Array.isArray(target?.frameIds)
        ? Array.from(new Set(target.frameIds.filter(Number.isInteger)))
        : [];
    if ( frameIds.length !== 0 ) {
        return frameIds.sort((a, b) => a - b)
            .map(value => `${tabId}|frame:${value}`);
    }
    return [ target?.allFrames === true
        ? `${tabId}|all-frames`
        : `${tabId}|frame:0` ];
};

const runtimeScriptTargetHasPendingExecution = keys => {
    if ( keys.length === 0 ) { return false; }
    const tabPrefix = `${keys[0].split('|', 1)[0]}|`;
    const allFramesKey = `${tabPrefix}all-frames`;
    if ( pendingTimedOutRuntimeScripts.has(allFramesKey) ) { return true; }
    if ( keys.includes(allFramesKey) ) {
        return Array.from(pendingTimedOutRuntimeScripts.keys()).some(
            key => key.startsWith(tabPrefix)
        );
    }
    return keys.some(key => pendingTimedOutRuntimeScripts.has(key));
};

function executeScriptingMutationWithTimeout(
    method,
    details,
    reason = 'execution did not settle',
    timeoutMs = RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS
) {
    const targetKeys = runtimeScriptTargetKeys(details);
    if ( runtimeScriptTargetHasPendingExecution(targetKeys) ) {
        return Promise.reject(new Error(
            `${RUNTIME_SCRIPT_TIMEOUT_PREFIX}: prior target execution is still pending`
        ));
    }
    let task;
    try {
        const operation = browser.scripting?.[method];
        if ( typeof operation !== 'function' ) {
            return Promise.reject(new Error(`scripting.${method} unavailable`));
        }
        task = Promise.resolve(operation.call(browser.scripting, details));
    } catch (reason) {
        return Promise.reject(reason);
    }
    pendingRuntimeScriptOperations.add(task);
    task.finally(() => {
        pendingRuntimeScriptOperations.delete(task);
    }).catch(() => {});
    const timeoutReason = `${RUNTIME_SCRIPT_TIMEOUT_PREFIX}: ${reason}`;
    const boundedTimeoutMs = Math.max(
        100,
        Math.min(
            RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS,
            Number(timeoutMs) || RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS
        )
    );
    return raceWithTimeout(
        task,
        boundedTimeoutMs,
        timeoutReason
    ).catch(error => {
        if ( runtimeRefreshErrorMessage(error) !== timeoutReason ) {
            throw error;
        }
        if ( targetKeys.length !== 0 ) {
            for ( const targetKey of targetKeys ) {
                pendingTimedOutRuntimeScripts.set(targetKey, task);
            }
            task.then(
                () => undefined,
                () => undefined
            ).then(() => {
                for ( const targetKey of targetKeys ) {
                    if ( pendingTimedOutRuntimeScripts.get(targetKey) === task ) {
                        pendingTimedOutRuntimeScripts.delete(targetKey);
                    }
                }
                return scheduleDeferredRuntimeRetry();
            }).catch(ubolErr);
        }
        throw error;
    });
}

function executeRuntimeScriptWithTimeout(
    details,
    reason = 'execution did not settle',
    timeoutMs = RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS
) {
    return executeScriptingMutationWithTimeout(
        'executeScript',
        details,
        reason,
        timeoutMs
    );
}

function insertRuntimeCSSWithTimeout(
    details,
    reason = 'CSS insertion did not settle'
) {
    return executeScriptingMutationWithTimeout('insertCSS', details, reason);
}

function removeRuntimeCSSWithTimeout(
    details,
    reason = 'CSS removal did not settle'
) {
    return executeScriptingMutationWithTimeout('removeCSS', details, reason);
}

function trackPaywallMutation(task) {
    const operation = Promise.resolve(task);
    paywallMutationReconciliationRequired = true;
    let trackedOperation;
    trackedOperation = operation.finally(async () => {
        await markEntitlementEffectsDirty().catch(reason => {
            ubolErr(`paywall/late-mutation-reconcile/${reason}`);
        });
        pendingPaywallMutations.delete(trackedOperation);
    });
    pendingPaywallMutations.add(trackedOperation);
    return trackedOperation;
}

async function waitForPendingPaywallMutations() {
    while ( pendingPaywallMutations.size !== 0 ) {
        await Promise.allSettled(Array.from(pendingPaywallMutations));
    }
}

async function prepareEntitledRestoreAfterPaywallMutations() {
    const reconciliationRequired =
        paywallMutationReconciliationRequired || pendingPaywallMutations.size !== 0;
    if ( pendingPaywallMutations.size !== 0 ) {
        await raceWithTimeout(
            waitForPendingPaywallMutations(),
            PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
            'pending paywall mutation did not settle before entitlement restore'
        );
    }
    return reconciliationRequired;
}

function normalizePopupWarmupLastError(injectableSyncDiagnostics, fallback = '') {
    if ( typeof injectableSyncDiagnostics?.lastError === 'string' ) {
        return injectableSyncDiagnostics.lastError;
    }
    return typeof fallback === 'string' ? fallback : '';
}

function buildPopupWarmupResponse({
    fullyInitialized = isStartupCoreReady(),
    injectableSyncReady = false,
    injectableSyncDiagnostics = null,
    injectableSyncLastError = '',
} = {}) {
    return {
        ok: true,
        fullyInitialized,
        entitlementStatus: entitlementStatus?.status || 'trial',
        paywalled: paywallActive === true,
        injectableSyncReady,
        injectableSyncUpdatedAt: Math.max(
            0,
            Number(injectableSyncDiagnostics?.updatedAt) || 0
        ),
        injectableSyncLastError: normalizePopupWarmupLastError(
            injectableSyncDiagnostics,
            injectableSyncLastError
        ),
    };
}

async function recoverStartupStateForPopup() {
    if ( startupRecoveryPromise instanceof Promise ) {
        return startupRecoveryPromise;
    }
    const recoveryGeneration = installStartupMutationBarrier();
    // Arm the watchdog before entering the entitlement queue. A wedged older
    // action must not leave this new startup generation pending forever.
    observeBestEffortOperation(
        () => browser.alarms?.create?.(STARTUP_PROCESS_RETRY_ALARM, {
            delayInMinutes: 1,
        }),
        'startup recovery watchdog create'
    );
    const recovery = enqueueEntitlementAction(async () => {
        const result = await start({ forcePermissionSync: true });
        if (
            startupComplete !== true ||
            startupCoreReady !== true ||
            startupInjectableResultIsReady(result) === false
        ) {
            throw new Error('startup recovery did not complete');
        }
        resolveStartupMutationBarrierGeneration(recoveryGeneration);
        return result;
    }, { allowAfterStartupFailure: true }).catch(async reason => {
        startupComplete = false;
        startupCoreReady = false;
        invalidateStartupDocumentRuntimeAttempt();
        settleStartupDocumentRuntimeUnavailable('startup_failed');
        await persistStartupDocumentRuntimeRepair({ force: true }).catch(ubolErr);
        rejectStartupMutationBarrierGeneration(recoveryGeneration, reason);
        await Promise.resolve(browser.alarms?.create?.(
            STARTUP_PROCESS_RETRY_ALARM,
            { delayInMinutes: 1 }
        )).catch(ubolErr);
        throw reason;
    });
    startupRecoveryPromise = recovery;
    isFullyInitialized = recovery.then(() => undefined);
    isFullyInitialized.catch(() => {});
    const trackedRecovery = recovery;
    trackedRecovery.finally(() => {
        if ( startupRecoveryPromise === trackedRecovery ) {
            startupRecoveryPromise = undefined;
        }
    }).catch(() => {});
    return recovery;
}

async function recoverStartupCoreFromPopupWarmup() {
    if ( popupWarmupRecoveryPromise instanceof Promise === false ) {
        const underlyingRecovery = recoverStartupStateForPopup()
            .then(async syncResult => {
                const registerResult = syncResult?.registerResult instanceof Object
                    ? syncResult.registerResult
                    : null;
                const injectableSyncDiagnostics =
                    await readInjectableSyncDiagnostics().catch(() => null);
                const injectableSyncReady = startupInjectableResultIsReady(syncResult);
                if ( injectableSyncReady ) {
                    startupCoreReady = true;
                }
                return {
                    syncResult,
                    injectableSyncDiagnostics,
                    injectableSyncReady,
                    injectableSyncLastError: normalizePopupWarmupLastError(
                        injectableSyncDiagnostics,
                        typeof registerResult?.lastError === 'string'
                            ? registerResult.lastError
                            : ''
                    ),
                };
            });
        popupWarmupRecoveryPromise = underlyingRecovery;
        const trackedRecovery = underlyingRecovery;
        trackedRecovery.finally(() => {
            if ( popupWarmupRecoveryPromise === trackedRecovery ) {
                popupWarmupRecoveryPromise = undefined;
            }
        }).catch(() => {});
    }
    return raceWithTimeout(
        popupWarmupRecoveryPromise,
        POPUP_WARMUP_RECOVERY_TIMEOUT_MS,
        'popup warmup recovery timeout'
    ).catch(reason => ({
        syncResult: null,
        injectableSyncDiagnostics: null,
        injectableSyncReady: false,
        injectableSyncLastError: `${reason}`,
    }));
}

function shouldHandleMessageBeforeFullInitialization(request, sender) {
    if ( request instanceof Object === false ) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if ( STARTUP_SAFE_MESSAGE_TYPES.has(what) === false ) { return false; }
    if ( what === 'removeCSS' ) {
        return isExtensionRuntimeSender(sender) &&
            Number.isInteger(sender?.tab?.id) &&
            Number.isInteger(sender?.frameId) &&
            typeof sender?.documentId === 'string' &&
            sender.documentId !== '';
    }
    return isTrustedExtensionSender(sender);
}

function shouldWaitForStartupDocumentRuntime(request, sender) {
    if ( request instanceof Object === false ) { return false; }
    if ( STARTUP_DOCUMENT_RUNTIME_MESSAGE_TYPES.has(request.what) === false ) {
        return false;
    }
    return isExtensionRuntimeSender(sender) &&
        Number.isInteger(sender?.tab?.id) &&
        Number.isInteger(sender?.frameId) &&
        typeof sender?.documentId === 'string' &&
        sender.documentId !== '';
}

function shouldRejectMessageUntilStartupComplete(request, sender) {
    if ( request instanceof Object === false ) { return false; }
    if ( isStartupCoreReady() ) { return false; }
    if ( isTrustedExtensionSender(sender) === false ) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if ( what === '' ) { return false; }
    return POST_STARTUP_ONLY_MESSAGE_TYPES.has(what);
}

function buildPostStartupOnlyResponse() {
    return {
        ok: false,
        error: 'post_startup_only',
    };
}

function shouldRejectPostStartupOnlyMessage(request, sender) {
    return shouldRejectMessageUntilStartupComplete(request, sender);
}

function shouldHandlePostStartupOnlyMessage(request, sender) {
    if ( request instanceof Object === false ) { return false; }
    if ( isStartupCoreReady() === false ) { return false; }
    if ( isTrustedExtensionSender(sender) === false ) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if ( what === '' ) { return false; }
    return POST_STARTUP_ONLY_MESSAGE_TYPES.has(what);
}

async function setDefaultFilteringMode(afterLevel) {
    return setDefaultFilteringModeRaw(afterLevel);
}

if ( browser.tabs?.onRemoved ) {
    browser.tabs.onRemoved.addListener(tabId => {
        invalidateRuntimeTabLifecycle(tabId);
        suspendedRuntimeReconcileRequests.delete(tabId);
        clearDeferredRuntimeDocuments({ tabId }).catch(ubolErr);
        clearReloadNeededStateForTab(tabId).catch(ubolErr);
        browser.storage?.session?.remove?.([
            reloadSafeDocumentsSessionKey(tabId),
            prerenderDocumentsSessionKey(tabId),
        ]).catch?.(ubolErr);
    });
}

async function setFilteringMode(hostname, afterLevel) {
    return setFilteringModeRaw(hostname, afterLevel);
}

async function setFilteringModeDetails(details, expectedRevision) {
    return setFilteringModeDetailsRaw(details, expectedRevision);
}

async function reconcileFilteringModeDetails() {
    return reconcileFilteringModeDetailsRaw();
}

function ensureInstallWelcomeAllowlistReady() {
    if ( installWelcomeAllowlistReadyPromise instanceof Promise ) {
        return installWelcomeAllowlistReadyPromise;
    }
    installWelcomeAllowlistReadyPromise = reconcileFilteringModeDetails().catch(reason => {
        installWelcomeAllowlistReadyPromise = undefined;
        throw reason;
    });
    return installWelcomeAllowlistReadyPromise;
}

async function syncWithBrowserPermissions() {
    return syncWithBrowserPermissionsRaw();
}

async function syncToolbarIconsForAllTabs() {
    if (paywallActive) { return; }
    const defaultMode = await getDefaultFilteringMode();
    const enabled = Number(defaultMode) !== MODE_NONE;
    setToolbarIcon(undefined, enabled);

    let tabs = [];
    try {
        tabs = await browser.tabs.query({});
    } catch {
        return;
    }
    const jobs = [];
    for (const tab of tabs || []) {
        if (typeof tab?.id !== 'number') { continue; }
        jobs.push(Promise.resolve(setToolbarIcon(tab.id, enabled)));
    }
    await Promise.all(jobs);
}

const getBundledRegionalRulesetIds = ( ) => {
    const entries = runtime.getManifest()?.declarative_net_request?.rule_resources;
    if ( Array.isArray(entries) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of entries ) {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
        if ( id === '' || seen.has(id) ) { continue; }
        if ( PUBLIC_SAFE_REGIONAL_RULESET_ID_SET.has(id) === false ) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
};

const getStoredEnabledRulesetsSnapshot = () => {
    const stored = sanitizeRulesetIds(rulesetConfig.enabledRulesets);
    return Array.isArray(stored) ? stored : [];
};

async function getFallbackEnabledRulesets() {
    if ( await readLocalStrict(PENDING_INSTALL_RULESET_RESET_KEY) ) {
        const defaults = await getDefaultRulesetsFromEnv().catch((reason) => {
            ubolErr(`getDefaultRulesetsFromEnv/${reason}`);
            return [];
        });
        if ( defaults.length !== 0 ) {
            return defaults;
        }
    }

    const stored = getStoredEnabledRulesetsSnapshot();
    if ( rulesetConfig.rulesetSelectionVersion === RULESET_SELECTION_STATE_VERSION ) {
        return stored;
    }

    const defaults = await getDefaultRulesetsFromEnv().catch((reason) => {
        ubolErr(`getDefaultRulesetsFromEnv/${reason}`);
        return [];
    });
    return defaults.length !== 0 ? defaults : stored;
}

async function getReportedEnabledRulesets() {
    if ( isStartupCoreReady() === false ) {
        return getFallbackEnabledRulesets();
    }
    try {
        const actual = sanitizeRulesetIds(await dnr.getEnabledRulesets());
        if ( Array.isArray(actual) ) {
            return actual;
        }
    } catch (reason) {
        ubolErr(`getEnabledRulesets/${reason}`);
    }
    return getFallbackEnabledRulesets();
}

async function patchAutoRegionalRulesets() {
    const bundledRegionalRuleIds = getBundledRegionalRulesetIds();
    if ( bundledRegionalRuleIds.length === 0 ) {
        return {
            changed: false,
            customized: false,
            storageChanged: false,
        };
    }
    const [
        storedAutoRegionalRulesetIds = [],
        storedRegionalOptOutIds = [],
        acceptLanguages,
    ] = await Promise.all([
        readLocalStrict(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
        readLocalStrict(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
        getPreferredLanguageTags(),
    ]);
    const nextAutoRegionalRulesetIds = getAutoRegionalRulesetIds({
        acceptLanguages,
        availableRulesetIds: bundledRegionalRuleIds,
    });
    const patch = reconcileAutoRegionalRulesetPatch({
        currentEnabledRulesets: rulesetConfig.enabledRulesets,
        storedAutoRegionalRulesetIds,
        storedRegionalOptOutIds,
        nextAutoRegionalRulesetIds,
        regionalRulesetFamilyIds: bundledRegionalRuleIds,
    });
    if ( patch.changed ) {
        rulesetConfig.enabledRulesets = patch.patchedEnabledRulesets;
    }
    if ( patch.storageChanged ) {
        await Promise.all([
            localWrite(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY, patch.autoRegionalRulesetIds),
            localWrite(
                REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
                patch.regionalRulesetOptOutIds
            ),
        ]);
    }
    return patch;
}

async function syncRegionalRulesetOptOutState(enabledRulesets) {
    const [
        storedAutoRegionalRulesetIds = [],
        storedRegionalOptOutIds = [],
    ] = await Promise.all([
        readLocalStrict(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
        readLocalStrict(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
    ]);
    const patch = reconcileRegionalRulesetOptOutPatch({
        enabledRulesets,
        storedAutoRegionalRulesetIds,
        storedRegionalOptOutIds,
    });
    if ( patch.changed === false ) { return false; }
    await localWrite(
        REGIONAL_RULESET_OPT_OUT_STORAGE_KEY,
        patch.regionalRulesetOptOutIds
    );
    return true;
}

function stopIsolatedRuntimeControllers() {
    const controllerTargets = [
        [ 'TalonRemoteCosmeticsController', [ 'stop', 'clear' ] ],
        [ 'TalonRemoteTacticsBootstrapController', [ 'stop' ] ],
        [ 'TalonNativeHeuristicsController', [ 'stop' ] ],
        [ 'TalonAutomationController', [ 'stop' ] ],
        [ 'TalonPostHideCleanupController', [ 'stop' ] ],
        [ 'TalonAdShellStylesController', [ 'stop' ] ],
        [ 'TalonCssGenericController', [ 'stop' ] ],
        [ 'TalonBlockHintsController', [ 'stop' ] ],
        [ 'TalonShadowRootController', [ 'stop' ] ],
    ];
    const jobs = [];
    for ( const [globalName, methods] of controllerTargets ) {
        const controller = globalThis[globalName];
        if ( controller instanceof Object === false ) { continue; }
        let invoked = false;
        for ( const method of methods ) {
            if ( typeof controller[method] !== 'function' ) { continue; }
            invoked = true;
            jobs.push(Promise.resolve().then(() => controller[method]()));
            break;
        }
        if ( invoked ) { continue; }
    }
    return Promise.all(jobs).then(() => true);
}

function stopMainWorldRuntimeControllers() {
    const controllers = [
        globalThis.TalonRemoteTacticsController,
        globalThis.TalonFrenchStreamSiteFixController,
    ];
    const jobs = [];
    for ( const controller of controllers ) {
        if ( controller instanceof Object === false ) { continue; }
        if ( typeof controller.stop !== 'function' ) { continue; }
        jobs.push(Promise.resolve().then(() => controller.stop()));
    }
    return Promise.all(jobs).then(() => true);
}

const isFrenchStreamSiteFixHostname = hostname =>
    FRENCH_STREAM_SITE_FIX_HOSTNAMES.some(root =>
        hostname === root || hostname.endsWith(`.${root}`)
    );

// Chrome can invalidate an enumerated frame (or its whole tab) between
// webNavigation.getAllFrames() and scripting.executeScript(). These messages
// are deliberately classified only for live runtime reconciliation: making
// them globally ignorable would also hide unrelated extension API failures.
const RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS = Object.freeze([
    /^No tab with id: \d+\.?$/,
    /^No frame with ID: \d+\.?$/,
    /^No frame with id \d+ in tab(?: with id)? \d+\.?$/,
    /^Frame with ID \d+ was removed\.?$/,
    /^Tab containing frame with ID \d+ was removed\.?$/,
    /^Frame with ID \d+ is not ready\.?$/,
    /^Frame with ID \d+ is showing error page\.?$/,
    /^No document with (?:ID|id):? [0-9a-f-]+\.?$/i,
    /^Document with (?:ID|id):? [0-9a-f-]+ (?:was removed|was not found|is not ready)\.?$/i,
]);

const runtimeRefreshErrorMessage = reason => {
    if ( typeof reason?.message === 'string' ) { return reason.message.trim(); }
    if ( typeof reason === 'string' ) { return reason.trim(); }
    return '';
};

const RUNTIME_SCRIPT_TIMEOUT_PREFIX = 'runtime script timeout';
const isRuntimeScriptTimeoutError = reason =>
    runtimeRefreshErrorMessage(reason).startsWith(RUNTIME_SCRIPT_TIMEOUT_PREFIX);

const isRuntimeRefreshTargetUnavailableError = reason => {
    const message = runtimeRefreshErrorMessage(reason);
    if ( message === '' ) { return false; }
    return RUNTIME_REFRESH_TARGET_UNAVAILABLE_PATTERNS.some(
        pattern => pattern.test(message)
    );
};

const isProtectedBrowserStoreUrl = url => {
    if ( typeof url !== 'string' || url === '' ) { return false; }
    try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        if ( hostname === 'chromewebstore.google.com' ) { return true; }
        if (
            hostname === 'chrome.google.com' &&
            parsed.pathname.toLowerCase().startsWith('/webstore')
        ) {
            return true;
        }
        return hostname === 'microsoftedge.microsoft.com' &&
            parsed.pathname.toLowerCase().startsWith('/addons');
    } catch {
    }
    return false;
};

const runtimeUrlHttpOrigin = url => {
    if ( typeof url !== 'string' || url === '' ) { return ''; }
    try {
        const parsed = new URL(url);
        if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ) {
            return parsed.origin;
        }
        if ( parsed.protocol === 'blob:' ) {
            return parsed.origin === 'null' ? '' : parsed.origin;
        }
    } catch {
    }
    return url.match(/^filesystem:(https?:\/\/[^/]+)/i)?.[1] || '';
};

const tabUrlMayHostExtensionRuntime = (url, fileSchemeAccessAllowed = false) => {
    const httpOrigin = runtimeUrlHttpOrigin(url);
    if ( httpOrigin !== '' ) {
        return isProtectedBrowserStoreUrl(/^https?:/i.test(url) ? url : httpOrigin) === false;
    }
    if ( typeof url !== 'string' ) { return false; }
    if ( /^file:/i.test(url) ) { return fileSchemeAccessAllowed === true; }
    return /^(?:blob:|data:|about:(?:blank|srcdoc))/i.test(url);
};

const isUnprovenOpaqueTopRuntimeUrl = url =>
    runtimeUrlHttpOrigin(url) === '' &&
    /^(?:blob:|data:|about:(?:blank|srcdoc)(?:[?#]|$))/i.test(url || '');

const isFileSchemeAccessAllowed = async () => {
    const checker = browser.extension?.isAllowedFileSchemeAccess;
    if ( typeof checker !== 'function' ) { return false; }
    try {
        return await checker.call(browser.extension) === true;
    } catch {
    }
    return false;
};

function readRuntimeDocumentOriginCandidates() {
    const origins = new Set();
    const add = value => {
        if (
            typeof value !== 'string' ||
            value === '' ||
            value.length > 2048 ||
            origins.size >= 8
        ) { return; }
        try {
            const parsed = new URL(value);
            if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ) {
                origins.add(parsed.origin);
                return;
            }
            if (
                (parsed.protocol === 'blob:' || parsed.protocol === 'filesystem:') &&
                /^https?:\/\//i.test(parsed.origin)
            ) {
                origins.add(new URL(parsed.origin).origin);
            }
        } catch {
        }
    };
    add(globalThis.location?.origin);
    add(globalThis.location?.href);
    add(globalThis.document?.referrer);
    for ( const origin of Array.from(globalThis.location?.ancestorOrigins || []) ) {
        add(origin);
    }
    try {
        add(globalThis.opener?.location?.origin);
    } catch {
    }
    return Array.from(origins);
}

async function getRuntimeFrameStates(tabId, fallbackUrl = '') {
    const framesById = new Map();
    if ( typeof fallbackUrl === 'string' && fallbackUrl !== '' ) {
        framesById.set(0, {
            frameId: 0,
            parentFrameId: -1,
            documentId: '',
            documentLifecycle: '',
            url: fallbackUrl,
        });
    }
    const getAllFrames = browser.webNavigation?.getAllFrames;
    if ( typeof getAllFrames === 'function' ) {
        try {
            const frames = await getAllFrames({ tabId });
            for ( const frame of frames || [] ) {
                if ( Number.isInteger(frame?.frameId) === false ) { continue; }
                framesById.set(frame.frameId, {
                    frameId: frame.frameId,
                    parentFrameId: Number.isInteger(frame?.parentFrameId)
                        ? frame.parentFrameId
                        : -1,
                    documentId: typeof frame?.documentId === 'string'
                        ? frame.documentId
                        : '',
                    documentLifecycle:
                        typeof frame?.documentLifecycle === 'string'
                            ? frame.documentLifecycle
                            : '',
                    url: typeof frame?.url === 'string' ? frame.url : '',
                });
            }
        } catch (reason) {
            if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                throw reason;
            }
            throw new Error(`runtimeRefresh/getAllFrames/${reason}`);
        }
    }
    const originFallbackUrl = url => {
        if ( typeof url !== 'string' ) { return false; }
        return /^(?:about:(?:blank|srcdoc)(?:[?#]|$)|data:|blob:|filesystem:)/i
            .test(url);
    };
    const unresolvedOriginFrameCandidates = Array.from(framesById.values()).filter(
        frame =>
            originFallbackUrl(frame.url) &&
            normalizeHttpHostname(frame.url) === '' &&
            runtimeUrlHttpOrigin(frame.url) === '' &&
            typeof frame.documentId === 'string' &&
            frame.documentId !== ''
    );
    const unresolvedTopOriginFrame = unresolvedOriginFrameCandidates.find(
        frame => frame.frameId === 0
    );
    const unresolvedChildOriginFrames = unresolvedOriginFrameCandidates
        .filter(frame => frame.frameId !== 0)
        .sort((a, b) => a.frameId - b.frameId);
    const unresolvedOriginFrames = [
        ...(unresolvedTopOriginFrame === undefined
            ? []
            : [ unresolvedTopOriginFrame ]),
        ...unresolvedChildOriginFrames.slice(0, MAX_OPAQUE_CHILD_ORIGIN_PROBES),
    ];
    for ( const frame of unresolvedChildOriginFrames.slice(
        MAX_OPAQUE_CHILD_ORIGIN_PROBES
    ) ) {
        frame.originProbeAttempted = true;
        frame.originCandidates = [];
        frame.richRuntimeRefreshBlocked = true;
    }
    let nextOriginProbeIndex = 0;
    const probeNextOriginFrame = async () => {
        while ( nextOriginProbeIndex < unresolvedOriginFrames.length ) {
            const frame = unresolvedOriginFrames[nextOriginProbeIndex++];
            frame.originProbeAttempted = true;
            try {
                const results = await executeRuntimeScriptWithTimeout({
                    func: readRuntimeDocumentOriginCandidates,
                    target: { tabId, documentIds: [ frame.documentId ] },
                }, 'runtime origin probe timed out', OPAQUE_ORIGIN_PROBE_TIMEOUT_MS);
                const candidates = results?.[0]?.result;
                frame.originCandidates = Array.isArray(candidates)
                    ? candidates.filter(value => typeof value === 'string')
                    : [];
            } catch (reason) {
                if ( isRuntimeScriptTimeoutError(reason) ) {
                    frame.originCandidates = [];
                    frame.runtimeMutationBlocked = true;
                    frame.richRuntimeRefreshBlocked = true;
                    frame.originProbeTimedOut = true;
                    continue;
                }
                if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                    framesById.delete(frame.frameId);
                    continue;
                }
                // An opaque document whose origin cannot be probed is not a
                // proven matchOriginAsFallback target. Skipping it avoids both
                // cross-origin mode escalation and retries on pages the browser
                // refuses to expose.
                framesById.delete(frame.frameId);
            }
        }
    };
    const originProbeWorkerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        unresolvedOriginFrames.length
    );
    await Promise.all(Array.from(
        { length: originProbeWorkerCount },
        probeNextOriginFrame
    ));
    if ( unresolvedTopOriginFrame?.originProbeTimedOut === true ) {
        throw new Error(
            `${RUNTIME_SCRIPT_TIMEOUT_PREFIX}: opaque top origin probe timed out`
        );
    }
    const fileSchemeAccessAllowed = Array.from(framesById.values()).some(
        frame => /^file:/i.test(frame.url)
    ) ? await isFileSchemeAccessAllowed() : false;
    const resolvedHostnames = new Map();
    const resolveFrameHostname = (frameId, seen = new Set()) => {
        if ( resolvedHostnames.has(frameId) ) {
            return resolvedHostnames.get(frameId);
        }
        if ( seen.has(frameId) ) { return ''; }
        seen.add(frameId);
        const frame = framesById.get(frameId);
        if ( frame === undefined ) { return ''; }
        let hostname = normalizeHttpHostname(frame.url);
        if ( hostname === '' && /^blob:/i.test(frame.url) ) {
            try {
                hostname = normalizeHttpHostname(new URL(frame.url).origin);
            } catch {
            }
        }
        if ( hostname === '' && /^filesystem:/i.test(frame.url) ) {
            const nestedOrigin = frame.url.match(
                /^filesystem:(https?:\/\/[^/]+)/i
            )?.[1];
            hostname = normalizeHttpHostname(nestedOrigin || '');
        }
        if ( hostname === '' && Array.isArray(frame.originCandidates) ) {
            for ( const candidate of frame.originCandidates ) {
                hostname = normalizeHttpHostname(candidate);
                if ( hostname === '' && /^blob:/i.test(candidate) ) {
                    try {
                        hostname = normalizeHttpHostname(new URL(candidate).origin);
                    } catch {
                    }
                }
                if ( hostname !== '' ) { break; }
            }
        }
        if (
            hostname === '' &&
            originFallbackUrl(frame.url) &&
            frame.originProbeAttempted !== true
        ) {
            const parentFrameId = Number(frame.parentFrameId);
            if ( parentFrameId >= 0 ) {
                hostname = resolveFrameHostname(parentFrameId, seen);
            } else if ( frameId !== 0 ) {
                hostname = resolveFrameHostname(0, seen);
            }
        }
        if (
            hostname === '' &&
            /^file:/i.test(frame.url) &&
            fileSchemeAccessAllowed
        ) {
            hostname = 'all-urls';
        }
        resolvedHostnames.set(frameId, hostname);
        return hostname;
    };
    const frames = Array.from(framesById.values()).filter(frame =>
        frame.documentLifecycle === '' || frame.documentLifecycle === 'active'
    ).map(frame => ({
        ...frame,
        hostname: resolveFrameHostname(frame.frameId),
    })).filter(frame =>
        frame.hostname !== '' || frame.originProbeAttempted === true
    );
    const levels = new Map();
    await Promise.all(Array.from(new Set(frames
        .map(frame => frame.hostname)
        .filter(hostname => hostname !== '')
    )).map(
        async hostname => {
            const level = await getFilteringMode(hostname);
            levels.set(hostname, Number(level) || MODE_NONE);
        }
    ));
    return frames.map(frame => ({
        ...frame,
        filteringLevel: frame.hostname === ''
            ? MODE_NONE
            : (levels.get(frame.hostname) ?? MODE_NONE),
    }));
}

const hostnameMatchesRegistrationPatterns = (hostname, patterns) => {
    if ( typeof hostname !== 'string' || hostname === '' ) { return false; }
    if ( Array.isArray(patterns) === false ) { return false; }
    for ( const root of hostnamesFromMatches(patterns) ) {
        if ( root === 'all-urls' || root === '*' ) { return true; }
        if ( hostname === root || hostname.endsWith(`.${root}`) ) { return true; }
    }
    return false;
};

const cosmeticRegistrationMatchesFrame = (registration, frame) => {
    if ( registration instanceof Object === false ) { return false; }
    if ( frame instanceof Object === false ) { return false; }
    if (
        hostnameMatchesRegistrationPatterns(
            frame.hostname,
            registration.matches
        ) === false
    ) {
        return false;
    }
    return hostnameMatchesRegistrationPatterns(
        frame.hostname,
        registration.excludeMatches
    ) === false;
};

async function getRegisteredCoreCosmeticDirectives() {
    if ( typeof browser.scripting?.getRegisteredContentScripts !== 'function' ) {
        throw new Error('registered content-script API unavailable');
    }
    const registrations = await browser.scripting.getRegisteredContentScripts();
    if ( Array.isArray(registrations) === false ) {
        throw new Error('invalid registered content-script response');
    }
    const byId = new Map();
    for ( const entry of registrations ) {
        if ( CORE_COSMETIC_REGISTRATION_ID_SET.has(entry?.id) === false ) {
            continue;
        }
        const normalized = normalizeContentScriptRegistration(entry);
        if ( normalized.js.length === 0 ) { continue; }
        byId.set(normalized.id, normalized);
    }
    return CORE_COSMETIC_REGISTRATION_IDS
        .map(id => byId.get(id))
        .filter(entry => entry !== undefined);
}

function stagePreparedCustomFilterDetails(details) {
    globalThis.TalonStagedCustomFilterDetails = details;
    return true;
}

function hasLegacyCosmeticRuntime() {
    const api = globalThis.cssAPI;
    return api !== null &&
        typeof api === 'object' &&
        api.supportsScopedOwnership !== true;
}

function readIrreversibleCustomProceduralSelectors(details) {
    const source = details instanceof Object
        ? details
        : globalThis.customFilters || globalThis.TalonPendingCustomFilterDetails;
    const selectors = Array.isArray(source?.proceduralSelectors)
        ? source.proceduralSelectors
        : [];
    const irreversible = [];
    for ( const selector of selectors ) {
        let parsed = selector;
        if ( typeof selector === 'string' ) {
            try {
                parsed = JSON.parse(selector);
            } catch {
                continue;
            }
        }
        const operation = Array.isArray(parsed?.action)
            ? parsed.action[0]
            : '';
        if (
            operation !== 'remove' &&
            operation !== 'remove-attr' &&
            operation !== 'remove-class'
        ) {
            continue;
        }
        irreversible.push(typeof selector === 'string'
            ? selector
            : JSON.stringify(selector));
    }
    irreversible.sort();
    return irreversible;
}

function readIrreversibleCoreProceduralSelectors() {
    const irreversible = [];
    const filterers = [
        globalThis.listsCompiledProceduralFiltererAPI?.proceduralFilterer,
        globalThis.listsSpecificProceduralFiltererAPI?.proceduralFilterer,
    ];
    for ( const filterer of filterers ) {
        const selectors = Array.isArray(filterer?.selectors)
            ? filterer.selectors
            : [];
        for ( const selector of selectors ) {
            const operation = Array.isArray(selector?.action)
                ? selector.action[0]
                : '';
            if (
                operation !== 'remove' &&
                operation !== 'remove-attr' &&
                operation !== 'remove-class'
            ) {
                continue;
            }
            const raw = typeof selector?.raw === 'string'
                ? selector.raw
                : '';
            irreversible.push(`${operation}:${raw}`);
        }
    }
    irreversible.sort();
    return irreversible;
}

async function getIrreversibleProceduralRuntimeByFrame(
    tabId,
    frameTargets,
    reader
) {
    const byFrameId = new Map();
    const batches = runtimeTargetBatches(frameTargets);
    let nextIndex = 0;
    let firstFailure;
    const inspectNext = async () => {
        while ( nextIndex < batches.length ) {
            const targets = batches[nextIndex++];
            try {
                const results = await executeRuntimeScriptTargetBatch(
                    tabId,
                    targets,
                    { func: reader }
                );
                for ( const result of results || [] ) {
                    if ( Number.isInteger(result?.frameId) === false ) { continue; }
                    const selectors = Array.isArray(result?.result)
                        ? result.result.filter(value => typeof value === 'string')
                        : [];
                    byFrameId.set(result.frameId, selectors.sort());
                }
            } catch (reason) {
                if ( isRuntimeRefreshTargetUnavailableError(reason) ) { continue; }
                firstFailure ||= reason;
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        batches.length
    );
    await Promise.all(Array.from({ length: workerCount }, inspectNext));
    if ( firstFailure !== undefined ) { throw firstFailure; }
    return byFrameId;
}

const getIrreversibleCustomProceduralRuntimeByFrame = (tabId, frameTargets) =>
    getIrreversibleProceduralRuntimeByFrame(
        tabId,
        frameTargets,
        readIrreversibleCustomProceduralSelectors
    );

const getIrreversibleCoreProceduralRuntimeByFrame = (tabId, frameTargets) =>
    getIrreversibleProceduralRuntimeByFrame(
        tabId,
        frameTargets,
        readIrreversibleCoreProceduralSelectors
    );

const stringArraysEqual = (left, right) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);

async function tabHasLegacyCosmeticRuntime(tabId, frameTargets) {
    const batches = runtimeTargetBatches(frameTargets);
    let nextIndex = 0;
    let legacyFound = false;
    let firstFailure;
    const inspectNext = async () => {
        while ( nextIndex < batches.length ) {
            const targets = batches[nextIndex++];
            try {
                const results = await executeRuntimeScriptTargetBatch(
                    tabId,
                    targets,
                    { func: hasLegacyCosmeticRuntime }
                );
                if ( results?.some(entry => entry?.result === true) ) {
                    legacyFound = true;
                }
            } catch (reason) {
                if ( isRuntimeRefreshTargetUnavailableError(reason) ) { continue; }
                firstFailure ||= reason;
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        batches.length
    );
    await Promise.all(Array.from({ length: workerCount }, inspectNext));
    if ( firstFailure !== undefined ) { throw firstFailure; }
    return legacyFound;
}

async function refreshFrenchStreamSiteFixForTab(
    tabId,
    hostname,
    frameStates,
    { siteFixEnabled = false, sourceAllowed = true } = {}
) {
    if ( isFrenchStreamSiteFixHostname(hostname) === false ) { return false; }
    if ( siteFixEnabled === false || sourceAllowed === false ) { return false; }
    const frameTargets = frameStates
        .filter(frame =>
            frame.filteringLevel !== MODE_NONE &&
            isFrenchStreamSiteFixHostname(frame.hostname)
        )
        .map(frame => ({
            frameId: frame.frameId,
            documentId: frame.documentId,
        }));
    if ( frameTargets.length === 0 ) { return false; }
    await executeRuntimeRefreshLane(
        tabId,
        [ FRENCH_STREAM_SITE_FIX_MAIN_PATH ],
        {
        frameTargets,
        world: 'MAIN',
        injectImmediately: true,
        }
    );
    return true;
}

async function resolveRuntimeLaneFrameIds(
    tabId,
    frameIds,
    allFrames,
    frameTargets
) {
    if ( Array.isArray(frameTargets) ) {
        const seen = new Set();
        const out = [];
        for ( const target of frameTargets ) {
            const frameId = Number(target?.frameId);
            const documentId = typeof target?.documentId === 'string'
                ? target.documentId
                : '';
            if ( Number.isInteger(frameId) === false ) { continue; }
            const key = documentId === '' ? `frame:${frameId}` : `document:${documentId}`;
            if ( seen.has(key) ) { continue; }
            seen.add(key);
            out.push({ frameId, documentId });
        }
        return out.sort((a, b) => a.frameId - b.frameId);
    }
    if ( Array.isArray(frameIds) ) {
        return Array.from(new Set(
            frameIds.filter(frameId => Number.isInteger(frameId))
        )).sort((a, b) => a - b);
    }
    if ( allFrames !== true ) { return [ 0 ]; }
    if ( typeof browser.webNavigation?.getAllFrames !== 'function' ) {
        return undefined;
    }
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    if ( Array.isArray(frames) === false ) {
        throw new Error('runtime lane received invalid frame state');
    }
    const targets = [];
    const seen = new Set();
    for ( const frame of frames ) {
        if ( Number.isInteger(frame?.frameId) === false ) { continue; }
        const documentId = typeof frame?.documentId === 'string'
            ? frame.documentId
            : '';
        const key = documentId === ''
            ? `frame:${frame.frameId}`
            : `document:${documentId}`;
        if ( seen.has(key) ) { continue; }
        seen.add(key);
        targets.push({ frameId: frame.frameId, documentId });
    }
    targets.sort((a, b) => a.frameId - b.frameId);
    return targets.length === 0 ? [ 0 ] : targets;
}

const runtimeTargetBatches = frameIds => {
    const documentTargets = [];
    const frameTargets = [];
    for ( const runtimeTarget of frameIds ) {
        const frameId = Number.isInteger(runtimeTarget)
            ? runtimeTarget
            : runtimeTarget?.frameId;
        const documentId = Number.isInteger(runtimeTarget)
            ? ''
            : runtimeTarget?.documentId;
        if ( typeof documentId === 'string' && documentId !== '' ) {
            documentTargets.push({ frameId, documentId });
        } else if ( Number.isInteger(frameId) ) {
            frameTargets.push({ frameId, documentId: '' });
        }
    }
    const batches = [];
    for (
        let i = 0;
        i < documentTargets.length;
        i += RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE
    ) {
        batches.push(documentTargets.slice(i, i + RUNTIME_SCRIPT_DOCUMENT_BATCH_SIZE));
    }
    for ( const target of frameTargets ) { batches.push([ target ]); }
    return batches;
};

async function executeRuntimeScriptTargetBatch(tabId, targets, details) {
    if ( targets.length === 0 ) { return []; }
    const documentIds = targets.map(target => target.documentId)
        .filter(value => value !== '');
    const target = documentIds.length === targets.length
        ? { tabId, documentIds }
        : { tabId, frameIds: targets.map(value => value.frameId) };
    try {
        const results = await executeRuntimeScriptWithTimeout({
            ...details,
            target,
        });
        if ( targets.length === 1 ) { return results || []; }
        const completed = new Set((results || []).map(result =>
            documentIds.length === targets.length
                ? result?.documentId
                : result?.frameId
        ));
        const missing = targets.filter(runtimeTarget =>
            completed.has(documentIds.length === targets.length
                ? runtimeTarget.documentId
                : runtimeTarget.frameId) === false
        );
        if ( missing.length === 0 ) { return results || []; }
        if ( missing.length === targets.length ) {
            const midpoint = Math.ceil(missing.length / 2);
            const first = await executeRuntimeScriptTargetBatch(
                tabId,
                missing.slice(0, midpoint),
                details
            );
            const second = await executeRuntimeScriptTargetBatch(
                tabId,
                missing.slice(midpoint),
                details
            );
            return [ ...(results || []), ...first, ...second ];
        }
        const retried = await executeRuntimeScriptTargetBatch(
            tabId,
            missing,
            details
        );
        return [ ...(results || []), ...retried ];
    } catch (reason) {
        if ( isRuntimeRefreshTargetUnavailableError(reason) === false ) {
            throw reason;
        }
        if ( targets.length === 1 ) { return []; }
        const midpoint = Math.ceil(targets.length / 2);
        const first = await executeRuntimeScriptTargetBatch(
            tabId,
            targets.slice(0, midpoint),
            details
        );
        const second = await executeRuntimeScriptTargetBatch(
            tabId,
            targets.slice(midpoint),
            details
        );
        return [ ...first, ...second ];
    }
}

async function executeScriptPerRuntimeFrame(tabId, frameIds, details) {
    const batches = runtimeTargetBatches(frameIds);
    let nextIndex = 0;
    let firstFailure;
    const executeNext = async () => {
        while ( nextIndex < batches.length ) {
            const targets = batches[nextIndex++];
            try {
                await executeRuntimeScriptTargetBatch(tabId, targets, details);
            } catch (reason) {
                firstFailure ||= reason;
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        batches.length
    );
    await Promise.all(Array.from({ length: workerCount }, executeNext));
    if ( firstFailure !== undefined ) { throw firstFailure; }
    return true;
}

async function awaitNamedRuntimeReadiness(globalNames) {
    const maxReadinessTransitions = 8;
    const awaitStableReadiness = async globalName => {
        for ( let transition = 0; transition <= maxReadinessTransitions; transition++ ) {
            const readiness = globalThis[globalName];
            if ( readiness === null || typeof readiness?.then !== 'function' ) {
                throw new Error(`runtime readiness unavailable: ${globalName}`);
            }
            await readiness;
            if ( globalThis[globalName] === readiness ) { return true; }
        }
        throw new Error(`runtime readiness did not quiesce: ${globalName}`);
    };
    await Promise.all((globalNames || []).map(awaitStableReadiness));
    return true;
}

async function executeRuntimeRefreshLane(
    tabId,
    files,
    {
        allFrames = false,
        frameIds,
        frameTargets,
        readinessGlobals = [],
        ...options
    } = {}
) {
    if ( Array.isArray(files) === false || files.length === 0 ) { return false; }
    const targets = await resolveRuntimeLaneFrameIds(
        tabId,
        frameIds,
        allFrames,
        frameTargets
    );
    if ( Array.isArray(targets) && targets.length === 0 ) { return false; }
    if ( targets === undefined ) {
        await executeRuntimeScriptWithTimeout({
            files,
            target: { tabId, allFrames: true },
            ...options,
        });
        if ( readinessGlobals.length !== 0 ) {
            await executeRuntimeScriptWithTimeout({
                func: awaitNamedRuntimeReadiness,
                args: [ readinessGlobals ],
                target: { tabId, allFrames: true },
                ...options,
            }, 'runtime readiness timed out');
        }
        return true;
    }
    await executeScriptPerRuntimeFrame(tabId, targets, { files, ...options });
    if ( readinessGlobals.length !== 0 ) {
        await executeScriptPerRuntimeFrame(tabId, targets, {
            func: awaitNamedRuntimeReadiness,
            args: [ readinessGlobals ],
            ...options,
        });
    }
    return true;
}

async function executeRuntimeStopLane(
    tabId,
    func,
    { frameIds, frameTargets, allFrames = true, ...options } = {}
) {
    const targets = await resolveRuntimeLaneFrameIds(
        tabId,
        frameIds,
        allFrames,
        frameTargets
    );
    if ( Array.isArray(targets) && targets.length === 0 ) { return false; }
    if ( targets === undefined ) {
        await executeRuntimeScriptWithTimeout({
            func,
            target: { tabId, allFrames: true },
            ...options,
        });
        return true;
    }
    return executeScriptPerRuntimeFrame(tabId, targets, { func, ...options });
}

function stopRemoteCosmeticsGlobalController() {
    const controller = globalThis.TalonRemoteCosmeticsController;
    if ( controller instanceof Object === false ) { return Promise.resolve(true); }
    if ( typeof controller.stop === 'function' ) {
        try {
            return Promise.resolve(controller.stop({ scope: 'global' })).then(() => true);
        } catch {
        }
    }
    if ( typeof controller.clear === 'function' ) {
        try {
            return Promise.resolve(controller.clear({ scope: 'global' })).then(() => true);
        } catch {
        }
    }
    return Promise.resolve(true);
}

function stopRemoteCosmeticsHostController() {
    const controller = globalThis.TalonRemoteCosmeticsController;
    if ( controller instanceof Object === false ) { return Promise.resolve(true); }
    if ( typeof controller.stop === 'function' ) {
        try {
            return Promise.resolve(controller.stop({ scope: 'host' })).then(() => true);
        } catch {
        }
    }
    if ( typeof controller.clear === 'function' ) {
        try {
            return Promise.resolve(controller.clear({ scope: 'host' })).then(() => true);
        } catch {
        }
    }
    return Promise.resolve(true);
}

function stopRemoteTacticsBootstrapController() {
    const controller = globalThis.TalonRemoteTacticsBootstrapController;
    if ( controller instanceof Object === false ) { return Promise.resolve(true); }
    if ( typeof controller.stop !== 'function' ) { return Promise.resolve(true); }
    try {
        return Promise.resolve(controller.stop()).then(() => true);
    } catch {
    }
    return Promise.resolve(true);
}

function stopCompleteModeRuntimeControllers() {
    const controller = globalThis.TalonCssGenericController;
    const jobs = [];
    if ( controller instanceof Object && typeof controller.stop === 'function' ) {
        jobs.push(Promise.resolve().then(() => controller.stop()));
    }
    if ( globalThis.cssAPI instanceof Object ) {
        jobs.push(Promise.resolve().then(() =>
            globalThis.cssAPI.removeAll?.('generic')
        ));
    }
    return Promise.all(jobs).then(() => true);
}

function stopNamedRuntimeControllers(globalNames) {
    const jobs = [];
    for ( const globalName of globalNames || [] ) {
        const controller = globalThis[globalName];
        if ( controller instanceof Object === false ) { continue; }
        const method = typeof controller.stop === 'function'
            ? 'stop'
            : typeof controller.clear === 'function'
                ? 'clear'
                : '';
        if ( method === '' ) { continue; }
        try {
            jobs.push(Promise.resolve(controller[method]()));
        } catch {
        }
    }
    return Promise.all(jobs).then(() => true);
}

const topFrameSuppressedControllerNames = hostname => {
    const names = [];
    if ( hasActiveSubsystemBackoff(hostname, 'nativeHeuristics') ) {
        names.push('TalonNativeHeuristicsController');
    }
    if (
        automationRuntimeRegistered === false ||
        hasActiveSubsystemBackoff(hostname, 'automation')
    ) {
        names.push('TalonAutomationController');
    }
    if ( hasActiveSubsystemBackoff(hostname, 'postHideCleanup') ) {
        names.push('TalonPostHideCleanupController');
    }
    if ( hasActiveSubsystemBackoff(hostname, 'adShellStyles') ) {
        names.push('TalonAdShellStylesController');
    }
    return names;
};

const topFrameLiveRuntimeFiles = (hostname, filteringLevel) => {
    if ( filteringLevel === MODE_BASIC ) {
        return hasActiveSubsystemBackoff(hostname, 'adShellStyles')
            ? []
            : BASIC_TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES;
    }
    if ( filteringLevel < MODE_OPTIMAL ) { return []; }
    const suppressedFiles = new Set();
    if ( hasActiveSubsystemBackoff(hostname, 'nativeHeuristics') ) {
        suppressedFiles.add('/js/scripting/native-heuristics.js');
    }
    if (
        automationRuntimeRegistered === false ||
        hasActiveSubsystemBackoff(hostname, 'automation')
    ) {
        suppressedFiles.add('/js/scripting/automation.js');
    }
    if ( hasActiveSubsystemBackoff(hostname, 'postHideCleanup') ) {
        suppressedFiles.add('/js/scripting/post-hide-cleanup.js');
    }
    if ( hasActiveSubsystemBackoff(hostname, 'adShellStyles') ) {
        suppressedFiles.add('/js/scripting/ad-shell-styles.js');
    }
    return TOP_FRAME_LIVE_RUNTIME_REFRESH_FILES.filter(
        file => suppressedFiles.has(file) === false
    );
};

const topFrameLiveRuntimeReadinessGlobals = files => {
    const names = [];
    if ( files.includes('/js/scripting/native-heuristics.js') ) {
        names.push('TalonNativeHeuristicsReady');
    }
    if ( files.includes('/js/scripting/automation.js') ) {
        names.push('TalonAutomationReady');
    }
    if ( files.includes('/js/scripting/post-hide-cleanup.js') ) {
        names.push('TalonPostHideCleanupReady');
    }
    if ( files.includes('/js/scripting/ad-shell-styles.js') ) {
        names.push('TalonAdShellStylesReady');
    }
    return names;
};

async function refreshRuntimeStateForTab(
    tabId,
    filteringLevel,
    {
        url = '',
        hostname = '',
        hasGlobalRemoteCosmetics = false,
        remoteCosmeticHostnames = new Set(),
        siteFixEnabled = false,
        frenchStreamSourceAllowed = true,
        refreshCustomFilters = false,
        refreshCoreCosmetics = false,
        coreCosmeticDirectives = [],
        desiredFingerprint = '',
        expectedTabGeneration,
    } = {}
) {
    if ( browser.scripting?.executeScript === undefined ) { return false; }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
    }
    try {
        const frameStates = await getRuntimeFrameStates(tabId, url);
        if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
            return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
        }
        if (
            frameStates.length === 0 &&
            isUnprovenOpaqueTopRuntimeUrl(url)
        ) {
            const identity = await getActiveTopDocumentIdentity(tabId, url);
            return {
                ok: true,
                skipped: 'unproven_opaque_document',
                topDocumentId: identity?.documentId || '',
            };
        }
        if ( frameStates.some(frame => frame.documentId === '') ) {
            throw new Error('runtime refresh document identity unavailable');
        }
        const topFrameState = frameStates.find(frame => frame.frameId === 0);
        if ( topFrameState === undefined ) {
            throw new Error('runtime refresh top document unavailable');
        }
        const childOriginProbeTimedOut = frameStates.some(frame =>
            frame.frameId !== 0 && frame.originProbeTimedOut === true
        );
        if ( childOriginProbeTimedOut ) {
            await deferRuntimeDocuments([{
                tabId,
                topDocumentId: topFrameState.documentId,
                operation: 'refresh',
                desiredFingerprint,
                expectedTabGeneration,
            }]);
            await scheduleDeferredRuntimeRetry().catch(() => {});
        }
        const runtimeFrameStates = [
            topFrameState,
            ...frameStates.filter(frame =>
                frame.frameId !== 0 &&
                frame.runtimeMutationBlocked !== true &&
                frame.richRuntimeRefreshBlocked !== true
            ).sort((a, b) => a.frameId - b.frameId)
                .slice(0, MAX_LIVE_RUNTIME_FRAME_TARGETS - 1),
        ];
        // The tab may have navigated after tabs.query(). Bind every decision to
        // the URL/mode from the same document snapshot used for injection.
        hostname = topFrameState.hostname;
        filteringLevel = topFrameState.filteringLevel;
        url = topFrameState.url;
        const frameTargetById = new Map(runtimeFrameStates.map(frame => [
            frame.frameId,
            { frameId: frame.frameId, documentId: frame.documentId },
        ]));
        const frameTargetsFromIds = frameIds => frameIds
            .map(frameId => frameTargetById.get(frameId))
            .filter(target => target !== undefined);
        const allFrameIds = runtimeFrameStates.map(frame => frame.frameId);
        const allFrameTargets = frameTargetsFromIds(allFrameIds);
        const runtimeFrameIdSet = new Set(allFrameIds);
        const overflowFrameTargets = frameStates.filter(frame =>
            runtimeFrameIdSet.has(frame.frameId) === false &&
            frame.runtimeMutationBlocked !== true &&
            typeof frame.documentId === 'string' &&
            frame.documentId !== ''
        ).map(frame => ({
            frameId: frame.frameId,
            documentId: frame.documentId,
        }));
        if ( overflowFrameTargets.length !== 0 ) {
            await executeRuntimeRefreshLane(
                tabId,
                [ '/js/scripting/css-runtime-terminate.js' ],
                { frameTargets: overflowFrameTargets }
            );
            await executeRuntimeStopLane(tabId, stopIsolatedRuntimeControllers, {
                frameTargets: overflowFrameTargets,
            });
            await executeRuntimeStopLane(tabId, stopMainWorldRuntimeControllers, {
                frameTargets: overflowFrameTargets,
                world: 'MAIN',
            });
        }
        const remoteEligibleFrameIds = runtimeFrameStates
            .filter(frame =>
                frame.filteringLevel >= MODE_OPTIMAL &&
                hasActiveSubsystemBackoff(
                    frame.hostname,
                    'remoteCosmetics'
                ) === false
            )
            .map(frame => frame.frameId);
        const nonRemoteEligibleFrameIds = runtimeFrameStates
            .filter(frame => remoteEligibleFrameIds.includes(frame.frameId) === false)
            .map(frame => frame.frameId);
        const nonCompleteFrameIds = runtimeFrameStates
            .filter(frame => frame.filteringLevel < MODE_COMPLETE)
            .map(frame => frame.frameId);

        if (
            (refreshCoreCosmetics || refreshCustomFilters) &&
            await tabHasLegacyCosmeticRuntime(tabId, allFrameTargets)
        ) {
            await markReloadNeededForTab(
                tabId,
                'legacy_cosmetic_runtime',
                topFrameState.documentId
            );
            return {
                deferred: true,
                reason: 'legacy_cosmetic_runtime',
                topDocumentId: topFrameState.documentId,
            };
        }

        if ( refreshCoreCosmetics && allFrameTargets.length !== 0 ) {
            const irreversibleCoreRuntime = Array.from(
                (await getIrreversibleCoreProceduralRuntimeByFrame(
                    tabId,
                    allFrameTargets
                )).values()
            ).some(selectors => selectors.length !== 0);
            if ( irreversibleCoreRuntime ) {
                // Packaged procedural remove/remove-attr/remove-class actions
                // are DOM mutations, not owned CSS. Stop their observers but
                // require a document reload before claiming the new core
                // cosmetic configuration is active.
                await executeRuntimeRefreshLane(
                    tabId,
                    [ CORE_COSMETIC_TERMINATOR_PATH ],
                    { frameTargets: allFrameTargets }
                );
                await markReloadNeededForTab(
                    tabId,
                    'irreversible_core_procedural',
                    topFrameState.documentId
                );
                return {
                    deferred: true,
                    reason: 'irreversible_core_procedural',
                    topDocumentId: topFrameState.documentId,
                };
            }
        }

        if ( refreshCoreCosmetics && allFrameIds.length !== 0 ) {
            await executeRuntimeRefreshLane(
                tabId,
                [ CORE_COSMETIC_TERMINATOR_PATH ],
                { frameTargets: allFrameTargets }
            );
            const restorationFailures = [];
            for ( const directive of coreCosmeticDirectives ) {
                const generic = directive.id === 'css-generic-all' ||
                    directive.id === 'css-generic-some';
                const directiveFrameIds = runtimeFrameStates.filter(frame =>
                    frame.filteringLevel >= (
                        generic ? MODE_COMPLETE : MODE_OPTIMAL
                    ) && cosmeticRegistrationMatchesFrame(directive, frame)
                ).map(frame => frame.frameId);
                if ( directiveFrameIds.length === 0 ) { continue; }
                try {
                    await executeRuntimeRefreshLane(tabId, directive.js, {
                        frameTargets: frameTargetsFromIds(directiveFrameIds),
                        world: directive.world,
                        injectImmediately: true,
                    });
                } catch (reason) {
                    // The terminator has already removed every core cosmetic
                    // lane. Keep restoring independent directives so one
                    // transient failure cannot leave the remainder of the
                    // page bare until the deferred retry.
                    restorationFailures.push(reason);
                }
            }
            if ( restorationFailures.length !== 0 ) {
                throw new AggregateError(
                    restorationFailures,
                    'core cosmetic restoration was incomplete'
                );
            }
        }

        if ( refreshCustomFilters && runtimeFrameStates.length !== 0 ) {
            // Resolve every authoritative custom-filter read before removing
            // the currently applied styles. A transient storage failure must
            // leave the last known-good page state intact for the next retry.
            const preparedByFrameId = new Map();
            const desiredIrreversibleByFrameId = new Map();
            const activeIrreversibleByFrameId =
                await getIrreversibleCustomProceduralRuntimeByFrame(
                    tabId,
                    allFrameTargets
                );
            await Promise.all(runtimeFrameStates.map(async frame => {
                const details = frame.filteringLevel === MODE_NONE
                    ? { plainSelectors: [], proceduralSelectors: [] }
                    : await prepareCustomFilterDetails(frame.hostname);
                desiredIrreversibleByFrameId.set(
                    frame.frameId,
                    readIrreversibleCustomProceduralSelectors(details)
                );
                if (
                    details.plainSelectors.length === 0 &&
                    details.proceduralSelectors.length === 0
                ) {
                    return;
                }
                preparedByFrameId.set(frame.frameId, {
                    details,
                    documentId: frame.documentId,
                    hostname: frame.hostname,
                });
            }));
            const irreversibleMutationCannotBeReversed = Array.from(
                activeIrreversibleByFrameId
            ).some(([ frameId, activeSelectors ]) =>
                activeSelectors.length !== 0 &&
                stringArraysEqual(
                    activeSelectors,
                    desiredIrreversibleByFrameId.get(frameId) || []
                ) === false
            );
            if ( irreversibleMutationCannotBeReversed ) {
                // remove/remove-attr/remove-class change the page DOM rather
                // than an owned stylesheet. Stop their observers immediately,
                // but never claim that a live refresh reconstructed data which
                // the page has already lost. The exact document (and its
                // BFCache descendants through the wildcard ledger) must reload.
                await executeRuntimeRefreshLane(
                    tabId,
                    [ '/js/scripting/css-user-terminate.js' ],
                    { frameTargets: allFrameTargets }
                );
                await markReloadNeededForTab(
                    tabId,
                    'irreversible_custom_procedural',
                    topFrameState.documentId
                );
                return {
                    deferred: true,
                    reason: 'irreversible_custom_procedural',
                    topDocumentId: topFrameState.documentId,
                };
            }
            await executeRuntimeRefreshLane(
                tabId,
                [ '/js/scripting/css-user-terminate.js' ],
                { frameTargets: allFrameTargets }
            );
            const restorationFailures = [];
            for ( const [ frameId, prepared ] of preparedByFrameId ) {
                let details;
                try {
                    details = await injectCustomFilters(
                        tabId,
                        frameId,
                        prepared.hostname,
                        prepared.details,
                        prepared.documentId,
                        scriptDetails => executeRuntimeScriptWithTimeout(
                            scriptDetails,
                            'open-tab custom filter API timed out'
                        )
                    );
                } catch (reason) {
                    // A child document can disappear after the authoritative
                    // read and all-frame termination. Continue restoring the
                    // remaining stable documents instead of falsely treating
                    // the whole tab as refreshed with later frames left bare.
                    if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                        continue;
                    }
                    restorationFailures.push(reason);
                    continue;
                }
                if ( details === false ) { continue; }
                try {
                    await executeRuntimeStopLane(
                        tabId,
                        stagePreparedCustomFilterDetails,
                        {
                            allFrames: false,
                            frameTargets: frameTargetsFromIds([ frameId ]),
                            args: [ details ],
                        }
                    );
                    await executeRuntimeRefreshLane(
                        tabId,
                        [
                            '/js/scripting/css-api.js',
                            '/js/scripting/css-procedural-api.js',
                            '/js/scripting/css-user.js',
                        ],
                        { frameTargets: frameTargetsFromIds([ frameId ]) }
                    );
                } catch (reason) {
                    await executeRuntimeRefreshLane(
                        tabId,
                        [ '/js/scripting/css-user-terminate.js' ],
                        { frameTargets: frameTargetsFromIds([ frameId ]) }
                    ).catch(ubolErr);
                    restorationFailures.push(reason);
                }
            }
            if ( restorationFailures.length !== 0 ) {
                throw new AggregateError(
                    restorationFailures,
                    'custom cosmetic restoration was incomplete'
                );
            }
        }

        if ( filteringLevel === MODE_NONE ) {
            await executeRuntimeStopLane(tabId, stopIsolatedRuntimeControllers, {
                frameTargets: frameTargetsFromIds([ 0 ]),
            });
        } else {
            const controllerNames = topFrameSuppressedControllerNames(hostname);
            if ( filteringLevel === MODE_BASIC ) {
                controllerNames.push(
                    'TalonNativeHeuristicsController',
                    'TalonAutomationController',
                    'TalonPostHideCleanupController',
                    'TalonShadowRootController'
                );
            }
            if ( controllerNames.length !== 0 ) {
                await executeRuntimeStopLane(tabId, stopNamedRuntimeControllers, {
                    frameTargets: frameTargetsFromIds([ 0 ]),
                    args: [ Array.from(new Set(controllerNames)) ],
                });
            }
            const topFrameFiles = topFrameLiveRuntimeFiles(
                hostname,
                filteringLevel
            );
            await executeRuntimeRefreshLane(tabId, topFrameFiles, {
                frameTargets: frameTargetsFromIds([ 0 ]),
                readinessGlobals:
                    topFrameLiveRuntimeReadinessGlobals(topFrameFiles),
            });
        }

        if ( hasGlobalRemoteCosmetics && remoteEligibleFrameIds.length !== 0 ) {
            await executeRuntimeRefreshLane(
                tabId,
                REMOTE_COSMETICS_GLOBAL_LIVE_RUNTIME_REFRESH_FILES,
                {
                    frameTargets: frameTargetsFromIds(remoteEligibleFrameIds),
                    readinessGlobals: [ 'TalonRemoteCosmeticsGlobalReady' ],
                }
            );
        }
        if ( hasGlobalRemoteCosmetics === false ) {
            await executeRuntimeStopLane(tabId, stopRemoteCosmeticsGlobalController, {
                frameTargets: allFrameTargets,
            });
        } else if ( nonRemoteEligibleFrameIds.length !== 0 ) {
            await executeRuntimeStopLane(tabId, stopRemoteCosmeticsGlobalController, {
                frameTargets: frameTargetsFromIds(nonRemoteEligibleFrameIds),
            });
        }

        const hostFrameIdSet = new Set(runtimeFrameStates
            .filter(frame =>
                frame.filteringLevel >= MODE_OPTIMAL &&
                hasActiveSubsystemBackoff(
                    frame.hostname,
                    'remoteCosmetics'
                ) === false &&
                remoteCosmeticHostnames.has(frame.hostname)
            )
            .map(frame => frame.frameId));
        const hostFrameIds = Array.from(hostFrameIdSet);
        const nonHostFrameIds = runtimeFrameStates
            .filter(frame => hostFrameIdSet.has(frame.frameId) === false)
            .map(frame => frame.frameId);
        if ( hostFrameIds.length !== 0 ) {
            await executeRuntimeRefreshLane(
                tabId,
                REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES,
                {
                    frameTargets: frameTargetsFromIds(hostFrameIds),
                    readinessGlobals: [ 'TalonRemoteCosmeticsHostReady' ],
                }
            );
        }
        if ( nonHostFrameIds.length !== 0 ) {
            await executeRuntimeStopLane(tabId, stopRemoteCosmeticsHostController, {
                frameTargets: frameTargetsFromIds(nonHostFrameIds),
            });
        }
        const activeRemoteFrameIds = new Set(hostFrameIds);
        if ( hasGlobalRemoteCosmetics ) {
            for ( const frameId of remoteEligibleFrameIds ) {
                activeRemoteFrameIds.add(frameId);
            }
        }
        const inactiveRemoteChildFrameIds = runtimeFrameStates
            .filter(frame =>
                frame.frameId !== 0 &&
                activeRemoteFrameIds.has(frame.frameId) === false
            )
            .map(frame => frame.frameId);
        if ( inactiveRemoteChildFrameIds.length !== 0 ) {
            await executeRuntimeStopLane(tabId, stopNamedRuntimeControllers, {
                frameTargets: frameTargetsFromIds(inactiveRemoteChildFrameIds),
                args: [[
                    'TalonShadowRootController',
                    'TalonBlockHintsController',
                ]],
            });
        }

        if ( nonCompleteFrameIds.length !== 0 ) {
            await executeRuntimeStopLane(tabId, stopCompleteModeRuntimeControllers, {
                frameTargets: frameTargetsFromIds(nonCompleteFrameIds),
            });
        }
        await executeRuntimeStopLane(tabId, stopRemoteTacticsBootstrapController, {
            frameTargets: allFrameTargets,
        });
        await executeRuntimeStopLane(tabId, stopMainWorldRuntimeControllers, {
            frameTargets: allFrameTargets,
            world: 'MAIN',
        });
        if ( filteringLevel !== MODE_NONE ) {
            await refreshFrenchStreamSiteFixForTab(tabId, hostname, frameStates, {
                siteFixEnabled,
                sourceAllowed: frenchStreamSourceAllowed,
            });
        }
        return {
            ok: true,
            deferred: childOriginProbeTimedOut,
            reason: childOriginProbeTimedOut
                ? 'opaque_child_origin_probe_timeout'
                : undefined,
            topDocumentId: topFrameState.documentId,
        };
    } catch (reason) {
        throw reason;
    }
}

async function recoverRuntimeTabFailure(
    tab,
    reason,
    operation,
    desiredFingerprint = '',
    expectedTabGeneration
) {
    const tabId = Number(tab?.id);
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return 'unavailable'; }
    const tabGeneration = expectedTabGeneration === undefined
        ? getRuntimeTabLifecycleGeneration(tabId)
        : expectedTabGeneration;
    if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
        return 'unavailable';
    }
    let tabState;
    try {
        tabState = await browser.tabs?.get?.(tabId);
    } catch (lookupReason) {
        if ( isRuntimeRefreshTargetUnavailableError(lookupReason) ) {
            return 'unavailable';
        }
        throw new AggregateError(
            [ reason, lookupReason ],
            `runtime ${operation} tab-state reconciliation failed`
        );
    }
    if ( tabState?.discarded === true ) { return 'unavailable'; }
    const waitForUnfreeze = tabState?.frozen === true;
    const identity = await getActiveTopDocumentIdentity(
        tabId,
        tabState?.url || tab?.url || ''
    );
    if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
        return 'unavailable';
    }
    if ( identity === null ) {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
            return 'unavailable';
        }
        throw new Error(`runtime ${operation} top-document identity unavailable`);
    }
    await deferRuntimeDocuments([{
        tabId,
        topDocumentId: identity.documentId,
        operation,
        desiredFingerprint,
        expectedTabGeneration: tabGeneration,
        waitForUnfreeze,
        incrementFailure: waitForUnfreeze === false,
        lastError: runtimeRefreshErrorMessage(reason),
    }]);
    if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
        return 'unavailable';
    }
    await scheduleDeferredRuntimeRetry().catch(() => {});
    return 'deferred';
}

async function refreshRuntimeStateForOpenTabsNow({
    refreshCustomFilters = false,
    refreshCoreCosmetics = false,
    desiredFingerprint = '',
} = {}) {
    if ( browser.tabs?.query === undefined ) { return false; }
    await ensureDeferredRuntimeDocumentsHydrated();
    let tabs = [];
    const [
        storedRemoteCosmetics,
        enabledRulesets,
        frenchStreamSourceLevel,
    ] = await Promise.all([
        readLocalStrict(REMOTE_COSMETICS_STORAGE_KEY),
        getReportedEnabledRulesets(),
        getFilteringMode('french-stream.one'),
    ]);
    const remoteCosmeticHostnames = collectStoredRemoteCosmeticHostnames(
        storedRemoteCosmetics
    );
    const hasGlobalRemoteCosmetics = storedRemoteCosmeticsHaveGlobalSelectors(
        storedRemoteCosmetics
    );
    const coreCosmeticDirectives = refreshCoreCosmetics
        ? await getRegisteredCoreCosmeticDirectives()
        : [];
    try {
        tabs = await browser.tabs.query({});
    } catch (reason) {
        ubolErr(`refreshRuntimeStateForOpenTabs/query/${reason}`);
        return false;
    }
    const fileSchemeAccessAllowed = (tabs || []).some(
        tab => /^file:/i.test(tab?.url || '')
    ) ? await isFileSchemeAccessAllowed() : false;
    const frozenCandidates = (tabs || []).filter(tab =>
        tab?.discarded !== true &&
        tab?.frozen === true &&
        Number.isInteger(tab?.id) &&
        tabUrlMayHostExtensionRuntime(tab?.url || '', fileSchemeAccessAllowed)
    );
    let allSucceeded = true;
    try {
        const deferredEntries = (await Promise.all(frozenCandidates.map(
            async tab => {
                try {
                    const tabGeneration = getRuntimeTabLifecycleGeneration(tab.id);
                    const identity = await getActiveTopDocumentIdentity(
                        tab.id,
                        tab?.url || ''
                    );
                    if ( runtimeTabLifecycleMatches(tab.id, tabGeneration) === false ) {
                        return null;
                    }
                    if ( identity === null ) {
                        throw new Error('frozen top-document identity unavailable');
                    }
                    return {
                        tabId: tab.id,
                        topDocumentId: identity.documentId,
                        operation: 'refresh',
                        desiredFingerprint,
                        expectedTabGeneration: tabGeneration,
                        waitForUnfreeze: true,
                        incrementFailure: false,
                    };
                } catch (reason) {
                    if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                        return null;
                    }
                    throw reason;
                }
            }
        ))).filter(entry => entry !== null);
        if ( deferredEntries.length !== 0 ) {
            await deferRuntimeDocuments(deferredEntries);
        }
    } catch (reason) {
        allSucceeded = false;
        ubolErr(`refreshRuntimeStateForOpenTabs/deferFrozen/${reason}`);
    }
    const candidates = (tabs || []).filter(tab =>
        tab?.discarded !== true &&
        tab?.frozen !== true &&
        Number.isInteger(tab?.id) &&
        tabUrlMayHostExtensionRuntime(tab?.url || '', fileSchemeAccessAllowed)
    ).sort((a, b) => Number(b?.active === true) - Number(a?.active === true));
    let nextIndex = 0;
    const refreshedDeferredEntries = [];
    const refreshNext = async () => {
        while ( nextIndex < candidates.length ) {
            const tab = candidates[nextIndex++];
            const tabId = Number.isInteger(tab?.id) ? tab.id : -1;
            const tabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            const hostname = normalizeHttpHostname(tab?.url || '');
            try {
                const pendingBefore = Array.from(
                    deferredRuntimeDocuments.values()
                ).filter(entry =>
                    entry.tabId === tabId && entry.operation === 'refresh'
                ).map(entry => ({ ...entry }));
                const level = hostname === ''
                    ? MODE_NONE
                    : await getFilteringMode(hostname);
                const refreshed = await refreshRuntimeStateForTab(
                    tabId,
                    Number(level) || MODE_NONE,
                    {
                        url: tab?.url || '',
                        hostname,
                        hasGlobalRemoteCosmetics,
                        remoteCosmeticHostnames,
                        siteFixEnabled: enabledRulesets.includes('talon-site-fixes'),
                        frenchStreamSourceAllowed:
                            frenchStreamSourceLevel !== MODE_NONE,
                        refreshCustomFilters,
                        refreshCoreCosmetics,
                        coreCosmeticDirectives,
                        desiredFingerprint,
                        expectedTabGeneration: tabGeneration,
                    }
                );
                if (
                    refreshed !== true &&
                    refreshed?.ok !== true &&
                    refreshed?.deferred !== true
                ) {
                    allSucceeded = false;
                } else if ( refreshed?.deferred !== true ) {
                    const topDocumentId = typeof refreshed?.topDocumentId === 'string'
                        ? refreshed.topDocumentId
                        : '';
                    for ( const entry of pendingBefore ) {
                        if ( entry.topDocumentId === topDocumentId ) {
                            refreshedDeferredEntries.push(entry);
                        }
                    }
                }
            } catch (reason) {
                try {
                    if ( await recoverRuntimeTabFailure(
                        tab,
                        reason,
                        'refresh',
                        desiredFingerprint,
                        tabGeneration
                    ) ) {
                        continue;
                    }
                } catch (freezeReason) {
                    reason = new AggregateError(
                        [ reason, freezeReason ],
                        'runtime refresh freeze reconciliation failed'
                    );
                }
                allSucceeded = false;
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`refreshRuntimeStateForOpenTabs/${reason}`);
                }
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        candidates.length
    );
    await Promise.all(Array.from({ length: workerCount }, refreshNext));
    for ( const entry of refreshedDeferredEntries ) {
        try {
            await clearDeferredRuntimeDocuments({
                tabId: entry.tabId,
                topDocumentId: entry.topDocumentId,
                operation: entry.operation,
                expectedUpdatedAt: entry.updatedAt,
            });
        } catch (reason) {
            allSucceeded = false;
            ubolErr(`refreshRuntimeStateForOpenTabs/clearDeferred/${reason}`);
        }
    }
    return allSucceeded;
}

let openTabRuntimeRefreshPromise;
let openTabRuntimeRefreshFlight;
const openTabRuntimeRefreshWaiters = [];

const normalizeSuspendedOpenTabRuntimeRefreshRequest = value => {
    if ( value instanceof Object === false ) { return; }
    return {
        refreshCustomFilters: value.refreshCustomFilters === true,
        refreshCoreCosmetics: value.refreshCoreCosmetics === true,
        desiredFingerprint: typeof value.desiredFingerprint === 'string'
            ? value.desiredFingerprint.slice(0, 256)
            : '',
        revision: Math.max(0, Number(value.revision) || 0),
        fingerprintRevision: Math.max(
            0,
            Number(value.fingerprintRevision) || (
                typeof value.desiredFingerprint === 'string' &&
                value.desiredFingerprint !== ''
                    ? Number(value.revision) || 0
                    : 0
            )
        ),
        updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    };
};

const mergeSuspendedOpenTabRuntimeRefreshRequests = (...values) => {
    const requests = values
        .map(normalizeSuspendedOpenTabRuntimeRefreshRequest)
        .filter(value => value !== undefined);
    if ( requests.length === 0 ) { return; }
    const fingerprintSource = requests
        .filter(value => value.desiredFingerprint !== '')
        .sort((a, b) =>
            b.fingerprintRevision - a.fingerprintRevision ||
            b.revision - a.revision
        )[0];
    return {
        refreshCustomFilters: requests.some(
            value => value.refreshCustomFilters
        ),
        refreshCoreCosmetics: requests.some(
            value => value.refreshCoreCosmetics
        ),
        desiredFingerprint: fingerprintSource?.desiredFingerprint || '',
        fingerprintRevision: fingerprintSource?.fingerprintRevision || 0,
        revision: Math.max(...requests.map(value => value.revision)),
        updatedAt: Math.max(...requests.map(value => value.updatedAt)),
    };
};

const ensureSuspendedOpenTabRuntimeRefreshHydrated = async () => {
    if ( suspendedOpenTabRuntimeRefreshHydrationPromise instanceof Promise ) {
        return suspendedOpenTabRuntimeRefreshHydrationPromise;
    }
    suspendedOpenTabRuntimeRefreshHydrationPromise = (async () => {
        const stored = normalizeSuspendedOpenTabRuntimeRefreshRequest(
            await readLocalStrict(SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY)
        );
        if ( stored === undefined ) { return; }
        const current = suspendedOpenTabRuntimeRefreshRequest;
        suspendedOpenTabRuntimeRefreshRequest =
            mergeSuspendedOpenTabRuntimeRefreshRequests(current, stored);
        suspendedOpenTabRuntimeRefreshRevision = Math.max(
            suspendedOpenTabRuntimeRefreshRevision,
            suspendedOpenTabRuntimeRefreshRequest?.revision || 0
        );
    })().catch(reason => {
        suspendedOpenTabRuntimeRefreshHydrationPromise = undefined;
        throw reason;
    });
    suspendedOpenTabRuntimeRefreshHydrationPromise.catch(() => {});
    return suspendedOpenTabRuntimeRefreshHydrationPromise;
};

const enqueueSuspendedOpenTabRuntimeJournalOperation = operation => {
    const run = suspendedOpenTabRuntimeRefreshPersistenceTail
        .catch(() => undefined)
        .then(async () => {
            await ensureSuspendedOpenTabRuntimeRefreshHydrated();
            return operation();
        });
    suspendedOpenTabRuntimeRefreshPersistenceTail = run;
    run.catch(() => {});
    return run;
};

const appendSuspendedOpenTabRuntimeRefresh = options =>
    enqueueSuspendedOpenTabRuntimeJournalOperation(async () => {
        const before = normalizeSuspendedOpenTabRuntimeRefreshRequest(
            suspendedOpenTabRuntimeRefreshRequest
        );
        const revision = Math.max(
            suspendedOpenTabRuntimeRefreshRevision,
            before?.revision || 0
        ) + 1;
        const desiredFingerprint = typeof options?.desiredFingerprint === 'string'
            ? options.desiredFingerprint.slice(0, 256)
            : '';
        const incoming = {
            refreshCustomFilters: options?.refreshCustomFilters === true,
            refreshCoreCosmetics: options?.refreshCoreCosmetics === true,
            desiredFingerprint,
            revision,
            fingerprintRevision: desiredFingerprint === '' ? 0 : revision,
            updatedAt: Math.max(
                Date.now(),
                (Number(before?.updatedAt) || 0) + 1
            ),
        };
        const candidate = mergeSuspendedOpenTabRuntimeRefreshRequests(
            before,
            incoming
        );
        // Page work must never begin before its exact merged intent is durable.
        await localWrite(
            SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY,
            candidate
        );
        suspendedOpenTabRuntimeRefreshRevision = revision;
        suspendedOpenTabRuntimeRefreshRequest = candidate;
        return { ...candidate };
    });

const snapshotSuspendedOpenTabRuntimeRefresh = () =>
    enqueueSuspendedOpenTabRuntimeJournalOperation(() => {
        const request = normalizeSuspendedOpenTabRuntimeRefreshRequest(
            suspendedOpenTabRuntimeRefreshRequest
        );
        return request === undefined ? undefined : { ...request };
    });

const acknowledgeSuspendedOpenTabRuntimeRefresh = coveredRevision =>
    enqueueSuspendedOpenTabRuntimeJournalOperation(async () => {
        const current = normalizeSuspendedOpenTabRuntimeRefreshRequest(
            suspendedOpenTabRuntimeRefreshRequest
        );
        if ( current?.revision !== coveredRevision ) { return false; }
        await localRemove(SUSPENDED_OPEN_TAB_RUNTIME_REFRESH_STORAGE_KEY);
        suspendedOpenTabRuntimeRefreshRequest = undefined;
        return true;
    });

const waitForSuspendedOpenTabRuntimeRefreshPersistence = async () => {
    for (;;) {
        const observed = suspendedOpenTabRuntimeRefreshPersistenceTail;
        await observed;
        if ( suspendedOpenTabRuntimeRefreshPersistenceTail === observed ) {
            return;
        }
    }
};

function rememberSuspendedOpenTabRuntimeRefresh({
    refreshCustomFilters = false,
    refreshCoreCosmetics = false,
    desiredFingerprint = '',
} = {}) {
    appendSuspendedOpenTabRuntimeRefresh({
        refreshCustomFilters,
        refreshCoreCosmetics,
        desiredFingerprint,
    }).catch(ubolErr);
    return false;
}

async function rememberFullOpenTabRuntimeRepair() {
    rememberSuspendedOpenTabRuntimeRefresh({
        refreshCustomFilters: true,
        refreshCoreCosmetics: true,
    });
    await waitForSuspendedOpenTabRuntimeRefreshPersistence();
}

async function persistStartupDocumentRuntimeRepair({ force = false } = {}) {
    const durableDirty = await readLocalStrict(
        STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY
    );
    if ( force ) {
        startupDocumentRuntimeAttemptRequiresRepair = true;
        if ( isDurableDirtyMarker(durableDirty) === false ) {
            await localWrite(STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY, {
                version: 1,
                forced: true,
                updatedAt: Date.now(),
            });
        }
    }
    startupDocumentRuntimeAttemptRequiresRepair ||=
        isDurableDirtyMarker(durableDirty);
    if ( startupDocumentRuntimeAttemptRequiresRepair === false ) { return; }
    await rememberFullOpenTabRuntimeRepair();
    // Clear only after the journal append is confirmed durable. A failed write
    // keeps this sticky bit for the next bounded/full recovery attempt.
    await localRemove(STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY);
    startupDocumentRuntimeAttemptRequiresRepair = false;
}

async function clearStartupDocumentRuntimeRepairEvidence() {
    await localRemove(STARTUP_DOCUMENT_RUNTIME_DIRTY_KEY);
    startupDocumentRuntimeAttemptRequiresRepair = false;
}

async function drainSuspendedOpenTabRuntimeRefresh() {
    for (;;) {
        const request = await snapshotSuspendedOpenTabRuntimeRefresh();
        if ( request === undefined ) { return true; }
        const refreshed = await waitForOpenTabRuntimeRefreshRevision(
            request.revision
        );
        if ( refreshed !== true ) {
            throw new Error('suspended open-tab runtime refresh did not drain');
        }
    }
}

const settleOpenTabRuntimeRefreshWaiters = (
    coveredRevision,
    outcome
) => {
    for ( let i = openTabRuntimeRefreshWaiters.length - 1; i >= 0; i-- ) {
        const waiter = openTabRuntimeRefreshWaiters[i];
        if ( waiter.revision > coveredRevision ) { continue; }
        openTabRuntimeRefreshWaiters.splice(i, 1);
        if ( outcome.ok ) {
            waiter.resolve(outcome.value === true);
        } else {
            waiter.reject(outcome.error);
        }
    }
};

const attemptOpenTabRuntimeRefresh = async request => {
    try {
        const value = await refreshRuntimeStateForOpenTabsNow(request);
        return { ok: true, value: value === true };
    } catch (error) {
        return { ok: false, error };
    }
};

const runOpenTabRuntimeRefreshCycles = async flight => {
    for (;;) {
        const initial = await snapshotSuspendedOpenTabRuntimeRefresh();
        if ( initial === undefined ) {
            if ( openTabRuntimeRefreshFlight === flight ) {
                openTabRuntimeRefreshFlight = undefined;
                openTabRuntimeRefreshPromise = undefined;
            }
            return true;
        }
        if ( lifecycleRuntimeRefreshSuspendedForPaywall ) {
            settleOpenTabRuntimeRefreshWaiters(initial.revision, {
                ok: true,
                value: false,
            });
            if ( openTabRuntimeRefreshFlight === flight ) {
                openTabRuntimeRefreshFlight = undefined;
                openTabRuntimeRefreshPromise = undefined;
            }
            return false;
        }

        let covered = initial;
        let outcome = await attemptOpenTabRuntimeRefresh(initial);
        const trailing = await snapshotSuspendedOpenTabRuntimeRefresh();
        if ( trailing?.revision > initial.revision ) {
            covered = trailing;
            // The merged trailing outcome supersedes the initial failure; its
            // request still contains every unacknowledged sticky requirement.
            outcome = await attemptOpenTabRuntimeRefresh(trailing);
        }

        if ( outcome.ok && outcome.value === true ) {
            try {
                await acknowledgeSuspendedOpenTabRuntimeRefresh(
                    covered.revision
                );
            } catch (error) {
                outcome = { ok: false, error };
            }
        }
        settleOpenTabRuntimeRefreshWaiters(covered.revision, outcome);

        const remaining = await snapshotSuspendedOpenTabRuntimeRefresh();
        if ( remaining?.revision > covered.revision ) {
            // Requests after the trailing snapshot form a new bounded cycle;
            // their waiters are not acknowledged by the earlier pass.
            await Promise.resolve();
            continue;
        }
        if ( openTabRuntimeRefreshFlight === flight ) {
            openTabRuntimeRefreshFlight = undefined;
            openTabRuntimeRefreshPromise = undefined;
        }
        if ( outcome.ok === false ) { throw outcome.error; }
        return outcome.value === true;
    }
};

const ensureOpenTabRuntimeRefreshRunner = () => {
    if ( openTabRuntimeRefreshFlight instanceof Object ) {
        return openTabRuntimeRefreshFlight.promise;
    }
    const flight = { promise: undefined };
    openTabRuntimeRefreshFlight = flight;
    flight.promise = runOpenTabRuntimeRefreshCycles(flight).catch(error => {
        settleOpenTabRuntimeRefreshWaiters(Number.MAX_SAFE_INTEGER, {
            ok: false,
            error,
        });
        if ( openTabRuntimeRefreshFlight === flight ) {
            openTabRuntimeRefreshFlight = undefined;
            openTabRuntimeRefreshPromise = undefined;
        }
        throw error;
    });
    flight.promise.catch(() => {});
    openTabRuntimeRefreshPromise = flight.promise;
    return flight.promise;
};

function waitForOpenTabRuntimeRefreshRevision(revision) {
    const waiter = new Promise((resolve, reject) => {
        openTabRuntimeRefreshWaiters.push({ revision, resolve, reject });
    });
    waiter.catch(() => {});
    ensureOpenTabRuntimeRefreshRunner();
    return waiter;
}

async function refreshRuntimeStateForOpenTabs({
    refreshCustomFilters = false,
    refreshCoreCosmetics = false,
    desiredFingerprint = '',
} = {}) {
    const request = await appendSuspendedOpenTabRuntimeRefresh({
        refreshCustomFilters,
        refreshCoreCosmetics,
        desiredFingerprint,
    });
    if ( lifecycleRuntimeRefreshSuspendedForPaywall ) {
        return false;
    }
    return waitForOpenTabRuntimeRefreshRevision(request.revision);
}

async function waitForOpenTabRuntimeRefreshIdle() {
    for (;;) {
        await waitForSuspendedOpenTabRuntimeRefreshPersistence();
        const observed = openTabRuntimeRefreshPromise;
        if ( observed instanceof Promise === false ) { return; }
        await observed.then(() => undefined, () => undefined);
    }
}

const resumedTabRuntimeTails = new Map();

async function waitForResumedTabRuntimeIdle() {
    for (;;) {
        const observed = Array.from(resumedTabRuntimeTails.values());
        if ( observed.length === 0 ) { return; }
        await Promise.allSettled(observed);
        if ( observed.every(operation =>
            Array.from(resumedTabRuntimeTails.values()).includes(operation) === false
        ) ) {
            if ( resumedTabRuntimeTails.size === 0 ) { return; }
        }
    }
}

async function reconcileRuntimeStateForCurrentTab(
    tabId,
    fallbackUrl = '',
    expectedTabGeneration
) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return true; }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
    }
    if ( isEntitled() === false || paywallActive ) {
        return stopRuntimeStateForTab(tabId, { expectedTabGeneration });
    }
    const [
        storedRemoteCosmetics,
        enabledRulesets,
        frenchStreamSourceLevel,
        coreCosmeticDirectives,
    ] = await Promise.all([
        readLocalStrict(REMOTE_COSMETICS_STORAGE_KEY),
        getReportedEnabledRulesets(),
        getFilteringMode('french-stream.one'),
        getRegisteredCoreCosmeticDirectives(),
    ]);
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
    }
    const hostname = normalizeHttpHostname(fallbackUrl);
    const filteringLevel = hostname === ''
        ? MODE_NONE
        : Number(await getFilteringMode(hostname)) || MODE_NONE;
    return refreshRuntimeStateForTab(tabId, filteringLevel, {
        url: fallbackUrl,
        hostname,
        hasGlobalRemoteCosmetics: storedRemoteCosmeticsHaveGlobalSelectors(
            storedRemoteCosmetics
        ),
        remoteCosmeticHostnames: collectStoredRemoteCosmeticHostnames(
            storedRemoteCosmetics
        ),
        siteFixEnabled: enabledRulesets.includes('talon-site-fixes'),
        frenchStreamSourceAllowed: frenchStreamSourceLevel !== MODE_NONE,
        refreshCustomFilters: true,
        refreshCoreCosmetics: true,
        coreCosmeticDirectives,
        expectedTabGeneration,
    });
}

async function rememberRuntimeReconcileFailure(
    tabId,
    fallbackUrl,
    reason,
    expectedTabGeneration
) {
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return 'unavailable';
    }
    let tab;
    try {
        tab = await browser.tabs?.get?.(tabId);
    } catch (lookupReason) {
        if ( isRuntimeRefreshTargetUnavailableError(lookupReason) ) {
            return 'unavailable';
        }
        throw new AggregateError(
            [ reason, lookupReason ],
            'deferred runtime retry tab lookup failed'
        );
    }
    if ( tab?.discarded === true ) { return 'unavailable'; }
    const fileSchemeAccessAllowed = /^file:/i.test(tab?.url || '')
        ? await isFileSchemeAccessAllowed()
        : false;
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return 'unavailable';
    }
    if (
        tabUrlMayHostExtensionRuntime(
            tab?.url || fallbackUrl,
            fileSchemeAccessAllowed
        ) === false
    ) {
        return 'unavailable';
    }
    const operation = isEntitled() === false || paywallActive
        ? 'stop'
        : 'refresh';
    const recovered = await recoverRuntimeTabFailure(
        tab,
        reason,
        operation,
        operation === 'refresh' ? lastInjectableRuntimeFingerprint : '',
        expectedTabGeneration
    );
    if ( recovered !== false ) { return recovered; }
    const identity = await getActiveTopDocumentIdentity(
        tabId,
        tab?.url || fallbackUrl
    );
    if (
        identity === null ||
        runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false
    ) { return 'unavailable'; }
    await deferRuntimeDocuments([{
        tabId,
        topDocumentId: identity.documentId,
        operation,
        desiredFingerprint:
            operation === 'refresh' ? lastInjectableRuntimeFingerprint : '',
        expectedTabGeneration,
    }]);
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return 'unavailable';
    }
    await scheduleDeferredRuntimeRetry().catch(() => {});
    return 'deferred';
}

function rememberSuspendedRuntimeReconcileRequest(tabId, fallbackUrl = '') {
    const request = {
        tabId,
        fallbackUrl: typeof fallbackUrl === 'string' ? fallbackUrl : '',
        tabGeneration: getRuntimeTabLifecycleGeneration(tabId),
        revision: ++suspendedRuntimeReconcileRevision,
    };
    suspendedRuntimeReconcileRequests.set(tabId, request);
    const operation = (async () => {
        let identity;
        try {
            identity = await getActiveTopDocumentIdentity(tabId, request.fallbackUrl);
        } catch (reason) {
            if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                if ( suspendedRuntimeReconcileRequests.get(tabId) === request ) {
                    suspendedRuntimeReconcileRequests.delete(tabId);
                }
                return { deferred: true, skipped: 'unavailable' };
            }
            throw reason;
        }
        if ( identity === null ) {
            return { deferred: true, skipped: 'document_unavailable' };
        }
        if (
            suspendedRuntimeReconcileRequests.get(tabId) !== request ||
            getRuntimeTabLifecycleGeneration(tabId) !== request.tabGeneration
        ) {
            return { deferred: true, skipped: 'tab_replaced' };
        }
        const [ deferredEntry ] = await deferRuntimeDocuments([{
            tabId,
            topDocumentId: identity.documentId,
            operation: 'refresh',
            desiredFingerprint: lastInjectableRuntimeFingerprint,
            expectedTabGeneration: request.tabGeneration,
        }]);
        if (
            suspendedRuntimeReconcileRequests.get(tabId) !== request ||
            getRuntimeTabLifecycleGeneration(tabId) !== request.tabGeneration
        ) {
            if ( deferredEntry !== undefined ) {
                await clearDeferredRuntimeDocuments({
                    tabId,
                    topDocumentId: identity.documentId,
                    operation: 'refresh',
                    expectedUpdatedAt: deferredEntry.updatedAt,
                });
            }
            return { deferred: true, skipped: 'tab_replaced' };
        }
        await scheduleDeferredRuntimeRetry().catch(() => {});
        return {
            deferred: true,
            topDocumentId: identity.documentId,
        };
    })();
    pendingSuspendedRuntimeReconcileOperations.add(operation);
    operation.finally(() => {
        pendingSuspendedRuntimeReconcileOperations.delete(operation);
    }).catch(() => {});
    return operation;
}

async function waitForSuspendedRuntimeReconcilePersistence() {
    while ( pendingSuspendedRuntimeReconcileOperations.size !== 0 ) {
        await Promise.allSettled(
            Array.from(pendingSuspendedRuntimeReconcileOperations)
        );
    }
}

async function drainSuspendedRuntimeReconcileRequests() {
    const pending = Array.from(suspendedRuntimeReconcileRequests.values());
    if ( pending.length === 0 ) { return true; }
    const results = await Promise.allSettled(pending.map(async request => {
        const result = await queueRuntimeStateReconcileForTab(
            request.tabId,
            request.fallbackUrl
        );
        if (
            result !== true &&
            result?.ok !== true &&
            result?.deferred !== true
        ) {
            throw new Error('suspended runtime reconciliation failed');
        }
        if ( suspendedRuntimeReconcileRequests.get(request.tabId) === request ) {
            suspendedRuntimeReconcileRequests.delete(request.tabId);
        }
        return true;
    }));
    const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
    if ( failures.length !== 0 ) {
        await scheduleDeferredRuntimeRetry().catch(() => {});
        throw new AggregateError(
            failures,
            'suspended runtime reconciliation did not drain'
        );
    }
    return true;
}

function queueRuntimeStateReconcileForTab(tabId, fallbackUrl = '') {
    const tabGeneration = getRuntimeTabLifecycleGeneration(tabId);
    if (
        lifecycleRuntimeRefreshSuspendedForPaywall &&
        isEntitled()
    ) {
        return rememberSuspendedRuntimeReconcileRequest(tabId, fallbackUrl);
    }
    const previous = resumedTabRuntimeTails.get(tabId) || Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
        if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
            return true;
        }
        if (
            lifecycleRuntimeRefreshSuspendedForPaywall &&
            isEntitled()
        ) {
            return rememberSuspendedRuntimeReconcileRequest(tabId, fallbackUrl);
        }
        await ensureDeferredRuntimeDocumentsHydrated();
        if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
            return true;
        }
        const pendingBefore = Array.from(deferredRuntimeDocuments.values())
            .filter(entry => entry.tabId === tabId)
            .map(entry => ({ ...entry }));
        try {
            const reconciled = await reconcileRuntimeStateForCurrentTab(
                tabId,
                fallbackUrl,
                tabGeneration
            );
            if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
                return true;
            }
            if (
                reconciled !== true &&
                reconciled?.ok !== true &&
                reconciled?.deferred !== true
            ) {
                throw new Error('resumed tab runtime reconciliation failed');
            }
            const topDocumentId = typeof reconciled?.topDocumentId === 'string'
                ? reconciled.topDocumentId
                : '';
            for ( const entry of pendingBefore ) {
                if ( entry.topDocumentId !== topDocumentId ) { continue; }
                if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
                    return true;
                }
                await clearDeferredRuntimeDocuments({
                    tabId,
                    topDocumentId: entry.topDocumentId,
                    operation: entry.operation,
                    expectedUpdatedAt: entry.updatedAt,
                });
            }
            return true;
        } catch (reason) {
            if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
                return true;
            }
            const disposition = await rememberRuntimeReconcileFailure(
                tabId,
                fallbackUrl,
                reason,
                tabGeneration
            );
            if ( disposition === 'unavailable' ) {
                for ( const entry of pendingBefore ) {
                    if ( runtimeTabLifecycleMatches(tabId, tabGeneration) === false ) {
                        return true;
                    }
                    await clearDeferredRuntimeDocuments({
                        tabId,
                        topDocumentId: entry.topDocumentId,
                        operation: entry.operation,
                        expectedUpdatedAt: entry.updatedAt,
                    });
                }
                return true;
            }
            if ( disposition === 'deferred' ) {
                await scheduleDeferredRuntimeRetry().catch(() => {});
                return { deferred: true };
            }
            await scheduleDeferredRuntimeRetry().catch(() => {});
            throw reason;
        }
    });
    resumedTabRuntimeTails.set(tabId, run);
    run.finally(() => {
        if ( resumedTabRuntimeTails.get(tabId) === run ) {
            resumedTabRuntimeTails.delete(tabId);
        }
    }).catch(() => {});
    return run;
}

async function drainActiveDeferredRuntimeDocuments() {
    const activeTabIds = await pruneDurableRuntimeLifecycleState();
    if ( activeTabIds.length === 0 ) {
        if ( deferredRuntimeDocuments.size === 0 ) {
            await browser.alarms?.clear?.(DEFERRED_RUNTIME_RETRY_ALARM);
        } else {
            await scheduleDeferredRuntimeRetry();
        }
        return true;
    }
    const results = await Promise.allSettled(
        activeTabIds.map(tabId => queueRuntimeStateReconcileForTab(tabId))
    );
    const remainingActiveTabIds = await pruneDurableRuntimeLifecycleState();
    if ( deferredRuntimeDocuments.size === 0 ) {
        await browser.alarms?.clear?.(DEFERRED_RUNTIME_RETRY_ALARM);
    } else {
        await scheduleDeferredRuntimeRetry();
    }
    return results.every(result => result.status === 'fulfilled');
}

function queueEntitlementOpenTabRefresh() {
    if ( lifecycleRuntimeRefreshSuspendedForPaywall ) {
        return Promise.resolve(rememberSuspendedOpenTabRuntimeRefresh());
    }
    if ( entitlementOpenTabRefreshPromise instanceof Promise ) {
        return entitlementOpenTabRefreshPromise;
    }
    entitlementOpenTabRefreshPromise = (async () => {
        const desiredFingerprint =
            await computeInjectableRuntimeFingerprint().catch(() => '');
        const refreshed = await refreshRuntimeStateForOpenTabs({
            desiredFingerprint,
        });
        return refreshed;
    })()
        .catch(ubolErr)
        .finally(() => {
            entitlementOpenTabRefreshPromise = undefined;
        });
    return entitlementOpenTabRefreshPromise;
}

async function waitForEntitlementOpenTabRefreshIdle() {
    for (;;) {
        const observed = entitlementOpenTabRefreshPromise;
        if ( observed instanceof Promise === false ) { return; }
        await observed.then(() => undefined, () => undefined);
        if ( entitlementOpenTabRefreshPromise === observed ) {
            entitlementOpenTabRefreshPromise = undefined;
        }
    }
}

async function waitForPendingTimedOutRuntimeScripts() {
    while (
        pendingRuntimeScriptOperations.size !== 0 ||
        pendingTimedOutRuntimeScripts.size !== 0
    ) {
        await Promise.allSettled(
            Array.from(new Set([
                ...pendingRuntimeScriptOperations,
                ...pendingTimedOutRuntimeScripts.values(),
            ]))
        );
    }
}

async function hashRuntimeStateText(serialized) {
    try {
        const bytes = new TextEncoder().encode(serialized);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte =>
            byte.toString(16).padStart(2, '0')
        ).join('');
    } catch {
    }
    let hash = 2166136261;
    for ( let i = 0; i < serialized.length; i++ ) {
        hash ^= serialized.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `fallback-${(hash >>> 0).toString(16)}`;
}

async function readLocalStrict(key) {
    if ( browser.storage?.local?.get === undefined ) {
        throw new Error('local storage API unavailable');
    }
    const bin = await browser.storage.local.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid local storage response for ${key}`);
    }
    return bin[key];
}

async function readSessionStrict(key) {
    if ( browser.storage?.session?.get === undefined ) {
        throw new Error('session storage API unavailable');
    }
    const bin = await browser.storage.session.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid session storage response for ${key}`);
    }
    return bin[key];
}

async function writeSessionStrict(key, value) {
    if ( browser.storage?.session?.set === undefined ) {
        throw new Error('session storage API unavailable');
    }
    await browser.storage.session.set({ [key]: value });
}

async function computeInjectableRuntimeFingerprint() {
    const [
        filteringModeDetails,
        communityInjectableFingerprint,
        subsystemBackoffs,
        enabledRulesets,
        compiledSandboxFingerprintState,
    ] = await Promise.all([
        getFilteringModeDetails(true),
        readLocalStrict('communityInjectableFingerprintV1'),
        readLocalStrict(AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY),
        getReportedEnabledRulesets(),
        readLocalStrict(SANDBOX_COMPILED_FINGERPRINT_KEY),
    ]);
    const serialized = JSON.stringify({
        version: getCurrentVersion(),
        userScriptsAvailable: supportsUserScripts && isUserScriptsAvailable(),
        filteringModeDetails,
        enabledRulesets: Array.isArray(enabledRulesets)
            ? enabledRulesets.slice().sort()
            : [],
        developerMode: rulesetConfig.developerMode === true,
        communityRulesEnabled: rulesetConfig.communityRulesEnabled === true,
        communityInjectableFingerprint:
            typeof communityInjectableFingerprint === 'string'
                ? communityInjectableFingerprint
                : '',
        subsystemBackoffs,
        compiledSandboxFingerprintState,
    });
    return hashRuntimeStateText(serialized);
}

async function getRegisteredContentScriptState() {
    if ( browser.scripting?.getRegisteredContentScripts === undefined ) {
        throw new Error('registered content-script API unavailable');
    }
    const registered = await browser.scripting.getRegisteredContentScripts();
    if ( Array.isArray(registered) === false ) {
        throw new Error('invalid registered content-script state');
    }
    automationRuntimeRegistered = registered.some(entry =>
        entry?.id === 'automation'
    );
    const canonical = registered
        .map(normalizeContentScriptRegistration)
        .sort((a, b) => a.id.localeCompare(b.id));
    return {
        count: canonical.length,
        fingerprint: await hashRuntimeStateText(JSON.stringify(canonical)),
    };
}

const canonicalUserScriptSource = source => ({
    code: typeof source?.code === 'string' ? source.code : '',
    file: typeof source?.file === 'string' ? source.file : '',
});

const canonicalUserScript = entry => ({
    id: typeof entry?.id === 'string' ? entry.id : '',
    js: Array.isArray(entry?.js)
        ? entry.js.map(canonicalUserScriptSource)
        : [],
    matches: Array.isArray(entry?.matches) ? entry.matches.slice().sort() : [],
    excludeMatches: Array.isArray(entry?.excludeMatches)
        ? entry.excludeMatches.slice().sort()
        : [],
    includeGlobs: Array.isArray(entry?.includeGlobs)
        ? entry.includeGlobs.slice().sort()
        : [],
    excludeGlobs: Array.isArray(entry?.excludeGlobs)
        ? entry.excludeGlobs.slice().sort()
        : [],
    allFrames: entry?.allFrames === true,
    matchOriginAsFallback: entry?.matchOriginAsFallback === true,
    runAt: typeof entry?.runAt === 'string' ? entry.runAt : 'document_idle',
    world: typeof entry?.world === 'string' ? entry.world : 'USER_SCRIPT',
});

async function getManagedUserScriptState() {
    if (
        supportsUserScripts !== true ||
        isUserScriptsAvailable() === false
    ) {
        return {
            ids: [],
            fingerprint: await hashRuntimeStateText('unavailable'),
            unavailable: true,
        };
    }
    const scripts = await browser.userScripts.getScripts();
    if ( Array.isArray(scripts) === false ) {
        throw new Error('invalid registered user-script state');
    }
    const canonical = scripts
        .filter(entry => entry?.id === 'user.isolated' || entry?.id === 'user.main')
        .map(canonicalUserScript)
        .sort((a, b) => a.id.localeCompare(b.id));
    return {
        ids: canonical.map(entry => entry.id),
        fingerprint: await hashRuntimeStateText(JSON.stringify(canonical)),
        registrationFingerprint:
            await fingerprintManagedUserScriptRegistrations(scripts),
    };
}

const managedUserScriptStateIsReusable = ({
    actualState,
    desiredFingerprint,
    desiredIds,
    mayExistMarker,
}) => {
    if (
        actualState instanceof Object === false ||
        Array.isArray(actualState.ids) === false ||
        typeof desiredFingerprint !== 'string' ||
        Array.isArray(desiredIds) === false
    ) {
        return false;
    }
    const normalizedActualIds = actualState.ids.slice().sort();
    const normalizedDesiredIds = desiredIds.slice().sort();
    if (
        JSON.stringify(normalizedActualIds) !==
        JSON.stringify(normalizedDesiredIds)
    ) {
        return false;
    }
    if ( actualState.unavailable !== true ) {
        return actualState.registrationFingerprint === desiredFingerprint;
    }
    // Chrome hides the userScripts API while its user-controlled toggle is
    // off. An empty desired state is still verifiable when Talon's durable
    // marker proves it never installed (or already removed) a managed script.
    // Any positive/failed marker read remains fail-closed until the API can be
    // queried and cleanup can be verified.
    return desiredFingerprint === '' &&
        normalizedDesiredIds.length === 0 &&
        isDurableDirtyMarker(mayExistMarker) === false;
};

async function persistInjectableRuntimeState(fingerprint) {
    if ( typeof fingerprint !== 'string' || fingerprint === '' ) { return; }
    const [ registrationState, managedUserScriptState ] = await Promise.all([
        getRegisteredContentScriptState(),
        getManagedUserScriptState(),
    ]);
    const next = {
        version: getCurrentVersion(),
        fingerprint,
        registrationCount: registrationState.count,
        registrationFingerprint: registrationState.fingerprint,
        managedUserScriptIds: managedUserScriptState.ids,
        managedUserScriptFingerprint: managedUserScriptState.fingerprint,
    };
    const before = await readLocalStrict(INJECTABLE_RUNTIME_STATE_KEY);
    if (
        before?.version === next.version &&
        before?.fingerprint === next.fingerprint &&
        before?.registrationCount === next.registrationCount &&
        before?.registrationFingerprint === next.registrationFingerprint &&
        before?.managedUserScriptFingerprint === next.managedUserScriptFingerprint &&
        JSON.stringify(before?.managedUserScriptIds || []) ===
            JSON.stringify(next.managedUserScriptIds)
    ) {
        lastInjectableRuntimeFingerprint = fingerprint;
        return;
    }
    await localWrite(INJECTABLE_RUNTIME_STATE_KEY, next);
    lastInjectableRuntimeFingerprint = fingerprint;
}

async function canReusePersistedInjectableRuntimeState() {
    if ( isEntitled() === false ) { return false; }
    const [
        currentFingerprint,
        storedState,
        registrationState,
        managedUserScriptState,
        sandboxDnrDirty,
        sandboxRegistrationDirty,
        sandboxRegistrationRevision,
        sandboxRegistrationAppliedRevision,
        sandboxUserScriptLiveReloadPending,
        compiledSandboxFingerprintState,
        contentScriptRegistrationMutationJournal,
        managedUserScriptsMayExist,
    ] = await Promise.all([
        computeInjectableRuntimeFingerprint(),
        readLocalStrict(INJECTABLE_RUNTIME_STATE_KEY).catch(() => null),
        getRegisteredContentScriptState().catch(() => null),
        getManagedUserScriptState().catch(() => null),
        readLocalStrict(SANDBOX_DNR_DIRTY_KEY).catch(() => true),
        readLocalStrict(SANDBOX_REGISTRATION_DIRTY_KEY).catch(() => true),
        readLocalStrict(SANDBOX_REGISTRATION_REVISION_KEY).catch(() => -1),
        readLocalStrict(SANDBOX_REGISTRATION_APPLIED_REVISION_KEY).catch(() => -2),
        readLocalStrict(SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY)
            .catch(() => true),
        readLocalStrict(SANDBOX_COMPILED_FINGERPRINT_KEY).catch(() => null),
        readLocalStrict(CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY)
            .catch(() => true),
        readLocalStrict(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY).catch(() => true),
    ]);
    const desiredSandboxRevision = Number(sandboxRegistrationRevision);
    const appliedSandboxRevision = Number(sandboxRegistrationAppliedRevision);
    const desiredManagedUserScriptFingerprint =
        typeof compiledSandboxFingerprintState?.userScriptRegistrationFingerprint ===
            'string'
            ? compiledSandboxFingerprintState.userScriptRegistrationFingerprint
            : null;
    const desiredManagedUserScriptIds = Array.isArray(
        compiledSandboxFingerprintState?.managedUserScriptIds
    )
        ? compiledSandboxFingerprintState.managedUserScriptIds
            .filter(id => id === 'user.isolated' || id === 'user.main')
            .sort()
        : desiredManagedUserScriptFingerprint === ''
            ? []
            : [
                compiledSandboxFingerprintState?.isolated === true
                    ? 'user.isolated'
                    : '',
                compiledSandboxFingerprintState?.main === true
                    ? 'user.main'
                    : '',
            ].filter(Boolean).sort();
    const reusable =
        isDurableDirtyMarker(sandboxDnrDirty) === false &&
        isDurableDirtyMarker(sandboxRegistrationDirty) === false &&
        isDurableDirtyMarker(sandboxUserScriptLiveReloadPending) === false &&
        isDurableDirtyMarker(contentScriptRegistrationMutationJournal) === false &&
        Number.isSafeInteger(desiredSandboxRevision) &&
        desiredSandboxRevision >= 0 &&
        Number.isSafeInteger(appliedSandboxRevision) &&
        appliedSandboxRevision >= 0 &&
        desiredSandboxRevision === appliedSandboxRevision &&
        storedState instanceof Object &&
        registrationState instanceof Object &&
        desiredManagedUserScriptFingerprint !== null &&
        managedUserScriptStateIsReusable({
            actualState: managedUserScriptState,
            desiredFingerprint: desiredManagedUserScriptFingerprint,
            desiredIds: desiredManagedUserScriptIds,
            mayExistMarker: managedUserScriptsMayExist,
        }) &&
        storedState.version === getCurrentVersion() &&
        storedState.fingerprint === currentFingerprint &&
        Number(storedState.registrationCount) >= 0 &&
        Number(storedState.registrationCount) === registrationState.count &&
        storedState.registrationFingerprint === registrationState.fingerprint &&
        storedState.managedUserScriptFingerprint ===
            managedUserScriptState.fingerprint &&
        JSON.stringify(storedState.managedUserScriptIds || []) ===
            JSON.stringify(managedUserScriptState.ids);
    if ( reusable ) {
        lastInjectableRuntimeFingerprint = currentFingerprint;
    }
    return reusable;
}

async function updateUserRulesAndAcknowledgeSandboxState() {
    const result = await updateUserRules();
    if ( result?.applyFailed === true ) {
        throw new Error('user-rule DNR reconciliation failed');
    }
    await localRemove(SANDBOX_DNR_DIRTY_KEY);
    return result;
}

async function ensureUserScriptMessagingWorld() {
    if ( supportsUserScripts === false || isUserScriptsAvailable() === false ) {
        return;
    }
    if ( typeof browser.userScripts?.configureWorld !== 'function' ) {
        throw new Error('user-script world configuration API unavailable');
    }
    await browser.userScripts.configureWorld({ messaging: true });
}

let injectableSyncTail = Promise.resolve();
let uncertainContentRegistrationReconciliationPromise;

const contentRegistrationResultIsUncertain = result =>
    result instanceof Object && result.uncertain === true;

const contentRegistrationResultIsVerified = result =>
    result === true || (
        result instanceof Object &&
        result.ok === true &&
        result.uncertain !== true
    );

const applyContentRegistrationReloadHint = async (
    registerResult,
    reloadHint,
    { refreshWildcard = false } = {}
) => {
    if ( reloadHint instanceof Object === false ) {
        return { marked: false, acknowledged: false };
    }
    await markTabsForRemoteScriptletReload(reloadHint, { refreshWildcard });
    if ( contentRegistrationResultIsVerified(registerResult) === false ) {
        // A timed-out Chrome mutation can still complete after this pass. Keep
        // the journaled hint so the authoritative reconciliation re-marks the
        // then-current document instead of treating an intervening reload as
        // safe.
        return { marked: true, acknowledged: false };
    }
    await localRemove(PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY);
    return { marked: true, acknowledged: true };
};

function scheduleUncertainContentRegistrationReconciliation() {
    if (
        uncertainContentRegistrationReconciliationPromise instanceof Promise
    ) {
        return uncertainContentRegistrationReconciliationPromise;
    }
    const operation = (async () => {
        await waitForTimedOutRegistrationOperations();
        // Exactly one in-process reconciliation closes the late-settlement
        // window. If Chrome times out again, sync schedules the existing
        // durable injectable retry alarm instead of keeping the worker alive
        // in an unbounded retry loop.
        return syncInjectablesAndRefreshTabs({
            runtimeOnly: false,
            refreshOpenTabs: true,
        });
    })();
    uncertainContentRegistrationReconciliationPromise = operation;
    operation.finally(() => {
        if ( uncertainContentRegistrationReconciliationPromise === operation ) {
            uncertainContentRegistrationReconciliationPromise = undefined;
        }
    }).catch(() => {});
    operation.catch(reason => {
        ubolErr(`uncertain content-script reconciliation/${reason}`);
    });
    return operation;
}

async function syncInjectablesAndRefreshTabsNow({
    runtimeOnly = false,
    refreshOpenTabs = true,
} = {}) {
    if (
        isEntitled() === false ||
        registrationMutationsSuspendedForPaywall
    ) {
        return {
            ok: true,
            skipped: 'not_entitled',
            registerResult: false,
            runtimeRefreshed: false,
            reloadHint: null,
        };
    }
    const persistedRuntimeStateBeforeSync = runtimeOnly === false
        ? await readLocalStrict(INJECTABLE_RUNTIME_STATE_KEY)
        : null;
    let registerResult = true;
    let reloadHint = null;
    let registrationChanged = false;
    let sandboxRulesChanged = false;
    let sandboxRegistrationSucceeded = true;
    let sandboxUserScriptsChanged = false;
    let sandboxCompiledUserScriptIntentChanged = false;
    let sandboxUserScriptsPending = false;
    let sandboxUserScriptsAvailabilityAffectsLiveDocuments = false;
    let sandboxUserScriptLiveReloadPending = null;
    let sandboxDnrSucceeded = true;
    let sandboxLastError = '';
    let sandboxRevision = 0;
    let refreshCustomFilters = false;
    if ( runtimeOnly !== true ) {
        const sandboxResult = await ensureUserScriptMessagingWorld()
            .then(() => reconcileSandboxFilters()).then(result => ({
            ok: true,
            changed: result?.changed === true,
            revision: Number(result?.revision) || 0,
            customFilterCount: Math.max(0, Number(result?.customFilterCount) || 0),
            userScriptsChanged: result?.userScriptsChanged === true,
            compiledUserScriptIntentChanged:
                result?.compiledUserScriptIntentChanged === true,
            userScriptsPending: result?.userScriptsPending === true,
            userScriptsAvailable: result?.userScriptsAvailable === true,
            userScriptsAvailabilityAffectsLiveDocuments:
                result?.userScriptsAvailabilityAffectsLiveDocuments === true,
            userScriptLiveReloadPending:
                result?.userScriptLiveReloadPending instanceof Object
                    ? result.userScriptLiveReloadPending
                    : null,
        })).catch(reason => ({
            ok: false,
            changed: false,
            revision: -1,
            customFilterCount: 0,
            userScriptsChanged: false,
            compiledUserScriptIntentChanged: false,
            userScriptsPending: false,
            userScriptsAvailable: false,
            userScriptsAvailabilityAffectsLiveDocuments: false,
            userScriptLiveReloadPending: null,
            lastError: String(reason || 'register sandbox filters failed'),
        }));
        sandboxRevision = sandboxResult.revision;
        sandboxRegistrationSucceeded = sandboxResult.ok === true;
        sandboxRulesChanged = sandboxResult.changed === true;
        sandboxUserScriptsChanged = sandboxResult.userScriptsChanged === true;
        sandboxCompiledUserScriptIntentChanged =
            sandboxResult.compiledUserScriptIntentChanged === true;
        sandboxUserScriptsPending = sandboxResult.userScriptsPending === true;
        sandboxUserScriptsAvailabilityAffectsLiveDocuments =
            sandboxResult.userScriptsAvailabilityAffectsLiveDocuments === true;
        sandboxUserScriptLiveReloadPending =
            sandboxResult.userScriptLiveReloadPending instanceof Object
                ? sandboxResult.userScriptLiveReloadPending
                : null;
        sandboxLastError = typeof sandboxResult.lastError === 'string'
            ? sandboxResult.lastError
            : '';
        if ( sandboxRegistrationSucceeded === false ) {
            ubolErr(`registerSandboxFilters/${sandboxLastError}`);
        }
        if (
            sandboxRegistrationSucceeded &&
            sandboxUserScriptLiveReloadPending instanceof Object
        ) {
            try {
                await markOpenTabsForSandboxUserScriptReload();
                const acknowledged =
                    await acknowledgeSandboxUserScriptLiveReload(
                        sandboxUserScriptLiveReloadPending
                    );
                if ( acknowledged !== true ) {
                    throw new Error(
                        'sandbox user-script reload marker was superseded'
                    );
                }
            } catch (reason) {
                sandboxRegistrationSucceeded = false;
                sandboxLastError = `${reason}`;
                ubolErr(`sandboxUserScripts/liveReloadMarker/${reason}`);
            }
        }

        const injectableResult = await registerInjectablesIfEntitled()
            .catch(reason => ({
                ok: false,
                lastError: String(reason || 'register injectables failed'),
            }));
        registerResult = injectableResult;
        let refreshRegistrationReloadWildcard =
            registerResult instanceof Object &&
            registerResult.remoteScriptletReloadHint instanceof Object;
        registrationChanged = registerResult instanceof Object && registerResult.ok === true && (
            (Number(registerResult.toAddCount) || 0) !== 0 ||
            (Number(registerResult.toUpdateCount) || 0) !== 0 ||
            (Number(registerResult.toRemoveCount) || 0) !== 0 ||
            registerResult.cosmeticDataChanged === true
        );
        reloadHint = registerResult instanceof Object && registerResult.ok === true
            ? registerResult.remoteScriptletReloadHint ?? null
            : null;
        const pendingReloadHint = await readLocalStrict(
            PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY
        );
        if ( pendingReloadHint instanceof Object ) {
            reloadHint = mergeRemoteScriptletReloadHints(
                reloadHint,
                pendingReloadHint
            );
        }
        if ( contentRegistrationResultIsUncertain(registerResult) ) {
            scheduleUncertainContentRegistrationReconciliation();
        }
        const extensionVersionChanged =
            registerResult instanceof Object &&
            registerResult.ok === true &&
            (
                persistedRuntimeStateBeforeSync instanceof Object === false ||
                typeof persistedRuntimeStateBeforeSync.version !== 'string' ||
                persistedRuntimeStateBeforeSync.version !== getCurrentVersion()
            );
        if ( extensionVersionChanged ) {
            if (
                typeof browser.scripting?.getRegisteredContentScripts !==
                    'function'
            ) {
                throw new Error(
                    'registered content-script API unavailable for update reload'
                );
            }
            const registeredAfterUpdate =
                await browser.scripting.getRegisteredContentScripts();
            if ( Array.isArray(registeredAfterUpdate) === false ) {
                throw new Error(
                    'invalid registered content-script update response'
                );
            }
            const updateReloadHint =
                packagedStaticScriptletReloadHintFromRegistrations(
                    registeredAfterUpdate
                );
            if ( updateReloadHint instanceof Object ) {
                refreshRegistrationReloadWildcard = true;
                reloadHint = mergeRemoteScriptletReloadHints(
                    reloadHint,
                    updateReloadHint
                );
                // The version transition is not a registration mutation, so
                // the manager cannot journal it. Persist before touching tabs;
                // a worker death must replay the exact document-start hint.
                await localWrite(
                    PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,
                    reloadHint
                );
            }
        }
        await applyContentRegistrationReloadHint(registerResult, reloadHint, {
            refreshWildcard: refreshRegistrationReloadWildcard,
        });
        const [
            sandboxAppliedRevisionValue,
            sandboxLiveStateDirty,
            persistedInjectableRuntimeState,
        ] =
            await Promise.all([
                readLocalStrict(SANDBOX_REGISTRATION_APPLIED_REVISION_KEY)
                    .catch(() => -1),
                readLocalStrict(SANDBOX_REGISTRATION_DIRTY_KEY)
                    .catch(() => true),
                readLocalStrict(INJECTABLE_RUNTIME_STATE_KEY)
                    .catch(() => null),
            ]);
        const sandboxAppliedRevision =
            Number(sandboxAppliedRevisionValue) || 0;
        const customRuntimeVersionMigrationRequired =
            sandboxResult.customFilterCount !== 0 &&
            persistedInjectableRuntimeState?.version !== getCurrentVersion();
        refreshCustomFilters =
            isDurableDirtyMarker(sandboxLiveStateDirty) ||
            sandboxAppliedRevision !== sandboxRevision ||
            customRuntimeVersionMigrationRequired ||
            sandboxUserScriptsChanged ||
            sandboxCompiledUserScriptIntentChanged ||
            sandboxUserScriptsAvailabilityAffectsLiveDocuments;
        if (
            sandboxRegistrationSucceeded &&
            (sandboxRulesChanged || sandboxAppliedRevision !== sandboxRevision)
        ) {
            try {
                await updateUserRulesAndAcknowledgeSandboxState();
            } catch (reason) {
                sandboxDnrSucceeded = false;
                sandboxLastError = `${reason}`;
                ubolErr(reason);
            }
        }
    }
    const runtimeFingerprint = runtimeOnly === false || refreshOpenTabs === true
        ? await computeInjectableRuntimeFingerprint().catch(() => '')
        : lastInjectableRuntimeFingerprint;
    const runtimeStateChanged =
        runtimeOnly === true ||
        registrationChanged === true ||
        refreshCustomFilters === true ||
        runtimeFingerprint !== lastInjectableRuntimeFingerprint;
    // `refreshOpenTabs: false` avoids work on an ordinary worker wake, but it
    // must not suppress the one-time live migration after an extension update
    // or a previously failed reconciliation.
    const shouldRefreshOpenTabs = runtimeStateChanged && (
        refreshOpenTabs === true || runtimeOnly === false
    );
    let runtimeRefreshSucceeded = true;
    if ( shouldRefreshOpenTabs ) {
        try {
            runtimeRefreshSucceeded = await refreshRuntimeStateForOpenTabs({
                refreshCustomFilters,
                // A previous pass may have updated registrations and then
                // failed while replacing live sheets. The durable fingerprint
                // intentionally remains old, so its delta is also the retry
                // signal even when this pass has no registration diff.
                refreshCoreCosmetics: registrationChanged ||
                    runtimeFingerprint !== lastInjectableRuntimeFingerprint,
                desiredFingerprint: runtimeFingerprint,
            }) === true;
        } catch (reason) {
            runtimeRefreshSucceeded = false;
            ubolErr(reason);
        }
    }
    const contentRegistrationSucceeded =
        registerResult === true ||
        (registerResult instanceof Object && registerResult.ok === true);
    let registrationSucceeded = contentRegistrationSucceeded &&
        sandboxRegistrationSucceeded && sandboxDnrSucceeded;
    const fingerprintSucceeded = typeof runtimeFingerprint === 'string' &&
        runtimeFingerprint !== '';
    let runtimeStatePersisted = runtimeOnly === true;
    if (
        runtimeOnly === false &&
        registrationSucceeded &&
        runtimeRefreshSucceeded &&
        fingerprintSucceeded
    ) {
        try {
            const currentRuntimeFingerprint =
                await computeInjectableRuntimeFingerprint();
            if ( currentRuntimeFingerprint !== runtimeFingerprint ) {
                runtimeRefreshSucceeded = false;
                syncInjectablesAndRefreshTabs({
                    runtimeOnly: false,
                    refreshOpenTabs: true,
                }).catch(ubolErr);
            } else {
                await persistInjectableRuntimeState(runtimeFingerprint);
                runtimeStatePersisted = true;
            }
        } catch (reason) {
            runtimeStatePersisted = false;
            ubolErr(reason);
        }
    }
    // A sandbox revision is not fully applied until existing pages have also
    // replaced (or removed) their custom CSS and the new runtime fingerprint
    // is durable. A crash anywhere before this point must leave retry intent.
    if (
        runtimeOnly === false &&
        registrationSucceeded &&
        runtimeStatePersisted
    ) {
        try {
            await localWrite(
                SANDBOX_REGISTRATION_APPLIED_REVISION_KEY,
                sandboxRevision
            );
            await localRemove(SANDBOX_REGISTRATION_DIRTY_KEY);
        } catch (reason) {
            sandboxRegistrationSucceeded = false;
            sandboxLastError = `${reason}`;
            registrationSucceeded = false;
        }
    }
    const succeeded = registrationSucceeded &&
        runtimeRefreshSucceeded &&
        fingerprintSucceeded &&
        runtimeStatePersisted;
    if ( sandboxUserScriptsPending && sandboxLastError === '' ) {
        sandboxLastError = 'Chrome userScripts API is temporarily unavailable';
    }
    if ( succeeded === false || sandboxUserScriptsPending ) {
        await scheduleStartupInjectableRetry({
            delayInMinutes: sandboxUserScriptsPending ? 15 :
                INJECTABLE_STARTUP_RETRY_DELAY_MINUTES,
        }).catch(ubolErr);
    }
    return {
        registerResult,
        runtimeRefreshed: shouldRefreshOpenTabs && runtimeRefreshSucceeded,
        runtimeRefreshRequired: shouldRefreshOpenTabs,
        reloadHint,
        runtimeFingerprint,
        sandboxRulesChanged,
        sandboxRegistrationSucceeded,
        sandboxUserScriptsChanged,
        sandboxCompiledUserScriptIntentChanged,
        sandboxUserScriptsPending,
        sandboxUserScriptsAvailabilityAffectsLiveDocuments,
        sandboxUserScriptLiveReloadPending,
        sandboxDnrSucceeded,
        sandboxLastError,
        sandboxRevision,
        ok: succeeded,
    };
}

function syncInjectablesAndRefreshTabs(options = {}) {
    const run = injectableSyncTail
        .catch(() => undefined)
        .then(() => syncInjectablesAndRefreshTabsNow(options));
    injectableSyncTail = run.catch(() => undefined);
    return run;
}

const waitForInjectableSyncIdle = async () => {
    for (;;) {
        const observed = injectableSyncTail;
        await observed.then(() => undefined, () => undefined);
        if ( injectableSyncTail === observed ) { return; }
    }
};

setAdminRuntimeReconciler(() => syncInjectablesAndRefreshTabs({
    runtimeOnly: false,
    refreshOpenTabs: true,
}));
setAdminDeveloperModeDisabler(() => setDeveloperMode(false));

async function ensureStartupInjectableState() {
    if ( isEntitled() === false ) {
        return {
            skipped: 'not_entitled',
            registerResult: false,
            runtimeRefreshed: false,
        };
    }
    resumeRegistrationMutationsAfterPaywall();
    if ( await canReusePersistedInjectableRuntimeState().catch(() => false) ) {
        return {
            skipped: 'unchanged',
            registerResult: true,
            runtimeRefreshed: false,
        };
    }
    // Registered content scripts persist across MV3 worker shutdown. Repair
    // missing or stale state, but never rescan every already-open page merely
    // because Chrome evicted and restarted the worker.
    const result = await syncInjectablesAndRefreshTabs({
        runtimeOnly: false,
        refreshOpenTabs: false,
    });
    if ( result?.ok !== true ) {
        throw new Error(
            result?.sandboxLastError || 'startup injectable restoration failed'
        );
    }
    if ( result?.sandboxUserScriptsPending === true ) {
        return result;
    }
    if ( await canReusePersistedInjectableRuntimeState() !== true ) {
        throw new Error('startup injectable verification failed');
    }
    return result;
}

function registerInjectablesIfEntitled() {
    if (isEntitled() === false) { return Promise.resolve(false); }
    return registerInjectables();
}

async function scrubPrivateProofState() {
    const [ communityState ] = await Promise.all([
        scrubPrivateCommunityState('developer-mode-off'),
        localRemove(BREAKAGE_AUDIT_OVERRIDES_KEY).catch(() => {}),
    ]);
    return communityState || {
        cleanupReason: '',
        requiresInjectableRefresh: false,
    };
}

async function handleCommunitySyncResult(result) {
    if (result instanceof Object === false) { return result; }
    if (typeof result.cleanupReason === 'string' && result.cleanupReason !== '') {
        lastCommunityCleanupReason = result.cleanupReason;
    } else if (
        result.source === 'remote' ||
        result.source === 'overlay' ||
        result.source === 'overlay-not-modified' ||
        result.source === 'overlay-removed'
    ) {
        lastCommunityCleanupReason = '';
    }

    const activation = result.activation;
    if ( activation instanceof Object ) {
        const describeInjectableFailure = value => {
            if ( value instanceof Object ) {
                if ( value.ok === true ) { return ''; }
                if ( typeof value.lastError === 'string' && value.lastError !== '' ) {
                    return value.lastError;
                }
                if ( typeof value.initialError === 'string' && value.initialError !== '' ) {
                    return value.initialError;
                }
            }
            return 'injectable activation failed';
        };
        const appendCommunitySyncError = async extraMessage => {
            if ( typeof extraMessage !== 'string' || extraMessage === '' ) { return; }
            try {
                const current = await localRead('communityBundleLastError');
                const message = typeof current === 'string' && current !== ''
                    ? `${current}; ${extraMessage}`
                    : extraMessage;
                await localWrite('communityBundleLastError', message);
            } catch (reason) {
                ubolErr(`community-sync/append-error/${reason}`);
            }
        };
        const rollbackActivation = async failureReason => {
            const rollbackResult = await rollbackCommunityActivation(
                activation,
                failureReason
            ).catch(reason => {
                ubolErr(`community-sync/rollback/${reason}`);
                return {
                    lastError: String(reason || failureReason || 'rollback failed'),
                };
            });
            const restoreSyncResult = await syncInjectablesAndRefreshTabs({
                runtimeOnly: false,
            }).catch(reason => ({
                registerResult: {
                    ok: false,
                    lastError: String(reason || 'rollback injectable restore failed'),
                },
                runtimeRefreshed: false,
            }));
            const restoreResult = restoreSyncResult?.registerResult;
            if ( restoreResult instanceof Object && restoreResult.ok !== true ) {
                await appendCommunitySyncError(
                    `rollback injectable restore failed: ${describeInjectableFailure(restoreResult)}`
                );
            }
            return {
                ...result,
                source: 'remote-rolled-back',
                rolledBack: true,
                error: rollbackResult?.lastError || String(failureReason || ''),
            };
        };

        try {
            if ( result.requiresInjectableRefresh ) {
                await resetRemoteCosmeticsRuntimeStats().catch(ubolErr);
                const syncResult = await syncInjectablesAndRefreshTabs({
                    runtimeOnly: false,
                });
                const injectableResult = syncResult?.registerResult;
                if (
                    injectableResult instanceof Object
                        ? injectableResult.ok !== true
                        : injectableResult !== true
                ) {
                    return rollbackActivation(describeInjectableFailure(injectableResult));
                }
            }
            await finalizeCommunityActivationSuccess(activation);
            return result;
        } catch (reason) {
            return rollbackActivation(String(reason || 'remote activation failed'));
        }
    }

    if ( result.requiresInjectableRefresh ) {
        await resetRemoteCosmeticsRuntimeStats().catch(ubolErr);
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
    }
    return result;
}

function runCommunitySync(options) {
    return runCommunityBaselineSync(options);
}

const enqueueCommunityApply = job => {
    const run = communityApplyQueue
        .catch(() => {})
        .then(job);
    communityApplyQueue = run.catch(() => {});
    return run;
};

function runCommunityBaselineSync(options) {
    const normalized = options instanceof Object
        ? { ...options }
        : {};
    if ( communityBaselineSyncInFlight !== undefined ) {
        if ( normalized.force === true ) {
            communityBaselineForceQueued = true;
        }
        return communityBaselineSyncInFlight;
    }
    communityBaselineSyncInFlight = enqueueCommunityApply(async () => {
        try {
            const result = await syncCommunityRules(normalized);
            return await handleCommunitySyncResult(result);
        } catch (reason) {
            ubolErr(`community-sync/baseline/${reason}`);
        } finally {
            communityBaselineSyncInFlight = undefined;
            if ( communityBaselineForceQueued ) {
                communityBaselineForceQueued = false;
                runCommunityBaselineSync({ force: true });
            }
        }
    });
    return communityBaselineSyncInFlight;
}

function runCommunityOverlaySync(options) {
    const normalized = options instanceof Object
        ? { ...options }
        : {};
    const siteKey = normalizeAutoPromotedHostname(normalized.siteKey);
    if ( siteKey === '' ) {
        return Promise.resolve({ skipped: 'invalid-site-key' });
    }
    if ( communityOverlaySyncInFlight.has(siteKey) ) {
        return communityOverlaySyncInFlight.get(siteKey);
    }
    const promise = enqueueCommunityApply(async () => {
        try {
            let result = await syncCommunityOverlayRules({
                siteKey,
                force: normalized.force === true,
                reason: normalized.reason,
            });
            if ( result?.retryWithForcedBaseline === true ) {
                await handleCommunitySyncResult(
                    await syncCommunityRules({ force: true })
                );
                result = await syncCommunityOverlayRules({
                    siteKey,
                    force: true,
                    reason: normalized.reason,
                });
            }
            return await handleCommunitySyncResult(result);
        } catch (reason) {
            ubolErr(`community-sync/overlay/${reason}`);
        } finally {
            communityOverlaySyncInFlight.delete(siteKey);
        }
    });
    communityOverlaySyncInFlight.set(siteKey, promise);
    return promise;
}

async function getRegisteredContentScriptsAuditSnapshot() {
    if (browser.scripting?.getRegisteredContentScripts === undefined) {
        return [];
    }
    try {
        const registered = await browser.scripting.getRegisteredContentScripts();
        return registered
            .filter(entry => entry instanceof Object && typeof entry.id === 'string')
            .map(entry => ({
                id: entry.id,
                js: Array.isArray(entry.js) ? entry.js.slice().sort() : [],
                css: Array.isArray(entry.css) ? entry.css.slice().sort() : [],
                matches: Array.isArray(entry.matches) ? entry.matches.slice().sort() : [],
                excludeMatches: Array.isArray(entry.excludeMatches)
                    ? entry.excludeMatches.slice().sort()
                    : [],
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
    } catch (reason) {
        ubolErr(`getRegisteredContentScriptsAuditSnapshot/${reason}`);
    }
    return [];
}

const packagedStaticScriptletReloadHintFromRegistrations = (
    registrations,
    { removed = false } = {}
) => {
    const hint = { before: [], after: [] };
    for ( const registration of registrations || [] ) {
        if ( isRemoteScriptletDirectiveId(registration?.id) ) {
            hint[removed ? 'before' : 'after'].push(registration);
            continue;
        }
        recordPackagedStaticScriptletReloadTransition(
            hint,
            removed ? registration : undefined,
            removed ? undefined : registration
        );
    }
    return normalizeRemoteScriptletReloadHint(hint);
};

async function unregisterAllContentScripts() {
    if ( typeof browser.scripting?.getRegisteredContentScripts !== 'function' ) {
        throw new Error('registered content-script API unavailable');
    }
    if ( typeof browser.scripting?.unregisterContentScripts !== 'function' ) {
        throw new Error('content-script unregister API unavailable');
    }
    const before = await browser.scripting.getRegisteredContentScripts();
    if ( Array.isArray(before) === false ) {
        throw new Error('invalid registered content-script response');
    }
    const packagedScriptletReloadHint =
        packagedStaticScriptletReloadHintFromRegistrations(before, {
            removed: true,
        });
    if ( packagedScriptletReloadHint instanceof Object ) {
        const pendingHint = await readLocalStrict(
            PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY
        );
        await localWrite(
            PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,
            mergeRemoteScriptletReloadHints(
                pendingHint,
                packagedScriptletReloadHint
            )
        );
    }
    // The no-argument form also cancels registrations still pending async
    // validation, which getRegisteredContentScripts() does not expose.
    await browser.scripting.unregisterContentScripts();
    const result = await unregisterAndVerifyManagedRegistrations({
        listRegistrations: () => browser.scripting.getRegisteredContentScripts(),
        unregisterRegistrations: ids =>
            browser.scripting.unregisterContentScripts({ ids }),
        label: 'content scripts',
    });
    return {
        ...result,
        removedIds: Array.isArray(before)
            ? before.map(entry => entry?.id).filter(Boolean)
            : [],
        packagedScriptletReloadHint,
    };
}

async function unregisterAllUserScripts({ retryAttempt = 0 } = {}) {
    const [
        mayExistMarker,
        persistedRuntimeState,
        cleanupPendingMarker,
    ] = await Promise.all([
        readLocalStrict(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY).catch(() => true),
        readLocalStrict(INJECTABLE_RUNTIME_STATE_KEY).catch(() => true),
        // A previous unavailable cleanup is itself durable evidence. Never
        // discard it merely because a newer runtime snapshot looks empty.
        readLocalStrict(USER_SCRIPTS_CLEANUP_PENDING_KEY).catch(() => true),
    ]);
    const runtimeStateMayContainManagedScripts = (() => {
        if ( persistedRuntimeState === undefined ) { return false; }
        if ( persistedRuntimeState === true ) { return true; }
        if (
            persistedRuntimeState === null ||
            typeof persistedRuntimeState !== 'object' ||
            Array.isArray(persistedRuntimeState) ||
            Array.isArray(persistedRuntimeState.managedUserScriptIds) === false
        ) { return true; }
        return persistedRuntimeState.managedUserScriptIds.length !== 0;
    })();
    const mayExist = (
        mayExistMarker !== undefined && mayExistMarker !== false
    ) || runtimeStateMayContainManagedScripts || (
        cleanupPendingMarker !== undefined && cleanupPendingMarker !== false
    );
    const normalizedAttempt = Math.max(
        0,
        Number(retryAttempt) || 0,
        Number(cleanupPendingMarker?.attempt) || 0
    );
    if ( mayExist ) {
        // Persist the cleanup transaction before touching Chrome. A worker
        // death, timeout, or browser API failure must leave enough evidence
        // for the next wake to cancel a late registration.
        const now = Date.now();
        await localWrite(USER_SCRIPTS_CLEANUP_PENDING_KEY, {
            attempt: normalizedAttempt + 1,
            scheduledAt: now,
            nextAttemptAt: now +
                USER_SCRIPTS_CLEANUP_OPPORTUNISTIC_PROBE_INTERVAL_MS,
        });
        userScriptsCleanupPendingKnown = true;
    }
    const deferUnavailableCleanup = async () => {
        if ( mayExist ) {
            if ( typeof browser.alarms?.create !== 'function' ) {
                throw new Error('user-script cleanup alarm API unavailable');
            }
            await browser.alarms.create(USER_SCRIPTS_CLEANUP_RETRY_ALARM, {
                delayInMinutes: USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES,
            });
        } else {
            userScriptsCleanupPendingKnown = false;
        }
        return {
            ok: true,
            skipped: 'unavailable',
            cleanupPending: mayExist,
            liveDocumentsMayContainManagedScripts: mayExist,
            attempts: 0,
            removedIds: [],
        };
    };
    if ( browser.userScripts instanceof Object === false ) {
        // Chrome keeps registrations while its toggle is off. The loader is
        // disabled now, so paywall startup can complete, but retain durable
        // cleanup evidence whenever managed registrations may have existed.
        return deferUnavailableCleanup();
    }
    if ( typeof browser.userScripts?.getScripts !== 'function' ) {
        throw new Error('registered user-script API unavailable');
    }
    if ( typeof browser.userScripts?.unregister !== 'function' ) {
        throw new Error('user-script unregister API unavailable');
    }
    let result;
    try {
        const before = await browser.userScripts.getScripts();
        // Clear both committed and pending dynamic script IDs. Listing alone
        // cannot see another worker generation's in-flight registration.
        await browser.userScripts.unregister();
        result = await unregisterAndVerifyManagedRegistrations({
            listRegistrations: () => browser.userScripts.getScripts(),
            unregisterRegistrations: ids => browser.userScripts.unregister({ ids }),
            label: 'user scripts',
        });
        result = {
            ...result,
            removedIds: Array.isArray(before)
                ? before.map(entry => entry?.id).filter(Boolean)
                : [],
        };
    } catch (reason) {
        if ( isUserScriptsAvailable() === false ) {
            return deferUnavailableCleanup();
        }
        throw reason;
    }
    await Promise.all([
        localRemove(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY),
        localRemove(USER_SCRIPTS_CLEANUP_PENDING_KEY),
        browser.alarms?.clear?.(USER_SCRIPTS_CLEANUP_RETRY_ALARM),
    ]);
    userScriptsCleanupPendingKnown = false;
    return {
        ...result,
        liveDocumentsMayContainManagedScripts: mayExist ||
            (Array.isArray(result?.removedIds) && result.removedIds.length !== 0),
    };
}

function unregisterAllUserScriptsSingleFlight(options) {
    if ( userScriptsPaywallCleanupPromise instanceof Promise ) {
        return userScriptsPaywallCleanupPromise;
    }
    const operation = unregisterAllUserScripts(options);
    userScriptsPaywallCleanupPromise = operation;
    operation.finally(() => {
        if ( userScriptsPaywallCleanupPromise === operation ) {
            userScriptsPaywallCleanupPromise = undefined;
        }
    }).catch(() => {});
    return operation;
}

async function opportunisticallyCleanupPaywalledUserScripts() {
    if (
        entitlementInitialized === false ||
        isEntitled() ||
        paywallActive === false
    ) {
        return { skipped: 'not_paywalled' };
    }
    const pending = await readLocalStrict(USER_SCRIPTS_CLEANUP_PENDING_KEY);
    if ( isDurableDirtyMarker(pending) === false ) {
        userScriptsCleanupPendingKnown = false;
        return { skipped: 'not_pending' };
    }
    userScriptsCleanupPendingKnown = true;
    // Avoid resetting the one-minute alarm on ordinary events while the API
    // remains unavailable. The event path exists to close the re-enable gap.
    if ( isUserScriptsAvailable() === false ) {
        return { skipped: 'unavailable' };
    }
    const retryAttempt = pending instanceof Object
        ? Math.max(0, Number(pending.attempt) || 0)
        : 0;
    const result = await unregisterAllUserScriptsSingleFlight({ retryAttempt });
    if ( result?.liveDocumentsMayContainManagedScripts === true ) {
        await markOpenTabsForSandboxUserScriptReload();
    }
    return result;
}

function observePendingUserScriptsPaywallCleanup() {
    if ( userScriptsCleanupPendingKnown === false ) { return; }
    if ( opportunisticUserScriptsCleanupPromise instanceof Promise ) { return; }
    const now = Date.now();
    if ( now < nextOpportunisticUserScriptsCleanupProbeAt ) { return; }
    nextOpportunisticUserScriptsCleanupProbeAt = now +
        USER_SCRIPTS_CLEANUP_OPPORTUNISTIC_PROBE_INTERVAL_MS;
    const operation = Promise.resolve(isFullyInitialized)
        .then(() => enqueueEntitlementAction(
            opportunisticallyCleanupPaywalledUserScripts
        ))
        .catch(async reason => {
            ubolErr(`opportunistic user-script cleanup/${reason}`);
            if ( userScriptsCleanupPendingKnown !== true ) { return; }
            await browser.alarms?.create?.(USER_SCRIPTS_CLEANUP_RETRY_ALARM, {
                delayInMinutes: USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES,
            });
        });
    opportunisticUserScriptsCleanupPromise = operation;
    operation.finally(() => {
        if ( opportunisticUserScriptsCleanupPromise === operation ) {
            opportunisticUserScriptsCleanupPromise = undefined;
        }
    }).catch(() => {});
}

function suspendRegistrationMutationsForPaywall() {
    livePageMutationGeneration += 1;
    registrationMutationsSuspendedForPaywall = true;
    lifecycleRuntimeRefreshSuspendedForPaywall = true;
    setInjectableRegistrationSuspended(true);
    setSandboxFilterRegistrationSuspended(true);
}

async function waitForRegistrationMutationsToSettle() {
    for (;;) {
        await Promise.all([
            waitForInjectableSyncIdle(),
            waitForInjectableRegistrationIdle(),
            waitForSandboxFilterOperations(),
            waitForResumedTabRuntimeIdle(),
            waitForOpenTabRuntimeRefreshIdle(),
            waitForEntitlementOpenTabRefreshIdle(),
            waitForSuspendedRuntimeReconcilePersistence(),
            waitForSuspendedOpenTabRuntimeRefreshPersistence(),
            waitForLivePageMutations(),
            waitForPendingTimedOutRuntimeScripts(),
        ]);
        if (
            resumedTabRuntimeTails.size === 0 &&
            openTabRuntimeRefreshPromise instanceof Promise === false &&
            entitlementOpenTabRefreshPromise instanceof Promise === false &&
            pendingSuspendedRuntimeReconcileOperations.size === 0 &&
            pendingLivePageMutations.size === 0 &&
            pendingRuntimeScriptOperations.size === 0 &&
            pendingTimedOutRuntimeScripts.size === 0
        ) {
            break;
        }
    }
    if (
        hasTimedOutRegistrationOperations() === false &&
        hasTimedOutSandboxFilterOperations() === false
    ) { return; }
    try {
        await raceWithTimeout(
            Promise.allSettled([
                waitForTimedOutRegistrationOperations(),
                waitForTimedOutSandboxFilterOperations(),
            ]),
            PAYWALL_REGISTRATION_SETTLE_TIMEOUT_MS,
            'timed-out registration operation is still unsettled'
        );
    } catch (reason) {
        schedulePaywallCleanupAfterTimedOperation();
        throw reason;
    }
    if (
        hasTimedOutRegistrationOperations() ||
        hasTimedOutSandboxFilterOperations()
    ) {
        schedulePaywallCleanupAfterTimedOperation();
        throw new Error('content-script registration operation is still unsettled');
    }
}

function schedulePaywallCleanupAfterTimedOperation(operationPromise) {
    if ( timedOutPaywallCleanupPromise instanceof Promise ) {
        return timedOutPaywallCleanupPromise;
    }
    const settlement = operationPromise ?? Promise.allSettled([
            waitForTimedOutRegistrationOperations(),
            waitForTimedOutSandboxFilterOperations(),
        ]);
    timedOutPaywallCleanupPromise = Promise.resolve(settlement)
        .then(() => {
            if ( paywallActive === false || isEntitled() ) { return; }
            return enablePaywall({ broadcast: false });
        })
        .catch(reason => {
            ubolErr(`paywall/timed-registration-cleanup/${reason}`);
        })
        .finally(() => {
            timedOutPaywallCleanupPromise = undefined;
        });
    return timedOutPaywallCleanupPromise;
}

function resumeRegistrationMutationsAfterPaywall() {
    registrationMutationsSuspendedForPaywall = false;
    lifecycleRuntimeRefreshSuspendedForPaywall = false;
    setInjectableRegistrationSuspended(false);
    setSandboxFilterRegistrationSuspended(false);
}

async function enablePaywallNow({ broadcast = true } = {}) {
    // Resolve any document-runtime startup waiters before terminators drain
    // their readiness promises. Otherwise an expired cold start can form a
    // cycle: paywall cleanup waits for a script which is waiting for startup.
    settleStartupDocumentRuntimeUnavailable('not_entitled');
    suspendRegistrationMutationsForPaywall();
    await raceWithTimeout(
        trackPaywallMutation(dnr.setAllowAllRules(
            PAYWALL_RULE_BASE_ID,
            [],
            [],
            true,
            PAYWALL_RULE_PRIORITY
        )),
        PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
        'paywall allow-all DNR update timed out'
    );
    paywallActive = true;
    try {
        const swallowPromise = p => {
            if ( p && typeof p.catch === 'function' ) {
                p.catch(( ) => { });
            }
        };
        if (typeof dnr.setExtensionActionOptions === 'function') {
            dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: false });
        }
        swallowPromise(browser.action?.setBadgeBackgroundColor?.({ color: '#ef4444' }));
        // Keep the badge short so it's visible on all platforms.
        swallowPromise(browser.action?.setBadgeTextColor?.({ color: '#ffffff' }));
        swallowPromise(browser.action?.setBadgeText?.({ text: '!' }));
        swallowPromise(browser.action?.setTitle?.({ title: 'Action needed: Activate Talon Defender' }));
        const paywallIcon = {
            '16': '/icons/shield_warning16.png',
            '32': '/icons/shield_warning32.png',
            '128': '/icons/shield_warning128.png'
        };
        swallowPromise(browser.action?.setIcon?.({ path: paywallIcon }));
        // Ensure per-tab icon overrides can't hide the paywall state.
        const paywallTabsPromise = browser.tabs?.query?.({});
        if (paywallTabsPromise && typeof paywallTabsPromise.then === 'function') {
            paywallTabsPromise.then(tabs => {
                for (const tab of tabs || []) {
                    if (typeof tab?.id !== 'number') { continue; }
                    swallowPromise(browser.action?.setIcon?.({ tabId: tab.id, path: paywallIcon }));
                    swallowPromise(browser.action?.setBadgeText?.({ tabId: tab.id, text: '!' }));
                    swallowPromise(browser.action?.setTitle?.({ tabId: tab.id, title: 'Action needed: Activate Talon Defender' }));
                }
            }).catch(() => { });
        }
    } catch {
    }
    const registrationDrain = trackPaywallMutation(
        waitForRegistrationMutationsToSettle()
    );
    const boundedRegistrationDrain = raceWithTimeout(
        registrationDrain,
        PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
        'paywall registration drain timed out'
    ).catch(reason => {
        schedulePaywallCleanupAfterTimedOperation(registrationDrain);
        throw reason;
    });
    const preparationResults = await Promise.allSettled([
        boundedRegistrationDrain,
    ]);
    const unregistrationResults = await Promise.allSettled([
        raceWithTimeout(
            trackPaywallMutation(unregisterAllContentScripts()),
            PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
            'paywall content-script cleanup timed out'
        ),
        raceWithTimeout(
            trackPaywallMutation(unregisterAllUserScriptsSingleFlight()),
            PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
            'paywall user-script cleanup timed out'
        ),
    ]);
    const userScriptCleanupResult = unregistrationResults[1];
    const contentScriptCleanupResult = unregistrationResults[0];
    const packagedScriptletReloadResults = await Promise.allSettled([
        (async () => {
            if ( contentScriptCleanupResult?.status === 'rejected' ) {
                // The pre-unregister snapshot is unavailable or untrusted.
                // Conservatively protect every live/BFCache document rather
                // than letting non-reversible packaged hooks survive expiry.
                await markOpenTabsForSandboxUserScriptReload();
                return;
            }
            // A previous worker may have durably journaled the removal and
            // died after Chrome unregistered the scripts. Replay that marker
            // even when this worker's fresh pre-unregister snapshot is empty.
            const pendingHint = await readLocalStrict(
                PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY
            );
            const reloadHint = mergeRemoteScriptletReloadHints(
                pendingHint,
                contentScriptCleanupResult?.value
                    ?.packagedScriptletReloadHint
            );
            if ( reloadHint instanceof Object === false ) { return; }
            await markTabsForRemoteScriptletReload(reloadHint, {
                refreshWildcard:
                    contentScriptCleanupResult?.value
                        ?.packagedScriptletReloadHint instanceof Object,
            });
            await localRemove(PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY);
        })(),
    ]);
    const sandboxLiveReloadResults = (
        userScriptCleanupResult?.status === 'rejected' ||
        userScriptCleanupResult?.value?.liveDocumentsMayContainManagedScripts === true
    ) ? await Promise.allSettled([
        markOpenTabsForSandboxUserScriptReload(),
    ]) : [];
    // Only enumerate and terminate documents after both registration lanes
    // are unregistered. A navigation between the frame snapshot and cleanup
    // can then create only a clean document, never a newly injected one.
    const openTabCleanup = stopRuntimeStateForOpenTabs().then(stopped => {
        if ( stopped !== true ) {
            throw new Error('paywall open-tab cleanup was not verified');
        }
        return true;
    });
    const runtimeCleanupResults = await Promise.allSettled([
        raceWithTimeout(
            trackPaywallMutation(openTabCleanup),
            PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
            'paywall open-tab cleanup timed out'
        ),
    ]);
    const failures = [
        ...preparationResults,
        ...unregistrationResults,
        ...packagedScriptletReloadResults,
        ...sandboxLiveReloadResults,
        ...runtimeCleanupResults,
    ]
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
    // Any expiry pass may have stopped only part of an open document before a
    // later lane failed. Preserve the paid-generation repair request even on
    // rejection; it remains dormant while expired and drains after a verified
    // entitlement restore.
    rememberSuspendedOpenTabRuntimeRefresh({
        refreshCustomFilters: true,
        refreshCoreCosmetics: true,
    });
    await waitForSuspendedOpenTabRuntimeRefreshPersistence();
    if ( failures.length !== 0 ) {
        throw new Error(
            `paywall cleanup verification failed: ${failures.map(reason =>
                reason instanceof Error ? reason.message : String(reason)
            ).join('; ')}`
        );
    }
    if (broadcast) {
        broadcastMessage({ entitlement: entitlementStatus });
    }
}

async function clearPaywallAllowAllRulesNow() {
    return raceWithTimeout(
        trackPaywallMutation(dnr.setAllowAllRules(
            PAYWALL_RULE_BASE_ID,
            [],
            [],
            false,
            PAYWALL_RULE_PRIORITY
        )),
        PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
        'paywall allow-all cleanup timed out'
    );
}

async function disablePaywallNow({ broadcast = true } = {}) {
    await prepareEntitledRestoreAfterPaywallMutations();
    await clearPaywallAllowAllRulesNow();
    paywallActive = false;
    paywallMutationReconciliationRequired = false;
    await Promise.all([
        localRemove(USER_SCRIPTS_CLEANUP_PENDING_KEY),
        browser.alarms?.clear?.(USER_SCRIPTS_CLEANUP_RETRY_ALARM),
    ]);
    userScriptsCleanupPendingKnown = false;
    try {
        const swallowPromise = p => {
            if ( p && typeof p.catch === 'function' ) {
                p.catch(( ) => { });
            }
        };
        if (typeof dnr.setExtensionActionOptions === 'function') {
            dnr.setExtensionActionOptions({
                displayActionCountAsBadgeText: false,
            });
        }
        swallowPromise(browser.action?.setBadgeText?.({ text: '' }));
        swallowPromise(browser.action?.setTitle?.({ title: 'Talon Defender' }));
        const normalIcon = {
            '16': '/icons/icon16.png',
            '32': '/icons/icon32.png',
            '128': '/icons/icon128.png'
        };
        swallowPromise(browser.action?.setIcon?.({ path: normalIcon }));
        // Reset any per-tab overrides set while the paywall was active.
        const normalTabsPromise = browser.tabs?.query?.({});
        if (normalTabsPromise && typeof normalTabsPromise.then === 'function') {
            normalTabsPromise.then(tabs => {
                for (const tab of tabs || []) {
                    if (typeof tab?.id !== 'number') { continue; }
                    swallowPromise(browser.action?.setIcon?.({ tabId: tab.id, path: normalIcon }));
                    swallowPromise(browser.action?.setBadgeText?.({ tabId: tab.id, text: '' }));
                    swallowPromise(browser.action?.setTitle?.({ tabId: tab.id, title: 'Talon Defender' }));
                }
            }).catch(() => { });
        }
    } catch {
    }
    await refreshReloadNeededBadges().catch(ubolErr);
    await syncToolbarIconsForAllTabs().catch(ubolErr);
    if (broadcast) {
        broadcastMessage({ entitlement: entitlementStatus });
    }
}

async function scheduleEntitlementAlarms(status) {
    if (browser.alarms?.create === undefined) { return; }
    // Hourly: catches trial expiry even if the browser was asleep.
    await browser.alarms.create(ENTITLEMENT_CHECK_ALARM, {
        delayInMinutes: 60,
        periodInMinutes: 60,
    });

    if (status?.status === 'trial' && typeof status.trialEndMs === 'number') {
        const when = status.trialEndMs + 2000;
        if (Number.isFinite(when) && when > Date.now()) {
            await browser.alarms.create(ENTITLEMENT_EXPIRE_ALARM, { when });
            return;
        }
    }
    await browser.alarms?.clear?.(ENTITLEMENT_EXPIRE_ALARM);
}

async function scheduleTrialExpiredReminderAlarm(status) {
    if (browser.alarms?.create === undefined) { return; }

    if (shouldEnablePaywallForStatus(status) === false) {
        await browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    const now = Date.now();
    const storedLastShown = Number(
        await readLocalStrict(TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY)
    ) || 0;
    const when = getTrialReminderWhen({
        status,
        now,
        lastShownMs: storedLastShown,
        initialDelayMs: TRIAL_EXPIRED_REMINDER_INITIAL_DELAY_MS,
        intervalMs: TRIAL_EXPIRED_REMINDER_INTERVAL_MS,
    });
    if (Number.isFinite(when) === false) {
        await browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    await browser.alarms.create(TRIAL_EXPIRED_REMINDER_ALARM, {
        when,
        periodInMinutes: TRIAL_EXPIRED_REMINDER_PERIOD_MINUTES,
    });
}

async function maybeShowTrialExpiredReminder() {
    const status = await enforceEntitlement({ verify: true });
    if (shouldEnablePaywallForStatus(status) === false) {
        await browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    const now = Date.now();
    const lastShownMs = Number(
        await readLocalStrict(TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY)
    ) || 0;
    if (lastShownMs > 0 && (now - lastShownMs) < TRIAL_EXPIRED_REMINDER_INTERVAL_MS) {
        return;
    }

    const url = buildTrialExpiredReminderURL();
    let opened = false;
    try {
        await gotoURL(url);
        opened = true;
    } catch (reason) {
        ubolErr(`trial-expired-reminder/gotoURL/${reason}`);
    }
    if (shouldRecordTrialReminderShown(opened)) {
        await localWrite(TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY, now).catch(ubolErr);
    }
    await scheduleTrialExpiredReminderAlarm(status);
}

function enqueueEntitlementAction(
    operation,
    { allowAfterStartupFailure = false } = {}
) {
    // Bind each action to the startup generation which existed when it was
    // queued. A later full recovery may install a new pending barrier while an
    // older action is still behind the entitlement tail; reading the global
    // barrier lazily there would create an A-waits-R / R-waits-A cycle.
    const requiredBarrier = startupMutationBarrier;
    const run = entitlementActionTail
        .catch(reason => {
            ubolErr(`entitlement/previous/${reason}`);
        })
        .then(() => allowAfterStartupFailure
            ? undefined
            : requiredBarrier)
        .then(operation);
    entitlementActionTail = run.catch(() => {});
    return run;
}

async function refreshEntitlement({ verify = false, forceVerify = false } = {}) {
    await initEntitlement();
    if (verify) {
        await verifyLicense({ force: forceVerify }).catch(() => { });
    }
    setEntitlementStatusForRuntime(await getEntitlementStatusFromStorage());
    await scheduleEntitlementAlarms(entitlementStatus);
    await scheduleTrialExpiredReminderAlarm(entitlementStatus);
    return entitlementStatus;
}

async function formatEntitlementStatusResponse(status) {
    const stored = await readEntitlement().catch(() => ({}));
    return Object.assign({}, status, {
        lastError: typeof stored.lastError === 'string' ? stored.lastError : '',
        lastErrorCode: typeof stored.lastErrorCode === 'string' ? stored.lastErrorCode : '',
        lastErrorMessage: typeof stored.lastErrorMessage === 'string' ? stored.lastErrorMessage : '',
        lastErrorAction: typeof stored.lastErrorAction === 'string' ? stored.lastErrorAction : '',
    });
}

async function scheduleEntitlementEffectsRetry() {
    if ( typeof browser.alarms?.create !== 'function' ) { return; }
    const result = browser.alarms.create(ENTITLEMENT_EFFECTS_RETRY_ALARM, {
        delayInMinutes: ENTITLEMENT_EFFECTS_RETRY_DELAY_MINUTES,
    });
    if ( result && typeof result.then === 'function' ) {
        await result;
    }
}

async function clearEntitlementEffectsRetry() {
    if ( typeof browser.alarms?.clear !== 'function' ) { return; }
    await browser.alarms.clear(ENTITLEMENT_EFFECTS_RETRY_ALARM);
}

async function markEntitlementEffectsDirty() {
    await localWrite(ENTITLEMENT_EFFECTS_DIRTY_KEY, true);
    await scheduleEntitlementEffectsRetry().catch(reason => {
        ubolErr(`entitlement/retry-schedule/${reason}`);
    });
}

async function clearEntitlementEffectsDirty() {
    await localRemove(ENTITLEMENT_EFFECTS_DIRTY_KEY);
}

async function ensureEntitledRegistrationEffects({
    refreshOpenTabs = false,
} = {}) {
    resumeRegistrationMutationsAfterPaywall();
    if ( await canReusePersistedInjectableRuntimeState().catch(() => false) ) {
        return { ok: true, skipped: 'unchanged' };
    }
    const syncResult = await syncInjectablesAndRefreshTabs({
        runtimeOnly: false,
        refreshOpenTabs,
    });
    if ( syncResult?.ok !== true ) {
        throw new Error(
            syncResult?.sandboxLastError || 'entitled runtime restoration failed'
        );
    }
    if ( syncResult?.sandboxUserScriptsPending === true ) {
        return syncResult;
    }
    if ( await canReusePersistedInjectableRuntimeState() !== true ) {
        throw new Error('entitled runtime registration verification failed');
    }
    return syncResult;
}

async function applyEntitlementStatusEffects(
    status,
    {
        broadcast = true,
        paywallWasActive = paywallActive,
        previousStatus = entitlementStatus,
        registerInjectablesOnEntitled = true,
        refreshOpenTabsOnEntitled = true,
        repairAllowAllRules = false,
    } = {}
) {
    const effectsRevision = ++entitlementEffectsRevision;
    let registrationEffectsPending = false;
    return runDurableEntitlementEffects({
        markDirty: markEntitlementEffectsDirty,
        applyEffects: async () => {
            if ( shouldEnablePaywallForStatus(status) ) {
                await enablePaywall({ broadcast });
                return { forcedCommunitySync: false };
            }

            // Entitlement restore is the mirror image of expiry: prevent an
            // old stop lane from resuming after registrations are restored.
            // A fresh document gate queues content-script requests throughout
            // the transition and is activated only for this live generation.
            let transitionRequiresRepair = prepareStartupDocumentRuntimeGate();
            try {
                suspendRegistrationMutationsForPaywall();
                await raceWithTimeout(
                    waitForRegistrationMutationsToSettle(),
                    PAYWALL_CLEANUP_OPERATION_TIMEOUT_MS,
                    'entitlement restore registration drain timed out'
                );
                const reconcileLatePaywallMutation =
                    await prepareEntitledRestoreAfterPaywallMutations();
                if ( paywallWasActive || paywallActive ) {
                    await disablePaywall({ broadcast });
                } else if ( repairAllowAllRules || reconcileLatePaywallMutation ) {
                    await clearPaywallAllowAllRules();
                    paywallMutationReconciliationRequired = false;
                }
                resumeRegistrationMutationsAfterPaywall();
                await markStartupDocumentRuntimeReady();
                transitionRequiresRepair = true;
                if (
                    registerInjectablesOnEntitled ||
                    await canReusePersistedInjectableRuntimeState()
                        .catch(() => false) === false
                ) {
                    const registrationResult =
                        await ensureEntitledRegistrationEffects({
                        refreshOpenTabs: refreshOpenTabsOnEntitled,
                    });
                    registrationEffectsPending ||=
                        registrationResult?.sandboxUserScriptsPending === true;
                }
                await drainSuspendedRuntimeReconcileRequests();
                await drainSuspendedOpenTabRuntimeRefresh();
                await clearStartupDocumentRuntimeRepairEvidence();

                const forcedCommunitySync =
                    shouldForceCommunitySyncAfterEntitlementRefresh({
                        status,
                        wasPaywalled: paywallWasActive,
                        wasStatusExpired: shouldEnablePaywallForStatus(previousStatus),
                    });
                if ( forcedCommunitySync ) {
                    runCommunitySync({ force: true });
                }
                return { forcedCommunitySync };
            } catch (reason) {
                transitionRequiresRepair =
                    invalidateStartupDocumentRuntimeAttempt() ||
                    transitionRequiresRepair;
                if ( transitionRequiresRepair ) {
                    startupDocumentRuntimeAttemptRequiresRepair = true;
                    await persistStartupDocumentRuntimeRepair().catch(ubolErr);
                }
                settleStartupDocumentRuntimeUnavailable('startup_failed');
                throw reason;
            }
        },
        clearDirty: async () => {
            if ( effectsRevision !== entitlementEffectsRevision ) { return; }
            if ( registrationEffectsPending ) { return; }
            await clearEntitlementEffectsDirty();
        },
        scheduleRetry: scheduleEntitlementEffectsRetry,
        clearRetry: async () => {
            if ( effectsRevision !== entitlementEffectsRevision ) { return; }
            await clearEntitlementEffectsRetry();
        },
    });
}

async function enforceEntitlementNow({
    verify = false,
    forceVerify = false,
    forceEffects = false,
    registerInjectablesOnEntitled = true,
    refreshOpenTabsOnEntitled = true,
} = {}) {
    const previousStatus = entitlementStatus;
    const paywallWasActive = paywallActive;
    const status = await refreshEntitlement({ verify, forceVerify });
    const shouldBePaywalled = shouldEnablePaywallForStatus(status);
    const effectsDirty = isDurableDirtyMarker(
        await readLocalStrict(ENTITLEMENT_EFFECTS_DIRTY_KEY).catch(() => true)
    );
    if (
        forceEffects === false &&
        effectsDirty === false &&
        shouldBePaywalled === paywallWasActive
    ) {
        return status;
    }
    await applyEntitlementStatusEffects(status, {
        paywallWasActive,
        previousStatus,
        registerInjectablesOnEntitled,
        refreshOpenTabsOnEntitled,
        repairAllowAllRules: forceEffects || effectsDirty,
    });
    return status;
}

function enforceEntitlement(options) {
    return enqueueEntitlementAction(() => enforceEntitlementNow(options));
}

function getCurrentVersion() {
    return runtime.getManifest().version;
}

/******************************************************************************/

const ANNOYANCE_RULESET_IDS = [
    'annoyances-ai',
    'annoyances-cookies',
    'annoyances-overlays',
    'annoyances-social',
    'annoyances-widgets',
    'annoyances-others',
    'annoyances-notifications',
];
const arrayEqAsSet = (a = [], b = []) => {
    const sa = Array.from(new Set(a)).sort();
    const sb = Array.from(new Set(b)).sort();
    if (sa.length !== sb.length) { return false; }
    for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) { return false; }
    }
    return true;
};

async function applyAutomaticRulesetSelection(enabledRulesets) {
    const result = await enableRulesets(enabledRulesets);
    if ( result !== undefined && result.staticUpdateSucceeded !== true ) {
        return false;
    }
    rulesetConfig.enabledRulesets = enabledRulesets.slice();
    await saveRulesetConfig();
    const repairResult = await repairDirtyDnrState({ force: true });
    if ( repairResult?.error ) {
        throw new Error(`automatic ruleset reconciliation failed: ${repairResult.error}`);
    }
    registerInjectablesIfEntitled().catch(ubolErr);
    const reportedEnabledRulesets = sanitizeRulesetIds(result?.enabledRulesets) ||
        await getReportedEnabledRulesets().catch(() => enabledRulesets);
    broadcastMessage({
        enabledRulesets: reportedEnabledRulesets,
        configRevision: rulesetConfig.configRevision,
    });
    return true;
}

async function ensureAnnoyancesForCompleteDefaultNow() {
    const defaultMode = await getDefaultFilteringMode();
    const enabledBefore = Array.isArray(rulesetConfig.enabledRulesets)
        ? rulesetConfig.enabledRulesets.slice()
        : [];

    if (defaultMode === MODE_COMPLETE) {
        const disabledByUser = await readLocalStrict(AUTO_ANNOYANCES_DISABLED_KEY);
        if (disabledByUser === true) { return; }

        const missing = ANNOYANCE_RULESET_IDS.filter(id =>
            enabledBefore.includes(id) === false
        );
        if (missing.length === 0) {
            await localRemove(AUTO_ANNOYANCES_BASELINE_KEY);
            return;
        }

        await localWrite(AUTO_ANNOYANCES_BASELINE_KEY, enabledBefore);
        const afterIds = Array.from(new Set(enabledBefore.concat(ANNOYANCE_RULESET_IDS)));
        await applyAutomaticRulesetSelection(afterIds);
        return;
    }

    const baseline = await readLocalStrict(AUTO_ANNOYANCES_BASELINE_KEY);
    if (Array.isArray(baseline) === false) { return; }

    const expected = Array.from(new Set(baseline.concat(ANNOYANCE_RULESET_IDS)));
    if (arrayEqAsSet(enabledBefore, expected)) {
        const applied = await applyAutomaticRulesetSelection(baseline);
        if ( applied === false ) { return; }
    }
    await localRemove(AUTO_ANNOYANCES_BASELINE_KEY);
}

function ensureAnnoyancesForCompleteDefault() {
    return enqueueRulesetMutation(ensureAnnoyancesForCompleteDefaultNow);
}

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if (modified === false) { return false; }
    await ensureAnnoyancesForCompleteDefault().catch(ubolErr);
    syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
    return true;
}

// Reconcile browser permission grants after optional permission flows.
async function onPermissionsAdded(permissions) {
    const details = pendingPermissionRequest;
    pendingPermissionRequest = undefined;
    if (details === undefined) {
        const modified = await syncWithBrowserPermissions();
        if (modified === false) { return; }
        await ensureAnnoyancesForCompleteDefault().catch(ubolErr);
        return Promise.all([
            updateSessionRules(),
            syncInjectablesAndRefreshTabs({ runtimeOnly: false }),
        ]);
    }
    const defaultMode = await getDefaultFilteringMode();
    if (defaultMode >= MODE_OPTIMAL) { return; }
    if (Array.isArray(permissions.origins) === false) { return; }
    const hostnames = hostnamesFromMatches(permissions.origins);
    if (hostnames.includes(details.hostname) === false) { return; }
    const beforeLevel = await getFilteringMode(details.hostname);
    if (beforeLevel === details.afterLevel) { return; }
    const afterLevel = await setFilteringMode(details.hostname, details.afterLevel);
    if (afterLevel !== details.afterLevel) { return; }
    await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
            if (rulesetConfig.autoReload) {
                self.setTimeout(() => {
                    browser.tabs.update(details.tabId, {
                        url: details.url,
                    }).catch(ignoreRuntimeError);
                }, 437);
            }
}

async function onPermissionsChanged(op, permissions) {
    await isFullyInitialized;
    const run = onPermissionsChanged.tail
        .catch(reason => {
            ubolErr(`permissions/previous/${reason}`);
        })
        .then(() => op === 'removed'
            ? onPermissionsRemoved()
            : onPermissionsAdded(permissions));
    onPermissionsChanged.tail = run.catch(reason => {
        ubolErr(`permissions/${reason}`);
    });
    return run;
}
onPermissionsChanged.tail = Promise.resolve();

/******************************************************************************/

async function setDeveloperMode(state) {
    rulesetConfig.developerMode = isDeveloperModeAllowed && state === true;
    let cleanupResult = {
        cleanupReason: '',
        requiresInjectableRefresh: false,
    };
    if ( rulesetConfig.developerMode === false ) {
        rulesetConfig.communityRulesURL = '';
        cleanupResult = await scrubPrivateProofState();
        if ( cleanupResult.cleanupReason ) {
            lastCommunityCleanupReason = cleanupResult.cleanupReason;
        }
    }
    toggleDeveloperMode(rulesetConfig.developerMode);
    broadcastMessage({ developerMode: rulesetConfig.developerMode });
    await saveRulesetConfig();
    await markSandboxRegistrationDirty();
    const syncResult = await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    if ( syncResult?.ok !== true ) {
        throw new Error(
            syncResult?.sandboxLastError || 'developer-mode runtime sync failed'
        );
    }
}

function enqueuePaywallTransition(operation) {
    const run = paywallTransitionTail
        .catch(reason => {
            ubolErr(`paywall/previous/${reason}`);
        })
        .then(operation);
    paywallTransitionTail = run.catch(() => {});
    return run;
}

function enablePaywall(options) {
    return enqueuePaywallTransition(() => enablePaywallNow(options));
}

function disablePaywall(options) {
    return enqueuePaywallTransition(() => disablePaywallNow(options));
}

function clearPaywallAllowAllRules() {
    return enqueuePaywallTransition(() => clearPaywallAllowAllRulesNow());
}

function enqueueRulesetMutation(operation) {
    const run = rulesetMutationTail
        .catch(reason => {
            ubolErr(`rulesets/previous/${reason}`);
        })
        .then(operation);
    rulesetMutationTail = run.catch(() => {});
    return run;
}

const buildRequestedRulesetState = request => {
    if ( Array.isArray(request?.enabledRulesets) ) {
        return sanitizeRulesetIds(request.enabledRulesets);
    }
    const enableIds = sanitizeRulesetIds(request?.enableRulesetIds || []);
    const disableIds = sanitizeRulesetIds(request?.disableRulesetIds || []);
    if ( enableIds === null || disableIds === null ) { return null; }
    if (
        Array.isArray(request?.enableRulesetIds) === false &&
        Array.isArray(request?.disableRulesetIds) === false
    ) {
        return null;
    }
    const enabled = new Set(rulesetConfig.enabledRulesets);
    for ( const id of disableIds ) { enabled.delete(id); }
    for ( const id of enableIds ) { enabled.add(id); }
    return Array.from(enabled);
};

async function applyRulesetMutation(request) {
    const hasExpectedRevision = Object.hasOwn(request || {}, 'expectedRevision');
    const expectedRevision = request?.expectedRevision;
    if (
        hasExpectedRevision &&
        (Number.isSafeInteger(expectedRevision) === false || expectedRevision < 0)
    ) {
        return { error: 'invalid_ruleset_revision' };
    }
    if ( hasExpectedRevision && expectedRevision !== Number(rulesetConfig.configRevision) ) {
        return {
            error: 'stale_ruleset_revision',
            configRevision: rulesetConfig.configRevision,
            enabledRulesets: rulesetConfig.enabledRulesets.slice(),
        };
    }
    const requestedRulesets = buildRequestedRulesetState(request);
    if ( requestedRulesets === null ) { return { error: 'invalid_rulesets' }; }
    const rulesetDetails = await getRulesetDetails();
    const userEnabledRulesets = requestedRulesets.filter(id => rulesetDetails.has(id));
    const rawChanged = arrayEqAsSet(
        rulesetConfig.enabledRulesets,
        userEnabledRulesets
    ) === false;
    const selectionVersionChanged =
        rulesetConfig.rulesetSelectionVersion !== RULESET_SELECTION_STATE_VERSION;
    const result = await enableRulesets(userEnabledRulesets);
    if (
        result?.error &&
        typeof result.staticUpdateSucceeded === 'boolean'
    ) {
        await browser.alarms?.create?.(DNR_RECONCILIATION_ALARM, {
            delayInMinutes: 1,
        });
    }
    const userIntentAccepted = result === undefined || result.staticUpdateSucceeded === true;
    if ( userIntentAccepted ) {
        const defaultMode = await getDefaultFilteringMode();
        await localRemove(AUTO_ANNOYANCES_BASELINE_KEY);
        if ( defaultMode === MODE_COMPLETE ) {
            const hasAllAnnoyances = ANNOYANCE_RULESET_IDS.every(id =>
                userEnabledRulesets.includes(id)
            );
            await localWrite(AUTO_ANNOYANCES_DISABLED_KEY, hasAllAnnoyances === false);
        }
        rulesetConfig.rulesetSelectionVersion = RULESET_SELECTION_STATE_VERSION;
        rulesetConfig.enabledRulesets = userEnabledRulesets;
        await syncRegionalRulesetOptOutState(userEnabledRulesets);
        if ( rawChanged || selectionVersionChanged ) {
            await saveRulesetConfig();
        }
        const repairResult = await repairDirtyDnrState({ force: true });
        if ( repairResult?.error ) {
            await browser.alarms?.create?.(DNR_RECONCILIATION_ALARM, {
                delayInMinutes: 1,
            });
            throw new Error(`ruleset reconciliation failed: ${repairResult.error}`);
        }
    }
    if ( result?.staticUpdateSucceeded === true ) {
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    }
    const reportedEnabled = sanitizeRulesetIds(result?.enabledRulesets) ||
        await getReportedEnabledRulesets().catch(() => userEnabledRulesets);
    return {
        ...(result || {}),
        enabledRulesets: reportedEnabled,
        configRevision: rulesetConfig.configRevision,
        changed: result !== undefined,
        reconciled: userIntentAccepted,
    };
}

/******************************************************************************/

async function deferFailedSenderDocumentRuntime({
    tabId,
    frameId,
    documentId,
    expectedTabGeneration,
    reason,
}) {
    if (
        Number.isInteger(tabId) === false || tabId < 0 ||
        Number.isInteger(frameId) === false ||
        typeof documentId !== 'string' || documentId === '' ||
        runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false
    ) {
        return false;
    }
    try {
        const tab = await browser.tabs.get(tabId);
        if ( tab?.discarded === true ) { return false; }
    } catch (reason) {
        if (
            isRuntimeRefreshTargetUnavailableError(reason) ||
            isIgnorableRuntimeError(reason)
        ) {
            return false;
        }
        throw reason;
    }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return false;
    }

    let topDocumentId = frameId === 0 ? documentId : '';
    try {
        const frames = await browser.webNavigation?.getAllFrames?.({ tabId });
        if ( Array.isArray(frames) ) {
            const senderFrame = frames.find(frame =>
                frame?.documentId === documentId &&
                (
                    typeof frame?.documentLifecycle !== 'string' ||
                    frame.documentLifecycle === 'active'
                )
            );
            if ( senderFrame === undefined ) { return false; }
            const topFrame = frames.find(frame =>
                frame?.frameId === 0 &&
                typeof frame?.documentId === 'string' &&
                frame.documentId !== '' &&
                (
                    typeof frame?.documentLifecycle !== 'string' ||
                    frame.documentLifecycle === 'active'
                )
            );
            if ( topFrame === undefined ) { return false; }
            topDocumentId = topFrame.documentId;
        }
    } catch (reason) {
        if (
            isRuntimeRefreshTargetUnavailableError(reason) ||
            isIgnorableRuntimeError(reason)
        ) {
            return false;
        }
        // A top-frame sender already supplies the exact durable identity. Its
        // deferred entry is harmless if navigation won the race: the drain
        // compares the active top document before applying it.
        if ( topDocumentId === '' ) { throw reason; }
    }
    if (
        topDocumentId === '' ||
        runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false
    ) {
        return false;
    }
    await deferRuntimeDocuments([{
        tabId,
        topDocumentId,
        operation: isEntitled() ? 'refresh' : 'stop',
        desiredFingerprint: lastInjectableRuntimeFingerprint,
        expectedTabGeneration,
        lastError: runtimeRefreshErrorMessage(reason),
    }]);
    await scheduleDeferredRuntimeRetry();
    return true;
}

const observeFailedSenderDocumentRuntime = details => {
    deferFailedSenderDocumentRuntime(details).catch(reason => {
        ubolErr(`defer failed document runtime/${reason}`);
    });
};

function onMessage(
    request,
    sender,
    callback,
    { startupDocumentEpoch = 0 } = {}
) {
    if (request instanceof Object === false) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if (what === '') { return false; }

    const tabId = Number.isInteger(sender?.tab?.id)
        ? sender.tab.id
        : false;
    const frameId = Number.isInteger(sender?.frameId)
        ? sender.frameId
        : false;
    const documentId = typeof sender?.documentId === 'string'
        ? sender.documentId
        : '';

    // Does not require trusted origin.

    switch (what) {

        case 'registerOverlaySession': {
            if (isEntitled() === false) {
                callback({ ok: false, error: 'subscription_required' });
                return true;
            }
            if (isExtensionRuntimeSender(sender) === false) {
                callback({ ok: false, error: 'invalid_sender' });
                return true;
            }
            if (Number.isInteger(tabId) === false || Number.isInteger(frameId) === false) {
                callback({ ok: false, error: 'invalid_sender' });
                return true;
            }
            callback(overlaySessions.register({
                token: request.token,
                file: request.file,
                pageUrl: request.pageUrl,
                tabId,
                frameId,
            }));
            return true;
        }

        case 'insertCSS': {
            if (isEntitled() === false) {
                callback({ ok: false, error: 'subscription_required' });
                return true;
            }
            if (tabId === false || frameId === false || documentId === '') {
                callback({ ok: false, error: 'invalid_sender' });
                return true;
            }
            const css = sanitizeCssPayload(request.css);
            if (css === '') {
                callback({ ok: false, error: 'invalid_css' });
                return true;
            }
            // https://bugs.webkit.org/show_bug.cgi?id=262491
            if (frameId !== 0 && webextFlavor === 'safari') {
                callback({ ok: false, error: 'unsupported_frame' });
                return true;
            }
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(() => insertRuntimeCSSWithTimeout({
                    css,
                    origin: 'USER',
                    target: { tabId, documentIds: [ documentId ] },
                }, 'content CSS insertion timed out'),
                { startupDocumentEpoch }).then(result => {
                callback(result === false
                    ? { ok: false, error: 'runtime_unavailable' }
                    : { ok: true });
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`insertCSS/${reason}`);
                }
                callback({ ok: false, error: 'insert_css_failed' });
            });
            return true;
        }

        case 'removeCSS': {
            if (tabId === false || frameId === false || documentId === '') {
                return false;
            }
            const css = sanitizeCssPayload(request.css);
            if (css === '') { return false; }
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(() => removeRuntimeCSSWithTimeout({
                    css,
                    origin: 'USER',
                    target: { tabId, documentIds: [ documentId ] },
                }, 'content CSS removal timed out'),
                { cleanup: true }).then(result => {
                callback(result === false
                    ? { ok: false, error: 'runtime_unavailable' }
                    : { ok: true });
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`removeCSS/${reason}`);
                }
                callback({ ok: false, error: 'remove_css_failed' });
            });
            return true;
        }

        case 'promoteComplete': {
            if (AUTO_PROMOTE_ENABLED === false) { return false; }
            if (isEntitled() === false) { return false; }
            const hn = normalizeAutoPromotedHostname(request.hostname);
            if (hn !== '') {
                (async () => {
                    const beforeLevel = await getFilteringMode(hn);
                    // Respect user allowlisting/basic mode.
                    if (beforeLevel !== MODE_OPTIMAL) { return; }
                    const afterLevel = await setFilteringMode(hn, MODE_COMPLETE);
                    if (afterLevel === MODE_COMPLETE) {
                        await touchAutoPromotionState('complete', hn);
                        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                    }
                })().catch(ubolErr);
            }
            return false;
        }

        case 'reportBreakageSignal': {
            const senderHostname = normalizeHttpHostname(sender?.url || sender?.tab?.url || '');
            if (senderHostname === '') { return false; }
            const reportedHostname = normalizeSiteKeyHostname(
                typeof request.hostname === 'string' ? request.hostname : ''
            );
            if (reportedHostname !== '' && reportedHostname !== senderHostname) {
                return false;
            }
            const details = request.details instanceof Object
                ? { ...request.details }
                : {};
            const subsystem = normalizeBreakageSubsystem(request.subsystem || details.subsystem);
            if ( subsystem !== '' ) {
                details.subsystem = subsystem;
            }
            recordBreakageSignal(senderHostname, request.signal, details).catch(ubolErr);
            return false;
        }

        case 'recordRemoteCosmeticsRuntimeStats': {
            if ( isEntitled() === false ) { return false; }
            if ( isExtensionRuntimeSender(sender) === false ) { return false; }
            if ( Number.isInteger(tabId) === false || Number.isInteger(frameId) === false ) {
                return false;
            }
            const senderHostname = normalizeHttpHostname(
                sender?.url || sender?.tab?.url || ''
            );
            const reportedHostname = normalizeSiteKeyHostname(request.hostname);
            if ( senderHostname === '' || reportedHostname !== senderHostname ) {
                return false;
            }
            recordRemoteCosmeticsRuntimeStats({
                ...request,
                hostname: senderHostname,
            }).catch(ubolErr);
            return false;
        }


        case 'setBreakageAuditOverrides': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            const overrides = sanitizeBreakageAuditOverrides(request.overrides);
            localWrite(BREAKAGE_AUDIT_OVERRIDES_KEY, overrides).then(() => {
                callback(overrides);
            }).catch(reason => {
                ubolErr(`setBreakageAuditOverrides/${reason}`);
                callback({ global: {}, hosts: {} });
            });
            return true;
        }


        case 'clearBreakageAuditOverrides': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            localRemove(BREAKAGE_AUDIT_OVERRIDES_KEY).then(() => {
                callback();
            }).catch(reason => {
                ubolErr(`clearBreakageAuditOverrides/${reason}`);
                callback();
            });
            return true;
        }

        case 'getBreakageAuditState': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            Promise.all([
                localRead(BREAKAGE_AUDIT_OVERRIDES_KEY),
                localRead(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY),
                dnr.getEnabledRulesets(),
                getRegisteredContentScriptsAuditSnapshot(),
            ]).then(([
                overrides,
                evidence,
                enabledRulesets,
                registeredContentScripts,
            ]) => {
                callback({
                    overrides: overrides || { global: {}, hosts: {} },
                    evidence: evidence || {},
                    activeBackoffs: serializeAutoBackoffState(),
                    activeSubsystemBackoffs: serializeAutoBackoffSubsystemState({
                        activeOnly: true,
                    }),
                    enabledRulesets: Array.isArray(enabledRulesets)
                        ? enabledRulesets.slice().sort()
                        : [],
                    registeredContentScripts,
                });
            });
            return true;
        }

        case 'getCommunitySyncDiagnostics': {
            if (isTrustedExtensionSender(sender) === false) { return false; }
            Promise.all([
                localRead('communityBundleMeta'),
                localRead('communityBundleLastAttempt'),
                localRead('communityBundleLastSuccess'),
                localRead('communityBundleLastError'),
                localRead('communityBundleCosmetics'),
                localRead('communityBundleHeuristics'),
                localRead('communityBundlePublicDirectives'),
                localRead('communityBundlePublicScriptlets'),
                localRead('communityBundlePrivateDirectives'),
                localRead('communityBundlePrivateScriptlets'),
                localRead('communityBundleDirectives'),
                localRead('communityBundleScriptlets'),
                localRead('communityBaselineMetaV1'),
                localRead('communityOverlayIndexV1'),
                localRead(REMOTE_COSMETICS_RUNTIME_STATS_KEY),
                localRead(COMMUNITY_EMERGENCY_SYNC_STATE_KEY),
                localRead(ALLOW_ALL_RULES_DIAGNOSTICS_KEY),
            ]).then(([
                meta,
                lastAttempt,
                lastSuccess,
                lastError,
                cosmetics,
                heuristics,
                publicDirectives,
                publicScriptlets,
                privateDirectives,
                privateScriptlets,
                legacyDirectives,
                legacyScriptlets,
                baselineMeta,
                overlayIndex,
                liveRuntimeStats,
                emergencySyncState,
                allowAllRulesDiagnostics,
            ]) => {
                const diagnosticsMeta = meta instanceof Object
                    ? { ...meta }
                    : {};
                const countStoredEntries = (...lists) => {
                    let total = 0;
                    for ( const list of lists ) {
                        if ( Array.isArray(list) === false ) { continue; }
                        total += list.length;
                    }
                    return total;
                };
                const stats = liveRuntimeStats instanceof Object
                    ? liveRuntimeStats
                    : {};
                const normalizedOverlayIndex = overlayIndex instanceof Object
                    ? overlayIndex
                    : {};
                let liveRemoteCosmeticChunkCount = 0;
                let liveRemoteCosmeticDroppedAtApply = 0;
                let liveRemoteCosmeticHostCount = 0;
                for ( const entry of Object.values(stats) ) {
                    const chunkCount = Math.max(0, Math.floor(Number(entry?.chunkCount) || 0));
                    const selectorCount = Math.max(0, Math.floor(Number(entry?.selectorCount) || 0));
                    const droppedAtApply = Math.max(
                        0,
                        Math.floor(Number(entry?.droppedAtApply) || 0)
                    );
                    liveRemoteCosmeticChunkCount += chunkCount;
                    liveRemoteCosmeticDroppedAtApply += droppedAtApply;
                    if ( chunkCount !== 0 || selectorCount !== 0 ) {
                        liveRemoteCosmeticHostCount += 1;
                    }
                }
                diagnosticsMeta.cosmeticsCount = countCommunityCosmeticSelectors(cosmetics);
                diagnosticsMeta.hostCosmeticsCount =
                    countHostSpecificCommunityCosmeticSelectors(cosmetics);
                diagnosticsMeta.heuristicRegexCount =
                    countCommunityHeuristicLabelRegexes(heuristics);
                diagnosticsMeta.publicDirectivesCount = countStoredEntries(publicDirectives);
                diagnosticsMeta.publicScriptletsCount = countStoredEntries(publicScriptlets);
                diagnosticsMeta.proofDirectivesCount = countStoredEntries(
                    privateDirectives,
                    legacyDirectives
                );
                diagnosticsMeta.proofScriptletsCount = countStoredEntries(
                    privateScriptlets,
                    legacyScriptlets
                );
                diagnosticsMeta.directivesCount = diagnosticsMeta.publicDirectivesCount +
                    diagnosticsMeta.proofDirectivesCount;
                diagnosticsMeta.scriptletsCount = diagnosticsMeta.publicScriptletsCount +
                    diagnosticsMeta.proofScriptletsCount;
                diagnosticsMeta.liveRemoteCosmeticChunkCount = liveRemoteCosmeticChunkCount;
                diagnosticsMeta.liveRemoteCosmeticDroppedAtApply =
                    liveRemoteCosmeticDroppedAtApply;
                diagnosticsMeta.liveRemoteCosmeticHostCount = liveRemoteCosmeticHostCount;
                diagnosticsMeta.baselineVersion = typeof baselineMeta?.version === 'string'
                    ? baselineMeta.version
                    : 'unknown';
                diagnosticsMeta.baselineLastAttempt = Number(baselineMeta?.lastAttempt) || 0;
                diagnosticsMeta.baselineLastSuccess = Number(baselineMeta?.lastSuccess) || 0;
                diagnosticsMeta.baselineLastError = typeof baselineMeta?.lastError === 'string'
                    ? baselineMeta.lastError
                    : '';
                diagnosticsMeta.activeOverlayCount = Object.values(normalizedOverlayIndex)
                    .filter(entry => typeof entry?.version === 'string' && entry.version !== '')
                    .length;
                diagnosticsMeta.overlayNegativeCacheCount = Object.values(normalizedOverlayIndex)
                    .filter(entry => (Number(entry?.negativeUntil) || 0) > Date.now())
                    .length;
                const emergencyDiagnostics = getCommunityEmergencySyncDiagnostics(
                    emergencySyncState
                );
                if ( emergencyDiagnostics.rollingCount !== 0 ) {
                    diagnosticsMeta.emergencySyncRollingCount =
                        emergencyDiagnostics.rollingCount;
                    diagnosticsMeta.lastEmergencySyncAt =
                        emergencyDiagnostics.lastSyncAt;
                    diagnosticsMeta.lastEmergencySyncDomain =
                        emergencyDiagnostics.lastDomain;
                    diagnosticsMeta.lastEmergencySyncReason =
                        emergencyDiagnostics.lastReason;
                }
                const partialDnrRepairCount = Math.max(
                    0,
                    Math.floor(Number(allowAllRulesDiagnostics?.partialRepairCount) || 0)
                );
                if ( partialDnrRepairCount !== 0 ) {
                    diagnosticsMeta.partialDnrRepairCount = partialDnrRepairCount;
                    diagnosticsMeta.lastPartialDnrRepair =
                        Number(allowAllRulesDiagnostics?.lastRepairAt) || 0;
                }
                const allowAllRollbackCount = Math.max(
                    0,
                    Math.floor(Number(allowAllRulesDiagnostics?.rollbackCount) || 0)
                );
                if ( allowAllRollbackCount !== 0 ) {
                    diagnosticsMeta.allowAllRollbackCount = allowAllRollbackCount;
                    diagnosticsMeta.lastAllowAllRollback =
                        Number(allowAllRulesDiagnostics?.lastRollbackAt) || 0;
                }
                if ( Object.keys(diagnosticsMeta).length !== 0 || partialDnrRepairCount !== 0 ) {
                    diagnosticsMeta.ttlHours = normalizeCommunitySyncTtlHours(
                        diagnosticsMeta.ttlHours
                    );
                    diagnosticsMeta.retryMinutes =
                        COMMUNITY_SYNC_FAILURE_RETRY_MS / (60 * 1000);
                }
                callback({
                    meta: diagnosticsMeta,
                    lastAttempt: Number(lastAttempt) || 0,
                    lastSuccess: Number(lastSuccess) || 0,
                    lastError: typeof lastError === 'string' ? lastError : '',
                    cleanupReason: lastCommunityCleanupReason,
                });
            }).catch(reason => {
                ubolErr(`getCommunitySyncDiagnostics/${reason}`);
                callback({
                    meta: {},
                    lastAttempt: 0,
                    lastSuccess: 0,
                    lastError: '',
                    cleanupReason: lastCommunityCleanupReason,
                });
            });
            return true;
        }

        case 'getInjectableSyncDiagnostics':
            if (isTrustedExtensionSender(sender) === false) { return false; }
            readInjectableSyncDiagnostics().then(result => {
                callback(result instanceof Object ? result : {});
            }).catch(reason => {
                ubolErr(`getInjectableSyncDiagnostics/${reason}`);
                callback({});
            });
            return true;

        case 'toggleToolbarIcon': {
            if (paywallActive) { return false; }
            if (Number.isInteger(tabId) && tabId >= 0) {
                toggleToolbarIcon(tabId);
            }
            return false;
        }

        case 'startCustomFilters':
            if (isEntitled() === false) { return false; }
            if (tabId === false || frameId === false || documentId === '') {
                return false;
            }
            {
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(() =>
                startCustomFilters(
                    tabId,
                    frameId,
                    documentId,
                    details => executeRuntimeScriptWithTimeout(
                        details,
                        'custom filter startup timed out'
                    )
                )
            ).then(result => {
                callback(result === false
                    ? { ok: false, error: 'frame_unavailable' }
                    : { ok: true });
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                ubolErr(`startCustomFilters/${reason}`);
                callback({ ok: false, error: 'start_custom_filters_failed' });
            });
            return true;
            }

        case 'terminateCustomFilters':
            if (tabId === false || frameId === false || documentId === '') {
                return false;
            }
            {
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(() =>
                terminateCustomFilters(
                    tabId,
                    frameId,
                    documentId,
                    details => executeRuntimeScriptWithTimeout(
                        details,
                        'custom filter cleanup timed out'
                    )
                ),
                { cleanup: true }
            ).then(result => {
                callback(result === false
                    ? { ok: false, error: 'frame_unavailable' }
                    : { ok: true });
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                ubolErr(`terminateCustomFilters/${reason}`);
                callback({ ok: false, error: 'terminate_custom_filters_failed' });
            });
            return true;
            }

        case 'injectCustomFilters':
            if (isEntitled() === false) { return false; }
            if (tabId === false || frameId === false || documentId === '') {
                return false;
            }
            {
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(async stillCurrent => {
                const preparedDetails = await prepareCustomFilterDetails(
                    request.hostname
                );
                if ( stillCurrent() === false ) { return false; }
                return injectCustomFilters(
                    tabId,
                    frameId,
                    request.hostname,
                    preparedDetails,
                    documentId,
                    details => executeRuntimeScriptWithTimeout(
                        details,
                        'custom filter procedural API timed out'
                    )
                );
            }, { startupDocumentEpoch }).then(selectors => {
                callback(selectors === false
                    ? { error: 'runtime_unavailable' }
                    : selectors);
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`injectCustomFilters/${reason}`);
                }
                callback({ error: 'inject_custom_filters_failed' });
            });
            return true;
            }

        case 'injectCSSProceduralAPI':
            if (isEntitled() === false) { return false; }
            if (tabId === false || frameId === false || documentId === '') {
                return false;
            }
            {
            const expectedTabGeneration = getRuntimeTabLifecycleGeneration(tabId);
            trackLivePageMutation(() => executeRuntimeScriptWithTimeout({
                    files: [
                        '/js/scripting/css-api.js',
                        '/js/scripting/css-procedural-api.js',
                    ],
                    target: { tabId, documentIds: [ documentId ] },
                    injectImmediately: true,
                }), { startupDocumentEpoch }).then(result => {
                callback(result === false
                    ? { ok: false, error: 'runtime_unavailable' }
                    : { ok: true });
            }).catch(reason => {
                observeFailedSenderDocumentRuntime({
                    tabId, frameId, documentId, expectedTabGeneration, reason,
                });
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`executeScript/${reason}`);
                }
                callback({ ok: false, error: 'inject_procedural_api_failed' });
            });
            return true;
            }

        default:
            break;
    }

    // Does require trusted origin.
    if (isTrustedExtensionSender(sender) === false) { return false; }

    switch (what) {

        case 'getMatchedRules': {
            const requestedTabId = Number.isInteger(request.tabId)
                ? request.tabId
                : -1;
            getMatchedRules(requestedTabId).then(result => {
                callback(Array.isArray(result) ? result : []);
            }).catch(reason => {
                ubolErr(`getMatchedRules/${reason}`);
                callback([]);
            });
            return true;
        }

        case 'launchElementTool': {
            const requestedTabId = Number.isInteger(request.tabId)
                ? request.tabId
                : -1;
            launchElementToolForTab(
                requestedTabId,
                request.tool,
                request.url
            ).then(result => {
                callback(result === true
                    ? { ok: true }
                    : { ok: false, error: 'runtime_unavailable' });
            }).catch(reason => {
                if ( isIgnorableRuntimeError(reason) === false ) {
                    ubolErr(`launchElementTool/${reason}`);
                }
                callback({ ok: false, error: 'tool_injection_failed' });
            });
            return true;
        }

        case 'claimOverlaySession': {
            if (isEntitled() === false) {
                callback({ ok: false, error: 'subscription_required' });
                return true;
            }
            callback(overlaySessions.claim({
                token: request.token,
                file: request.file,
                pageUrl: request.pageUrl,
            }));
            return true;
        }

        case 'applyRulesets': {
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                callback({ error: 'subscription_required' });
                return true;
            }
            enqueueRulesetMutation(() => applyRulesetMutation(request)).then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`applyRulesets/${reason}`);
                callback({ error: `${reason}` });
            }).finally(() => {
                broadcastMessage({
                    enabledRulesets: rulesetConfig.enabledRulesets,
                    configRevision: rulesetConfig.configRevision,
                });
            });
            return true;
        }

        case 'getDefaultConfig':
            getDefaultRulesetsFromEnv().then(rulesets => {
                callback({
                    autoReload: defaultConfig.autoReload,
                    developerMode: defaultConfig.developerMode,
                    showBlockedCount: defaultConfig.showBlockedCount,
                    strictBlockMode: defaultConfig.strictBlockMode,
                    rulesets,
                    filteringModes: Object.assign(defaultFilteringModes),
                });
            });
            return true;

        case 'getOptionsPageData':
            Promise.allSettled([
                hasBroadHostPermissions(),
                getDefaultFilteringMode(),
                getRulesetDetails(),
                getReportedEnabledRulesets(),
                getAdminRulesets(),
                adminReadEx('disabledFeatures'),
            ]).then(results => {
                const hasOmnipotence = results[0]?.status === 'fulfilled'
                    ? results[0].value
                    : true;
                const defaultFilteringMode = results[1]?.status === 'fulfilled'
                    ? results[1].value
                    : MODE_OPTIMAL;
                const rulesetDetails = results[2]?.status === 'fulfilled'
                    ? results[2].value
                    : new Map();
                const enabledRulesets = results[3]?.status === 'fulfilled'
                    ? results[3].value
                    : [];
                const adminRulesets = results[4]?.status === 'fulfilled'
                    ? results[4].value
                    : [];
                const disabledFeatures = results[5]?.status === 'fulfilled'
                    ? results[5].value
                    : [];
                for ( const result of results ) {
                    if ( result?.status !== 'rejected' ) { continue; }
                    ubolErr(`getOptionsPageData/${result.reason}`);
                }
                callback({
                    hasOmnipotence,
                    defaultFilteringMode,
                    enabledRulesets,
                    configRevision: rulesetConfig.configRevision,
                    adminRulesets,
                    maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                    rulesetDetails: Array.from(rulesetDetails.values()),
                    autoReload: rulesetConfig.autoReload,
                    showBlockedCount: rulesetConfig.showBlockedCount,
                    canShowBlockedCount,
                    strictBlockMode: getEffectiveStrictBlockMode(),
                    firstRun: process.firstRun,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures,
                    supportsUserScripts,
                });
                process.firstRun = false;
            }).catch(reason => {
                ubolErr(`getOptionsPageData/${reason}`);
                callback({
                    hasOmnipotence: true,
                    defaultFilteringMode: MODE_OPTIMAL,
                    enabledRulesets: [],
                    configRevision: rulesetConfig.configRevision,
                    adminRulesets: [],
                    maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                    rulesetDetails: [],
                    autoReload: rulesetConfig.autoReload,
                    showBlockedCount: rulesetConfig.showBlockedCount,
                    canShowBlockedCount,
                    strictBlockMode: getEffectiveStrictBlockMode(),
                    firstRun: process.firstRun,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures: [],
                    supportsUserScripts,
                });
            });
            return true;

        case 'getEnabledRulesets':
            getReportedEnabledRulesets().then(rulesets => {
                callback(rulesets);
            }).catch(reason => {
                ubolErr(`getEnabledRulesets/${reason}`);
                callback([]);
            });
            return true;

        case 'getRulesetDetails':
            getRulesetDetails().then(rulesetDetails => {
                callback(Array.from(rulesetDetails.values()));
            });
            return true;

        case 'hasBroadHostPermissions':
            hasBroadHostPermissions().then(result => {
                callback(result);
            });
            return true;

        case 'setAutoReload':
            rulesetConfig.autoReload = request.state && true || false;
            saveRulesetConfig().then(() => {
                callback();
                broadcastMessage({ autoReload: rulesetConfig.autoReload });
            });
            return true;

        case 'setShowBlockedCount':
            rulesetConfig.showBlockedCount = false;
            if (canShowBlockedCount) {
                dnr.setExtensionActionOptions({
                    displayActionCountAsBadgeText: false,
                });
            }
            saveRulesetConfig().then(() => {
                callback();
                broadcastMessage({ showBlockedCount: rulesetConfig.showBlockedCount });
            });
            return true;

        case 'setStrictBlockMode':
            setStrictBlockMode(request.state).then(strictBlockMode => {
                callback(strictBlockMode);
                broadcastMessage({ strictBlockMode });
            }).catch(reason => {
                ubolErr(`setStrictBlockMode/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'setDeveloperMode':
            setDeveloperMode(request.state).then(() => {
                callback();
            }).catch(reason => {
                ubolErr(`setDeveloperMode/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'popupPanelData': {
            const tabId = Number.isInteger(request.tabId)
                ? request.tabId
                : sender?.tab?.id;
            const hostname = sanitizeModeHostname(request.hostname);
            readPopupPanelData({
                tabId,
                hostname,
            }).then(panelData => {
                callback(panelData);
            }).catch(reason => {
                ubolErr(`popupPanelData/${reason}`);
                callback({
                    defaultFilteringMode: MODE_OPTIMAL,
                    hasOmnipotence: false,
                    level: MODE_OPTIMAL,
                    autoReload: rulesetConfig.autoReload,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures: [],
                    hasCustomFilters: 0,
                    entitlementStatus: { status: 'error', error: `${reason}` },
                    reloadNeededState: { reason: '' },
                    compatibilityMode: { active: false },
                });
            });
            return true;
        }

        case 'restoreCompatibilityMode': {
            const hostname = sanitizeModeHostname(request.hostname);
            if (isEntitled() === false) {
                callback({ ok: false, error: 'subscription_required' });
                return true;
            }
            restoreCompatibilityModeForHostname(hostname).then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`restoreCompatibilityMode/${reason}`);
                callback({ ok: false, error: `${reason}` });
            });
            return true;
        }

        case 'getTabReloadNeededState': {
            const requestedTabId = Number.isInteger(request.tabId)
                ? request.tabId
                : sender?.tab?.id;
            ensureReloadNeededTabsHydrated().then(() => {
                callback(getReloadNeededState(requestedTabId));
            }).catch(reason => {
                ubolErr(`getTabReloadNeededState/${reason}`);
                callback({ reason: '', error: 'reload_state_unavailable' });
            });
            return true;
        }

        case 'getFilteringMode': {
            getFilteringMode(request.hostname).then(actualLevel => {
                callback(actualLevel);
            });
            return true;
        }

        case 'maybeOpenFirstPopupWelcome': {
            runFirstPopupWelcomeOpen().then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`maybeOpenFirstPopupWelcome/${reason}`);
                callback({ opened: false, error: `${reason}` });
            });
            return true;
        }

        case 'gotoURL': {
            const url = sanitizeNavigationRequestURL(request.url);
            if (url === '') {
                callback({ ok: false, error: 'invalid_url' });
                return true;
            }
            gotoURL(url, request.type).then(() => {
                callback({ ok: true });
            }).catch(reason => {
                ubolErr(`gotoURL/${reason}`);
                callback({ ok: false, error: `${reason}` });
            });
            return true;
        }

        case 'setFilteringMode': {
            const hostname = sanitizeModeHostname(request.hostname);
            const level = sanitizeFilteringLevel(request.level);
            if (hostname === '' || level === null) {
                callback(MODE_NONE);
                return true;
            }
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                callback(MODE_NONE);
                return true;
            }
            let changed = false;
            getFilteringMode(hostname).then(beforeLevel => {
                if (level === beforeLevel) { return beforeLevel; }
                changed = true;
                return setFilteringMode(hostname, level);
            }).then(async afterLevel => {
                if ( changed === false ) { return afterLevel; }
                await syncInjectablesAndRefreshTabs({ runtimeOnly: false })
                    .catch(ubolErr);
                return afterLevel;
            }).then(afterLevel => {
                callback(afterLevel);
            }).catch(reason => {
                ubolErr(`setFilteringMode/${reason}`);
                callback(MODE_NONE);
            });
            return true;
        }

        case 'setPendingFilteringMode': {
            const hostname = sanitizeModeHostname(request.hostname);
            const afterLevel = sanitizeFilteringLevel(request.afterLevel);
            const tabId = Number.isInteger(request.tabId) ? request.tabId : -1;
            const url = sanitizeNavigationRequestURL(request.url);
            pendingPermissionRequest = undefined;
            if (hostname !== '' && afterLevel !== null && tabId >= 0 && url !== '') {
                pendingPermissionRequest = { hostname, afterLevel, tabId, url };
            }
            break;
        }

        case 'getDefaultFilteringMode': {
            getDefaultFilteringMode().then(level => {
                callback(level);
            });
            return true;
        }

        case 'popupWarmup': {
            Promise.resolve().then(async () => {
                let startupObservationSettled = false;
                let startupObservationError = '';
                const startupObservation = await observePromiseWithTimeout(
                    Promise.resolve(isFullyInitialized),
                    POPUP_WARMUP_RECOVERY_TIMEOUT_MS
                );
                if ( startupObservation.status === 'timeout' ) {
                    startupObservationError = 'popup startup observation timeout';
                } else {
                    startupObservationSettled = true;
                    if ( startupObservation.status === 'rejected' ) {
                        startupObservationError = `${startupObservation.reason}`;
                    }
                }
                let injectableSyncDiagnostics = isStartupCoreReady()
                    ? await readInjectableSyncDiagnostics().catch(( ) => null)
                    : null;
                let injectableSyncReady = injectableSyncDiagnostics?.ok === true;
                let injectableSyncLastError = normalizePopupWarmupLastError(
                    injectableSyncDiagnostics
                );

                if (
                    injectableSyncReady === false &&
                    startupObservationSettled
                ) {
                    const recovery = await recoverStartupCoreFromPopupWarmup();
                    injectableSyncDiagnostics =
                        recovery?.injectableSyncDiagnostics ?? injectableSyncDiagnostics;
                    injectableSyncReady =
                        recovery?.injectableSyncReady === true ||
                        injectableSyncDiagnostics?.ok === true;
                    injectableSyncLastError =
                        typeof recovery?.injectableSyncLastError === 'string' &&
                        recovery.injectableSyncLastError !== ''
                            ? recovery.injectableSyncLastError
                            : normalizePopupWarmupLastError(
                                injectableSyncDiagnostics,
                                injectableSyncLastError
                            );
                }
                if (
                    injectableSyncReady === false &&
                    startupObservationSettled === false &&
                    injectableSyncLastError === ''
                ) {
                    injectableSyncLastError = startupObservationError ||
                        'startup still in progress';
                }

                if ( injectableSyncReady ) {
                    startupCoreReady = true;
                }

                callback(buildPopupWarmupResponse({
                    fullyInitialized: isStartupCoreReady(),
                    injectableSyncReady,
                    injectableSyncDiagnostics,
                    injectableSyncLastError,
                }));
            }).catch(reason => {
                ubolErr(`popupWarmup/${reason}`);
                callback(buildPopupWarmupResponse({
                    fullyInitialized: isStartupCoreReady(),
                    injectableSyncReady: false,
                    injectableSyncDiagnostics: null,
                    injectableSyncLastError: `${reason}`,
                }));
            });
            return true;
        }

        case 'getEntitlementStatus': {
            enqueueEntitlementAction(async () => {
                const previousStatus = entitlementStatus;
                const paywallWasActive = paywallActive;
                const status = await refreshEntitlement({ verify: false });
                const effectsDirty = isDurableDirtyMarker(
                    await readLocalStrict(ENTITLEMENT_EFFECTS_DIRTY_KEY)
                        .catch(() => true)
                );
                if (
                    effectsDirty ||
                    shouldEnablePaywallForStatus(status) !== paywallWasActive ||
                    shouldEnablePaywallForStatus(status) !==
                        shouldEnablePaywallForStatus(previousStatus)
                ) {
                    await applyEntitlementStatusEffects(status, {
                        broadcast: false,
                        paywallWasActive,
                        previousStatus,
                        registerInjectablesOnEntitled:
                            paywallWasActive || effectsDirty,
                        refreshOpenTabsOnEntitled: false,
                        repairAllowAllRules: effectsDirty,
                    });
                }
                return formatEntitlementStatusResponse(status);
            }).then(callback).catch(reason => {
                ubolErr(`getEntitlementStatus/${reason}`);
                callback({
                    status: 'error',
                    error: 'entitlement_runtime_effects_failed',
                    detail: `${reason}`,
                });
            });
            return true;
        }

        case 'setLicenseKey': {
            const parsed = normalizeAndValidateLicenseKey(request.licenseKey, {
                maxLength: MAX_LICENSE_KEY_LENGTH,
            });
            if (parsed.ok === false) {
                callback({ error: parsed.error || 'invalid_license_key' });
                return true;
            }
            enqueueEntitlementAction(async () => {
                const previousStatus = entitlementStatus;
                const paywallWasActive = paywallActive;
                await storeLicenseKey(parsed.key);
                const status = await refreshEntitlement({
                    verify: true,
                    forceVerify: true,
                });
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled: true,
                    refreshOpenTabsOnEntitled: false,
                });
                if ( paywallWasActive && shouldEnablePaywallForStatus(status) === false ) {
                    queueEntitlementOpenTabRefresh();
                }
                return formatEntitlementStatusResponse(status);
            }).then(callback).catch(reason => {
                ubolErr(`setLicenseKey/${reason}`);
                callback({
                    error: 'entitlement_runtime_effects_failed',
                    detail: `${reason}`,
                });
            });
            return true;
        }

        case 'replaceDevice': {
            enqueueEntitlementAction(async () => {
                const previousStatus = entitlementStatus;
                const paywallWasActive = paywallActive;
                await verifyLicense({ force: true, replaceDevice: true });
                const status = await refreshEntitlement({ verify: false });
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled: true,
                    refreshOpenTabsOnEntitled: false,
                });
                if ( paywallWasActive && shouldEnablePaywallForStatus(status) === false ) {
                    queueEntitlementOpenTabRefresh();
                }
                return formatEntitlementStatusResponse(status);
            }).then(callback).catch(reason => {
                ubolErr(`replaceDevice/${reason}`);
                callback({
                    error: 'entitlement_runtime_effects_failed',
                    detail: `${reason}`,
                });
            });
            return true;
        }

        case 'clearLicenseKey': {
            enqueueEntitlementAction(async () => {
                const previousStatus = entitlementStatus;
                const paywallWasActive = paywallActive;
                await clearLicenseKey();
                const status = await refreshEntitlement({ verify: false });
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled:
                        paywallWasActive &&
                        shouldEnablePaywallForStatus(status) === false,
                    refreshOpenTabsOnEntitled: false,
                });
                return formatEntitlementStatusResponse(status);
            }).then(callback).catch(reason => {
                ubolErr(`clearLicenseKey/${reason}`);
                callback({
                    error: 'entitlement_runtime_effects_failed',
                    detail: `${reason}`,
                });
            });
            return true;
        }

        case 'setDefaultFilteringMode': {
            const level = sanitizeFilteringLevel(request.level);
            if (level === null) {
                callback(MODE_NONE);
                return true;
            }
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                callback(MODE_NONE);
                return true;
            }
            getDefaultFilteringMode().then(beforeLevel =>
                setDefaultFilteringMode(level).then(afterLevel =>
                    ({ beforeLevel, afterLevel })
                )
            ).then(({ beforeLevel, afterLevel }) => {
                if (afterLevel === beforeLevel) {
                    callback(afterLevel);
                    return;
                }
                ensureAnnoyancesForCompleteDefault()
                    .catch(ubolErr)
                    .then(() => syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr))
                    .then(() => syncToolbarIconsForAllTabs().catch(ubolErr))
                    .finally(() => {
                        callback(afterLevel);
                    });
            });
            return true;
        }

        case 'getFilteringModeDetails':
            getFilteringModeDetails(true).then(details => {
                callback(details);
            });
            return true;

        case 'setFilteringModeDetails': {
            const modes = sanitizeFilteringModesPayload(request.modes);
            if (modes === null) {
                getFilteringModeDetails(true).then(details => callback(details));
                return true;
            }
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                getFilteringModeDetails(true).then(details => callback(details));
                return true;
            }
            const expectedRevision = Object.hasOwn(request, 'expectedRevision')
                ? request.expectedRevision
                : undefined;
            (async () => {
                const before = await getFilteringModeDetails(true);
                try {
                    await setFilteringModeDetails(modes, expectedRevision);
                } catch (reason) {
                    if ( reason?.code === 'stale_filtering_mode_revision' ) {
                        callback({
                            ...(reason.currentDetails || before),
                            error: reason.code,
                        });
                        return;
                    }
                    if ( reason?.code === 'invalid_filtering_mode_revision' ) {
                        callback({
                            ...before,
                            error: reason.code,
                        });
                        return;
                    }
                    throw reason;
                }
                const after = await getFilteringModeDetails(true);
                if ( after.configRevision === before.configRevision ) {
                    callback(after);
                    return;
                }
                await ensureAnnoyancesForCompleteDefault();
                await syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
                getDefaultFilteringMode().then(defaultFilteringMode => {
                    broadcastMessage({ defaultFilteringMode });
                });
                await syncToolbarIconsForAllTabs().catch(ubolErr);
                callback(await getFilteringModeDetails(true));
            })().catch(reason => {
                ubolErr(`setFilteringModeDetails/${reason}`);
                getFilteringModeDetails(true).then(details => {
                    callback({ ...details, error: 'filtering_mode_update_failed' });
                }).catch(() => callback({ error: 'filtering_mode_update_failed' }));
            });
            return true;
        }

        case 'excludeFromStrictBlock': {
            excludeFromStrictBlock(request.hostname, request.permanent).then(() => {
                callback();
            });
            return true;
        }

        case 'getEffectiveDynamicRules':
            getEffectiveDynamicRules().then(result => {
                callback(result);
            });
            return true;

        case 'getEffectiveSessionRules':
            getEffectiveSessionRules().then(result => {
                callback(result);
            });
            return true;

        case 'getEffectiveUserRules':
            getEffectiveUserRules().then(result => {
                callback(result);
            });
            return true;

        case 'updateUserDnrRules':
            updateUserRulesAndAcknowledgeSandboxState().then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`updateUserDnrRules/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'addCustomFilters':
            addCustomFilters(request.hostname, request.selectors).then(async modified => {
                if (modified !== true) {
                    return { modified: false, runtimeRefreshed: false };
                }
                const result = await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                if ( result?.ok !== true ) {
                    throw new Error(result?.sandboxLastError || 'custom-filter sync failed');
                }
                return { modified: true, runtimeRefreshed: true };
            }).then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`addCustomFilters/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'removeCustomFilters':
            removeCustomFilters(request.hostname, request.selectors).then(async modified => {
                if (modified !== true) {
                    return { modified: false, runtimeRefreshed: false };
                }
                const result = await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                if ( result?.ok !== true ) {
                    throw new Error(result?.sandboxLastError || 'custom-filter sync failed');
                }
                return { modified: true, runtimeRefreshed: true };
            }).then(result => {
                callback(result);
            }).catch(reason => {
                ubolErr(`removeCustomFilters/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'removeAllCustomFilters':
            removeAllCustomFilters(request.hostname).then(async modified => {
                if (modified !== true) { return; }
                const result = await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                if ( result?.ok !== true ) {
                    throw new Error(result?.sandboxLastError || 'custom-filter sync failed');
                }
            }).then(() => {
                callback();
            }).catch(reason => {
                ubolErr(`removeAllCustomFilters/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'customFiltersFromHostname':
            customFiltersFromHostname(request.hostname).then(selectors => {
                callback(selectors);
            });
            return true;

        case 'getAllCustomFilters':
            getAllCustomFilters().then(data => {
                callback(data);
            });
            return true;

        case 'getSandboxFilters':
            if (isEntitled() === false) {
                callback('');
                return true;
            }
            getSandboxFilters().then(text => {
                callback(text || '');
            }).catch(reason => {
                ubolErr(`getSandboxFilters/${reason}`);
                callback('');
            });
            return true;

        case 'setSandboxFilters':
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                callback({ error: 'subscription_required' });
                return true;
            }
            setSandboxFilters(request.text).then(async () => {
                const result = await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                if ( result?.ok !== true ) {
                    throw new Error(
                        result?.sandboxLastError || 'sandbox filter sync failed'
                    );
                }
            }).then(() => {
                callback();
            }).catch(reason => {
                ubolErr(`setSandboxFilters/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;

        case 'getConsoleOutput':
            callback(getConsoleOutput());
            return true;

        default:
            break;
    }

    return false;
}

/******************************************************************************/

async function launchElementToolForTab(tabId, tool, fallbackUrl = '') {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const files = tool === 'picker'
        ? [
            '/js/scripting/css-api.js',
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/tool-overlay.js',
            '/js/scripting/picker.js',
        ]
        : tool === 'unpicker'
            ? [
                '/js/scripting/tool-overlay.js',
                '/js/scripting/unpicker.js',
            ]
            : [];
    if ( files.length === 0 ) { return false; }
    return trackLivePageMutation(async stillCurrent => {
        const identity = await getActiveTopDocumentIdentity(tabId, fallbackUrl);
        if ( identity === null || stillCurrent() === false ) { return false; }
        await executeRuntimeScriptWithTimeout({
            files,
            target: { tabId, documentIds: [ identity.documentId ] },
        }, 'element tool injection timed out');
        return true;
    });
}

function onCommand(command, tab) {
    if ( command !== 'enter-picker-mode' ) { return; }
    launchElementToolForTab(tab?.id, 'picker', tab?.url || '')
        .catch(ignoreRuntimeError);
}

/******************************************************************************/

async function repairDirtyDnrState(options) {
    const result = await repairDnrReconciliation(options);
    if ( result?.error ) {
        await browser.alarms?.create?.(DNR_RECONCILIATION_ALARM, {
            delayInMinutes: 1,
        });
    } else {
        await browser.alarms?.clear?.(DNR_RECONCILIATION_ALARM);
    }
    return result;
}

/******************************************************************************/

const isCurrentStartSessionCommit = value =>
    value?.schema === 1 &&
    value.extensionVersion === getCurrentVersion() &&
    value.configRevision === rulesetConfig.configRevision;

const writeCurrentStartSessionCommit = () => writeSessionStrict(
    START_SESSION_COMMIT_KEY,
    {
        schema: 1,
        extensionVersion: getCurrentVersion(),
        configRevision: rulesetConfig.configRevision,
        completedAt: Date.now(),
    }
);

async function startSession({
    forceDynamicRules = false,
    initialSetup = false,
} = {}) {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;
    let defaultsPatched = false;
    let regionalPatchResult = {
        changed: false,
        customized: false,
        storageChanged: false,
    };

    // The default rulesets may have changed, find out new ruleset to enable,
    // obsolete ruleset to remove.
    if (isNewVersion) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
    }
    defaultsPatched = await patchDefaultRulesets();
    regionalPatchResult = await patchAutoRegionalRulesets();
    if (isNewVersion || defaultsPatched || regionalPatchResult.changed) {
        await saveRulesetConfig();
    }

    const rulesetsUpdated = await enableRulesets(rulesetConfig.enabledRulesets);

    if ( rulesetsUpdated?.error ) {
        throw new Error(`enableRulesets/${rulesetsUpdated.error}`);
    }
    const repairResult = await repairDirtyDnrState({
        force: isNewVersion || forceDynamicRules || rulesetsUpdated !== undefined,
    });
    if ( repairResult?.error ) {
        throw new Error(`updateRules/${repairResult.error}`);
    }
    if ( repairResult?.skipped === 'clean' ) {
        const sessionResult = await updateSessionRules();
        if ( sessionResult?.error ) {
            throw new Error(`updateSessionRules/${sessionResult.error}`);
        }
    }

    // Permissions may have been removed while the extension was disabled
    await syncWithBrowserPermissions();
    await ensureAnnoyancesForCompleteDefault();
    await sessionAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

    // Community intelligence sync (runs after DNR state is settled)
    try {
        if (isEntitled()) {
            runCommunitySync({ force: initialSetup || isNewVersion });
        }
    } catch (e) {
        ubolErr(`community-sync/${e}`);
    }

    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
    //   Firefox API does not support `dnr.setExtensionActionOptions`
    if (canShowBlockedCount) {
        dnr.setExtensionActionOptions({
            displayActionCountAsBadgeText: false,
        });
    }
    if (paywallActive === false) {
        browser.action?.setBadgeText?.({ text: '' });
    }

    // Switch to basic filtering if the extension lacks broad permissions at
    // install time.
    if (initialSetup) {
        const enableOptimal = await hasBroadHostPermissions();
        if (enableOptimal === false) {
            const afterLevel = await setDefaultFilteringMode(MODE_BASIC);
            if (afterLevel === MODE_BASIC) {
                registerInjectablesIfEntitled().catch(ubolErr);
                await ensureAnnoyancesForCompleteDefault().catch(ubolErr);
            }
        }
    }

    const reportedEnabledRulesets = await getReportedEnabledRulesets().catch(() =>
        getStoredEnabledRulesetsSnapshot()
    );
    broadcastMessage({
        enabledRulesets: reportedEnabledRulesets,
        configRevision: rulesetConfig.configRevision,
    });
    process.firstRun = false;

    return {
        isNewVersion,
        defaultsPatched,
        regionalPatchResult,
        forceDynamicRules,
    };
}

/******************************************************************************/

async function applyPendingInstallRulesetReset() {
    const marker = await readLocalStrict(PENDING_INSTALL_RULESET_RESET_KEY);
    if ( marker === null || marker === undefined ) { return false; }

    const defaultRulesetIds = await getDefaultRulesetsFromEnv();
    if ( defaultRulesetIds.length === 0 ) {
        throw new Error('install ruleset reset has no packaged defaults');
    }

    rulesetConfig.version = getCurrentVersion();
    rulesetConfig.rulesetSelectionVersion = RULESET_SELECTION_STATE_VERSION;
    rulesetConfig.enabledRulesets = defaultRulesetIds.slice();

    await Promise.all([
        localWrite(DEFAULT_RULESET_IDS_STORAGE_KEY, defaultRulesetIds),
        localRemove(AUTO_ANNOYANCES_BASELINE_KEY),
        localRemove(AUTO_ANNOYANCES_DISABLED_KEY),
        localRemove(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
        localRemove(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
        saveRulesetConfig(),
    ]);

    return true;
}

async function stopRuntimeStateForTab(
    tabId,
    { expectedTabGeneration } = {}
) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return true; }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
    }
    const getAllFrames = browser.webNavigation?.getAllFrames;
    if ( typeof getAllFrames !== 'function' ) {
        throw new Error('runtime stop frame enumeration unavailable');
    }
    let frames;
    try {
        frames = await getAllFrames({ tabId });
    } catch (reason) {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return true; }
        throw reason;
    }
    if ( runtimeTabLifecycleMatches(tabId, expectedTabGeneration) === false ) {
        return { ok: true, skipped: 'tab_replaced', topDocumentId: '' };
    }
    const frameTargets = (frames || []).filter(frame =>
        Number.isInteger(frame?.frameId) &&
        typeof frame?.documentId === 'string' &&
        frame.documentId !== '' &&
        (
            typeof frame?.documentLifecycle !== 'string' ||
            frame.documentLifecycle === 'active'
        )
    ).map(frame => ({
        frameId: frame.frameId,
        documentId: frame.documentId,
    }));
    if ( frameTargets.length === 0 ) {
        throw new Error('runtime stop active documents unavailable');
    }
    const topFrame = (frames || []).find(frame => frame?.frameId === 0);
    if ( isUnprovenOpaqueTopRuntimeUrl(topFrame?.url || '') ) {
        const runtimeFrameStates = await getRuntimeFrameStates(
            tabId,
            topFrame?.url || ''
        );
        if ( runtimeFrameStates.some(frame => frame.frameId === 0) === false ) {
            return {
                ok: true,
                skipped: 'unproven_opaque_document',
                topDocumentId: topFrame?.documentId || '',
            };
        }
    }
    const legacyRuntime = await tabHasLegacyCosmeticRuntime(tabId, frameTargets);
    const irreversibleCustomRuntime = Array.from(
        (await getIrreversibleCustomProceduralRuntimeByFrame(
            tabId,
            frameTargets
        )).values()
    ).some(selectors => selectors.length !== 0);
    const irreversibleCoreRuntime = Array.from(
        (await getIrreversibleCoreProceduralRuntimeByFrame(
            tabId,
            frameTargets
        )).values()
    ).some(selectors => selectors.length !== 0);
    await executeRuntimeRefreshLane(
        tabId,
        [ '/js/scripting/css-runtime-terminate.js' ],
        { frameTargets }
    );
    await executeRuntimeStopLane(tabId, stopIsolatedRuntimeControllers, {
        frameTargets,
    });
    await executeRuntimeStopLane(tabId, stopMainWorldRuntimeControllers, {
        frameTargets,
        world: 'MAIN',
    });
    if (
        legacyRuntime ||
        irreversibleCoreRuntime ||
        irreversibleCustomRuntime
    ) {
        const topDocumentId = frames.find(frame =>
            frame?.frameId === 0 &&
            typeof frame?.documentId === 'string'
        )?.documentId || '';
        const reason = legacyRuntime
            ? 'legacy_cosmetic_runtime'
            : irreversibleCoreRuntime
                ? 'irreversible_core_procedural'
            : 'irreversible_custom_procedural';
        await markReloadNeededForTab(
            tabId,
            reason,
            topDocumentId
        );
        return {
            deferred: true,
            reason,
            topDocumentId,
        };
    }
    return {
        ok: true,
        topDocumentId: topFrame?.documentId || '',
    };
}

async function stopRuntimeStateForOpenTabs() {
    if ( browser.tabs?.query === undefined ) { return true; }
    await ensureDeferredRuntimeDocumentsHydrated();
    const tabs = await browser.tabs.query({});
    const fileSchemeAccessAllowed = (tabs || []).some(
        tab => /^file:/i.test(tab?.url || '')
    ) ? await isFileSchemeAccessAllowed() : false;
    const frozenCandidates = (tabs || []).filter(tab =>
        tab?.discarded !== true &&
        tab?.frozen === true &&
        Number.isInteger(tab?.id) &&
        tabUrlMayHostExtensionRuntime(tab?.url || '', fileSchemeAccessAllowed)
    );
    let allSucceeded = true;
    try {
        const deferredEntries = (await Promise.all(frozenCandidates.map(
            async tab => {
                try {
                    const tabGeneration = getRuntimeTabLifecycleGeneration(tab.id);
                    const identity = await getActiveTopDocumentIdentity(
                        tab.id,
                        tab?.url || ''
                    );
                    if ( runtimeTabLifecycleMatches(tab.id, tabGeneration) === false ) {
                        return null;
                    }
                    if ( identity === null ) {
                        throw new Error('frozen top-document identity unavailable');
                    }
                    return {
                        tabId: tab.id,
                        topDocumentId: identity.documentId,
                        operation: 'stop',
                        desiredFingerprint: '',
                        expectedTabGeneration: tabGeneration,
                        waitForUnfreeze: true,
                        incrementFailure: false,
                    };
                } catch (reason) {
                    if ( isRuntimeRefreshTargetUnavailableError(reason) ) {
                        return null;
                    }
                    throw reason;
                }
            }
        ))).filter(entry => entry !== null);
        if ( deferredEntries.length !== 0 ) {
            await deferRuntimeDocuments(deferredEntries);
        }
    } catch (reason) {
        allSucceeded = false;
        ubolErr(`stopRuntimeStateForOpenTabs/deferFrozen/${reason}`);
    }
    const candidates = (tabs || []).filter(tab =>
        tab?.discarded !== true &&
        tab?.frozen !== true &&
        Number.isInteger(tab?.id) &&
        tabUrlMayHostExtensionRuntime(tab?.url || '', fileSchemeAccessAllowed)
    ).sort((a, b) => Number(b?.active === true) - Number(a?.active === true));
    let nextIndex = 0;
    const stoppedDeferredEntries = [];
    const stopNext = async () => {
        while ( nextIndex < candidates.length ) {
            const tab = candidates[nextIndex++];
            const tabId = tab.id;
            try {
                const pendingBefore = Array.from(
                    deferredRuntimeDocuments.values()
                ).filter(entry =>
                    entry.tabId === tabId && entry.operation === 'stop'
                ).map(entry => ({ ...entry }));
                const stopped = await stopRuntimeStateForTab(tabId);
                if (
                    stopped !== true &&
                    stopped?.ok !== true &&
                    stopped?.deferred !== true
                ) {
                    allSucceeded = false;
                } else {
                    const topDocumentId = typeof stopped?.topDocumentId === 'string'
                        ? stopped.topDocumentId
                        : '';
                    for ( const entry of pendingBefore ) {
                        if ( entry.topDocumentId === topDocumentId ) {
                            stoppedDeferredEntries.push(entry);
                        }
                    }
                }
            } catch (reason) {
                try {
                    if ( await recoverRuntimeTabFailure(
                        tab,
                        reason,
                        'stop'
                    ) ) {
                        continue;
                    }
                } catch (freezeReason) {
                    reason = new AggregateError(
                        [ reason, freezeReason ],
                        'runtime stop freeze reconciliation failed'
                    );
                }
                allSucceeded = false;
                if ( isIgnorableRuntimeError(reason) === false ) { throw reason; }
            }
        }
    };
    const workerCount = Math.min(
        OPEN_TAB_RUNTIME_REFRESH_CONCURRENCY,
        candidates.length
    );
    await Promise.all(Array.from({ length: workerCount }, stopNext));
    for ( const entry of stoppedDeferredEntries ) {
        try {
            await clearDeferredRuntimeDocuments({
                tabId: entry.tabId,
                topDocumentId: entry.topDocumentId,
                operation: entry.operation,
                expectedUpdatedAt: entry.updatedAt,
            });
        } catch (reason) {
            allSucceeded = false;
            ubolErr(`stopRuntimeStateForOpenTabs/clearDeferred/${reason}`);
        }
    }
    return allSucceeded;
}

async function completeLateInstallRulesetReset() {
    const applied = await applyPendingInstallRulesetReset();
    if ( applied === false ) { return false; }
    const rulesetsUpdated = await enableRulesets(rulesetConfig.enabledRulesets);
    if ( rulesetsUpdated?.error ) {
        throw new Error(`lateInstall/enableRulesets/${rulesetsUpdated.error}`);
    }
    const repairResult = await repairDirtyDnrState({ force: true });
    if ( repairResult?.error ) {
        throw new Error(`lateInstall/updateDynamicRules/${repairResult.error}`);
    }
    await localRemove(PENDING_INSTALL_RULESET_RESET_KEY);
    await ensureStartupInjectableState();
    return true;
}

/******************************************************************************/

async function startNow({ forcePermissionSync = false } = {}) {
    await loadRulesetConfig();
    const initialSetupMarker = await readLocalStrict(
        INITIAL_SETUP_PENDING_KEY
    );
    const initialSetupPending = process.firstRun ||
        isDurableDirtyMarker(initialSetupMarker);
    const activeDeferredRuntimeTabIds =
        await pruneDurableRuntimeLifecycleState();
    // Managed strict-block state is in-memory. Rehydrate it on every MV3
    // worker start before any DNR/session reconciliation, not only on cold
    // browser sessions.
    const adminConfig = await loadAdminConfig();
    if ( adminConfig.disabledFeatures.includes('develop') ) {
        const adminDisabledDeveloperMode =
            rulesetConfig.developerMode || rulesetConfig.communityRulesURL !== '';
        rulesetConfig.developerMode = false;
        rulesetConfig.communityRulesURL = '';
        if ( adminDisabledDeveloperMode ) { await saveRulesetConfig(); }
    }
    if ( process.wakeupRun ) {
        const repairResult = await repairDirtyDnrState();
        if ( repairResult?.error ) {
            throw new Error(`startup/dnr-repair/${repairResult.error}`);
        }
    }
    const installResetApplied = await applyPendingInstallRulesetReset();
    if ( initialSetupPending || installResetApplied ) {
        await ensureInstallWelcomeAllowlistReady();
    }
    setEntitlementStatusForRuntime(await initEntitlement());
    entitlementInitialized = true;
    await scheduleEntitlementAlarms(entitlementStatus);
    await scheduleTrialExpiredReminderAlarm(entitlementStatus);
    const startupNeedsEntitledRegistration =
        shouldEnablePaywallForStatus(entitlementStatus) === false;
    if ( startupNeedsEntitledRegistration === false ) {
        await applyEntitlementStatusEffects(entitlementStatus, {
            broadcast: false,
            paywallWasActive: paywallActive,
            previousStatus: entitlementStatus,
            registerInjectablesOnEntitled: false,
            refreshOpenTabsOnEntitled: false,
            repairAllowAllRules: true,
        });
    } else {
        await markEntitlementEffectsDirty();
        try {
            await clearPaywallAllowAllRules();
            resumeRegistrationMutationsAfterPaywall();
        } catch (reason) {
            await scheduleEntitlementEffectsRetry().catch(() => {});
            throw reason;
        }
    }
    if ( isDeveloperModeAllowed === false ) {
        if ( rulesetConfig.developerMode || rulesetConfig.communityRulesURL !== '' ) {
            rulesetConfig.developerMode = false;
            rulesetConfig.communityRulesURL = '';
            await saveRulesetConfig();
        }
    }
    if ( rulesetConfig.developerMode === false ) {
        const scrubResult = await scrubPrivateProofState();
        if ( scrubResult.cleanupReason ) {
            lastCommunityCleanupReason = scrubResult.cleanupReason;
        }
    }

    configureUninstallURL('extension_start');
    await sessionAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

    // Permission events which fired while an earlier startup promise was
    // rejected cannot be replayed. A warm/full recovery therefore re-reads
    // Chrome's authoritative permission state before injectable verification.
    if ( process.wakeupRun || forcePermissionSync ) {
        await syncWithBrowserPermissions();
    }

    // Permission reconciliation and admin policy can change persisted config.
    // Decide against the final pre-session revision, never an earlier snapshot.
    const startSessionCommit = await readSessionStrict(
        START_SESSION_COMMIT_KEY
    );
    const startSessionRequired = process.wakeupRun === false ||
        initialSetupPending ||
        installResetApplied ||
        isCurrentStartSessionCommit(startSessionCommit) === false;

    if ( startupNeedsEntitledRegistration ) {
        await markStartupDocumentRuntimeReady();
    }

    if ( startSessionRequired ) {
        await startSession({
            forceDynamicRules: initialSetupPending || installResetApplied,
            initialSetup: initialSetupPending,
        });
        await writeCurrentStartSessionCommit();
        if ( initialSetupPending ) {
            await localRemove(INITIAL_SETUP_PENDING_KEY);
        }
        if ( installResetApplied ) {
            await localRemove(PENDING_INSTALL_RULESET_RESET_KEY);
        }
    }

    let startupInjectableResult;
    try {
        startupInjectableResult = await ensureStartupInjectableState();
        startupCoreReady = startupInjectableResultIsReady(startupInjectableResult);
        if ( startupCoreReady === false ) {
            throw new Error('startup injectable state was not verified');
        }
        if (
            startupNeedsEntitledRegistration &&
            startupInjectableResult?.sandboxUserScriptsPending !== true
        ) {
            await clearEntitlementEffectsDirty();
            await clearEntitlementEffectsRetry().catch(() => {});
        }
    } catch (reason) {
        startupCoreReady = false;
        ubolErr(`startup/injectables/${reason}`);
        if ( startupNeedsEntitledRegistration ) {
            await scheduleEntitlementEffectsRetry().catch(() => {});
        }
        await scheduleStartupInjectableRetry();
        throw reason;
    }
    if ( startupInjectableResult?.sandboxUserScriptsPending !== true ) {
        observeBestEffortOperation(
            () => browser.alarms?.clear?.(INJECTABLE_STARTUP_RETRY_ALARM),
            'injectable startup retry alarm clear'
        );
    }

    // A warm worker wake never touches already-open browsing tabs. Readiness
    // remains false until persisted registrations and sandbox state are
    // positively verified or the paywall has intentionally suspended them.

    await initAutoBackoff();
    await initAutoPromotionState();
    await initRuntimeDiagnosticsState();
    await initCommunityEmergencySyncState();
    if ( process.wakeupRun === false || paywallActive ) {
        await syncToolbarIconsForAllTabs().catch(ubolErr);
    }
    if ( paywallActive === false ) {
        await refreshReloadNeededBadges().catch(ubolErr);
    }

    toggleDeveloperMode(rulesetConfig.developerMode);
    if ( isEntitled() && paywallActive === false ) {
        await drainSuspendedRuntimeReconcileRequests();
        await drainSuspendedOpenTabRuntimeRefresh();
    }
    await clearStartupDocumentRuntimeRepairEvidence();
    startupComplete = true;
    observeBestEffortOperation(
        () => browser.alarms?.clear?.(STARTUP_PROCESS_RETRY_ALARM),
        'startup watchdog clear'
    );
    await localRemove('goodStart').catch(() => {});
    if ( deferredRuntimeDocuments.size !== 0 ) {
        observeBestEffortOperation(
            () => scheduleDeferredRuntimeRetry(),
            'startup deferred runtime retry schedule'
        );
    }
    for ( const tabId of activeDeferredRuntimeTabIds ) {
        queueRuntimeStateReconcileForTab(tabId).catch(reason => {
            if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return; }
            ubolErr(`startup deferred runtime reconcile/${reason}`);
        });
    }
    if ( process.wakeupRun === false ) {
        self.setTimeout(() => {
            enforceEntitlement({
                verify: true,
                registerInjectablesOnEntitled: true,
                refreshOpenTabsOnEntitled: false,
            }).catch(ubolErr);
        }, 0);
    }
    return startupInjectableResult;
}

async function start(options = {}) {
    startupComplete = false;
    startupCoreReady = false;
    const hadPendingLivePageMutations = pendingLivePageMutations.size !== 0;
    beginStartupDocumentRuntimeAttempt();
    try {
        startupDocumentRuntimeAttemptRequiresRepair ||=
            hadPendingLivePageMutations;
        await persistStartupDocumentRuntimeRepair();
        await raceWithTimeout(
            waitForLivePageMutations(),
            RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS,
            'startup live-page mutation drain timed out'
        );
        return await startNow(options);
    } catch (reason) {
        const requiresRepair = invalidateStartupDocumentRuntimeAttempt();
        if ( requiresRepair ) {
            await persistStartupDocumentRuntimeRepair().catch(ubolErr);
        }
        throw reason;
    }
}

/******************************************************************************/

// Retry a transient warm-start failure once in-process. Never resolve the
// startup gate after a partial initialization: mutation messages must receive
// an explicit failure instead of running against half-loaded state.
const startWithBoundedRetry = async () => {
    // `process.wakeupRun` is hydrated by loadRulesetConfig() inside start(), so
    // consulting it here always observed the module default on a fresh worker.
    // Use the same tightly bounded retry for cold and warm starts; this also
    // recovers a one-shot failure that occurs before config can identify the
    // worker as warm.
    const attempts = 2;
    const startupGeneration = startupMutationBarrierGeneration;
    let lastError;
    for ( let attempt = 0; attempt < attempts; attempt++ ) {
        try {
            // Keep a one-shot watchdog armed for the full duration of each
            // attempt, including a promise which never settles.
            observeBestEffortOperation(
                () => browser.alarms?.create?.(
                    STARTUP_PROCESS_RETRY_ALARM,
                    { delayInMinutes: 1 }
                ),
                'startup watchdog create'
            );
            await start();
            resolveStartupMutationBarrierGeneration(startupGeneration);
            return;
        } catch (reason) {
            lastError = reason;
            startupComplete = false;
            startupCoreReady = false;
            if ( attempt + 1 < attempts ) {
                await new Promise(resolve => self.setTimeout(resolve, 250));
            }
        }
    }
    settleStartupDocumentRuntimeUnavailable('startup_failed');
    rejectStartupMutationBarrierGeneration(startupGeneration, lastError);
    throw lastError;
};

const initialStartupGeneration = startupMutationBarrierGeneration;
let isFullyInitialized = startWithBoundedRetry().then(async () => {
    await localRemove('goodStart').catch(() => {});
}).catch(async reason => {
    ubolErr(reason);
    rememberSuspendedOpenTabRuntimeRefresh({
        refreshCustomFilters: true,
        refreshCoreCosmetics: true,
    });
    await waitForSuspendedOpenTabRuntimeRefreshPersistence().catch(ubolErr);
    if (
        startupMutationBarrierGeneration !== initialStartupGeneration ||
        startupRecoveryPromise instanceof Promise
    ) {
        throw reason;
    }
    observeBestEffortOperation(
        () => browser.alarms?.create?.(STARTUP_PROCESS_RETRY_ALARM, {
            delayInMinutes: 1,
        }),
        'startup failure watchdog create'
    );
    if (
        startupMutationBarrierGeneration !== initialStartupGeneration ||
        startupRecoveryPromise instanceof Promise
    ) {
        throw reason;
    }
    if ( process.wakeupRun ) {
        throw reason;
    }
    const goodStart = await localRead('goodStart').catch(() => false);
    if (
        startupMutationBarrierGeneration !== initialStartupGeneration ||
        startupRecoveryPromise instanceof Promise
    ) {
        throw reason;
    }
    if ( goodStart === false ) {
        await localRemove('goodStart').catch(() => {});
        throw reason;
    }
    await localWrite('goodStart', false);
    if (
        startupMutationBarrierGeneration !== initialStartupGeneration ||
        startupRecoveryPromise instanceof Promise
    ) {
        throw reason;
    }
    runtime.reload();
    throw reason;
});

const queueLifecycleRuntimeReconcile = (tabId, url = '') => {
    const readiness = isEntitled() === false || paywallActive
        ? Promise.resolve()
        : isFullyInitialized;
    readiness.then(() =>
        queueRuntimeStateReconcileForTab(tabId, url)
    ).catch(reason => {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return; }
        ubolErr(`lifecycle runtime reconcile/${reason}`);
    });
};

browser.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    observePendingUserScriptsPaywallCleanup();
    if ( changeInfo?.frozen !== false ) { return; }
    queueLifecycleRuntimeReconcile(tabId, tab?.url || changeInfo?.url || '');
});

browser.tabs?.onActivated?.addListener(({ tabId }) => {
    observePendingUserScriptsPaywallCleanup();
    ensureDeferredRuntimeDocumentsHydrated().then(() => {
        if ( deferredFrozenRuntimeTabIds.has(tabId) === false ) { return; }
        const tabPromise = browser.tabs?.get?.(tabId);
        if ( tabPromise?.then === undefined ) { return; }
        return tabPromise.then(tab => {
            if ( tab?.frozen === true ) { return; }
            queueLifecycleRuntimeReconcile(tabId, tab?.url || '');
        });
    }).catch(reason => {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return; }
        ubolErr(`activated runtime reconcile/${reason}`);
    });
});

browser.tabs?.onReplaced?.addListener((addedTabId, removedTabId) => {
    const prerenderMigration = beginPrerenderTabMigration(
        addedTabId,
        removedTabId
    );
    const lifecycleMigration = Promise.all([
        prerenderMigration,
        migrateRuntimeLifecycleTabState(addedTabId, removedTabId),
    ]);
    // Activation for the added tab must not classify the document until its
    // reload wildcard and deferred state have moved as well.
    prerenderTabMigrationFailures.set(addedTabId, removedTabId);
    prerenderTabMigrationPromises.set(addedTabId, lifecycleMigration);
    lifecycleMigration.then(() => {
        if ( prerenderTabMigrationFailures.get(addedTabId) === removedTabId ) {
            prerenderTabMigrationFailures.delete(addedTabId);
        }
    }).catch(() => {});
    lifecycleMigration.finally(() => {
        if ( prerenderTabMigrationPromises.get(addedTabId) === lifecycleMigration ) {
            prerenderTabMigrationPromises.delete(addedTabId);
        }
    }).catch(() => {});
    lifecycleMigration.catch(reason => {
        ubolErr(`replaced runtime lifecycle migration/${reason}`);
    });
});

browser.webNavigation?.onCommitted?.addListener(details => {
    observePendingUserScriptsPaywallCleanup();
    const outermostFrame = details?.frameId === 0 ||
        details?.frameType === 'outermost_frame';
    if ( outermostFrame === false ) { return; }
    const documentId = details.documentId || '';
    if ( details?.documentLifecycle !== 'active' ) {
        if ( details?.documentLifecycle === 'prerender' ) {
            rememberPrerenderDocument(
                details.tabId,
                documentId,
                details.timeStamp
            ).catch(reason => {
                ubolErr(`prerender runtime lifecycle record/${reason}`);
            });
        }
        return;
    }
    // Invalidate synchronously before any awaited cleanup. A refresh which
    // captured the previous document generation must not overwrite deferred
    // state for this newly committed (or reactivated) document.
    invalidateRuntimeTabLifecycle(details.tabId);
    (async () => {
        const forwardBack = Array.isArray(details?.transitionQualifiers) &&
            details.transitionQualifiers.includes('forward_back');
        const prerenderRecord = await consumePrerenderDocument(
            details.tabId,
            documentId
        );
        const outermostPrerender = prerenderRecord instanceof Object;
        await Promise.all([
            clearReloadNeededStateForTab(details.tabId, {
                currentDocumentId: documentId,
                currentUrl: details.url || '',
                transitionType: details.transitionType || '',
                forwardBack,
                outermostPrerender,
                prerenderCommittedAt: Number(prerenderRecord?.committedAt) || 0,
            }),
            clearReplacedDeferredRuntimeDocuments(details.tabId, documentId),
        ]);
        if ( forwardBack === false && outermostPrerender === false ) { return; }
        // Chrome re-emits navigation events for BFCache/prerender activation,
        // but it does not run a new document-start registration. Reconcile by
        // the promoted document identity after lifecycle state is durable.
        self.setTimeout(() => {
            queueLifecycleRuntimeReconcile(details.tabId, details.url || '');
        }, 0);
    })().catch(reason => {
        if ( isRuntimeRefreshTargetUnavailableError(reason) ) { return; }
        ubolErr(`committed runtime lifecycle cleanup/${reason}`);
    });
});

runtime.onMessage.addListener((request, sender, callback) => {
    observePendingUserScriptsPaywallCleanup();
    if (
        request?.what === 'getRawFilters' ||
        request?.what === 'compiledRawFilters'
    ) {
        // The temporary authenticated compiler listener in filter-manager.js
        // exclusively owns these responses. An eager undefined callback here
        // can win Chrome's single-response race and strand compilation.
        return false;
    }
    const safeCallback = (response) => {
        try {
            callback(response);
        } catch (reason) {
            const message = reason === undefined ? 'undefined' : reason;
            ubolErr(`runtime.onMessage/respond/${message}`);
        }
    };
    const handleMessage = (messageContext = {}) => {
        let handled = false;
        try {
            handled = onMessage(request, sender, safeCallback, messageContext);
        } catch (reason) {
            ubolErr(`onMessage/${reason}`);
        }
        if (handled !== true) { safeCallback(); }
    };
    if ( shouldRejectPostStartupOnlyMessage(request, sender) ) {
        safeCallback(buildPostStartupOnlyResponse());
        return true;
    }
    if ( shouldWaitForStartupDocumentRuntime(request, sender) ) {
        awaitStartupDocumentRuntimeGate().then(result => {
            if ( result?.operational === true ) {
                handleMessage({ startupDocumentEpoch: result.epoch });
                return;
            }
            if ( result?.reason === 'not_entitled' ) {
                handleMessage();
                return;
            }
            safeCallback({ error: 'startup_failed' });
        }).catch(reason => {
            ubolErr(`startup document runtime/${reason}`);
            safeCallback({ error: 'startup_failed' });
        });
        return true;
    }
    if ( shouldHandleMessageBeforeFullInitialization(request, sender) ) {
        handleMessage();
        return true;
    }
    if ( shouldHandlePostStartupOnlyMessage(request, sender) ) {
        handleMessage();
        return true;
    }
    isFullyInitialized.then(() => {
        handleMessage();
    }).catch(reason => {
        ubolErr(`runtime.onMessage/${reason}`);
        safeCallback({ error: 'startup_failed' });
    });
    return true;
});

    if ( supportsUserScripts && runtime.onUserScriptMessage ) {
    runtime.onUserScriptMessage.addListener((request, sender, callback) => {
        const safeCallback = (response) => {
            try {
                callback(response);
            } catch (reason) {
                const message = reason === undefined ? 'undefined' : reason;
                ubolErr(`runtime.onUserScriptMessage/respond/${message}`);
            }
        };
        isFullyInitialized.then(() => {
            let handled = false;
            try {
                handled = onMessage(request, sender, safeCallback);
            } catch (reason) {
                ubolErr(`onUserScriptMessage/${reason}`);
            }
            if (handled !== true) { safeCallback(); }
        }).catch(reason => {
            ubolErr(`runtime.onUserScriptMessage/${reason}`);
            safeCallback({ error: 'startup_failed' });
        });
        return true;
    });
}

browser.permissions.onRemoved.addListener((...args) => {
    isFullyInitialized
        .then(() => onPermissionsChanged('removed', ...args))
        .catch(ubolErr);
});

browser.permissions.onAdded.addListener((...args) => {
    isFullyInitialized
        .then(() => onPermissionsChanged('added', ...args))
        .catch(ubolErr);
});

browser.commands.onCommand.addListener((...args) => {
    isFullyInitialized.then(() => {
        onCommand(...args);
    }).catch(ubolErr);
});

async function openInstallWelcomeAfterAllowlistReady(url) {
    // Static rules can already be active on first install; wait only for the
    // install-welcome allowlist, not for unrelated extension startup work.
    await ensureInstallWelcomeAllowlistReady().catch(reason => {
        ubolErr(`runtime.onInstalled/allowlist/${reason}`);
    });
    await gotoURL(url);
}

runtime.onInstalled.addListener((details) => {
    configureUninstallURL(`extension_${details?.reason || 'install'}`);
    if (details?.reason !== 'install') { return; }
    const url = INSTALL_WELCOME_URL;
    const installResetQueued = localWrite(PENDING_INSTALL_RULESET_RESET_KEY, {
        queuedAt: Date.now(),
    });
    installResetQueued
        .then(() => isFullyInitialized)
        .then(() => completeLateInstallRulesetReset())
        .catch(ubolErr);
    localWrite(FIRST_POPUP_WELCOME_PENDING_KEY, {
        source: FIRST_POPUP_WELCOME_SOURCE,
        queuedAt: Date.now(),
    }).catch(ubolErr);
    localRemove(FIRST_POPUP_WELCOME_SEEN_KEY).catch(ubolErr);
    openInstallWelcomeAfterAllowlistReady(url).catch(reason => {
        ubolErr(`runtime.onInstalled/welcome/${reason}`);
    });
});

async function onAlarmAfterStartup(alarm) {
    if ( alarm?.name === DEFERRED_RUNTIME_RETRY_ALARM ) {
        if ( startupComplete === false ) {
            await scheduleDeferredRuntimeRetry();
            return;
        }
        const drained = await drainActiveDeferredRuntimeDocuments();
        if ( drained === false ) {
            await scheduleDeferredRuntimeRetry();
        }
        return;
    }
    if (alarm?.name === USER_SCRIPTS_CLEANUP_RETRY_ALARM) {
        await enqueueEntitlementAction(async () => {
            if ( isEntitled() ) {
                await Promise.all([
                    localRemove(USER_SCRIPTS_CLEANUP_PENDING_KEY),
                    browser.alarms?.clear?.(USER_SCRIPTS_CLEANUP_RETRY_ALARM),
                ]);
                userScriptsCleanupPendingKnown = false;
                return;
            }
            try {
                const pending = await readLocalStrict(
                    USER_SCRIPTS_CLEANUP_PENDING_KEY
                );
                const retryAttempt = pending instanceof Object
                    ? Math.max(0, Number(pending.attempt) || 0)
                    : 1;
                const result = await unregisterAllUserScriptsSingleFlight({
                    retryAttempt,
                });
                if ( result?.liveDocumentsMayContainManagedScripts === true ) {
                    await markOpenTabsForSandboxUserScriptReload();
                }
            } catch (reason) {
                // This alarm is one-shot. Keep both cleanup-specific and
                // entitlement-wide recovery paths alive if any read/API call fails.
                const recoveryResults = await Promise.allSettled([
                    markEntitlementEffectsDirty(),
                    browser.alarms?.create?.(USER_SCRIPTS_CLEANUP_RETRY_ALARM, {
                        delayInMinutes: USER_SCRIPTS_CLEANUP_RETRY_DELAY_MINUTES,
                    }),
                ]);
                for ( const result of recoveryResults ) {
                    if ( result.status === 'rejected' ) {
                        ubolErr(`user-script cleanup retry schedule/${result.reason}`);
                    }
                }
                throw reason;
            }
        });
        return;
    }
    if (alarm?.name === INJECTABLE_STARTUP_RETRY_ALARM) {
        let sandboxUserScriptsPending = false;
        try {
            const result = startupComplete && startupCoreReady
                ? await ensureStartupInjectableState()
                : await recoverStartupStateForPopup();
            startupCoreReady = startupInjectableResultIsReady(result);
            sandboxUserScriptsPending =
                result?.sandboxUserScriptsPending === true;
            if (
                startupCoreReady &&
                isEntitled() &&
                sandboxUserScriptsPending === false
            ) {
                await clearEntitlementEffectsDirty();
                await clearEntitlementEffectsRetry().catch(() => {});
            }
        } catch (reason) {
            startupCoreReady = false;
            ubolErr(`alarm/injectable-startup-retry/${reason}`);
        }
        if ( startupCoreReady && sandboxUserScriptsPending === false ) {
            await browser.alarms?.clear?.(INJECTABLE_STARTUP_RETRY_ALARM);
        } else {
            await scheduleStartupInjectableRetry({
                delayInMinutes: sandboxUserScriptsPending ? 15 :
                    INJECTABLE_STARTUP_RETRY_DELAY_MINUTES,
            });
        }
        return;
    }
    if (alarm?.name === ENTITLEMENT_EFFECTS_RETRY_ALARM) {
        await enforceEntitlement({
            verify: false,
            forceEffects: true,
            registerInjectablesOnEntitled: true,
            refreshOpenTabsOnEntitled: false,
        });
        return;
    }
    if (alarm?.name === DNR_RECONCILIATION_ALARM) {
        const result = await repairDirtyDnrState();
        if ( result?.error ) {
            ubolErr(`alarm/dnr-repair/${result.error}`);
        }
        return;
    }
    if (alarm?.name === AUTO_BACKOFF_ALARM) {
        await restoreExpiredAutoBackoffs();
        return;
    }
    if (alarm?.name === AUTO_PROMOTION_ALARM) {
        await pruneExpiredAutoPromotions();
        return;
    }
    if (alarm?.name === TRIAL_EXPIRED_REMINDER_ALARM) {
        await maybeShowTrialExpiredReminder();
        return;
    }
    if (alarm?.name === ENTITLEMENT_CHECK_ALARM || alarm?.name === ENTITLEMENT_EXPIRE_ALARM) {
        await enforceEntitlement({ verify: true });
        return;
    }
    if (alarm?.name !== COMMUNITY_ALARM_NAME) { return; }
    if (isEntitled() === false) { return; }
    await runCommunitySync();
}

async function handleStartupProcessRetryAlarm() {
    if ( startupComplete && startupCoreReady ) {
        await browser.alarms?.clear?.(STARTUP_PROCESS_RETRY_ALARM);
        return;
    }
    const observedRecovery = startupRecoveryPromise;
    const observedInitialization = observedRecovery instanceof Promise
        ? observedRecovery
        : Promise.resolve(isFullyInitialized);
    const observation = await observePromiseWithTimeout(
        observedInitialization,
        RUNTIME_SCRIPT_EXECUTION_TIMEOUT_MS
    );
    if ( startupComplete && startupCoreReady ) {
        await browser.alarms?.clear?.(STARTUP_PROCESS_RETRY_ALARM);
        return;
    }
    if ( observation.status === 'timeout' ) {
        // A timeout proves only that the observed promise is still pending.
        // Never infer settlement from a different mutable startup flag.
        await browser.alarms?.create?.(STARTUP_PROCESS_RETRY_ALARM, {
            delayInMinutes: 1,
        });
        return;
    }
    if ( observation.status === 'rejected' ) {
        ubolErr(`startup process retry observation/${observation.reason}`);
    }
    await Promise.resolve();
    if ( startupRecoveryPromise instanceof Promise ) {
        await browser.alarms?.create?.(STARTUP_PROCESS_RETRY_ALARM, {
            delayInMinutes: 1,
        });
        return;
    }
    await recoverStartupStateForPopup();
    await browser.alarms?.clear?.(STARTUP_PROCESS_RETRY_ALARM);
}

browser.alarms?.onAlarm.addListener(alarm => {
    if ( alarm?.name === STARTUP_PROCESS_RETRY_ALARM ) {
        handleStartupProcessRetryAlarm().catch(ubolErr);
        return;
    }
    // Recoverable lifecycle alarms remain reachable after a rejected startup,
    // but wait for the current start attempt to settle so they cannot race
    // configuration/entitlement hydration on a newly woken worker.
    if (
        alarm?.name === INJECTABLE_STARTUP_RETRY_ALARM ||
        alarm?.name === DEFERRED_RUNTIME_RETRY_ALARM
    ) {
        Promise.resolve(isFullyInitialized)
            .catch(() => undefined)
            .then(() => onAlarmAfterStartup(alarm))
            .catch(ubolErr);
        return;
    }
    isFullyInitialized
        .then(() => onAlarmAfterStartup(alarm))
        .catch(ubolErr);
});
