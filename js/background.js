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
    addCustomFilters,
    customFiltersFromHostname,
    getAllCustomFilters,
    hasCustomFilters,
    injectCustomFilters,
    removeAllCustomFilters,
    removeCustomFilters,
    startCustomFilters,
    terminateCustomFilters,
} from './filter-manager.js';

import {
    adminReadEx,
    getAdminRulesets,
    loadAdminConfig,
} from './admin.js';

import {
    broadcastMessage,
    createOverlaySessionStore,
    gotoURL,
    hasBroadHostPermissions,
    hostnamesFromMatches,
    ignoreRuntimeError,
    isIgnorableRuntimeError,
} from './utils.js';
import {
    getTrialReminderWhen,
    normalizeAndValidateLicenseKey,
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
    REMOTE_SCRIPTLET_RELOAD_REASON,
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
const AUTO_ANNOYANCES_BASELINE_KEY = 'autoAnnoyancesBaselineRulesets';
const AUTO_ANNOYANCES_DISABLED_KEY = 'autoAnnoyancesDisabledInComplete';
const REMOTE_COSMETICS_RUNTIME_STATS_KEY = 'remoteCosmeticsRuntimeStatsV1';
const REMOTE_COSMETICS_RUNTIME_STATS_TTL_MS = 24 * 60 * 60 * 1000;
const REMOTE_COSMETICS_STORAGE_KEY = 'communityBundleCosmetics';
const ISOLATED_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/public-suffix-data.js',
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/remote-cosmetics.js',
    '/js/scripting/remote-cosmetics-global.js',
    '/js/scripting/native-heuristics.js',
    '/js/scripting/automation.js',
    '/js/scripting/post-hide-cleanup.js',
]);
const REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/public-suffix-data.js',
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/block-hints.js',
    '/js/scripting/remote-cosmetics.js',
    '/js/scripting/remote-cosmetics-host.js',
]);
const DEFAULT_ACTION_TITLE = 'Talon Defender';
const HOTFIX_RELOAD_ACTION_TITLE = 'Talon Defender: Reload tab to apply hotfix';
const HOTFIX_RELOAD_BADGE_COLOR = '#f59e0b';
const PUBLIC_SAFE_REGIONAL_RULESET_ID_SET = new Set(getPublicSafeRegionalRulesetIds());

const autoBackoffCounts = new Map();
const autoBackoffSignalCounts = new Map();
let autoBackoffState = new Map();
let autoBackoffEvidence = new Map();
let autoBackoffSubsystemState = new Map();
let autoPromotionState = {
    genericHigh: new Map(),
    complete: new Map(),
};
const reloadNeededTabs = new Map();
let remoteCosmeticsRuntimeStats = {};
let communityEmergencySyncState = {};
let autoBackoffAlarmWhen = 0;
let autoPromotionAlarmWhen = 0;
let lastInjectableRuntimeFingerprint = '';

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

const getReloadNeededState = tabId => {
    const entry = reloadNeededTabs.get(tabId);
    if ( entry instanceof Object === false ) {
        return { reason: '' };
    }
    return {
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        updatedAt: Number(entry.updatedAt) || 0,
    };
};

const readPopupPanelData = async ({
    tabId = -1,
    hostname = '',
} = {}) => {
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

const refreshReloadNeededBadgeForTab = async tabId => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    if ( paywallActive ) { return false; }
    const state = getReloadNeededState(tabId);
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
        setActionTitle({ tabId, title: HOTFIX_RELOAD_ACTION_TITLE }),
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

const clearReloadNeededStateForTab = async tabId => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const hadEntry = reloadNeededTabs.delete(tabId);
    if ( hadEntry === false ) { return false; }
    await refreshReloadNeededBadgeForTab(tabId);
    return true;
};

const markReloadNeededForTab = async (tabId, reason) => {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
    if ( normalizedReason === '' ) { return false; }
    reloadNeededTabs.set(tabId, {
        reason: normalizedReason,
        updatedAt: Date.now(),
    });
    await refreshReloadNeededBadgeForTab(tabId);
    return true;
};

const listTabFrameUrls = async (tabId, fallbackUrl = '') => {
    const urls = new Set();
    if ( typeof fallbackUrl === 'string' && fallbackUrl !== '' ) {
        urls.add(fallbackUrl);
    }
    const getAllFrames = browser.webNavigation?.getAllFrames;
    if ( typeof getAllFrames !== 'function' ) {
        return Array.from(urls);
    }
    try {
        const frames = await getAllFrames({ tabId });
        for ( const frame of frames || [] ) {
            if ( typeof frame?.url !== 'string' || frame.url === '' ) { continue; }
            urls.add(frame.url);
        }
    } catch (reason) {
        if ( isIgnorableRuntimeError(reason) === false ) {
            ubolErr(`reloadNeeded/getAllFrames/${reason}`);
        }
    }
    return Array.from(urls);
};

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

const markTabsForRemoteScriptletReload = async reloadHint => {
    if ( reloadHint instanceof Object === false || browser.tabs?.query === undefined ) {
        return [];
    }
    let tabs = [];
    try {
        tabs = await browser.tabs.query({});
    } catch (reason) {
        ubolErr(`reloadNeeded/queryTabs/${reason}`);
        return [];
    }
    const markedTabIds = [];
    await Promise.all((tabs || []).map(async tab => {
        const tabId = Number.isInteger(tab?.id) ? tab.id : -1;
        if ( tabId < 0 ) { return; }
        const frameUrls = await listTabFrameUrls(tabId, tab?.url || '');
        if ( shouldReloadForFrameUrls(frameUrls, reloadHint) === false ) { return; }
        const marked = await markReloadNeededForTab(tabId, REMOTE_SCRIPTLET_RELOAD_REASON);
        if ( marked ) {
            markedTabIds.push(tabId);
        }
    }));
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
        genericHigh: serializePromotionMap(autoPromotionState.genericHigh),
        complete: serializePromotionMap(autoPromotionState.complete),
    };
};

const createEmptyAutoPromotionState = () => ({
    genericHigh: new Map(),
    complete: new Map(),
});

const scheduleAutoBackoffAlarm = () => {
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
        autoBackoffAlarmWhen = 0;
        browser.alarms?.clear?.(AUTO_BACKOFF_ALARM);
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
    if ( when === autoBackoffAlarmWhen ) { return; }
    autoBackoffAlarmWhen = when;
    browser.alarms.create(AUTO_BACKOFF_ALARM, { when });
};

