import {
    isExactHostnamePattern,
    patternCouldMatchInternalUnfilteredDomain,
    patternCouldMatchProtectedDomain,
} from './breakage-policy.js';
import { normalizeScopedHostPattern } from './breakage-policy.js';

export const COMMUNITY_TACTIC_KIND_PRUNE = 'jsonPrune';
export const COMMUNITY_TACTIC_KIND_SET = 'jsonSet';
export const COMMUNITY_TACTIC_TRANSPORT_FETCH = 'fetch';
export const COMMUNITY_TACTIC_TRANSPORT_XHR = 'xhr';
export const COMMUNITY_TACTIC_TRANSPORT_BOTH = 'both';
export const COMMUNITY_TACTIC_PHASE_RESPONSE = 'response';
export const COMMUNITY_TACTIC_PHASE_REQUEST = 'request';

export const COMMUNITY_TACTIC_BASELINE_MAX = 80;
export const COMMUNITY_TACTIC_OVERLAY_MAX = 20;
export const COMMUNITY_TACTIC_COMPILED_MAX = 100;
export const COMMUNITY_TACTIC_HOSTS_MAX = 8;
export const COMMUNITY_TACTIC_URL_PREFIXES_MAX = 8;
export const COMMUNITY_TACTIC_JSON_PATHS_MAX = 16;
export const COMMUNITY_TACTIC_URL_PREFIX_MAX_LENGTH = 128;
export const COMMUNITY_TACTIC_JSON_PATH_MAX_LENGTH = 128;
export const COMMUNITY_TACTIC_ID_MAX_LENGTH = 64;

const VALID_TACTIC_KINDS = new Set([
    COMMUNITY_TACTIC_KIND_PRUNE,
    COMMUNITY_TACTIC_KIND_SET,
]);

const VALID_TACTIC_TRANSPORTS = new Set([
    COMMUNITY_TACTIC_TRANSPORT_FETCH,
    COMMUNITY_TACTIC_TRANSPORT_XHR,
    COMMUNITY_TACTIC_TRANSPORT_BOTH,
]);

const VALID_TACTIC_PHASES = new Set([
    COMMUNITY_TACTIC_PHASE_RESPONSE,
    COMMUNITY_TACTIC_PHASE_REQUEST,
]);

const COMMUNITY_TACTIC_REQUEST_PHASE_SCHEMA_VERSION = 5;

const JSON_PATH_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

const cloneValue = value => value === undefined
    ? undefined
    : structuredClone(value);

const isAllowedEmptyObjectValue = value => {
    if ( value instanceof Object === false || Array.isArray(value) ) { return false; }
    const prototype = Object.getPrototypeOf(value);
    if ( prototype !== Object.prototype && prototype !== null ) { return false; }
    return Object.keys(value).length === 0;
};

const isAllowedCommunityTacticValue = value => (
    value === null ||
    value === false ||
    value === 0 ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    isAllowedEmptyObjectValue(value)
);

export const normalizeCommunityTacticHostPattern = value => {
    const normalized = normalizeScopedHostPattern(value, {
        allowGlobal: false,
    });
    if (
        normalized === '' ||
        normalized === '*' ||
        normalized === 'all-urls'
    ) {
        return '';
    }
    const exactHost = isExactHostnamePattern(normalized)
        ? normalized
        : normalized.includes('*')
            ? ''
            : `=${normalized}`;
    if ( exactHost === '' ) { return ''; }
    if ( patternCouldMatchInternalUnfilteredDomain(exactHost) ) { return ''; }
    if ( patternCouldMatchProtectedDomain(exactHost) ) { return ''; }
    return exactHost;
};

export const collectCommunityTacticHostnames = input => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of input ) {
        if ( entry instanceof Object === false ) { continue; }
        const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
        for ( const host of hosts ) {
            const normalized = normalizeCommunityTacticHostPattern(host);
            if ( normalized.startsWith('=') === false ) { continue; }
            const hostname = normalized.slice(1);
            if ( hostname === '' || seen.has(hostname) ) { continue; }
            seen.add(hostname);
            out.push(hostname);
        }
    }
    return out;
};

