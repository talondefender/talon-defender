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
    getYouTubeWatchOwnerProfileConfig,
    normalizeYouTubeWatchOwnerProfile,
    YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY,
    YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT,
    YOUTUBE_WATCH_RUNTIME_LANE_DEFAULT,
    YOUTUBE_WATCH_PLAYER_RESPONSE_REWRITE_ENABLED,
    YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT,
    YOUTUBE_WATCH_OWNER_PROFILE_STORAGE_KEY,
    sanitizeBreakageAuditOverrides,
} from './breakage-policy.js';
import {
    normalizeAutoPromotedHostname,
    normalizeSiteKeyHostname,
} from './site-key.js';
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
const REMOTE_COSMETICS_RUNTIME_STATS_KEY = 'remoteCosmeticsRuntimeStatsV1';
const REMOTE_COSMETICS_RUNTIME_STATS_TTL_MS = 24 * 60 * 60 * 1000;
const LIVE_RUNTIME_REFRESH_FILES = Object.freeze([
    '/shared/site-key-resolver.js',
    '/js/scripting/breakage-guard.js',
    '/js/scripting/shadow-dom-helper.js',
    '/js/scripting/remote-cosmetics.js',
    '/js/scripting/remote-tactics-bootstrap.js',
    '/js/scripting/remote-tactics.js',
    '/js/scripting/native-heuristics.js',
    '/js/scripting/automation.js',
    '/js/scripting/post-hide-cleanup.js',
]);
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
let remoteCosmeticsRuntimeStats = {};
let communityEmergencySyncState = {};

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
        browser.alarms?.clear?.(AUTO_BACKOFF_ALARM);
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
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
        browser.alarms?.clear?.(AUTO_PROMOTION_ALARM);
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
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
    chunkCount = 0,
    selectorCount = 0,
    hostSpecificSelectorCount = 0,
    droppedAtApply = 0,
} = {}) => {
    const normalizedHostname = normalizeSiteKeyHostname(hostname);
    if ( normalizedHostname === '' ) { return; }
    await pruneStaleRemoteCosmeticsRuntimeStats();
    remoteCosmeticsRuntimeStats[normalizedHostname] = {
        chunkCount: Math.max(0, Math.floor(Number(chunkCount) || 0)),
        selectorCount: Math.max(0, Math.floor(Number(selectorCount) || 0)),
        hostSpecificSelectorCount: Math.max(0, Math.floor(Number(hostSpecificSelectorCount) || 0)),
        droppedAtApply: Math.max(0, Math.floor(Number(droppedAtApply) || 0)),
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

const isTrustedExtensionSender = sender => {
    const senderId = typeof sender?.id === 'string' ? sender.id : '';
    if (senderId !== '' && senderId !== runtime.id) { return false; }
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
const YOUTUBE_WATCH_BOOTSTRAP_HOST = 'www.youtube.com';
const YOUTUBE_WATCH_BOOTSTRAP_URL = `https://${YOUTUBE_WATCH_BOOTSTRAP_HOST}/watch?v=talon_bootstrap`;
const YOUTUBE_WATCH_BOOTSTRAP_COOKIE_NAME = 'td_yw_boot';
const YOUTUBE_WATCH_REWRITE_MODE_COOKIE_NAME = 'td_yw_rw';
const YOUTUBE_WATCH_RUNTIME_LANE_COOKIE_NAME = 'td_yw_lane';
const YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME = 'td_yw_owner';
const YOUTUBE_WATCH_BOOTSTRAP_COOKIE_SEEDED_KEY = 'youtubeWatchBootstrapCookieSeeded';
const YOUTUBE_WATCH_BOOTSTRAP_COOKIE_TTL_SEC = 365 * 24 * 60 * 60;
const YOUTUBE_FOLLOWUP_COOKIE_CLEAR_NAMES = new Set([
    'GPS',
    'YSC',
    'VISITOR_INFO1_LIVE',
    'VISITOR_PRIVACY_METADATA',
    '__Secure-YNID',
    '__Secure-ROLLOUT_TOKEN',
    'PREF',
]);
const YOUTUBE_FOLLOWUP_TAB_STATE_TTL_MS = 2 * 60 * 1000;
const YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_BASE_ID = 8650000;
const YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_PRIORITY = 3000001;
const YOUTUBE_FOLLOWUP_HEADER_STRIP_TTL_MS = 15000;
const YOUTUBE_FOLLOWUP_NEXT_BLOCK_RULE_BASE_ID = 8651000;
const YOUTUBE_FOLLOWUP_NEXT_BLOCK_RULE_PRIORITY = 3000002;
const YOUTUBE_FOLLOWUP_NEXT_BLOCK_TTL_MS = 30000;
const YOUTUBE_FOLLOWUP_NEUTRAL_HOP_URL = 'about:blank#td-yw-followup-hop';
const YOUTUBE_FOLLOWUP_NEUTRAL_HOP_TTL_MS = 15000;
const YOUTUBE_FOLLOWUP_DONOR_PREFETCH_TIMEOUT_MS = 4000;
const YOUTUBE_FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES = 1024;
const YOUTUBE_FOLLOWUP_ARCHITECTURE_PORT_NAME = 'td-yw-followup-architecture-proof';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A = 'track-a-controlled-entry';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT = 'track-a-same-origin-commit';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM = 'track-a-prewarm-pool';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_INTENT_LEASE = 'track-a-exact-anchor-intent-lease';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER = 'track-a-exact-target-donor-tab-owner';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_B = 'track-b-background-relay';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_RELAY_PAGE = 'options/youtube-followup-relay.html';
const YOUTUBE_FOLLOWUP_ARCHITECTURE_PREWARM_TTL_MS = 60000;
const youtubeWatchTabState = new Map();
const youtubeFollowupHeaderStripTimers = new Map();
const youtubeFollowupNextBlockTimers = new Map();
const youtubeFollowupNeutralHopTargets = new Map();
const youtubeFollowupNeutralHopTimers = new Map();
const youtubeFollowupDonorPrefetches = new Map();
const youtubeFollowupDonorTabs = new Map();
const youtubeFollowupArchitectureJobs = new Map();
const youtubeFollowupArchitectureSubscribers = new Map();
const youtubeFollowupArchitectureCompletedJobs = new Map();
const youtubeFollowupArchitecturePrewarmPool = new Map();

let entitlementStatus = { status: 'trial' };
let paywallActive = false;
let lastCommunityCleanupReason = '';
let communityBaselineSyncInFlight;
let communityBaselineForceQueued = false;
let communityApplyQueue = Promise.resolve();
const communityOverlaySyncInFlight = new Map();

const AUTO_GENERIC_HIGH_KEY = 'autoGenericHighHosts';
const AUTO_GENERIC_HIGH_MAX = 200;
const AUTO_PROMOTE_ENABLED = true;
const MAX_MESSAGE_CSS_LENGTH = 120000;
const MAX_NAVIGATION_URL_LENGTH = 4096;
const MAX_LICENSE_KEY_LENGTH = 512;
const MAX_RULESETS_PER_REQUEST = 256;
const MAX_MODE_HOSTS_PER_LEVEL = 4096;
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

async function computeYouTubeWatchBootstrapEnabled() {
    if ( shouldEnablePaywallForStatus(entitlementStatus) ) { return false; }
    const bootstrapOptIn = await localRead(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY)
        .catch(() => false) === true;
    if ( YOUTUBE_WATCH_BOOTSTRAP_PUBLIC_DEFAULT !== true && bootstrapOptIn !== true ) {
        return false;
    }
    const level = await getFilteringMode(YOUTUBE_WATCH_BOOTSTRAP_HOST);
    return level === MODE_OPTIMAL || level === MODE_COMPLETE;
}

async function getStoredYouTubeWatchBootstrapOptIn() {
    return await localRead(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY).catch(() => false) === true;
}

async function syncYouTubeWatchBootstrapCookie({ forceWrite = false } = {}) {
    if ( browser.cookies?.set === undefined || browser.cookies?.get === undefined ) {
        return false;
    }

    const enabled = await computeYouTubeWatchBootstrapEnabled().catch(( ) => false);
    const nextValue = enabled ? '1' : '0';
    const seeded = await localRead(YOUTUBE_WATCH_BOOTSTRAP_COOKIE_SEEDED_KEY);
    let currentCookie;

    if ( forceWrite === false ) {
        try {
            currentCookie = await browser.cookies.get({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_BOOTSTRAP_COOKIE_NAME,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-bootstrap-cookie/get/${reason}`);
        }
    }

    if ( forceWrite || currentCookie?.value !== nextValue ) {
        try {
            await browser.cookies.set({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_BOOTSTRAP_COOKIE_NAME,
                value: nextValue,
                path: '/watch',
                secure: true,
                sameSite: 'lax',
                expirationDate: Math.floor(Date.now() / 1000) + YOUTUBE_WATCH_BOOTSTRAP_COOKIE_TTL_SEC,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-bootstrap-cookie/set/${reason}`);
        }
    }

    if ( seeded !== true ) {
        await localWrite(YOUTUBE_WATCH_BOOTSTRAP_COOKIE_SEEDED_KEY, true).catch(ubolErr);
    }

    return enabled;
}

async function syncYouTubeWatchRewriteModeCookie({ forceWrite = false } = {}) {
    if ( browser.cookies?.set === undefined || browser.cookies?.get === undefined ) {
        return 'off';
    }

    const bootstrapEnabled = await computeYouTubeWatchBootstrapEnabled().catch(( ) => false);
    const nextValue =
        bootstrapEnabled && YOUTUBE_WATCH_PLAYER_RESPONSE_REWRITE_ENABLED === true
            ? 'player'
            : 'off';
    let currentCookie;

    if ( forceWrite === false ) {
        try {
            currentCookie = await browser.cookies.get({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_REWRITE_MODE_COOKIE_NAME,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-rewrite-cookie/get/${reason}`);
        }
    }

    if ( forceWrite || currentCookie?.value !== nextValue ) {
        try {
            await browser.cookies.set({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_REWRITE_MODE_COOKIE_NAME,
                value: nextValue,
                path: '/watch',
                secure: true,
                sameSite: 'lax',
                expirationDate: Math.floor(Date.now() / 1000) + YOUTUBE_WATCH_BOOTSTRAP_COOKIE_TTL_SEC,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-rewrite-cookie/set/${reason}`);
        }
    }

    return nextValue;
}

async function syncYouTubeWatchRuntimeLaneCookie({ forceWrite = false } = {}) {
    if ( browser.cookies?.set === undefined || browser.cookies?.get === undefined ) {
        return YOUTUBE_WATCH_RUNTIME_LANE_DEFAULT;
    }

    const nextValue =
        typeof YOUTUBE_WATCH_RUNTIME_LANE_DEFAULT === 'string' &&
        YOUTUBE_WATCH_RUNTIME_LANE_DEFAULT !== ''
            ? YOUTUBE_WATCH_RUNTIME_LANE_DEFAULT
            : 'baseline';
    let currentCookie;

    if ( forceWrite === false ) {
        try {
            currentCookie = await browser.cookies.get({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_RUNTIME_LANE_COOKIE_NAME,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-runtime-lane-cookie/get/${reason}`);
        }
    }

    if ( forceWrite || currentCookie?.value !== nextValue ) {
        try {
            await browser.cookies.set({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_RUNTIME_LANE_COOKIE_NAME,
                value: nextValue,
                path: '/watch',
                secure: true,
                sameSite: 'lax',
                expirationDate: Math.floor(Date.now() / 1000) + YOUTUBE_WATCH_BOOTSTRAP_COOKIE_TTL_SEC,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-runtime-lane-cookie/set/${reason}`);
        }
    }

    return nextValue;
}

async function getStoredYouTubeWatchOwnerProfile() {
    const stored = await localRead(YOUTUBE_WATCH_OWNER_PROFILE_STORAGE_KEY).catch(() => null);
    return normalizeYouTubeWatchOwnerProfile(stored);
}

async function syncYouTubeWatchOwnerProfileCookie({ forceWrite = false } = {}) {
    if ( browser.cookies?.set === undefined || browser.cookies?.get === undefined ) {
        return YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT;
    }

    const nextValue = await getStoredYouTubeWatchOwnerProfile();
    let currentCookie;

    if ( forceWrite === false ) {
        try {
            currentCookie = await browser.cookies.get({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-owner-profile-cookie/get/${reason}`);
        }
    }

    if ( forceWrite || currentCookie?.value !== nextValue ) {
        try {
            await browser.cookies.set({
                url: YOUTUBE_WATCH_BOOTSTRAP_URL,
                name: YOUTUBE_WATCH_OWNER_PROFILE_COOKIE_NAME,
                value: nextValue,
                path: '/watch',
                secure: true,
                sameSite: 'lax',
                expirationDate: Math.floor(Date.now() / 1000) + YOUTUBE_WATCH_BOOTSTRAP_COOKIE_TTL_SEC,
            });
        } catch(reason) {
            ubolErr(`youtube-watch-owner-profile-cookie/set/${reason}`);
        }
    }

    return nextValue;
}

async function syncYouTubeWatchControlCookies({ forceWrite = false } = {}) {
    await syncYouTubeWatchBootstrapCookie({ forceWrite }).catch(ubolErr);
    await syncYouTubeWatchRewriteModeCookie({ forceWrite }).catch(ubolErr);
    await syncYouTubeWatchRuntimeLaneCookie({ forceWrite }).catch(ubolErr);
    await syncYouTubeWatchOwnerProfileCookie({ forceWrite }).catch(ubolErr);
}

function isYouTubeFollowupClearCookie(cookie) {
    if ( cookie instanceof Object === false ) { return false; }
    if ( YOUTUBE_FOLLOWUP_COOKIE_CLEAR_NAMES.has(cookie.name) === false ) { return false; }
    const rawDomain = typeof cookie.domain === 'string' ? cookie.domain : '';
    const normalizedDomain = rawDomain.trim().toLowerCase().replace(/^\./, '');
    return normalizedDomain === 'youtube.com' || normalizedDomain.endsWith('.youtube.com');
}

function normalizeCookiePartitionKey(partitionKey) {
    if ( partitionKey instanceof Object && typeof partitionKey.topLevelSite === 'string' ) {
        const normalized = {
            topLevelSite: partitionKey.topLevelSite,
        };
        if ( typeof partitionKey.hasCrossSiteAncestor === 'boolean' ) {
            normalized.hasCrossSiteAncestor = partitionKey.hasCrossSiteAncestor;
        }
        return normalized;
    }
    if ( typeof partitionKey === 'string' && partitionKey !== '' ) {
        return { topLevelSite: partitionKey };
    }
    return null;
}

async function getSenderCookiePartitionKey(sender) {
    if ( browser.cookies?.getPartitionKey === undefined ) { return null; }
    const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
    const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
    if ( tabId === null || tabId < 0 ) { return null; }
    try {
        return normalizeCookiePartitionKey(await browser.cookies.getPartitionKey({
            tabId,
            frameId,
        }));
    } catch(reason) {
        ubolErr(`youtube-followup-cookie-partition-key/${reason}`);
    }
    return null;
}

function youtubeCookieRemovalDetails(cookie, partitionKeyOverride = null) {
    if ( isYouTubeFollowupClearCookie(cookie) === false ) { return []; }
    const normalizedDomain = cookie.domain.trim().toLowerCase().replace(/^\./, '');
    const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/';
    const secure = cookie.secure !== false;
    const baseDetails = {
        name: cookie.name,
    };
    if ( typeof cookie.storeId === 'string' && cookie.storeId !== '' ) {
        baseDetails.storeId = cookie.storeId;
    }
    const partitionKey = normalizeCookiePartitionKey(partitionKeyOverride || cookie.partitionKey);
    if ( partitionKey !== null && cookie.partitionKey !== undefined ) {
        baseDetails.partitionKey = partitionKey;
    }
    const candidateHosts = [ normalizedDomain, YOUTUBE_WATCH_BOOTSTRAP_HOST ]
        .filter(hostname => typeof hostname === 'string' && hostname !== '');
    const uniqueHosts = [];
    const seenHosts = new Set();
    for ( const hostname of candidateHosts ) {
        if ( seenHosts.has(hostname) ) { continue; }
        seenHosts.add(hostname);
        uniqueHosts.push(hostname);
    }
    return uniqueHosts.map(hostname => ({
        ...baseDetails,
        url: `${secure ? 'https' : 'http'}://${hostname}${path}`,
    }));
}

async function clearYouTubeFollowupCookies(partitionKeyOverride = null) {
    if ( browser.cookies?.getAll === undefined || browser.cookies?.remove === undefined ) {
        return { ok: false, removedCount: 0 };
    }
    const cookies = await browser.cookies.getAll({}).catch(( ) => []);
    let removedCount = 0;
    for ( const cookie of cookies ) {
        const detailsList = youtubeCookieRemovalDetails(cookie, partitionKeyOverride);
        if ( detailsList.length === 0 ) { continue; }
        for ( const details of detailsList ) {
            try {
                const removed = await browser.cookies.remove(details);
                if ( removed ) {
                    removedCount += 1;
                    break;
                }
            } catch(reason) {
                ubolErr(`clearYouTubeFollowupCookies/remove/${reason}`);
            }
        }
    }
    return { ok: true, removedCount };
}

function getYouTubeFollowupHeaderStripRuleIds(tabId) {
    const baseId = YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_BASE_ID + (tabId * 4);
    return [ baseId + 1, baseId + 2 ];
}

function getYouTubeFollowupNextBlockRuleIds(tabId) {
    const baseId = YOUTUBE_FOLLOWUP_NEXT_BLOCK_RULE_BASE_ID + (tabId * 4);
    return [ baseId + 1 ];
}

async function clearYouTubeFollowupHeaderStripRules(tabId) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const timer = youtubeFollowupHeaderStripTimers.get(tabId);
    if ( timer !== undefined ) {
        self.clearTimeout(timer);
        youtubeFollowupHeaderStripTimers.delete(tabId);
    }
    if ( browser.declarativeNetRequest?.updateSessionRules === undefined ) {
        return false;
    }
    const removeRuleIds = getYouTubeFollowupHeaderStripRuleIds(tabId);
    try {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds });
        return true;
    } catch(reason) {
        ubolErr(`clearYouTubeFollowupHeaderStripRules/${reason}`);
    }
    return false;
}

async function clearYouTubeFollowupNextBlockRules(tabId) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const timer = youtubeFollowupNextBlockTimers.get(tabId);
    if ( timer !== undefined ) {
        self.clearTimeout(timer);
        youtubeFollowupNextBlockTimers.delete(tabId);
    }
    if ( browser.declarativeNetRequest?.updateSessionRules === undefined ) {
        return false;
    }
    const removeRuleIds = getYouTubeFollowupNextBlockRuleIds(tabId);
    try {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds });
        return true;
    } catch(reason) {
        ubolErr(`clearYouTubeFollowupNextBlockRules/${reason}`);
    }
    return false;
}

async function armYouTubeFollowupHeaderStripRules(tabId) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    if ( browser.declarativeNetRequest?.updateSessionRules === undefined ) {
        return false;
    }
    const [ watchRuleId, nextRuleId ] = getYouTubeFollowupHeaderStripRuleIds(tabId);
    const addRules = [
        {
            id: watchRuleId,
            priority: YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_PRIORITY,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [
                    { header: 'cookie', operation: 'remove' },
                ],
            },
            condition: {
                tabIds: [ tabId ],
                urlFilter: '||www.youtube.com/watch?',
                resourceTypes: [ 'main_frame' ],
            },
        },
        {
            id: nextRuleId,
            priority: YOUTUBE_FOLLOWUP_HEADER_STRIP_RULE_PRIORITY,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [
                    { header: 'cookie', operation: 'remove' },
                ],
            },
            condition: {
                tabIds: [ tabId ],
                urlFilter: '||www.youtube.com/youtubei/v1/next',
                resourceTypes: [ 'xmlhttprequest' ],
            },
        },
    ];
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            addRules,
            removeRuleIds: [ watchRuleId, nextRuleId ],
        });
        const existingTimer = youtubeFollowupHeaderStripTimers.get(tabId);
        if ( existingTimer !== undefined ) {
            self.clearTimeout(existingTimer);
        }
        const timer = self.setTimeout(() => {
            clearYouTubeFollowupHeaderStripRules(tabId).catch(ubolErr);
        }, YOUTUBE_FOLLOWUP_HEADER_STRIP_TTL_MS);
        youtubeFollowupHeaderStripTimers.set(tabId, timer);
        return true;
    } catch(reason) {
        ubolErr(`armYouTubeFollowupHeaderStripRules/${reason}`);
    }
    return false;
}

