import { getYouTubeRegistrationScopes } from './youtube-registration.js';
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

import * as ut from './utils.js';

import {
    browser,
    localRead,
    localRemove,
    localWrite,
} from './ext.js';
import { ubolErr, ubolLog } from './debug.js';

import {
    INTERNAL_UNFILTERED_DOMAINS,
    getRemoteAutomationRegistrationMatches,
    isInternalUnfilteredHostname,
} from './breakage-policy.js';
import { canonicalizeCommunityScriptlets } from './community-sync.js';
import { fetchJSON } from './fetch.js';
import {
    isRemoteScriptletDirectiveId,
    mergeRemoteScriptletReloadHints,
    normalizeRemoteScriptletReloadHint,
    PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY,
} from './remote-scriptlet-hotfix.js';
import { getEnabledRulesetsDetails } from './ruleset-manager.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { registerCustomFilters } from './filter-manager.js';
import { registerPreventPopup } from './prevent-popup.js';
import {
    contentScriptRegistrationsEqual,
    recordPackagedStaticScriptletReloadTransition,
    runInjectableRegistrationFlow,
    waitForTimedOutRegistrationOperations,
} from './injectable-registration.js';
import { registerToolbarIconToggler } from './action.js';
import { createSingleFlightRunner } from './single-flight.js';

/******************************************************************************/

const resourceDetailPromises = new Map();
let uncertainReconcileScheduled = false;
let injectableRegistrationSuspended = false;
const PUBLIC_REMOTE_COSMETICS_KEY = 'communityBundleCosmetics';
const PUBLIC_REMOTE_SCRIPTLETS_KEY = 'communityBundlePublicScriptlets';
const PRIVATE_REMOTE_SCRIPTLETS_KEY = 'communityBundlePrivateScriptlets';
const LEGACY_REMOTE_SCRIPTLETS_KEY = 'communityBundleScriptlets';
const PUBLIC_REMOTE_DIRECTIVES_KEY = 'communityBundlePublicDirectives';
const PRIVATE_REMOTE_DIRECTIVES_KEY = 'communityBundlePrivateDirectives';
const LEGACY_REMOTE_DIRECTIVES_KEY = 'communityBundleDirectives';
const AUTO_BACKOFF_SUBSYSTEMS_KEY = 'autoBackoffSubsystemsV1';
const CSS_SPECIFIC_DATA_STATE_KEY = 'cssSpecificDataStateV1';
const CSS_SPECIFIC_DATA_SCHEMA = 1;
const CSS_CACHE_DIRTY_KEY = 'injectableCssCacheDirtyV1';
const INJECTABLE_SYNC_DIAGNOSTICS_KEY = 'injectableSyncDiagnosticsV1';
const CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY =
    'contentScriptRegistrationMutationJournalV1';
const INJECTABLE_REGISTRATION_OPERATION_TIMEOUT_MS = 5000;
const SUPPRESSIBLE_SUBSYSTEMS = Object.freeze([
    'adShellStyles',
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'postHideCleanup',
    'youtubeAdSkip',
]);
const SCRIPTLET_PATH_ALIASES = new Map([
    [
        'ublock-filters.trusted-json-edit-xhr-request',
        '/js/scripting/scriptlet-token/ublock-experimental.trusted-json-edit-xhr-request.js',
    ],
]);
const TALON_PUBLIC_SUFFIX_DATA_PATH = '/shared/public-suffix-data.js';
const TALON_COOPERATIVE_SCHEDULER_PATH =
    '/js/scripting/cooperative-scheduler.js';
const TALON_SHADOW_DOM_HELPER_PATH = '/js/scripting/shadow-dom-helper.js';
const TALON_BLOCK_HINTS_PATH = '/js/scripting/block-hints.js';
const TALON_SITE_FIXES_MAIN_ID = 'talon-site-fixes-main';
const TALON_SITE_FIXES_MAIN_PATH =
    '/rulesets/scripting/scriptlet/main/talon-site-fixes.js';
const TALON_SITE_FIX_HOSTNAMES = Object.freeze([
    'french-stream.one',
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
]);
const TALON_YOUTUBE_AD_SKIP_PATH = '/js/scripting/youtube-ad-skip.js';
const TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip';
const TALON_YOUTUBE_PLAYER_GUARD_PATH = '/js/scripting/youtube-player-guard.js';
const TALON_YOUTUBE_PLAYER_GUARD_ID = 'talon-youtube-player-guard';
const YOUTUBE_AD_SKIP_HOSTNAMES = Object.freeze([
    'youtube.com',
    'youtube-nocookie.com',
]);

const getScriptletExcludedHostnames = ( ) => YOUTUBE_AD_SKIP_HOSTNAMES;

const readOptionalLocalValue = async (key, fallbackValue, context) => {
    if ( browser.storage?.local?.get === undefined ) {
        throw new Error(`${context}/local storage API unavailable`);
    }
    const bin = await browser.storage.local.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`${context}/invalid local storage response`);
    }
    return Object.hasOwn(bin, key) ? bin[key] : fallbackValue;
};

const readMergedLocalArrays = async (keys, context) => {
    if ( browser.storage?.local?.get === undefined ) {
        throw new Error(`${context}/local storage API unavailable`);
    }
    const bin = await browser.storage.local.get(keys);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`${context}/invalid local storage response`);
    }
    const out = [];
    for ( const key of keys ) {
        const value = bin[key];
        if ( value === undefined || value === null ) { continue; }
        if ( Array.isArray(value) === false ) {
            throw new TypeError(`${context}/${key} must be an array`);
        }
        out.push(...value);
    }
    return out;
};

const getResourceDetailMap = (key, path) => {
    let promise = resourceDetailPromises.get(key);
    if ( promise !== undefined ) { return promise; }
    promise = fetchJSON(path).then(entries => {
        if ( Array.isArray(entries) === false ) {
            throw new TypeError(`Invalid packaged resource details: ${path}`);
        }
        return new Map(entries);
    });
    resourceDetailPromises.set(key, promise);
    // A transient packaged-resource read must not poison this service worker
    // for its remaining lifetime. A later reconciliation can retry the read.
    promise.catch(() => {
        if ( resourceDetailPromises.get(key) === promise ) {
            resourceDetailPromises.delete(key);
        }
    });
    return promise;
};

const getScriptletDetails = () => getResourceDetailMap(
    'scriptlet',
    '/rulesets/scriptlet-details'
);

const getScriptletTokenDetails = () => getResourceDetailMap(
    'scriptlet-token',
    '/js/scripting/scriptlet-token-details'
);