export const normalizeCommunityTacticUrlPathPrefix = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    if ( normalized === '' || normalized.length > COMMUNITY_TACTIC_URL_PREFIX_MAX_LENGTH ) {
        return '';
    }
    if ( normalized.startsWith('/') === false ) { return ''; }
    if ( normalized.includes('?') || normalized.includes('#') ) { return ''; }
    return normalized;
};

export const normalizeCommunityTacticJsonPath = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    if ( normalized === '' || normalized.length > COMMUNITY_TACTIC_JSON_PATH_MAX_LENGTH ) {
        return '';
    }
    if (
        normalized.startsWith('.') ||
        normalized.endsWith('.') ||
        normalized.includes('..')
    ) {
        return '';
    }
    const segments = normalized.split('.');
    if ( segments.length === 0 ) { return ''; }
    for ( const segment of segments ) {
        if ( segment === '[]' || segment === '*' ) { continue; }
        if ( JSON_PATH_IDENTIFIER_RE.test(segment) ) { continue; }
        return '';
    }
    return normalized;
};

const sanitizeUniqueStringArray = (input, normalize, limit) => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of input ) {
        const normalized = normalize(entry);
        if ( normalized === '' || seen.has(normalized) ) { continue; }
        seen.add(normalized);
        out.push(normalized);
        if ( out.length >= limit ) { break; }
    }
    return out;
};

export const sanitizeCommunityTactics = (
    input,
    {
        maxEntries = COMMUNITY_TACTIC_COMPILED_MAX,
        maxHosts = COMMUNITY_TACTIC_HOSTS_MAX,
        maxUrlPathPrefixes = COMMUNITY_TACTIC_URL_PREFIXES_MAX,
        maxJsonPaths = COMMUNITY_TACTIC_JSON_PATHS_MAX,
        schemaVersion = 4,
    } = {}
) => {
    if ( Array.isArray(input) === false ) { return null; }
    const out = [];
    const seenIds = new Set();
    for ( const entry of input ) {
        if ( entry instanceof Object === false ) { continue; }
        const id = typeof entry.id === 'string'
            ? entry.id.trim().slice(0, COMMUNITY_TACTIC_ID_MAX_LENGTH)
            : '';
        const kind = typeof entry.kind === 'string'
            ? entry.kind.trim()
            : '';
        const transport = typeof entry.transport === 'string'
            ? entry.transport.trim()
            : '';
        const phase = typeof entry.phase === 'string'
            ? entry.phase.trim()
            : COMMUNITY_TACTIC_PHASE_RESPONSE;
        if (
            id === '' ||
            seenIds.has(id) ||
            VALID_TACTIC_KINDS.has(kind) === false ||
            VALID_TACTIC_TRANSPORTS.has(transport) === false ||
            VALID_TACTIC_PHASES.has(phase) === false ||
            (
                phase === COMMUNITY_TACTIC_PHASE_REQUEST &&
                Number(schemaVersion) < COMMUNITY_TACTIC_REQUEST_PHASE_SCHEMA_VERSION
            )
        ) {
            continue;
        }
        const hosts = sanitizeUniqueStringArray(
            entry.hosts,
            normalizeCommunityTacticHostPattern,
            maxHosts
        );
        const urlPathPrefixes = sanitizeUniqueStringArray(
            entry.urlPathPrefixes,
            normalizeCommunityTacticUrlPathPrefix,
            maxUrlPathPrefixes
        );
        const jsonPaths = sanitizeUniqueStringArray(
            entry.jsonPaths,
            normalizeCommunityTacticJsonPath,
            maxJsonPaths
        );
        if (
            hosts.length === 0 ||
            urlPathPrefixes.length === 0 ||
            jsonPaths.length === 0
        ) {
            continue;
        }
        const tactic = {
            id,
            kind,
            hosts,
            phase,
            transport,
            urlPathPrefixes,
            jsonPaths,
        };
        if ( kind === COMMUNITY_TACTIC_KIND_SET ) {
            if ( isAllowedCommunityTacticValue(entry.value) === false ) {
                continue;
            }
            tactic.value = cloneValue(entry.value);
        }
        seenIds.add(id);
        out.push(tactic);
        if ( out.length >= maxEntries ) { break; }
    }
    return out.length === 0 ? null : out;
};