const scheduleAutoPromotionAlarm = () => {
    if ( browser?.alarms?.create === undefined ) { return; }
    let nextExpiry = Infinity;
    for ( const promotionMap of [
        autoPromotionState.genericHigh,
        autoPromotionState.complete,
    ] ) {
        for ( const entry of promotionMap.values() ) {
            const lastHitAt = Number(entry?.lastHitAt) || 0;
            if ( lastHitAt <= 0 ) { continue; }
            const expiresAt = lastHitAt + AUTO_PROMOTION_TTL_MS;
            if ( expiresAt < nextExpiry ) {
                nextExpiry = expiresAt;
            }
        }
    }
    if ( Number.isFinite(nextExpiry) === false ) {
        autoPromotionAlarmWhen = 0;
        browser.alarms?.clear?.(AUTO_PROMOTION_ALARM);
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
    if ( when === autoPromotionAlarmWhen ) { return; }
    autoPromotionAlarmWhen = when;
    browser.alarms.create(AUTO_PROMOTION_ALARM, { when });
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
    const hasGenericHigh = Object.keys(serialized.genericHigh).length !== 0;
    const hasComplete = Object.keys(serialized.complete).length !== 0;
    if ( hasGenericHigh === false && hasComplete === false ) {
        await Promise.all([
            localRemove(AUTO_PROMOTION_STATE_KEY),
            localRemove(AUTO_GENERIC_HIGH_KEY),
        ]);
        return;
    }
    await Promise.all([
        localWrite(AUTO_PROMOTION_STATE_KEY, serialized),
        localWrite(AUTO_GENERIC_HIGH_KEY, Object.keys(serialized.genericHigh)),
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
    const stored = await localRead(AUTO_BACKOFF_STORAGE_KEY);
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
    scheduleAutoBackoffAlarm();
};

const loadAutoBackoffEvidence = async () => {
    const stored = await localRead(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY);
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
    const stored = await localRead(AUTO_BACKOFF_SUBSYSTEMS_STORAGE_KEY);
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
        localRead(AUTO_PROMOTION_STATE_KEY),
        localRead(AUTO_GENERIC_HIGH_KEY),
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
    loadPromotionMap(storedState?.genericHigh, autoPromotionState.genericHigh);
    loadPromotionMap(storedState?.complete, autoPromotionState.complete);
    if (
        autoPromotionState.genericHigh.size === 0 &&
        Array.isArray(legacyGenericHighHosts)
    ) {
        const now = Date.now();
        for ( const hostname of legacyGenericHighHosts ) {
            const normalizedHostname = normalizeAutoPromotedHostname(hostname);
            if ( normalizedHostname === '' ) { continue; }
            autoPromotionState.genericHigh.set(normalizedHostname, { lastHitAt: now });
        }
        await persistAutoPromotionState();
    }
    scheduleAutoPromotionAlarm();
};

const loadRemoteCosmeticsRuntimeStats = async () => {
    const stored = await localRead(REMOTE_COSMETICS_RUNTIME_STATS_KEY);
    remoteCosmeticsRuntimeStats = stored instanceof Object
        ? { ...stored }
        : {};
};

const loadCommunityEmergencySyncState = async () => {
    const stored = await localRead(COMMUNITY_EMERGENCY_SYNC_STATE_KEY);
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
    scheduleAutoBackoffAlarm();
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
    let genericHighChanged = false;
    let completeChanged = false;
    for ( const [hostname, entry] of Array.from(autoPromotionState.genericHigh.entries()) ) {
        const lastHitAt = Number(entry?.lastHitAt) || 0;
        if ( lastHitAt > 0 && (lastHitAt + AUTO_PROMOTION_TTL_MS) > now ) { continue; }
        autoPromotionState.genericHigh.delete(hostname);
        genericHighChanged = true;
    }
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
    if ( genericHighChanged || completeChanged ) {
        await persistAutoPromotionState();
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false });
    }
    scheduleAutoPromotionAlarm();
    return genericHighChanged || completeChanged;
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

const resetRemoteCosmeticsRuntimeStats = async () => {
    remoteCosmeticsRuntimeStats = {};
    await localRemove(REMOTE_COSMETICS_RUNTIME_STATS_KEY);
};

const recordRemoteCosmeticsRuntimeStats = async ({
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
    scopes[normalizedLaneScope] = {
        chunkCount: Math.max(0, Math.floor(Number(chunkCount) || 0)),
        selectorCount: Math.max(0, Math.floor(Number(selectorCount) || 0)),
        hostSpecificSelectorCount: Math.max(0, Math.floor(Number(hostSpecificSelectorCount) || 0)),
        droppedAtApply: Math.max(0, Math.floor(Number(droppedAtApply) || 0)),
        updatedAt: Date.now(),
    };
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
        updatedAt: Date.now(),
    };
    await persistRemoteCosmeticsRuntimeStats();
};

const touchAutoPromotionState = async (kind, hostname) => {
    const normalizedHostname = normalizeAutoPromotedHostname(hostname);
    if ( normalizedHostname === '' ) { return ''; }
    const targetMap = kind === 'complete'
        ? autoPromotionState.complete
        : autoPromotionState.genericHigh;
    targetMap.set(normalizedHostname, { lastHitAt: Date.now() });
    if ( kind !== 'complete' && targetMap.size > AUTO_GENERIC_HIGH_MAX ) {
        const overflow = targetMap.size - AUTO_GENERIC_HIGH_MAX;
        const oldest = Array.from(targetMap.entries())
            .sort((a, b) => (Number(a[1]?.lastHitAt) || 0) - (Number(b[1]?.lastHitAt) || 0))
            .slice(0, overflow);
        for ( const [hostToDrop] of oldest ) {
            targetMap.delete(hostToDrop);
        }
    }
    await persistAutoPromotionState();
    scheduleAutoPromotionAlarm();
    return normalizedHostname;
};

const clearAutoPromotionStateForHostname = async (
    hostname,
    { revertComplete = false } = {}
) => {
    const normalizedHostname = normalizeAutoPromotedHostname(hostname);
    if ( normalizedHostname === '' ) { return false; }
    let changed = false;
    if ( autoPromotionState.genericHigh.delete(normalizedHostname) ) {
        changed = true;
    }
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
        scheduleAutoPromotionAlarm();
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
        scheduleAutoBackoffAlarm();
        return hostMap.size >= BREAKAGE_SUBSYSTEM_IDS.length
            ? 'escalate'
            : 'handled';
    }
    hostMap.set(normalizedSubsystem, {
        expiresAt: now + AUTO_BACKOFF_TTL_MS,
    });
    await persistAutoBackoffSubsystemState();
    scheduleAutoBackoffAlarm();
    await clearAutoPromotionStateForHostname(normalizedHostname, {
        revertComplete: true,
    });
    await syncInjectablesAndRefreshTabs({ runtimeOnly: true });
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
        scheduleAutoBackoffAlarm();
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
    scheduleAutoBackoffAlarm();
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
        scheduleAutoBackoffAlarm();
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
        applyAutoBackoff(hostname).catch(ubolErr);
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
        recordBlockedNavigation(hostname);
    });
}

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
    webextFlavor,
} from './ext.js';

import {
    defaultConfig,
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
    setStrictBlockMode,
    updateDynamicRules,
    updateSessionRules,
    updateUserRules,
} from './ruleset-manager.js';

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
    readInjectableSyncDiagnostics,
    registerInjectables,
} from './scripting-manager.js';
import { setToolbarIcon, toggleToolbarIcon } from './action.js';

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
            ignoreRuntimeError();
        });
    } catch (reason) {
        ubolErr(`setUninstallURL/${reason}`);
    }
};

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
let paywallActive = false;
let lastCommunityCleanupReason = '';
let communityBaselineSyncInFlight;
let communityBaselineForceQueued = false;
let communityApplyQueue = Promise.resolve();
let entitlementOpenTabRefreshPromise;
const communityOverlaySyncInFlight = new Map();
let startupComplete = false;
let startupCoreReady = false;
let popupWarmupRecoveryPromise;
let installWelcomeAllowlistReadyPromise;
const overlaySessions = createOverlaySessionStore();

