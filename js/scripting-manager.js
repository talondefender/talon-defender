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

import { browser, localRead, localRemove, localWrite } from './ext.js';
import { ubolErr, ubolLog } from './debug.js';

import {
    INTERNAL_UNFILTERED_DOMAINS,
    isInternalUnfilteredHostname,
} from './breakage-policy.js';
import { canonicalizeCommunityScriptlets } from './community-sync.js';
import { collectCommunityTacticHostnames } from './community-tactics.js';
import { fetchJSON } from './fetch.js';
import {
    isRemoteScriptletDirectiveId,
    normalizeRemoteScriptletReloadHint,
} from './remote-scriptlet-hotfix.js';
import { getEnabledRulesetsDetails } from './ruleset-manager.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { registerCustomFilters } from './filter-manager.js';
import { runInjectableRegistrationFlow } from './injectable-registration.js';
import { registerToolbarIconToggler } from './action.js';
import { createSingleFlightRunner } from './single-flight.js';

/******************************************************************************/

const resourceDetailPromises = new Map();
const PUBLIC_REMOTE_COSMETICS_KEY = 'communityBundleCosmetics';
const PUBLIC_REMOTE_SCRIPTLETS_KEY = 'communityBundlePublicScriptlets';
const PUBLIC_REMOTE_TACTICS_KEY = 'communityBundlePublicTactics';
const PRIVATE_REMOTE_SCRIPTLETS_KEY = 'communityBundlePrivateScriptlets';
const LEGACY_REMOTE_SCRIPTLETS_KEY = 'communityBundleScriptlets';
const AUTO_GENERIC_HIGH_KEY = 'autoGenericHighHosts';
const AUTO_PROMOTION_STATE_KEY = 'autoPromotionStateV2';
const AUTO_BACKOFF_SUBSYSTEMS_KEY = 'autoBackoffSubsystemsV1';
const AUTO_PROMOTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INJECTABLE_SYNC_DIAGNOSTICS_KEY = 'injectableSyncDiagnosticsV1';
const SUPPRESSIBLE_SUBSYSTEMS = Object.freeze([
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'remoteTactics',
    'postHideCleanup',
]);
const SCRIPTLET_PATH_ALIASES = new Map([
    // Upstream YouTube quick fixes now rely on the XHR request editor rather
    // than the older fetch request variant. Reuse the bundled implementation
    // until the next full ruleset refresh lands.
    [
        'ublock-filters.trusted-json-edit-xhr-request',
        '/rulesets/scripting/scriptlet/ublock-experimental.trusted-json-edit-xhr-request.js',
    ],
]);
const TALON_PUBLIC_SUFFIX_DATA_PATH = '/shared/public-suffix-data.js';
const TALON_SHADOW_DOM_HELPER_PATH = '/js/scripting/shadow-dom-helper.js';
const TALON_BLOCK_HINTS_PATH = '/js/scripting/block-hints.js';

const readOptionalLocalValue = async (key, fallbackValue, context) => {
    if ( browser.storage?.local?.get === undefined ) { return fallbackValue; }
    try {
        const bin = await browser.storage.local.get(key);
        if ( bin instanceof Object === false ) { return fallbackValue; }
        return bin[key] ?? fallbackValue;
    } catch(reason) {
        ubolErr(`${context}/${reason}`);
    }
    return fallbackValue;
};

const readMergedLocalArrays = async (keys, context) => {
    if ( browser.storage?.local?.get === undefined ) { return []; }
    try {
        const bin = await browser.storage.local.get(keys);
        if ( bin instanceof Object === false ) { return []; }
        const out = [];
        for ( const key of keys ) {
            const value = bin[key];
            if ( Array.isArray(value) === false ) { continue; }
            out.push(...value);
        }
        return out;
    } catch(reason) {
        ubolErr(`${context}/${reason}`);
    }
    return [];
};

