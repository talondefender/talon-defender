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
    COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
    normalizeCommunityRuleSchemaVersion,
} from './community-rule-sanitizer.js';

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
    privateDirectives: 'communityBundlePrivateDirectives',
    privateScriptlets: 'communityBundlePrivateScriptlets',
    lastAttempt: 'communityBundleLastAttempt',
    lastSuccess: 'communityBundleLastSuccess',
    lastFetch: 'communityBundleLastFetch',
    lastError: 'communityBundleLastError',
};
const LEGACY_PRIVATE_STORAGE_KEYS = {
    directives: 'communityBundleDirectives',
    scriptlets: 'communityBundleScriptlets',
};

const ALARM_NAME = 'community-sync';
const COMMUNITY_FETCH_TIMEOUT_MS = 10000;
const COMMUNITY_PRIVATE_ONLY_KEYS = [
    STORAGE_KEYS.privateDirectives,
    STORAGE_KEYS.privateScriptlets,
    LEGACY_PRIVATE_STORAGE_KEYS.directives,
    LEGACY_PRIVATE_STORAGE_KEYS.scriptlets,
];
const COMMUNITY_STATE_KEYS = [
    ...Object.values(STORAGE_KEYS),
    ...Object.values(LEGACY_PRIVATE_STORAGE_KEYS),
];
const COMMUNITY_ROLLBACK_SNAPSHOT_KEYS = [
    STORAGE_KEYS.meta,
    STORAGE_KEYS.rules,
    STORAGE_KEYS.cosmetics,
    STORAGE_KEYS.heuristics,
    STORAGE_KEYS.publicDirectives,
    STORAGE_KEYS.publicScriptlets,
    STORAGE_KEYS.privateDirectives,
    STORAGE_KEYS.privateScriptlets,
    STORAGE_KEYS.lastSuccess,
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

const getCommunityApplyError = applied => {
    const rawError = typeof applied?.error === 'string'
        ? applied.error.trim()
        : applied?.error instanceof Error
            ? applied.error.message
            : '';
    return rawError.replace(/^Error:\s*/i, '').trim();
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
        privateDirectives,
        privateScriptlets,
        legacyDirectives,
        legacyScriptlets,
    ] = await Promise.all([
        localRead(STORAGE_KEYS.cosmetics),
        localRead(STORAGE_KEYS.heuristics),
        localRead(STORAGE_KEYS.publicDirectives),
        localRead(STORAGE_KEYS.publicScriptlets),
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
    await Promise.all([
        localWrite(STORAGE_KEYS.meta, nextMeta),
        localWrite(STORAGE_KEYS.lastSuccess, now),
        localRemove(STORAGE_KEYS.lastError),
    ]);
    scheduleCommunitySuccessAlarm({
        ttlHours: activation?.candidateMeta?.ttlHours,
    });
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
        await Promise.all([
            localWrite(STORAGE_KEYS.lastError, message),
            localWrite(STORAGE_KEYS.lastAttempt, now),
            localWrite(STORAGE_KEYS.lastFetch, now),
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
    const [
        meta,
        lastAttempt,
        lastSuccess,
        lastFetch,
        lastError,
    ] = await Promise.all([
        localRead(STORAGE_KEYS.meta),
        localRead(STORAGE_KEYS.lastAttempt),
        localRead(STORAGE_KEYS.lastSuccess),
        localRead(STORAGE_KEYS.lastFetch),
        localRead(STORAGE_KEYS.lastError),
    ]);

    const legacyLastFetch = Number(lastFetch) || 0;
    const effectiveLastAttempt = Number(lastAttempt) || legacyLastFetch;
    const effectiveLastSuccess = Number(lastSuccess) || (
        (typeof lastError !== 'string' || lastError === '') ? legacyLastFetch : 0
    );

    return computeCommunitySyncState({
        force,
        ttlHours: meta?.ttlHours,
        lastAttempt: effectiveLastAttempt,
        lastSuccess: effectiveLastSuccess,
        lastError,
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
    const activationSnapshot = await snapshotCommunityActivationState({
        attemptedAt: Date.now(),
    });
    const applied = await updateCommunityRules(rules, {
        source: 'remote',
        version: bundle.version,
        schemaVersion: normalizedSchemaVersion,
    });
    const applyError = getCommunityApplyError(applied);
    if ( applyError !== '' ) {
        return applyFallback(
            new Error(`apply failed: ${applyError}`),
            privateStateResult
        );
    }

    // Extras are only trusted if covered by the signature.
    const extrasSigned = integrityScope === 'full';
    const beforeInjectableSnapshot = await readStoredCommunityInjectableSnapshot();
    const beforeInjectableState = snapshotToInjectableState(beforeInjectableSnapshot);

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
            if ( seen.has(normalized) ) { continue; }
            seen.add(normalized);
            out.push(normalized);
        }
        return out;
    };

    const sanitizeCosmetics = input => {
        if ( input instanceof Object === false ) { return null; }
        const out = { all: [], hosts: {} };
        const globalSelectors = sanitizeStringArray(input.all, 250)
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
                if (
                    patternCouldMatchProtectedDomain(normalizedHost) &&
                    isExactHostnamePattern(normalizedHost) === false
                ) {
                    continue;
                }
                const filteredSelectors = sanitizeStringArray(selectors, 250)
                    .filter(selector => isSafeMutationSelector(selector));
                if ( filteredSelectors.length === 0 ) { continue; }
                out.hosts[normalizedHost] = filteredSelectors;
                hostCount += 1;
                if ( hostCount >= 500 ) { break; }
            }
        }
        if ( out.all.length === 0 && Object.keys(out.hosts).length === 0 ) {
            return null;
        }
        return out;
    };

    const sanitizeHeuristics = input => {
        if ( input instanceof Object === false ) { return null; }
        const out = {};
        const disableHosts = sanitizeScopedHostPatterns(input.disableHosts, 200);
        if ( disableHosts.length !== 0 ) {
            out.disableHosts = disableHosts;
        }
        const labelRegexes = normalizeCommunityHeuristicLabelRegexes(
            input.labelRegexes
        );
        if ( labelRegexes.length !== 0 ) {
            out.labelRegexes = labelRegexes;
        }
        const labelSelectors = sanitizeStringArray(
            input.labelSelectors,
            COMMUNITY_HEURISTIC_SELECTOR_MAX
        ).filter(selector => isSafeMutationSelector(selector));
        if ( labelSelectors.length !== 0 ) {
            out.labelSelectors = labelSelectors;
        }
        const widgetSelectors = sanitizeStringArray(
            input.widgetSelectors,
            COMMUNITY_HEURISTIC_SELECTOR_MAX
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

    const sanitizeDirectives = input => {
        if ( Array.isArray(input) === false ) { return null; }
        const out = [];
        for ( const d of input ) {
            if ( d instanceof Object === false ) { continue; }
            const id = typeof d.id === 'string' ? d.id.trim() : '';
            const action = typeof d.action === 'string' ? d.action.trim() : '';
            const selectors = sanitizeStringArray(d.selectors, 16)
                .filter(selector => isSafeMutationSelector(selector, {
                    requireKnownConsent: d.category === 'consent',
                }));
            const sanitizedHosts = sanitizeScopedHostPatterns(d.hosts, 32);
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
                if ( protectedHosts.some(host => isExactHostnamePattern(host) === false) ) {
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
                maxApplies: Number.isFinite(Number(d.maxApplies)) ? Number(d.maxApplies) : undefined,
            });
            if ( out.length >= 80 ) { break; }
        }
        return out;
    };

    const sanitizeScriptlets = input => canonicalizeCommunityScriptlets(input, {
        maxEntries: 120,
    });

    let cosmeticsToStore = null;
    let heuristicsToStore = null;
    let publicDirectivesToStore = beforeInjectableSnapshot.publicDirectives ?? null;
    let publicScriptletsToStore = beforeInjectableSnapshot.publicScriptlets ?? null;
    let privateDirectivesToStore = null;
    let privateScriptletsToStore = null;
    const allowPrivateDirectiveFeatures = isDeveloperModeAllowed &&
        rulesetConfig.developerMode === true;
    if ( extrasSigned ) {
        cosmeticsToStore = sanitizeCosmetics(bundle.cosmetics);
        heuristicsToStore = sanitizeHeuristics(bundle.heuristics);
        const sanitizedDirectives = sanitizeDirectives(bundle.directives);
        const sanitizedScriptlets = sanitizeScriptlets(bundle.scriptlets);
        if ( publicHotfixLane ) {
            publicDirectivesToStore = sanitizedDirectives;
            publicScriptletsToStore = sanitizedScriptlets;
        } else if ( allowPrivateDirectiveFeatures ) {
            privateDirectivesToStore = sanitizedDirectives;
            privateScriptletsToStore = sanitizedScriptlets;
        }
    } else if ( publicHotfixLane ) {
        publicDirectivesToStore = null;
        publicScriptletsToStore = null;
    }
    const totalDirectives = mergeCommunityExtras(
        publicDirectivesToStore,
        privateDirectivesToStore
    );
    const totalScriptlets = mergeCommunityExtras(
        publicScriptletsToStore,
        privateScriptletsToStore
    );

    const metaToStore = {
        version: bundle.version,
        schemaVersion: normalizedSchemaVersion,
        generatedAt: bundle.generatedAt,
        ttlHours: normalizeCommunitySyncTtlHours(bundle.ttlHours),
        retryMinutes: COMMUNITY_SYNC_FAILURE_RETRY_MS / (60 * 1000),
        integrity: integrity.value,
        applied,
        extrasSigned,
        hotfixLane: publicHotfixLane ? 'public' : 'private',
        remoteDirectiveFeaturesEnabled: Boolean(totalDirectives || totalScriptlets),
        cosmeticsCount: countCommunityCosmeticSelectors(cosmeticsToStore),
        hostCosmeticsCount: countHostSpecificCommunityCosmeticSelectors(cosmeticsToStore),
        protectedCosmeticsCount: countProtectedCosmeticSelectors(cosmeticsToStore),
        heuristicRegexCount: countCommunityHeuristicLabelRegexes(heuristicsToStore),
        directivesCount: totalDirectives?.length || 0,
        protectedDirectivesCount: countProtectedDirectives(totalDirectives),
        scriptletsCount: totalScriptlets?.length || 0,
        publicDirectivesCount: publicDirectivesToStore?.length || 0,
        publicScriptletsCount: publicScriptletsToStore?.length || 0,
        proofDirectivesCount: privateDirectivesToStore?.length || 0,
        proofScriptletsCount: privateScriptletsToStore?.length || 0,
    };

    const now = activationSnapshot.attemptedAt;
    const writes = [
        localWrite(STORAGE_KEYS.rules, rules),
        localWrite(STORAGE_KEYS.meta, metaToStore),
        localWrite(STORAGE_KEYS.lastAttempt, now),
        localWrite(STORAGE_KEYS.lastFetch, now),
    ];
    if ( extrasSigned ) {
        writes.push(
            localWrite(STORAGE_KEYS.cosmetics, cosmeticsToStore),
            localWrite(STORAGE_KEYS.heuristics, heuristicsToStore),
            localWrite(STORAGE_KEYS.publicDirectives, publicDirectivesToStore),
            localWrite(STORAGE_KEYS.publicScriptlets, publicScriptletsToStore),
            localWrite(STORAGE_KEYS.privateDirectives, privateDirectivesToStore),
            localWrite(STORAGE_KEYS.privateScriptlets, privateScriptletsToStore),
            localRemove(LEGACY_PRIVATE_STORAGE_KEYS.directives),
            localRemove(LEGACY_PRIVATE_STORAGE_KEYS.scriptlets),
        );
    } else {
        writes.push(
            localWrite(STORAGE_KEYS.cosmetics, null),
            localWrite(STORAGE_KEYS.heuristics, null),
            localWrite(STORAGE_KEYS.publicDirectives, publicDirectivesToStore),
            localWrite(STORAGE_KEYS.publicScriptlets, publicScriptletsToStore),
            localWrite(STORAGE_KEYS.privateDirectives, privateDirectivesToStore),
            localWrite(STORAGE_KEYS.privateScriptlets, privateScriptletsToStore),
            localRemove(LEGACY_PRIVATE_STORAGE_KEYS.directives),
            localRemove(LEGACY_PRIVATE_STORAGE_KEYS.scriptlets),
        );
    }

    await Promise.all(writes);

    const afterInjectableState = snapshotToInjectableState({
        cosmetics: cosmeticsToStore,
        heuristics: heuristicsToStore,
        publicDirectives: publicDirectivesToStore,
        publicScriptlets: publicScriptletsToStore,
        privateDirectives: privateDirectivesToStore,
        privateScriptlets: privateScriptletsToStore,
        legacyDirectives: null,
        legacyScriptlets: null,
    });
    const requiresInjectableRefresh = Boolean(
        privateStateResult.requiresInjectableRefresh ||
        hasCommunityInjectableStateChanged(beforeInjectableState, afterInjectableState)
    );

    ubolLog(`community-sync: applied ${applied.added || 0} rules from remote`);

    return {
        source: 'remote',
        applied,
        meta: metaToStore,
        requiresInjectableRefresh,
        cleanupReason: '',
        activation: {
            ...activationSnapshot,
            candidateMeta: cloneValue(metaToStore),
        },
    };
}

export {
    ALARM_NAME,
    COMMUNITY_URL_DEFAULT,
    normalizeCommunityURL,
};
