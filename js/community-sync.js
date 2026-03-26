/******************************************************************************/
// Community intelligence sync (remote signed DNR rules)

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
} from './ext.js';

import { isDeveloperModeAllowed, rulesetConfig } from './config.js';
import { ubolErr, ubolLog } from './debug.js';
import { getActiveCommunityRules, updateCommunityRules } from './ruleset-manager.js';
import {
    isExactHostnamePattern,
    isRemoteScriptletAllowed,
    isSafeMutationSelector,
    normalizeScopedHostPattern,
    patternCouldMatchInternalUnfilteredDomain,
    patternCouldMatchProtectedDomain,
} from './breakage-policy.js';
import {
    countCommunityCosmeticSelectors,
    countCommunityHeuristicLabelRegexes,
    countHostSpecificCommunityCosmeticSelectors,
    hasCommunityInjectableStateChanged,
    COMMUNITY_HEURISTIC_SELECTOR_MAX,
    normalizeCommunityHeuristicLabelRegexes,
    COMMUNITY_SYNC_FAILURE_RETRY_MS,
    computeCommunitySyncState,
    normalizeCommunitySyncTtlHours,
} from './community-sync-logic.js';
import {
    COMMUNITY_TACTIC_BASELINE_MAX,
    COMMUNITY_TACTIC_COMPILED_MAX,
    COMMUNITY_TACTIC_OVERLAY_MAX,
    mergeCommunityTactics,
    sanitizeCommunityTactics,
} from './community-tactics.js';
import {
    COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
    COMMUNITY_RULE_SCHEMA_VERSION_TACTICS,
    normalizeCommunityRuleSchemaVersion,
    sanitizeCommunityRules,
} from './community-rule-sanitizer.js';
import { normalizeAutoPromotedHostname } from './site-key.js';

/******************************************************************************/

const COMMUNITY_URL_DEFAULT = (() => {
    // Default to the product's API domain, derived from homepage_url when available.
    try {
        const homepageUrl = runtime.getManifest?.()?.homepage_url;
        if ( typeof homepageUrl === 'string' && homepageUrl.trim() !== '' ) {
            const u = new URL(homepageUrl.trim());
            const host = u.hostname.replace(/^www\./i, '');
            if ( host !== '' ) {
                return `${u.protocol}//api.${host}/v1/community/latest.bundle.json`;
            }
        }
    } catch {
    }
    return 'https://api.talondefender.com/v1/community/latest.bundle.json';
})();

// Base64-encoded Ed25519 public key. Leave empty to disable remote bundles.
const COMMUNITY_PUBLIC_KEY_B64 = 'yruHWK0iAC1kxojUHLL55jK923qZSPF/DsmuTCT8TUk=';

const FALLBACK_PATH = 'automation/community-fallback.json';

const STORAGE_KEYS = {
    meta: 'communityBundleMeta',
    rules: 'communityBundleRules',
    cosmetics: 'communityBundleCosmetics',
    heuristics: 'communityBundleHeuristics',
    publicDirectives: 'communityBundlePublicDirectives',
    publicScriptlets: 'communityBundlePublicScriptlets',
    publicTactics: 'communityBundlePublicTactics',
    privateDirectives: 'communityBundlePrivateDirectives',
    privateScriptlets: 'communityBundlePrivateScriptlets',
    lastAttempt: 'communityBundleLastAttempt',
    lastSuccess: 'communityBundleLastSuccess',
    lastFetch: 'communityBundleLastFetch',
    lastError: 'communityBundleLastError',
};
const BASELINE_STORAGE_KEYS = {
    meta: 'communityBaselineMetaV1',
    rules: 'communityBaselineRulesV1',
    cosmetics: 'communityBaselineCosmeticsV1',
    heuristics: 'communityBaselineHeuristicsV1',
    publicDirectives: 'communityBaselinePublicDirectivesV1',
    publicScriptlets: 'communityBaselinePublicScriptletsV1',
    publicTactics: 'communityBaselinePublicTacticsV1',
};
const OVERLAY_STORAGE_KEYS = {
    index: 'communityOverlayIndexV1',
    payloads: 'communityOverlayPayloadsV1',
};
const LEGACY_PRIVATE_STORAGE_KEYS = {
    directives: 'communityBundleDirectives',
    scriptlets: 'communityBundleScriptlets',
};

const ALARM_NAME = 'community-sync';
const COMMUNITY_FETCH_TIMEOUT_MS = 10000;
const COMMUNITY_OVERLAY_SCHEMA_VERSION = 3;
const COMMUNITY_OVERLAY_TACTIC_SCHEMA_VERSION = COMMUNITY_RULE_SCHEMA_VERSION_TACTICS;
const COMMUNITY_OVERLAY_DEFAULT_TTL_MINUTES = 30;
const COMMUNITY_OVERLAY_MIN_TTL_MINUTES = 10;
const COMMUNITY_OVERLAY_MAX_TTL_MINUTES = 360;
const COMMUNITY_OVERLAY_FETCH_RETRY_MS = 5 * 60 * 1000;
const COMMUNITY_OVERLAY_NEGATIVE_CACHE_MS = 30 * 60 * 1000;
const COMMUNITY_OVERLAY_MAX_ACTIVE = 20;
const COMMUNITY_OVERLAY_MAX_RULES = 150;
const COMMUNITY_OVERLAY_MAX_COSMETIC_SELECTORS = 200;
const COMMUNITY_OVERLAY_MAX_DIRECTIVES = 20;
const COMMUNITY_OVERLAY_MAX_SCRIPTLETS = 20;
const COMMUNITY_OVERLAY_MAX_HEURISTIC_REGEXES = 10;
const COMMUNITY_OVERLAY_MAX_TACTICS = COMMUNITY_TACTIC_OVERLAY_MAX;
const COMMUNITY_PRIVATE_ONLY_KEYS = [
    STORAGE_KEYS.privateDirectives,
    STORAGE_KEYS.privateScriptlets,
    LEGACY_PRIVATE_STORAGE_KEYS.directives,
    LEGACY_PRIVATE_STORAGE_KEYS.scriptlets,
];
const COMMUNITY_STATE_KEYS = [
    ...Object.values(STORAGE_KEYS),
    ...Object.values(BASELINE_STORAGE_KEYS),
    ...Object.values(OVERLAY_STORAGE_KEYS),
    ...Object.values(LEGACY_PRIVATE_STORAGE_KEYS),
];
const COMMUNITY_ROLLBACK_SNAPSHOT_KEYS = [
    STORAGE_KEYS.meta,
    STORAGE_KEYS.rules,
    STORAGE_KEYS.cosmetics,
    STORAGE_KEYS.heuristics,
    STORAGE_KEYS.publicDirectives,
    STORAGE_KEYS.publicScriptlets,
    STORAGE_KEYS.publicTactics,
    STORAGE_KEYS.privateDirectives,
    STORAGE_KEYS.privateScriptlets,
    BASELINE_STORAGE_KEYS.meta,
    BASELINE_STORAGE_KEYS.rules,
    BASELINE_STORAGE_KEYS.cosmetics,
    BASELINE_STORAGE_KEYS.heuristics,
    BASELINE_STORAGE_KEYS.publicDirectives,
    BASELINE_STORAGE_KEYS.publicScriptlets,
    BASELINE_STORAGE_KEYS.publicTactics,
    OVERLAY_STORAGE_KEYS.index,
    OVERLAY_STORAGE_KEYS.payloads,
    STORAGE_KEYS.lastAttempt,
    STORAGE_KEYS.lastSuccess,
    STORAGE_KEYS.lastFetch,
    STORAGE_KEYS.lastError,
    LEGACY_PRIVATE_STORAGE_KEYS.directives,
    LEGACY_PRIVATE_STORAGE_KEYS.scriptlets,
];
const COMMUNITY_ACTIVATION_META_KEYS = [
    'activationStatus',
    'activationRollbackAt',
    'activationRollbackReason',
    'activationRollbackAttemptedVersion',
    'activationRollbackRestoredVersion',
];

const COMMUNITY_ALLOWED_HOSTS = (() => {
    const out = new Set();
    try {
        out.add(new URL(COMMUNITY_URL_DEFAULT).hostname.toLowerCase());
    } catch {
    }
    try {
        const homepageUrl = runtime.getManifest?.()?.homepage_url;
        if ( typeof homepageUrl === 'string' && homepageUrl.trim() !== '' ) {
            const u = new URL(homepageUrl.trim());
            const host = u.hostname.replace(/^www\./i, '').toLowerCase();
            if ( host !== '' ) {
                out.add(`api.${host}`);
            }
        }
    } catch {
    }
    return out;
})();

/******************************************************************************/

const normalizeCommunityURL = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const trimmed = value.trim();
    if ( trimmed === '' ) { return ''; }
    try {
        const parsed = new URL(trimmed);
        if ( parsed.protocol !== 'https:' ) { return ''; }
        const allowCustomHost = isDeveloperModeAllowed &&
            rulesetConfig.developerMode === true;
        if (
            allowCustomHost === false &&
            COMMUNITY_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) === false
        ) {
            return '';
        }
        parsed.hash = '';
        return parsed.toString();
    } catch {
    }
    return '';
};

const normalizeCommunityOverlayTtlMinutes = value => {
    const ttlMinutes = Number(value);
    if ( Number.isFinite(ttlMinutes) === false || ttlMinutes <= 0 ) {
        return COMMUNITY_OVERLAY_DEFAULT_TTL_MINUTES;
    }
    return Math.min(
        COMMUNITY_OVERLAY_MAX_TTL_MINUTES,
        Math.max(COMMUNITY_OVERLAY_MIN_TTL_MINUTES, ttlMinutes)
    );
};

const buildCommunityOverlayURL = (
    communityUrl,
    siteKey,
    {
        baselineVersion = '',
        knownVersion = '',
    } = {}
) => {
    const normalizedUrl = normalizeCommunityURL(communityUrl);
    if ( normalizedUrl === '' || typeof siteKey !== 'string' || siteKey.trim() === '' ) {
        return '';
    }
    try {
        const base = new URL(normalizedUrl);
        const url = new URL(
            `/v1/community/overlay/${encodeURIComponent(siteKey.trim())}.bundle.json`,
            `${base.protocol}//${base.host}`
        );
        if ( typeof baselineVersion === 'string' && baselineVersion.trim() !== '' ) {
            url.searchParams.set('baseline', baselineVersion.trim());
        }
        if ( typeof knownVersion === 'string' && knownVersion.trim() !== '' ) {
            url.searchParams.set('known', knownVersion.trim());
        }
        return url.toString();
    } catch {
    }
    return '';
};

const isPublicCommunityHotfixLane = value => {
    try {
        return COMMUNITY_ALLOWED_HOSTS.has(new URL(value).hostname.toLowerCase());
    } catch {
    }
    return false;
};

const fetchWithTimeout = async (url, options = {}) => {
    let controller;
    let timer;
    try {
        controller = new AbortController();
        timer = self.setTimeout(() => controller.abort(), COMMUNITY_FETCH_TIMEOUT_MS);
    } catch {
    }
    try {
        return await fetch(url, {
            ...options,
            signal: controller?.signal,
            redirect: 'error',
        });
    } finally {
        if ( timer !== undefined ) {
            try { clearTimeout(timer); } catch { }
        }
    }
};

