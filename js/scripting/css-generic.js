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

/******************************************************************************/

// Important!
// Isolate from global scope
self.TalonCssGenericInitialReady = (async function uBOL_cssGeneric() {

const existingController = self.TalonCssGenericController;

const genericSelectorMaps = self.genericSelectorMaps ?? [];
self.genericSelectorMaps = undefined;

const genericDetails = self.genericDetails ?? [];
self.genericDetails = undefined;
const runtimeGeneration = Number(self.TalonCoreCssRuntimeGeneration) || 0;
const runtimeWasTerminated = () =>
    (Number(self.TalonCoreCssTerminationDepth) || 0) !== 0 ||
    (Number(self.TalonCoreCssRuntimeGeneration) || 0) !== runtimeGeneration;

if ( runtimeWasTerminated() ) { return false; }

// An empty payload is meaningful during a live mode downgrade: it must stop
// a surveyor installed earlier while the page was in Complete mode.
await existingController?.stop?.();
if ( genericDetails.length === 0 ) { return Promise.resolve(true); }
if ( document.documentElement === null ) { return Promise.resolve(true); }

/******************************************************************************/

const maxSurveyTimeSlice = 4;
const maxSurveyNodeSlice = 64;
const maxSurveyRootQueue = 256;
const maxSurveyMutationRecords = 512;
// The background message validator accepts at most 120,000 characters. Keep
// comfortable headroom for the declaration suffix and future protocol fields.
const maxGenericCssPayloadLength = 100000;
const maxPendingStyleSheetChunks = 128;
const maxStyleSheetInsertAttempts = 3;
const styleSheetRetryDelays = [ 100, 500 ];
const genericHideDeclaration = '{display:none!important;}';
const monotonicNow = typeof self.performance?.now === 'function'
    ? self.performance.now.bind(self.performance)
    : Date.now;
const seenHashes = new Set();
const pendingHashes = new Set();
const pendingSelectors = [];
const stopAllRatio = 0.95; // To be investigated

let surveyCount = 0;
let surveyMissCount = 0;
let styleSheetTimer;
let styleSheetTimerType = '';
let styleSheetFlushInFlight = false;
let stopAfterStyleSheet = false;
const pendingStyleSheetChunks = [];
let genericRuntimeStopped = false;
let nextStyleSheetChunkId = 1;
let initialReadyTargetId = 0;
let initialScanOpen = true;
let lastInsertedStyleSheetChunkId = 0;
let initialReadySettled = false;
let initialRollbackPromise;
let resolveInitialReady;
let rejectInitialReady;
const initialReady = new Promise((resolve, reject) => {
    resolveInitialReady = resolve;
    rejectInitialReady = reject;
});
const settleInitialReady = (error, entryId = 0) => {
    if ( initialReadySettled ) { return; }
    if ( error === undefined ) {
        if ( initialScanOpen ) { return; }
        if ( entryId < initialReadyTargetId ) { return; }
        initialReadySettled = true;
        resolveInitialReady(true);
        return;
    }
    initialReadySettled = true;
    rejectInitialReady(error);
};
const rejectInitialReadyWithRollback = reason => {
    if ( initialReadySettled ) {
        return initialRollbackPromise || Promise.resolve();
    }
    initialReadySettled = true;
    const cleanup = typeof self.cssAPI?.removeAll === 'function'
        ? self.cssAPI.removeAll('generic')
        : Promise.resolve();
    initialRollbackPromise = Promise.resolve(cleanup).then(
        () => rejectInitialReady(reason),
        cleanupReason => rejectInitialReady(new AggregateError(
            [ reason, cleanupReason ],
            'generic cosmetic rollback failed'
        ))
    );
    initialRollbackPromise.catch(() => {});
    return initialRollbackPromise;
};
let processTimer;
let domChangeTimer;
let lastDomChange = Date.now();
const deferredInitialMutations = [];

/******************************************************************************/

const pendingNodes = {
    addedNodes: [],
    addedIndex: 0,
    walker: undefined,
    seenNodes: new WeakSet(),
    overflowed: false,
    rescanRequested: false,
    add(node) {
        if ( this.overflowed ) {
            this.rescanRequested = true;
            return false;
        }
        if (
            (this.addedNodes.length - this.addedIndex) >=
            maxSurveyRootQueue
        ) {
            this.forceFullScan();
            return false;
        }
        this.addedNodes.push(node);
        return true;
    },
    forceFullScan() {
        if ( this.overflowed ) {
            this.rescanRequested = true;
            return;
        }
        this.addedNodes = [ document.documentElement ];
        this.addedIndex = 0;
        this.walker = undefined;
        this.seenNodes = new WeakSet();
        this.overflowed = true;
    },
    next(out, deadline) {
        while ( out.length < maxSurveyNodeSlice && monotonicNow() < deadline ) {
            if ( this.walker === undefined ) {
                if ( this.addedIndex >= this.addedNodes.length ) {
                    if ( this.overflowed && this.rescanRequested ) {
                        this.addedNodes = [ document.documentElement ];
                        this.addedIndex = 0;
                        this.seenNodes = new WeakSet();
                        this.rescanRequested = false;
                        continue;
                    }
                    this.addedNodes = [];
                    this.addedIndex = 0;
                    this.seenNodes = new WeakSet();
                    this.overflowed = false;
                    this.rescanRequested = false;
                    break;
                }
                const added = this.addedNodes[this.addedIndex++];
                if ( added?.nodeType !== 1 || this.seenNodes.has(added) ) {
                    continue;
                }
                this.seenNodes.add(added);
                out.push(added);
                try {
                    this.walker = document.createTreeWalker(
                        added,
                        self.NodeFilter?.SHOW_ELEMENT || 1
                    );
                } catch {
                    this.walker = undefined;
                }
                continue;
            }

            const node = this.walker.nextNode();
            if ( node === null ) {
                this.walker = undefined;
                continue;
            }
            if ( this.seenNodes.has(node) ) { continue; }
            this.seenNodes.add(node);
            if ( node.id === '' && node.hasAttribute?.('class') !== true ) {
                continue;
            }
            out.push(node);
        }
    },
    hasNodes() {
        return this.walker !== undefined || this.addedIndex < this.addedNodes.length;
    },
    clear() {
        this.addedNodes.length = 0;
        this.addedIndex = 0;
        this.walker = undefined;
        this.seenNodes = new WeakSet();
        this.overflowed = false;
        this.rescanRequested = false;
    },
};

/******************************************************************************/

// http://www.cse.yorku.ca/~oz/hash.html#djb2
//   Must mirror dnrRulesetFromRawLists's version

const hashFromStr = (type, s) => {
    const len = s.length;
    const step = len + 7 >>> 3;
    let hash = (type << 5) + type ^ len;
    for ( let i = 0; i < len; i += step ) {
        hash = (hash << 5) + hash ^ s.charCodeAt(i);
    }
    return hash & 0xFFFF;
};

/******************************************************************************/

// Extract all classes/ids: these will be passed to the cosmetic
// filtering engine, and in return we will obtain only the relevant
// CSS selectors.

// https://github.com/gorhill/uBlock/issues/672
// http://www.w3.org/TR/2014/REC-html5-20141028/infrastructure.html#space-separated-tokens
// http://jsperf.com/enumerate-classes/6

const uBOL_idFromNode = node => {
    const raw = node.id;
    if ( typeof raw !== 'string' || raw.length === 0 ) { return; }
    const hash = hashFromStr(0x23 /* '#' */, raw.trim());
    if ( seenHashes.has(hash) ) { return; }
    seenHashes.add(hash);
    pendingHashes.add(hash);
};

// https://github.com/uBlockOrigin/uBlock-issues/discussions/2076
//   Performance: avoid using Element.classList
const uBOL_classesFromNode = node => {
    const s = node.getAttribute('class');
    if ( typeof s !== 'string' ) { return; }
    const len = s.length;
    for ( let beg = 0, end = 0; beg < len; beg += 1 ) {
        end = s.indexOf(' ', beg);
        if ( end === beg ) { continue; }
        if ( end === -1 ) { end = len; }
        const token = s.slice(beg, end).trimEnd();
        beg = end;
        if ( token.length === 0 ) { continue; }
        const hash = hashFromStr(0x2E /* '.' */, token);
        if ( seenHashes.has(hash) ) { continue; }
        seenHashes.add(hash);
        pendingHashes.add(hash);
    }
};

/******************************************************************************/

const processPendingHashes = ( ) => {
    for ( const hash of pendingHashes ) {
        for ( const selectorMap of genericSelectorMaps ) {
            const selectors = selectorMap.get(hash);
            if ( selectors === undefined ) { continue; }
            selectorMap.delete(hash);
            pendingSelectors.push(selectors);
        }
    }
};

/******************************************************************************/

const scheduleNodeProcessing = (delay = 0) => {
    if ( processTimer !== undefined ) { return; }
    processTimer = self.setTimeout(( ) => {
        processTimer = undefined;
        uBOL_processNodes();
    }, delay);
};

/******************************************************************************/

const exceptPendingSelectors = ( ) => {
    if ( exceptionSet.size === 0 ) { return pendingSelectors.join(',\n'); }
    const selectorSet = new Set(pendingSelectors.map(a => a.split(',\n')).flat());
    return Array.from(selectorSet.difference(exceptionSet)).join(',\n');
};

const finishInitialScan = () => {
    if ( initialScanOpen === false ) { return; }
    initialScanOpen = false;
    initialReadyTargetId = nextStyleSheetChunkId - 1;
    settleInitialReady(undefined, lastInsertedStyleSheetChunkId);
    if ( deferredInitialMutations.length !== 0 ) {
        const mutations = deferredInitialMutations.splice(0);
        self.setTimeout(() => uBOL_processChanges(mutations), 0);
    }
};

/******************************************************************************/

const uBOL_processNodes = ( ) => {
    if ( runtimeWasTerminated() ) {
        stopAll('generic CSS runtime terminated during initial scan');
        return;
    }
    const nodes = [];
    const deadline = monotonicNow() + maxSurveyTimeSlice;
    for (;;) {
        pendingNodes.next(nodes, deadline);
        if ( nodes.length === 0 ) { break; }
        for ( const node of nodes ) {
            uBOL_idFromNode(node);
            uBOL_classesFromNode(node);
        }
        nodes.length = 0;
        if ( monotonicNow() >= deadline ) { break; }
    }
    const hasMoreNodes = pendingNodes.hasNodes();
    if ( hasMoreNodes === false ) { surveyCount += 1; }
    processPendingHashes();
    const styleSheetSelectors = exceptPendingSelectors();
    pendingHashes.clear();
    pendingSelectors.length = 0;
    if ( hasMoreNodes ) {
        scheduleNodeProcessing();
    }
    if ( styleSheetSelectors === '' ) {
        if ( hasMoreNodes ) { return; }
        finishInitialScan();
        surveyMissCount += 1;
        if ( surveyCount >= 64 ) {
            if ( (surveyMissCount / surveyCount) >= stopAllRatio ) {
                if ( styleSheetTimer !== undefined ) {
                    stopAfterStyleSheet = true;
                } else {
                    stopAll(`too many misses in surveyor (${surveyMissCount}/${surveyCount})`);
                }
            }
        }
        return;
    }
    enqueueStyleSheetSelectors(styleSheetSelectors);
    scheduleStyleSheetFlush();
    if ( hasMoreNodes === false ) { finishInitialScan(); }
    surveyMissCount = 0;
};

const enqueueStyleSheetSelectors = selectorText => {
    if ( typeof selectorText !== 'string' || selectorText === '' ) { return; }
    const budget = maxGenericCssPayloadLength - genericHideDeclaration.length;
    let chunk = '';
    for ( const selector of selectorText.split(',\n') ) {
        if ( selector === '' || selector.length > budget ) { continue; }
        const candidate = chunk === '' ? selector : `${chunk},\n${selector}`;
        if ( candidate.length <= budget ) {
            chunk = candidate;
            continue;
        }
        if ( pendingStyleSheetChunks.length < maxPendingStyleSheetChunks ) {
            pendingStyleSheetChunks.push({
                id: nextStyleSheetChunkId++,
                selectors: chunk,
                attempts: 0,
            });
            if ( initialScanOpen ) {
                initialReadyTargetId = nextStyleSheetChunkId - 1;
            }
        }
        chunk = selector;
    }
    if (
        chunk !== '' &&
        pendingStyleSheetChunks.length < maxPendingStyleSheetChunks
    ) {
        pendingStyleSheetChunks.push({
            id: nextStyleSheetChunkId++,
            selectors: chunk,
            attempts: 0,
        });
        if ( initialScanOpen ) {
            initialReadyTargetId = nextStyleSheetChunkId - 1;
        }
    }
};

function scheduleStyleSheetFlush(delay = 0) {
    if ( genericRuntimeStopped ) { return; }
    if ( styleSheetFlushInFlight || styleSheetTimer !== undefined ) { return; }
    if ( delay > 0 ) {
        styleSheetTimerType = 'timeout';
        styleSheetTimer = self.setTimeout(flushStyleSheet, delay);
    } else {
        styleSheetTimerType = 'animation';
        styleSheetTimer = self.requestAnimationFrame(flushStyleSheet);
    }
}

function flushStyleSheet() {
    styleSheetTimer = undefined;
    styleSheetTimerType = '';
    if ( genericRuntimeStopped ) { return; }
    if ( runtimeWasTerminated() ) {
        stopAll('generic CSS runtime terminated before insertion');
        return;
    }
    const entry = pendingStyleSheetChunks.shift();
    if ( entry === undefined ) {
        if ( stopAfterStyleSheet ) {
            stopAfterStyleSheet = false;
            stopAll('too many misses in surveyor');
        }
        return;
    }
    const css = `${entry.selectors}${genericHideDeclaration}`;
    // This invariant prevents a protocol rejection from becoming a hot retry
    // loop even if upstream selector data is unexpectedly malformed.
    if ( css.length > maxGenericCssPayloadLength ) {
        const reason = new Error('generic CSS payload exceeds message limit');
        if ( initialReadySettled === false ) {
            rejectInitialReadyWithRollback(reason);
        }
        stopAll(reason.message);
        return;
    }
    styleSheetFlushInFlight = true;
    let nextFlushDelay = 0;
    Promise.resolve(self.cssAPI.insert(css, 'generic')).then(() => {
        lastInsertedStyleSheetChunkId = entry.id;
        settleInitialReady(undefined, entry.id);
    }).catch(() => {
        if ( genericRuntimeStopped ) { return; }
        entry.attempts += 1;
        if ( entry.attempts >= maxStyleSheetInsertAttempts ) {
            if ( initialReadySettled === false ) {
                rejectInitialReadyWithRollback(
                    new Error('generic CSS insertion failed')
                );
            }
            stopAll('generic CSS insertion failed');
            return;
        }
        pendingStyleSheetChunks.unshift(entry);
        nextFlushDelay = styleSheetRetryDelays[entry.attempts - 1] ||
            styleSheetRetryDelays.at(-1);
    }).finally(() => {
        styleSheetFlushInFlight = false;
        if (
            genericRuntimeStopped === false &&
            styleSheetTimer === undefined
        ) {
            scheduleStyleSheetFlush(nextFlushDelay);
        }
    });
}

/******************************************************************************/

const uBOL_processChanges = mutations => {
    if ( runtimeWasTerminated() ) {
        stopAll('generic CSS runtime terminated during DOM update');
        return;
    }
    if ( initialScanOpen ) {
        const available = maxSurveyMutationRecords - deferredInitialMutations.length;
        if ( available > 0 ) {
            deferredInitialMutations.push(...mutations.slice(0, available));
        }
        if ( mutations.length > available ) {
            deferredInitialMutations.length = 0;
            deferredInitialMutations.push({
                type: 'childList',
                addedNodes: [ document.documentElement ],
                removedNodes: [],
            });
        }
        return;
    }
    let mutationCount = 0;
    mutationLoop:
    for ( const mutation of mutations ) {
        mutationCount += 1;
        if ( mutationCount > maxSurveyMutationRecords ) {
            pendingNodes.forceFullScan();
            break;
        }
        if ( mutation.type === 'childList' ) {
            for ( const added of mutation.addedNodes ) {
                if ( added.nodeType !== 1 ) { continue; }
                if ( added.parentElement === null ) { continue; }
                if ( pendingNodes.add(added) === false ) {
                    break mutationLoop;
                }
            }
        } else if ( mutation.attributeName === 'class' ) {
            uBOL_classesFromNode(mutation.target);
        } else {
            uBOL_idFromNode(mutation.target);
        }
    }
    if ( pendingNodes.hasNodes() === false ) {
        if ( pendingHashes.size === 0 ) { return; }
    }
    lastDomChange = Date.now();
    scheduleNodeProcessing(64);
};

/******************************************************************************/

const stopAll = reason => {
    if ( initialReadySettled === false ) {
        rejectInitialReadyWithRollback(reason instanceof Error
            ? reason
            : new Error(
                typeof reason === 'string' && reason !== ''
                    ? reason
                    : 'generic CSS runtime stopped before initial insertion'
            ));
    }
    genericRuntimeStopped = true;
    if ( domChangeTimer !== undefined ) {
        self.clearTimeout(domChangeTimer);
        domChangeTimer = undefined;
    }
    if ( domMutationObserver ) {
        domMutationObserver.disconnect();
        domMutationObserver.takeRecords();
        domMutationObserver = undefined;
    }
    if ( processTimer !== undefined ) {
        self.clearTimeout(processTimer);
        processTimer = undefined;
    }
    if ( styleSheetTimer !== undefined ) {
        if ( styleSheetTimerType === 'timeout' ) {
            self.clearTimeout(styleSheetTimer);
        } else {
            self.cancelAnimationFrame(styleSheetTimer);
        }
        styleSheetTimer = undefined;
    }
    styleSheetTimerType = '';
    stopAfterStyleSheet = false;
    pendingStyleSheetChunks.length = 0;
    pendingNodes.clear();
    pendingHashes.clear();
    pendingSelectors.length = 0;
    genericSelectorMaps.length = 0;
    deferredInitialMutations.length = 0;
    return initialRollbackPromise || Promise.resolve(true);
};

/******************************************************************************/

// Perform once:
// - Inject highly generics
// - Collate exceptions matching current context

const exceptionSet = new Set();
for ( const entry of genericDetails ) {
    const { highlyGeneric, exceptions, hostnames } = entry;
    if ( highlyGeneric ) {
        pendingSelectors.push(highlyGeneric);
    }
    if ( hostnames.length === 0 ) { continue; }
    let i = -1;
    for ( const hostname of self.isolatedAPI.contexts.hostnames ) {
        i = self.isolatedAPI.binarySearch(hostnames, hostname, i);
        if ( i >= 0 ) {
            exceptions[i].split('\n').forEach(a => exceptionSet.add(a));
        } else {
            i = ~i + 1;
        }
    }
    if ( entry.hasEntities ) {
        i = -1;
        for ( const entity of self.isolatedAPI.contexts.entities ) {
            i = self.isolatedAPI.binarySearch(hostnames, entity, i);
            if ( i >= 0 ) {
                exceptions[i].split('\n').forEach(a => exceptionSet.add(a));
            } else {
                i = ~i + 1;
            }
        }
    }
}
genericDetails.length = 0;

/******************************************************************************/

// Start applying generic cosmetic filters

pendingNodes.add(document.documentElement);
uBOL_processNodes();

let domMutationObserver = new MutationObserver(uBOL_processChanges);
domMutationObserver.observe(document, {
    attributeFilter: [ 'class', 'id' ],
    attributes: true,
    childList: true,
    subtree: true,
});

const needDomChangeObserver = ( ) => {
    domChangeTimer = undefined;
    if ( domMutationObserver === undefined ) { return; }
    if ( (Date.now() - lastDomChange) > 30000 ) {
        return stopAll('no more DOM changes');
    }
    domChangeTimer = self.setTimeout(needDomChangeObserver, 30000);
};

needDomChangeObserver();

self.TalonCssGenericController = { stop: stopAll };

/******************************************************************************/

return initialReady;
})();

self.TalonCssGenericInitialReady.catch(() => {});
self.TalonCssGenericReadySet ||= new Set();
self.TalonCssGenericReadySet.add(self.TalonCssGenericInitialReady);
self.TalonCssGenericInitialReady.finally(() => {
    self.TalonCssGenericReadySet.delete(self.TalonCssGenericInitialReady);
}).catch(() => {});
self.TalonCssGenericInitialReady;

/******************************************************************************/
