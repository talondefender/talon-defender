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
    localKeys,
    localRead,
    localRemove,
    localWrite,
    runtime,
    supportsUserScripts,
} from './ext.js';

import {
    intersectHostnameIters,
    isIgnorableRuntimeError,
    matchesFromHostnames,
    strArrayEq,
    subtractHostnameIters,
} from './utils.js';

import { ubolErr } from './debug.js';
import { getFilteringModeDetails } from './mode-manager.js';
import { rulesetConfig } from './config.js';

/******************************************************************************/

const isProcedural = a => a.startsWith('{');
const isScriptlet = a => a.startsWith('+js');
const isCSS = a => isProcedural(a) === false && isScriptlet(a) === false;
const EXTENSION_ORIGIN = new URL(runtime.getURL('/')).origin;
const OFFSCREEN_COMPILER_PATH = '/js/offscreen/compile-filters.html';

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

async function flushWrites() {
    while ( pendingWrites.length !== 0 ) {
        const promises = pendingWrites;
        pendingWrites.length = 0;
        await Promise.all(promises);
    }
}

async function keysFromStorage() {
    await flushWrites();
    return localKeys();
}

async function readFromStorage(key) {
    await flushWrites();
    return localRead(key);
}

async function writeToStorage(key, value) {
    pendingWrites.push(localWrite(key, value));
}

async function removeFromStorage(key) {
    pendingWrites.push(localRemove(key));
}

const pendingWrites = [];

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
        const selectors = results[i];
        if ( Array.isArray(selectors) === false ) { continue; }
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

/******************************************************************************/

async function getAllCustomFilterKeys() {
    const storageKeys = await keysFromStorage() || [];
    return storageKeys.filter(a => a.startsWith('site.'));
}

/******************************************************************************/

export async function getAllCustomFilters() {
    const collect = async key => {
        const selectors = await readFromStorage(key) || [];
        return [ key.slice(5), selectors.map(a => a.startsWith('0') ? a.slice(1) : a) ];
    };
    const keys = await getAllCustomFilterKeys();
    const promises = keys.map(k => collect(k));
    return Promise.all(promises);
}

/******************************************************************************/

export function startCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        if ( isIgnorableRuntimeError(reason) ) { return; }
        ubolErr(`startCustomFilters/${reason}`);
    })
}

export function terminateCustomFilters(tabId, frameId) {
    return browser.scripting.executeScript({
        files: [ '/js/scripting/css-user-terminate.js' ],
        target: { tabId, frameIds: [ frameId ] },
        injectImmediately: true,
    }).catch(reason => {
        if ( isIgnorableRuntimeError(reason) ) { return; }
        ubolErr(`terminateCustomFilters/${reason}`);
    })
}

/******************************************************************************/

export async function injectCustomFilters(tabId, frameId, hostname) {
    const selectors = await customFiltersFromHostname(hostname);
    if ( selectors.length === 0 ) { return; }
    const promises = [];
    const plainSelectors = selectors.filter(a => isCSS(a));
    if ( plainSelectors.length !== 0 ) {
        promises.push(
            browser.scripting.insertCSS({
                css: `${plainSelectors.join(',\n')}{display:none!important;}`,
                origin: 'USER',
                target: { tabId, frameIds: [ frameId ] },
            }).catch(reason => {
                if ( isIgnorableRuntimeError(reason) ) { return; }
                ubolErr(`injectCustomFilters/insertCSS/${reason}`);
            })
        );
    }
    const proceduralSelectors = selectors.filter(a => isProcedural(a));
    if ( proceduralSelectors.length !== 0 ) {
        promises.push(
            browser.scripting.executeScript({
                files: [
                    '/js/scripting/css-api.js',
                    '/js/scripting/css-procedural-api.js',
                ],
                target: { tabId, frameIds: [ frameId ] },
                injectImmediately: true,
            }).catch(reason => {
                if ( isIgnorableRuntimeError(reason) ) { return; }
                ubolErr(`injectCustomFilters/executeScript/${reason}`);
            })
        );
    }
    await Promise.all(promises);
    return { plainSelectors, proceduralSelectors };
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
        js: [ '/js/scripting/css-user.js' ],
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
    } else if (
        strArrayEq(registered.matches, directive.matches) === false ||
        strArrayEq(registered.excludeMatches, directive.excludeMatches) === false ||
        Boolean(registered.matchOriginAsFallback) !== Boolean(directive.matchOriginAsFallback)
    ) {
        context.toRemove.push('css-user');
        context.toAdd.push(directive);
    }
}

/******************************************************************************/