const getGenericDetails = () => getResourceDetailMap(
    'generic',
    '/rulesets/generic-details'
);

/******************************************************************************/

const applyInternalUnfilteredDomains = filteringModeDetails => {
    const { none, basic, optimal, complete } = filteringModeDetails;
    for ( const domain of INTERNAL_UNFILTERED_DOMAINS ) {
        none.add(domain);
    }
    for ( const modeSet of [ basic, optimal, complete ]) {
        for ( const hostname of Array.from(modeSet) ) {
            if ( isInternalUnfilteredHostname(hostname) === false ) { continue; }
            modeSet.delete(hostname);
        }
    }
};

/******************************************************************************/

const normalizeMatches = matches => {
    if ( matches.length <= 1 ) { return; }
    if ( matches.includes('<all_urls>') === false ) {
        if ( matches.includes('*://*/*') === false ) { return; }
    }
    matches.length = 0;
    matches.push('<all_urls>');
};

const getScriptletPath = id =>
    SCRIPTLET_PATH_ALIASES.get(id) || `/js/scripting/scriptlet-token/${id}.js`;

async function resetCSSCache() {
    const area = browser.storage?.session;
    if ( typeof area?.get !== 'function' || typeof area?.remove !== 'function' ) {
        throw new Error('session storage API unavailable');
    }
    const bin = await area.get(null);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error('invalid session storage response');
    }
    const keys = Object.keys(bin).filter(key => key.startsWith('cache.css.'));
    if ( keys.length !== 0 ) { await area.remove(keys); }
}

const specificCosmeticDataKey = id => `css.specific.${id}`;

const sameJSONValue = (before, after) => {
    if ( before === after ) { return true; }
    try {
        return JSON.stringify(before) === JSON.stringify(after);
    } catch {
    }
    return false;
};

const isValidSpecificCosmeticData = data =>
    data instanceof Object &&
    Array.isArray(data.selectors) &&
    Array.isArray(data.selectorLists) &&
    Array.isArray(data.selectorListRefs) &&
    Array.isArray(data.hostnames) &&
    typeof data.hasEntities === 'boolean' &&
    Array.isArray(data.regexes);

const prepareSpecificCosmeticData = async rulesetIds => {
    const keepKeys = rulesetIds.map(specificCosmeticDataKey);
    if ( keepKeys.length === 0 ) {
        return { keepKeys, changed: false };
    }
    const state = {
        schema: CSS_SPECIFIC_DATA_SCHEMA,
        extensionVersion: browser.runtime?.getManifest?.()?.version || '',
        rulesetIds: rulesetIds.slice(),
    };
    // The state marker is written in the same storage transaction as every
    // generated payload. On the unchanged fast path, reading all payloads only
    // to prove their keys exist needlessly deserializes close to a megabyte (or
    // more with annoyance lists) on each worker wake.
    const stored = await browser.storage.local.get(CSS_SPECIFIC_DATA_STATE_KEY);
    const storedState = stored?.[CSS_SPECIFIC_DATA_STATE_KEY];
    if ( sameJSONValue(storedState, state) ) {
        return { keepKeys, changed: false };
    }

    const dataEntries = await Promise.all(rulesetIds.map(async id => {
        const data = await fetchJSON(`/rulesets/scripting/specific/${id}`);
        if ( isValidSpecificCosmeticData(data) === false ) {
            throw new TypeError(`Invalid specific cosmetic data: ${id}`);
        }
        return [ specificCosmeticDataKey(id), data ];
    }));
    const toWrite = { [CSS_SPECIFIC_DATA_STATE_KEY]: state };
    for ( const [ key, data ] of dataEntries ) {
        toWrite[key] = data;
    }
    // The payload affects live selector resolution. Persist a durable dirty
    // marker before changing it so a worker eviction or cache-reset failure
    // cannot acknowledge stale session CSS as current.
    await browser.storage.local.set({ [CSS_CACHE_DIRTY_KEY]: true });
    await browser.storage.local.set(toWrite);
    return { keepKeys, changed: true };
};

const cleanupSpecificCosmeticData = async keepKeys => {
    const keep = new Set(keepKeys);
    const area = browser.storage?.local;
    if ( typeof area?.get !== 'function' || typeof area?.remove !== 'function' ) {
        throw new Error('local storage API unavailable');
    }
    const bin = await area.get(null);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error('invalid local storage response');
    }
    const keys = Object.keys(bin);
    const obsolete = keys.filter(key =>
        (key.startsWith('css.specific.') && keep.has(key) === false) ||
        key.startsWith('css.procedural.')
    );
    if ( obsolete.length === 0 ) { return false; }
    await area.remove(obsolete);
    return true;
};

const exactMatchesFromHostnames = hostnames => {
    const out = [];
    const seen = new Set();
    for ( const hostname of hostnames || [] ) {
        if ( typeof hostname !== 'string' || hostname.trim() === '' ) { continue; }
        const normalized = hostname.trim().toLowerCase();
        const match = `*://${normalized}/*`;
        if ( seen.has(match) ) { continue; }
        seen.add(match);
        out.push(match);
    }
    return out;
};

const pushExactExcludeMatches = (excludeMatches, hostnames) => {
    if ( Array.isArray(excludeMatches) === false || Array.isArray(hostnames) === false ) {
        return;
    }
    const seen = new Set(excludeMatches);
    for ( const match of exactMatchesFromHostnames(hostnames) ) {
        if ( seen.has(match) ) { continue; }
        seen.add(match);
        excludeMatches.push(match);
    }
};

const readActiveSubsystemSuppressionHostnames = async () => {
    const stored = await readOptionalLocalValue(
        AUTO_BACKOFF_SUBSYSTEMS_KEY,
        {},
        `registerInjectables/${AUTO_BACKOFF_SUBSYSTEMS_KEY}`
    );
    const out = Object.fromEntries(
        SUPPRESSIBLE_SUBSYSTEMS.map(id => [ id, [] ])
    );
    if ( stored instanceof Object === false ) { return out; }
    const now = Date.now();
    for ( const [ hostname, subsystems ] of Object.entries(stored) ) {
        if ( typeof hostname !== 'string' || hostname.trim() === '' ) { continue; }
        if ( subsystems instanceof Object === false ) { continue; }
        for ( const subsystemId of SUPPRESSIBLE_SUBSYSTEMS ) {
            const expiresAt = Number(subsystems?.[subsystemId]?.expiresAt) || 0;
            if ( expiresAt <= now ) { continue; }
            out[subsystemId].push(hostname.trim().toLowerCase());
        }
    }
    return out;
};

