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
    browser,
    localRemove,
    localWrite,
    runtime,
    isUserScriptsAvailable,
    supportsUserScripts,
} from './ext.js';

import {
    intersectHostnameIters,
    isIgnorableRuntimeError,
    matchesFromHostnames,
    subtractHostnameIters,
} from './utils.js';

import { contentScriptRegistrationsEqual } from './injectable-registration.js';

import { ubolErr } from './debug.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { rulesetConfig } from './config.js';

/******************************************************************************/

const isProcedural = a => a.startsWith('{');
const isScriptlet = a => a.startsWith('+js');
const isCSS = a => isProcedural(a) === false && isScriptlet(a) === false;
const EXTENSION_ORIGIN = new URL(runtime.getURL('/')).origin;
const OFFSCREEN_COMPILER_PATH = '/js/offscreen/compile-filters.html';
const COMPILED_SANDBOX_FILTERS_KEY = 'sandboxFilters.compiledV1';
export const SANDBOX_COMPILED_FINGERPRINT_KEY =
    'sandboxFilters.compiledFingerprintV1';
const COMPILED_SANDBOX_FILTERS_SCHEMA = 1;
export const SANDBOX_DNR_DIRTY_KEY = 'sandboxFilters.dnrDirtyV1';
export const SANDBOX_REGISTRATION_DIRTY_KEY = 'sandboxFilters.registrationDirtyV1';
export const SANDBOX_REGISTRATION_REVISION_KEY =
    'sandboxFilters.registrationRevisionV1';
export const SANDBOX_REGISTRATION_APPLIED_REVISION_KEY =
    'sandboxFilters.registrationAppliedRevisionV1';
export const SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY =
    'sandboxFilters.userScriptLiveReloadPendingV1';
export const MANAGED_USER_SCRIPTS_MAY_EXIST_KEY =
    'sandboxFilters.managedUserScriptsMayExistV1';
const MANAGED_USER_SCRIPT_IDS = new Set([ 'user.isolated', 'user.main' ]);
let sandboxFilterOperationTail = Promise.resolve();
let sandboxFilterRegistrationSuspended = false;
const SANDBOX_USER_SCRIPT_OPERATION_TIMEOUT_MS = 5000;
const unsettledSandboxUserScriptOperations = new Set();

export const waitForTimedOutSandboxFilterOperations = () =>
    Promise.allSettled(Array.from(unsettledSandboxUserScriptOperations));

export const hasTimedOutSandboxFilterOperations = () =>
    unsettledSandboxUserScriptOperations.size !== 0;

const invokeSandboxUserScriptOperation = async (operation, label) => {
    let timer;
    const operationPromise = Promise.resolve().then(operation);
    try {
        return await Promise.race([
            operationPromise,
            new Promise((_, reject) => {
                timer = self.setTimeout(() => {
                    const error = new Error(`${label} timed out`);
                    error.uncertain = true;
                    reject(error);
                }, SANDBOX_USER_SCRIPT_OPERATION_TIMEOUT_MS);
            }),
        ]);
    } catch (reason) {
        if ( reason?.uncertain === true ) {
            unsettledSandboxUserScriptOperations.add(operationPromise);
            operationPromise.then(
                () => unsettledSandboxUserScriptOperations.delete(operationPromise),
                () => unsettledSandboxUserScriptOperations.delete(operationPromise)
            );
        }
        throw reason;
    } finally {
        if ( timer !== undefined ) { self.clearTimeout(timer); }
    }
};

const enqueueSandboxFilterOperation = operation => {
    const result = sandboxFilterOperationTail
        .catch(() => {})
        .then(operation);
    sandboxFilterOperationTail = result.catch(() => {});
    return result;
};