function getScriptletDetails() {
    let promise = resourceDetailPromises.get('scriptlet');
    if ( promise !== undefined ) { return promise; }
    promise = fetchJSON('/rulesets/scriptlet-details').then(
        entries => new Map(entries)
    );
    resourceDetailPromises.set('scriptlet', promise);
    return promise;
}

function getGenericDetails() {
    let promise = resourceDetailPromises.get('generic');
    if ( promise !== undefined ) { return promise; }
    promise = fetchJSON('/rulesets/generic-details').then(
        entries => new Map(entries)
    );
    resourceDetailPromises.set('generic', promise);
    return promise;
}

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
    SCRIPTLET_PATH_ALIASES.get(id) || `/rulesets/scripting/scriptlet/${id}.js`;

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

const readActiveAutoGenericHighHosts = async () => {
    const now = Date.now();
    const state = await readOptionalLocalValue(
        AUTO_PROMOTION_STATE_KEY,
        null,
        `registerInjectables/${AUTO_PROMOTION_STATE_KEY}`
    );
    if ( state?.genericHigh instanceof Object ) {
        const out = new Set();
        for ( const [ hostname, entry ] of Object.entries(state.genericHigh) ) {
            if ( typeof hostname !== 'string' || hostname.trim() === '' ) { continue; }
            const lastHitAt = Number(entry?.lastHitAt ?? entry?.ts ?? entry);
            if ( Number.isFinite(lastHitAt) === false || lastHitAt <= 0 ) { continue; }
            if ( (now - lastHitAt) > AUTO_PROMOTION_TTL_MS ) { continue; }
            out.add(hostname.trim().toLowerCase());
        }
        return out;
    }
    const legacyHosts = await readOptionalLocalValue(
        AUTO_GENERIC_HIGH_KEY,
        [],
        `registerInjectables/${AUTO_GENERIC_HIGH_KEY}`
    );
    return Array.isArray(legacyHosts)
        ? new Set(
            legacyHosts
                .filter(v => typeof v === 'string' && v.trim() !== '')
                .map(v => v.trim().toLowerCase())
        )
        : new Set();
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

const collectRegisteredRemoteTacticHostnames = (
    filteringModeDetails,
    remoteTactics,
) => {
    const tacticHostnames = collectCommunityTacticHostnames(remoteTactics);
    if ( tacticHostnames.length === 0 ) { return []; }
    const hasBroadHostPermission =
        filteringModeDetails?.optimal?.has?.('all-urls') ||
        filteringModeDetails?.complete?.has?.('all-urls');
    if ( hasBroadHostPermission ) { return tacticHostnames; }
    const permissionGrantedHostnames = [
        ...(filteringModeDetails?.optimal || []),
        ...(filteringModeDetails?.complete || []),
    ];
    if ( permissionGrantedHostnames.length === 0 ) { return []; }
    return ut.intersectHostnameIters(tacticHostnames, permissionGrantedHostnames);
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
// trigger noisy sandbox errors there (e.g. YouTube's sandboxed subframes).
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

/******************************************************************************/

function registerHighGeneric(context, genericDetails) {
    const { before, filteringModeDetails, rulesetsDetails, autoGenericHighHosts } = context;

    const excludeHostnames = [];
    const includeHostnames = [];
    const css = [];
    for ( const details of rulesetsDetails ) {
        const hostnames = genericDetails.get(details.id);
        if ( hostnames ) {
            if ( hostnames.unhide ) {
                excludeHostnames.push(...hostnames.unhide);
            }
            if ( hostnames.hide ) {
                includeHostnames.push(...hostnames.hide);
            }
        }
        const count = details.css?.generichigh || 0;
        if ( count === 0 ) { continue; }
        css.push(`/rulesets/scripting/generichigh/${details.id}.css`);
    }

    if ( css.length === 0 ) { return; }

    const { none, basic, optimal, complete } = filteringModeDetails;
    const extendedComplete = new Set(complete);
    if ( autoGenericHighHosts instanceof Set ) {
        for ( const hn of autoGenericHighHosts ) {
            if ( typeof hn !== 'string' || hn === '' ) { continue; }
            extendedComplete.add(hn);
        }
    }
    const matches = [];
    const excludeMatches = [];
    if ( extendedComplete.has('all-urls') ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
        excludeMatches.push(...ut.matchesFromHostnames(basic));
        excludeMatches.push(...ut.matchesFromHostnames(optimal));
        excludeMatches.push(...ut.matchesFromHostnames(excludeHostnames));
        matches.push('<all_urls>');
    } else {
        const excludedByMode = [ ...none, ...basic, ...optimal ];
        matches.push(
            ...ut.matchesFromHostnames(
                ut.subtractHostnameIters(
                    ut.subtractHostnameIters(
                        Array.from(extendedComplete),
                        excludeHostnames
                    ),
                    excludedByMode
                )
            )
        );
    }

    if ( matches.length === 0 ) { return; }

    const registered = before.get('css-generichigh');
    before.delete('css-generichigh'); // Important!

    // https://github.com/w3c/webextensions/issues/414#issuecomment-1623992885
    // Once supported, add:
    // cssOrigin: 'USER',
    const directive = {
        id: 'css-generichigh',
        css,
        matches,
        allFrames: true,
        runAt: 'document_end',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    // register
    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    // update
    if (
        ut.strArrayEq(registered.css, css, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false
    ) {
        context.toRemove.push('css-generichigh');
        context.toAdd.push(directive);
    }
}

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
        const registered = before.get('css-generic-some');
        before.delete('css-generic-some'); // Important!
        const directive = {
            id: 'css-generic-some',
            js,
            allFrames: true,
            matches,
            runAt: 'document_idle',
        };
        if ( registered === undefined ) { // register
            context.toAdd.push(directive);
        } else if ( // update
            ut.strArrayEq(registered.js, js, false) === false ||
            ut.strArrayEq(registered.matches, directive.matches) === false
        ) {
            context.toRemove.push('css-generic-some');
            context.toAdd.push(directive);
        }
        return;
    }

    const excludeMatches = [
        ...ut.matchesFromHostnames(excludedByMode),
        ...ut.matchesFromHostnames(excludedByFilter),
    ];
    const registeredAll = before.get('css-generic-all');
    before.delete('css-generic-all'); // Important!
    const directiveAll = {
        id: 'css-generic-all',
        js,
        allFrames: true,
        matches: [ '<all_urls>' ],
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directiveAll.excludeMatches = excludeMatches;
    }

    if ( registeredAll === undefined ) { // register
        context.toAdd.push(directiveAll);
    } else if ( // update
        ut.strArrayEq(registeredAll.js, js, false) === false ||
        ut.strArrayEq(registeredAll.excludeMatches, directiveAll.excludeMatches) === false
    ) {
        context.toRemove.push('css-generic-all');
        context.toAdd.push(directiveAll);
    }
    const matches = [
        ...ut.matchesFromHostnames(
            ut.subtractHostnameIters(includedByFilter, excludedByMode)
        ),
    ];
    if ( matches.length === 0 ) { return; }
    const registeredSome = before.get('css-generic-some');
    before.delete('css-generic-some'); // Important!
    const directiveSome = {
        id: 'css-generic-some',
        js,
        allFrames: true,
        matches,
        runAt: 'document_idle',
    };
    if ( registeredSome === undefined ) { // register
        context.toAdd.push(directiveSome);
    } else if ( // update
        ut.strArrayEq(registeredSome.js, js, false) === false ||
        ut.strArrayEq(registeredSome.matches, directiveSome.matches) === false
    ) {
        context.toRemove.push('css-generic-some');
        context.toAdd.push(directiveSome);
    }
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

    js.unshift('/js/scripting/css-api.js', '/js/scripting/isolated-api.js');
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

    const registered = before.get('css-procedural');
    before.delete('css-procedural'); // Important!

    const directive = {
        id: 'css-procedural',
        js,
        matches,
        allFrames: true,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    // register
    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    // update
    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false
    ) {
        context.toRemove.push('css-procedural');
        context.toAdd.push(directive);
    }
}

/******************************************************************************/

function registerSpecific(context) {
    const { before, filteringModeDetails, rulesetsDetails } = context;

    const js = [];
    for ( const rulesetDetails of rulesetsDetails ) {
        const count = rulesetDetails.css?.specific || 0;
        if ( count === 0 ) { continue; }
        js.push(`/rulesets/scripting/specific/${rulesetDetails.id}.js`);
    }
    if ( js.length === 0 ) { return; }

    const { none, basic, optimal, complete } = filteringModeDetails;
    const matches = [
        ...ut.matchesFromHostnames(optimal),
        ...ut.matchesFromHostnames(complete),
    ];
    if ( matches.length === 0 ) { return; }

    normalizeMatches(matches);

    js.unshift('/js/scripting/css-api.js', '/js/scripting/isolated-api.js');
    js.push('/js/scripting/css-specific.js');

    const excludeMatches = [];
    if ( none.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(none));
    }
    if ( basic.has('all-urls') === false ) {
        excludeMatches.push(...ut.matchesFromHostnames(basic));
    }

    const registered = before.get('css-specific');
    before.delete('css-specific'); // Important!

    const directive = {
        id: 'css-specific',
        js,
        matches,
        allFrames: true,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    // register
    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    // update
    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false
    ) {
        context.toRemove.push('css-specific');
        context.toAdd.push(directive);
    }
}

/******************************************************************************/

function registerScriptlet(context, scriptletDetails) {
    const { before, filteringModeDetails, rulesetsDetails } = context;

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
        const scriptletList = scriptletDetails.get(rulesetId);
        if ( scriptletList === undefined ) { continue; }

        for ( const [ token, details ] of scriptletList ) {
            const id = `${rulesetId}.${token}`;
            const registered = before.get(id);

            const matches = [];
            const excludeMatches = [];
            let targetHostnames = [];
            if ( hasBroadHostPermission ) {
                excludeMatches.push(...permissionRevokedMatches);
                if ( details.hostnames.length > 100 ) {
                    targetHostnames = [ '*' ];
                } else {
                    targetHostnames = details.hostnames;
                }
            } else if ( permissionGrantedHostnames.length !== 0 ) {
                if ( details.hostnames.includes('*') ) {
                    targetHostnames = permissionGrantedHostnames;
                } else {
                    targetHostnames = ut.intersectHostnameIters(
                        details.hostnames,
                        permissionGrantedHostnames
                    );
                }
            }
            if ( targetHostnames.length === 0 ) { continue; }
            matches.push(...ut.matchesFromHostnames(targetHostnames));
            normalizeMatches(matches);

            before.delete(id); // Important!

            const directive = {
                id,
                js: [ getScriptletPath(id) ],
                matches,
                allFrames: shouldUseAllFramesForScriptlet(rulesetId, token),
                matchOriginAsFallback: shouldUseOriginFallbackForScriptlet(rulesetId, token),
                runAt: 'document_start',
                world: details.world,
            };
            if ( excludeMatches.length !== 0 ) {
                directive.excludeMatches = excludeMatches;
            }

            // register
            if ( registered === undefined ) {
                context.toAdd.push(directive);
                continue;
            }

            // update
            if (
                ut.strArrayEq(registered.matches, matches) === false ||
                ut.strArrayEq(registered.excludeMatches, excludeMatches) === false ||
                ut.strArrayEq(registered.js, directive.js, false) === false ||
                registered.allFrames !== directive.allFrames ||
                registered.world !== directive.world ||
                Boolean(registered.matchOriginAsFallback) !==
                    Boolean(directive.matchOriginAsFallback)
            ) {
                context.toRemove.push(id);
                context.toAdd.push(directive);
            }
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
        }
        if ( targetHostnames.length === 0 ) { continue; }

        const matches = ut.matchesFromHostnames(targetHostnames);
        if ( matches.length === 0 ) { continue; }
        normalizeMatches(matches);

        before.delete(id); // Important!

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

        if ( registered === undefined ) {
            context.toAdd.push(directive);
            context.remoteScriptletReloadHint.after.push(directive);
            continue;
        }

        if (
            ut.strArrayEq(registered.matches, matches) === false ||
            ut.strArrayEq(registered.excludeMatches, excludeMatches) === false ||
            ut.strArrayEq(registered.js, directive.js, false) === false ||
            registered.allFrames !== directive.allFrames ||
            registered.world !== directive.world ||
            Boolean(registered.matchOriginAsFallback) !==
                Boolean(directive.matchOriginAsFallback)
        ) {
            context.toRemove.push(id);
            context.toAdd.push(directive);
            context.remoteScriptletReloadHint.before.push(registered);
            context.remoteScriptletReloadHint.after.push(directive);
        }
    }
}

