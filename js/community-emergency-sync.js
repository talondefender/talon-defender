import { normalizeSiteKeyHostname } from './site-key.js';

export const COMMUNITY_EMERGENCY_SYNC_STATE_KEY = 'communityEmergencySyncStateV1';
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

const normalizeEntry = (input, now) => {
    if ( input instanceof Object === false ) { return null; }
    const recent = Array.isArray(input.recent)
        ? input.recent
            .map(event => normalizeEvent(event, now))
            .filter(Boolean)
            .sort((a, b) => b.ts - a.ts)
            .slice(0, COMMUNITY_EMERGENCY_SYNC_MAX_EVENTS_PER_DOMAIN)
        : [];
    if ( recent.length === 0 ) { return null; }
    return {
        lastSyncAt: recent[0].ts,
        lastReason: recent[0].reason,
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
    normalizedEntries.sort((a, b) => b[1].lastSyncAt - a[1].lastSyncAt);
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
    const lastSyncAt = Number(normalizedState[normalizedDomain]?.lastSyncAt) || 0;
    if ( lastSyncAt > 0 && (now - lastSyncAt) < COMMUNITY_EMERGENCY_SYNC_COOLDOWN_MS ) {
        return {
            allowed: false,
            reason: 'cooldown',
            domain: normalizedDomain,
            lastSyncAt,
            state: normalizedState,
        };
    }
    return {
        allowed: true,
        reason: 'ready',
        domain: normalizedDomain,
        lastSyncAt,
        state: normalizedState,
    };
};

export const recordCommunityEmergencySync = ({
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
    const existingRecent = Array.isArray(normalizedState[normalizedDomain]?.recent)
        ? normalizedState[normalizedDomain].recent
        : [];
    normalizedState[normalizedDomain] = {
        lastSyncAt: now,
        lastReason: normalizedReason,
        recent: [
            { ts: now, reason: normalizedReason },
            ...existingRecent,
        ].slice(0, COMMUNITY_EMERGENCY_SYNC_MAX_EVENTS_PER_DOMAIN),
    };
    return normalizeCommunityEmergencySyncState(normalizedState, { now });
};

export const getCommunityEmergencySyncDiagnostics = (
    state,
    { now = Date.now() } = {}
) => {
    const normalizedState = normalizeCommunityEmergencySyncState(state, { now });
    let lastSyncAt = 0;
    let lastDomain = '';
    let lastReason = '';
    let rollingCount = 0;
    for ( const [domain, entry] of Object.entries(normalizedState) ) {
        rollingCount += Array.isArray(entry.recent) ? entry.recent.length : 0;
        const candidateLastSyncAt = Number(entry.lastSyncAt) || 0;
        if ( candidateLastSyncAt <= lastSyncAt ) { continue; }
        lastSyncAt = candidateLastSyncAt;
        lastDomain = domain;
        lastReason = normalizeReason(entry.lastReason);
    }
    return {
        state: normalizedState,
        lastSyncAt,
        lastDomain,
        lastReason,
        rollingCount,
    };
};
