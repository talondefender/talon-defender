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
(async function uBOL_cssCompiled() {

/******************************************************************************/

const cssSpecificData = self.$cssSpecificData$;

/******************************************************************************/

const { isolatedAPI } = self;
const thisHostname = document.location.hostname || '';
const selectors = new Set();
const exceptions = new Set();

const selectorsFromListIndex = ilist => {
    const list = JSON.parse(`[${cssSpecificData.selectorLists[ilist]}]`);
    for ( const iselector of list ) {
        if ( iselector >= 0 ) {
            const selector = cssSpecificData.selectors[iselector];
            if ( exceptions.has(selector) ) { continue; }
            selectors.add(selector);
        } else {
            const exception = cssSpecificData.selectors[~iselector];
            exceptions.add(exception);
            selectors.delete(exception);
        }
    }
};

const { hostnames, regexes } = cssSpecificData;
if ( hostnames.length ) {
    const selectorsFromHostnames = (haystack, needles) => {
        let listref = -1;
        for ( const needle of needles ) {
            listref = isolatedAPI.binarySearch(haystack, needle, listref);
            if ( listref >= 0 ) {
                selectorsFromListIndex(cssSpecificData.selectorListRefs[listref]);
            } else {
                listref = ~listref + 1;
            }
        }
    };
    selectorsFromHostnames(hostnames, isolatedAPI.contexts.hostnames);
    if ( cssSpecificData.hasEntities ) {
        selectorsFromHostnames(hostnames, isolatedAPI.contexts.entities);
    }
}
for ( let i = 0, n = regexes.length; i < n; i += 3 ) {
    if ( thisHostname.includes(regexes[i+0]) === false ) { continue; }
    if ( typeof regexes[i+1] === 'string' ) {
        regexes[i+1] = new RegExp(regexes[i+1]);
    }
    if ( regexes[i+1].test(thisHostname) === false ) { continue; }
    selectorsFromListIndex(regexes[i+2]);
}

const s = [];
const p = [];
for ( const selector of selectors ) {
    if ( selector.startsWith('{') ) {
        p.push(JSON.parse(selector));
    } else {
        s.push(selector);
    }
}

const sandboxScope = 'sandbox';
try {
    if ( s.length !== 0 ) {
        await self.cssAPI.insert(
            `${s.join(',\n')}{display:none!important;}`,
            sandboxScope
        );
    }

    if ( p.length !== 0 ) {
        await self.ProceduralFiltererAPI;
        if ( typeof self.ProceduralFiltererAPI !== 'function' ) {
            throw new Error('sandbox procedural CSS API unavailable');
        }
        self.listsProceduralFiltererAPI =
            new self.ProceduralFiltererAPI(sandboxScope);
        await self.listsProceduralFiltererAPI.addSelectors(p);
    }
} catch (reason) {
    const cleanup = [];
    if ( self.listsProceduralFiltererAPI instanceof Object ) {
        cleanup.push(Promise.resolve(
            self.listsProceduralFiltererAPI.reset()
        ));
    }
    if ( typeof self.cssAPI?.removeAll === 'function' ) {
        cleanup.push(Promise.resolve(self.cssAPI.removeAll(sandboxScope)));
    }
    const results = await Promise.allSettled(cleanup);
    const failures = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
    if ( failures.length !== 0 ) {
        throw new AggregateError(
            [ reason, ...failures ],
            'sandbox cosmetic rollback failed'
        );
    }
    throw reason;
}

self.isolatedAPI = undefined;
self.ProceduralFiltererAPI = undefined;

/******************************************************************************/

})();

void 0;
