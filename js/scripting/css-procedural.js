/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2014-present Raymond Hill

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
self.TalonCssProceduralReady = (async function uBOL_cssProcedural() {

/******************************************************************************/

const proceduralImports = self.proceduralImports || [];
self.proceduralImports = undefined;
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
            reject(new Error('compiled procedural CSS API request timed out'));
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
                    response?.error || 'compiled procedural CSS API request failed'
                );
            }
        } catch (reason) {
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
    throw new Error('compiled procedural CSS API unavailable');
};

/******************************************************************************/

const selectors = [];
const exceptions = [];

const lookupHostname = (hostname, details, out) => {
    let seqi = details.hostnamesMap.get(hostname);
    if ( seqi === undefined ) { return; }
    const { argsList, argsSeqs } = details;
    for (;;) {
        const argi = argsSeqs[seqi++];
        const done = argi > 0;
        out.push(...JSON.parse(argsList[done ? argi : -argi]));
        if ( done ) { break; }
    }
};

const lookupAll = hostname => {
    for ( const details of proceduralImports ) {
        lookupHostname(hostname, details, selectors);
        const matches = [];
        lookupHostname(`~${hostname}`, details, matches);
        if ( matches.length === 0 ) { continue; }
        exceptions.push(...matches.map(a => JSON.stringify(a)));
    }
};

self.isolatedAPI.forEachHostname(lookupAll, {
    hasEntities: proceduralImports.some(a => a.hasEntities)
});
proceduralImports.length = 0;

if ( selectors.length === 0 ) { return; }

const exceptedSelectors = exceptions.length !== 0
    ? selectors.filter(a => exceptions.includes(JSON.stringify(a)) === false)
    : selectors;
if ( exceptedSelectors.length === 0 ) { return; }
const coreProceduralScope = 'core-procedural';
const cleanupCompiledProceduralCosmetics = async () => {
    const jobs = [];
    if ( self.listsCompiledProceduralFiltererAPI instanceof Object ) {
        jobs.push(Promise.resolve(
            self.listsCompiledProceduralFiltererAPI.reset()
        ));
    }
    if ( self.cssAPI instanceof Object ) {
        jobs.push(Promise.resolve(self.cssAPI.removeAll(coreProceduralScope)));
    }
    const results = await Promise.allSettled(jobs);
    self.listsCompiledProceduralFiltererAPI = undefined;
    const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
    if ( failures.length !== 0 ) {
        throw new AggregateError(failures, 'compiled procedural rollback failed');
    }
};

try {
    await ensureProceduralFiltererAPI();
    if ( runtimeWasTerminated() ) {
        await cleanupCompiledProceduralCosmetics();
        return;
    }
    if ( typeof self.ProceduralFiltererAPI !== 'function' ) {
        self.ProceduralFiltererAPI = undefined;
        throw new Error('compiled procedural CSS API unavailable');
    }
    if ( self.listsCompiledProceduralFiltererAPI instanceof Object === false ) {
        self.listsCompiledProceduralFiltererAPI =
            new self.ProceduralFiltererAPI(coreProceduralScope);
    }
    if ( runtimeWasTerminated() ) {
        await cleanupCompiledProceduralCosmetics();
        return;
    }
    await self.listsCompiledProceduralFiltererAPI.addSelectors(exceptedSelectors);
} catch (reason) {
    try {
        await cleanupCompiledProceduralCosmetics();
    } catch (cleanupReason) {
        throw new AggregateError(
            [ reason, cleanupReason ],
            'compiled procedural initialization rollback failed'
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
    self.TalonCssProceduralReady,
    self.TalonCssProceduralReadySet ||= new Set()
);
