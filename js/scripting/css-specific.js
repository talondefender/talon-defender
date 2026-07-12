/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2019-present Raymond Hill

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

// Important!
// Isolate from global scope
self.TalonCssSpecificReady = (async function uBOL_cssSpecific() {

/******************************************************************************/

const specificImports = self.specificImports || [];
self.specificImports = undefined;

/******************************************************************************/

const { isolatedAPI } = self;
const runtimeGeneration = Number(self.TalonCoreCssRuntimeGeneration) || 0;
const runtimeWasTerminated = () =>
    (Number(self.TalonCoreCssTerminationDepth) || 0) !== 0 ||
    (Number(self.TalonCoreCssRuntimeGeneration) || 0) !== runtimeGeneration;
if ( runtimeWasTerminated() ) { return; }

const proceduralApiMessageTimeoutMs = 5000;
const sendRuntimeMessageBounded = payload => {
    let raw;
    try {
        raw = Promise.resolve(chrome.runtime.sendMessage(payload));
    } catch (reason) {
        return Promise.reject(reason);
    }
    raw.catch(() => {});
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = self.setTimeout(() => {
            if ( settled ) { return; }
            settled = true;
            reject(new Error('specific procedural CSS API request timed out'));
        }, proceduralApiMessageTimeoutMs);
        raw.then(value => {
            if ( settled ) { return; }
            settled = true;
            self.clearTimeout(timer);
            resolve(value);
        }, reason => {
            if ( settled ) { return; }
            settled = true;
            self.clearTimeout(timer);
            reject(reason);
        });
    });
};
const ensureProceduralFiltererAPI = async () => {
    if ( typeof self.ProceduralFiltererAPI === 'function' ) { return; }
    if ( self.ProceduralFiltererAPI === undefined ) {
        self.ProceduralFiltererAPI = sendRuntimeMessageBounded({
            what: 'injectCSSProceduralAPI',
        });
    }
    const pending = self.ProceduralFiltererAPI;
    if ( pending instanceof Promise ) {
        try {
            const response = await pending;
            if (
                typeof self.ProceduralFiltererAPI !== 'function' &&
                response?.ok !== true
            ) {
                throw new Error(
                    response?.error || 'specific procedural CSS API request failed'
                );
            }
        } catch (reason) {
            // The injected file can install the constructor before the message
            // response channel settles. Keep that valid late success.
            if ( typeof self.ProceduralFiltererAPI === 'function' ) { return; }
            if ( self.ProceduralFiltererAPI === pending ) {
                self.ProceduralFiltererAPI = undefined;
            }
            throw reason;
        }
    }
    if ( typeof self.ProceduralFiltererAPI === 'function' ) { return; }
    if ( self.ProceduralFiltererAPI === pending ) {
        self.ProceduralFiltererAPI = undefined;
    }
    throw new Error('specific procedural CSS API unavailable');
};

const sessionRead = async function(key) {
    const bin = await chrome.storage.session.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid session storage response for ${key}`);
    }
    return Object.hasOwn(bin, key) ? bin[key] : undefined;
};

const sessionWrite = async function(key, data) {
    await chrome.storage.session.set({ [key]: data });
};

const localRead = async function(key) {
    const bin = await chrome.storage.local.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid local storage response for ${key}`);
    }
    return Object.hasOwn(bin, key) ? bin[key] : undefined;
};

const selectorsFromListIndex = (data, ilist) => {
    const list = JSON.parse(`[${data.selectorLists[ilist]}]`);
    const { result } = data;
    for ( const iselector of list ) {
        if ( iselector >= 0 ) {
            result.selectors.add(data.selectors[iselector]);
        } else {
            result.exceptions.add(data.selectors[~iselector]);
        }
    }
};

const selectorsFromHostnames = (haystack, needles, data) => {
    let listref = -1;
    for ( const needle of needles ) {
        listref = isolatedAPI.binarySearch(haystack, needle, listref);
        if ( listref >= 0 ) {
            selectorsFromListIndex(data, data.selectorListRefs[listref]);
        } else {
            listref = ~listref + 1;
        }
    }
};

const selectorsFromRuleset = async (rulesetId, result) => {
    const data = await localRead(`css.specific.${rulesetId}`);
    if ( typeof data !== 'object' || data === null ) { return; }
    data.result = result;
    const { hostnames, regexes } = data;
    if ( hostnames.length ) {
        selectorsFromHostnames(hostnames, isolatedAPI.contexts.hostnames, data);
        if ( data.hasEntities ) {
            selectorsFromHostnames(hostnames, isolatedAPI.contexts.entities, data);
        }
    }
    for ( let i = 0, n = regexes.length; i < n; i += 3 ) {
        if ( thisHostname.includes(regexes[i+0]) === false ) { continue; }
        if ( typeof regexes[i+1] === 'string' ) {
            regexes[i+1] = new RegExp(regexes[i+1]);
        }
        if ( regexes[i+1].test(thisHostname) === false ) { continue; }
        selectorsFromListIndex(data, regexes[i+2]);
    }
};