const classifyRemoteCosmeticsState = cosmetics => {
    const hostnames = [];
    const seen = new Set();
    let hasGlobal = Array.isArray(cosmetics?.all) && cosmetics.all.length !== 0;
    const hosts = cosmetics?.hosts;
    if ( hosts instanceof Object ) {
        for ( const [ pattern, selectors ] of Object.entries(hosts) ) {
            if ( Array.isArray(selectors) === false || selectors.length === 0 ) { continue; }
            const normalized = `${pattern || ''}`.trim().toLowerCase();
            if ( normalized.startsWith('=') ) {
                const hostname = normalized.slice(1);
                if ( hostname === '' || seen.has(hostname) ) { continue; }
                seen.add(hostname);
                hostnames.push(hostname);
                continue;
            }
            hasGlobal = true;
        }
    }
    return {
        hasGlobal,
        hostnames,
    };
};

const collectRegisteredRemoteCosmeticHostnames = (
    filteringModeDetails,
    remoteCosmetics,
) => {
    const cosmeticHostnames = classifyRemoteCosmeticsState(remoteCosmetics).hostnames;
    if ( cosmeticHostnames.length === 0 ) { return []; }
    const hasBroadHostPermission =
        filteringModeDetails?.optimal?.has?.('all-urls') ||
        filteringModeDetails?.complete?.has?.('all-urls');
    if ( hasBroadHostPermission ) { return cosmeticHostnames; }
    const permissionGrantedHostnames = [
        ...(filteringModeDetails?.optimal || []),
        ...(filteringModeDetails?.complete || []),
    ];
    if ( permissionGrantedHostnames.length === 0 ) { return []; }
    return ut.intersectHostnameIters(cosmeticHostnames, permissionGrantedHostnames);
};

/******************************************************************************/

// Some scriptlets do not need to run in about:blank fallback frames and can
// trigger noisy sandbox errors there.
const SCRIPTLETS_NO_ORIGIN_FALLBACK = new Set([
    'ublock-filters.trusted-prevent-dom-bypass',
]);

const shouldUseOriginFallbackForScriptlet = (rulesetId, token) => {
    return SCRIPTLETS_NO_ORIGIN_FALLBACK.has(`${rulesetId}.${token}`) === false;
};

/******************************************************************************/

// Some scriptlets are intended for the top frame only.
const SCRIPTLETS_TOP_FRAME_ONLY = new Set([
    'ublock-filters.trusted-prevent-dom-bypass',
]);

const shouldUseAllFramesForScriptlet = (rulesetId, token) => {
    return SCRIPTLETS_TOP_FRAME_ONLY.has(`${rulesetId}.${token}`) === false;
};

/******************************************************************************/

// The extensions API does not always return exactly what we fed it, so we
// need to normalize some entries to be sure we properly detect changes when
// comparing registered entries vs. entries to register.

const normalizeRegisteredContentScripts = registered => {
    for ( const entry of registered ) {
        const { css = [], js = [] } = entry;
        for ( let i = 0; i < css.length; i++ ) {
            const path = css[i];
            if ( path.startsWith('/') ) { continue; }
            css[i] = `/${path}`;
        }
        for ( let i = 0; i < js.length; i++ ) {
            const path = js[i];
            if ( path.startsWith('/') ) { continue; }
            js[i] = `/${path}`;
        }
    }
    return registered;
};

const reconcileContentScript = (context, directive) => {
    const registered = context.before.get(directive.id);
    context.before.delete(directive.id);
    if ( registered === undefined ) {
        context.toAdd.push(directive);
        recordPackagedStaticScriptletReloadTransition(
            context.remoteScriptletReloadHint,
            undefined,
            directive
        );
        return;
    }
    if ( contentScriptRegistrationsEqual(registered, directive) ) { return; }
    context.toRemove.push(directive.id);
    context.toAdd.push(directive);
    recordPackagedStaticScriptletReloadTransition(
        context.remoteScriptletReloadHint,
        registered,
        directive
    );
};

/******************************************************************************/

function registerGeneric(context, genericDetails) {
    const { before, filteringModeDetails, rulesetsDetails } = context;

    const excludedByFilter = [];
    const includedByFilter = [];
    const js = [];
    for ( const details of rulesetsDetails ) {
        const hostnames = genericDetails.get(details.id);
        if ( hostnames ) {
            if ( hostnames.unhide ) {
                excludedByFilter.push(...hostnames.unhide);
            }
            if ( hostnames.hide ) {
                includedByFilter.push(...hostnames.hide);
            }
        }
        const count = details.css?.generic || 0;
        if ( count === 0 ) { continue; }
        js.push(`/rulesets/scripting/generic/${details.id}.js`);
    }

    if ( js.length === 0 ) { return; }

    js.unshift('/js/scripting/css-api.js', '/js/scripting/isolated-api.js');
    js.push('/js/scripting/css-generic.js');

    const { none, basic, optimal, complete } = filteringModeDetails;
    const includedByMode = [ ...complete ];
    const excludedByMode = [ ...none, ...basic, ...optimal ];

    if ( complete.has('all-urls') === false ) {
        const matches = [
            ...ut.matchesFromHostnames(
                ut.subtractHostnameIters(includedByMode, excludedByFilter)
            ),
            ...ut.matchesFromHostnames(
                ut.intersectHostnameIters(includedByMode, includedByFilter)
            ),
        ];
        if ( matches.length === 0 ) { return; }
        const directive = {
            id: 'css-generic-some',
            js,
            allFrames: true,
            matchOriginAsFallback: true,
            matches,
            runAt: 'document_idle',
        };
        reconcileContentScript(context, directive);
        return;
    }

    const excludeMatches = [
        ...ut.matchesFromHostnames(excludedByMode),
        ...ut.matchesFromHostnames(excludedByFilter),
    ];
    const directiveAll = {
        id: 'css-generic-all',
        js,
        allFrames: true,
        matchOriginAsFallback: true,
        matches: [ '<all_urls>' ],
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directiveAll.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directiveAll);
    const matches = [
        ...ut.matchesFromHostnames(
            ut.subtractHostnameIters(includedByFilter, excludedByMode)
        ),
    ];
    if ( matches.length === 0 ) { return; }
    const directiveSome = {
        id: 'css-generic-some',
        js,
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_idle',
    };
    reconcileContentScript(context, directiveSome);
}

/******************************************************************************/

