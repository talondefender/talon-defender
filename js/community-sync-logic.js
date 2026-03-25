export const COMMUNITY_SYNC_DEFAULT_TTL_HOURS = 24;
export const COMMUNITY_SYNC_FAILURE_RETRY_MS = 15 * 60 * 1000;
export const COMMUNITY_HEURISTIC_LABEL_REGEX_MAX = 64;
export const COMMUNITY_HEURISTIC_LABEL_REGEX_MAX_LENGTH = 256;
export const COMMUNITY_HEURISTIC_SELECTOR_MAX = 64;

const toFinitePositiveNumber = value => {
    const num = Number(value);
    if ( Number.isFinite(num) === false || num <= 0 ) { return 0; }
    return num;
};

export const normalizeCommunitySyncTtlHours = value => {
    const ttlHours = Number(value);
    if ( Number.isFinite(ttlHours) === false || ttlHours <= 0 ) {
        return COMMUNITY_SYNC_DEFAULT_TTL_HOURS;
    }
    return ttlHours;
};

export const computeCommunitySyncState = ({
    force = false,
    now = Date.now(),
    lastAttempt = 0,
    lastSuccess = 0,
    lastError = '',
    ttlHours = COMMUNITY_SYNC_DEFAULT_TTL_HOURS,
} = {}) => {
    const effectiveNow = toFinitePositiveNumber(now) || Date.now();
    const ttlMs = normalizeCommunitySyncTtlHours(ttlHours) * 60 * 60 * 1000;
    const attemptMs = toFinitePositiveNumber(lastAttempt);
    const successMs = toFinitePositiveNumber(lastSuccess);
    const errorMessage = typeof lastError === 'string' ? lastError : '';
    const hasRetryFailure = errorMessage !== '' && attemptMs > 0 && attemptMs >= successMs;

    if ( force ) {
        return {
            due: true,
            reason: 'force',
            ttlMs,
            retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
        };
    }

    if ( hasRetryFailure ) {
        const retryAgeMs = Math.max(0, effectiveNow - attemptMs);
        const retryRemainingMs = Math.max(0, COMMUNITY_SYNC_FAILURE_RETRY_MS - retryAgeMs);
        if ( retryRemainingMs === 0 ) {
            return {
                due: true,
                reason: 'retry',
                ttlMs,
                retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
            };
        }
        return {
            due: false,
            reason: 'retry-backoff',
            nextDelayMs: retryRemainingMs,
            periodMs: 0,
            ttlMs,
            retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
        };
    }

    if ( successMs > 0 ) {
        const successAgeMs = Math.max(0, effectiveNow - successMs);
        const ttlRemainingMs = Math.max(0, ttlMs - successAgeMs);
        if ( ttlRemainingMs === 0 ) {
            return {
                due: true,
                reason: 'ttl-expired',
                ttlMs,
                retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
            };
        }
        return {
            due: false,
            reason: 'ttl',
            nextDelayMs: ttlRemainingMs,
            periodMs: ttlMs,
            ttlMs,
            retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
        };
    }

    return {
        due: true,
        reason: attemptMs > 0 ? 'retry-initial' : 'initial',
        ttlMs,
        retryMs: COMMUNITY_SYNC_FAILURE_RETRY_MS,
    };
};

const normalizeStringArray = (input, { sort = false } = {}) => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    for ( const item of input ) {
        if ( typeof item !== 'string' ) { continue; }
        const value = item.trim();
        if ( value === '' ) { continue; }
        out.push(value);
    }
    if ( sort ) {
        out.sort();
    }
    return out;
};

export const normalizeCommunityHeuristicLabelRegexes = (
    input,
    {
        limit = COMMUNITY_HEURISTIC_LABEL_REGEX_MAX,
        maxLen = COMMUNITY_HEURISTIC_LABEL_REGEX_MAX_LENGTH,
    } = {}
) => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const item of input ) {
        if ( typeof item !== 'string' ) { continue; }
        const value = item.trim();
        if ( value === '' || value.length > maxLen || seen.has(value) ) { continue; }
        try {
            new RegExp(value, 'i');
        } catch {
            continue;
        }
        seen.add(value);
        out.push(value);
        if ( out.length >= limit ) { break; }
    }
    return out;
};