export async function addCustomFilters(hostname, toAdd) {
    if ( hostname === '' ) { return false; }
    const key = `site.${hostname}`;
    const selectors = await readFromStorage(key) || [];
    const countBefore = selectors.length;
    for ( const selector of toAdd ) {
        if ( selectors.includes(selector) ) { continue; }
        selectors.push(selector);
    }
    if ( selectors.length === countBefore ) { return false; }
    selectors.sort();
    writeToStorage(key, selectors);
    return true;
}

/******************************************************************************/

export async function removeAllCustomFilters(hostname) {
    if ( hostname === '*' ) {
        const keys = await getAllCustomFilterKeys();
        if ( keys.length === 0 ) { return false; }
        for ( const key of keys ) {
            removeFromStorage(key);
        }
        return true;
    }
    const key = `site.${hostname}`;
    const selectors = await readFromStorage(key) || [];
    removeFromStorage(key);
    return selectors.length !== 0;
}

export async function removeCustomFilters(hostname, selectors) {
    const promises = [];
    let hn = typeof hostname === 'string'
        ? hostname.trim().toLowerCase()
        : '';
    if ( hn === '' ) { return false; }
    while ( hn !== '' ) {
        promises.push(removeCustomFiltersByKey(`site.${hn}`, selectors));
        const pos = hn.indexOf('.');
        if ( pos === -1 ) { break; }
        hn = hn.slice(pos + 1);
    }
    const results = await Promise.all(promises);
    return results.some(a => a);
}

async function removeCustomFiltersByKey(key, toRemove) {
    const selectors = await readFromStorage(key);
    if ( selectors === undefined ) { return false; }
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
    if ( afterCount !== 0 ) {
        writeToStorage(key, selectors);
    } else {
        removeFromStorage(key);
    }
    return true;
}

/******************************************************************************/

export function getSandboxFilters() {
    return localRead('sandboxFilters');
}

export function setSandboxFilters(text = '') {
    text = typeof text === 'string' ? text.trim() : '';
    return text !== ''
        ? localWrite('sandboxFilters', text)
        : localRemove('sandboxFilters');
}

/******************************************************************************/

export async function registerSandboxFilters() {
    if ( supportsUserScripts !== true ) { return false; }
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
    const result = await parseRawFilters(text) || {};
    const toRemove = await browser.userScripts.getScripts();
    if ( toRemove.length !== 0 ) {
        await browser.userScripts.unregister();
    }
    const toAdd = [];
    const hostnames = none.has('all-urls')
        ? [ ...notNone ]
        : [];
    const excludeHostnames = none.has('all-urls') === false
        ? [ ...none ]
        : [];
    const matches = hostnames.length !== 0
        ? matchesFromHostnames(hostnames)
        : [ '<all_urls>' ];
    const excludeMatches = excludeHostnames.length !== 0
        ? matchesFromHostnames(excludeHostnames)
        : [];
    if ( result.ISOLATED?.length ) {
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
    if ( result.MAIN?.length ) {
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
    if ( toAdd.length ) {
        await browser.userScripts.register(toAdd);
    }
    const beforeRules = await localRead('sandboxFilters.dnrRules');
    const afterRules = rulesetConfig.developerMode && result.dnrRules?.length
        ? result.dnrRules
        : undefined;
    const modified = JSON.stringify(afterRules) !== JSON.stringify(beforeRules);
    if ( modified ) {
        if ( Array.isArray(afterRules) ) {
            await localWrite('sandboxFilters.dnrRules', afterRules);
        } else {
            await localRemove('sandboxFilters.dnrRules');
        }
    }
    return modified;
}

/******************************************************************************/

async function parseRawFilters(text) {
    if ( Boolean(text) === false ) { return; }
    let offscreenResolve;
    const offscreenPromise = new Promise(resolve => {
        offscreenResolve = resolve;
    });
    const handler = (request, sender, callback) => {
        if ( typeof request !== 'object' ) { return; }
        if ( isOffscreenCompilerSender(sender) === false ) { return; }
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
    let timeoutResolve;
    const timeoutPromise = new Promise(resolve => {
        timeoutResolve = resolve;
    });
    self.setTimeout(timeoutResolve, 2000);
    const [ result ] = await Promise.all([
        Promise.race([ offscreenPromise, timeoutPromise ]),
        browser.offscreen.createDocument({
            url: '/js/offscreen/compile-filters.html',
            reasons: [ 'WORKERS' ],
            justification: 'Compile user custom filters from the service worker without dynamic module import',
        }),
    ]).finally(async () => {
        runtime.onMessage.removeListener(handler);
        await browser.offscreen.closeDocument().catch(() => {});
    });
    return result;
}