/******************************************************************************/

const base64ToBytes = b64 => {
    try {
        const bin = self.atob(b64);
        const out = new Uint8Array(bin.length);
        for ( let i = 0; i < bin.length; i++ ) {
            out[i] = bin.charCodeAt(i);
        }
        return out;
    } catch {
    }
    return new Uint8Array(0);
};

const sha256Hex = async text => {
    const data = new TextEncoder().encode(text);
    const digest = await self.crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for ( const b of bytes ) {
        hex += b.toString(16).padStart(2, '0');
    }
    return hex;
};

const verifyEd25519 = async (publicKeyBytes, messageBytes, signatureBytes) => {
    if ( self.crypto?.subtle === undefined ) { return false; }
    try {
        const key = await self.crypto.subtle.importKey(
            'raw',
            publicKeyBytes,
            { name: 'Ed25519' },
            false,
            [ 'verify' ]
        );
        return self.crypto.subtle.verify(
            { name: 'Ed25519' },
            key,
            signatureBytes,
            messageBytes
        );
    } catch {
    }
    return false;
};

const buildCommunityPayloadText = ({ bundle, rules, integrityScope }) => {
    const schemaVersion = bundle?.schemaVersion;
    if ( integrityScope === 'full' ) {
        const payloadObj = {
            rules,
            cosmetics: bundle.cosmetics ?? null,
            heuristics: bundle.heuristics ?? null,
            directives: bundle.directives ?? null,
            scriptlets: bundle.scriptlets ?? null,
        };
        if ( Number(schemaVersion) >= COMMUNITY_RULE_SCHEMA_VERSION_TACTICS ) {
            payloadObj.tactics = bundle.tactics ?? null;
        }
        if ( schemaVersion !== undefined ) {
            payloadObj.schemaVersion = schemaVersion;
        }
        return JSON.stringify(payloadObj);
    }
    if ( schemaVersion !== undefined ) {
        return JSON.stringify({
            schemaVersion,
            rules,
        });
    }
    return JSON.stringify(rules);
};

const buildCommunityOverlayPayloadText = ({
    bundle,
    rules,
    cosmetics,
    heuristics,
    directives,
    scriptlets,
    tactics,
} = {}) => JSON.stringify({
    siteKey: bundle?.siteKey,
    baselineVersion: bundle?.baselineVersion,
    ttlMinutes: bundle?.ttlMinutes,
    schemaVersion: Number(bundle?.schemaVersion) || COMMUNITY_OVERLAY_SCHEMA_VERSION,
    rules,
    cosmetics: cosmetics ?? null,
    heuristics: heuristics ?? null,
    directives: directives ?? null,
    scriptlets: scriptlets ?? null,
    ...(Number(bundle?.schemaVersion) >= COMMUNITY_RULE_SCHEMA_VERSION_TACTICS
        ? { tactics: tactics ?? null }
        : {}),
});

const clearCommunityAlarm = () => {
    if ( browser.alarms?.clear === undefined ) { return; }
    return browser.alarms.clear(ALARM_NAME);
};

const scheduleCommunityAlarm = ({ delayMs, periodMs } = {}) => {
    if ( browser.alarms?.create === undefined ) { return; }
    const alarm = {
        when: Date.now() + (
            Number.isFinite(delayMs) && delayMs > 0
                ? delayMs
                : COMMUNITY_SYNC_FAILURE_RETRY_MS
        ),
    };
    if ( Number.isFinite(periodMs) && periodMs > 0 ) {
        alarm.periodInMinutes = Math.max(1, Math.ceil(periodMs / (60 * 1000)));
    }
    browser.alarms.create(ALARM_NAME, alarm);
};

const scheduleCommunityRetryAlarm = (delayMs = COMMUNITY_SYNC_FAILURE_RETRY_MS) =>
    scheduleCommunityAlarm({ delayMs });

const scheduleCommunitySuccessAlarm = ({ ttlHours, delayMs } = {}) => {
    const ttlMs = normalizeCommunitySyncTtlHours(ttlHours) * 60 * 60 * 1000;
    scheduleCommunityAlarm({
        delayMs: Number.isFinite(delayMs) && delayMs > 0 ? delayMs : ttlMs,
        periodMs: ttlMs,
    });
};

const countProtectedCosmeticSelectors = input => {
    if ( input?.hosts instanceof Object === false ) { return 0; }
    let total = 0;
    for ( const [hostPattern, selectors] of Object.entries(input.hosts) ) {
        if ( patternCouldMatchProtectedDomain(hostPattern) === false ) { continue; }
        if ( Array.isArray(selectors) === false ) { continue; }
        total += selectors.length;
    }
    return total;
};

const countProtectedDirectives = input => {
    if ( Array.isArray(input) === false ) { return 0; }
    let total = 0;
    for ( const directive of input ) {
        if ( directive instanceof Object === false ) { continue; }
        const hosts = Array.isArray(directive.hosts) ? directive.hosts : [];
        if ( hosts.some(patternCouldMatchProtectedDomain) === false ) { continue; }
        total += 1;
    }
    return total;
};

const countProtectedTactics = input => {
    if ( Array.isArray(input) === false ) { return 0; }
    let total = 0;
    for ( const tactic of input ) {
        if ( tactic instanceof Object === false ) { continue; }
        const hosts = Array.isArray(tactic.hosts) ? tactic.hosts : [];
        if ( hosts.some(patternCouldMatchProtectedDomain) === false ) { continue; }
        total += 1;
    }
    return total;
};

const sanitizeStringArray = (input, limit, maxLen = 256) => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    for ( const item of input ) {
        if ( typeof item !== 'string' ) { continue; }
        const s = item.trim();
        if ( s === '' || s.length > maxLen ) { continue; }
        out.push(s);
        if ( out.length >= limit ) { break; }
    }
    return out;
};