const normalizeCommunityCosmetics = input => {
    if ( input instanceof Object === false ) { return null; }
    const all = normalizeStringArray(input.all, { sort: true });
    const hostEntries = input.hosts instanceof Object
        ? Object.entries(input.hosts)
        : [];
    const hosts = {};
    for ( const [host, selectors] of hostEntries.sort(([a], [b]) => a.localeCompare(b)) ) {
        const normalizedHost = typeof host === 'string' ? host.trim() : '';
        if ( normalizedHost === '' ) { continue; }
        const normalizedSelectors = normalizeStringArray(selectors, { sort: true });
        if ( normalizedSelectors.length === 0 ) { continue; }
        hosts[normalizedHost] = normalizedSelectors;
    }
    if ( all.length === 0 && Object.keys(hosts).length === 0 ) { return null; }
    return { all, hosts };
};

const normalizeCommunityHeuristics = input => {
    if ( input instanceof Object === false ) { return null; }
    const out = {};
    const disableHosts = normalizeStringArray(input.disableHosts, { sort: true });
    if ( disableHosts.length !== 0 ) {
        out.disableHosts = disableHosts;
    }
    const labelRegexes = normalizeStringArray(input.labelRegexes, { sort: true });
    if ( labelRegexes.length !== 0 ) {
        out.labelRegexes = labelRegexes;
    }
    const labelSelectors = normalizeStringArray(input.labelSelectors, { sort: true });
    if ( labelSelectors.length !== 0 ) {
        out.labelSelectors = labelSelectors;
    }
    const widgetSelectors = normalizeStringArray(input.widgetSelectors, { sort: true });
    if ( widgetSelectors.length !== 0 ) {
        out.widgetSelectors = widgetSelectors;
    }
    const containerStopSelectors = normalizeStringArray(input.containerStopSelectors, {
        sort: true,
    });
    if ( containerStopSelectors.length !== 0 ) {
        out.containerStopSelectors = containerStopSelectors;
    }
    for ( const key of [
        'maxLabelTextLength',
        'minContainerHeight',
        'minContainerWidth',
        'minScore',
        'minScoreLowConfidence',
    ] ) {
        const num = Number(input[key]);
        if ( Number.isFinite(num) === false ) { continue; }
        out[key] = num;
    }
    return Object.keys(out).length === 0 ? null : out;
};

export const countCommunityCosmeticSelectors = input => {
    const cosmetics = normalizeCommunityCosmetics(input);
    if ( cosmetics === null ) { return 0; }
    let total = cosmetics.all.length;
    for ( const selectors of Object.values(cosmetics.hosts) ) {
        total += selectors.length;
    }
    return total;
};

export const countHostSpecificCommunityCosmeticSelectors = input => {
    const cosmetics = normalizeCommunityCosmetics(input);
    if ( cosmetics === null ) { return 0; }
    let total = 0;
    for ( const selectors of Object.values(cosmetics.hosts) ) {
        total += selectors.length;
    }
    return total;
};

export const countCommunityHeuristicLabelRegexes = input => {
    const heuristics = normalizeCommunityHeuristics(input);
    return heuristics?.labelRegexes?.length || 0;
};

export const buildCommunityInjectableStateFingerprint = (input = {}) => {
    const source = input instanceof Object ? input : {};
    const normalized = {
        cosmetics: normalizeCommunityCosmetics(source.cosmetics),
        heuristics: normalizeCommunityHeuristics(source.heuristics),
        directives: Array.isArray(source.directives) && source.directives.length !== 0
            ? source.directives
            : null,
        scriptlets: Array.isArray(source.scriptlets) && source.scriptlets.length !== 0
            ? source.scriptlets
            : null,
    };
    return JSON.stringify(normalized);
};

export const hasCommunityInjectableStateChanged = (before, after) =>
    buildCommunityInjectableStateFingerprint(before) !==
        buildCommunityInjectableStateFingerprint(after);