/******************************************************************************/

function registerNativeHeuristics(context) {
    const { before, filteringModeDetails, subsystemSuppressionHostnames } = context;

    const js = [
        TALON_PUBLIC_SUFFIX_DATA_PATH,
        '/shared/site-key-resolver.js',
        '/js/scripting/breakage-guard.js',
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

    const registered = before.get('native-heuristics');
    before.delete('native-heuristics'); // Important!

    const directive = {
        id: 'native-heuristics',
        js,
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false ||
        Boolean(registered.matchOriginAsFallback) !==
            Boolean(directive.matchOriginAsFallback)
    ) {
        context.toRemove.push('native-heuristics');
        context.toAdd.push(directive);
    }
}

function registerAutomation(context) {
    const { before, filteringModeDetails, subsystemSuppressionHostnames } = context;

    const js = [
        '/js/scripting/breakage-guard.js',
        TALON_SHADOW_DOM_HELPER_PATH,
        TALON_BLOCK_HINTS_PATH,
        '/js/scripting/automation.js',
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
        subsystemSuppressionHostnames?.automation
    );

    const registered = before.get('automation');
    before.delete('automation'); // Important!

    const directive = {
        id: 'automation',
        js,
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false ||
        Boolean(registered.matchOriginAsFallback) !==
            Boolean(directive.matchOriginAsFallback)
    ) {
        context.toRemove.push('automation');
        context.toAdd.push(directive);
    }
}

/******************************************************************************/

function registerAdShellStyles(context) {
    const { before, filteringModeDetails } = context;

    const js = [ '/js/scripting/ad-shell-styles.js' ];

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

    const registered = before.get('ad-shell-styles');
    before.delete('ad-shell-styles'); // Important!

    const directive = {
        id: 'ad-shell-styles',
        js,
        allFrames: true,
        matches,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false
    ) {
        context.toRemove.push('ad-shell-styles');
        context.toAdd.push(directive);
    }
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
        } else if (
            ut.strArrayEq(registeredGlobal.js, globalDirective.js, false) === false ||
            ut.strArrayEq(registeredGlobal.matches, broadMatches) === false ||
            ut.strArrayEq(registeredGlobal.excludeMatches, excludeMatches) === false ||
            Boolean(registeredGlobal.matchOriginAsFallback) !==
                Boolean(globalDirective.matchOriginAsFallback)
        ) {
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
        } else if (
            ut.strArrayEq(registeredHost.js, hostDirective.js, false) === false ||
            ut.strArrayEq(registeredHost.matches, hostMatches) === false ||
            ut.strArrayEq(registeredHost.excludeMatches, excludeMatches) === false ||
            Boolean(registeredHost.matchOriginAsFallback) !==
                Boolean(hostDirective.matchOriginAsFallback)
        ) {
            context.toRemove.push('remote-cosmetics-host');
            context.toAdd.push(hostDirective);
        }
    } else if ( registeredHost !== undefined ) {
        context.toRemove.push('remote-cosmetics-host');
    }
}

