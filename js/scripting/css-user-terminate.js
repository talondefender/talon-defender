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

(async function uBOL_cssUserTerminate() {

/******************************************************************************/

self.TalonCustomCssTerminationDepth =
    (Number(self.TalonCustomCssTerminationDepth) || 0) + 1;
self.TalonCustomCssRuntimeGeneration =
    (Number(self.TalonCustomCssRuntimeGeneration) || 0) + 1;
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
            reject(new Error('custom CSS cleanup message timed out'));
        }, 15000);
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
const drainReadySets = async globalNames => {
    let emptyPasses = 0;
    for ( let pass = 0; pass < 32; pass++ ) {
        const pending = Array.from(new Set(globalNames.flatMap(globalName =>
            Array.from(self[globalName] || []).filter(value =>
                value !== null && typeof value?.then === 'function'
            )
        )));
        if ( pending.length === 0 ) {
            emptyPasses += 1;
            if ( emptyPasses >= 2 ) { return; }
            await Promise.resolve();
            continue;
        }
        emptyPasses = 0;
        let timer;
        try {
            await Promise.race([
                Promise.allSettled(pending),
                new Promise((_, reject) => {
                    timer = self.setTimeout(() => {
                        reject(new Error('custom CSS readiness timed out'));
                    }, 5000);
                }),
            ]);
        } finally {
            if ( timer !== undefined ) { self.clearTimeout(timer); }
        }
    }
    throw new Error('custom CSS readiness did not quiesce');
};

try {

const cleanupFailures = [];
if ( self.customProceduralFiltererAPI instanceof Object ) {
    const filterer = self.customProceduralFiltererAPI;
    self.customProceduralFiltererAPI = undefined;
    try {
        await filterer.reset();
    } catch (reason) {
        // A failed reset can leave a live observer. Preserve the only handle
        // so the durable document retry can stop it instead of reporting a
        // false success on its next pass.
        if ( self.customProceduralFiltererAPI === undefined ) {
            self.customProceduralFiltererAPI = filterer;
        }
        cleanupFailures.push(reason);
    }
}

await drainReadySets([ 'TalonCssUserReadySet' ]).catch(reason => {
    cleanupFailures.push(reason);
});

try {
if (
    self.cssAPI?.supportsScopedOwnership === true &&
    typeof self.cssAPI.removeAll === 'function'
) {
    // The ownership registry is authoritative, including a sheet inserted by
    // a late starter whose metadata has not yet committed. removeAll restores
    // failed ownership records, which makes the next cleanup retry exact.
    await self.cssAPI.removeAll('custom');
} else {
const plainSelectors = self.customFilters?.plainSelectors ||
    self.TalonPendingCustomFilterDetails?.plainSelectors;
if ( Array.isArray(plainSelectors) && plainSelectors.length !== 0 ) {
    const buildChunks = selectors => {
        if ( typeof self.cssAPI?.selectorListCssChunks === 'function' ) {
            return self.cssAPI.selectorListCssChunks(selectors);
        }
        const declaration = '{display:none!important;}';
        const budget = 100000 - declaration.length;
        const chunks = [];
        let chunk = '';
        for ( const selector of selectors ) {
            if ( typeof selector !== 'string' || selector === '' ) { continue; }
            if ( selector.length > budget ) {
                throw new Error('custom selector exceeds CSS message limit');
            }
            const candidate = chunk === '' ? selector : `${chunk},\n${selector}`;
            if ( candidate.length <= budget ) {
                chunk = candidate;
                continue;
            }
            chunks.push(`${chunk}${declaration}`);
            chunk = selector;
        }
        if ( chunk !== '' ) { chunks.push(`${chunk}${declaration}`); }
        return chunks;
    };
    const chunks = buildChunks(plainSelectors);
    for ( const css of chunks ) {
        const response = await sendRuntimeMessageBounded({
            what: 'removeCSS',
            css,
        });
        if ( response?.ok !== true ) {
            throw new Error(response?.error || 'remove custom CSS failed');
        }
    }
}
}
} catch (reason) {
    cleanupFailures.push(reason);
}

if ( cleanupFailures.length !== 0 ) {
    throw new AggregateError(
        cleanupFailures,
        'custom CSS termination was incomplete'
    );
}
self.customFilters = undefined;
self.TalonPendingCustomFilterDetails = undefined;
self.TalonStagedCustomFilterDetails = undefined;

} finally {
    self.TalonCustomCssTerminationDepth = Math.max(
        0,
        (Number(self.TalonCustomCssTerminationDepth) || 1) - 1
    );
}

/******************************************************************************/

})();
