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
    setDefaultFilteringMode,
    setFilteringMode,
    setFilteringModeDetails,
    syncWithBrowserPermissions,
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
    shouldEnablePaywallForStatus,
    shouldRecordTrialReminderShown,
} from './entitlement-logic.js';
import {
    AUTO_BACKOFF_SIGNAL_WINDOW_MS,
    getDowngradedFilteringMode,
    mergeBreakageEvidenceEntry,
    normalizeHttpHostname,
    sanitizeBreakageDetails,
    shouldTriggerSignalBackoff,
    updateSignalCounter,
} from './auto-backoff.js';
import {
    BREAKAGE_AUDIT_OVERRIDES_KEY,
    sanitizeBreakageAuditOverrides,
} from './breakage-policy.js';

const AUTO_BACKOFF_STORAGE_KEY = 'autoBackoffHostsV1';
const AUTO_BACKOFF_EVIDENCE_STORAGE_KEY = 'autoBackoffEvidenceV1';
const AUTO_BACKOFF_ALARM = 'auto-backoff-restore';
const AUTO_BACKOFF_TTL_MS = 60 * 60 * 1000;
const AUTO_BACKOFF_WINDOW_MS = 2 * 60 * 1000;
const AUTO_BACKOFF_MIN_ERRORS = 2;
const AUTO_BACKOFF_ERROR_RE = /ERR_BLOCKED_BY_CLIENT/i;

const autoBackoffCounts = new Map();
const autoBackoffSignalCounts = new Map();
let autoBackoffState = new Map();
let autoBackoffEvidence = new Map();

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