const normalizeRegistrationRevision = value => {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

const markSandboxRegistrationDirtyNow = async () => {
    const before = normalizeRegistrationRevision(
        await readFromStorage(SANDBOX_REGISTRATION_REVISION_KEY)
    );
    const after = before < Number.MAX_SAFE_INTEGER ? before + 1 : 1;
    await Promise.all([
        localWrite(SANDBOX_REGISTRATION_DIRTY_KEY, true),
        localWrite(SANDBOX_REGISTRATION_REVISION_KEY, after),
    ]);
    return after;
};

const ensureSandboxUserScriptLiveReloadPending = async ({
    revision,
    fingerprint,
} = {}) => {
    const current = await readFromStorage(
        SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY
    );
    const normalizedRevision = normalizeRegistrationRevision(revision);
    const normalizedFingerprint = typeof fingerprint === 'string'
        ? fingerprint
        : '';
    if (
        current instanceof Object &&
        Number(current.revision) === normalizedRevision &&
        current.fingerprint === normalizedFingerprint
    ) {
        return current;
    }
    const marker = {
        sequence: Math.max(0, Number(current?.sequence) || 0) + 1,
        revision: normalizedRevision,
        fingerprint: normalizedFingerprint,
        updatedAt: Math.max(
            Date.now(),
            (Number(current?.updatedAt) || 0) + 1
        ),
    };
    await localWrite(SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY, marker);
    return marker;
};

const sameSandboxUserScriptLiveReloadMarker = (left, right) =>
    left instanceof Object &&
    right instanceof Object &&
    Number(left.sequence) === Number(right.sequence) &&
    Number(left.revision) === Number(right.revision) &&
    left.fingerprint === right.fingerprint;

export const acknowledgeSandboxUserScriptLiveReload = marker =>
    enqueueSandboxFilterOperation(async () => {
        const current = await readFromStorage(
            SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY
        );
        if ( sameSandboxUserScriptLiveReloadMarker(current, marker) === false ) {
            return false;
        }
        await localRemove(SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY);
        return true;
    });

export const markSandboxRegistrationDirty = () =>
    enqueueSandboxFilterOperation(markSandboxRegistrationDirtyNow);

const isOffscreenCompilerSender = sender => {
    const senderId = typeof sender?.id === 'string' ? sender.id : '';
    if ( senderId !== '' && senderId !== runtime.id ) { return false; }
    const senderURL = typeof sender?.url === 'string' ? sender.url : '';
    if ( senderURL === '' ) { return false; }
    try {
        const parsedURL = new URL(senderURL);
        return parsedURL.origin === EXTENSION_ORIGIN &&
            parsedURL.pathname === OFFSCREEN_COMPILER_PATH;
    } catch {
    }
    return false;
};

/******************************************************************************/

async function keysFromStorage() {
    if ( browser.storage?.local?.getKeys ) {
        const keys = await browser.storage.local.getKeys();
        if ( Array.isArray(keys) === false ) {
            throw new Error('invalid local storage key response');
        }
        return keys;
    }
    if ( browser.storage?.local?.get === undefined ) {
        throw new Error('local storage API unavailable');
    }
    const bin = await browser.storage.local.get(null);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error('invalid local storage response');
    }
    return Object.keys(bin);
}