export const mergeCommunityTactics = (
    sources,
    {
        maxEntries = COMMUNITY_TACTIC_COMPILED_MAX,
    } = {}
) => {
    const merged = [];
    const seen = new Set();
    let dropped = 0;
    for ( const source of sources ) {
        if ( Array.isArray(source?.publicTactics) === false ) { continue; }
        for ( const entry of source.publicTactics ) {
            const id = typeof entry?.id === 'string' ? entry.id : '';
            if ( id === '' || seen.has(id) ) { continue; }
            seen.add(id);
            if ( merged.length >= maxEntries ) {
                dropped += 1;
                continue;
            }
            merged.push(cloneValue(entry));
        }
    }
    return {
        tactics: merged.length === 0 ? null : merged,
        dropped,
    };
};

export const filterCommunityTacticsByHostname = (input, hostname) => {
    if ( Array.isArray(input) === false || typeof hostname !== 'string' ) { return []; }
    const normalizedHostname = normalizeCommunityTacticHostPattern(hostname);
    if ( normalizedHostname === '' ) { return []; }
    return input
        .filter(entry => Array.isArray(entry?.hosts) && entry.hosts.includes(normalizedHostname))
        .map(entry => cloneValue(entry));
};

const pathSegmentsFromQuery = query => (
    normalizeCommunityTacticJsonPath(query) === ''
        ? []
        : query.trim().split('.')
);

const collectConcretePaths = (root, segments, index = 0, prefix = [], out = []) => {
    if ( index >= segments.length ) {
        out.push(prefix.slice());
        return out;
    }
    const segment = segments[index];
    if ( segment === '[]' ) {
        if ( Array.isArray(root) === false ) { return out; }
        for ( let i = 0; i < root.length; i++ ) {
            collectConcretePaths(root[i], segments, index + 1, [ ...prefix, i ], out);
        }
        return out;
    }
    if ( segment === '*' ) {
        if ( Array.isArray(root) ) {
            for ( let i = 0; i < root.length; i++ ) {
                collectConcretePaths(root[i], segments, index + 1, [ ...prefix, i ], out);
            }
            return out;
        }
        if ( root instanceof Object ) {
            for ( const key of Object.keys(root) ) {
                collectConcretePaths(root[key], segments, index + 1, [ ...prefix, key ], out);
            }
        }
        return out;
    }
    if ( root instanceof Object === false ) { return out; }
    if ( Object.hasOwn(root, segment) === false ) { return out; }
    collectConcretePaths(root[segment], segments, index + 1, [ ...prefix, segment ], out);
    return out;
};

const resolvePathOwner = (root, path) => {
    if ( Array.isArray(path) === false || path.length === 0 ) { return null; }
    let owner = root;
    for ( let i = 0; i < path.length - 1; i++ ) {
        const key = path[i];
        if ( owner instanceof Object === false || Object.hasOwn(owner, key) === false ) {
            return null;
        }
        owner = owner[key];
    }
    return {
        owner,
        key: path[path.length - 1],
    };
};