const scheduleAutoBackoffAlarm = () => {
    if (browser?.alarms?.create === undefined) { return; }
    let nextExpiry = Infinity;
    for (const entry of autoBackoffState.values()) {
        const expiresAt = Number(entry?.expiresAt) || 0;
        if (expiresAt > 0 && expiresAt < nextExpiry) {
            nextExpiry = expiresAt;
        }
    }
    if (Number.isFinite(nextExpiry) === false) {
        browser.alarms?.clear?.(AUTO_BACKOFF_ALARM);
        return;
    }
    const when = Math.max(Date.now() + 1000, nextExpiry);
    browser.alarms.create(AUTO_BACKOFF_ALARM, { when });
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

const restoreExpiredAutoBackoffs = async () => {
    if (autoBackoffState.size === 0) { return; }
    const now = Date.now();
    let changed = false;
    for (const [hostname, entry] of Array.from(autoBackoffState.entries())) {
        const expiresAt = Number(entry?.expiresAt) || 0;
        if (expiresAt > now) { continue; }
        const currentLevel = await getFilteringMode(hostname);
        if (Number(currentLevel) === Number(entry.downgradedLevel)) {
            const restored = await setFilteringMode(hostname, entry.previousLevel);
            if (restored === entry.previousLevel) {
                registerInjectablesIfEntitled().catch(ubolErr);
            }
        }
        autoBackoffState.delete(hostname);
        changed = true;
    }
    if (changed) {
        await persistAutoBackoffState();
    }
    scheduleAutoBackoffAlarm();
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

const applyAutoBackoff = async (hostname) => {
    if (hostname === '') { return; }
    const now = Date.now();
    const existing = autoBackoffState.get(hostname);
    if (existing && Number(existing.expiresAt) > now) {
        existing.expiresAt = now + AUTO_BACKOFF_TTL_MS;
        autoBackoffState.set(hostname, existing);
        await persistAutoBackoffState();
        scheduleAutoBackoffAlarm();
        return;
    }

    const beforeLevel = Number(await getFilteringMode(hostname));
    const targetLevel = getDowngradedFilteringMode(
        beforeLevel,
        MODE_COMPLETE,
        MODE_OPTIMAL,
        MODE_BASIC
    );
    if (targetLevel === beforeLevel) { return; }

    const afterLevel = await setFilteringMode(hostname, targetLevel);
    if (afterLevel !== targetLevel) { return; }

    registerInjectablesIfEntitled().catch(ubolErr);

    autoBackoffState.set(hostname, {
        previousLevel: beforeLevel,
        downgradedLevel: targetLevel,
        expiresAt: now + AUTO_BACKOFF_TTL_MS,
    });
    await persistAutoBackoffState();
    scheduleAutoBackoffAlarm();
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
        applyAutoBackoff(hostname).catch(ubolErr);
    }
};

const recordBreakageSignal = async (hostname, signal, details = {}) => {
    if (hostname === '' || typeof signal !== 'string' || signal.trim() === '') { return; }
    const normalizedSignal = signal.trim();
    const now = Date.now();
    autoBackoffEvidence.set(
        hostname,
        mergeBreakageEvidenceEntry(autoBackoffEvidence.get(hostname), {
            signal: normalizedSignal,
            details: sanitizeBreakageDetails(details),
        }, now)
    );
    await persistAutoBackoffEvidence();
    const counter = updateSignalCounter(autoBackoffSignalCounts, hostname, normalizedSignal, now);
    if ( shouldTriggerSignalBackoff(normalizedSignal, counter) ) {
        await applyAutoBackoff(hostname);
    }
};

const initAutoBackoff = async () => {
    await loadAutoBackoffState();
    await loadAutoBackoffEvidence();
    await restoreExpiredAutoBackoffs();
    await pruneStaleAutoBackoffEvidence();
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
    scheduleCommunityAlarm,
    syncCommunityRules,
} from './community-sync.js';

import {
    getConsoleOutput,
    isSideloaded,
    toggleDeveloperMode,
    ubolErr,
    ubolLog,
} from './debug.js';

import { dnr } from './ext-compat.js';
import { registerInjectables } from './scripting-manager.js';
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

let entitlementStatus = { status: 'trial' };
let paywallActive = false;

const AUTO_GENERIC_HIGH_KEY = 'autoGenericHighHosts';
const AUTO_GENERIC_HIGH_MAX = 200;
const AUTO_PROMOTE_ENABLED = false;
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

function registerInjectablesIfEntitled() {
    if (isEntitled() === false) { return Promise.resolve(false); }
    return registerInjectables();
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

async function enforceEntitlement({ verify = false, forceVerify = false } = {}) {
    const status = await refreshEntitlement({ verify, forceVerify });
    if (status.status === 'expired') {
        await enablePaywall();
        return status;
    }

    // Ensure paywall override is removed before re-registering injectables.
    await disablePaywall();
    registerInjectablesIfEntitled().catch(ubolErr);
    return status;
}

async function addAutoGenericHighHost(hostname) {
    if (typeof hostname !== 'string') { return; }
    const hn = hostname.trim().toLowerCase();
    if (hn === '') { return; }

    const stored = await localRead(AUTO_GENERIC_HIGH_KEY);
    const list = Array.isArray(stored)
        ? stored.filter(v => typeof v === 'string' && v.trim() !== '')
        : [];

    const idx = list.indexOf(hn);
    if (idx !== -1) { list.splice(idx, 1); }
    list.unshift(hn);
    if (list.length > AUTO_GENERIC_HIGH_MAX) {
        list.length = AUTO_GENERIC_HIGH_MAX;
    }

    await localWrite(AUTO_GENERIC_HIGH_KEY, list);
    registerInjectablesIfEntitled().catch(ubolErr);
}

/******************************************************************************/

function getCurrentVersion() {
    return runtime.getManifest().version;
}

/******************************************************************************/

const ANNOYANCE_RULESET_IDS = [
    'annoyances-overlays',
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

function setDeveloperMode(state) {
    rulesetConfig.developerMode = isDeveloperModeAllowed && state === true;
    if ( rulesetConfig.developerMode === false ) {
        rulesetConfig.communityRulesURL = '';
        localRemove(BREAKAGE_AUDIT_OVERRIDES_KEY).catch(() => {});
    }
    toggleDeveloperMode(rulesetConfig.developerMode);
    broadcastMessage({ developerMode: rulesetConfig.developerMode });
    return Promise.all([
        updateUserRules(),
        saveRulesetConfig(),
    ]);
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
                addAutoGenericHighHost(request.hostname);
            }
            return false;
        }

        case 'promoteComplete': {
            if (AUTO_PROMOTE_ENABLED === false) { return false; }
            if (isEntitled() === false) { return false; }
            if (typeof request.hostname === 'string') {
                const hn = request.hostname.trim().toLowerCase();
                if (hn !== '') {
                    (async () => {
                        const beforeLevel = await getFilteringMode(hn);
                        // Respect user allowlisting/basic mode.
                        if (beforeLevel !== MODE_OPTIMAL) { return; }
                        const afterLevel = await setFilteringMode(hn, MODE_COMPLETE);
                        if (afterLevel === MODE_COMPLETE) {
                            registerInjectablesIfEntitled().catch(ubolErr);
                        }
                    })().catch(ubolErr);
                }
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
            recordBreakageSignal(hostname, request.signal, request.details).catch(ubolErr);
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
            ]).then(([overrides, evidence, enabledRulesets, registeredContentScripts]) => {
                callback({
                    overrides: overrides || { global: {}, hosts: {} },
                    evidence: evidence || {},
                    activeBackoffs: serializeAutoBackoffState(),
                    enabledRulesets: Array.isArray(enabledRulesets)
                        ? enabledRulesets.slice().sort()
                        : [],
                    registeredContentScripts,
                });
            });
            return true;
        }

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
                return saveRulesetConfig().then(() => {
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
            refreshEntitlement({ verify: false }).then(async status => {
                if (status?.status === 'expired') {
                    if (paywallActive === false) {
                        await enablePaywall({ broadcast: false }).catch(ubolErr);
                    }
                } else {
                    if (paywallActive) {
                        await disablePaywall({ broadcast: false }).catch(ubolErr);
                    }
                }
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
                refreshEntitlement({ verify: false })
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

    // Admin settings override user settings
    await loadAdminConfig();

    // The default rulesets may have changed, find out new ruleset to enable,
    // obsolete ruleset to remove.
    if (isNewVersion) {
        ubolLog(`Version change: ${rulesetConfig.version} => ${currentVersion}`);
        rulesetConfig.version = currentVersion;
    }
    defaultsPatched = await patchDefaultRulesets();
    if (isNewVersion || defaultsPatched) {
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
            const meta = await localRead('communityBundleMeta');
            scheduleCommunityAlarm(meta?.ttlHours);
            syncCommunityRules({ force: process.firstRun || isNewVersion })
                .catch(ubolErr);
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

    configureUninstallURL('extension_start');

    await initEntitlement().then(status => {
        entitlementStatus = status;
        scheduleEntitlementAlarms(entitlementStatus);
        scheduleTrialExpiredReminderAlarm(entitlementStatus).catch(ubolErr);
    }).catch(ubolErr);

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
    gotoURL(url).catch(ubolErr);
});

browser.alarms?.onAlarm.addListener(alarm => {
    if (alarm?.name === AUTO_BACKOFF_ALARM) {
        restoreExpiredAutoBackoffs().catch(ubolErr);
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
    syncCommunityRules().catch(ubolErr);
});