const sanitizeScopedHostPatterns = (input, limit) => {
    const out = [];
    const seen = new Set();
    for ( const value of sanitizeStringArray(input, limit) ) {
        const normalized = normalizeScopedHostPattern(value);
        if ( normalized === '' || normalized === '*' || normalized === 'all-urls' ) {
            continue;
        }
        if ( patternCouldMatchInternalUnfilteredDomain(normalized) ) { continue; }
        if ( seen.has(normalized) ) { continue; }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
};

const sanitizeCommunityCosmetics = (
    input,
    {
        globalSelectorLimit = 250,
        hostSelectorLimit = 250,
        hostLimit = 500,
    } = {}
) => {
    if ( input instanceof Object === false ) { return null; }
    const out = { all: [], hosts: {} };
    const globalSelectors = sanitizeStringArray(input.all, globalSelectorLimit)
        .filter(selector => isSafeMutationSelector(selector));
    if ( globalSelectors.length !== 0 ) {
        out.all.push(...globalSelectors);
    }
    const hosts = input.hosts;
    if ( hosts instanceof Object ) {
        let hostCount = 0;
        for ( const [ host, selectors ] of Object.entries(hosts) ) {
            const normalizedHost = normalizeScopedHostPattern(host, {
                allowGlobal: false,
            });
            if ( normalizedHost === '' ) { continue; }
            if ( patternCouldMatchInternalUnfilteredDomain(normalizedHost) ) {
                continue;
            }
            if (
                patternCouldMatchProtectedDomain(normalizedHost) &&
                isExactHostnamePattern(normalizedHost) === false
            ) {
                continue;
            }
            const filteredSelectors = sanitizeStringArray(selectors, hostSelectorLimit)
                .filter(selector => isSafeMutationSelector(selector));
            if ( filteredSelectors.length === 0 ) { continue; }
            out.hosts[normalizedHost] = filteredSelectors;
            hostCount += 1;
            if ( hostCount >= hostLimit ) { break; }
        }
    }
    if ( out.all.length === 0 && Object.keys(out.hosts).length === 0 ) {
        return null;
    }
    return out;
};

const sanitizeCommunityHeuristics = (
    input,
    {
        disableHostLimit = 200,
        regexLimit = COMMUNITY_HEURISTIC_SELECTOR_MAX,
        selectorLimit = COMMUNITY_HEURISTIC_SELECTOR_MAX,
    } = {}
) => {
    if ( input instanceof Object === false ) { return null; }
    const out = {};
    const disableHosts = sanitizeScopedHostPatterns(input.disableHosts, disableHostLimit);
    if ( disableHosts.length !== 0 ) {
        out.disableHosts = disableHosts;
    }
    const labelRegexes = normalizeCommunityHeuristicLabelRegexes(
        input.labelRegexes,
        { limit: regexLimit }
    );
    if ( labelRegexes.length !== 0 ) {
        out.labelRegexes = labelRegexes;
    }
    const labelSelectors = sanitizeStringArray(
        input.labelSelectors,
        selectorLimit
    ).filter(selector => isSafeMutationSelector(selector));
    if ( labelSelectors.length !== 0 ) {
        out.labelSelectors = labelSelectors;
    }
    const widgetSelectors = sanitizeStringArray(
        input.widgetSelectors,
        selectorLimit
    ).filter(selector => isSafeMutationSelector(selector));
    if ( widgetSelectors.length !== 0 ) {
        out.widgetSelectors = widgetSelectors;
    }
    if ( input.containerStopSelectors ) {
        out.containerStopSelectors = sanitizeStringArray(input.containerStopSelectors, 80)
            .filter(selector => isSafeMutationSelector(selector));
    }
    const toNum = (v, min, max, fallback) => {
        const n = Number(v);
        if ( Number.isFinite(n) === false ) { return fallback; }
        if ( n < min ) { return min; }
        if ( n > max ) { return max; }
        return n;
    };
    if ( input.maxLabelTextLength !== undefined ) {
        out.maxLabelTextLength = toNum(input.maxLabelTextLength, 10, 80, 40);
    }
    if ( input.minContainerHeight !== undefined ) {
        out.minContainerHeight = toNum(input.minContainerHeight, 30, 300, 60);
    }
    if ( input.minContainerWidth !== undefined ) {
        out.minContainerWidth = toNum(input.minContainerWidth, 60, 600, 120);
    }
    if ( input.minScore !== undefined ) {
        out.minScore = toNum(input.minScore, 1, 10, 4);
    }
    if ( input.minScoreLowConfidence !== undefined ) {
        out.minScoreLowConfidence = toNum(input.minScoreLowConfidence, 1, 12, 5);
    }
    return Object.keys(out).length === 0 ? null : out;
};

const sanitizeCommunityDirectives = (
    input,
    {
        maxEntries = 80,
        maxHosts = 32,
        maxSelectors = 16,
    } = {}
) => {
    if ( Array.isArray(input) === false ) { return null; }
    const out = [];
    for ( const d of input ) {
        if ( d instanceof Object === false ) { continue; }
        const id = typeof d.id === 'string' ? d.id.trim() : '';
        const action = typeof d.action === 'string' ? d.action.trim() : '';
        const selectors = sanitizeStringArray(d.selectors, maxSelectors)
            .filter(selector => isSafeMutationSelector(selector, {
                requireKnownConsent: d.category === 'consent',
            }));
        const sanitizedHosts = sanitizeScopedHostPatterns(d.hosts, maxHosts);
        if (
            id === '' ||
            action === '' ||
            selectors.length === 0 ||
            sanitizedHosts.length === 0
        ) {
            continue;
        }
        const fallbackAction = typeof d.fallbackAction === 'string'
            ? d.fallbackAction.trim()
            : undefined;
        const fallbackSelectors = sanitizeStringArray(d.fallbackSelectors, 8)
            .filter(selector => isSafeMutationSelector(selector, {
                requireKnownConsent: d.category === 'consent',
            }));
        const protectedHosts = sanitizedHosts.filter(patternCouldMatchProtectedDomain);
        if ( protectedHosts.length !== 0 ) {
            if ( action !== 'hide' ) { continue; }
            if ( protectedHosts.some(host => isExactHostnamePattern(host) === false ) ) {
                continue;
            }
        }
        if ( fallbackAction && fallbackAction !== 'hide' ) { continue; }
        if ( fallbackAction === 'hide' && fallbackSelectors.length === 0 ) { continue; }
        out.push({
            id,
            category: typeof d.category === 'string' ? d.category.trim() : 'annoyances',
            hosts: sanitizedHosts,
            action,
            selectors,
            fallbackAction,
            fallbackSelectors,
            postActions: sanitizeStringArray(d.postActions, 4),
            maxApplies: Number.isFinite(Number(d.maxApplies))
                ? Number(d.maxApplies)
                : undefined,
        });
        if ( out.length >= maxEntries ) { break; }
    }
    return out.length === 0 ? null : out;
};

const sanitizeCommunityScriptlets = (input, { maxEntries = 120 } = {}) =>
    canonicalizeCommunityScriptlets(input, { maxEntries });

const sanitizeCommunityTacticsForStorage = (input, {
    maxEntries = COMMUNITY_TACTIC_COMPILED_MAX,
} = {}) => sanitizeCommunityTactics(input, { maxEntries });

const sortObjectEntries = object => Object.fromEntries(
    Object.entries(object || {}).sort(([ left ], [ right ]) => left.localeCompare(right))
);

const sanitizeCommunityRulesForStorage = (
    input,
    schemaVersion,
    { maxRules = Infinity } = {}
) => {
    const normalizedSchemaVersion = normalizeCommunityRuleSchemaVersion(schemaVersion);
    if ( Array.isArray(input) === false ) {
        return {
            schemaVersion: normalizedSchemaVersion || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
            rules: [],
            ruleSanitization: sanitizeCommunityRules([], {
                schemaVersion: normalizedSchemaVersion || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
            }),
        };
    }
    const effectiveSchemaVersion = normalizedSchemaVersion ||
        COMMUNITY_RULE_SCHEMA_VERSION_LEGACY;
    const sanitized = sanitizeCommunityRules(input, {
        schemaVersion: effectiveSchemaVersion,
    });
    const rules = sanitized.rules.slice(
        0,
        Number.isFinite(maxRules) ? maxRules : sanitized.rules.length
    );
    return {
        schemaVersion: effectiveSchemaVersion,
        rules,
        ruleSanitization: sanitized,
    };
};

const sanitizeCommunityPayloadForStorage = (
    input,
    {
        schemaVersion = COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
        maxRules = Infinity,
        maxCosmeticSelectors = 250,
        maxDirectives = 80,
        maxScriptlets = 120,
        maxTactics = COMMUNITY_TACTIC_COMPILED_MAX,
        maxHeuristicRegexes = COMMUNITY_HEURISTIC_SELECTOR_MAX,
    } = {}
) => {
    const sanitizedRules = sanitizeCommunityRulesForStorage(input?.rules, schemaVersion, {
        maxRules,
    });
    return {
        schemaVersion: sanitizedRules.schemaVersion,
        rules: sanitizedRules.rules,
        ruleSanitization: sanitizedRules.ruleSanitization,
        cosmetics: sanitizeCommunityCosmetics(input?.cosmetics, {
            globalSelectorLimit: maxCosmeticSelectors,
            hostSelectorLimit: maxCosmeticSelectors,
        }),
        heuristics: sanitizeCommunityHeuristics(input?.heuristics, {
            regexLimit: maxHeuristicRegexes,
        }),
        publicDirectives: sanitizeCommunityDirectives(input?.directives, {
            maxEntries: maxDirectives,
        }),
        publicScriptlets: sanitizeCommunityScriptlets(input?.scriptlets, {
            maxEntries: maxScriptlets,
        }),
        publicTactics: sanitizeCommunityTacticsForStorage(
            input?.tactics ?? input?.publicTactics,
            { maxEntries: maxTactics }
        ),
    };
};

const mergeUniqueStringArrays = (...inputs) => {
    const out = [];
    const seen = new Set();
    for ( const input of inputs ) {
        if ( Array.isArray(input) === false ) { continue; }
        for ( const value of input ) {
            if ( typeof value !== 'string' || value === '' || seen.has(value) ) { continue; }
            seen.add(value);
            out.push(value);
        }
    }
    return out.length === 0 ? null : out;
};

const mergeCommunityCosmetics = sources => {
    const all = [];
    const seenGlobal = new Set();
    const hosts = {};
    const hostSeen = new Map();
    for ( const source of sources ) {
        if ( source?.cosmetics instanceof Object === false ) { continue; }
        for ( const selector of source.cosmetics.all || [] ) {
            if ( seenGlobal.has(selector) ) { continue; }
            seenGlobal.add(selector);
            all.push(selector);
        }
        for ( const [ host, selectors ] of Object.entries(source.cosmetics.hosts || {}) ) {
            let bucket = hostSeen.get(host);
            if ( bucket === undefined ) {
                bucket = new Set();
                hostSeen.set(host, bucket);
                hosts[host] = [];
            }
            for ( const selector of selectors ) {
                if ( bucket.has(selector) ) { continue; }
                bucket.add(selector);
                hosts[host].push(selector);
            }
        }
    }
    if ( all.length === 0 && Object.keys(hosts).length === 0 ) { return null; }
    return {
        all,
        hosts: sortObjectEntries(hosts),
    };
};

const mergeCommunityHeuristics = sources => {
    const scalars = new Map();
    const out = {};
    const arrayFields = [
        'disableHosts',
        'labelRegexes',
        'labelSelectors',
        'widgetSelectors',
        'containerStopSelectors',
    ];
    for ( const field of arrayFields ) {
        const merged = mergeUniqueStringArrays(
            ...sources.map(source => source?.heuristics?.[field])
        );
        if ( merged !== null ) {
            out[field] = merged;
        }
    }
    for ( const field of [
        'maxLabelTextLength',
        'minContainerHeight',
        'minContainerWidth',
        'minScore',
        'minScoreLowConfidence',
    ] ) {
        for ( const source of sources ) {
            const value = source?.heuristics?.[field];
            if ( Number.isFinite(Number(value)) === false || scalars.has(field) ) { continue; }
            scalars.set(field, Number(value));
        }
    }
    for ( const [ field, value ] of scalars ) {
        out[field] = value;
    }
    return Object.keys(out).length === 0 ? null : out;
};

const mergeCommunityDirectives = sources => {
    const out = [];
    const seen = new Set();
    for ( const source of sources ) {
        const directives = source?.publicDirectives;
        if ( Array.isArray(directives) === false ) { continue; }
        for ( const directive of directives ) {
            const id = typeof directive?.id === 'string' ? directive.id : '';
            if ( id === '' || seen.has(id) ) { continue; }
            seen.add(id);
            out.push(structuredClone(directive));
        }
    }
    return out.length === 0 ? null : out;
};

const mergeCommunityScriptlets = sources => {
    const merged = [];
    for ( const source of sources ) {
        if ( Array.isArray(source?.publicScriptlets) === false ) { continue; }
        merged.push(...structuredClone(source.publicScriptlets));
    }
    return sanitizeCommunityScriptlets(merged, {
        maxEntries: COMMUNITY_OVERLAY_MAX_ACTIVE * COMMUNITY_OVERLAY_MAX_SCRIPTLETS,
    });
};

const normalizeOverlayIndexEntry = (input = {}) => {
    const siteKey = typeof input.siteKey === 'string'
        ? input.siteKey.trim()
        : '';
    if ( siteKey === '' ) { return null; }
    return {
        siteKey,
        version: typeof input.version === 'string' ? input.version.trim() : '',
        baselineVersion: typeof input.baselineVersion === 'string'
            ? input.baselineVersion.trim()
            : '',
        ttlMinutes: normalizeCommunityOverlayTtlMinutes(input.ttlMinutes),
        lastAttempt: Number(input.lastAttempt) || 0,
        lastSuccess: Number(input.lastSuccess) || 0,
        lastError: typeof input.lastError === 'string' ? input.lastError.trim() : '',
        lastReason: typeof input.lastReason === 'string' ? input.lastReason.trim() : '',
        lastStatus: typeof input.lastStatus === 'string' ? input.lastStatus.trim() : '',
        negativeUntil: Number(input.negativeUntil) || 0,
    };
};

const normalizeOverlayIndex = input => {
    if ( input instanceof Object === false ) { return {}; }
    const out = {};
    for ( const [ siteKey, entry ] of Object.entries(input) ) {
        const normalized = normalizeOverlayIndexEntry({
            siteKey,
            ...(entry instanceof Object ? entry : {}),
        });
        if ( normalized === null ) { continue; }
        out[normalized.siteKey] = normalized;
    }
    return sortObjectEntries(out);
};

const normalizeOverlayPayload = (input = {}) => {
    const siteKey = typeof input.siteKey === 'string'
        ? input.siteKey.trim()
        : '';
    if ( siteKey === '' ) { return null; }
    return {
        siteKey,
        version: typeof input.version === 'string' ? input.version.trim() : '',
        baselineVersion: typeof input.baselineVersion === 'string'
            ? input.baselineVersion.trim()
            : '',
        schemaVersion: normalizeCommunityRuleSchemaVersion(input.schemaVersion) ||
            COMMUNITY_OVERLAY_SCHEMA_VERSION,
        ttlMinutes: normalizeCommunityOverlayTtlMinutes(input.ttlMinutes),
        rules: Array.isArray(input.rules) ? structuredClone(input.rules) : [],
        cosmetics: input.cosmetics instanceof Object
            ? structuredClone(input.cosmetics)
            : null,
        heuristics: input.heuristics instanceof Object
            ? structuredClone(input.heuristics)
            : null,
        publicDirectives: Array.isArray(input.publicDirectives)
            ? structuredClone(input.publicDirectives)
            : null,
        publicScriptlets: Array.isArray(input.publicScriptlets)
            ? structuredClone(input.publicScriptlets)
            : null,
        publicTactics: Array.isArray(input.publicTactics)
            ? structuredClone(input.publicTactics)
            : null,
    };
};

const normalizeOverlayPayloads = input => {
    if ( input instanceof Object === false ) { return {}; }
    const out = {};
    for ( const [ siteKey, payload ] of Object.entries(input) ) {
        const normalized = normalizeOverlayPayload({
            siteKey,
            ...(payload instanceof Object ? payload : {}),
        });
        if ( normalized === null ) { continue; }
        out[normalized.siteKey] = normalized;
    }
    return sortObjectEntries(out);
};

const sortOverlaySources = (index, payloads) => Object.values(payloads)
    .map(payload => {
        const entry = index?.[payload.siteKey];
        return {
            ...payload,
            _sortTs: Math.max(
                Number(entry?.lastSuccess) || 0,
                Number(entry?.lastAttempt) || 0
            ),
        };
    })
    .sort((left, right) => right._sortTs - left._sortTs)
    .map(({ _sortTs, ...payload }) => payload);

const buildCompiledCommunityState = ({
    baseline,
    overlays = [],
} = {}) => {
    const sources = [
        ...overlays,
        baseline,
    ].filter(source => source instanceof Object);
    if ( sources.length === 1 ) {
        const [ source ] = sources;
        return {
            schemaVersion: Number(source?.schemaVersion) || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
            rules: Array.isArray(source?.rules) ? structuredClone(source.rules) : [],
            cosmetics: source?.cosmetics instanceof Object
                ? structuredClone(source.cosmetics)
                : null,
            heuristics: source?.heuristics instanceof Object
                ? structuredClone(source.heuristics)
                : null,
            publicDirectives: Array.isArray(source?.publicDirectives)
                ? structuredClone(source.publicDirectives)
                : null,
            publicScriptlets: Array.isArray(source?.publicScriptlets)
                ? structuredClone(source.publicScriptlets)
                : null,
            publicTactics: Array.isArray(source?.publicTactics)
                ? structuredClone(source.publicTactics)
                : null,
            tacticsDroppedAtCompile: 0,
            activeOverlayCount: overlays.length,
        };
    }
    const highestSchemaVersion = sources.reduce((maxVersion, source) => (
        Math.max(maxVersion, Number(source.schemaVersion) || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY)
    ), COMMUNITY_RULE_SCHEMA_VERSION_LEGACY);
    const rules = [];
    for ( const source of sources ) {
        if ( Array.isArray(source.rules) === false ) { continue; }
        rules.push(...structuredClone(source.rules));
    }
    const mergedTactics = mergeCommunityTactics(sources, {
        maxEntries: COMMUNITY_TACTIC_COMPILED_MAX,
    });
    return {
        schemaVersion: highestSchemaVersion,
        rules,
        cosmetics: mergeCommunityCosmetics(sources),
        heuristics: mergeCommunityHeuristics(sources),
        publicDirectives: mergeCommunityDirectives(sources),
        publicScriptlets: mergeCommunityScriptlets(sources),
        publicTactics: mergedTactics.tactics,
        tacticsDroppedAtCompile: mergedTactics.dropped,
        activeOverlayCount: overlays.length,
    };
};

const mergeQuotaByClassCounts = (left = {}, right = {}) => ({
    exactExceptions: (Number(left.exactExceptions) || 0) + (Number(right.exactExceptions) || 0),
    exactRedirects: (Number(left.exactRedirects) || 0) + (Number(right.exactRedirects) || 0),
    exactBlocks: (Number(left.exactBlocks) || 0) + (Number(right.exactBlocks) || 0),
    broadBlocks: (Number(left.broadBlocks) || 0) + (Number(right.broadBlocks) || 0),
    regexBlocks: (Number(left.regexBlocks) || 0) + (Number(right.regexBlocks) || 0),
});

const mergeCommunityApplyResult = (applied, ruleSanitization) => {
    if ( ruleSanitization instanceof Object === false ) {
        return applied;
    }
    const sanitizerDropped = ruleSanitization.dropped instanceof Object
        ? ruleSanitization.dropped
        : {};
    const existingDropped = applied?.dropped instanceof Object
        ? applied.dropped
        : {};
    const dropped = {
        unsupportedAction: (Number(existingDropped.unsupportedAction) || 0) +
            (Number(sanitizerDropped.unsupportedAction) || 0),
        unsafeScope: (Number(existingDropped.unsafeScope) || 0) +
            (Number(sanitizerDropped.unsafeScope) || 0),
        unsupportedRedirectPath: (Number(existingDropped.unsupportedRedirectPath) || 0) +
            (Number(sanitizerDropped.unsupportedRedirectPath) || 0),
        quota: (Number(existingDropped.quota) || 0) +
            (Number(sanitizerDropped.quota) || 0),
        regexUnsupported: (Number(existingDropped.regexUnsupported) || 0) +
            (Number(sanitizerDropped.regexUnsupported) || 0),
        quotaByClass: mergeQuotaByClassCounts(
            existingDropped.quotaByClass,
            sanitizerDropped.quotaByClass
        ),
    };
    return {
        ...(applied instanceof Object ? applied : {}),
        dropped,
        droppedQuota: (Number(applied?.droppedQuota) || 0) + (Number(sanitizerDropped.quota) || 0),
        droppedUnsafe: (
            dropped.unsupportedAction +
            dropped.unsafeScope +
            dropped.unsupportedRedirectPath
        ),
    };
};

/******************************************************************************/

const loadFallbackRules = async ( ) => {
    try {
        const url = runtime.getURL(FALLBACK_PATH);
        const res = await fetch(url);
        if ( res.ok === false ) { return []; }
        const rules = await res.json();
        return Array.isArray(rules) ? rules : [];
    } catch {
    }
    return [];
};

const removeStoredCommunityKeys = keys =>
    Promise.all(keys.map(key => localRemove(key)));

const cloneValue = value => value === undefined
    ? undefined
    : structuredClone(value);

const readLocalStorageSnapshot = async keys => {
    if ( browser.storage?.local?.get === undefined ) { return {}; }
    try {
        const bin = await browser.storage.local.get(keys);
        if ( bin instanceof Object === false ) { return {}; }
        const snapshot = {};
        for ( const key of keys ) {
            if ( Object.hasOwn(bin, key) === false ) { continue; }
            snapshot[key] = cloneValue(bin[key]);
        }
        return snapshot;
    } catch {
    }
    return {};
};

const restoreLocalStorageSnapshot = async (snapshot, keys) => {
    const writes = {};
    const removes = [];
    for ( const key of keys ) {
        if ( Object.hasOwn(snapshot, key) ) {
            writes[key] = cloneValue(snapshot[key]);
            continue;
        }
        removes.push(key);
    }
    const jobs = [];
    if ( Object.keys(writes).length !== 0 ) {
        jobs.push(browser.storage.local.set(writes));
    }
    if ( removes.length !== 0 ) {
        jobs.push(browser.storage.local.remove(removes));
    }
    await Promise.all(jobs);
};

const readCommunityBaselineState = async () => {
    const [
        meta,
        rules,
        cosmetics,
        heuristics,
        publicDirectives,
        publicScriptlets,
        publicTactics,
    ] = await Promise.all([
        localRead(BASELINE_STORAGE_KEYS.meta),
        localRead(BASELINE_STORAGE_KEYS.rules),
        localRead(BASELINE_STORAGE_KEYS.cosmetics),
        localRead(BASELINE_STORAGE_KEYS.heuristics),
        localRead(BASELINE_STORAGE_KEYS.publicDirectives),
        localRead(BASELINE_STORAGE_KEYS.publicScriptlets),
        localRead(BASELINE_STORAGE_KEYS.publicTactics),
    ]);
    return {
        meta: meta instanceof Object ? meta : {},
        schemaVersion: normalizeCommunityRuleSchemaVersion(meta?.schemaVersion) ||
            COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
        rules: Array.isArray(rules) ? rules : [],
        cosmetics: cosmetics instanceof Object ? cosmetics : null,
        heuristics: heuristics instanceof Object ? heuristics : null,
        publicDirectives: Array.isArray(publicDirectives) ? publicDirectives : null,
        publicScriptlets: Array.isArray(publicScriptlets) ? publicScriptlets : null,
        publicTactics: Array.isArray(publicTactics) ? publicTactics : null,
    };
};

const readCommunityOverlayState = async () => {
    const [
        rawIndex,
        rawPayloads,
    ] = await Promise.all([
        localRead(OVERLAY_STORAGE_KEYS.index),
        localRead(OVERLAY_STORAGE_KEYS.payloads),
    ]);
    const index = normalizeOverlayIndex(rawIndex);
    const payloads = normalizeOverlayPayloads(rawPayloads);
    for ( const siteKey of Object.keys(index) ) {
        if ( payloads[siteKey] !== undefined ) { continue; }
        if ( (Number(index[siteKey]?.negativeUntil) || 0) > Date.now() ) { continue; }
        delete index[siteKey];
    }
    for ( const siteKey of Object.keys(payloads) ) {
        if ( index[siteKey] !== undefined ) { continue; }
        delete payloads[siteKey];
    }
    return {
        index,
        payloads,
    };
};

const persistOverlayState = async ({ index, payloads }) => Promise.all([
    localWrite(OVERLAY_STORAGE_KEYS.index, normalizeOverlayIndex(index)),
    localWrite(OVERLAY_STORAGE_KEYS.payloads, normalizeOverlayPayloads(payloads)),
]);

const ensureCommunityBaselineMigration = async () => {
    const baselineMeta = await localRead(BASELINE_STORAGE_KEYS.meta);
    if ( baselineMeta instanceof Object ) { return false; }
    const [
        meta,
        rules,
        cosmetics,
        heuristics,
        publicDirectives,
        publicScriptlets,
        publicTactics,
    ] = await Promise.all([
        localRead(STORAGE_KEYS.meta),
        localRead(STORAGE_KEYS.rules),
        localRead(STORAGE_KEYS.cosmetics),
        localRead(STORAGE_KEYS.heuristics),
        localRead(STORAGE_KEYS.publicDirectives),
        localRead(STORAGE_KEYS.publicScriptlets),
        localRead(STORAGE_KEYS.publicTactics),
    ]);
    if (
        meta instanceof Object === false &&
        Array.isArray(rules) === false &&
        cosmetics instanceof Object === false &&
        heuristics instanceof Object === false &&
        Array.isArray(publicDirectives) === false &&
        Array.isArray(publicScriptlets) === false &&
        Array.isArray(publicTactics) === false
    ) {
        return false;
    }
    await Promise.all([
        localWrite(BASELINE_STORAGE_KEYS.meta, meta instanceof Object ? meta : {}),
        localWrite(BASELINE_STORAGE_KEYS.rules, Array.isArray(rules) ? rules : []),
        localWrite(BASELINE_STORAGE_KEYS.cosmetics, cosmetics instanceof Object ? cosmetics : null),
        localWrite(BASELINE_STORAGE_KEYS.heuristics, heuristics instanceof Object ? heuristics : null),
        localWrite(
            BASELINE_STORAGE_KEYS.publicDirectives,
            Array.isArray(publicDirectives) ? publicDirectives : null
        ),
        localWrite(
            BASELINE_STORAGE_KEYS.publicScriptlets,
            Array.isArray(publicScriptlets) ? publicScriptlets : null
        ),
        localWrite(
            BASELINE_STORAGE_KEYS.publicTactics,
            Array.isArray(publicTactics) ? publicTactics : null
        ),
    ]);
    return true;
};

const getCommunityApplyError = applied => {
    const rawError = typeof applied?.error === 'string'
        ? applied.error.trim()
        : applied?.error instanceof Error
            ? applied.error.message
            : '';
    return rawError.replace(/^Error:\s*/i, '').trim();
};

const enforceOverlayCapacity = (
    index,
    payloads,
    { protectSiteKey = '' } = {}
) => {
    const activeSiteKeys = Object.keys(payloads);
    if ( activeSiteKeys.length <= COMMUNITY_OVERLAY_MAX_ACTIVE ) { return; }
    const candidates = activeSiteKeys
        .filter(siteKey => siteKey !== protectSiteKey)
        .sort((left, right) => {
            const leftTs = Math.max(
                Number(index?.[left]?.lastSuccess) || 0,
                Number(index?.[left]?.lastAttempt) || 0
            );
            const rightTs = Math.max(
                Number(index?.[right]?.lastSuccess) || 0,
                Number(index?.[right]?.lastAttempt) || 0
            );
            return leftTs - rightTs;
        });
    while ( Object.keys(payloads).length > COMMUNITY_OVERLAY_MAX_ACTIVE ) {
        const siteKey = candidates.shift();
        if ( typeof siteKey !== 'string' || siteKey === '' ) { break; }
        delete payloads[siteKey];
        delete index[siteKey];
    }
};

const buildCommunityMetaCounts = ({
    applied,
    compiled,
    baselineMeta,
    overlayIndex,
    lastOverlaySiteKey = '',
    lastOverlayVersion = '',
    lastOverlayReason = '',
    lastOverlayStatus = '',
} = {}) => {
    const overlayEntries = Object.values(overlayIndex || {});
    const negativeCacheCount = overlayEntries.filter(entry => (
        (Number(entry?.negativeUntil) || 0) > Date.now()
    )).length;
    return {
        applied,
        schemaVersion: compiled?.schemaVersion || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
        cosmeticsCount: countCommunityCosmeticSelectors(compiled?.cosmetics),
        hostCosmeticsCount: countHostSpecificCommunityCosmeticSelectors(compiled?.cosmetics),
        protectedCosmeticsCount: countProtectedCosmeticSelectors(compiled?.cosmetics),
        heuristicRegexCount: countCommunityHeuristicLabelRegexes(compiled?.heuristics),
        directivesCount: compiled?.publicDirectives?.length || 0,
        protectedDirectivesCount: countProtectedDirectives(compiled?.publicDirectives),
        scriptletsCount: compiled?.publicScriptlets?.length || 0,
        tacticsCount: compiled?.publicTactics?.length || 0,
        publicDirectivesCount: compiled?.publicDirectives?.length || 0,
        publicScriptletsCount: compiled?.publicScriptlets?.length || 0,
        publicTacticsCount: compiled?.publicTactics?.length || 0,
        proofDirectivesCount: 0,
        proofScriptletsCount: 0,
        protectedTacticsCount: countProtectedTactics(compiled?.publicTactics),
        tacticsDroppedAtCompile: Math.max(0, Number(compiled?.tacticsDroppedAtCompile) || 0),
        hotfixLane: 'public',
        extrasSigned: true,
        remoteDirectiveFeaturesEnabled: Boolean(
            compiled?.publicDirectives?.length ||
            compiled?.publicScriptlets?.length ||
            compiled?.publicTactics?.length
        ),
        baselineVersion: typeof baselineMeta?.version === 'string'
            ? baselineMeta.version
            : 'unknown',
        baselineLastAttempt: Number(baselineMeta?.lastAttempt) || 0,
        baselineLastSuccess: Number(baselineMeta?.lastSuccess) || 0,
        baselineLastError: typeof baselineMeta?.lastError === 'string'
            ? baselineMeta.lastError
            : '',
        activeOverlayCount: Math.max(0, Number(compiled?.activeOverlayCount) || 0),
        overlayNegativeCacheCount: negativeCacheCount,
        lastOverlaySiteKey,
        lastOverlayVersion,
        lastOverlayReason,
        lastOverlayStatus,
    };
};

const buildCompiledCommunityMetaPatch = ({
    baselineMeta,
    compiled,
    overlayIndex,
    lastOverlaySiteKey = '',
    lastOverlayVersion = '',
    lastOverlayReason = '',
    lastOverlayStatus = '',
} = {}) => ({
    version: typeof baselineMeta?.version === 'string' && baselineMeta.version !== ''
        ? baselineMeta.version
        : 'unknown',
    schemaVersion: compiled?.schemaVersion || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
    generatedAt: baselineMeta?.generatedAt,
    ttlHours: normalizeCommunitySyncTtlHours(baselineMeta?.ttlHours),
    retryMinutes: COMMUNITY_SYNC_FAILURE_RETRY_MS / (60 * 1000),
    integrity: typeof baselineMeta?.integrity === 'string'
        ? baselineMeta.integrity
        : '',
    extrasSigned: baselineMeta?.extrasSigned !== false,
    hotfixLane: typeof baselineMeta?.hotfixLane === 'string'
        ? baselineMeta.hotfixLane
        : 'public',
    ...buildCommunityMetaCounts({
        compiled,
        baselineMeta,
        overlayIndex,
        lastOverlaySiteKey,
        lastOverlayVersion,
        lastOverlayReason,
        lastOverlayStatus,
    }),
});

const writeCompiledCommunityState = async ({
    compiled,
    metaPatch = {},
    attemptedAt = Date.now(),
    fetchAt = attemptedAt,
    ruleSanitization = null,
} = {}) => {
    const activationSnapshot = await snapshotCommunityActivationState({
        attemptedAt,
    });
    const rawApplied = await updateCommunityRules(compiled?.rules || [], {
        source: 'remote',
        version: metaPatch.version,
        schemaVersion: compiled?.schemaVersion,
    });
    const applyError = getCommunityApplyError(rawApplied);
    if ( applyError !== '' ) {
        throw new Error(`apply failed: ${applyError}`);
    }
    const applied = mergeCommunityApplyResult(rawApplied, ruleSanitization);
    const metaToStore = {
        ...metaPatch,
        applied,
    };
    await Promise.all([
        localWrite(STORAGE_KEYS.rules, compiled?.rules || []),
        localWrite(STORAGE_KEYS.meta, metaToStore),
        localWrite(STORAGE_KEYS.cosmetics, compiled?.cosmetics ?? null),
        localWrite(STORAGE_KEYS.heuristics, compiled?.heuristics ?? null),
        localWrite(STORAGE_KEYS.publicDirectives, compiled?.publicDirectives ?? null),
        localWrite(STORAGE_KEYS.publicScriptlets, compiled?.publicScriptlets ?? null),
        localWrite(STORAGE_KEYS.publicTactics, compiled?.publicTactics ?? null),
        localWrite(STORAGE_KEYS.privateDirectives, null),
        localWrite(STORAGE_KEYS.privateScriptlets, null),
        localRemove(LEGACY_PRIVATE_STORAGE_KEYS.directives),
        localRemove(LEGACY_PRIVATE_STORAGE_KEYS.scriptlets),
        localWrite(STORAGE_KEYS.lastAttempt, attemptedAt),
        localWrite(STORAGE_KEYS.lastFetch, fetchAt),
    ]);
    return {
        applied,
        metaToStore,
        activationSnapshot,
    };
};

const mergeCommunityExtras = (...inputs) => {
    const out = [];
    for ( const input of inputs ) {
        if ( Array.isArray(input) === false ) { continue; }
        out.push(...input);
    }
    return out.length === 0 ? null : out;
};

const clearCommunityActivationMeta = meta => {
    const out = meta instanceof Object
        ? { ...meta }
        : {};
    for ( const key of COMMUNITY_ACTIVATION_META_KEYS ) {
        delete out[key];
    }
    return out;
};

const normalizeRollbackReason = reason => {
    if ( reason instanceof Error ) { return reason.message; }
    return typeof reason === 'string'
        ? reason.trim()
        : String(reason || '').trim();
};

const buildCommunityActivationMeta = (meta, patch = {}) =>
    Object.assign(clearCommunityActivationMeta(meta), patch);

export const canonicalizeCommunityScriptlets = (
    input,
    { maxEntries = 120 } = {}
) => {
    if ( Array.isArray(input) === false ) { return null; }
    const grouped = new Map();
    for ( const entry of input ) {
        if ( entry instanceof Object === false ) { continue; }
        const rulesetId = typeof entry.rulesetId === 'string'
            ? entry.rulesetId.trim()
            : '';
        const token = typeof entry.token === 'string'
            ? entry.token.trim()
            : '';
        if ( rulesetId === '' || token === '' ) { continue; }
        if ( isRemoteScriptletAllowed(token) === false ) { continue; }
        const world = entry.world === 'MAIN' ? 'MAIN' : 'ISOLATED';
        const key = `${rulesetId}\n${token}\n${world}`;
        let bucket = grouped.get(key);
        if ( bucket === undefined ) {
            if ( grouped.size >= maxEntries ) { continue; }
            bucket = {
                rulesetId,
                token,
                world,
                hosts: new Set(),
            };
            grouped.set(key, bucket);
        }
        const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
        for ( const host of hosts ) {
            const normalizedHost = normalizeScopedHostPattern(host, {
                allowGlobal: false,
            });
            if ( normalizedHost === '' ) { continue; }
            if ( patternCouldMatchInternalUnfilteredDomain(normalizedHost) ) { continue; }
            if ( patternCouldMatchProtectedDomain(normalizedHost) ) { continue; }
            bucket.hosts.add(normalizedHost);
        }
    }
    const out = [];
    for ( const bucket of grouped.values() ) {
        const hosts = Array.from(bucket.hosts).sort();
        if ( hosts.length === 0 ) { continue; }
        out.push({
            rulesetId: bucket.rulesetId,
            token: bucket.token,
            hosts,
            world: bucket.world,
        });
    }
    return out.length === 0 ? null : out;
};

const readStoredCommunityInjectableSnapshot = async () => {
    const [
        cosmetics,
        heuristics,
        publicDirectives,
        publicScriptlets,
        publicTactics,
        privateDirectives,
        privateScriptlets,
        legacyDirectives,
        legacyScriptlets,
    ] = await Promise.all([
        localRead(STORAGE_KEYS.cosmetics),
        localRead(STORAGE_KEYS.heuristics),
        localRead(STORAGE_KEYS.publicDirectives),
        localRead(STORAGE_KEYS.publicScriptlets),
        localRead(STORAGE_KEYS.publicTactics),
        localRead(STORAGE_KEYS.privateDirectives),
        localRead(STORAGE_KEYS.privateScriptlets),
        localRead(LEGACY_PRIVATE_STORAGE_KEYS.directives),
        localRead(LEGACY_PRIVATE_STORAGE_KEYS.scriptlets),
    ]);
    return {
        cosmetics: cosmetics ?? null,
        heuristics: heuristics ?? null,
        publicDirectives: publicDirectives ?? null,
        publicScriptlets: publicScriptlets ?? null,
        publicTactics: publicTactics ?? null,
        privateDirectives: privateDirectives ?? null,
        privateScriptlets: privateScriptlets ?? null,
        legacyDirectives: legacyDirectives ?? null,
        legacyScriptlets: legacyScriptlets ?? null,
    };
};

const snapshotToInjectableState = snapshot => ({
    cosmetics: snapshot?.cosmetics ?? null,
    heuristics: snapshot?.heuristics ?? null,
    directives: mergeCommunityExtras(
        snapshot?.publicDirectives,
        snapshot?.privateDirectives,
        snapshot?.legacyDirectives
    ),
    scriptlets: mergeCommunityExtras(
        snapshot?.publicScriptlets,
        snapshot?.privateScriptlets,
        snapshot?.legacyScriptlets
    ),
    tactics: snapshot?.publicTactics ?? null,
});

const readStoredCommunityInjectableState = async ( ) =>
    snapshotToInjectableState(await readStoredCommunityInjectableSnapshot());

const buildPrivateStateAfterScrub = beforeSnapshot => snapshotToInjectableState({
    ...beforeSnapshot,
    privateDirectives: null,
    privateScriptlets: null,
    legacyDirectives: null,
    legacyScriptlets: null,
});

export async function scrubPrivateCommunityState(
    cleanupReason = 'developer-mode-off'
) {
    const beforeSnapshot = await readStoredCommunityInjectableSnapshot();
    const beforeState = snapshotToInjectableState(beforeSnapshot);
    const afterState = buildPrivateStateAfterScrub(beforeSnapshot);
    await removeStoredCommunityKeys(COMMUNITY_PRIVATE_ONLY_KEYS);
    const requiresInjectableRefresh = hasCommunityInjectableStateChanged(
        beforeState,
        afterState
    );
    return {
        cleanupReason: requiresInjectableRefresh ? cleanupReason : '',
        requiresInjectableRefresh,
    };
}

const snapshotCommunityActivationState = async ({ candidateMeta, attemptedAt } = {}) => {
    const [
        activeRules,
        storageSnapshot,
    ] = await Promise.all([
        getActiveCommunityRules(),
        readLocalStorageSnapshot(COMMUNITY_ROLLBACK_SNAPSHOT_KEYS),
    ]);
    return {
        activeRules,
        storageSnapshot,
        attemptedAt: Number(attemptedAt) || Date.now(),
        candidateMeta: candidateMeta instanceof Object
            ? cloneValue(candidateMeta)
            : null,
    };
};

export async function finalizeCommunityActivationSuccess(activation) {
    if ( activation instanceof Object === false ) { return {}; }
    const now = Date.now();
    const currentMeta = await localRead(STORAGE_KEYS.meta);
    const nextMeta = buildCommunityActivationMeta(currentMeta);
    const writes = [
        localWrite(STORAGE_KEYS.meta, nextMeta),
        localWrite(STORAGE_KEYS.lastSuccess, now),
        localRemove(STORAGE_KEYS.lastError),
    ];
    if ( activation.kind === 'baseline' ) {
        writes.push(
            localWrite(BASELINE_STORAGE_KEYS.meta, {
                ...(activation?.baselineMeta instanceof Object
                    ? activation.baselineMeta
                    : await localRead(BASELINE_STORAGE_KEYS.meta) || {}),
                lastSuccess: now,
                lastError: '',
            })
        );
        scheduleCommunitySuccessAlarm({
            ttlHours: activation?.candidateMeta?.ttlHours,
        });
    } else if (
        activation.kind === 'overlay' &&
        typeof activation.overlaySiteKey === 'string' &&
        activation.overlaySiteKey !== ''
    ) {
        const overlayState = await readCommunityOverlayState();
        const entry = normalizeOverlayIndexEntry({
            siteKey: activation.overlaySiteKey,
            ...(overlayState.index[activation.overlaySiteKey] || {}),
            version: activation.overlayVersion || overlayState.index[activation.overlaySiteKey]?.version,
            lastSuccess: now,
            lastError: '',
            lastStatus: activation.overlayStatus || 'updated',
            lastReason: activation.overlayReason ||
                overlayState.index[activation.overlaySiteKey]?.lastReason ||
                '',
        });
        if ( entry !== null ) {
            overlayState.index[activation.overlaySiteKey] = entry;
            writes.push(persistOverlayState(overlayState));
        }
    }
    await Promise.all(writes);
    return {
        meta: nextMeta,
        lastSuccess: now,
    };
}

export async function rollbackCommunityActivation(activation, reason) {
    const failureMessage = normalizeRollbackReason(reason) || 'activation failed';
    const attemptedAt = Number(activation?.attemptedAt) || Date.now();
    const storageSnapshot = activation?.storageSnapshot instanceof Object
        ? activation.storageSnapshot
        : {};
    const candidateMeta = activation?.candidateMeta instanceof Object
        ? activation.candidateMeta
        : {};
    const restoredMeta = Object.hasOwn(storageSnapshot, STORAGE_KEYS.meta)
        ? storageSnapshot[STORAGE_KEYS.meta]
        : undefined;
    const restoreResult = await updateCommunityRules(
        Array.isArray(activation?.activeRules) ? activation.activeRules : [],
        {
            source: 'rollback',
            version: restoredMeta?.version,
            schemaVersion: restoredMeta?.schemaVersion,
        }
    );
    const restoreError = getCommunityApplyError(restoreResult);
    const effectiveFailureMessage = [
        failureMessage,
        restoreError !== ''
            ? `rollback community rules failed: ${restoreError}`
            : '',
    ].filter(part => part !== '').join('; ');
    await restoreLocalStorageSnapshot(storageSnapshot, COMMUNITY_ROLLBACK_SNAPSHOT_KEYS);
    const rollbackMeta = buildCommunityActivationMeta(restoredMeta, {
        activationStatus: 'rolled_back',
        activationRollbackAt: attemptedAt,
        activationRollbackReason: effectiveFailureMessage,
        activationRollbackAttemptedVersion: typeof candidateMeta?.version === 'string'
            ? candidateMeta.version
            : '',
        activationRollbackRestoredVersion: typeof restoredMeta?.version === 'string'
            ? restoredMeta.version
            : '',
    });
    await Promise.all([
        localWrite(STORAGE_KEYS.meta, rollbackMeta),
        localWrite(STORAGE_KEYS.lastAttempt, attemptedAt),
        localWrite(STORAGE_KEYS.lastFetch, attemptedAt),
        localWrite(STORAGE_KEYS.lastError, effectiveFailureMessage),
    ]);
    scheduleCommunityRetryAlarm();
    return {
        meta: rollbackMeta,
        lastError: effectiveFailureMessage,
    };
}

const clearCommunityState = async cleanupReason => {
    const beforeState = await readStoredCommunityInjectableState();
    clearCommunityAlarm();
    const applied = await updateCommunityRules([], {
        source: 'cleanup',
        schemaVersion: COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
    });
    await removeStoredCommunityKeys(COMMUNITY_STATE_KEYS);
    return {
        source: 'cleanup',
        cleanupReason,
        applied,
        requiresInjectableRefresh: hasCommunityInjectableStateChanged(
            beforeState,
            null
        ),
    };
};

async function applyFallback(reason, baseResult = {}) {
    const message = reason instanceof Error ? reason.message : String(reason);
    ubolErr(`community-sync: ${message}`);
    const now = Date.now();
    const privateCleanup = await scrubPrivateCommunityState(
        'fallback-private-state'
    );
    const requiresInjectableRefresh = Boolean(
        baseResult.requiresInjectableRefresh ||
        privateCleanup.requiresInjectableRefresh
    );
    const cleanupReason = privateCleanup.cleanupReason ||
        baseResult.cleanupReason ||
        '';
    try {
        const baselineMeta = await localRead(BASELINE_STORAGE_KEYS.meta);
        await Promise.all([
            localWrite(STORAGE_KEYS.lastError, message),
            localWrite(STORAGE_KEYS.lastAttempt, now),
            localWrite(STORAGE_KEYS.lastFetch, now),
            localWrite(BASELINE_STORAGE_KEYS.meta, {
                ...(baselineMeta instanceof Object ? baselineMeta : {}),
                lastAttempt: now,
                lastFetch: now,
                lastError: message,
            }),
        ]);
    } catch (error) {
        ubolErr(error);
    }
    scheduleCommunityRetryAlarm();

    const [ storedRules, storedMeta ] = await Promise.all([
        localRead(STORAGE_KEYS.rules),
        localRead(STORAGE_KEYS.meta),
    ]);
    let storedRestoreError = '';
    if ( Array.isArray(storedRules) && storedRules.length !== 0 ) {
        const applied = await updateCommunityRules(storedRules, {
            source: 'stored',
            version: storedMeta?.version,
            schemaVersion: storedMeta?.schemaVersion,
        });
        storedRestoreError = getCommunityApplyError(applied);
        if ( storedRestoreError === '' ) {
            return {
                source: 'stored',
                applied,
                error: message,
                requiresInjectableRefresh,
                cleanupReason,
            };
        }
    }

    const fallbackRules = await loadFallbackRules();
    const applied = await updateCommunityRules(fallbackRules, {
        source: 'fallback',
    });
    return {
        source: 'fallback',
        applied,
        error: [
            message,
            storedRestoreError !== ''
                ? `stored restore failed: ${storedRestoreError}`
                : '',
            getCommunityApplyError(applied) !== ''
                ? `packaged fallback failed: ${applied.error}`
                : '',
        ].filter(part => part !== '').join('; '),
        requiresInjectableRefresh,
        cleanupReason,
    };
}

/******************************************************************************/

async function getCommunitySyncState(force = false) {
    await ensureCommunityBaselineMigration();
    const [
        baselineMeta,
        lastAttempt,
        lastSuccess,
        lastFetch,
        lastError,
    ] = await Promise.all([
        localRead(BASELINE_STORAGE_KEYS.meta),
        localRead(STORAGE_KEYS.lastAttempt),
        localRead(STORAGE_KEYS.lastSuccess),
        localRead(STORAGE_KEYS.lastFetch),
        localRead(STORAGE_KEYS.lastError),
    ]);

    const baselineLastFetch = Number(baselineMeta?.lastFetch) || 0;
    const legacyLastFetch = Number(lastFetch) || 0;
    const effectiveLastAttempt = Number(baselineMeta?.lastAttempt) ||
        Number(lastAttempt) ||
        baselineLastFetch ||
        legacyLastFetch;
    const effectiveLastSuccess = Number(baselineMeta?.lastSuccess) ||
        Number(lastSuccess) ||
        (
            (typeof baselineMeta?.lastError !== 'string' || baselineMeta.lastError === '') &&
            (typeof lastError !== 'string' || lastError === '')
                ? baselineLastFetch || legacyLastFetch
                : 0
        );
    const effectiveLastError = typeof baselineMeta?.lastError === 'string' &&
        baselineMeta.lastError !== ''
        ? baselineMeta.lastError
        : lastError;

    return computeCommunitySyncState({
        force,
        ttlHours: baselineMeta?.ttlHours,
        lastAttempt: effectiveLastAttempt,
        lastSuccess: effectiveLastSuccess,
        lastError: effectiveLastError,
    });
}

export async function syncCommunityRules({ force = false } = {}) {
    if ( rulesetConfig.communityRulesEnabled === false ) {
        return clearCommunityState('disabled');
    }

    let privateStateResult = {
        cleanupReason: '',
        requiresInjectableRefresh: false,
    };
    if ( isDeveloperModeAllowed === false || rulesetConfig.developerMode !== true ) {
        privateStateResult = await scrubPrivateCommunityState(
            'developer-mode-off'
        );
    }

    const configuredURL = rulesetConfig.communityRulesURL || COMMUNITY_URL_DEFAULT;
    const url = normalizeCommunityURL(configuredURL);
    if ( url === '' ) {
        return clearCommunityState('invalid-url');
    }
    const publicHotfixLane = isPublicCommunityHotfixLane(url);

    const syncState = await getCommunitySyncState(force);
    if ( syncState.due === false ) {
        if ( syncState.reason === 'retry-backoff' ) {
            scheduleCommunityRetryAlarm(syncState.nextDelayMs);
        } else {
            scheduleCommunitySuccessAlarm({
                ttlHours: syncState.ttlMs / (60 * 60 * 1000),
                delayMs: syncState.nextDelayMs,
            });
        }
        return {
            skipped: syncState.reason,
            cleanupReason: privateStateResult.cleanupReason,
            requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
        };
    }

    if ( COMMUNITY_PUBLIC_KEY_B64 === '' ) {
        return applyFallback(new Error('no public key configured'), privateStateResult);
    }

    let bundle;
    try {
        const res = await fetchWithTimeout(url, { cache: 'no-store' });
        if ( res.ok === false ) {
            throw new Error(`http ${res.status}`);
        }
        bundle = await res.json();
    } catch (e) {
        return applyFallback(e, privateStateResult);
    }

    const rules = Array.isArray(bundle?.rules) ? bundle.rules : null;
    if ( rules === null ) {
        return applyFallback(new Error('invalid bundle format'), privateStateResult);
    }

    const integrity = bundle.integrity || {};
    if ( integrity.algorithm !== 'sha256' || typeof integrity.value !== 'string' ) {
        return applyFallback(new Error('missing integrity'), privateStateResult);
    }

    const integrityScope = integrity.scope === 'full' ? 'full' : 'rules';
    const payloadText = buildCommunityPayloadText({
        bundle,
        rules,
        integrityScope,
    });
    let digest;
    try {
        digest = await sha256Hex(payloadText);
    } catch (e) {
        return applyFallback(e, privateStateResult);
    }
    if ( digest !== integrity.value.toLowerCase() ) {
        return applyFallback(new Error('integrity mismatch'), privateStateResult);
    }

    const signature = bundle.signature || {};
    if ( signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ) {
        return applyFallback(new Error('missing signature'), privateStateResult);
    }

    const publicKeyBytes = base64ToBytes(COMMUNITY_PUBLIC_KEY_B64);
    const signatureBytes = base64ToBytes(signature.value);
    if ( publicKeyBytes.length !== 32 || signatureBytes.length !== 64 ) {
        return applyFallback(new Error('bad signature encoding'), privateStateResult);
    }

    const ok = await verifyEd25519(
        publicKeyBytes,
        new TextEncoder().encode(payloadText),
        signatureBytes
    );
    if ( ok !== true ) {
        return applyFallback(new Error('signature invalid'), privateStateResult);
    }

    const schemaVersion = normalizeCommunityRuleSchemaVersion(bundle.schemaVersion);
    if ( bundle.schemaVersion !== undefined && schemaVersion === 0 ) {
        return applyFallback(new Error('unsupported schema version'), privateStateResult);
    }

    const normalizedSchemaVersion = schemaVersion || COMMUNITY_RULE_SCHEMA_VERSION_LEGACY;
    if (
        normalizedSchemaVersion >= COMMUNITY_RULE_SCHEMA_VERSION_TACTICS &&
        integrityScope !== 'full'
    ) {
        return applyFallback(new Error('schema v4 requires full integrity scope'), privateStateResult);
    }
    if (
        normalizedSchemaVersion < COMMUNITY_RULE_SCHEMA_VERSION_TACTICS &&
        bundle?.tactics !== undefined
    ) {
        return applyFallback(new Error('schema v4 required for tactics'), privateStateResult);
    }
    const now = Date.now();
    const currentCompiledMeta = await localRead(STORAGE_KEYS.meta);
    const extrasSigned = integrityScope === 'full';
    const sanitizedBaseline = sanitizeCommunityPayloadForStorage({
        rules,
        cosmetics: extrasSigned ? bundle.cosmetics : null,
        heuristics: extrasSigned ? bundle.heuristics : null,
        directives: extrasSigned && publicHotfixLane ? bundle.directives : null,
        scriptlets: extrasSigned && publicHotfixLane ? bundle.scriptlets : null,
        tactics: extrasSigned && publicHotfixLane ? bundle.tactics : null,
    }, {
        schemaVersion: normalizedSchemaVersion,
        maxTactics: COMMUNITY_TACTIC_BASELINE_MAX,
    });
    const baselineMetaToStore = {
        version: bundle.version,
        schemaVersion: normalizedSchemaVersion,
        generatedAt: bundle.generatedAt,
        ttlHours: normalizeCommunitySyncTtlHours(bundle.ttlHours),
        retryMinutes: COMMUNITY_SYNC_FAILURE_RETRY_MS / (60 * 1000),
        integrity: integrity.value,
        extrasSigned,
        hotfixLane: publicHotfixLane ? 'public' : 'private',
        lastAttempt: now,
        lastFetch: now,
        lastSuccess: Number(currentCompiledMeta?.baselineLastSuccess) || 0,
        lastError: '',
    };
    const overlayState = await readCommunityOverlayState();
    const compiled = buildCompiledCommunityState({
        baseline: {
            ...sanitizedBaseline,
            meta: baselineMetaToStore,
        },
        overlays: sortOverlaySources(overlayState.index, overlayState.payloads),
    });
    const beforeInjectableSnapshot = await readStoredCommunityInjectableSnapshot();
    const beforeInjectableState = snapshotToInjectableState(beforeInjectableSnapshot);

    await Promise.all([
        localWrite(BASELINE_STORAGE_KEYS.meta, baselineMetaToStore),
        localWrite(BASELINE_STORAGE_KEYS.rules, sanitizedBaseline.rules),
        localWrite(BASELINE_STORAGE_KEYS.cosmetics, sanitizedBaseline.cosmetics),
        localWrite(BASELINE_STORAGE_KEYS.heuristics, sanitizedBaseline.heuristics),
        localWrite(BASELINE_STORAGE_KEYS.publicDirectives, sanitizedBaseline.publicDirectives),
        localWrite(BASELINE_STORAGE_KEYS.publicScriptlets, sanitizedBaseline.publicScriptlets),
        localWrite(BASELINE_STORAGE_KEYS.publicTactics, sanitizedBaseline.publicTactics),
    ]);

    let writeResult;
    try {
        writeResult = await writeCompiledCommunityState({
            compiled,
            metaPatch: buildCompiledCommunityMetaPatch({
                baselineMeta: baselineMetaToStore,
                compiled,
                overlayIndex: overlayState.index,
                lastOverlaySiteKey: typeof currentCompiledMeta?.lastOverlaySiteKey === 'string'
                    ? currentCompiledMeta.lastOverlaySiteKey
                    : '',
                lastOverlayVersion: typeof currentCompiledMeta?.lastOverlayVersion === 'string'
                    ? currentCompiledMeta.lastOverlayVersion
                    : '',
                lastOverlayReason: typeof currentCompiledMeta?.lastOverlayReason === 'string'
                    ? currentCompiledMeta.lastOverlayReason
                    : '',
                lastOverlayStatus: typeof currentCompiledMeta?.lastOverlayStatus === 'string'
                    ? currentCompiledMeta.lastOverlayStatus
                    : '',
            }),
            attemptedAt: now,
            fetchAt: now,
            ruleSanitization: sanitizedBaseline.ruleSanitization,
        });
    } catch (error) {
        return applyFallback(error, privateStateResult);
    }

    const afterInjectableState = snapshotToInjectableState({
        cosmetics: compiled.cosmetics,
        heuristics: compiled.heuristics,
        directives: compiled.publicDirectives,
        scriptlets: compiled.publicScriptlets,
        tactics: compiled.publicTactics,
    });
    const requiresInjectableRefresh = Boolean(
        privateStateResult.requiresInjectableRefresh ||
        hasCommunityInjectableStateChanged(beforeInjectableState, afterInjectableState)
    );

    ubolLog(
        `community-sync: applied ${writeResult.applied.added || 0} compiled rules from baseline`
    );

    return {
        source: 'remote',
        applied: writeResult.applied,
        meta: writeResult.metaToStore,
        requiresInjectableRefresh,
        cleanupReason: '',
        activation: {
            ...writeResult.activationSnapshot,
            candidateMeta: cloneValue(writeResult.metaToStore),
            kind: 'baseline',
            baselineMeta: baselineMetaToStore,
        },
    };
}

export async function syncCommunityOverlayRules({
    siteKey,
    force = false,
    reason = '',
} = {}) {
    if ( rulesetConfig.communityRulesEnabled === false ) {
        return { skipped: 'disabled' };
    }

    await ensureCommunityBaselineMigration();

    const normalizedSiteKey = normalizeAutoPromotedHostname(siteKey);
    if ( normalizedSiteKey === '' ) {
        return { skipped: 'invalid-site-key' };
    }

    let privateStateResult = {
        cleanupReason: '',
        requiresInjectableRefresh: false,
    };
    if ( isDeveloperModeAllowed === false || rulesetConfig.developerMode !== true ) {
        privateStateResult = await scrubPrivateCommunityState(
            'developer-mode-off'
        );
    }

    const configuredURL = rulesetConfig.communityRulesURL || COMMUNITY_URL_DEFAULT;
    const url = normalizeCommunityURL(configuredURL);
    if ( url === '' ) {
        return { skipped: 'invalid-url' };
    }

    const now = Date.now();
    const [
        baselineState,
        overlayState,
    ] = await Promise.all([
        readCommunityBaselineState(),
        readCommunityOverlayState(),
    ]);
    const existingEntry = overlayState.index[normalizedSiteKey];
    const existingPayload = overlayState.payloads[normalizedSiteKey];
    const persistOverlayError = async message => {
        overlayState.index[normalizedSiteKey] = normalizeOverlayIndexEntry({
            siteKey: normalizedSiteKey,
            ...(overlayState.index[normalizedSiteKey] || existingEntry || {}),
            lastAttempt: now,
            lastError: message,
            lastReason: reason,
            lastStatus: 'error',
        });
        await persistOverlayState(overlayState);
        return {
            source: 'overlay-error',
            overlaySiteKey: normalizedSiteKey,
            error: message,
            requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
        };
    };
    if ( force !== true ) {
        const negativeUntil = Number(existingEntry?.negativeUntil) || 0;
        if ( negativeUntil > now ) {
            return {
                skipped: 'negative-cache',
                overlaySiteKey: normalizedSiteKey,
                requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
            };
        }
        const lastAttempt = Number(existingEntry?.lastAttempt) || 0;
        const lastError = typeof existingEntry?.lastError === 'string'
            ? existingEntry.lastError
            : '';
        if ( lastError !== '' && (now - lastAttempt) < COMMUNITY_OVERLAY_FETCH_RETRY_MS ) {
            return {
                skipped: 'retry-backoff',
                overlaySiteKey: normalizedSiteKey,
                requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
            };
        }
    }

    const overlayUrl = buildCommunityOverlayURL(url, normalizedSiteKey, {
        baselineVersion: baselineState.meta?.version,
        knownVersion: existingEntry?.version,
    });
    if ( overlayUrl === '' ) {
        return { skipped: 'invalid-overlay-url' };
    }

    let response;
    try {
        response = await fetchWithTimeout(overlayUrl, { cache: 'no-store' });
    } catch (error) {
        return persistOverlayError(
            error instanceof Error ? error.message : String(error || 'overlay fetch failed')
        );
    }

    if ( response.status === 204 ) {
        overlayState.index[normalizedSiteKey] = normalizeOverlayIndexEntry({
            siteKey: normalizedSiteKey,
            ...(existingEntry || {}),
            lastAttempt: now,
            lastError: '',
            lastReason: reason,
            lastStatus: 'not-modified',
        });
        await persistOverlayState(overlayState);
        return {
            source: 'overlay-not-modified',
            overlaySiteKey: normalizedSiteKey,
            overlayVersion: existingEntry?.version || '',
            overlayStatus: 'not-modified',
            requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
        };
    }

    if ( response.status === 404 || response.status === 410 ) {
        const hadPayload = existingPayload instanceof Object;
        overlayState.index[normalizedSiteKey] = normalizeOverlayIndexEntry({
            siteKey: normalizedSiteKey,
            ...(existingEntry || {}),
            version: '',
            baselineVersion: baselineState.meta?.version || '',
            lastAttempt: now,
            lastError: '',
            lastReason: reason,
            lastStatus: response.status === 410 ? 'revoked' : 'missing',
            negativeUntil: now + COMMUNITY_OVERLAY_NEGATIVE_CACHE_MS,
        });
        delete overlayState.payloads[normalizedSiteKey];
        await persistOverlayState(overlayState);
        if ( hadPayload === false ) {
            return {
                source: 'overlay-miss',
                overlaySiteKey: normalizedSiteKey,
                overlayStatus: response.status === 410 ? 'revoked' : 'missing',
                requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
            };
        }
        const compiled = buildCompiledCommunityState({
            baseline: baselineState,
            overlays: sortOverlaySources(overlayState.index, overlayState.payloads),
        });
        const beforeInjectableSnapshot = await readStoredCommunityInjectableSnapshot();
        const beforeInjectableState = snapshotToInjectableState(beforeInjectableSnapshot);
        let writeResult;
        try {
            writeResult = await writeCompiledCommunityState({
                compiled,
                metaPatch: buildCompiledCommunityMetaPatch({
                    baselineMeta: baselineState.meta,
                    compiled,
                    overlayIndex: overlayState.index,
                    lastOverlaySiteKey: normalizedSiteKey,
                    lastOverlayVersion: '',
                    lastOverlayReason: reason,
                    lastOverlayStatus: response.status === 410 ? 'revoked' : 'missing',
                }),
                attemptedAt: now,
                fetchAt: now,
            });
        } catch (error) {
            return persistOverlayError(String(error || 'overlay removal apply failed'));
        }
        const afterInjectableState = snapshotToInjectableState({
            cosmetics: compiled.cosmetics,
            heuristics: compiled.heuristics,
            directives: compiled.publicDirectives,
            scriptlets: compiled.publicScriptlets,
            tactics: compiled.publicTactics,
        });
        return {
            source: 'overlay-removed',
            overlaySiteKey: normalizedSiteKey,
            overlayStatus: response.status === 410 ? 'revoked' : 'missing',
            applied: writeResult.applied,
            meta: writeResult.metaToStore,
            requiresInjectableRefresh: Boolean(
                privateStateResult.requiresInjectableRefresh ||
                hasCommunityInjectableStateChanged(beforeInjectableState, afterInjectableState)
            ),
            activation: {
                ...writeResult.activationSnapshot,
                candidateMeta: cloneValue(writeResult.metaToStore),
                kind: 'overlay',
                overlaySiteKey: normalizedSiteKey,
                overlayVersion: '',
                overlayReason: reason,
                overlayStatus: response.status === 410 ? 'revoked' : 'missing',
            },
        };
    }

    if ( response.ok === false ) {
        return persistOverlayError(`http ${response.status}`);
    }

    let bundle;
    try {
        bundle = await response.json();
    } catch {
        bundle = null;
    }
    const rules = Array.isArray(bundle?.rules) ? bundle.rules : null;
    const overlayBundleSiteKey = normalizeAutoPromotedHostname(bundle?.siteKey);
    if (
        rules === null ||
        overlayBundleSiteKey === '' ||
        overlayBundleSiteKey !== normalizedSiteKey ||
        typeof bundle?.baselineVersion !== 'string' ||
        bundle.baselineVersion.trim() === ''
    ) {
        return persistOverlayError('invalid overlay bundle');
    }

    const overlaySchemaVersion = normalizeCommunityRuleSchemaVersion(bundle.schemaVersion);
    if (
        overlaySchemaVersion !== COMMUNITY_OVERLAY_SCHEMA_VERSION &&
        overlaySchemaVersion !== COMMUNITY_OVERLAY_TACTIC_SCHEMA_VERSION
    ) {
        return persistOverlayError('unsupported overlay schema version');
    }
    if (
        overlaySchemaVersion < COMMUNITY_RULE_SCHEMA_VERSION_TACTICS &&
        bundle?.tactics !== undefined
    ) {
        return persistOverlayError('schema v4 required for tactics');
    }

    const integrity = bundle.integrity || {};
    if ( integrity.algorithm !== 'sha256' || typeof integrity.value !== 'string' ) {
        return persistOverlayError('missing overlay integrity');
    }
    const payloadText = buildCommunityOverlayPayloadText({
        bundle,
        rules,
        cosmetics: bundle.cosmetics ?? null,
        heuristics: bundle.heuristics ?? null,
        directives: bundle.directives ?? null,
        scriptlets: bundle.scriptlets ?? null,
        tactics: bundle.tactics ?? null,
    });
    let digest;
    try {
        digest = await sha256Hex(payloadText);
    } catch (error) {
        return persistOverlayError(String(error || 'overlay digest failed'));
    }
    if ( digest !== integrity.value.toLowerCase() ) {
        return persistOverlayError('overlay integrity mismatch');
    }

    const signature = bundle.signature || {};
    if ( signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ) {
        return persistOverlayError('missing overlay signature');
    }
    const publicKeyBytes = base64ToBytes(COMMUNITY_PUBLIC_KEY_B64);
    const signatureBytes = base64ToBytes(signature.value);
    const ok = await verifyEd25519(
        publicKeyBytes,
        new TextEncoder().encode(payloadText),
        signatureBytes
    );
    if ( ok !== true ) {
        return persistOverlayError('overlay signature invalid');
    }

    if ( bundle.baselineVersion.trim() !== String(baselineState.meta?.version || '').trim() ) {
        overlayState.index[normalizedSiteKey] = normalizeOverlayIndexEntry({
            siteKey: normalizedSiteKey,
            ...(existingEntry || {}),
            lastAttempt: now,
            lastError: '',
            lastReason: reason,
            lastStatus: 'baseline-mismatch',
            baselineVersion: bundle.baselineVersion,
            version: typeof bundle.version === 'string' ? bundle.version : '',
        });
        await persistOverlayState(overlayState);
        return {
            source: 'overlay-baseline-mismatch',
            overlaySiteKey: normalizedSiteKey,
            overlayVersion: typeof bundle.version === 'string' ? bundle.version : '',
            retryWithForcedBaseline: true,
            requiresInjectableRefresh: privateStateResult.requiresInjectableRefresh,
        };
    }

    const sanitizedOverlay = sanitizeCommunityPayloadForStorage({
        rules,
        cosmetics: bundle.cosmetics ?? null,
        heuristics: bundle.heuristics ?? null,
        directives: bundle.directives ?? null,
        scriptlets: bundle.scriptlets ?? null,
        tactics: bundle.tactics ?? null,
    }, {
        schemaVersion: overlaySchemaVersion,
        maxRules: COMMUNITY_OVERLAY_MAX_RULES,
        maxCosmeticSelectors: COMMUNITY_OVERLAY_MAX_COSMETIC_SELECTORS,
        maxDirectives: COMMUNITY_OVERLAY_MAX_DIRECTIVES,
        maxScriptlets: COMMUNITY_OVERLAY_MAX_SCRIPTLETS,
        maxTactics: COMMUNITY_OVERLAY_MAX_TACTICS,
        maxHeuristicRegexes: COMMUNITY_OVERLAY_MAX_HEURISTIC_REGEXES,
    });
    overlayState.index[normalizedSiteKey] = normalizeOverlayIndexEntry({
        siteKey: normalizedSiteKey,
        ...(existingEntry || {}),
        version: typeof bundle.version === 'string' ? bundle.version : '',
        baselineVersion: bundle.baselineVersion,
        ttlMinutes: normalizeCommunityOverlayTtlMinutes(bundle.ttlMinutes),
        lastAttempt: now,
        lastError: '',
        lastReason: reason,
        lastStatus: 'updated',
        negativeUntil: 0,
    });
    overlayState.payloads[normalizedSiteKey] = normalizeOverlayPayload({
        siteKey: normalizedSiteKey,
        version: typeof bundle.version === 'string' ? bundle.version : '',
        baselineVersion: bundle.baselineVersion,
        schemaVersion: overlaySchemaVersion,
        ttlMinutes: normalizeCommunityOverlayTtlMinutes(bundle.ttlMinutes),
        ...sanitizedOverlay,
    });
    enforceOverlayCapacity(overlayState.index, overlayState.payloads, {
        protectSiteKey: normalizedSiteKey,
    });
    await persistOverlayState(overlayState);

    const compiled = buildCompiledCommunityState({
        baseline: baselineState,
        overlays: sortOverlaySources(overlayState.index, overlayState.payloads),
    });
    const beforeInjectableSnapshot = await readStoredCommunityInjectableSnapshot();
    const beforeInjectableState = snapshotToInjectableState(beforeInjectableSnapshot);
    let writeResult;
    try {
        writeResult = await writeCompiledCommunityState({
            compiled,
            metaPatch: buildCompiledCommunityMetaPatch({
                baselineMeta: baselineState.meta,
                compiled,
                overlayIndex: overlayState.index,
                lastOverlaySiteKey: normalizedSiteKey,
                lastOverlayVersion: typeof bundle.version === 'string' ? bundle.version : '',
                lastOverlayReason: reason,
                lastOverlayStatus: 'updated',
            }),
            attemptedAt: now,
            fetchAt: now,
            ruleSanitization: sanitizedOverlay.ruleSanitization,
        });
    } catch (error) {
        return persistOverlayError(String(error || 'overlay apply failed'));
    }
    const afterInjectableState = snapshotToInjectableState({
        cosmetics: compiled.cosmetics,
        heuristics: compiled.heuristics,
        directives: compiled.publicDirectives,
        scriptlets: compiled.publicScriptlets,
        tactics: compiled.publicTactics,
    });
    return {
        source: 'overlay',
        overlaySiteKey: normalizedSiteKey,
        overlayVersion: typeof bundle.version === 'string' ? bundle.version : '',
        overlayStatus: 'updated',
        applied: writeResult.applied,
        meta: writeResult.metaToStore,
        requiresInjectableRefresh: Boolean(
            privateStateResult.requiresInjectableRefresh ||
            hasCommunityInjectableStateChanged(beforeInjectableState, afterInjectableState)
        ),
        cleanupReason: '',
        activation: {
            ...writeResult.activationSnapshot,
            candidateMeta: cloneValue(writeResult.metaToStore),
            kind: 'overlay',
            overlaySiteKey: normalizedSiteKey,
            overlayVersion: typeof bundle.version === 'string' ? bundle.version : '',
            overlayReason: reason,
            overlayStatus: 'updated',
        },
    };
}

export {
    ALARM_NAME,
    buildCommunityOverlayURL,
    COMMUNITY_URL_DEFAULT,
    normalizeCommunityURL,
};