function registerProcedural(context) {
    const { before, filteringModeDetails, rulesetsDetails } = context;

    const js = [];
    for ( const rulesetDetails of rulesetsDetails ) {
        const count = rulesetDetails.css?.procedural || 0;
        if ( count === 0 ) { continue; }
        js.push(`/rulesets/scripting/procedural/${rulesetDetails.id}.js`);
    }
    if ( js.length === 0 ) { return; }

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    js.unshift(
        '/js/scripting/css-api.js',
        '/js/scripting/isolated-api.js',
        '/js/scripting/css-procedural-api.js'
    );
    js.push('/js/scripting/css-procedural.js');

    const excludeMatches = [];
    if ( none.has('all-urls') === false && basic.has('all-urls') === false ) {
        const toExclude = [
            ...ut.matchesFromHostnames(none),
            ...ut.matchesFromHostnames(basic),
        ];
        for ( const hn of toExclude ) {
            excludeMatches.push(hn);
        }
    }

    const directive = {
        id: 'css-procedural',
        js,
        matches,
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

async function registerSpecific(context) {
    const { filteringModeDetails, rulesetsDetails } = context;

    const rulesetIds = [];
    for ( const rulesetDetails of rulesetsDetails ) {
        const count = rulesetDetails.css?.specific ?? 0;
        if ( count === 0 ) { continue; }
        rulesetIds.push(rulesetDetails.id);
    }
    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( rulesetIds.length === 0 || matches.length === 0 ) {
        context.specificCosmeticKeepKeys = [];
        return;
    }

    const prepared = await prepareSpecificCosmeticData(rulesetIds);
    context.specificCosmeticKeepKeys = prepared.keepKeys;
    context.cosmeticDataChanged ||= prepared.changed;

    normalizeMatches(matches);

    const js = rulesetIds.map(id => `/rulesets/scripting/specific/${id}.js`);
    js.unshift(
        '/js/scripting/css-api.js',
        '/js/scripting/isolated-api.js',
        '/js/scripting/css-procedural-api.js'
    );
    js.push('/js/scripting/css-specific.js');

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }

    const directive = {
        id: 'css-specific',
        js,
        matches,
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

function registerScriptlet(context, scriptletDetails) {
    const { before, filteringModeDetails, rulesetsDetails } = context;
    const scriptletExcludedHostnames = getScriptletExcludedHostnames();

    const hasBroadHostPermission =
        filteringModeDetails.optimal.has('all-urls') ||
        filteringModeDetails.complete.has('all-urls');

    const permissionRevokedMatches = [
        ...ut.matchesFromHostnames(filteringModeDetails.none),
        ...ut.matchesFromHostnames(filteringModeDetails.basic),
    ];
    const permissionGrantedHostnames = [
        ...filteringModeDetails.optimal,
        ...filteringModeDetails.complete,
    ];

    for ( const rulesetId of rulesetsDetails.map(v => v.id) ) {
        if ( rulesetId === 'talon-site-fixes' ) { continue; }
        const worlds = scriptletDetails.get(rulesetId);
        if ( worlds instanceof Object === false ) { continue; }

        for ( const world of Object.keys(worlds) ) {
            if ( world !== 'MAIN' && world !== 'ISOLATED' ) { continue; }
            const id = `${rulesetId}.${world.toLowerCase()}`;
            const hostnames = Array.isArray(worlds[world]) ? worlds[world] : [];

            const matches = [];
            const excludeMatches = [];
            let targetHostnames = [];
            if ( hasBroadHostPermission ) {
                excludeMatches.push(...permissionRevokedMatches);
                excludeMatches.push(...ut.matchesFromHostnames(scriptletExcludedHostnames));
                targetHostnames = hostnames;
            } else if ( permissionGrantedHostnames.length !== 0 ) {
                if ( hostnames.includes('*') ) {
                    targetHostnames = permissionGrantedHostnames;
                } else {
                    targetHostnames = ut.intersectHostnameIters(
                        hostnames,
                        permissionGrantedHostnames
                    );
                }
                targetHostnames = ut.subtractHostnameIters(
                    targetHostnames,
                    scriptletExcludedHostnames
                );
            }
            if ( targetHostnames.length === 0 ) { continue; }
            matches.push(...ut.matchesFromHostnames(targetHostnames));
            normalizeMatches(matches);

            const directive = {
                id,
                js: [ `/rulesets/scripting/scriptlet/${world.toLowerCase()}/${rulesetId}.js` ],
                matches,
                allFrames: true,
                matchOriginAsFallback: true,
                runAt: 'document_start',
                world,
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches;
            }

            const registered = before.get(id);
            before.delete(id);
            if ( registered === undefined ) {
                context.toAdd.push(directive);
                recordPackagedStaticScriptletReloadTransition(
                    context.remoteScriptletReloadHint,
                    undefined,
                    directive
                );
                continue;
            }
            if ( contentScriptRegistrationsEqual(registered, directive) ) {
                continue;
            }
            context.toRemove.push(id);
            context.toAdd.push(directive);
            recordPackagedStaticScriptletReloadTransition(
                context.remoteScriptletReloadHint,
                registered,
                directive
            );
        }
    }
}

/******************************************************************************/

function registerRemoteScriptlets(context, scriptletDetails) {
    const {
        before,
        filteringModeDetails,
        remoteScriptlets,
    } = context;
    const scriptletExcludedHostnames = getScriptletExcludedHostnames();
    const canonicalRemoteScriptlets = canonicalizeCommunityScriptlets(remoteScriptlets);
    if ( Array.isArray(canonicalRemoteScriptlets) === false ||
        canonicalRemoteScriptlets.length === 0 ) {
        return;
    }

    // Build a set of valid scriptlets bundled in the extension.
    const validIds = new Set();
    for ( const [ rulesetId, list ] of scriptletDetails ) {
        if ( Array.isArray(list) === false ) { continue; }
        for ( const [ token ] of list ) {
            validIds.add(`${rulesetId}.${token}`);
        }
    }

    const hasBroadHostPermission =
        filteringModeDetails.optimal.has('all-urls') ||
        filteringModeDetails.complete.has('all-urls');

    const permissionRevokedMatches = [
        ...ut.matchesFromHostnames(filteringModeDetails.none),
        ...ut.matchesFromHostnames(filteringModeDetails.basic),
    ];
    const permissionGrantedHostnames = [
        ...filteringModeDetails.optimal,
        ...filteringModeDetails.complete,
    ];

    for ( const details of canonicalRemoteScriptlets ) {
        const rulesetId = details?.rulesetId;
        const token = details?.token;
        if ( typeof rulesetId !== 'string' || typeof token !== 'string' ) { continue; }
        const baseId = `${rulesetId}.${token}`;
        if ( validIds.has(baseId) === false ) { continue; }

        const world = details.world === 'MAIN' ? 'MAIN' : 'ISOLATED';
        const id = `remote-scriptlet.${world.toLowerCase()}.${baseId}`;
        const registered = before.get(id);

        const excludeMatches = [];
        let targetHostnames = [];
        if ( hasBroadHostPermission ) {
            excludeMatches.push(...permissionRevokedMatches);
            excludeMatches.push(...ut.matchesFromHostnames(scriptletExcludedHostnames));
            targetHostnames = Array.isArray(details.hosts) ? details.hosts : [];
        } else if ( permissionGrantedHostnames.length !== 0 ) {
            const hosts = Array.isArray(details.hosts) ? details.hosts : [];
            if ( hosts.includes('*') ) {
                targetHostnames = permissionGrantedHostnames;
            } else {
                targetHostnames = ut.intersectHostnameIters(
                    hosts,
                    permissionGrantedHostnames
                );
            }
            targetHostnames = ut.subtractHostnameIters(
                targetHostnames,
                scriptletExcludedHostnames
            );
        }
        if ( targetHostnames.length === 0 ) { continue; }

        const matches = ut.matchesFromHostnames(targetHostnames);
        if ( matches.length === 0 ) { continue; }
        normalizeMatches(matches);

        const directive = {
            id,
            js: [ getScriptletPath(baseId) ],
            matches,
            allFrames: shouldUseAllFramesForScriptlet(rulesetId, token),
            matchOriginAsFallback: shouldUseOriginFallbackForScriptlet(rulesetId, token),
            runAt: 'document_start',
            world,
        };
        if ( excludeMatches.length !== 0 ) {
            directive.excludeMatches = excludeMatches;
        }

        before.delete(id);
        if ( registered === undefined ) {
            context.toAdd.push(directive);
            context.remoteScriptletReloadHint.after.push(directive);
            continue;
        }

        if ( contentScriptRegistrationsEqual(registered, directive) === false ) {
            context.toRemove.push(id);
            context.toAdd.push(directive);
            context.remoteScriptletReloadHint.before.push(registered);
            context.remoteScriptletReloadHint.after.push(directive);
        }
    }
}

/******************************************************************************/

function registerTalonSiteFixesMain(context) {
    const enabled = context.rulesetsDetails.some(
        details => details.id === 'talon-site-fixes'
    );
    if ( enabled === false ) { return; }

    const { none } = context.filteringModeDetails;
    // Player-host registrations are meaningful only when embedded by the
    // French Stream top-level site. If that source site is allowlisted, omit
    // the entire lane so cross-origin player frames cannot bypass the choice.
    if ( modeSetCoversHostname(none, 'french-stream.one') ) { return; }
    const targetHostnames = TALON_SITE_FIX_HOSTNAMES.filter(
        hostname => modeSetCoversHostname(none, hostname) === false
    );
    if ( targetHostnames.length === 0 ) { return; }

    const directive = {
        id: TALON_SITE_FIXES_MAIN_ID,
        js: [ TALON_SITE_FIXES_MAIN_PATH ],
        matches: ut.matchesFromHostnames(targetHostnames),
        allFrames: true,
        runAt: 'document_start',
        world: 'MAIN',
    };
    if ( none.size !== 0 ) {
        directive.excludeMatches = ut.matchesFromHostnames(none);
    }
    reconcileContentScript(context, directive);
}

/******************************************************************************/

function registerNativeHeuristics(context) {
    const { before, filteringModeDetails, subsystemSuppressionHostnames } = context;

    const js = [
        TALON_PUBLIC_SUFFIX_DATA_PATH,
        '/shared/site-key-resolver.js',
        '/js/scripting/breakage-guard.js',
        TALON_COOPERATIVE_SCHEDULER_PATH,
        TALON_SHADOW_DOM_HELPER_PATH,
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/native-heuristics.js',
    ];

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }
    pushExactExcludeMatches(
        excludeMatches,
        subsystemSuppressionHostnames?.nativeHeuristics
    );

    const directive = {
        id: 'native-heuristics',
        js,
        allFrames: false,
        matches,
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

function registerAutomation(context) {
    const {
        filteringModeDetails,
        subsystemSuppressionHostnames,
        rulesetsDetails,
        remoteAutomationDirectives,
    } = context;

    const enabledRulesetIds = new Set(
        rulesetsDetails.map(details => details?.id).filter(Boolean)
    );
    const packagedAutomationActive =
        enabledRulesetIds.has('annoyances-overlays');
    const remoteAutomationMatches = getRemoteAutomationRegistrationMatches(
        remoteAutomationDirectives,
        enabledRulesetIds,
        filteringModeDetails
    );
    if (
        packagedAutomationActive === false &&
        remoteAutomationMatches.length === 0
    ) { return; }

    const js = [
        '/js/scripting/breakage-guard.js',
        TALON_COOPERATIVE_SCHEDULER_PATH,
        TALON_SHADOW_DOM_HELPER_PATH,
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/automation.js',
    ];

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = packagedAutomationActive
        ? [
            ...ut.matchesFromHostnames(optimal),
            ...ut.matchesFromHostnames(complete),
        ]
        : remoteAutomationMatches;
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }
    pushExactExcludeMatches(
        excludeMatches,
        subsystemSuppressionHostnames?.automation
    );

    const directive = {
        id: 'automation',
        js,
        allFrames: false,
        matches,
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

const modeSetCoversHostname = (modeSet, hostname) => {
    if ( modeSet instanceof Set === false ) { return false; }
    return modeSet.has('all-urls') || modeSet.has('*') || modeSet.has(hostname) ||
        ut.isDescendantHostnameOfIter(hostname, modeSet);
};

function registerYouTubeLane(context, baseId, files, world) {
    const scopes = getYouTubeRegistrationScopes(
        context.filteringModeDetails,
        context.subsystemSuppressionHostnames?.youtubeAdSkip || []
    );
    scopes.forEach((scope, index) => {
        const id = index === 0 ? baseId : `${baseId}.${index}`;
        const directive = {
            id, js: files, allFrames: true,
            matches: scope.matches, excludeMatches: scope.excludeMatches,
            runAt: 'document_start', persistAcrossSessions: true,
            ...(world ? { world } : {}),
        };
        const registered = context.before.get(id);
        context.before.delete(id);
        if ( registered === undefined ) {
            context.toAdd.push(directive);
        } else if ( contentScriptRegistrationsEqual(registered, directive) === false ) {
            context.toRemove.push(id);
            context.toAdd.push(directive);
        }
    });
}

function registerYouTubeAdSkip(context) {
    registerYouTubeLane(context, TALON_YOUTUBE_AD_SKIP_ID, [
        '/js/scripting/breakage-guard.js', TALON_YOUTUBE_AD_SKIP_PATH,
    ]);
}

function registerYouTubePlayerGuard(context) {
    registerYouTubeLane(context, TALON_YOUTUBE_PLAYER_GUARD_ID, [
        TALON_YOUTUBE_PLAYER_GUARD_PATH,
    ], 'MAIN');
}

/******************************************************************************/

function registerAdShellStyles(context) {
    const {
        before,
        filteringModeDetails,
        subsystemSuppressionHostnames,
    } = context;

    const js = [
        '/js/scripting/breakage-guard.js',
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/ad-shell-styles.js',
    ];

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(basic),
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    pushExactExcludeMatches(
        excludeMatches,
        subsystemSuppressionHostnames?.adShellStyles
    );

    const directive = {
        id: 'ad-shell-styles',
        js,
        allFrames: false,
        matches,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

function registerRemoteCosmetics(context) {
    const {
        before,
        filteringModeDetails,
        subsystemSuppressionHostnames,
        remoteCosmetics,
    } = context;

    const baseJs = [
        TALON_PUBLIC_SUFFIX_DATA_PATH,
        '/shared/site-key-resolver.js',
        '/js/scripting/breakage-guard.js',
        TALON_COOPERATIVE_SCHEDULER_PATH,
        TALON_SHADOW_DOM_HELPER_PATH,
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/remote-cosmetics.js',
    ];
    const { none, basic, optimal, complete } = filteringModeDetails;
    const broadMatches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( broadMatches.length === 0 ) { return; }
    normalizeMatches(broadMatches);

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }
    pushExactExcludeMatches(
        excludeMatches,
        subsystemSuppressionHostnames?.remoteCosmetics
    );

    const registeredGlobal = before.get('remote-cosmetics-global');
    before.delete('remote-cosmetics-global'); // Important!
    const registeredHost = before.get('remote-cosmetics-host');
    before.delete('remote-cosmetics-host'); // Important!
    const registeredLegacy = before.get('remote-cosmetics');
    before.delete('remote-cosmetics'); // Important!
    if ( registeredLegacy !== undefined ) {
        context.toRemove.push('remote-cosmetics');
    }

    const { hasGlobal } = classifyRemoteCosmeticsState(remoteCosmetics);
    if ( hasGlobal ) {
        const globalDirective = {
            id: 'remote-cosmetics-global',
            js: [
                ...baseJs,
                '/js/scripting/remote-cosmetics-global.js',
            ],
            allFrames: true,
            matchOriginAsFallback: true,
            matches: broadMatches,
            runAt: 'document_start',
        };
        if ( excludeMatches.length !== 0 ) {
            globalDirective.excludeMatches = excludeMatches;
        }
        if ( registeredGlobal === undefined ) {
            context.toAdd.push(globalDirective);
        } else if ( contentScriptRegistrationsEqual(
            registeredGlobal,
            globalDirective
        ) === false ) {
            context.toRemove.push('remote-cosmetics-global');
            context.toAdd.push(globalDirective);
        }
    } else if ( registeredGlobal !== undefined ) {
        context.toRemove.push('remote-cosmetics-global');
    }

    const targetHostnames = collectRegisteredRemoteCosmeticHostnames(
        filteringModeDetails,
        remoteCosmetics
    );
    const hostMatches = exactMatchesFromHostnames(targetHostnames);
    if ( hostMatches.length !== 0 ) {
        normalizeMatches(hostMatches);
        const hostDirective = {
            id: 'remote-cosmetics-host',
            js: [
                ...baseJs,
                '/js/scripting/remote-cosmetics-host.js',
            ],
            allFrames: true,
            matchOriginAsFallback: true,
            matches: hostMatches,
            runAt: 'document_start',
        };
        if ( excludeMatches.length !== 0 ) {
            hostDirective.excludeMatches = excludeMatches;
        }
        if ( registeredHost === undefined ) {
            context.toAdd.push(hostDirective);
        } else if ( contentScriptRegistrationsEqual(
            registeredHost,
            hostDirective
        ) === false ) {
            context.toRemove.push('remote-cosmetics-host');
            context.toAdd.push(hostDirective);
        }
    } else if ( registeredHost !== undefined ) {
        context.toRemove.push('remote-cosmetics-host');
    }
}

/******************************************************************************/

function registerPostHideCleanup(context) {
    const { before, filteringModeDetails, subsystemSuppressionHostnames } = context;

    const js = [
        '/js/scripting/breakage-guard.js',
        TALON_COOPERATIVE_SCHEDULER_PATH,
        TALON_SHADOW_DOM_HELPER_PATH,
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/post-hide-cleanup.js',
    ];

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }
    pushExactExcludeMatches(
        excludeMatches,
        subsystemSuppressionHostnames?.postHideCleanup
    );

    const directive = {
        id: 'post-hide-cleanup',
        js,
        allFrames: false,
        matches,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    reconcileContentScript(context, directive);
}

/******************************************************************************/

// Issue: Safari appears to completely ignore excludeMatches
// https://github.com/radiolondra/ExcludeMatches-Test

const writeInjectableSyncDiagnostics = async result => {
    if ( result instanceof Object === false ) { return; }
    const payload = {
        ok: result.ok === true,
        updatedAt: Number(result.updatedAt) || Date.now(),
        attemptedRecovery: result.attemptedRecovery === true,
        recovered: result.recovered === true,
        initialError: typeof result.initialError === 'string'
            ? result.initialError
            : '',
        lastError: typeof result.lastError === 'string'
            ? result.lastError
            : '',
        recoveryResetError: typeof result.recoveryResetError === 'string'
            ? result.recoveryResetError
            : '',
        recoveryResetCount: Math.max(0, Number(result.recoveryResetCount) || 0),
        toAddCount: Math.max(0, Number(result.toAddCount) || 0),
        toUpdateCount: Math.max(0, Number(result.toUpdateCount) || 0),
        toRemoveCount: Math.max(0, Number(result.toRemoveCount) || 0),
        uncertain: result.uncertain === true,
        registeredTacticsHostCount: Math.max(
            0,
            Number(result.registeredTacticsHostCount) || 0
        ),
    };
    await localWrite(INJECTABLE_SYNC_DIAGNOSTICS_KEY, payload);
};

const logInjectableSyncResult = result => {
    if ( result instanceof Object === false ) { return; }
    if ( result.ok === true ) {
        if ( result.attemptedRecovery === true ) {
            ubolLog('injectable sync: recovered after clean retry');
        }
        return;
    }
    const parts = [
        typeof result.initialError === 'string' && result.initialError !== ''
            ? `initial ${result.initialError}`
            : '',
        typeof result.lastError === 'string' && result.lastError !== ''
            ? `final ${result.lastError}`
            : '',
        typeof result.recoveryResetError === 'string' && result.recoveryResetError !== ''
            ? `reset ${result.recoveryResetError}`
            : '',
    ].filter(part => part !== '');
    ubolErr(`injectable sync: ${parts.join('; ') || 'failed'}`);
};

async function readInjectableSyncDiagnostics() {
    return readOptionalLocalValue(
        INJECTABLE_SYNC_DIAGNOSTICS_KEY,
        null,
        `registerInjectables/${INJECTABLE_SYNC_DIAGNOSTICS_KEY}`
    );
}

const buildInjectablesRegistrationPlan = async () => {
    if ( browser.scripting === undefined ) {
        return { toAdd: [], toRemove: [] };
    }
    const [
        filteringModeDetails,
        rulesetsDetails,
        scriptletDetails,
        scriptletTokenDetails,
        genericDetails,
        remoteCosmetics,
        remoteScriptlets,
        remoteAutomationDirectives,
        subsystemSuppressionHostnames,
        registered,
    ] = await Promise.all([
        getFilteringModeDetails(),
        getEnabledRulesetsDetails(),
        getScriptletDetails(),
        getScriptletTokenDetails(),
        getGenericDetails(),
        readOptionalLocalValue(
            PUBLIC_REMOTE_COSMETICS_KEY,
            null,
            `registerInjectables/${PUBLIC_REMOTE_COSMETICS_KEY}`
        ),
        readMergedLocalArrays(
            [
                PUBLIC_REMOTE_SCRIPTLETS_KEY,
                PRIVATE_REMOTE_SCRIPTLETS_KEY,
                LEGACY_REMOTE_SCRIPTLETS_KEY,
            ],
            'registerInjectables/remote-scriptlets'
        ),
        readMergedLocalArrays(
            [
                PUBLIC_REMOTE_DIRECTIVES_KEY,
                PRIVATE_REMOTE_DIRECTIVES_KEY,
                LEGACY_REMOTE_DIRECTIVES_KEY,
            ],
            'registerInjectables/remote-directives'
        ),
        readActiveSubsystemSuppressionHostnames(),
        browser.scripting.getRegisteredContentScripts(),
    ]);
    const before = new Map(
        normalizeRegisteredContentScripts(registered).map(
            entry => [ entry.id, entry ]
        )
    );
    applyInternalUnfilteredDomains(filteringModeDetails);
    const toAdd = [], toRemove = [];
    const context = {
        filteringModeDetails,
        rulesetsDetails,
        before,
        toAdd,
        toRemove,
        remoteCosmetics: remoteCosmetics instanceof Object ? remoteCosmetics : null,
        remoteScriptlets,
        remoteAutomationDirectives,
        subsystemSuppressionHostnames,
        remoteScriptletReloadHint: {
            before: [],
            after: [],
        },
        registeredTacticsHostCount: 0,
        specificCosmeticKeepKeys: [],
        cosmeticDataChanged: false,
    };

    await Promise.all([
        registerProcedural(context),
        registerScriptlet(context, scriptletDetails),
        registerRemoteScriptlets(context, scriptletTokenDetails),
        registerTalonSiteFixesMain(context),
        registerPreventPopup(context),
        registerSpecific(context),
        registerNativeHeuristics(context),
        registerAutomation(context),
        registerYouTubePlayerGuard(context),
        registerYouTubeAdSkip(context),
        registerAdShellStyles(context),
        registerRemoteCosmetics(context),
        registerPostHideCleanup(context),
        registerGeneric(context, genericDetails),
        registerCustomFilters(context),
        registerToolbarIconToggler(context),
    ]);

    for ( const [id, entry] of before ) {
        if ( isRemoteScriptletDirectiveId(id) ) {
            context.remoteScriptletReloadHint.before.push(entry);
            continue;
        }
        recordPackagedStaticScriptletReloadTransition(
            context.remoteScriptletReloadHint,
            entry,
            undefined
        );
    }
    toRemove.push(...Array.from(before.keys()));
    return {
        toAdd,
        toRemove,
        registeredTacticsHostCount: context.registeredTacticsHostCount,
        remoteScriptletReloadHint: normalizeRemoteScriptletReloadHint(
            context.remoteScriptletReloadHint
        ),
        specificCosmeticKeepKeys: context.specificCosmeticKeepKeys,
        cosmeticDataChanged: context.cosmeticDataChanged,
    };
};

const registrationPlanHasMutations = plan =>
    Array.isArray(plan?.toAdd) && plan.toAdd.length !== 0 ||
    Array.isArray(plan?.toUpdate) && plan.toUpdate.length !== 0 ||
    Array.isArray(plan?.toRemove) && plan.toRemove.length !== 0;

const buildInjectablesRegistrationPlanWithCacheMarker = async () => {
    const plan = await buildInjectablesRegistrationPlan();
    if (
        registrationPlanHasMutations(plan) ||
        plan?.cosmeticDataChanged === true
    ) {
        // This runs after the authoritative plan has been built but before any
        // Chrome registration mutation is attempted.
        if ( typeof browser.storage?.local?.set !== 'function' ) {
            throw new Error('local storage API unavailable');
        }
        const markerPatch = { [CSS_CACHE_DIRTY_KEY]: true };
        if ( plan.remoteScriptletReloadHint instanceof Object ) {
            if ( typeof browser.storage.local.get !== 'function' ) {
                throw new Error('local storage read API unavailable');
            }
            const pendingBin = await browser.storage.local.get(
                PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY
            );
            markerPatch[PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY] =
                mergeRemoteScriptletReloadHints(
                    pendingBin?.[PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY],
                    plan.remoteScriptletReloadHint
                );
        }
        await browser.storage.local.set(markerPatch);
    }
    return plan;
};

const createContentScriptRegistrationMutationJournal = () => {
    let active = false;
    return {
        async recover() {
            const marker = await readOptionalLocalValue(
                CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY,
                false,
                `registerInjectables/${CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY}`
            );
            if ( marker === false || marker === undefined ) { return false; }
            active = true;
            if (
                typeof browser.scripting?.unregisterContentScripts !==
                    'function'
            ) {
                throw new Error('content-script unregister API unavailable');
            }
            // Chrome's listing API omits IDs which are still being validated.
            // The no-argument form cancels both loaded and pending dynamic IDs.
            await browser.scripting.unregisterContentScripts();
            return true;
        },
        async mark(details = {}) {
            if ( typeof browser.storage?.local?.set !== 'function' ) {
                throw new Error('local storage API unavailable');
            }
            await browser.storage.local.set({
                [CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY]: {
                    schema: 1,
                    updatedAt: Date.now(),
                    phase: typeof details.phase === 'string'
                        ? details.phase
                        : '',
                    toAddCount: Math.max(0, Number(details.toAddCount) || 0),
                    toUpdateCount:
                        Math.max(0, Number(details.toUpdateCount) || 0),
                    toRemoveCount:
                        Math.max(0, Number(details.toRemoveCount) || 0),
                },
            });
            active = true;
        },
        async verify() {
            if ( active === false ) { return true; }
            const plan = await buildInjectablesRegistrationPlan();
            return registrationPlanHasMutations(plan) === false;
        },
        async clear() {
            if ( typeof browser.storage?.local?.remove !== 'function' ) {
                throw new Error('local storage API unavailable');
            }
            await browser.storage.local.remove(
                CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY
            );
            active = false;
        },
    };
};

const registerInjectablesImpl = async () => {
    if ( injectableRegistrationSuspended ) {
        return {
            ok: false,
            skipped: 'suspended',
            updatedAt: Date.now(),
            attemptedRecovery: false,
            recovered: false,
            initialError: '',
            lastError: '',
            recoveryResetError: '',
            recoveryResetCount: 0,
            toAddCount: 0,
            toUpdateCount: 0,
            toRemoveCount: 0,
        };
    }
    if ( browser.scripting === undefined ) {
        const unsupported = {
            ok: false,
            updatedAt: Date.now(),
            attemptedRecovery: false,
            recovered: false,
            initialError: '',
            lastError: 'browser.scripting unavailable',
            recoveryResetError: '',
            recoveryResetCount: 0,
            toAddCount: 0,
            toUpdateCount: 0,
            toRemoveCount: 0,
        };
        await writeInjectableSyncDiagnostics(unsupported);
        return unsupported;
    }

    const registrationMutationJournal =
        createContentScriptRegistrationMutationJournal();
    let result = await runInjectableRegistrationFlow({
        buildPlan: buildInjectablesRegistrationPlanWithCacheMarker,
        listRegistered: () => browser.scripting.getRegisteredContentScripts(),
        updateContentScripts: async entries => {
            if ( entries.length === 0 ) { return; }
            ubolLog(`Updated ${entries.map(entry => entry.id)} content (css/js)`);
            await browser.scripting.updateContentScripts(entries);
        },
        unregisterContentScripts: async ids => {
            if ( ids.length === 0 ) { return; }
            ubolLog(`Unregistered ${ids} content (css/js)`);
            await browser.scripting.unregisterContentScripts({ ids });
        },
        registerContentScripts: async entries => {
            if ( entries.length === 0 ) { return; }
            ubolLog(`Registered ${entries.map(entry => entry.id)} content (css/js)`);
            await browser.scripting.registerContentScripts(entries);
        },
        registrationMutationJournal,
        operationTimeoutMs: INJECTABLE_REGISTRATION_OPERATION_TIMEOUT_MS,
    });
    if ( result.ok === true ) {
        uncertainReconcileScheduled = false;
        const registrationsChanged =
            result.toAddCount !== 0 ||
            result.toUpdateCount !== 0 ||
            result.toRemoveCount !== 0;
        try {
            const cssCacheDirtyValue = await readOptionalLocalValue(
                CSS_CACHE_DIRTY_KEY,
                false,
                `registerInjectables/${CSS_CACHE_DIRTY_KEY}`
            );
            const cssCacheDirty =
                cssCacheDirtyValue !== undefined && cssCacheDirtyValue !== false;
            if ( cssCacheDirty || registrationsChanged || result.cosmeticDataChanged ) {
                await cleanupSpecificCosmeticData(
                    result.specificCosmeticKeepKeys
                );
                await resetCSSCache();
                if ( typeof browser.storage?.local?.remove !== 'function' ) {
                    throw new Error('local storage API unavailable');
                }
                await browser.storage.local.remove(CSS_CACHE_DIRTY_KEY);
            }
            await Promise.all([
                localRemove('$scripting.unregisterContentScripts').catch(() => {}),
                localRemove('$scripting.registerContentScripts').catch(() => {}),
                localRemove('$scripting.updateContentScripts').catch(() => {}),
            ]);
        } catch (reason) {
            result = {
                ...result,
                ok: false,
                lastError: `post-registration cosmetic cleanup: ${reason}`,
            };
        }
    } else if ( result.uncertain && uncertainReconcileScheduled === false ) {
        uncertainReconcileScheduled = true;
        waitForTimedOutRegistrationOperations().then(() => {
            // The deferred call owns a fresh timeout/reconciliation cycle. A
            // second timeout must be allowed to schedule its own waiter.
            uncertainReconcileScheduled = false;
            return registerInjectables();
        }).catch(reason => {
            uncertainReconcileScheduled = false;
            ubolErr(`deferred injectable reconciliation/${reason}`);
        });
    }
    await writeInjectableSyncDiagnostics(result);
    logInjectableSyncResult(result);
    return result;
};

const registerInjectablesRunner = createSingleFlightRunner(
    registerInjectablesImpl,
    { trailing: true }
);

async function registerInjectables() {
    if ( injectableRegistrationSuspended ) {
        return registerInjectablesImpl();
    }
    if ( browser.scripting === undefined ) {
        return {
            ok: false,
            updatedAt: Date.now(),
            attemptedRecovery: false,
            recovered: false,
            initialError: '',
            lastError: 'browser.scripting unavailable',
            recoveryResetError: '',
            recoveryResetCount: 0,
            toAddCount: 0,
            toUpdateCount: 0,
            toRemoveCount: 0,
        };
    }
    return registerInjectablesRunner();
}

const setInjectableRegistrationSuspended = value => {
    injectableRegistrationSuspended = value === true;
};

const waitForInjectableRegistrationIdle = () =>
    registerInjectablesRunner.waitForIdle();

/******************************************************************************/

export {
    CONTENT_SCRIPT_REGISTRATION_MUTATION_JOURNAL_KEY,
    INJECTABLE_SYNC_DIAGNOSTICS_KEY,
    readInjectableSyncDiagnostics,
    registerInjectables,
    setInjectableRegistrationSuspended,
    waitForInjectableRegistrationIdle,
};