async function readFromStorage(key) {
    if ( browser.storage?.local?.get === undefined ) {
        throw new Error('local storage API unavailable');
    }
    const bin = await browser.storage.local.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid local storage response for ${key}`);
    }
    return bin[key];
}

const normalizeStoredCustomSelectors = (value, key = '') => {
    if ( value === undefined ) { return []; }
    if ( Array.isArray(value) === false ) {
        ubolErr(`custom filters ignored malformed value for ${key || 'unknown key'}`);
        return [];
    }
    const selectors = value.filter(entry => typeof entry === 'string');
    if ( selectors.length !== value.length ) {
        ubolErr(`custom filters ignored malformed entries for ${key || 'unknown key'}`);
    }
    return selectors;
};

/******************************************************************************/

export async function customFiltersFromHostname(hostname) {
    const promises = [];
    let hn = typeof hostname === 'string'
        ? hostname.trim().toLowerCase()
        : '';
    if ( hn === '' ) { return []; }
    while ( hn !== '' ) {
        promises.push(readFromStorage(`site.${hn}`));
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
    }
    const results = await Promise.all(promises);
    const out = [];
    for ( let i = 0; i < promises.length; i++ ) {
        const selectors = normalizeStoredCustomSelectors(results[i]);
        selectors.forEach(selector => {
            out.push(selector.startsWith('0') ? selector.slice(1) : selector);
        });
    }
    return out.sort();
}

/******************************************************************************/

export async function hasCustomFilters(hostname) {
    const selectors = await customFiltersFromHostname(hostname);
    return selectors?.length ?? 0;
}

export async function prepareCustomFilterDetails(hostname) {
    const selectors = await customFiltersFromHostname(hostname);
    return {
        plainSelectors: selectors.filter(a => isCSS(a)),
        proceduralSelectors: selectors.filter(a => isProcedural(a)),
    };
}

/******************************************************************************/

async function getAllCustomFilterKeys() {
    const storageKeys = await keysFromStorage() || [];
    return storageKeys.filter(a => a.startsWith('site.'));
}

/******************************************************************************/

export async function getAllCustomFilters() {
    const collect = async key => {
        const selectors = normalizeStoredCustomSelectors(
            await readFromStorage(key),
            key
        );
        return [ key.slice(5), selectors.map(a => a.startsWith('0') ? a.slice(1) : a) ];
    };
    const keys = await getAllCustomFilterKeys();
    const promises = keys.map(k => collect(k));
    return Promise.all(promises);
}

/******************************************************************************/

const contentScriptTarget = (tabId, frameId, documentId) =>
    typeof documentId === 'string' && documentId !== ''
        ? { tabId, documentIds: [ documentId ] }
        : { tabId, frameIds: [ frameId ] };

export function startCustomFilters(
    tabId,
    frameId,
    documentId,
    executeScript = details => browser.scripting.executeScript(details)
) {
    return executeScript({
        files: [
            '/js/scripting/css-api.js',
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/css-user.js',
        ],
        target: contentScriptTarget(tabId, frameId, documentId),
        injectImmediately: true,
    }).catch(reason => {
        if ( isIgnorableRuntimeError(reason) ) { return false; }
        throw reason;
    })
}

export function terminateCustomFilters(
    tabId,
    frameId,
    documentId,
    executeScript = details => browser.scripting.executeScript(details)
) {
    return executeScript({
        files: [ '/js/scripting/css-user-terminate.js' ],
        target: contentScriptTarget(tabId, frameId, documentId),
        injectImmediately: true,
    }).catch(reason => {
        if ( isIgnorableRuntimeError(reason) ) { return false; }
        throw reason;
    })
}

/******************************************************************************/

export async function injectCustomFilters(
    tabId,
    frameId,
    hostname,
    preparedDetails,
    documentId,
    executeScript = scriptDetails =>
        browser.scripting.executeScript(scriptDetails)
) {
    const details = preparedDetails instanceof Object
        ? {
            plainSelectors: Array.isArray(preparedDetails.plainSelectors)
                ? preparedDetails.plainSelectors.filter(a => typeof a === 'string')
                : [],
            proceduralSelectors: Array.isArray(preparedDetails.proceduralSelectors)
                ? preparedDetails.proceduralSelectors.filter(a => typeof a === 'string')
                : [],
        }
        : await prepareCustomFilterDetails(hostname);
    const { plainSelectors, proceduralSelectors } = details;
    if ( plainSelectors.length === 0 && proceduralSelectors.length === 0 ) {
        return details;
    }
    const promises = [];
    if ( proceduralSelectors.length !== 0 ) {
        promises.push(
            executeScript({
                files: [
                    '/js/scripting/css-api.js',
                    '/js/scripting/css-procedural-api.js',
                ],
                target: contentScriptTarget(tabId, frameId, documentId),
                injectImmediately: true,
            }).catch(reason => {
                if ( isIgnorableRuntimeError(reason) ) { return false; }
                throw reason;
            })
        );
    }
    const results = await Promise.all(promises);
    if ( results.includes(false) ) { return false; }
    return details;
}

/******************************************************************************/

export async function registerCustomFilters(context) {
    const customFilters = new Map(await getAllCustomFilters());
    if ( customFilters.size === 0 ) { return; }

    const { none } = context.filteringModeDetails;
    let hostnames = Array.from(customFilters.keys());
    let excludeHostnames = [];
    if ( none.has('all-urls') ) {
        const { basic, optimal, complete } = context.filteringModeDetails;
        hostnames = intersectHostnameIters(hostnames, [
            ...basic, ...optimal, ...complete
        ]);
    } else if ( none.size !== 0 ) {
        hostnames = [ ...subtractHostnameIters(hostnames, none) ];
        excludeHostnames = Array.from(none);
    }
    hostnames = hostnames.filter(a =>
        customFilters.get(a).some(a => isCSS(a) || isProcedural(a))
    );
    if ( hostnames.length === 0 ) { return; }

    const registered = context.before.get('css-user');
    context.before.delete('css-user'); // Important!

    const directive = {
        id: 'css-user',
        js: [
            '/js/scripting/css-api.js',
            '/js/scripting/css-procedural-api.js',
            '/js/scripting/css-user.js',
        ],
        matches: matchesFromHostnames(hostnames),
        allFrames: true,
        matchOriginAsFallback: true,
        runAt: 'document_start',
    };
    if ( excludeHostnames.length !== 0 ) {
        directive.excludeMatches = matchesFromHostnames(excludeHostnames);
    }

    if ( registered === undefined ) {
        context.toAdd.push(directive);
    } else if ( contentScriptRegistrationsEqual(registered, directive) === false ) {
        context.toRemove.push('css-user');
        context.toAdd.push(directive);
    }
}

/******************************************************************************/

async function addCustomFiltersNow(hostname, toAdd) {
    if ( hostname === '' ) { return false; }
    const key = `site.${hostname}`;
    const selectors = normalizeStoredCustomSelectors(
        await readFromStorage(key),
        key
    );
    const countBefore = selectors.length;
    for ( const selector of toAdd ) {
        if ( selectors.includes(selector) ) { continue; }
        selectors.push(selector);
    }
    if ( selectors.length === countBefore ) { return false; }
    selectors.sort();
    await markSandboxRegistrationDirtyNow();
    await localWrite(key, selectors);
    return true;
}

/******************************************************************************/

async function removeAllCustomFiltersNow(hostname) {
    if ( hostname === '*' ) {
        const keys = await getAllCustomFilterKeys();
        if ( keys.length === 0 ) { return false; }
        await markSandboxRegistrationDirtyNow();
        await Promise.all(keys.map(key => localRemove(key)));
        return true;
    }
    const key = `site.${hostname}`;
    const stored = await readFromStorage(key);
    if ( stored === undefined ) { return false; }
    normalizeStoredCustomSelectors(stored, key);
    await markSandboxRegistrationDirtyNow();
    await localRemove(key);
    return true;
}

async function removeCustomFiltersNow(hostname, selectors) {
    const keys = [];
    let hn = typeof hostname === 'string'
        ? hostname.trim().toLowerCase()
        : '';
    if ( hn === '' ) { return false; }
    while ( hn !== '' ) {
        keys.push(`site.${hn}`);
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
    }
    const results = [];
    for ( const key of keys ) {
        results.push(await removeCustomFiltersByKey(key, selectors));
    }
    return results.some(a => a);
}

async function removeCustomFiltersByKey(key, toRemove) {
    const stored = await readFromStorage(key);
    if ( stored === undefined ) { return false; }
    const selectors = normalizeStoredCustomSelectors(stored, key);
    if ( Array.isArray(stored) === false ) { return false; }
    const beforeCount = selectors.length;
    for ( const selector of toRemove ) {
        let i = selectors.indexOf(selector);
        if ( i === -1 ) {
            i = selectors.indexOf(`0${selector}`);
            if ( i === -1 ) { continue; }
        }
        selectors.splice(i, 1);
    }
    const afterCount = selectors.length;
    if ( afterCount === beforeCount ) { return false; }
    await markSandboxRegistrationDirtyNow();
    if ( afterCount !== 0 ) {
        await localWrite(key, selectors);
    } else {
        await localRemove(key);
    }
    return true;
}

/******************************************************************************/

export function getSandboxFilters() {
    return readFromStorage('sandboxFilters');
}

async function setSandboxFiltersNow(text = '') {
    text = typeof text === 'string' ? text.trim() : '';
    await markSandboxRegistrationDirtyNow();
    return text !== ''
        ? localWrite('sandboxFilters', text)
        : localRemove('sandboxFilters');
}

export function addCustomFilters(hostname, toAdd) {
    return enqueueSandboxFilterOperation(
        () => addCustomFiltersNow(hostname, toAdd)
    );
}

export function removeAllCustomFilters(hostname) {
    return enqueueSandboxFilterOperation(
        () => removeAllCustomFiltersNow(hostname)
    );
}

export function removeCustomFilters(hostname, selectors) {
    return enqueueSandboxFilterOperation(
        () => removeCustomFiltersNow(hostname, selectors)
    );
}

export function setSandboxFilters(text = '') {
    return enqueueSandboxFilterOperation(
        () => setSandboxFiltersNow(text)
    );
}

/******************************************************************************/

const stableValue = value => {
    if ( Array.isArray(value) ) { return value.map(stableValue); }
    if ( value instanceof Object ) {
        const out = {};
        for ( const key of Object.keys(value).sort() ) {
            out[key] = stableValue(value[key]);
        }
        return out;
    }
    return value;
};

const canonicalUserScript = entry => stableValue({
    id: entry?.id,
    world: entry?.world,
    allFrames: Boolean(entry?.allFrames),
    js: Array.isArray(entry?.js) ? entry.js : [],
    runAt: entry?.runAt,
    matches: Array.isArray(entry?.matches) ? entry.matches.slice().sort() : [],
    excludeMatches: Array.isArray(entry?.excludeMatches)
        ? entry.excludeMatches.slice().sort()
        : [],
});

const sameUserScript = (left, right) =>
    JSON.stringify(canonicalUserScript(left)) ===
    JSON.stringify(canonicalUserScript(right));

const getManagedUserScripts = async () => {
    const scripts = await invokeSandboxUserScriptOperation(
        () => browser.userScripts.getScripts(),
        'list managed user scripts'
    );
    if ( Array.isArray(scripts) === false ) {
        throw new Error('invalid registered user-script response');
    }
    return scripts.filter(entry => MANAGED_USER_SCRIPT_IDS.has(entry?.id));
};

const reconcileManagedUserScripts = async (
    desired,
    {
        revision = 0,
        fingerprint = '',
        forceClearPending = false,
    } = {}
) => {
    if ( unsettledSandboxUserScriptOperations.size !== 0 ) {
        throw new Error('a timed-out user-script operation is still unsettled');
    }
    const before = await getManagedUserScripts();
    if ( desired.length !== 0 ) {
        // Persist conservative evidence before registration. Paywall cleanup
        // must not assume the retained Chrome registrations are absent merely
        // because the Allow User Scripts toggle currently hides the API.
        await localWrite(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY, true);
    }
    if ( desired.length === 0 && forceClearPending ) {
        await ensureSandboxUserScriptLiveReloadPending({
            revision,
            fingerprint,
        });
        // No-argument unregister clears Chrome's loaded and pending dynamic
        // IDs; getScripts() exposes only loaded scripts and is insufficient.
        await invokeSandboxUserScriptOperation(
            () => browser.userScripts.unregister(),
            'clear loaded and pending managed user scripts'
        );
        const remaining = await getManagedUserScripts();
        if ( remaining.length !== 0 ) {
            throw new Error('managed user scripts remained after full cleanup');
        }
        await localRemove(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY);
        return true;
    }
    const beforeById = new Map(before.map(entry => [ entry.id, entry ]));
    const desiredById = new Map(desired.map(entry => [ entry.id, entry ]));
    const toAdd = [];
    const toUpdate = [];
    const toRemove = [];
    for ( const entry of desired ) {
        const existing = beforeById.get(entry.id);
        if ( existing === undefined ) {
            toAdd.push(entry);
        } else if ( sameUserScript(existing, entry) === false ) {
            toUpdate.push(entry);
        }
    }
    for ( const entry of before ) {
        if ( desiredById.has(entry.id) ) { continue; }
        toRemove.push(entry.id);
    }
    if ( toAdd.length === 0 && toUpdate.length === 0 && toRemove.length === 0 ) {
        if ( desired.length === 0 ) {
            await localRemove(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY);
        }
        return false;
    }
    await ensureSandboxUserScriptLiveReloadPending({
        revision,
        fingerprint,
    });
    try {
        if ( toAdd.length !== 0 ) {
            await invokeSandboxUserScriptOperation(
                () => browser.userScripts.register(toAdd),
                'register managed user scripts'
            );
        }
        if ( toUpdate.length !== 0 ) {
            if ( typeof browser.userScripts.update === 'function' ) {
                await invokeSandboxUserScriptOperation(
                    () => browser.userScripts.update(toUpdate),
                    'update managed user scripts'
                );
            } else {
                await invokeSandboxUserScriptOperation(
                    () => browser.userScripts.unregister({
                        ids: toUpdate.map(entry => entry.id),
                    }),
                    'unregister managed user scripts for update'
                );
                await invokeSandboxUserScriptOperation(
                    () => browser.userScripts.register(toUpdate),
                    're-register managed user scripts for update'
                );
            }
        }
        if ( toRemove.length !== 0 ) {
            await invokeSandboxUserScriptOperation(
                () => browser.userScripts.unregister({ ids: toRemove }),
                'unregister managed user scripts'
            );
        }
        if ( desired.length === 0 ) {
            await localRemove(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY);
        }
        return true;
    } catch (reason) {
        if ( reason?.uncertain === true ) { throw reason; }
        // Restore only Talon-managed custom-filter scripts. Never wipe scripts
        // owned by another extension subsystem during recovery.
        const current = await getManagedUserScripts().catch(() => []) || [];
        const currentIds = current.map(entry => entry.id);
        if ( currentIds.length !== 0 ) {
            await invokeSandboxUserScriptOperation(
                () => browser.userScripts.unregister({ ids: currentIds }),
                'recover managed user scripts cleanup'
            ).catch(() => {});
        }
        if ( before.length !== 0 ) {
            await invokeSandboxUserScriptOperation(
                () => browser.userScripts.register(before),
                'recover managed user scripts restore'
            ).catch(() => {});
        }
        throw reason;
    }
};

const fingerprintFilterText = async text => {
    const input = `${COMPILED_SANDBOX_FILTERS_SCHEMA}\n${text}`;
    try {
        const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(input)
        );
        return Array.from(new Uint8Array(digest), byte =>
            byte.toString(16).padStart(2, '0')
        ).join('');
    } catch {
    }
    let hash = 2166136261;
    for ( let i = 0; i < input.length; i++ ) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `fallback-${(hash >>> 0).toString(16)}`;
};

export const fingerprintManagedUserScriptRegistrations = async scripts => {
    const managed = (Array.isArray(scripts) ? scripts : [])
        .filter(entry => MANAGED_USER_SCRIPT_IDS.has(entry?.id))
        .map(canonicalUserScript)
        .sort((a, b) => `${a.id || ''}`.localeCompare(`${b.id || ''}`));
    return managed.length === 0
        ? ''
        : fingerprintFilterText(JSON.stringify(managed));
};

const normalizeCompiledFilters = value => {
    if ( value instanceof Object === false ) { return null; }
    const normalizeCode = entries => Array.isArray(entries)
        ? entries.filter(entry => typeof entry === 'string' && entry !== '')
        : [];
    return {
        ISOLATED: normalizeCode(value.ISOLATED),
        MAIN: normalizeCode(value.MAIN),
        dnrRules: Array.isArray(value.dnrRules) ? value.dnrRules : [],
    };
};

async function registerSandboxFiltersNow() {
    const storedRevision = await readFromStorage(
        SANDBOX_REGISTRATION_REVISION_KEY
    );
    let revision = normalizeRegistrationRevision(storedRevision);
    if ( sandboxFilterRegistrationSuspended ) {
        return {
            changed: false,
            revision,
            customFilterCount: 0,
            suspended: true,
        };
    }
    if ( storedRevision === undefined ) {
        await localWrite(SANDBOX_REGISTRATION_REVISION_KEY, revision);
    } else if (
        (
            typeof storedRevision !== 'number' ||
            Number.isSafeInteger(storedRevision) === false ||
            storedRevision < 0
        )
    ) {
        revision = 1;
        await Promise.all([
            localWrite(SANDBOX_REGISTRATION_DIRTY_KEY, true),
            localWrite(SANDBOX_REGISTRATION_REVISION_KEY, revision),
        ]);
    }
    const userScriptsAvailable = supportsUserScripts === true &&
        isUserScriptsAvailable();
    const { none, basic, optimal, complete } = await getFilteringModeDetails();
    const notNone = [ ...basic, ...optimal, ...complete ];
    const customFilters = await getAllCustomFilters();
    const lines = [];
    for ( const [ hostname, selectors ] of customFilters ) {
        for ( const selector of selectors ) {
            if ( isScriptlet(selector) === false ) { continue; }
            lines.push(`${hostname}##${selector}`);
        }
    }
    if ( rulesetConfig.developerMode ) {
        const sandboxFilters = await getSandboxFilters();
        if ( sandboxFilters ) {
            lines.push(sandboxFilters);
        }
    }
    const text = lines.join('\n').trim();
    const fingerprint = await fingerprintFilterText(text);
    const [ cached, cachedFingerprintState, managedScriptsMayExist ] =
        await Promise.all([
        readFromStorage(COMPILED_SANDBOX_FILTERS_KEY),
        readFromStorage(SANDBOX_COMPILED_FINGERPRINT_KEY),
        readFromStorage(MANAGED_USER_SCRIPTS_MAY_EXIST_KEY),
    ]);
    const previousCompiledResult = cached?.schema ===
        COMPILED_SANDBOX_FILTERS_SCHEMA
        ? normalizeCompiledFilters(cached.result)
        : null;
    let result = cached?.schema === COMPILED_SANDBOX_FILTERS_SCHEMA &&
        cached?.fingerprint === fingerprint
        ? normalizeCompiledFilters(cached.result)
        : null;
    if ( result === null ) {
        if ( text === '' ) {
            result = { ISOLATED: [], MAIN: [], dnrRules: [] };
        } else {
            result = normalizeCompiledFilters(await parseRawFilters(text));
            if ( result === null ) {
                throw new Error('custom filter compilation returned no valid result');
            }
        }
    }
    const toAdd = [];
    const hostnames = none.has('all-urls')
        ? [ ...notNone ]
        : [];
    const excludeHostnames = none.has('all-urls') === false
        ? [ ...none ]
        : [];
    const matches = none.has('all-urls')
        ? (hostnames.length !== 0 ? matchesFromHostnames(hostnames) : [])
        : [ '<all_urls>' ];
    const excludeMatches = excludeHostnames.length !== 0
        ? matchesFromHostnames(excludeHostnames)
        : [];
    if ( matches.length !== 0 && result.ISOLATED.length ) {
        const directive = {
            id: 'user.isolated',
            world: 'USER_SCRIPT',
            allFrames: true,
            js: [ { code: result.ISOLATED.join('\n\n') } ],
            runAt: 'document_start',
            matches: matches.slice(),
        };
        if ( excludeMatches.length !== 0 ) {
            directive.excludeMatches = excludeMatches.slice();
        }
        toAdd.push(directive);
    }
    if ( matches.length !== 0 && result.MAIN.length ) {
        const directive = {
            id: 'user.main',
            world: 'MAIN',
            allFrames: true,
            js: [ { code: result.MAIN.join('\n\n') } ],
            runAt: 'document_start',
            matches: matches.slice(),
        };
        if ( excludeMatches.length !== 0 ) {
            directive.excludeMatches = excludeMatches.slice();
        }
        toAdd.push(directive);
    }
    const userScriptRegistrationFingerprint = toAdd.length === 0
        ? ''
        : await fingerprintFilterText(JSON.stringify(
            toAdd.map(canonicalUserScript)
        ));
    const previousUserScriptRegistrationFingerprint =
        typeof cachedFingerprintState?.userScriptRegistrationFingerprint ===
            'string'
            ? cachedFingerprintState.userScriptRegistrationFingerprint
            : (
                cachedFingerprintState?.isolated === true ||
                cachedFingerprintState?.main === true ||
                (previousCompiledResult?.ISOLATED.length || 0) !== 0 ||
                (previousCompiledResult?.MAIN.length || 0) !== 0
                    ? 'legacy-user-script-intent'
                    : ''
            );
    const compiledUserScriptIntentChanged =
        previousUserScriptRegistrationFingerprint !==
        userScriptRegistrationFingerprint;
    const userScriptsAvailabilityChanged =
        typeof cachedFingerprintState?.userScriptsAvailable === 'boolean' &&
        cachedFingerprintState.userScriptsAvailable !== userScriptsAvailable;
    const hasModernManagedRegistrationEvidence =
        typeof cachedFingerprintState?.userScriptRegistrationFingerprint ===
            'string' ||
        Array.isArray(cachedFingerprintState?.managedUserScriptIds);
    const managedRegistrationMayExist =
        (managedScriptsMayExist !== undefined && managedScriptsMayExist !== false) ||
        (
            typeof cachedFingerprintState?.userScriptRegistrationFingerprint ===
                'string' &&
            cachedFingerprintState.userScriptRegistrationFingerprint !== ''
        ) ||
        (
            Array.isArray(cachedFingerprintState?.managedUserScriptIds) &&
            cachedFingerprintState.managedUserScriptIds.length !== 0
        ) ||
        (
            hasModernManagedRegistrationEvidence === false && (
                cachedFingerprintState?.isolated === true ||
                cachedFingerprintState?.main === true ||
                (previousCompiledResult?.ISOLATED.length || 0) !== 0 ||
                (previousCompiledResult?.MAIN.length || 0) !== 0
            )
        );
    const userScriptLiveStateMayExist =
        toAdd.length !== 0 || managedRegistrationMayExist;
    const userScriptsPending = supportsUserScripts === true &&
        userScriptsAvailable === false &&
        userScriptLiveStateMayExist;
    const userScriptsAvailabilityAffectsLiveDocuments =
        userScriptsAvailabilityChanged && userScriptLiveStateMayExist;
    if (
        compiledUserScriptIntentChanged ||
        userScriptsAvailabilityAffectsLiveDocuments
    ) {
        await ensureSandboxUserScriptLiveReloadPending({
            revision,
            fingerprint: userScriptRegistrationFingerprint,
        });
    }
    const userScriptsChanged = userScriptsAvailable
        ? await reconcileManagedUserScripts(toAdd, {
            revision,
            fingerprint: userScriptRegistrationFingerprint,
            forceClearPending: managedRegistrationMayExist,
        })
        : false;
    const [ beforeRules, dnrStateDirty ] = await Promise.all([
        readFromStorage('sandboxFilters.dnrRules'),
        readFromStorage(SANDBOX_DNR_DIRTY_KEY),
    ]);
    const afterRules =
        rulesetConfig.developerMode &&
        none.has('all-urls') === false &&
        result.dnrRules.length
        ? result.dnrRules
        : undefined;
    const modified = JSON.stringify(afterRules) !== JSON.stringify(beforeRules);
    if ( modified ) {
        // Persist intent first. If the desired-rule write or the subsequent
        // DNR apply fails, a later sync must retry instead of treating storage
        // equality as proof that Chrome has the rules installed.
        await localWrite(SANDBOX_DNR_DIRTY_KEY, true);
        if ( Array.isArray(afterRules) ) {
            await localWrite('sandboxFilters.dnrRules', afterRules);
        } else {
            await localRemove('sandboxFilters.dnrRules');
        }
    }
    if (
        cached?.schema !== COMPILED_SANDBOX_FILTERS_SCHEMA ||
        cached?.fingerprint !== fingerprint
    ) {
        await localWrite(COMPILED_SANDBOX_FILTERS_KEY, {
            schema: COMPILED_SANDBOX_FILTERS_SCHEMA,
            fingerprint,
            result,
        });
    }
    const fingerprintState = {
        schema: COMPILED_SANDBOX_FILTERS_SCHEMA,
        fingerprint,
        isolated: result.ISOLATED.length !== 0,
        main: result.MAIN.length !== 0,
        dnrRuleCount: result.dnrRules.length,
        userScriptsAvailable,
        userScriptRegistrationFingerprint,
        managedUserScriptIds: toAdd.map(entry => entry.id).sort(),
    };
    if ( JSON.stringify(cachedFingerprintState) !== JSON.stringify(fingerprintState) ) {
        await localWrite(SANDBOX_COMPILED_FINGERPRINT_KEY, fingerprintState);
    }
    const userScriptLiveReloadPending = await readFromStorage(
        SANDBOX_USER_SCRIPT_LIVE_RELOAD_PENDING_KEY
    );
    return {
        changed: modified || (
            dnrStateDirty !== undefined && dnrStateDirty !== false
        ),
        revision,
        customFilterCount: customFilters.length,
        userScriptsAvailable,
        userScriptsChanged,
        compiledUserScriptIntentChanged,
        userScriptsPending,
        userScriptsAvailabilityChanged,
        userScriptsAvailabilityAffectsLiveDocuments,
        userScriptLiveReloadPending:
            userScriptLiveReloadPending instanceof Object
                ? userScriptLiveReloadPending
                : null,
    };
}