const compareConcretePathsForDeletion = (left, right) => {
    if ( left.length !== right.length ) {
        return right.length - left.length;
    }
    const leftParent = JSON.stringify(left.slice(0, -1));
    const rightParent = JSON.stringify(right.slice(0, -1));
    if ( leftParent === rightParent ) {
        const leftKey = left[left.length - 1];
        const rightKey = right[right.length - 1];
        if ( typeof leftKey === 'number' && typeof rightKey === 'number' ) {
            return rightKey - leftKey;
        }
    }
    return JSON.stringify(right).localeCompare(JSON.stringify(left));
};

const cloneJsonValue = value => (
    value === null || value === false || value === 0 || value === ''
        ? value
        : cloneValue(value)
);

const applyPathMutation = (root, pathQuery, { kind, value } = {}) => {
    const segments = pathSegmentsFromQuery(pathQuery);
    if ( segments.length === 0 ) { return false; }
    const targets = collectConcretePaths(root, segments);
    if ( targets.length === 0 ) { return false; }
    let mutated = false;
    if ( kind === COMMUNITY_TACTIC_KIND_SET ) {
        for ( const path of targets ) {
            const ref = resolvePathOwner(root, path);
            if ( ref === null || ref.owner instanceof Object === false ) { continue; }
            ref.owner[ref.key] = cloneJsonValue(value);
            mutated = true;
        }
        return mutated;
    }
    for ( const path of targets.sort(compareConcretePathsForDeletion) ) {
        const ref = resolvePathOwner(root, path);
        if ( ref === null || ref.owner instanceof Object === false ) { continue; }
        if ( Array.isArray(ref.owner) && typeof ref.key === 'number' ) {
            if ( ref.key < 0 || ref.key >= ref.owner.length ) { continue; }
            ref.owner.splice(ref.key, 1);
        } else {
            if ( Object.hasOwn(ref.owner, ref.key) === false ) { continue; }
            delete ref.owner[ref.key];
        }
        mutated = true;
    }
    return mutated;
};

const tacticMatchesTransport = (tactic, transport) => (
    tactic?.transport === COMMUNITY_TACTIC_TRANSPORT_BOTH ||
    tactic?.transport === transport
);

const tacticMatchesPhase = (tactic, phase) => (
    (tactic?.phase || COMMUNITY_TACTIC_PHASE_RESPONSE) === phase
);

const tacticMatchesPathname = (tactic, pathname) => (
    Array.isArray(tactic?.urlPathPrefixes) &&
    tactic.urlPathPrefixes.some(prefix => pathname.startsWith(prefix))
);

export const applyCommunityTacticsToJsonValue = (
    input,
    tactics,
    {
        hostname = '',
        phase = COMMUNITY_TACTIC_PHASE_RESPONSE,
        transport = COMMUNITY_TACTIC_TRANSPORT_FETCH,
        pathname = '/',
    } = {}
) => {
    if (
        Array.isArray(tactics) === false ||
        tactics.length === 0 ||
        input instanceof Object === false ||
        typeof pathname !== 'string'
    ) {
        return { applied: false, value: input };
    }
    const exactHost = normalizeCommunityTacticHostPattern(hostname);
    const applicable = [];
    for ( const tactic of tactics ) {
        if ( tactic instanceof Object === false ) { continue; }
        if ( exactHost !== '' ) {
            if ( Array.isArray(tactic.hosts) === false || tactic.hosts.includes(exactHost) === false ) {
                continue;
            }
        }
        if ( tacticMatchesPhase(tactic, phase) === false ) { continue; }
        if ( tacticMatchesTransport(tactic, transport) === false ) { continue; }
        if ( tacticMatchesPathname(tactic, pathname) === false ) { continue; }
        applicable.push(tactic);
    }
    if ( applicable.length === 0 ) {
        return { applied: false, value: input };
    }
    const clone = structuredClone(input);
    let mutated = false;
    for ( const tactic of applicable ) {
        for ( const path of tactic.jsonPaths || [] ) {
            mutated = applyPathMutation(clone, path, tactic) || mutated;
        }
    }
    return {
        applied: mutated,
        value: mutated ? clone : input,
    };
};
