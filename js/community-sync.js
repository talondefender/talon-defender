/******************************************************************************/
// Community intelligence sync (remote signed DNR rules)

import {
    browser,
    localRead, localRemove, localWrite,
    runtime,
} from './ext.js';

import { isDeveloperModeAllowed, rulesetConfig } from './config.js';
import { ubolErr, ubolLog } from './debug.js';
import { updateCommunityRules } from './ruleset-manager.js';

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
    directives: 'communityBundleDirectives',
    scriptlets: 'communityBundleScriptlets',
    lastFetch: 'communityBundleLastFetch',
    lastError: 'communityBundleLastError',
};

const ALARM_NAME = 'community-sync';
const DEFAULT_TTL_HOURS = 24;
const COMMUNITY_FETCH_TIMEOUT_MS = 10000;

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

const scheduleCommunityAlarm = ttlHours => {
    if ( browser.alarms?.create === undefined ) { return; }
    const hours = Number.isFinite(ttlHours) && ttlHours > 0
        ? ttlHours
        : DEFAULT_TTL_HOURS;
    const minutes = Math.max(60, Math.round(hours * 60));
    browser.alarms.create(ALARM_NAME, {
        delayInMinutes: minutes,
        periodInMinutes: minutes,
    });
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

async function applyFallback(reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    ubolErr(`community-sync: ${message}`);
    await localWrite(STORAGE_KEYS.lastError, message);
    await localWrite(STORAGE_KEYS.lastFetch, Date.now());

    const storedRules = await localRead(STORAGE_KEYS.rules);
    if ( Array.isArray(storedRules) && storedRules.length !== 0 ) {
        const applied = await updateCommunityRules(storedRules, {
            source: 'stored',
        });
        return { source: 'stored', applied, error: message };
    }

    const fallbackRules = await loadFallbackRules();
    const applied = await updateCommunityRules(fallbackRules, {
        source: 'fallback',
    });
    return { source: 'fallback', applied, error: message };
}

/******************************************************************************/

async function isDue(force) {
    if ( force ) { return true; }
    const [ lastFetch, meta ] = await Promise.all([
        localRead(STORAGE_KEYS.lastFetch),
        localRead(STORAGE_KEYS.meta),
    ]);
    const ttlHours = Number(meta?.ttlHours) || DEFAULT_TTL_HOURS;
    const ttlMs = ttlHours * 3600 * 1000;
    if ( typeof lastFetch !== 'number' ) { return true; }
    return (Date.now() - lastFetch) >= ttlMs;
}

export async function syncCommunityRules({ force = false } = {}) {
    if ( rulesetConfig.communityRulesEnabled === false ) {
        return { skipped: 'disabled' };
    }

    if ( isDeveloperModeAllowed === false || rulesetConfig.developerMode !== true ) {
        await Promise.all([
            localWrite(STORAGE_KEYS.directives, null),
            localWrite(STORAGE_KEYS.scriptlets, null),
        ]);
    }

    const configuredURL = rulesetConfig.communityRulesURL || COMMUNITY_URL_DEFAULT;
    const url = normalizeCommunityURL(configuredURL);
    if ( url === '' ) {
        return { skipped: 'no-url' };
    }

    if ( await isDue(force) === false ) {
        return { skipped: 'ttl' };
    }

    if ( COMMUNITY_PUBLIC_KEY_B64 === '' ) {
        return applyFallback(new Error('no public key configured'));
    }

    let bundle;
    try {
        const res = await fetchWithTimeout(url, { cache: 'no-store' });
        if ( res.ok === false ) {
            throw new Error(`http ${res.status}`);
        }
        bundle = await res.json();
    } catch (e) {
        return applyFallback(e);
    }

    const rules = Array.isArray(bundle?.rules) ? bundle.rules : null;
    if ( rules === null ) {
        return applyFallback(new Error('invalid bundle format'));
    }

    const integrity = bundle.integrity || {};
    if ( integrity.algorithm !== 'sha256' || typeof integrity.value !== 'string' ) {
        return applyFallback(new Error('missing integrity'));
    }

    const integrityScope = integrity.scope === 'full' ? 'full' : 'rules';
    let payloadText;
    if ( integrityScope === 'full' ) {
        const payloadObj = {
            rules,
            cosmetics: bundle.cosmetics ?? null,
            heuristics: bundle.heuristics ?? null,
            directives: bundle.directives ?? null,
            scriptlets: bundle.scriptlets ?? null,
        };
        payloadText = JSON.stringify(payloadObj);
    } else {
        payloadText = JSON.stringify(rules);
    }
    let digest;
    try {
        digest = await sha256Hex(payloadText);
    } catch (e) {
        return applyFallback(e);
    }
    if ( digest !== integrity.value.toLowerCase() ) {
        return applyFallback(new Error('integrity mismatch'));
    }

    const signature = bundle.signature || {};
    if ( signature.algorithm !== 'ed25519' || typeof signature.value !== 'string' ) {
        return applyFallback(new Error('missing signature'));
    }

    const publicKeyBytes = base64ToBytes(COMMUNITY_PUBLIC_KEY_B64);
    const signatureBytes = base64ToBytes(signature.value);
    if ( publicKeyBytes.length !== 32 || signatureBytes.length !== 64 ) {
        return applyFallback(new Error('bad signature encoding'));
    }

    const ok = await verifyEd25519(
        publicKeyBytes,
        new TextEncoder().encode(payloadText),
        signatureBytes
    );
    if ( ok !== true ) {
        return applyFallback(new Error('signature invalid'));
    }

    const applied = await updateCommunityRules(rules, bundle);

    // Extras are only trusted if covered by the signature.
    const extrasSigned = integrityScope === 'full';

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

    const sanitizeCosmetics = input => {
        if ( input instanceof Object === false ) { return null; }
        const out = { all: [], hosts: {} };
        out.all = sanitizeStringArray(input.all, 400);
        const hosts = input.hosts;
        if ( hosts instanceof Object ) {
            let hostCount = 0;
            for ( const [ host, selectors ] of Object.entries(hosts) ) {
                if ( typeof host !== 'string' || host.trim() === '' ) { continue; }
                out.hosts[host.trim().toLowerCase()] = sanitizeStringArray(selectors, 250);
                hostCount += 1;
                if ( hostCount >= 500 ) { break; }
            }
        }
        return out;
    };

    const sanitizeHeuristics = input => {
        if ( input instanceof Object === false ) { return null; }
        const out = {};
        if ( input.disableHosts ) {
            out.disableHosts = sanitizeStringArray(input.disableHosts, 200);
        }
        if ( input.labelRegexes ) {
            out.labelRegexes = sanitizeStringArray(input.labelRegexes, 80, 512);
        }
        if ( input.labelSelectors ) {
            out.labelSelectors = sanitizeStringArray(input.labelSelectors, 120);
        }
        if ( input.widgetSelectors ) {
            out.widgetSelectors = sanitizeStringArray(input.widgetSelectors, 120);
        }
        if ( input.containerStopSelectors ) {
            out.containerStopSelectors = sanitizeStringArray(input.containerStopSelectors, 80);
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
        return out;
    };

    const sanitizeDirectives = input => {
        if ( Array.isArray(input) === false ) { return null; }
        const out = [];
        for ( const d of input ) {
            if ( d instanceof Object === false ) { continue; }
            const id = typeof d.id === 'string' ? d.id.trim() : '';
            const action = typeof d.action === 'string' ? d.action.trim() : '';
            const selectors = sanitizeStringArray(d.selectors, 16);
            if ( id === '' || action === '' || selectors.length === 0 ) { continue; }
            const hosts = sanitizeStringArray(d.hosts, 32);
            out.push({
                id,
                category: typeof d.category === 'string' ? d.category.trim() : 'annoyances',
                hosts: hosts.length !== 0 ? hosts : [ '*' ],
                action,
                selectors,
                fallbackAction: typeof d.fallbackAction === 'string' ? d.fallbackAction.trim() : undefined,
                fallbackSelectors: sanitizeStringArray(d.fallbackSelectors, 8),
                postActions: sanitizeStringArray(d.postActions, 4),
                maxApplies: Number.isFinite(Number(d.maxApplies)) ? Number(d.maxApplies) : undefined,
            });
            if ( out.length >= 80 ) { break; }
        }
        return out;
    };

    const sanitizeScriptlets = input => {
        if ( Array.isArray(input) === false ) { return null; }
        const out = [];
        for ( const s of input ) {
            if ( s instanceof Object === false ) { continue; }
            const rulesetId = typeof s.rulesetId === 'string' ? s.rulesetId.trim() : '';
            const token = typeof s.token === 'string' ? s.token.trim() : '';
            if ( rulesetId === '' || token === '' ) { continue; }
            const hosts = sanitizeStringArray(s.hosts, 80);
            const world = s.world === 'MAIN' ? 'MAIN' : 'ISOLATED';
            out.push({ rulesetId, token, hosts: hosts.length !== 0 ? hosts : [ '*' ], world });
            if ( out.length >= 120 ) { break; }
        }
        return out;
    };

    let cosmeticsToStore = null;
    let heuristicsToStore = null;
    let directivesToStore = null;
    let scriptletsToStore = null;
    const allowRemoteDirectiveFeatures = extrasSigned &&
        isDeveloperModeAllowed &&
        rulesetConfig.developerMode === true;
    if ( extrasSigned ) {
        cosmeticsToStore = sanitizeCosmetics(bundle.cosmetics);
        heuristicsToStore = sanitizeHeuristics(bundle.heuristics);
        if ( allowRemoteDirectiveFeatures ) {
            directivesToStore = sanitizeDirectives(bundle.directives);
            scriptletsToStore = sanitizeScriptlets(bundle.scriptlets);
        }
    }

    const metaToStore = {
        version: bundle.version,
        generatedAt: bundle.generatedAt,
        ttlHours: Number(bundle.ttlHours) || DEFAULT_TTL_HOURS,
        integrity: integrity.value,
        applied,
        extrasSigned,
        remoteDirectiveFeaturesEnabled: allowRemoteDirectiveFeatures,
        cosmeticsCount: cosmeticsToStore?.all?.length || 0,
        directivesCount: directivesToStore?.length || 0,
        scriptletsCount: scriptletsToStore?.length || 0,
    };

    const writes = [
        localWrite(STORAGE_KEYS.rules, rules),
        localWrite(STORAGE_KEYS.meta, metaToStore),
        localWrite(STORAGE_KEYS.lastFetch, Date.now()),
        localRemove(STORAGE_KEYS.lastError),
    ];
    if ( extrasSigned ) {
        writes.push(
            localWrite(STORAGE_KEYS.cosmetics, cosmeticsToStore),
            localWrite(STORAGE_KEYS.heuristics, heuristicsToStore),
            localWrite(STORAGE_KEYS.directives, directivesToStore),
            localWrite(STORAGE_KEYS.scriptlets, scriptletsToStore),
        );
    } else {
        writes.push(
            localWrite(STORAGE_KEYS.cosmetics, null),
            localWrite(STORAGE_KEYS.heuristics, null),
            localWrite(STORAGE_KEYS.directives, null),
            localWrite(STORAGE_KEYS.scriptlets, null),
        );
    }

    await Promise.all(writes);

    scheduleCommunityAlarm(metaToStore.ttlHours);
    ubolLog(`community-sync: applied ${applied.added || 0} rules from remote`);

    return { source: 'remote', applied, meta: metaToStore };
}

export { scheduleCommunityAlarm, ALARM_NAME };
