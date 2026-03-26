import { normalizeSiteKeyHostname } from './site-key.js';

export const COMMUNITY_EMERGENCY_SYNC_STATE_KEY = 'communityEmergencySyncStateV1';
export const COMMUNITY_EMERGENCY_SYNC_ATTEMPT_DEBOUNCE_MS = 60 * 1000;
export const COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS = 30 * 60 * 1000;
export const COMMUNITY_EMERGENCY_SYNC_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMMUNITY_EMERGENCY_SYNC_MAX_DOMAINS = 200;
const COMMUNITY_EMERGENCY_SYNC_MAX_EVENTS_PER_DOMAIN = 12;

const normalizeReason = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    return normalized === '' ? '' : normalized.slice(0, 96);
};

const normalizeEvent = (input, now) => {
    if ( input instanceof Object === false ) { return null; }
    const ts = Number(input.ts);
    const reason = normalizeReason(input.reason);
    if ( Number.isFinite(ts) === false || ts <= 0 || reason === '' ) { return null; }
    if ( ts > now ) { return null; }
    if ( (now - ts) > COMMUNITY_EMERGENCY_SYNC_RETENTION_MS ) { return null; }
    return { ts, reason };
};

const pickNewestEvent = (...events) => {
    let newest = null;
    for ( const event of events ) {
        if ( event === null ) { continue; }
        if ( newest === null || event.ts > newest.ts ) {
            newest = event;
        }
    }
    return newest;
};

const normalizeEntry = (input, now) => {
    if ( input instanceof Object === false ) { return null; }
    const recent = Array.isArray(input.recent)
        ? input.recent
            .map(event => normalizeEvent(event, now))
            .filter(Boolean)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, COMMUNITY_EMERGENCY_SYNC_MAX_EVENTS_PER_DOMAIN)
        : [];
    const lastAttemptEvent = normalizeEvent({
        ts: input.lastAttemptAt ?? input.lastSyncAt,
        reason: input.lastAttemptReason ?? input.lastReason,
    }, now);
    const lastSuccessEvent = normalizeEvent({
        ts: input.lastSuccessAt ?? input.lastSyncAt,
        reason: input.lastSuccessReason ?? input.lastReason,
    }, now);
    const effectiveLastAttempt = pickNewestEvent(
        lastAttemptEvent,
        recent[0] || null
    ) || lastSuccessEvent;
    if ( recent.length === 0 && effectiveLastAttempt === null && lastSuccessEvent === null ) {
        return null;
    }
    return {
        lastAttemptAt: effectiveLastAttempt?.ts || 0,
        lastAttemptReason: effectiveLastAttempt?.reason || '',
        lastSuccessAt: lastSuccessEvent?.ts || 0,
        lastSuccessReason: lastSuccessEvent?.reason || '',
        recent,
    };
};

export const normalizeCommunityEmergencySyncState = (
    input,
    { now = Date.now() } = {}
) => {
    if ( input instanceof Object === false ) { return {}; }
    const normalizedEntries = [];
    for ( const [domain, entry] of Object.entries(input) ) {
        const normalizedDomain = normalizeSiteKeyHostname(domain);
        if ( normalizedDomain === '' ) { continue; }
        const normalizedEntry = normalizeEntry(entry, now);
        if ( normalizedEntry === null ) { continue; }
        normalizedEntries.push([ normalizedDomain, normalizedEntry ]);
    }
    normalizedEntries.sort((a, b) => (
        Math.max(b[1].lastAttemptAt, b[1].lastSuccessAt) -
        Math.max(a[1].lastAttemptAt, a[1].lastSuccessAt)
    ));
    return Object.fromEntries(
        normalizedEntries.slice(0, COMMUNITY_EMERGENCY_SYNC_MAX_DOMAINS)
    );
};

export const shouldTriggerCommunityEmergencySync = ({
    state,
    domain,
    entitled = true,
    communityRulesEnabled = true,
    communityUrlValid = true,
    now = Date.now(),
} = {}) => {
    const normalizedState = normalizeCommunityEmergencySyncState(state, { now });
    const normalizedDomain = normalizeSiteKeyHostname(domain);
    if ( entitled !== true ) {
        return { allowed: false, reason: 'not-entitled', state: normalizedState };
    }
    if ( communityRulesEnabled !== true ) {
        return { allowed: false, reason: 'disabled', state: normalizedState };
    }
    if ( communityUrlValid !== true ) {
        return { allowed: false, reason: 'invalid-url', state: normalizedState };
    }
    if ( normalizedDomain === '' ) {
        return { allowed: false, reason: 'invalid-domain', state: normalizedState };
    }
    const lastSuccessAt = Number(normalizedState[normalizedDomain]?.lastSuccessAt) || 0;
    if ( lastSuccessAt > 0 && (now - lastSuccessAt) < COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS ) {
        return {
            allowed: false,
            reason: 'cooldown',
            domain: normalizedDomain,
            lastAttemptAt: Number(normalizedState[normalizedDomain]?.lastAttemptAt) || 0,
            lastSuccessAt,
            state: normalizedState,
        };
    }
    const lastAttemptAt = Number(normalizedState[normalizedDomain]?.lastAttemptAt) || 0;
    if (
        lastAttemptAt > 0 &&
        (now - lastAttemptAt) < COMMUNITY_EMERGENCY_SYNC_ATTEMPT_DEBOUNCE_MS
    ) {
        return {
            allowed: false,
            reason: 'attempt-debounce',
            domain: normalizedDomain,
            lastAttemptAt,
            lastSuccessAt,
            state: normalizedState,
        };
    }
    return {
        allowed: true,
        reason: 'ready',
        domain: normalizedDomain,
        lastAttemptAt,
        lastSuccessAt,
        state: normalizedState,
    };
};