const fillCache = async function(rulesetIds) {
    const selectors = new Set();
    const exceptions = new Set();
    const result = { selectors, exceptions };
    const [ filteringModeDetails ] = await Promise.all([
        localRead('filteringModeDetails'),
        ...rulesetIds.map(a => selectorsFromRuleset(a, result)),
    ]);
    const skip = filteringModeDetails?.none.includes('all-urls') ||
        filteringModeDetails?.none.some(a => {
        if ( topHostname.endsWith(a) === false ) { return false; }
        const n = a.length;
        return topHostname.length === n || topHostname.at(-n-1) === '.';
        });
    for ( const selector of exceptions ) {
        selectors.delete(selector);
    }
    if ( skip ) {
        selectors.clear();
    }
    cacheEntry.s = [];
    cacheEntry.p = [];
    for ( const selector of selectors ) {
        if ( selector.startsWith('{') ) {
            cacheEntry.p.push(JSON.parse(selector));
        } else {
            cacheEntry.s.push(selector);
        }
    }
    return cacheEntry;
};

const topHostname = isolatedAPI.contexts.topHostname;
const thisHostname = document.location.hostname ||
    isolatedAPI.contexts.hostnames[0] || '';
const cachePath = topHostname !== thisHostname ? `${topHostname}/` : '';
const cacheKey = `cache.css.${cachePath}${thisHostname}`;

let cacheEntry = await sessionRead(cacheKey) ?? { t: 0 };
if (
    cacheEntry === null ||
    typeof cacheEntry !== 'object' ||
    Array.isArray(cacheEntry) ||
    Array.isArray(cacheEntry.s) === false && Number(cacheEntry.t) !== 0 ||
    Array.isArray(cacheEntry.p) === false && Number(cacheEntry.t) !== 0
) {
    cacheEntry = { t: 0 };
}
if ( runtimeWasTerminated() ) { return; }
if ( cacheEntry.t === 0 ) {
    cacheEntry = await fillCache(specificImports);
}
if ( runtimeWasTerminated() ) { return; }
const now = Math.round(Date.now() / (5 * 60000));
const since = now - cacheEntry.t;
if ( since > 1 ) {
    cacheEntry.t = now;
    await sessionWrite(cacheKey, cacheEntry).catch(() => {});
}
if ( runtimeWasTerminated() ) { return; }

const { s, p } = cacheEntry;
const coreSpecificScope = 'core-specific';
const cleanupSpecificCosmetics = async () => {
    const jobs = [];
    if ( self.listsSpecificProceduralFiltererAPI instanceof Object ) {
        jobs.push(Promise.resolve(
            self.listsSpecificProceduralFiltererAPI.reset()
        ));
    }
    if ( self.cssAPI instanceof Object ) {
        jobs.push(Promise.resolve(self.cssAPI.removeAll(coreSpecificScope)));
    }
    const results = await Promise.allSettled(jobs);
    self.listsSpecificProceduralFiltererAPI = undefined;
    const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
    if ( failures.length !== 0 ) {
        throw new AggregateError(failures, 'specific cosmetic rollback failed');
    }
};

try {

if ( s.length !== 0 ) {
    await self.cssAPI.insert(
        `${s.join(',\n')}{display:none!important;}`,
        coreSpecificScope
    );
}
if ( runtimeWasTerminated() ) {
    await cleanupSpecificCosmetics();
    return;
}

if ( p.length === 0 ) { return; }

await ensureProceduralFiltererAPI();

if ( runtimeWasTerminated() ) {
    await cleanupSpecificCosmetics();
    return;
}

if ( typeof self.ProceduralFiltererAPI !== 'function' ) {
    self.ProceduralFiltererAPI = undefined;
    throw new Error('specific procedural CSS API unavailable');
}

if ( self.listsSpecificProceduralFiltererAPI instanceof Object === false ) {
    self.listsSpecificProceduralFiltererAPI =
        new self.ProceduralFiltererAPI(coreSpecificScope);
}

if ( runtimeWasTerminated() ) {
    await cleanupSpecificCosmetics();
    return;
}

await self.listsSpecificProceduralFiltererAPI.addSelectors(p);

} catch (reason) {
    try {
        await cleanupSpecificCosmetics();
    } catch (cleanupReason) {
        throw new AggregateError(
            [ reason, cleanupReason ],
            'specific cosmetic initialization rollback failed'
        );
    }
    throw reason;
}

/******************************************************************************/

})();

((ready, pending) => {
    pending.add(ready);
    ready.finally(() => pending.delete(ready)).catch(() => {});
    return ready;
})(
    self.TalonCssSpecificReady,
    self.TalonCssSpecificReadySet ||= new Set()
);