const AUTO_GENERIC_HIGH_KEY = 'autoGenericHighHosts';
const AUTO_GENERIC_HIGH_MAX = 200;
const AUTO_PROMOTE_ENABLED = true;
const STARTUP_SAFE_MESSAGE_TYPES = new Set([
    'applyRulesets',
    'getDefaultFilteringMode',
    'getEntitlementStatus',
    'getFilteringMode',
    'getFilteringModeDetails',
    'getEnabledRulesets',
    'getOptionsPageData',
    'getTabReloadNeededState',
    'popupPanelData',
    'popupWarmup',
    'setLicenseKey',
    'replaceDevice',
    'clearLicenseKey',
]);
const POST_STARTUP_ONLY_MESSAGE_TYPES = new Set([
]);
const MAX_MESSAGE_CSS_LENGTH = 120000;
const MAX_NAVIGATION_URL_LENGTH = 4096;
const MAX_LICENSE_KEY_LENGTH = 512;
const MAX_RULESETS_PER_REQUEST = 256;
const MAX_MODE_HOSTS_PER_LEVEL = 4096;
const POPUP_WARMUP_RECOVERY_TIMEOUT_MS = 4000;
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

function isStartupCoreReady() {
    return startupCoreReady === true || startupComplete === true;
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

async function recoverStartupCoreFromPopupWarmup() {
    if ( popupWarmupRecoveryPromise instanceof Promise ) {
        return popupWarmupRecoveryPromise;
    }
    popupWarmupRecoveryPromise = raceWithTimeout(
        syncInjectablesAndRefreshTabs({
            runtimeOnly: false,
            refreshOpenTabs: false,
        }),
        POPUP_WARMUP_RECOVERY_TIMEOUT_MS,
        'popup warmup recovery timeout'
    ).then(async syncResult => {
        const registerResult = syncResult?.registerResult instanceof Object
            ? syncResult.registerResult
            : null;
        const injectableSyncDiagnostics =
            await readInjectableSyncDiagnostics().catch(() => null);
        const injectableSyncReady =
            injectableSyncDiagnostics?.ok === true ||
            registerResult?.ok === true;
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
    }).catch(reason => ({
        syncResult: null,
        injectableSyncDiagnostics: null,
        injectableSyncReady: false,
        injectableSyncLastError: `${reason}`,
    })).finally(() => {
        popupWarmupRecoveryPromise = undefined;
    });
    return popupWarmupRecoveryPromise;
}

function shouldHandleMessageBeforeFullInitialization(request, sender) {
    if ( request instanceof Object === false ) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if ( STARTUP_SAFE_MESSAGE_TYPES.has(what) === false ) { return false; }
    return isTrustedExtensionSender(sender);
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

if ( chrome.webNavigation?.onCommitted ) {
    chrome.webNavigation.onCommitted.addListener(details => {
        if ( details?.frameId !== 0 ) { return; }
        clearReloadNeededStateForTab(details.tabId).catch(ubolErr);
    });
}

if ( browser.tabs?.onRemoved ) {
    browser.tabs.onRemoved.addListener(tabId => {
        clearReloadNeededStateForTab(tabId).catch(ubolErr);
    });
}

async function setFilteringMode(hostname, afterLevel) {
    return setFilteringModeRaw(hostname, afterLevel);
}

async function setFilteringModeDetails(details) {
    return setFilteringModeDetailsRaw(details);
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
    if ( await localRead(PENDING_INSTALL_RULESET_RESET_KEY).catch(() => null) ) {
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
        localRead(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
        localRead(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
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
        localRead(AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY),
        localRead(REGIONAL_RULESET_OPT_OUT_STORAGE_KEY),
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
        [ 'TalonBlockHintsController', [ 'stop' ] ],
        [ 'TalonNativeHeuristicsController', [ 'stop' ] ],
        [ 'TalonAutomationController', [ 'stop' ] ],
        [ 'TalonPostHideCleanupController', [ 'stop' ] ],
    ];
    const jobs = [];
    for ( const [globalName, methods] of controllerTargets ) {
        const controller = globalThis[globalName];
        if ( controller instanceof Object === false ) { continue; }
        let invoked = false;
        for ( const method of methods ) {
            if ( typeof controller[method] !== 'function' ) { continue; }
            invoked = true;
            try {
                jobs.push(Promise.resolve(controller[method]()));
            } catch {
            }
            break;
        }
        if ( invoked ) { continue; }
    }
    return Promise.all(jobs).then(() => true);
}

function stopMainWorldRuntimeControllers() {
    const controller = globalThis.TalonRemoteTacticsController;
    if ( controller instanceof Object === false ) { return Promise.resolve(true); }
    if ( typeof controller.stop !== 'function' ) { return Promise.resolve(true); }
    try {
        return Promise.resolve(controller.stop()).then(() => true);
    } catch {
    }
    return Promise.resolve(true);
}

async function executeRuntimeRefreshLane(tabId, files, options = {}) {
    if ( Array.isArray(files) === false || files.length === 0 ) { return false; }
    await browser.scripting.executeScript({
        files,
        target: { tabId, allFrames: true },
        ...options,
    });
    return true;
}

async function executeRuntimeStopLane(tabId, func, options = {}) {
    await browser.scripting.executeScript({
        func,
        target: { tabId, allFrames: true },
        ...options,
    });
    return true;
}

async function readRegisteredRemoteCosmeticHostnames() {
    const storedCosmetics = await localRead(REMOTE_COSMETICS_STORAGE_KEY);
    return collectStoredRemoteCosmeticHostnames(storedCosmetics);
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

async function refreshRuntimeStateForTab(
    tabId,
    filteringLevel,
    {
        url = '',
        hostname = '',
        remoteCosmeticHostnames = new Set(),
    } = {}
) {
    if ( browser.scripting?.executeScript === undefined ) { return false; }
    try {
        if ( filteringLevel >= MODE_OPTIMAL ) {
            await executeRuntimeRefreshLane(tabId, ISOLATED_LIVE_RUNTIME_REFRESH_FILES);
            const shouldRefreshRemoteCosmeticsHost = await tabMatchesHostnameSet(tabId, {
                fallbackUrl: url,
                hostname,
                hostnames: remoteCosmeticHostnames,
            });
            if ( shouldRefreshRemoteCosmeticsHost ) {
                await executeRuntimeRefreshLane(
                    tabId,
                    REMOTE_COSMETICS_HOST_LIVE_RUNTIME_REFRESH_FILES
                );
            } else {
                await executeRuntimeStopLane(tabId, stopRemoteCosmeticsHostController);
            }
            await executeRuntimeStopLane(tabId, stopRemoteTacticsBootstrapController);
            await executeRuntimeStopLane(tabId, stopMainWorldRuntimeControllers, {
                world: 'MAIN',
            });
            return true;
        }
        await executeRuntimeStopLane(tabId, stopIsolatedRuntimeControllers);
        await executeRuntimeStopLane(tabId, stopMainWorldRuntimeControllers, {
            world: 'MAIN',
        });
        return true;
    } catch (reason) {
        if ( isIgnorableRuntimeError(reason) === false ) {
            ubolErr(`refreshRuntimeStateForTab/${reason}`);
        }
    }
    return false;
}

async function refreshRuntimeStateForOpenTabs() {
    if ( browser.tabs?.query === undefined ) { return false; }
    let tabs = [];
    const remoteCosmeticHostnames = await readRegisteredRemoteCosmeticHostnames().catch(
        () => new Set()
    );
    try {
        tabs = await browser.tabs.query({});
    } catch (reason) {
        ubolErr(`refreshRuntimeStateForOpenTabs/query/${reason}`);
        return false;
    }
    const jobs = [];
    for ( const tab of tabs || [] ) {
        const tabId = Number.isInteger(tab?.id) ? tab.id : -1;
        if ( tabId < 0 ) { continue; }
        const hostname = normalizeHttpHostname(tab?.url || '');
        if ( hostname === '' ) { continue; }
        jobs.push(
            getFilteringMode(hostname)
                .then(level => refreshRuntimeStateForTab(tabId, Number(level) || MODE_NONE, {
                    url: tab?.url || '',
                    hostname,
                    remoteCosmeticHostnames,
                }))
                .catch(reason => {
                    if ( isIgnorableRuntimeError(reason) === false ) {
                        ubolErr(`refreshRuntimeStateForOpenTabs/${reason}`);
                    }
                    return false;
                })
        );
    }
    await Promise.all(jobs);
    return true;
}

function queueEntitlementOpenTabRefresh() {
    if ( entitlementOpenTabRefreshPromise instanceof Promise ) {
        return entitlementOpenTabRefreshPromise;
    }
    entitlementOpenTabRefreshPromise = refreshRuntimeStateForOpenTabs()
        .then(async refreshed => {
            if ( refreshed === true ) {
                lastInjectableRuntimeFingerprint =
                    await computeInjectableRuntimeFingerprint().catch(() => '');
            }
            return refreshed;
        })
        .catch(ubolErr)
        .finally(() => {
            entitlementOpenTabRefreshPromise = undefined;
        });
    return entitlementOpenTabRefreshPromise;
}

async function computeInjectableRuntimeFingerprint() {
    const [
        filteringModeDetails,
        remoteCosmetics,
        remoteHeuristics,
        publicDirectives,
        privateDirectives,
        directives,
    ] = await Promise.all([
        getFilteringModeDetails(true).catch(() => null),
        localRead(REMOTE_COSMETICS_STORAGE_KEY).catch(() => null),
        localRead('communityBundleHeuristics').catch(() => null),
        localRead('communityBundlePublicDirectives').catch(() => null),
        localRead('communityBundlePrivateDirectives').catch(() => null),
        localRead('communityBundleDirectives').catch(() => null),
    ]);
    return JSON.stringify({
        filteringModeDetails,
        enabledRulesets: Array.isArray(rulesetConfig.enabledRulesets)
            ? rulesetConfig.enabledRulesets.slice().sort()
            : [],
        remoteCosmetics,
        remoteHeuristics,
        publicDirectives,
        privateDirectives,
        directives,
    });
}

async function syncInjectablesAndRefreshTabs({
    runtimeOnly = false,
    refreshOpenTabs = true,
} = {}) {
    if ( isEntitled() === false ) {
        return {
            registerResult: false,
            runtimeRefreshed: false,
            reloadHint: null,
        };
    }
    let registerResult = true;
    let reloadHint = null;
    let registrationChanged = false;
    if ( runtimeOnly !== true ) {
        registerResult = await registerInjectablesIfEntitled().catch(reason => ({
            ok: false,
            lastError: String(reason || 'register injectables failed'),
        }));
        registrationChanged = registerResult instanceof Object && registerResult.ok === true && (
            (Number(registerResult.toAddCount) || 0) !== 0 ||
            (Number(registerResult.toRemoveCount) || 0) !== 0
        );
        reloadHint = registerResult instanceof Object && registerResult.ok === true
            ? registerResult.remoteScriptletReloadHint ?? null
            : null;
        if ( reloadHint instanceof Object ) {
            await markTabsForRemoteScriptletReload(reloadHint).catch(ubolErr);
        }
    }
    const runtimeFingerprint = refreshOpenTabs === true
        ? await computeInjectableRuntimeFingerprint().catch(() => '')
        : '';
    const shouldRefreshOpenTabs =
        refreshOpenTabs === true && (
            runtimeOnly === true ||
            registrationChanged === true ||
            runtimeFingerprint !== lastInjectableRuntimeFingerprint
        );
    if ( shouldRefreshOpenTabs ) {
        await refreshRuntimeStateForOpenTabs().catch(ubolErr);
        lastInjectableRuntimeFingerprint = runtimeFingerprint;
    }
    return {
        registerResult,
        runtimeRefreshed: shouldRefreshOpenTabs,
        reloadHint,
        runtimeFingerprint,
    };
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

async function unregisterAllContentScripts() {
    if (browser.scripting?.getRegisteredContentScripts === undefined) { return; }
    let registered = [];
    try {
        registered = await browser.scripting.getRegisteredContentScripts();
    } catch (reason) {
        ubolErr(`getRegisteredContentScripts/${reason}`);
        return;
    }
    const ids = registered
        .map(entry => entry?.id)
        .filter(id => typeof id === 'string' && id !== '');
    if (ids.length === 0) { return; }
    try {
        await browser.scripting.unregisterContentScripts({ ids });
    } catch (reason) {
        ubolErr(`unregisterContentScripts/${reason}`);
    }
}

async function enablePaywall({ broadcast = true } = {}) {
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
    try {
        await dnr.setAllowAllRules(
            PAYWALL_RULE_BASE_ID,
            [],
            [],
            true,
            PAYWALL_RULE_PRIORITY
        );
    } catch (reason) {
        ubolErr(`paywall/setAllowAllRules/${reason}`);
    }
    await unregisterAllContentScripts();
    if (broadcast) {
        broadcastMessage({ entitlement: entitlementStatus });
    }
}

async function disablePaywall({ broadcast = true } = {}) {
    paywallActive = false;
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
    try {
        await dnr.setAllowAllRules(
            PAYWALL_RULE_BASE_ID,
            [],
            [],
            false,
            PAYWALL_RULE_PRIORITY
        );
    } catch (reason) {
        ubolErr(`paywall/clearAllowAllRules/${reason}`);
    }
    await refreshReloadNeededBadges().catch(ubolErr);
    await syncToolbarIconsForAllTabs().catch(ubolErr);
    if (broadcast) {
        broadcastMessage({ entitlement: entitlementStatus });
    }
}

function scheduleEntitlementAlarms(status) {
    if (browser.alarms?.create === undefined) { return; }
    // Hourly: catches trial expiry even if the browser was asleep.
    browser.alarms.create(ENTITLEMENT_CHECK_ALARM, {
        delayInMinutes: 60,
        periodInMinutes: 60,
    });

    if (status?.status === 'trial' && typeof status.trialEndMs === 'number') {
        const when = status.trialEndMs + 2000;
        if (Number.isFinite(when) && when > Date.now()) {
            browser.alarms.create(ENTITLEMENT_EXPIRE_ALARM, { when });
            return;
        }
    }
    browser.alarms?.clear?.(ENTITLEMENT_EXPIRE_ALARM);
}

async function scheduleTrialExpiredReminderAlarm(status) {
    if (browser.alarms?.create === undefined) { return; }

    if (shouldEnablePaywallForStatus(status) === false) {
        browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    const now = Date.now();
    const storedLastShown = Number(await localRead(TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY)) || 0;
    const when = getTrialReminderWhen({
        status,
        now,
        lastShownMs: storedLastShown,
        initialDelayMs: TRIAL_EXPIRED_REMINDER_INITIAL_DELAY_MS,
        intervalMs: TRIAL_EXPIRED_REMINDER_INTERVAL_MS,
    });
    if (Number.isFinite(when) === false) {
        browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    browser.alarms.create(TRIAL_EXPIRED_REMINDER_ALARM, {
        when,
        periodInMinutes: TRIAL_EXPIRED_REMINDER_PERIOD_MINUTES,
    });
}

async function maybeShowTrialExpiredReminder() {
    const status = await enforceEntitlement({ verify: true });
    if (shouldEnablePaywallForStatus(status) === false) {
        browser.alarms?.clear?.(TRIAL_EXPIRED_REMINDER_ALARM);
        return;
    }

    const now = Date.now();
    const lastShownMs = Number(await localRead(TRIAL_EXPIRED_REMINDER_LAST_SHOWN_KEY)) || 0;
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

async function refreshEntitlement({ verify = false, forceVerify = false } = {}) {
    await initEntitlement();
    if (verify) {
        await verifyLicense({ force: forceVerify }).catch(() => { });
    }
    entitlementStatus = await getEntitlementStatusFromStorage();
    scheduleEntitlementAlarms(entitlementStatus);
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

async function applyEntitlementStatusEffects(
    status,
    {
        broadcast = true,
        paywallWasActive = paywallActive,
        previousStatus = entitlementStatus,
        registerInjectablesOnEntitled = true,
        refreshOpenTabsOnEntitled = true,
    } = {}
) {
    if ( shouldEnablePaywallForStatus(status) ) {
        await enablePaywall({ broadcast });
        return { forcedCommunitySync: false };
    }

    if ( paywallWasActive ) {
        await disablePaywall({ broadcast });
    }
    if ( registerInjectablesOnEntitled ) {
        await syncInjectablesAndRefreshTabs({
            runtimeOnly: false,
            refreshOpenTabs: refreshOpenTabsOnEntitled,
        }).catch(ubolErr);
    }

    const forcedCommunitySync = shouldForceCommunitySyncAfterEntitlementRefresh({
        status,
        wasPaywalled: paywallWasActive,
        wasStatusExpired: shouldEnablePaywallForStatus(previousStatus),
    });
    if ( forcedCommunitySync ) {
        runCommunitySync({ force: true });
    }
    return { forcedCommunitySync };
}

async function enforceEntitlement({ verify = false, forceVerify = false } = {}) {
    const previousStatus = entitlementStatus;
    const paywallWasActive = paywallActive;
    const status = await refreshEntitlement({ verify, forceVerify });
    await applyEntitlementStatusEffects(status, {
        paywallWasActive,
        previousStatus,
        registerInjectablesOnEntitled: true,
    });
    return status;
}

async function addAutoGenericHighHost(hostname) {
    const hn = await touchAutoPromotionState('genericHigh', hostname);
    if ( hn === '' ) { return; }
    registerInjectablesIfEntitled().catch(ubolErr);
}

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

/******************************************************************************/

const ANNOYANCE_RULESET_IDS = [
    'annoyances-cookies',
    'annoyances-notifications',
    'annoyances-others',
    'annoyances-overlays',
    'annoyances-social',
    'annoyances-widgets',
];
let annoyancesAdjusting = false;

const arrayEqAsSet = (a = [], b = []) => {
    const sa = Array.from(new Set(a)).sort();
    const sb = Array.from(new Set(b)).sort();
    if (sa.length !== sb.length) { return false; }
    for (let i = 0; i < sa.length; i++) {
        if (sa[i] !== sb[i]) { return false; }
    }
    return true;
};

async function ensureAnnoyancesForCompleteDefault() {
    if (annoyancesAdjusting) { return; }
    annoyancesAdjusting = true;
    try {
        const defaultMode = await getDefaultFilteringMode();
        const enabledBefore = Array.isArray(rulesetConfig.enabledRulesets)
            ? rulesetConfig.enabledRulesets.slice()
            : [];

        if (defaultMode === MODE_COMPLETE) {
            const disabledByUser = await localRead(AUTO_ANNOYANCES_DISABLED_KEY);
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
            const result = await enableRulesets(afterIds);
            if (result?.enabledRulesets) {
                rulesetConfig.enabledRulesets = result.enabledRulesets;
                await saveRulesetConfig();
                registerInjectablesIfEntitled().catch(ubolErr);
                broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
            }
            return;
        }

        const baseline = await localRead(AUTO_ANNOYANCES_BASELINE_KEY);
        if (Array.isArray(baseline) === false) { return; }

        const expected = Array.from(new Set(baseline.concat(ANNOYANCE_RULESET_IDS)));
        if (arrayEqAsSet(enabledBefore, expected)) {
            const result = await enableRulesets(baseline);
            if (result?.enabledRulesets) {
                rulesetConfig.enabledRulesets = result.enabledRulesets;
                await saveRulesetConfig();
                registerInjectablesIfEntitled().catch(ubolErr);
                broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
            }
        }
        await localRemove(AUTO_ANNOYANCES_BASELINE_KEY);
    } finally {
        annoyancesAdjusting = false;
    }
}

async function onPermissionsRemoved() {
    const modified = await syncWithBrowserPermissions();
    if (modified === false) { return false; }
    await ensureAnnoyancesForCompleteDefault().catch(ubolErr);
    syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
    return true;
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
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
    const { pending } = onPermissionsChanged;
    await Promise.all(pending);
    const promise = op === 'removed'
        ? onPermissionsRemoved()
        : onPermissionsAdded(permissions);
    pending.push(promise);
}
onPermissionsChanged.pending = [];

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
    await Promise.all([
        updateUserRules(),
        saveRulesetConfig(),
    ]);
    if ( cleanupResult.requiresInjectableRefresh ) {
        await syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
    }
}

/******************************************************************************/

function onMessage(request, sender, callback) {
    if (request instanceof Object === false) { return false; }
    const what = typeof request.what === 'string' ? request.what : '';
    if (what === '') { return false; }

    const tabId = sender?.tab?.id ?? false;
    const frameId = tabId && (sender?.frameId ?? false);

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
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            const css = sanitizeCssPayload(request.css);
            if (css === '') { return false; }
            // https://bugs.webkit.org/show_bug.cgi?id=262491
            if (frameId !== 0 && webextFlavor === 'safari') { return false; }
            browser.scripting.insertCSS({
                css,
                origin: 'USER',
                target: { tabId, frameIds: [frameId] },
            }).catch(reason => {
                ubolErr(`insertCSS/${reason}`);
            });
            return false;
        }

        case 'removeCSS': {
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            const css = sanitizeCssPayload(request.css);
            if (css === '') { return false; }
            browser.scripting.removeCSS({
                css,
                origin: 'USER',
                target: { tabId, frameIds: [frameId] },
            }).catch(reason => {
                ubolErr(`removeCSS/${reason}`);
            });
            return false;
        }

        case 'promoteGenericHigh': {
            if (AUTO_PROMOTE_ENABLED === false) { return false; }
            if (isEntitled() === false) { return false; }
            if (typeof request.hostname === 'string') {
                addAutoGenericHighHost(request.hostname).catch(ubolErr);
            }
            return false;
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
            const reportedHostname = typeof request.hostname === 'string'
                ? request.hostname.trim().toLowerCase()
                : '';
            const senderHostname = normalizeHttpHostname(sender?.url || '');
            const hostname = reportedHostname || senderHostname;
            if (hostname === '') { return false; }
            const details = request.details instanceof Object
                ? { ...request.details }
                : {};
            const subsystem = normalizeBreakageSubsystem(request.subsystem || details.subsystem);
            if ( subsystem !== '' ) {
                details.subsystem = subsystem;
            }
            recordBreakageSignal(hostname, request.signal, details).catch(ubolErr);
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
            readInjectableSyncDiagnostics().then(result => {
                callback(result instanceof Object ? result : {});
            }).catch(reason => {
                ubolErr(`getInjectableSyncDiagnostics/${reason}`);
                callback({});
            });
            return true;

        case 'toggleToolbarIcon': {
            if (paywallActive) { return false; }
            if (tabId) {
                toggleToolbarIcon(tabId);
            }
            return false;
        }

        case 'startCustomFilters':
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            startCustomFilters(tabId, frameId).then(() => {
                callback();
            });
            return true;

        case 'terminateCustomFilters':
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            terminateCustomFilters(tabId, frameId).then(() => {
                callback();
            });
            return true;

        case 'injectCustomFilters':
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            injectCustomFilters(tabId, frameId, request.hostname).then(selectors => {
                callback(selectors);
            });
            return true;

        case 'injectCSSProceduralAPI':
            if (isEntitled() === false) { return false; }
            if (frameId === false) { return false; }
            browser.scripting.executeScript({
                files: ['/js/scripting/css-procedural-api.js'],
                target: { tabId, frameIds: [frameId] },
                injectImmediately: true,
            }).catch(reason => {
                ubolErr(`executeScript/${reason}`);
            }).then(() => {
                callback();
            });
            return true;

        default:
            break;
    }

    // Does require trusted origin.
    if (isTrustedExtensionSender(sender) === false) { return false; }

    switch (what) {

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
            const enabledRulesets = sanitizeRulesetIds(request.enabledRulesets);
            if (enabledRulesets === null) {
                callback({ error: 'invalid_rulesets' });
                return true;
            }
            if (isEntitled() === false) {
                enablePaywall().catch(ubolErr);
                callback({ error: 'subscription_required' });
                return true;
            }
            Promise.all([
                getDefaultFilteringMode(),
                localRemove(AUTO_ANNOYANCES_BASELINE_KEY),
            ]).then(([defaultMode]) => {
                if (defaultMode === MODE_COMPLETE) {
                    const hasAllAnnoyances = ANNOYANCE_RULESET_IDS.every(id =>
                        enabledRulesets.includes(id)
                    );
                    localWrite(AUTO_ANNOYANCES_DISABLED_KEY, hasAllAnnoyances === false);
                }
                return enableRulesets(enabledRulesets);
            }).then(result => {
                if (result === undefined || result.error) {
                    callback(result);
                    return;
                }
                rulesetConfig.rulesetSelectionVersion = RULESET_SELECTION_STATE_VERSION;
                rulesetConfig.enabledRulesets = result.enabledRulesets;
                return syncRegionalRulesetOptOutState(result.enabledRulesets).then(() =>
                    saveRulesetConfig()
                ).then(() => {
                    return syncInjectablesAndRefreshTabs({ runtimeOnly: false });
                }).then(() => {
                    callback(result);
                });
            }).finally(() => {
                broadcastMessage({ enabledRulesets: rulesetConfig.enabledRulesets });
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
                    adminRulesets,
                    maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                    rulesetDetails: Array.from(rulesetDetails.values()),
                    autoReload: rulesetConfig.autoReload,
                    showBlockedCount: rulesetConfig.showBlockedCount,
                    canShowBlockedCount,
                    strictBlockMode: rulesetConfig.strictBlockMode,
                    firstRun: process.firstRun,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures,
                });
                process.firstRun = false;
            }).catch(reason => {
                ubolErr(`getOptionsPageData/${reason}`);
                callback({
                    hasOmnipotence: true,
                    defaultFilteringMode: MODE_OPTIMAL,
                    enabledRulesets: [],
                    adminRulesets: [],
                    maxNumberOfEnabledRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
                    rulesetDetails: [],
                    autoReload: rulesetConfig.autoReload,
                    showBlockedCount: rulesetConfig.showBlockedCount,
                    canShowBlockedCount,
                    strictBlockMode: rulesetConfig.strictBlockMode,
                    firstRun: process.firstRun,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures: [],
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
            setStrictBlockMode(request.state).then(() => {
                callback();
                broadcastMessage({ strictBlockMode: rulesetConfig.strictBlockMode });
            });
            return true;

        case 'setDeveloperMode':
            setDeveloperMode(request.state).then(() => {
                callback();
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
            callback(getReloadNeededState(requestedTabId));
            return true;
        }

        case 'getFilteringMode': {
            getFilteringMode(request.hostname).then(actualLevel => {
                callback(actualLevel);
            });
            return true;
        }

        case 'maybeOpenFirstPopupWelcome': {
            Promise.all([
                localRead(FIRST_POPUP_WELCOME_PENDING_KEY),
                localRead(FIRST_POPUP_WELCOME_SEEN_KEY),
            ]).then(async ([pending, seenAt]) => {
                if (pending !== true && pending instanceof Object === false) {
                    callback({ opened: false });
                    return;
                }
                const seenTs = Number(seenAt) || 0;
                if (seenTs > 0) {
                    await localRemove(FIRST_POPUP_WELCOME_PENDING_KEY);
                    callback({ opened: false });
                    return;
                }
                const url = buildFirstPopupWelcomeURL();
                await localWrite(FIRST_POPUP_WELCOME_SEEN_KEY, Date.now());
                await localRemove(FIRST_POPUP_WELCOME_PENDING_KEY);
                await gotoURL(url);
                callback({ opened: true });
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
            getFilteringMode(hostname).then(beforeLevel => {
                if (level === beforeLevel) { return beforeLevel; }
                return setFilteringMode(hostname, level);
            }).then(afterLevel => {
                return syncInjectablesAndRefreshTabs({ runtimeOnly: false })
                    .catch(ubolErr)
                    .then(() => afterLevel);
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
                let injectableSyncDiagnostics = isStartupCoreReady()
                    ? await readInjectableSyncDiagnostics().catch(( ) => null)
                    : null;
                let injectableSyncReady = injectableSyncDiagnostics?.ok === true;
                let injectableSyncLastError = normalizePopupWarmupLastError(
                    injectableSyncDiagnostics
                );

                if ( injectableSyncReady === false ) {
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
            const previousStatus = entitlementStatus;
            const paywallWasActive = paywallActive;
            refreshEntitlement({ verify: false }).then(async status => {
                await applyEntitlementStatusEffects(status, {
                    broadcast: false,
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled:
                        paywallWasActive ||
                        shouldEnablePaywallForStatus(previousStatus),
                    refreshOpenTabsOnEntitled: false,
                }).catch(ubolErr);
                if (shouldEnablePaywallForStatus(status) === false) {
                    queueEntitlementOpenTabRefresh();
                }
                callback(await formatEntitlementStatusResponse(status));
            }).catch(reason => {
                ubolErr(`getEntitlementStatus/${reason}`);
                callback({ status: 'expired', error: `${reason}` });
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
            const previousStatus = entitlementStatus;
            const paywallWasActive = paywallActive;
            storeLicenseKey(parsed.key).then(() =>
                refreshEntitlement({ verify: true, forceVerify: true })
            ).then(async status => {
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled: true,
                    refreshOpenTabsOnEntitled: false,
                }).catch(ubolErr);
                if (shouldEnablePaywallForStatus(status) === false) {
                    queueEntitlementOpenTabRefresh();
                }
                callback(await formatEntitlementStatusResponse(status));
            }).catch(reason => {
                ubolErr(`setLicenseKey/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;
        }

        case 'replaceDevice': {
            const previousStatus = entitlementStatus;
            const paywallWasActive = paywallActive;
            verifyLicense({ force: true, replaceDevice: true }).then(() =>
                refreshEntitlement({ verify: false })
            ).then(async status => {
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled: true,
                    refreshOpenTabsOnEntitled: false,
                }).catch(ubolErr);
                if (shouldEnablePaywallForStatus(status) === false) {
                    queueEntitlementOpenTabRefresh();
                }
                callback(await formatEntitlementStatusResponse(status));
            }).catch(reason => {
                ubolErr(`replaceDevice/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;
        }

        case 'clearLicenseKey': {
            const previousStatus = entitlementStatus;
            const paywallWasActive = paywallActive;
            clearLicenseKey().then(() =>
                refreshEntitlement({ verify: false })
            ).then(async status => {
                await applyEntitlementStatusEffects(status, {
                    paywallWasActive,
                    previousStatus,
                    registerInjectablesOnEntitled: false,
                    refreshOpenTabsOnEntitled: false,
                }).catch(ubolErr);
                callback(await formatEntitlementStatusResponse(status));
            }).catch(reason => {
                ubolErr(`clearLicenseKey/${reason}`);
                callback({ error: `${reason}` });
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
            setFilteringModeDetails(modes).then(() => {
                return ensureAnnoyancesForCompleteDefault().catch(ubolErr);
            }).then(() => {
                return syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);
            }).then(() => {
                getDefaultFilteringMode().then(defaultFilteringMode => {
                    broadcastMessage({ defaultFilteringMode });
                });
                return syncToolbarIconsForAllTabs().catch(ubolErr);
            }).then(() =>
                getFilteringModeDetails(true)
            ).then(details => {
                callback(details);
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
            updateUserRules().then(result => {
                callback(result);
            });
            return true;

        case 'addCustomFilters':
            addCustomFilters(request.hostname, request.selectors).then(modified => {
                if (modified !== true) { return; }
                return registerInjectablesIfEntitled();
            }).then(() => {
                callback();
            })
            return true;

        case 'removeCustomFilters':
            removeCustomFilters(request.hostname, request.selectors).then(modified => {
                if (modified !== true) { return; }
                return registerInjectablesIfEntitled();
            }).then(() => {
                callback();
            });
            return true;

        case 'removeAllCustomFilters':
            removeAllCustomFilters(request.hostname).then(modified => {
                if (modified !== true) { return; }
                return registerInjectablesIfEntitled();
            }).then(() => {
                callback();
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

        case 'getConsoleOutput':
            callback(getConsoleOutput());
            return true;

        default:
            break;
    }

    return false;
}

/******************************************************************************/

function onCommand(command, tab) {
    if (isEntitled() === false) { return; }
    switch (command) {
        case 'enter-picker-mode': {
            if (browser.scripting === undefined) { return; }
            if ( Number.isInteger(tab?.id) === false ) { return; }
            browser.scripting.executeScript({
                files: [
                    '/js/scripting/css-procedural-api.js',
                    '/js/scripting/tool-overlay.js',
                    '/js/scripting/picker.js',
                ],
                target: { tabId: tab.id },
            }).catch(ignoreRuntimeError);
            break;
        }
        default:
            break;
    }
}

/******************************************************************************/

async function startSession() {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;
    let defaultsPatched = false;
    let regionalPatchResult = {
        changed: false,
        customized: false,
        storageChanged: false,
    };

    // Admin settings override user settings
    await loadAdminConfig();

    // The default rulesets may have changed, find out new ruleset to enable,
    // obsolete ruleset to remove.
    if (isNewVersion) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
    }
    defaultsPatched = await patchDefaultRulesets();
    regionalPatchResult = await patchAutoRegionalRulesets();
    if (isNewVersion || defaultsPatched || regionalPatchResult.changed) {
        saveRulesetConfig();
    }

    const rulesetsUpdated = await enableRulesets(rulesetConfig.enabledRulesets);

    // We need to update the regex rules only when ruleset version changes.
    let dnrUpdatePromise;
    if (rulesetsUpdated === undefined) {
        if (isNewVersion) {
            dnrUpdatePromise = updateDynamicRules();
        } else {
            dnrUpdatePromise = updateSessionRules();
        }
    }
    if (dnrUpdatePromise) {
        await dnrUpdatePromise;
    }

    // Permissions may have been removed while the extension was disabled
    await syncWithBrowserPermissions();
    await ensureAnnoyancesForCompleteDefault().catch(ubolErr);

    // Community intelligence sync (runs after DNR state is settled)
    try {
        if (isEntitled()) {
            runCommunitySync({ force: process.firstRun || isNewVersion });
        }
    } catch (e) {
        ubolErr(`community-sync/${e}`);
    }

    // Enforce trial/subscription state before registering injectables.
    await enforceEntitlement({ verify: true }).catch(ubolErr);

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

    // Switch to basic filtering if uBOL doesn't have broad permissions at
    // install time.
    if (process.firstRun) {
        const enableOptimal = await hasBroadHostPermissions();
        if (enableOptimal === false) {
            const afterLevel = await setDefaultFilteringMode(MODE_BASIC);
            if (afterLevel === MODE_BASIC) {
                registerInjectablesIfEntitled().catch(ubolErr);
                process.firstRun = false;
                await ensureAnnoyancesForCompleteDefault().catch(ubolErr);
            }
        }
    }

    const reportedEnabledRulesets = await getReportedEnabledRulesets().catch(() =>
        getStoredEnabledRulesetsSnapshot()
    );
    broadcastMessage({ enabledRulesets: reportedEnabledRulesets });

    // Required to ensure up to date properties are available when needed
    adminReadEx('disabledFeatures').then(items => {
        if (Array.isArray(items) === false) { return; }
        if (items.includes('develop')) {
            if (rulesetConfig.developerMode) {
                setDeveloperMode(false);
            }
        }
    });
}

/******************************************************************************/

async function runStartupRulesetMaintenance() {
    const currentVersion = getCurrentVersion();
    const isNewVersion = currentVersion !== rulesetConfig.version;
    let defaultsPatched = false;
    let regionalPatchResult = {
        changed: false,
        customized: false,
        storageChanged: false,
    };

    await loadAdminConfig();

    if (isNewVersion) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
    }
    defaultsPatched = await patchDefaultRulesets();
    regionalPatchResult = await patchAutoRegionalRulesets();
    if (isNewVersion || defaultsPatched || regionalPatchResult.changed) {
        await saveRulesetConfig();
    }

    const shouldSyncRulesets = isNewVersion || defaultsPatched || regionalPatchResult.changed;
    if (shouldSyncRulesets) {
        const rulesetsUpdated = await enableRulesets(rulesetConfig.enabledRulesets);
        if (rulesetsUpdated === undefined) {
            if (isNewVersion) {
                await updateDynamicRules();
            } else {
                await updateSessionRules();
            }
        }
        await syncWithBrowserPermissions();
        await ensureAnnoyancesForCompleteDefault().catch(ubolErr);

        const reportedEnabledRulesets = await getReportedEnabledRulesets().catch(() =>
            getStoredEnabledRulesetsSnapshot()
        );
        broadcastMessage({ enabledRulesets: reportedEnabledRulesets });
    }

    return {
        isNewVersion,
        defaultsPatched,
        regionalPatchResult,
    };
}

/******************************************************************************/

async function applyPendingInstallRulesetReset() {
    const marker = await localRead(PENDING_INSTALL_RULESET_RESET_KEY).catch(() => null);
    if ( marker === null || marker === undefined ) { return false; }

    const defaultRulesetIds = await getDefaultRulesetsFromEnv().catch((reason) => {
        ubolErr(`getDefaultRulesetsFromEnv/${reason}`);
        return [];
    });
    if ( defaultRulesetIds.length === 0 ) {
        await localRemove(PENDING_INSTALL_RULESET_RESET_KEY).catch(ubolErr);
        return false;
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
        localRemove(PENDING_INSTALL_RULESET_RESET_KEY),
        saveRulesetConfig(),
    ]).catch(ubolErr);

    return true;
}

/******************************************************************************/

async function start() {
    await loadRulesetConfig();
    await applyPendingInstallRulesetReset().catch(ubolErr);
    if (process.wakeupRun) {
        await runStartupRulesetMaintenance().catch(ubolErr);
    }
    await ensureInstallWelcomeAllowlistReady().catch(ubolErr);
    await initEntitlement().then(status => {
        entitlementStatus = status;
        scheduleEntitlementAlarms(entitlementStatus);
        scheduleTrialExpiredReminderAlarm(entitlementStatus).catch(ubolErr);
    }).catch(ubolErr);
    if (entitlementStatus?.status === 'expired') {
        await enablePaywall({ broadcast: false }).catch(ubolErr);
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

    // Prime dynamic registrations from cached state so popup state and warm
    // wakeups do not stall on empty content-script registration.
    await syncInjectablesAndRefreshTabs({ runtimeOnly: false }).catch(ubolErr);

    // Core startup is ready once injectables are synced and extension-owned
    // control pages can safely interact with the background worker.
    startupCoreReady = true;

    if (process.wakeupRun === false) {
        await startSession();
    } else {
        // Ensure paywall is enforced even if we skipped full session init.
        await enforceEntitlement({ verify: true }).catch(ubolErr);
    }

    await initAutoBackoff().catch(ubolErr);
    await initAutoPromotionState().catch(ubolErr);
    await initRuntimeDiagnosticsState().catch(ubolErr);
    await initCommunityEmergencySyncState().catch(ubolErr);
    await syncToolbarIconsForAllTabs().catch(ubolErr);

    toggleDeveloperMode(rulesetConfig.developerMode);
    startupComplete = true;
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/199
// Force a restart of the extension once when an "internal error" occurs

const isFullyInitialized = start().then(() => {
    localRemove('goodStart');
    return false;
}).catch(reason => {
    ubolErr(reason);
    if (process.wakeupRun) { return; }
    return localRead('goodStart').then(goodStart => {
        if (goodStart === false) {
            localRemove('goodStart');
            return false;
        }
        return localWrite('goodStart', false).then(() => true);
    });
}).then(restart => {
    if (restart !== true) { return; }
    runtime.reload();
});

runtime.onMessage.addListener((request, sender, callback) => {
    const safeCallback = (response) => {
        try {
            callback(response);
        } catch (reason) {
            const message = reason === undefined ? 'undefined' : reason;
            ubolErr(`runtime.onMessage/respond/${message}`);
        }
    };
    const handleMessage = () => {
        let handled = false;
        try {
            handled = onMessage(request, sender, safeCallback);
        } catch (reason) {
            ubolErr(`onMessage/${reason}`);
        }
        if (handled !== true) { safeCallback(); }
    };
    if ( shouldRejectPostStartupOnlyMessage(request, sender) ) {
        safeCallback(buildPostStartupOnlyResponse());
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
        safeCallback();
    });
    return true;
});

browser.permissions.onRemoved.addListener((...args) => {
    isFullyInitialized.then(() => {
        onPermissionsChanged('removed', ...args);
    });
});

browser.permissions.onAdded.addListener((...args) => {
    isFullyInitialized.then(() => {
        onPermissionsChanged('added', ...args);
    });
});

browser.commands.onCommand.addListener((...args) => {
    isFullyInitialized.then(() => {
        onCommand(...args);
    });
});

async function openInstallWelcomeAfterAllowlistReady(url) {
    // Static rules can already be active on first install; wait only for the
    // internal Talon allowlist, not for unrelated extension startup work.
    await ensureInstallWelcomeAllowlistReady().catch(reason => {
        ubolErr(`runtime.onInstalled/allowlist/${reason}`);
    });
    await gotoURL(url);
}

runtime.onInstalled.addListener((details) => {
    configureUninstallURL(`extension_${details?.reason || 'install'}`);
    if (details?.reason !== 'install') { return; }
    const url = INSTALL_WELCOME_URL;
    localWrite(PENDING_INSTALL_RULESET_RESET_KEY, {
        queuedAt: Date.now(),
    }).catch(ubolErr);
    localWrite(FIRST_POPUP_WELCOME_PENDING_KEY, {
        source: FIRST_POPUP_WELCOME_SOURCE,
        queuedAt: Date.now(),
    }).catch(ubolErr);
    localRemove(FIRST_POPUP_WELCOME_SEEN_KEY).catch(ubolErr);
    openInstallWelcomeAfterAllowlistReady(url).catch(reason => {
        ubolErr(`runtime.onInstalled/welcome/${reason}`);
    });
});

browser.alarms?.onAlarm.addListener(alarm => {
    if (alarm?.name === AUTO_BACKOFF_ALARM) {
        restoreExpiredAutoBackoffs().catch(ubolErr);
        return;
    }
    if (alarm?.name === AUTO_PROMOTION_ALARM) {
        pruneExpiredAutoPromotions().catch(ubolErr);
        return;
    }
    if (alarm?.name === TRIAL_EXPIRED_REMINDER_ALARM) {
        maybeShowTrialExpiredReminder().catch(ubolErr);
        return;
    }
    if (alarm?.name === ENTITLEMENT_CHECK_ALARM || alarm?.name === ENTITLEMENT_EXPIRE_ALARM) {
        enforceEntitlement({ verify: true }).catch(ubolErr);
        return;
    }
    if (alarm?.name !== COMMUNITY_ALARM_NAME) { return; }
    if (isEntitled() === false) { return; }
    runCommunitySync();
});