/******************************************************************************/

function registerRemoteTactics(context) {
    const {
        before,
        filteringModeDetails,
        subsystemSuppressionHostnames,
        remoteTactics,
    } = context;

    const registeredBootstrap = before.get('remote-tactics-bootstrap');
    before.delete('remote-tactics-bootstrap'); // Important!
    const registeredMain = before.get('remote-tactics-main');
    before.delete('remote-tactics-main'); // Important!

    context.registeredTacticsHostCount = 0;

    if ( Array.isArray(remoteTactics) === false || remoteTactics.length === 0 ) {
        if ( registeredBootstrap !== undefined ) {
            context.toRemove.push('remote-tactics-bootstrap');
        }
        if ( registeredMain !== undefined ) {
            context.toRemove.push('remote-tactics-main');
        }
        return;
    }

    const { none, basic } = filteringModeDetails;
    const targetHostnames = collectRegisteredRemoteTacticHostnames(
        filteringModeDetails,
        remoteTactics
    );
    const matches = exactMatchesFromHostnames(targetHostnames);
    if ( matches.length === 0 ) {
        if ( registeredBootstrap !== undefined ) {
            context.toRemove.push('remote-tactics-bootstrap');
        }
        if ( registeredMain !== undefined ) {
            context.toRemove.push('remote-tactics-main');
        }
        return;
    }

    context.registeredTacticsHostCount = targetHostnames.length;
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
        subsystemSuppressionHostnames?.remoteTactics
    );

    const bootstrapDirective = {
        id: 'remote-tactics-bootstrap',
        js: ['/js/scripting/remote-tactics-bootstrap.js'],
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_start',
    };
    if ( excludeMatches.length !== 0 ) {
        bootstrapDirective.excludeMatches = excludeMatches;
    }
    if ( registeredBootstrap === undefined ) {
        context.toAdd.push(bootstrapDirective);
    } else if (
        ut.strArrayEq(registeredBootstrap.js, bootstrapDirective.js, false) === false ||
        ut.strArrayEq(registeredBootstrap.matches, matches) === false ||
        ut.strArrayEq(registeredBootstrap.excludeMatches, excludeMatches) === false ||
        Boolean(registeredBootstrap.matchOriginAsFallback) !==
            Boolean(bootstrapDirective.matchOriginAsFallback)
    ) {
        context.toRemove.push('remote-tactics-bootstrap');
        context.toAdd.push(bootstrapDirective);
    }

    const mainDirective = {
        id: 'remote-tactics-main',
        js: ['/js/scripting/remote-tactics.js'],
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_start',
        world: 'MAIN',
    };
    if ( excludeMatches.length !== 0 ) {
        mainDirective.excludeMatches = excludeMatches;
    }
    if ( registeredMain === undefined ) {
        context.toAdd.push(mainDirective);
    } else if (
        ut.strArrayEq(registeredMain.js, mainDirective.js, false) === false ||
        ut.strArrayEq(registeredMain.matches, matches) === false ||
        ut.strArrayEq(registeredMain.excludeMatches, excludeMatches) === false ||
        Boolean(registeredMain.matchOriginAsFallback) !==
            Boolean(mainDirective.matchOriginAsFallback) ||
        registeredMain.world !== 'MAIN'
    ) {
        context.toRemove.push('remote-tactics-main');
        context.toAdd.push(mainDirective);
    }
}