async function armYouTubeFollowupNextBlockRules(tabId) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    if ( browser.declarativeNetRequest?.updateSessionRules === undefined ) {
        return false;
    }
    const [ nextRuleId ] = getYouTubeFollowupNextBlockRuleIds(tabId);
    const addRules = [
        {
            id: nextRuleId,
            priority: YOUTUBE_FOLLOWUP_NEXT_BLOCK_RULE_PRIORITY,
            action: {
                type: 'block',
            },
            condition: {
                initiatorDomains: [ YOUTUBE_WATCH_BOOTSTRAP_HOST ],
                requestDomains: [ YOUTUBE_WATCH_BOOTSTRAP_HOST ],
                urlFilter: '||www.youtube.com/youtubei/v1/next',
            },
        },
    ];
    try {
        await browser.declarativeNetRequest.updateSessionRules({
            addRules,
            removeRuleIds: [ nextRuleId ],
        });
        const existingTimer = youtubeFollowupNextBlockTimers.get(tabId);
        if ( existingTimer !== undefined ) {
            self.clearTimeout(existingTimer);
        }
        const timer = self.setTimeout(() => {
            clearYouTubeFollowupNextBlockRules(tabId).catch(ubolErr);
        }, YOUTUBE_FOLLOWUP_NEXT_BLOCK_TTL_MS);
        youtubeFollowupNextBlockTimers.set(tabId, timer);
        return true;
    } catch(reason) {
        ubolErr(`armYouTubeFollowupNextBlockRules/${reason}`);
    }
    return false;
}