export function registerSandboxFilters() {
    return enqueueSandboxFilterOperation(registerSandboxFiltersNow)
        .then(result => result.changed === true);
}

export function reconcileSandboxFilters() {
    return enqueueSandboxFilterOperation(registerSandboxFiltersNow);
}

export function setSandboxFilterRegistrationSuspended(value) {
    sandboxFilterRegistrationSuspended = value === true;
}

export function waitForSandboxFilterOperations() {
    return sandboxFilterOperationTail.then(() => undefined, () => undefined);
}

/******************************************************************************/

const OFFSCREEN_CLOSE_TIMEOUT_MS = 5000;

async function awaitBoundedOffscreenOperation(operation, label) {
    const operationPromise = Promise.resolve(operation);
    // Consume a late rejection even when the timeout wins the race.
    operationPromise.catch(() => {});
    let timer;
    try {
        return await Promise.race([
            operationPromise,
            new Promise((_, reject) => {
                timer = self.setTimeout(() => {
                    reject(new Error(`${label} timed out`));
                }, OFFSCREEN_CLOSE_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if ( timer !== undefined ) { self.clearTimeout(timer); }
    }
}

async function parseRawFilters(text) {
    if ( Boolean(text) === false ) { return; }
    const requestId = crypto.randomUUID?.() ||
        `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let offscreenResolve;
    const offscreenPromise = new Promise(resolve => {
        offscreenResolve = resolve;
    });
    const handler = (request, sender, callback) => {
        if ( typeof request !== 'object' ) { return; }
        if ( isOffscreenCompilerSender(sender) === false ) { return; }
        if ( request?.requestId !== requestId ) { return; }
        switch ( request?.what ) {
        case 'getRawFilters':
            callback(text);
            break;
        case 'compiledRawFilters':
            offscreenResolve(request);
            break;
        default:
            break;
        }
    };
    runtime.onMessage.addListener(handler);
    let timeoutId;
    let createPromise;
    let cleanupRequested = false;
    let createCompleted = false;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = self.setTimeout(() => {
            reject(new Error('custom filter compilation timed out'));
        }, 60000);
    });
    try {
        // Recover a compiler document orphaned by a terminated worker before
        // attempting to create the extension's single allowed offscreen page.
        await awaitBoundedOffscreenOperation(
            browser.offscreen.closeDocument().catch(() => {}),
            'initial offscreen compiler cleanup'
        );
        createPromise = browser.offscreen.createDocument({
            url: `${OFFSCREEN_COMPILER_PATH}?requestId=${encodeURIComponent(requestId)}`,
            reasons: [ 'WORKERS' ],
            justification: 'Compile user custom filters from the service worker without dynamic module import',
        });
        // If creation outlives the compilation timeout, the immediate close in
        // `finally` can run before the document exists. Attach a late cleanup
        // so a subsequently created compiler cannot be orphaned.
        createPromise.then(() => {
            if ( cleanupRequested === false ) { return; }
            return awaitBoundedOffscreenOperation(
                browser.offscreen.closeDocument(),
                'late offscreen compiler cleanup'
            ).catch(() => {});
        }, () => {});
        await Promise.race([ createPromise, timeoutPromise ]);
        createCompleted = true;
        return await Promise.race([ offscreenPromise, timeoutPromise ]);
    } finally {
        cleanupRequested = true;
        if ( timeoutId !== undefined ) { self.clearTimeout(timeoutId); }
        runtime.onMessage.removeListener(handler);
        const closeOperation = browser.offscreen.closeDocument();
        await awaitBoundedOffscreenOperation(
            createCompleted ? closeOperation : closeOperation.catch(() => {}),
            'final offscreen compiler cleanup'
        );
    }
}