export const recordCommunityEmergencySyncAttempt = ({
    state,
    domain,
    reason,
    now = Date.now(),
} = {}) => {
    const normalizedState = normalizeCommunityEmergencySyncState(state, { now });
    const normalizedDomain = normalizeSiteKeyHostname(domain);
    const normalizedReason = normalizeReason(reason);
    if ( normalizedDomain === '' || normalizedReason === '' ) {
        return normalizedState;
    }
    const existingEntry = normalizedState[normalizedDomain] instanceof Object
        ? normalizedState[normalizedDomain]
        : null;
    const existingRecent = Array.isArray(existingEntry?.recent)
        ? existingEntry.recent
        : [];
    normalizedState[normalizedDomain] = {
        lastAttemptAt: now,
        lastAttemptReason: normalizedReason,
        lastSuccessAt: Number(existingEntry?.lastSuccessAt) || 0,
        lastSuccessReason: normalizeReason(existingEntry?.lastSuccessReason),
        recent: [
            { ts: now, reason: normalizedReason },
            ...existingRecent,
        ].slice(0, COMMUNITY_EMERGENCY_SYNC_MAX_EVENTS_PER_DOMAIN),
    };
    return normalizeCommunityEmergencySyncState(normalizedState, { now });
};

export const recordCommunityEmergencySyncSuccess = ({
    state,
    domain,
    reason,
    now = Date.now(),
} = {}) => {
    const normalizedState = normalizeCommunityEmergencySyncState(state, { now });
    const normalizedDomain = normalizeSiteKeyHostname(domain);
    const existingEntry = normalizedDomain !== ''
        ? normalizedState[normalizedDomain]
        : null;
    const normalizedReason = normalizeReason(reason) ||
        normalizeReason(existingEntry?.lastAttemptReason) ||
        normalizeReason(existingEntry?.lastSuccessReason);
    if ( normalizedDomain === '' || normalizedReason === '' ) {
        return normalizedState;
    }
    normalizedState[normalizedDomain] = {
        lastAttemptAt: Number(existingEntry?.lastAttemptAt) || now,
        lastAttemptReason: normalizeReason(existingEntry?.lastAttemptReason) ||
            normalizedReason,
        lastSuccessAt: now,
        lastSuccessReason: normalizedReason,
        recent: Array.isArray(existingEntry?.recent)
            ? existingEntry.recent
            : [],
    };
    return normalizeCommunityEmergencySyncState(normalizedState, { now });
};

export const recordCommunityEmergencySync = options =>
    recordCommunityEmergencySyncAttempt(options);

export const getCommunityEmergencySyncDiagnostics = (
    state,
    { now = Date.now() } = {}
) => {
    const normalizedState = normalizeCommunityEmergencySyncState(state, { now });
    let lastAttemptAt = 0;
    let lastAttemptDomain = '';
    let lastAttemptReason = '';
    let lastSuccessAt = 0;
    let lastSuccessDomain = '';
    let lastSuccessReason = '';
    let rollingCount = 0;
    for ( const [domain, entry] of Object.entries(normalizedState) ) {
        rollingCount += Array.isArray(entry.recent) ? entry.recent.length : 0;
        const candidateLastAttemptAt = Number(entry.lastAttemptAt) || 0;
        if ( candidateLastAttemptAt > lastAttemptAt ) {
            lastAttemptAt = candidateLastAttemptAt;
            lastAttemptDomain = domain;
            lastAttemptReason = normalizeReason(entry.lastAttemptReason);
        }
        const candidateLastSuccessAt = Number(entry.lastSuccessAt) || 0;
        if ( candidateLastSuccessAt > lastSuccessAt ) {
            lastSuccessAt = candidateLastSuccessAt;
            lastSuccessDomain = domain;
            lastSuccessReason = normalizeReason(entry.lastSuccessReason);
        }
    }
    const lastSyncAt = Math.max(lastAttemptAt, lastSuccessAt);
    const useSuccess = lastSuccessAt >= lastAttemptAt && lastSuccessAt > 0;
    return {
        state: normalizedState,
        lastAttemptAt,
        lastAttemptDomain,
        lastAttemptReason,
        lastSuccessAt,
        lastSuccessDomain,
        lastSuccessReason,
        lastSyncAt,
        lastDomain: useSuccess ? lastSuccessDomain : lastAttemptDomain,
        lastReason: useSuccess ? lastSuccessReason : lastAttemptReason,
        rollingCount,
    };
};