function clearYouTubeFollowupNeutralHop(tabId) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const timer = youtubeFollowupNeutralHopTimers.get(tabId);
    if ( timer !== undefined ) {
        self.clearTimeout(timer);
        youtubeFollowupNeutralHopTimers.delete(tabId);
    }
    return youtubeFollowupNeutralHopTargets.delete(tabId);
}

function armYouTubeFollowupNeutralHop(tabId, targetUrl) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return false; }
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) { return false; }
    clearYouTubeFollowupNeutralHop(tabId);
    youtubeFollowupNeutralHopTargets.set(tabId, normalizedTargetUrl);
    const timer = self.setTimeout(() => {
        clearYouTubeFollowupNeutralHop(tabId);
    }, YOUTUBE_FOLLOWUP_NEUTRAL_HOP_TTL_MS);
    youtubeFollowupNeutralHopTimers.set(tabId, timer);
    return true;
}

function parseYouTubeWatchVideoId(url) {
    if ( typeof url !== 'string' || url === '' ) { return ''; }
    try {
        const parsed = new URL(url);
        if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
            return '';
        }
        const videoId = parsed.searchParams.get('v');
        return typeof videoId === 'string' ? videoId.trim() : '';
    } catch {
    }
    return '';
}

function normalizeYouTubeFollowupTargetUrl(value) {
    if ( typeof value !== 'string' || value.trim() === '' ) { return ''; }
    try {
        const parsed = new URL(value);
        if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
            return '';
        }
        const videoId = parsed.searchParams.get('v');
        if ( typeof videoId !== 'string' || videoId.trim() === '' ) { return ''; }
        return `${parsed.origin}/watch?v=${videoId.trim()}`;
    } catch {
    }
    return '';
}

function buildYouTubeFollowupDonorUrl(targetUrl, donorToken) {
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' || typeof donorToken !== 'string' || donorToken === '' ) {
        return '';
    }
    try {
        const parsed = new URL(normalizedTargetUrl);
        parsed.hash = `td-yw-donor=${encodeURIComponent(donorToken)}`;
        return parsed.toString();
    } catch {
    }
    return '';
}

function sanitizeYouTubeFollowupPrefetchSections(value) {
    if ( value instanceof Object === false ) { return null; }
    const ytInitialData = value.ytInitialData instanceof Object
        ? JSON.parse(JSON.stringify(value.ytInitialData))
        : null;
    const fullPlayerResponse = value.fullPlayerResponse instanceof Object
        ? JSON.parse(JSON.stringify(value.fullPlayerResponse))
        : null;
    const responseContext = value.responseContext instanceof Object
        ? JSON.parse(JSON.stringify(value.responseContext))
        : null;
    const streamingData = value.streamingData instanceof Object
        ? JSON.parse(JSON.stringify(value.streamingData))
        : null;
    const playbackTracking = value.playbackTracking instanceof Object
        ? JSON.parse(JSON.stringify(value.playbackTracking))
        : null;
    const playerConfig = value.playerConfig instanceof Object
        ? JSON.parse(JSON.stringify(value.playerConfig))
        : null;
    if (
        fullPlayerResponse === null &&
        (streamingData === null || playerConfig === null)
    ) {
        return null;
    }
    return {
        ytInitialData,
        fullPlayerResponse,
        responseContext,
        streamingData,
        playbackTracking,
        playerConfig,
    };
}

function sanitizeYouTubeFollowupBootstrapEnvelope(value) {
    if ( value instanceof Object === false ) { return null; }
    const cloneObject = candidate =>
        candidate instanceof Object
            ? JSON.parse(JSON.stringify(candidate))
            : null;
    let rawPlayerResponse = cloneObject(value.rawPlayerResponse);
    if ( rawPlayerResponse === null && typeof value.rawPlayerResponse === 'string' ) {
        try {
            const parsed = JSON.parse(value.rawPlayerResponse);
            rawPlayerResponse = cloneObject(parsed);
        } catch {}
    }
    return {
        ytcfg: cloneObject(value.ytcfg),
        ytInitialData: cloneObject(value.ytInitialData),
        ytInitialPlayerResponse: cloneObject(value.ytInitialPlayerResponse),
        ytPlayerConfig: cloneObject(value.ytPlayerConfig),
        rawPlayerResponse,
        bootstrapPlayerResponse: cloneObject(value.bootstrapPlayerResponse),
        bootstrapWebPlayerContextConfig: cloneObject(value.bootstrapWebPlayerContextConfig),
        wizGlobalData: cloneObject(value.wizGlobalData),
    };
}

function sanitizeYouTubeFollowupDonorHealth(value) {
    if ( value instanceof Object === false ) { return null; }
    const firstPayloadBytes = Number(value.firstPayloadBytes);
    const firstPayloadSubstantive = value.firstPayloadSubstantive === true;
    const firstPayloadHost = typeof value.firstPayloadHost === 'string'
        ? value.firstPayloadHost.trim()
        : '';
    const adShowing = value.adShowing === true;
    const capturedAt = Number(value.capturedAt);
    return {
        firstPayloadBytes: Number.isFinite(firstPayloadBytes) ? firstPayloadBytes : -1,
        firstPayloadSubstantive,
        firstPayloadHost,
        adShowing,
        capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0,
    };
}

function sanitizeYouTubeFollowupSameOriginCommit(value) {
    if ( value instanceof Object === false ) { return null; }
    const storedAt = Number(value.storedAt);
    const storedBytes = Number(value.storedBytes);
    return {
        storedAt: Number.isFinite(storedAt) ? storedAt : 0,
        writeOk: value.writeOk === true,
        storedBytes: Number.isFinite(storedBytes) ? storedBytes : 0,
        readbackOk: value.readbackOk === true,
        targetMatch: value.targetMatch === true,
    };
}

function isYouTubeFollowupDonorAccepted(sections, health) {
    if ( sections instanceof Object === false ) { return false; }
    if (
        sections.fullPlayerResponse === null &&
        (
            sections.streamingData === null ||
            sections.playerConfig === null
        )
    ) {
        return false;
    }
    if ( health instanceof Object === false ) { return false; }
    if ( health.adShowing === true ) { return false; }
    if ( health.firstPayloadSubstantive === true ) { return true; }
    return health.firstPayloadBytes > YOUTUBE_FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES;
}

function isYouTubeFollowupBootstrapEnvelopeAccepted(envelope) {
    if ( envelope instanceof Object === false ) { return false; }
    return (
        envelope.ytcfg instanceof Object &&
        envelope.ytInitialPlayerResponse instanceof Object &&
        envelope.ytPlayerConfig instanceof Object &&
        envelope.bootstrapWebPlayerContextConfig instanceof Object
    );
}

function isYouTubeFollowupSameOriginCommitAccepted(commit) {
    if ( commit instanceof Object === false ) { return false; }
    return commit.writeOk === true &&
        commit.readbackOk === true &&
        commit.targetMatch === true;
}