/******************************************************************************/

function registerPostHideCleanup(context) {
    const { before, filteringModeDetails, subsystemSuppressionHostnames } = context;

    const js = [
        '/js/scripting/breakage-guard.js',
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

    const registered = before.get('post-hide-cleanup');
    before.delete('post-hide-cleanup'); // Important!

    const directive = {
        id: 'post-hide-cleanup',
        js,
        allFrames: true,
        matchOriginAsFallback: true,
        matches,
        runAt: 'document_idle',
    };
    if ( excludeMatches.length !== 0 ) {
        directive.excludeMatches = excludeMatches;
    }

    if ( registered === undefined ) {
        context.toAdd.push(directive);
        return;
    }

    if (
        ut.strArrayEq(registered.js, js, false) === false ||
        ut.strArrayEq(registered.matches, matches) === false ||
        ut.strArrayEq(registered.excludeMatches, excludeMatches) === false ||
        Boolean(registered.matchOriginAsFallback) !==
            Boolean(directive.matchOriginAsFallback)
    ) {
        context.toRemove.push('post-hide-cleanup');
        context.toAdd.push(directive);
    }
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
        toRemoveCount: Math.max(0, Number(result.toRemoveCount) || 0),
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
        genericDetails,
        remoteCosmetics,
        remoteScriptlets,
        remoteTactics,
        autoGenericHighHosts,
        subsystemSuppressionHostnames,
        registered,
    ] = await Promise.all([
        getFilteringModeDetails(),
        getEnabledRulesetsDetails(),
        getScriptletDetails(),
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
        readOptionalLocalValue(
            PUBLIC_REMOTE_TACTICS_KEY,
            null,
            `registerInjectables/${PUBLIC_REMOTE_TACTICS_KEY}`
        ),
        readActiveAutoGenericHighHosts(),
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
        remoteTactics: Array.isArray(remoteTactics) ? remoteTactics : null,
        autoGenericHighHosts:
            autoGenericHighHosts instanceof Set
                ? autoGenericHighHosts
                : new Set(),
        subsystemSuppressionHostnames,
        remoteScriptletReloadHint: {
            before: [],
            after: [],
        },
        registeredTacticsHostCount: 0,
    };

    await Promise.all([
        registerProcedural(context),
        registerScriptlet(context, scriptletDetails),
        registerRemoteScriptlets(context, scriptletDetails),
        registerSpecific(context),
        registerNativeHeuristics(context),
        registerAutomation(context),
        registerAdShellStyles(context),
        registerRemoteCosmetics(context),
        registerRemoteTactics(context),
        registerPostHideCleanup(context),
        registerGeneric(context, genericDetails),
        registerHighGeneric(context, genericDetails),
        registerCustomFilters(context),
        registerToolbarIconToggler(context),
    ]);

    for ( const [id, entry] of before ) {
        if ( isRemoteScriptletDirectiveId(id) === false ) { continue; }
        context.remoteScriptletReloadHint.before.push(entry);
    }
    toRemove.push(...Array.from(before.keys()));
    return {
        toAdd,
        toRemove,
        registeredTacticsHostCount: context.registeredTacticsHostCount,
        remoteScriptletReloadHint: normalizeRemoteScriptletReloadHint(
            context.remoteScriptletReloadHint
        ),
    };
};

const registerInjectablesImpl = async () => {
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
            toRemoveCount: 0,
        };
        await writeInjectableSyncDiagnostics(unsupported);
        return unsupported;
    }

    const result = await runInjectableRegistrationFlow({
        buildPlan: buildInjectablesRegistrationPlan,
        listRegistered: () => browser.scripting.getRegisteredContentScripts(),
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
    });
    if ( result.ok === true ) {
        await Promise.all([
            localRemove('$scripting.unregisterContentScripts').catch(() => {}),
            localRemove('$scripting.registerContentScripts').catch(() => {}),
        ]);
    }
    await writeInjectableSyncDiagnostics(result);
    logInjectableSyncResult(result);
    return result;
};

const registerInjectablesRunner = createSingleFlightRunner(registerInjectablesImpl);

async function registerInjectables() {
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
            toRemoveCount: 0,
        };
    }
    return registerInjectablesRunner();
}

/******************************************************************************/

export {
    INJECTABLE_SYNC_DIAGNOSTICS_KEY,
    readInjectableSyncDiagnostics,
    registerInjectables
};
