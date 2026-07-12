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

self.TalonCssUserReady = (async function uBOL_cssUser() {

/******************************************************************************/

const previousCustomCssOperation = self.TalonCustomCssOperationTail ||
    Promise.resolve();
let releaseCustomCssOperation;
const customCssOperationDone = new Promise(resolve => {
    releaseCustomCssOperation = resolve;
});
const customCssOperationTail = previousCustomCssOperation
    .catch(() => {})
    .then(() => customCssOperationDone);
self.TalonCustomCssOperationTail = customCssOperationTail;
await previousCustomCssOperation.catch(() => {});

try {

const runtimeGeneration = Number(self.TalonCustomCssRuntimeGeneration) || 0;
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
            reject(new Error('custom CSS runtime message timed out'));
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
const runtimeWasTerminated = () =>
    (Number(self.TalonCustomCssTerminationDepth) || 0) !== 0 ||
    (Number(self.TalonCustomCssRuntimeGeneration) || 0) !== runtimeGeneration;
const effectiveHostname = (() => {
    const hostnameFrom = value => {
        if (
            typeof value !== 'string' ||
            value === '' ||
            value.length > 2048
        ) { return ''; }
        try {
            const parsed = new URL(value);
            if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ) {
                return parsed.hostname.toLowerCase();
            }
            if (
                (parsed.protocol === 'blob:' || parsed.protocol === 'filesystem:') &&
                /^https?:\/\//i.test(parsed.origin)
            ) {
                return new URL(parsed.origin).hostname.toLowerCase();
            }
        } catch {
        }
        return '';
    };
    const candidates = [
        document.location?.origin,
        document.location?.href,
        document.referrer,
        ...Array.from(document.location?.ancestorOrigins || []),
    ];
    for ( const candidate of candidates ) {
        const hostname = hostnameFrom(candidate);
        if ( hostname !== '' ) { return hostname; }
    }
    try {
        return hostnameFrom(self.opener?.location?.origin);
    } catch {
    }
    return '';
})();
const stagedDetails = self.TalonStagedCustomFilterDetails;
self.TalonStagedCustomFilterDetails = undefined;
if ( runtimeWasTerminated() ) { return; }
const details = stagedDetails instanceof Object
    ? stagedDetails
    : await sendRuntimeMessageBounded({
        what: 'injectCustomFilters',
        hostname: effectiveHostname,
    });
if ( details?.error ) { throw new Error(details.error); }
self.TalonPendingCustomFilterDetails = details;
const plainSelectors = Array.isArray(details?.plainSelectors)
    ? details.plainSelectors
    : [];
const buildCustomCssChunks = selectors => {
    if ( Array.isArray(selectors) === false || selectors.length === 0 ) {
        return [];
    }
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
const customCssChunks = buildCustomCssChunks(plainSelectors);
const removeCustomCss = async () => {
    if ( customCssChunks.length === 0 ) { return; }
    if (
        self.cssAPI?.supportsScopedOwnership === true &&
        typeof self.cssAPI.remove === 'function'
    ) {
        const results = await Promise.allSettled(
            customCssChunks.map(css => self.cssAPI.remove(css, 'custom'))
        );
        const failure = results.find(result => result.status === 'rejected');
        if ( failure ) {
            throw failure.reason;
        }
        return;
    }
    for ( const css of customCssChunks ) {
        const response = await sendRuntimeMessageBounded({
            what: 'removeCSS',
            css,
        });
        if ( response?.ok !== true ) {
            throw new Error(response?.error || 'rollback custom CSS failed');
        }
    }
};

try {

if ( runtimeWasTerminated() ) {
    self.TalonPendingCustomFilterDetails = undefined;
    return;
}

if ( customCssChunks.length !== 0 ) {
    for ( const css of customCssChunks ) {
        if (
            self.cssAPI?.supportsScopedOwnership === true &&
            typeof self.cssAPI.insert === 'function'
        ) {
            await self.cssAPI.insert(css, 'custom');
        } else {
            const response = await sendRuntimeMessageBounded({
                what: 'insertCSS',
                css,
            });
            if ( response?.ok !== true ) {
                throw new Error(response?.error || 'insert custom CSS failed');
            }
        }
    }
    if ( runtimeWasTerminated() ) {
        await removeCustomCss();
        self.TalonPendingCustomFilterDetails = undefined;
        return;
    }
}

// Re-entry is possible after an options/picker refresh or a retried scripting
// call. Never overwrite the only handle to an older procedural observer.
if ( self.customProceduralFiltererAPI instanceof Object ) {
    const previousFilterer = self.customProceduralFiltererAPI;
    await previousFilterer.reset();
    if ( self.customProceduralFiltererAPI === previousFilterer ) {
        self.customProceduralFiltererAPI = undefined;
    }
}

if ( details?.proceduralSelectors?.length ) {
    if ( typeof self.ProceduralFiltererAPI !== 'function' ) {
        throw new Error('custom procedural CSS API unavailable');
    }
    const proceduralSelectors = details.proceduralSelectors.map(selector =>
        JSON.parse(selector)
    );
    const filterer = new self.ProceduralFiltererAPI('custom');
    await filterer.addSelectors(proceduralSelectors);
    if ( runtimeWasTerminated() ) {
        self.customProceduralFiltererAPI = filterer;
        await filterer.reset();
        self.customProceduralFiltererAPI = undefined;
        await removeCustomCss();
        self.TalonPendingCustomFilterDetails = undefined;
        return;
    }
    self.customProceduralFiltererAPI = filterer;
}

if ( runtimeWasTerminated() ) {
    if ( self.customProceduralFiltererAPI instanceof Object ) {
        await self.customProceduralFiltererAPI.reset();
        self.customProceduralFiltererAPI = undefined;
    }
    await removeCustomCss();
    self.TalonPendingCustomFilterDetails = undefined;
    return;
}
self.customFilters = details;
self.TalonPendingCustomFilterDetails = undefined;

} catch (reason) {
    const cleanupFailures = [];
    if ( self.customProceduralFiltererAPI instanceof Object ) {
        try {
            await self.customProceduralFiltererAPI.reset();
            self.customProceduralFiltererAPI = undefined;
        } catch (cleanupReason) {
            cleanupFailures.push(cleanupReason);
        }
    }
    try {
        await removeCustomCss();
    } catch (cleanupReason) {
        cleanupFailures.push(cleanupReason);
    }
    if ( cleanupFailures.length === 0 ) {
        self.TalonPendingCustomFilterDetails = undefined;
        throw reason;
    }
    const cleanupError = new Error(
        `custom CSS rollback failed: ${cleanupFailures.join('; ')}`
    );
    cleanupError.cause = reason;
    throw cleanupError;
}

} finally {
    releaseCustomCssOperation();
}

/******************************************************************************/

})();

((ready, pending) => {
    pending.add(ready);
    ready.finally(() => pending.delete(ready)).catch(() => {});
    return ready;
})(
    self.TalonCssUserReady,
    self.TalonCssUserReadySet ||= new Set()
);