function finishYouTubeFollowupDonorPrefetch(donorToken, payload = {}) {
    if ( typeof donorToken !== 'string' || donorToken === '' ) { return false; }
    const entry = youtubeFollowupDonorPrefetches.get(donorToken);
    if ( entry === undefined ) { return false; }
    youtubeFollowupDonorPrefetches.delete(donorToken);
    if ( entry.timeoutId !== undefined ) {
        self.clearTimeout(entry.timeoutId);
    }
    if ( Number.isInteger(entry.donorTabId) ) {
        youtubeFollowupDonorTabs.delete(entry.donorTabId);
        browser.tabs?.remove?.(entry.donorTabId).catch(ignoreRuntimeError);
    }
    try {
        entry.callback(payload instanceof Object ? payload : { ok: false });
    } catch(reason) {
        ubolErr(`finishYouTubeFollowupDonorPrefetch/callback/${reason}`);
    }
    return true;
}

function startYouTubeFollowupDonorPrefetch(tabId, targetUrl, callback) {
    if ( Number.isInteger(tabId) === false || tabId < 0 || typeof callback !== 'function' ) {
        callback({ ok: false });
        return;
    }
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) {
        callback({ ok: false });
        return;
    }
    const donorToken = `tdyw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const donorUrl = buildYouTubeFollowupDonorUrl(normalizedTargetUrl, donorToken);
    if ( donorUrl === '' ) {
        callback({ ok: false });
        return;
    }
    const timeoutId = self.setTimeout(() => {
        finishYouTubeFollowupDonorPrefetch(donorToken, { ok: false, error: 'timeout' });
    }, YOUTUBE_FOLLOWUP_DONOR_PREFETCH_TIMEOUT_MS);
    youtubeFollowupDonorPrefetches.set(donorToken, {
        sourceTabId: tabId,
        targetUrl: normalizedTargetUrl,
        donorTabId: -1,
        callback,
        timeoutId,
    });
    browser.tabs?.create?.({
        url: 'about:blank',
        active: false,
    }).then(async tab => {
        const donorTabId = Number.isInteger(tab?.id) ? tab.id : -1;
        const entry = youtubeFollowupDonorPrefetches.get(donorToken);
        if ( entry === undefined ) { return; }
        if ( donorTabId < 0 ) {
            finishYouTubeFollowupDonorPrefetch(donorToken, { ok: false, error: 'missing-tab-id' });
            return;
        }
        entry.donorTabId = donorTabId;
        youtubeFollowupDonorPrefetches.set(donorToken, entry);
        youtubeFollowupDonorTabs.set(donorTabId, donorToken);
        await Promise.all([
            armYouTubeFollowupHeaderStripRules(donorTabId).catch(reason => {
                ubolErr(`startYouTubeFollowupDonorPrefetch/headerStrip/${reason}`);
                return false;
            }),
            armYouTubeFollowupNextBlockRules(donorTabId).catch(reason => {
                ubolErr(`startYouTubeFollowupDonorPrefetch/nextBlock/${reason}`);
                return false;
            }),
        ]);
        try {
            await browser.tabs?.update?.(donorTabId, { url: donorUrl });
        } catch(reason) {
            ubolErr(`startYouTubeFollowupDonorPrefetch/update/${reason}`);
            finishYouTubeFollowupDonorPrefetch(donorToken, { ok: false, error: `${reason}` });
        }
    }).catch(reason => {
        ubolErr(`startYouTubeFollowupDonorPrefetch/${reason}`);
        finishYouTubeFollowupDonorPrefetch(donorToken, { ok: false, error: `${reason}` });
    });
}

function getYouTubeFollowupArchitecturePrewarmEntry(targetUrl) {
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) { return null; }
    const entry = youtubeFollowupArchitecturePrewarmPool.get(normalizedTargetUrl);
    if ( entry === undefined ) { return null; }
    if (
        entry.status === 'ready' &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt <= Date.now()
    ) {
        const staleEntry = {
            ...entry,
            status: 'stale',
            staleAt: Date.now(),
            entry: null,
        };
        youtubeFollowupArchitecturePrewarmPool.set(normalizedTargetUrl, staleEntry);
        return staleEntry;
    }
    return entry;
}

function storeYouTubeFollowupArchitecturePrewarmResult(jobEntry, payload = {}) {
    if ( jobEntry instanceof Object === false ) { return; }
    if ( jobEntry.strategy !== YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM ) { return; }
    const targetUrl = normalizeYouTubeFollowupTargetUrl(jobEntry.targetUrl);
    if ( targetUrl === '' ) { return; }
    const now = Date.now();
    if ( payload.ok === true && payload.entry instanceof Object ) {
        youtubeFollowupArchitecturePrewarmPool.set(targetUrl, {
            strategy: jobEntry.strategy,
            targetUrl,
            targetVideoId: typeof payload.targetVideoId === 'string'
                ? payload.targetVideoId
                : parseYouTubeWatchVideoId(targetUrl),
            status: 'ready',
            requestedAt: jobEntry.donorStartedAt,
            donorStartedAt: jobEntry.donorStartedAt,
            donorReadyAt: typeof payload.donorReadyAt === 'number' ? payload.donorReadyAt : now,
            createdAt: now,
            expiresAt: now + YOUTUBE_FOLLOWUP_ARCHITECTURE_PREWARM_TTL_MS,
            health: payload.health instanceof Object
                ? JSON.parse(JSON.stringify(payload.health))
                : null,
            entry: JSON.parse(JSON.stringify(payload.entry)),
        });
        return;
    }
    youtubeFollowupArchitecturePrewarmPool.set(targetUrl, {
        strategy: jobEntry.strategy,
        targetUrl,
        targetVideoId: parseYouTubeWatchVideoId(targetUrl),
        status: payload.error === 'stale' ? 'stale' : 'failed',
        requestedAt: jobEntry.donorStartedAt,
        donorStartedAt: jobEntry.donorStartedAt,
        donorReadyAt: null,
        createdAt: now,
        expiresAt: now + YOUTUBE_FOLLOWUP_ARCHITECTURE_PREWARM_TTL_MS,
        staleAt: payload.error === 'stale' ? now : null,
        error: typeof payload.error === 'string' ? payload.error : 'prewarm-failed',
        entry: null,
    });
}

function consumeYouTubeFollowupArchitecturePrewarmEntry(targetUrl) {
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) {
        return {
            ok: false,
            error: 'invalid-target-url',
            targetUrl: '',
            prewarmStatus: 'miss',
            predictionHit: false,
            predictionMiss: true,
            staleEntry: false,
        };
    }
    const poolEntry = getYouTubeFollowupArchitecturePrewarmEntry(normalizedTargetUrl);
    if ( poolEntry === null ) {
        return {
            ok: false,
            error: 'prewarm-miss',
            targetUrl: normalizedTargetUrl,
            prewarmStatus: 'miss',
            predictionHit: false,
            predictionMiss: true,
            staleEntry: false,
            prewarmRequested: false,
        };
    }
    if ( poolEntry.status === 'ready' && poolEntry.entry instanceof Object ) {
        const consumedAt = Date.now();
        youtubeFollowupArchitecturePrewarmPool.set(normalizedTargetUrl, {
            ...poolEntry,
            status: 'consumed',
            consumedAt,
            entry: null,
        });
        return {
            ok: true,
            targetUrl: normalizedTargetUrl,
            targetVideoId: poolEntry.targetVideoId,
            donorStartedAt: poolEntry.donorStartedAt,
            donorReadyAt: poolEntry.donorReadyAt,
            prewarmStatus: 'hit',
            predictionHit: true,
            predictionMiss: false,
            staleEntry: false,
            prewarmRequested: true,
            prewarmEntryCreatedAt: poolEntry.createdAt,
            prewarmEntryAgeMs:
                Number.isFinite(poolEntry.createdAt) ? consumedAt - poolEntry.createdAt : null,
            entry: JSON.parse(JSON.stringify(poolEntry.entry)),
        };
    }
    return {
        ok: false,
        error:
            typeof poolEntry.error === 'string' && poolEntry.error !== ''
                ? poolEntry.error
                : poolEntry.status === 'stale'
                    ? 'stale'
                    : 'prewarm-miss',
        targetUrl: normalizedTargetUrl,
        targetVideoId: poolEntry.targetVideoId || parseYouTubeWatchVideoId(normalizedTargetUrl),
        donorStartedAt: Number.isFinite(poolEntry.donorStartedAt) ? poolEntry.donorStartedAt : null,
        donorReadyAt: Number.isFinite(poolEntry.donorReadyAt) ? poolEntry.donorReadyAt : null,
        prewarmStatus: poolEntry.status === 'stale' ? 'stale' : 'miss',
        predictionHit: false,
        predictionMiss: poolEntry.status !== 'stale',
        staleEntry: poolEntry.status === 'stale',
        prewarmRequested: true,
        prewarmEntryCreatedAt:
            Number.isFinite(poolEntry.createdAt) ? poolEntry.createdAt : null,
        prewarmEntryAgeMs:
            Number.isFinite(poolEntry.createdAt) ? Date.now() - poolEntry.createdAt : null,
    };
}

function isYouTubeFollowupArchitectureStrategy(value) {
    return value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A ||
        value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT ||
        value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM ||
        value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_INTENT_LEASE ||
        value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER ||
        value === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_B;
}

function findYouTubeFollowupArchitectureJobBySource(sourceTabId, strategy, targetUrl) {
    if ( Number.isInteger(sourceTabId) === false || sourceTabId < 0 ) { return null; }
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) { return null; }
    for ( const [token, entry] of youtubeFollowupArchitectureJobs ) {
        if ( entry instanceof Object === false ) { continue; }
        if ( entry.sourceTabId !== sourceTabId ) { continue; }
        if ( entry.strategy !== strategy ) { continue; }
        if ( entry.targetUrl !== normalizedTargetUrl ) { continue; }
        return {
            token,
            entry,
        };
    }
    return null;
}

function findYouTubeFollowupCompletedArchitectureJobBySource(sourceTabId, strategy, targetUrl) {
    if ( Number.isInteger(sourceTabId) === false || sourceTabId < 0 ) { return null; }
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) { return null; }
    for ( const [token, payload] of youtubeFollowupArchitectureCompletedJobs ) {
        if ( payload instanceof Object === false ) { continue; }
        if ( payload.sourceTabId !== sourceTabId ) { continue; }
        if ( payload.strategy !== strategy ) { continue; }
        if ( payload.targetUrl !== normalizedTargetUrl ) { continue; }
        return {
            token,
            payload,
        };
    }
    return null;
}

function takeYouTubeFollowupCompletedArchitectureJobBySource(sourceTabId, strategy, targetUrl) {
    const match = findYouTubeFollowupCompletedArchitectureJobBySource(
        sourceTabId,
        strategy,
        targetUrl
    );
    if ( match === null ) { return null; }
    youtubeFollowupArchitectureCompletedJobs.delete(match.token);
    return match;
}

function buildYouTubeFollowupArchitectureRelayUrl(token) {
    if ( typeof token !== 'string' || token === '' ) { return ''; }
    try {
        return runtime.getURL(`${YOUTUBE_FOLLOWUP_ARCHITECTURE_RELAY_PAGE}#token=${encodeURIComponent(token)}`);
    } catch {
    }
    return '';
}

function postArchitectureJobUpdate(token, payload) {
    const subscribers = youtubeFollowupArchitectureSubscribers.get(token);
    if ( subscribers instanceof Set === false || subscribers.size === 0 ) { return; }
    for ( const port of Array.from(subscribers) ) {
        try {
            port.postMessage(payload);
        } catch {
            subscribers.delete(port);
        }
    }
    if ( subscribers.size === 0 ) {
        youtubeFollowupArchitectureSubscribers.delete(token);
    }
}

function detachArchitectureSubscriber(port) {
    for ( const [token, subscribers] of youtubeFollowupArchitectureSubscribers ) {
        if ( subscribers.has(port) === false ) { continue; }
        subscribers.delete(port);
        if ( subscribers.size === 0 ) {
            youtubeFollowupArchitectureSubscribers.delete(token);
        }
    }
}

function attachArchitectureSubscriber(token, port) {
    if ( typeof token !== 'string' || token === '' || port == null ) { return; }
    const existing = youtubeFollowupArchitectureSubscribers.get(token) || new Set();
    existing.add(port);
    youtubeFollowupArchitectureSubscribers.set(token, existing);
}

function finishYouTubeFollowupArchitectureJob(token, payload = {}) {
    if ( typeof token !== 'string' || token === '' ) { return false; }
    const entry = youtubeFollowupArchitectureJobs.get(token);
    if ( entry === undefined ) { return false; }
    storeYouTubeFollowupArchitecturePrewarmResult(entry, payload);
    youtubeFollowupArchitectureJobs.delete(token);
    if ( entry.timeoutId !== undefined ) {
        self.clearTimeout(entry.timeoutId);
    }
    if ( Number.isInteger(entry.donorTabId) ) {
        youtubeFollowupDonorTabs.delete(entry.donorTabId);
        browser.tabs?.remove?.(entry.donorTabId).catch(ignoreRuntimeError);
    }
    const result = payload instanceof Object ? payload : { ok: false };
    const finalPayload = {
        requestId: entry.requestId,
        token,
        sourceTabId: entry.sourceTabId,
        targetUrl: entry.targetUrl,
        strategy: entry.strategy,
        donorStartedAt: entry.donorStartedAt,
        ...result,
        done: true,
    };
    youtubeFollowupArchitectureCompletedJobs.set(token, finalPayload);
    postArchitectureJobUpdate(token, finalPayload);
    return true;
}

function startYouTubeFollowupArchitectureJob(sourceTabId, strategy, targetUrl, requestId = '') {
    if ( Number.isInteger(sourceTabId) === false || sourceTabId < 0 ) {
        return { ok: false, error: 'missing-tab-id' };
    }
    if ( isYouTubeFollowupArchitectureStrategy(strategy) === false ) {
        return { ok: false, error: 'invalid-strategy' };
    }
    const normalizedTargetUrl = normalizeYouTubeFollowupTargetUrl(targetUrl);
    if ( normalizedTargetUrl === '' ) {
        return { ok: false, error: 'invalid-target-url' };
    }
    const donorToken = `tdyw-proof-${
        strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A
            ? 'a'
            : strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT
                ? 'ac'
            : strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM
                ? 'ap'
                : strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_INTENT_LEASE
                    ? 'a1'
                    : strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER
                        ? 'a2'
                : 'b'
    }-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const donorUrl = buildYouTubeFollowupDonorUrl(normalizedTargetUrl, donorToken);
    if ( donorUrl === '' ) {
        return { ok: false, error: 'invalid-donor-url' };
    }
    const timeoutId = self.setTimeout(() => {
        finishYouTubeFollowupArchitectureJob(donorToken, {
            ok: false,
            error: 'timeout',
            timedOut: true,
        });
    }, YOUTUBE_FOLLOWUP_DONOR_PREFETCH_TIMEOUT_MS);
    const donorStartedAt = Date.now();
    youtubeFollowupArchitectureJobs.set(donorToken, {
        requestId,
        sourceTabId,
        strategy,
        targetUrl: normalizedTargetUrl,
        donorTabId: -1,
        timeoutId,
        donorStartedAt,
    });
    browser.tabs?.create?.({
        url: 'about:blank',
        active: false,
    }).then(async tab => {
        const donorTabId = Number.isInteger(tab?.id) ? tab.id : -1;
        const entry = youtubeFollowupArchitectureJobs.get(donorToken);
        if ( entry === undefined ) { return; }
        if ( donorTabId < 0 ) {
            finishYouTubeFollowupArchitectureJob(donorToken, { ok: false, error: 'missing-donor-tab-id' });
            return;
        }
        entry.donorTabId = donorTabId;
        youtubeFollowupArchitectureJobs.set(donorToken, entry);
        youtubeFollowupDonorTabs.set(donorTabId, donorToken);
        await Promise.all([
            armYouTubeFollowupHeaderStripRules(donorTabId).catch(reason => {
                ubolErr(`startYouTubeFollowupArchitectureJob/headerStrip/${reason}`);
                return false;
            }),
            armYouTubeFollowupNextBlockRules(donorTabId).catch(reason => {
                ubolErr(`startYouTubeFollowupArchitectureJob/nextBlock/${reason}`);
                return false;
            }),
        ]);
        try {
            await browser.tabs?.update?.(donorTabId, { url: donorUrl });
        } catch(reason) {
            ubolErr(`startYouTubeFollowupArchitectureJob/update/${reason}`);
            finishYouTubeFollowupArchitectureJob(donorToken, { ok: false, error: `${reason}` });
        }
    }).catch(reason => {
        ubolErr(`startYouTubeFollowupArchitectureJob/${reason}`);
        finishYouTubeFollowupArchitectureJob(donorToken, { ok: false, error: `${reason}` });
    });
    return {
        ok: true,
        token: donorToken,
        relayUrl:
            strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_B
                ? buildYouTubeFollowupArchitectureRelayUrl(donorToken)
                : '',
        donorStartedAt,
        targetUrl: normalizedTargetUrl,
        strategy,
    };
}

function syncYouTubeWatchTabState(tabId, url) {
    if ( Number.isInteger(tabId) === false || tabId < 0 ) { return; }
    const videoId = parseYouTubeWatchVideoId(url);
    if ( videoId === '' ) { return; }
    youtubeWatchTabState.set(tabId, {
        videoId,
        seenAt: Date.now(),
    });
}

async function maybeClearYouTubeFollowupCookiesForNavigation(details) {
    if ( details?.frameId !== 0 ) { return; }
    const tabId = Number.isInteger(details?.tabId) ? details.tabId : -1;
    if ( tabId < 0 ) { return; }
    const nextVideoId = parseYouTubeWatchVideoId(details?.url || '');
    if ( nextVideoId === '' ) { return; }
    const previousEntry = youtubeWatchTabState.get(tabId);
    const previousVideoId = typeof previousEntry?.videoId === 'string'
        ? previousEntry.videoId
        : '';
    const seenAt = Number.isFinite(previousEntry?.seenAt) ? previousEntry.seenAt : 0;
    if ( previousVideoId !== '' && (Date.now() - seenAt) > YOUTUBE_FOLLOWUP_TAB_STATE_TTL_MS ) {
        youtubeWatchTabState.delete(tabId);
        return;
    }
    if ( previousVideoId === '' || previousVideoId === nextVideoId ) { return; }
    await Promise.all([
        clearYouTubeFollowupCookies().catch(reason => {
            ubolErr(`maybeClearYouTubeFollowupCookiesForNavigation/cookies/${reason}`);
        }),
        armYouTubeFollowupHeaderStripRules(tabId).catch(reason => {
            ubolErr(`maybeClearYouTubeFollowupCookiesForNavigation/headerStrip/${reason}`);
        }),
        armYouTubeFollowupNextBlockRules(tabId).catch(reason => {
            ubolErr(`maybeClearYouTubeFollowupCookiesForNavigation/nextBlock/${reason}`);
        }),
    ]);
}

async function setDefaultFilteringMode(afterLevel) {
    const out = await setDefaultFilteringModeRaw(afterLevel);
    await syncYouTubeWatchControlCookies().catch(ubolErr);
    return out;
}

if ( chrome.webNavigation?.onBeforeNavigate ) {
    chrome.webNavigation.onBeforeNavigate.addListener(details => {
        maybeClearYouTubeFollowupCookiesForNavigation(details).catch(ubolErr);
    });
}

if ( chrome.webNavigation?.onCommitted ) {
    chrome.webNavigation.onCommitted.addListener(details => {
        if ( details?.frameId !== 0 ) { return; }
        const pendingTargetUrl = youtubeFollowupNeutralHopTargets.get(details.tabId);
        if ( typeof pendingTargetUrl === 'string' && pendingTargetUrl !== '' ) {
            if ( details.url === YOUTUBE_FOLLOWUP_NEUTRAL_HOP_URL ) {
                clearYouTubeFollowupNeutralHop(details.tabId);
                browser.tabs?.update?.(details.tabId, { url: pendingTargetUrl }).catch(reason => {
                    ubolErr(`youtubeFollowupNeutralHop/update/${reason}`);
                });
                return;
            }
            if ( normalizeYouTubeFollowupTargetUrl(details.url || '') === pendingTargetUrl ) {
                clearYouTubeFollowupNeutralHop(details.tabId);
            }
        }
        syncYouTubeWatchTabState(details.tabId, details.url || '');
    });
}

if ( browser.tabs?.onRemoved ) {
    browser.tabs.onRemoved.addListener(tabId => {
        youtubeWatchTabState.delete(tabId);
        clearYouTubeFollowupHeaderStripRules(tabId).catch(ubolErr);
        clearYouTubeFollowupNextBlockRules(tabId).catch(ubolErr);
        clearYouTubeFollowupNeutralHop(tabId);
        const donorToken = youtubeFollowupDonorTabs.get(tabId);
        if ( typeof donorToken === 'string' && donorToken !== '' ) {
            if ( youtubeFollowupArchitectureJobs.has(donorToken) ) {
                finishYouTubeFollowupArchitectureJob(donorToken, { ok: false, error: 'tab-removed' });
            } else {
                finishYouTubeFollowupDonorPrefetch(donorToken, { ok: false, error: 'tab-removed' });
            }
        }
    });
}

async function setFilteringMode(hostname, afterLevel) {
    const out = await setFilteringModeRaw(hostname, afterLevel);
    await syncYouTubeWatchControlCookies().catch(ubolErr);
    return out;
}

async function setFilteringModeDetails(details) {
    const out = await setFilteringModeDetailsRaw(details);
    await syncYouTubeWatchControlCookies().catch(ubolErr);
    return out;
}

async function syncWithBrowserPermissions() {
    const out = await syncWithBrowserPermissionsRaw();
    await syncYouTubeWatchControlCookies().catch(ubolErr);
    return out;
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

function stopLiveRuntimeControllers() {
    const controllerTargets = [
        [ 'TalonRemoteCosmeticsController', [ 'stop', 'clear' ] ],
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

async function refreshRuntimeStateForTab(tabId, filteringLevel) {
    if ( browser.scripting?.executeScript === undefined ) { return false; }
    try {
        if ( filteringLevel >= MODE_OPTIMAL ) {
            await browser.scripting.executeScript({
                files: LIVE_RUNTIME_REFRESH_FILES,
                target: { tabId },
            });
            return true;
        }
        await browser.scripting.executeScript({
            func: stopLiveRuntimeControllers,
            target: { tabId },
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
                .then(level => refreshRuntimeStateForTab(tabId, Number(level) || MODE_NONE))
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

async function syncInjectablesAndRefreshTabs({ runtimeOnly = false } = {}) {
    if ( isEntitled() === false ) { return false; }
    if ( runtimeOnly !== true ) {
        await registerInjectablesIfEntitled().catch(ubolErr);
    }
    await refreshRuntimeStateForOpenTabs().catch(ubolErr);
    return true;
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
            const restoreResult = await registerInjectablesIfEntitled().catch(reason => ({
                ok: false,
                lastError: String(reason || 'rollback injectable restore failed'),
            }));
            if ( restoreResult instanceof Object && restoreResult.ok !== true ) {
                await appendCommunitySyncError(
                    `rollback injectable restore failed: ${describeInjectableFailure(restoreResult)}`
                );
            }
            await refreshRuntimeStateForOpenTabs().catch(ubolErr);
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
                const injectableResult = await registerInjectablesIfEntitled();
                if (
                    injectableResult instanceof Object
                        ? injectableResult.ok !== true
                        : injectableResult !== true
                ) {
                    return rollbackActivation(describeInjectableFailure(injectableResult));
                }
                await refreshRuntimeStateForOpenTabs().catch(ubolErr);
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
    await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);
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
    await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);
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

async function applyEntitlementStatusEffects(
    status,
    {
        broadcast = true,
        paywallWasActive = paywallActive,
        previousStatus = entitlementStatus,
        registerInjectablesOnEntitled = true,
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
        await registerInjectablesIfEntitled().catch(ubolErr);
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

const AUTO_ANNOYANCES_BASELINE_KEY = 'autoAnnoyancesBaselineRulesets';
const AUTO_ANNOYANCES_DISABLED_KEY = 'autoAnnoyancesDisabledInComplete';

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
    ensureAnnoyancesForCompleteDefault().catch(ubolErr);
    registerInjectablesIfEntitled().catch(ubolErr);
    return true;
}

// https://github.com/uBlockOrigin/uBOL-home/issues/280
async function onPermissionsAdded(permissions) {
    const details = pendingPermissionRequest;
    pendingPermissionRequest = undefined;
    if (details === undefined) {
        const modified = await syncWithBrowserPermissions();
        if (modified === false) { return; }
        ensureAnnoyancesForCompleteDefault().catch(ubolErr);
        return Promise.all([
            updateSessionRules(),
            registerInjectablesIfEntitled(),
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
    await registerInjectablesIfEntitled();
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
        await registerInjectablesIfEntitled().catch(ubolErr);
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

        case 'recordRemoteCosmeticsRuntimeStats': {
            if ( isEntitled() === false ) { return false; }
            recordRemoteCosmeticsRuntimeStats({
                hostname: request.hostname,
                chunkCount: request.chunkCount,
                selectorCount: request.selectorCount,
                hostSpecificSelectorCount: request.hostSpecificSelectorCount,
                droppedAtApply: request.droppedAtApply,
            }).catch(ubolErr);
            return false;
        }

        case 'prefetchYouTubeFollowupPlayerResponseSections': {
            const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
            const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
            const targetUrl = normalizeYouTubeFollowupTargetUrl(request.targetUrl);
            if ( tabId < 0 || targetUrl === '' ) {
                callback({ ok: false });
                return false;
            }
            try {
                const parsed = new URL(senderUrl);
                if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
                    callback({ ok: false });
                    return false;
                }
            } catch {
                callback({ ok: false });
                return false;
            }
            startYouTubeFollowupDonorPrefetch(tabId, targetUrl, callback);
            return true;
        }

        case 'completeYouTubeFollowupPrefetchDonor': {
            const donorToken = typeof request.donorToken === 'string'
                ? request.donorToken.trim()
                : '';
            const sections = sanitizeYouTubeFollowupPrefetchSections(request.sections);
            const bootstrapEnvelope = sanitizeYouTubeFollowupBootstrapEnvelope(
                request.bootstrapEnvelope
            );
            const health = sanitizeYouTubeFollowupDonorHealth(request.health);
            const sameOriginCommit = sanitizeYouTubeFollowupSameOriginCommit(
                request.sameOriginCommit
            );
            const targetUrl = normalizeYouTubeFollowupTargetUrl(request.targetUrl);
            const targetVideoId = typeof request.targetVideoId === 'string'
                ? request.targetVideoId.trim()
                : '';
            if ( donorToken === '' || sections === null ) {
                callback({ ok: false });
                return false;
            }
            const architectureEntry = youtubeFollowupArchitectureJobs.get(donorToken);
            if ( architectureEntry !== undefined ) {
                const senderTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
                if ( senderTabId < 0 || architectureEntry.donorTabId !== senderTabId ) {
                    callback({ ok: false });
                    return false;
                }
                const commitRequired =
                    architectureEntry.strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT;
                const commitAccepted =
                    isYouTubeFollowupSameOriginCommitAccepted(sameOriginCommit);
                if (
                    isYouTubeFollowupDonorAccepted(sections, health) === false ||
                    isYouTubeFollowupBootstrapEnvelopeAccepted(bootstrapEnvelope) === false ||
                    (commitRequired && commitAccepted === false)
                ) {
                    finishYouTubeFollowupArchitectureJob(donorToken, {
                        ok: false,
                        error:
                            commitRequired && commitAccepted === false
                                ? 'same-origin-commit-failed'
                                : 'donor-rejected',
                        targetVideoId,
                        health,
                        sameOriginCommit,
                        hasBootstrapEnvelope:
                            isYouTubeFollowupBootstrapEnvelopeAccepted(bootstrapEnvelope),
                    });
                    callback({
                        ok: false,
                        error:
                            commitRequired && commitAccepted === false
                                ? 'same-origin-commit-failed'
                                : 'donor-rejected',
                    });
                    return false;
                }
                finishYouTubeFollowupArchitectureJob(donorToken, {
                    ok: true,
                    targetVideoId,
                    donorReadyAt: Date.now(),
                    health,
                    sameOriginCommit,
                    entry: {
                        kind: 'td-yw-architecture-envelope',
                        strategy: architectureEntry.strategy,
                        handoffSurface:
                            architectureEntry.strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_B
                                ? 'windowName'
                                : architectureEntry.strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT
                                    ? 'localStorage'
                                    : 'sessionStorage',
                        targetUrl: architectureEntry.targetUrl,
                        targetVideoId,
                        prefetchedAt: Date.now(),
                        sections,
                        bootstrapEnvelope,
                        health,
                    },
                });
                callback({ ok: true });
                return false;
            }
            const entry = youtubeFollowupDonorPrefetches.get(donorToken);
            const senderTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
            if ( entry === undefined || senderTabId < 0 || entry.donorTabId !== senderTabId ) {
                callback({ ok: false });
                return false;
            }
            if (
                isYouTubeFollowupDonorAccepted(sections, health) === false ||
                isYouTubeFollowupBootstrapEnvelopeAccepted(bootstrapEnvelope) === false
            ) {
                finishYouTubeFollowupDonorPrefetch(donorToken, {
                    ok: false,
                    error: 'donor-rejected',
                    targetUrl,
                    targetVideoId,
                    health,
                    hasBootstrapEnvelope:
                        isYouTubeFollowupBootstrapEnvelopeAccepted(bootstrapEnvelope),
                });
                callback({ ok: false, error: 'donor-rejected' });
                return false;
            }
            finishYouTubeFollowupDonorPrefetch(donorToken, {
                ok: true,
                targetUrl,
                targetVideoId,
                sections,
                bootstrapEnvelope,
                health,
            });
            callback({ ok: true });
            return false;
        }

        case 'clearYouTubeFollowupCookies': {
            const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
            const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
            const targetUrl = normalizeYouTubeFollowupTargetUrl(request.targetUrl);
            try {
                const parsed = new URL(senderUrl);
                if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
                    callback({ ok: false, removedCount: 0 });
                    return false;
                }
            } catch {
                callback({ ok: false, removedCount: 0 });
                return false;
            }
            Promise.all([
                getSenderCookiePartitionKey(sender).then(partitionKey => {
                    return clearYouTubeFollowupCookies(partitionKey);
                }).catch(reason => {
                    ubolErr(`clearYouTubeFollowupCookies/partitioned/${reason}`);
                    return { ok: false, removedCount: 0 };
                }),
                armYouTubeFollowupHeaderStripRules(tabId).catch(reason => {
                    ubolErr(`clearYouTubeFollowupCookies/armHeaderStrip/${reason}`);
                    return false;
                }),
                armYouTubeFollowupNextBlockRules(tabId).catch(reason => {
                    ubolErr(`clearYouTubeFollowupCookies/armNextBlock/${reason}`);
                    return false;
                }),
            ]).then(([ cookieResult, headerStripArmed, nextBlockArmed ]) => {
                const neutralHopArmed = targetUrl !== ''
                    ? armYouTubeFollowupNeutralHop(tabId, targetUrl)
                    : false;
                callback({
                    ...(cookieResult instanceof Object ? cookieResult : { ok: false, removedCount: 0 }),
                    ok: targetUrl !== ''
                        ? neutralHopArmed === true
                        : (headerStripArmed === true || nextBlockArmed === true),
                    headerStripArmed: headerStripArmed === true,
                    nextBlockArmed: nextBlockArmed === true,
                    neutralHopArmed: neutralHopArmed === true,
                    neutralHopUrl: neutralHopArmed === true ? YOUTUBE_FOLLOWUP_NEUTRAL_HOP_URL : '',
                });
            }).catch(reason => {
                ubolErr(`clearYouTubeFollowupCookies/${reason}`);
                callback({ ok: false, removedCount: 0 });
            });
            return true;
        }

        case 'releaseYouTubeFollowupNextBlock': {
            const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
            const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
            try {
                const parsed = new URL(senderUrl);
                if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
                    callback({ ok: false });
                    return false;
                }
            } catch {
                callback({ ok: false });
                return false;
            }
            clearYouTubeFollowupNextBlockRules(tabId).then(cleared => {
                callback({ ok: cleared === true });
            }).catch(reason => {
                ubolErr(`releaseYouTubeFollowupNextBlock/${reason}`);
                callback({ ok: false });
            });
            return true;
        }

        case 'navigateYouTubeFollowupWatch': {
            const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
            const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : -1;
            const targetUrl = normalizeYouTubeFollowupTargetUrl(request.targetUrl);
            if ( tabId < 0 || targetUrl === '' ) {
                callback({ ok: false });
                return false;
            }
            try {
                const parsed = new URL(senderUrl);
                if ( parsed.hostname !== YOUTUBE_WATCH_BOOTSTRAP_HOST || parsed.pathname !== '/watch' ) {
                    callback({ ok: false });
                    return false;
                }
            } catch {
                callback({ ok: false });
                return false;
            }
            Promise.all([
                armYouTubeFollowupHeaderStripRules(tabId).catch(reason => {
                    ubolErr(`navigateYouTubeFollowupWatch/headerStrip/${reason}`);
                    return false;
                }),
                armYouTubeFollowupNextBlockRules(tabId).catch(reason => {
                    ubolErr(`navigateYouTubeFollowupWatch/nextBlock/${reason}`);
                    return false;
                }),
            ]).then(() => {
                return browser.tabs?.update?.(tabId, { url: targetUrl });
            }).then(tab => {
                callback({ ok: Boolean(tab), targetUrl });
            }).catch(reason => {
                ubolErr(`navigateYouTubeFollowupWatch/${reason}`);
                callback({ ok: false });
            });
            return true;
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

        case 'setYouTubeWatchOwnerProfile': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            const profile = normalizeYouTubeWatchOwnerProfile(request.profile);
            localWrite(YOUTUBE_WATCH_OWNER_PROFILE_STORAGE_KEY, profile).then(async () => {
                await syncYouTubeWatchOwnerProfileCookie({ forceWrite: true }).catch(ubolErr);
                await registerInjectablesIfEntitled().catch(ubolErr);
                callback({
                    profile,
                    config: getYouTubeWatchOwnerProfileConfig(profile),
                });
            }).catch(reason => {
                ubolErr(`setYouTubeWatchOwnerProfile/${reason}`);
                callback({
                    profile: YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT,
                    config: getYouTubeWatchOwnerProfileConfig(YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT),
                });
            });
            return true;
        }

        case 'setYouTubeWatchBootstrapEnabled': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            const enabled = request.enabled === true;
            const updateBootstrapOverride = enabled
                ? localWrite(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY, true)
                : localRemove(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY);
            updateBootstrapOverride.then(async () => {
                await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);
                await registerInjectablesIfEntitled().catch(ubolErr);
                callback({
                    enabled: await computeYouTubeWatchBootstrapEnabled().catch(() => false),
                    optIn: await getStoredYouTubeWatchBootstrapOptIn(),
                });
            }).catch(reason => {
                ubolErr(`setYouTubeWatchBootstrapEnabled/${reason}`);
                callback({
                    enabled: false,
                    optIn: false,
                });
            });
            return true;
        }

        case 'clearYouTubeWatchBootstrapOverride': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            localRemove(YOUTUBE_WATCH_BOOTSTRAP_OPT_IN_STORAGE_KEY).then(async () => {
                await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);
                await registerInjectablesIfEntitled().catch(ubolErr);
                callback({
                    enabled: await computeYouTubeWatchBootstrapEnabled().catch(() => false),
                    optIn: await getStoredYouTubeWatchBootstrapOptIn(),
                });
            }).catch(reason => {
                ubolErr(`clearYouTubeWatchBootstrapOverride/${reason}`);
                callback({
                    enabled: false,
                    optIn: false,
                });
            });
            return true;
        }

        case 'clearYouTubeWatchOwnerProfile': {
            if (rulesetConfig.developerMode !== true && isTrustedExtensionSender(sender) === false) {
                return false;
            }
            localRemove(YOUTUBE_WATCH_OWNER_PROFILE_STORAGE_KEY).then(async () => {
                await syncYouTubeWatchOwnerProfileCookie({ forceWrite: true }).catch(ubolErr);
                await registerInjectablesIfEntitled().catch(ubolErr);
                const profile = YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT;
                callback({
                    profile,
                    config: getYouTubeWatchOwnerProfileConfig(profile),
                });
            }).catch(reason => {
                ubolErr(`clearYouTubeWatchOwnerProfile/${reason}`);
                const profile = YOUTUBE_WATCH_OWNER_PROFILE_DEFAULT;
                callback({
                    profile,
                    config: getYouTubeWatchOwnerProfileConfig(profile),
                });
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
                getStoredYouTubeWatchBootstrapOptIn(),
                computeYouTubeWatchBootstrapEnabled(),
                getStoredYouTubeWatchOwnerProfile(),
                localRead(AUTO_BACKOFF_EVIDENCE_STORAGE_KEY),
                dnr.getEnabledRulesets(),
                getRegisteredContentScriptsAuditSnapshot(),
            ]).then(([
                overrides,
                youtubeWatchBootstrapOptIn,
                youtubeWatchBootstrapEnabled,
                youtubeOwnerProfile,
                evidence,
                enabledRulesets,
                registeredContentScripts,
            ]) => {
                callback({
                    overrides: overrides || { global: {}, hosts: {} },
                    youtubeWatchBootstrapOptIn,
                    youtubeWatchBootstrapEnabled,
                    youtubeOwnerProfile,
                    youtubeOwnerConfig: getYouTubeWatchOwnerProfileConfig(youtubeOwnerProfile),
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
                rulesetConfig.enabledRulesets = result.enabledRulesets;
                return syncRegionalRulesetOptOutState(result.enabledRulesets).then(() =>
                    saveRulesetConfig()
                ).then(() => {
                    return registerInjectablesIfEntitled();
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
            Promise.all([
                hasBroadHostPermissions(),
                getDefaultFilteringMode(),
                getRulesetDetails(),
                dnr.getEnabledRulesets(),
                getAdminRulesets(),
                adminReadEx('disabledFeatures'),
            ]).then(results => {
                const [
                    hasOmnipotence,
                    defaultFilteringMode,
                    rulesetDetails,
                    enabledRulesets,
                    adminRulesets,
                    disabledFeatures,
                ] = results;
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
            });
            return true;

        case 'getEnabledRulesets':
            dnr.getEnabledRulesets().then(rulesets => {
                callback(rulesets);
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
            Promise.all([
                hasBroadHostPermissions(),
                getFilteringMode(request.hostname),
                adminReadEx('disabledFeatures'),
                hasCustomFilters(request.hostname),
            ]).then(results => {
                callback({
                    hasOmnipotence: results[0],
                    level: results[1],
                    autoReload: rulesetConfig.autoReload,
                    isSideloaded,
                    developerMode: rulesetConfig.developerMode,
                    disabledFeatures: results[2],
                    hasCustomFilters: results[3],
                });
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
                return registerInjectablesIfEntitled()
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
                }).catch(ubolErr);
                const stored = await readEntitlement();
                callback(Object.assign({}, status, {
                    lastError: typeof stored.lastError === 'string' ? stored.lastError : '',
                    lastErrorCode: typeof stored.lastErrorCode === 'string' ? stored.lastErrorCode : '',
                    lastErrorMessage: typeof stored.lastErrorMessage === 'string' ? stored.lastErrorMessage : '',
                    lastErrorAction: typeof stored.lastErrorAction === 'string' ? stored.lastErrorAction : '',
                }));
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
            storeLicenseKey(parsed.key).then(() =>
                enforceEntitlement({ verify: true, forceVerify: true })
            ).then(status => {
                callback(status);
            }).catch(reason => {
                ubolErr(`setLicenseKey/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;
        }

        case 'replaceDevice': {
            verifyLicense({ force: true, replaceDevice: true }).then(() =>
                enforceEntitlement({ verify: false })
            ).then(status => {
                callback(status);
            }).catch(reason => {
                ubolErr(`replaceDevice/${reason}`);
                callback({ error: `${reason}` });
            });
            return true;
        }

        case 'clearLicenseKey': {
            clearLicenseKey().then(() =>
                enforceEntitlement({ verify: false })
            ).then(status => {
                callback(status);
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
                Promise.all([
                    registerInjectablesIfEntitled().catch(ubolErr),
                    ensureAnnoyancesForCompleteDefault().catch(ubolErr),
                ])
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
                return registerInjectablesIfEntitled().catch(ubolErr);
            }).then(() => {
                getDefaultFilteringMode().then(defaultFilteringMode => {
                    broadcastMessage({ defaultFilteringMode });
                });
                return ensureAnnoyancesForCompleteDefault().catch(ubolErr);
            }).then(() =>
                syncToolbarIconsForAllTabs().catch(ubolErr)
            ).then(() =>
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
            browser.scripting.executeScript({
                files: [
                    '/js/scripting/css-procedural-api.js',
                    '/js/scripting/tool-overlay.js',
                    '/js/scripting/picker.js',
                ],
                target: { tabId: tab.id },
            });
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

async function start() {
    await loadRulesetConfig();
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

    await initEntitlement().then(status => {
        entitlementStatus = status;
        scheduleEntitlementAlarms(entitlementStatus);
        scheduleTrialExpiredReminderAlarm(entitlementStatus).catch(ubolErr);
    }).catch(ubolErr);
    await syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr);

    if (entitlementStatus?.status === 'expired') {
        await enablePaywall({ broadcast: false }).catch(ubolErr);
    }

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

runtime.onConnect.addListener(port => {
    if ( port?.name !== YOUTUBE_FOLLOWUP_ARCHITECTURE_PORT_NAME ) { return; }
    port.onDisconnect.addListener(() => {
        detachArchitectureSubscriber(port);
    });
    port.onMessage.addListener(message => {
        const what = typeof message?.what === 'string' ? message.what : '';
        if ( what === 'startYouTubeFollowupArchitectureJob' ) {
            const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
            const strategy = typeof message?.strategy === 'string' ? message.strategy : '';
            const action = typeof message?.action === 'string' ? message.action : '';
            const targetUrl = normalizeYouTubeFollowupTargetUrl(message?.targetUrl);
            const sourceTabId = Number.isInteger(port.sender?.tab?.id) ? port.sender.tab.id : -1;
            if (
                strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER &&
                action === 'start-donor-owner'
            ) {
                const completed = findYouTubeFollowupCompletedArchitectureJobBySource(
                    sourceTabId,
                    strategy,
                    targetUrl
                );
                if ( completed !== null ) {
                    try {
                        port.postMessage({
                            requestId,
                            ok: completed.payload?.ok === true,
                            started: true,
                            token: completed.token,
                            targetUrl,
                            strategy,
                            donorStartedAt:
                                typeof completed.payload?.donorStartedAt === 'number'
                                    ? completed.payload.donorStartedAt
                                    : null,
                            donorReadyAt:
                                typeof completed.payload?.donorReadyAt === 'number'
                                    ? completed.payload.donorReadyAt
                                    : null,
                            ready: completed.payload?.ok === true,
                        });
                    } catch {}
                    return;
                }
                const running = findYouTubeFollowupArchitectureJobBySource(
                    sourceTabId,
                    strategy,
                    targetUrl
                );
                if ( running !== null ) {
                    try {
                        port.postMessage({
                            requestId,
                            ok: true,
                            started: true,
                            token: running.token,
                            targetUrl,
                            strategy,
                            donorStartedAt:
                                typeof running.entry?.donorStartedAt === 'number'
                                    ? running.entry.donorStartedAt
                                    : null,
                            ready: false,
                        });
                    } catch {}
                    return;
                }
                const started = startYouTubeFollowupArchitectureJob(
                    sourceTabId,
                    strategy,
                    targetUrl,
                    requestId
                );
                try {
                    port.postMessage({
                        requestId,
                        ...started,
                        started: started.ok === true,
                    });
                } catch {}
                return;
            }
            if (
                strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_DONOR_OWNER &&
                action === 'consume-donor-owner'
            ) {
                const completed = takeYouTubeFollowupCompletedArchitectureJobBySource(
                    sourceTabId,
                    strategy,
                    targetUrl
                );
                if ( completed !== null ) {
                    try {
                        port.postMessage({
                            requestId,
                            ...completed.payload,
                            requestId,
                            donorOwnerTransferOk: completed.payload?.ok === true,
                            donorOwnerReuseDetected: false,
                            donorOwnerContaminationDetected: false,
                        });
                    } catch {}
                    return;
                }
                const running = findYouTubeFollowupArchitectureJobBySource(
                    sourceTabId,
                    strategy,
                    targetUrl
                );
                try {
                    port.postMessage({
                        requestId,
                        ok: false,
                        error: running !== null ? 'owner-pending' : 'owner-miss',
                        donorOwnerTransferOk: false,
                        donorOwnerReuseDetected: false,
                        donorOwnerContaminationDetected: false,
                        done: true,
                    });
                } catch {}
                return;
            }
            if (
                strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM &&
                action === 'consume-prewarmed-entry'
            ) {
                try {
                    port.postMessage({
                        requestId,
                        ...consumeYouTubeFollowupArchitecturePrewarmEntry(targetUrl),
                        done: true,
                    });
                } catch {}
                return;
            }
            const started = startYouTubeFollowupArchitectureJob(
                sourceTabId,
                strategy,
                targetUrl,
                requestId
            );
            if ( started.ok !== true ) {
                try {
                    port.postMessage({
                        requestId,
                        ok: false,
                        error: started.error || 'start-failed',
                        done: true,
                    });
                } catch {}
                return;
            }
            if (
                (
                    strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A ||
                    strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_COMMIT ||
                    strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_INTENT_LEASE
                ) &&
                action === 'acquire-and-wait'
            ) {
                attachArchitectureSubscriber(started.token, port);
                return;
            }
            if (
                strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_A_PREWARM &&
                action === 'prewarm-target'
            ) {
                attachArchitectureSubscriber(started.token, port);
                return;
            }
            if ( strategy === YOUTUBE_FOLLOWUP_ARCHITECTURE_TRACK_B && action === 'start-relay' ) {
                try {
                    port.postMessage({
                        requestId,
                        ...started,
                        started: true,
                    });
                } catch {}
                return;
            }
            try {
                port.postMessage({
                    requestId,
                    ok: false,
                    error: 'invalid-action',
                    done: true,
                });
            } catch {}
            return;
        }
        if ( what === 'subscribeYouTubeFollowupArchitectureJob' ) {
            const token = typeof message?.token === 'string' ? message.token.trim() : '';
            if ( token === '' ) {
                try {
                    port.postMessage({
                        ok: false,
                        error: 'missing-token',
                        done: true,
                    });
                } catch {}
                return;
            }
            const completed = youtubeFollowupArchitectureCompletedJobs.get(token);
            if ( completed ) {
                try {
                    port.postMessage(completed);
                } catch {}
                youtubeFollowupArchitectureCompletedJobs.delete(token);
                return;
            }
            if ( youtubeFollowupArchitectureJobs.has(token) ) {
                attachArchitectureSubscriber(token, port);
                return;
            }
            try {
                port.postMessage({
                    token,
                    ok: false,
                    error: 'job-missing',
                    done: true,
                });
            } catch {}
        }
    });
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
    isFullyInitialized.then(() => {
        let handled = false;
        try {
            handled = onMessage(request, sender, safeCallback);
        } catch (reason) {
            ubolErr(`onMessage/${reason}`);
        }
        if (handled !== true) { safeCallback(); }
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

runtime.onInstalled.addListener((details) => {
    configureUninstallURL(`extension_${details?.reason || 'install'}`);
    if (details?.reason !== 'install') { return; }
    const url = INSTALL_WELCOME_URL;
    localWrite(FIRST_POPUP_WELCOME_PENDING_KEY, {
        source: FIRST_POPUP_WELCOME_SOURCE,
        queuedAt: Date.now(),
    }).catch(ubolErr);
    localRemove(FIRST_POPUP_WELCOME_SEEN_KEY).catch(ubolErr);
    Promise.all([
        syncYouTubeWatchControlCookies({ forceWrite: true }).catch(ubolErr),
    ])
        .finally(() => {
            gotoURL(url).catch(ubolErr);
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
