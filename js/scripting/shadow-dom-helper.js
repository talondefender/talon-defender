/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_shadowDomHelper() {

if ( self.TalonShadowRootController ) {
    self.TalonShadowRootController.start?.();
    return;
}

const ROOTS_CHANGED_EVENT = 'talon-shadow-roots-changed';
const CONTENT_CHANGED_EVENT = 'talon-shadow-content-changed';
const RESCAN_DELAY_MS = 120;
const POST_LOAD_RESCAN_DELAYS_MS = [ 1000 ];

const getOpenOrClosedShadowRoot = (( ) => {
    const browserApi = self.browser?.dom;
    if ( typeof browserApi?.openOrClosedShadowRoot === 'function' ) {
        return browserApi.openOrClosedShadowRoot.bind(browserApi);
    }
    const chromeApi = self.chrome?.dom;
    if ( typeof chromeApi?.openOrClosedShadowRoot === 'function' ) {
        return chromeApi.openOrClosedShadowRoot.bind(chromeApi);
    }
    return node => {
        if ( node instanceof Element === false ) { return null; }
        return node.openOrClosedShadowRoot || node.shadowRoot || null;
    };
})();

let knownRoots = [];
const rootHosts = new Map();
let rescanTimer;
let scanTimer;
let observerConnected = false;
let active = true;
const observedRoots = new Set();
const postLoadTimers = new Set();
let pendingAddedNodes = [];
let pendingRemovedNodes = [];
let pendingFullRescan = false;
const MAX_PENDING_MUTATION_NODES = 512;
const MAX_CONTENT_EVENT_NODES = 128;
let budgetedFullScan;
let budgetedAddedScan;
const FULL_SCAN_TIME_SLICE_MS = 4;
const FULL_SCAN_NODE_SLICE = 256;
const monotonicNow = typeof self.performance?.now === 'function'
    ? self.performance.now.bind(self.performance)
    : Date.now;
const cooperativeScheduler = self.TalonCooperativeScheduler;
const scheduleCooperativeTask = callback => {
    if ( typeof cooperativeScheduler?.schedule === 'function' ) {
        return cooperativeScheduler.schedule(callback);
    }
    if ( typeof self.requestAnimationFrame === 'function' ) {
        return self.requestAnimationFrame(() => callback(
            monotonicNow() + FULL_SCAN_TIME_SLICE_MS
        ));
    }
    return self.setTimeout(() => callback(
        monotonicNow() + FULL_SCAN_TIME_SLICE_MS
    ), 0);
};
const cancelCooperativeTask = task => {
    if ( task === undefined ) { return; }
    if ( typeof cooperativeScheduler?.cancel === 'function' ) {
        cooperativeScheduler.cancel(task);
        return;
    }
    if ( typeof self.cancelAnimationFrame === 'function' ) {
        self.cancelAnimationFrame(task);
        return;
    }
    self.clearTimeout(task);
};
const cooperativeDeadline = deadline => Number.isFinite(deadline)
    ? deadline
    : monotonicNow() + FULL_SCAN_TIME_SLICE_MS;

const queuePendingMutationNode = (nodes, node) => {
    if ( pendingFullRescan ) { return false; }
    if (
        (pendingAddedNodes.length + pendingRemovedNodes.length) >=
        MAX_PENDING_MUTATION_NODES
    ) {
        pendingAddedNodes = [];
        pendingRemovedNodes = [];
        pendingFullRescan = true;
        return false;
    }
    nodes.push(node);
    return true;
};

const rootsEqual = (left, right) => {
    if ( left.length !== right.length ) { return false; }
    for ( let i = 0; i < left.length; i++ ) {
        if ( left[i] !== right[i] ) { return false; }
    }
    return true;
};

const dispatchRootsChanged = (roots, addedRoots = [], removedRoots = []) => {
    const detail = {
        roots: roots.slice(),
        addedRoots: addedRoots.slice(),
        removedRoots: removedRoots.slice(),
    };
    try {
        if ( typeof self.CustomEvent === 'function' ) {
            self.dispatchEvent?.(new self.CustomEvent(ROOTS_CHANGED_EVENT, { detail }));
            return;
        }
    } catch {
    }
    try {
        self.dispatchEvent?.({ type: ROOTS_CHANGED_EVENT, detail });
    } catch {
    }
};

const dispatchContentChanged = (
    roots,
    addedNodes,
    removedNodes = [],
    overflowed = false
) => {
    if (
        overflowed === false &&
        (
            roots.length === 0 ||
            (addedNodes.length === 0 && removedNodes.length === 0)
        )
    ) {
        return;
    }
    const detail = {
        roots: roots.slice(),
        addedNodes: addedNodes.slice(),
        removedNodes: removedNodes.slice(),
        overflowed: overflowed === true,
    };
    try {
        if ( typeof self.CustomEvent === 'function' ) {
            self.dispatchEvent?.(new self.CustomEvent(CONTENT_CHANGED_EVENT, { detail }));
            return;
        }
    } catch {
    }
    try {
        self.dispatchEvent?.({ type: CONTENT_CHANGED_EVENT, detail });
    } catch {
    }
};

const observeDocument = () => {
    if ( active === false || observerConnected ) { return; }
    try {
        shadowMutationObserver.observe(document, {
            childList: true,
            subtree: true,
        });
        observerConnected = true;
    } catch {
        observerConnected = false;
    }
};

const syncObservers = roots => {
    const shouldReconnect =
        observerConnected === false ||
        Array.from(observedRoots).some(root => roots.includes(root) === false);
    if ( shouldReconnect ) {
        try {
            shadowMutationObserver.disconnect();
        } catch {
        }
        observedRoots.clear();
        observerConnected = false;
    }
    observeDocument();
    for ( const root of roots ) {
        if ( root instanceof DocumentFragment === false ) { continue; }
        if ( observedRoots.has(root) ) { continue; }
        try {
            shadowMutationObserver.observe(root, {
                childList: true,
                subtree: true,
            });
            observedRoots.add(root);
        } catch {
        }
    }
};

const scanTree = (root, out, seenRoots) => {
    if ( root === null ) { return; }
    let walker;
    try {
        walker = document.createTreeWalker(
            root,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
    } catch {
        return;
    }
    while ( walker.nextNode() ) {
        const node = walker.currentNode;
        if ( node instanceof Element === false ) { continue; }
        let shadowRoot = null;
        try {
            shadowRoot = getOpenOrClosedShadowRoot(node);
        } catch {
            shadowRoot = null;
        }
        if ( shadowRoot instanceof DocumentFragment === false ) { continue; }
        if ( seenRoots.has(shadowRoot) ) { continue; }
        seenRoots.add(shadowRoot);
        rootHosts.set(shadowRoot, node);
        out.push(shadowRoot);
        scanTree(shadowRoot, out, seenRoots);
    }
};

const applyKnownRoots = nextRoots => {
    if ( rootsEqual(knownRoots, nextRoots) ) {
        syncObservers(knownRoots);
        return false;
    }
    const previousRoots = knownRoots;
    const previousSet = new Set(previousRoots);
    const nextSet = new Set(nextRoots);
    const addedRoots = nextRoots.filter(root => previousSet.has(root) === false);
    const removedRoots = previousRoots.filter(root => nextSet.has(root) === false);
    for ( const root of knownRoots ) {
        if ( nextSet.has(root) ) { continue; }
        rootHosts.delete(root);
    }
    knownRoots = nextRoots;
    syncObservers(knownRoots);
    dispatchRootsChanged(knownRoots, addedRoots, removedRoots);
    return true;
};

const continueBudgetedFullScan = deadline => {
    scanTimer = undefined;
    const state = budgetedFullScan;
    if ( state === undefined || active === false ) { return; }
    deadline = cooperativeDeadline(deadline);
    let scanned = 0;
    while (
        state.walkers.length !== 0 &&
        scanned < FULL_SCAN_NODE_SLICE &&
        monotonicNow() < deadline
    ) {
        const walker = state.walkers.at(-1);
        if ( walker.nextNode() === false ) {
            state.walkers.pop();
            continue;
        }
        scanned += 1;
        const node = walker.currentNode;
        if ( node instanceof Element === false ) { continue; }
        let shadowRoot;
        try { shadowRoot = getOpenOrClosedShadowRoot(node); } catch {
            shadowRoot = null;
        }
        if (
            shadowRoot instanceof DocumentFragment === false ||
            state.seenRoots.has(shadowRoot)
        ) {
            continue;
        }
        state.seenRoots.add(shadowRoot);
        state.nextRoots.push(shadowRoot);
        rootHosts.set(shadowRoot, node);
        try {
            state.walkers.push(document.createTreeWalker(
                shadowRoot,
                self.NodeFilter?.SHOW_ELEMENT || 1
            ));
        } catch {
        }
    }
    if ( state.walkers.length !== 0 ) {
        scanTimer = scheduleCooperativeTask(continueBudgetedFullScan);
        return;
    }
    budgetedFullScan = undefined;
    applyKnownRoots(state.nextRoots);
    if (
        pendingFullRescan ||
        pendingAddedNodes.length !== 0 ||
        pendingRemovedNodes.length !== 0
    ) {
        scheduleRescan(0);
    }
};

const startBudgetedFullScan = () => {
    if ( budgetedFullScan !== undefined || budgetedAddedScan !== undefined ) { return; }
    let walker;
    try {
        walker = document.createTreeWalker(
            document,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
    } catch {
        return;
    }
    budgetedFullScan = {
        walkers: [ walker ],
        nextRoots: [],
        seenRoots: new Set(),
    };
    scanTimer = scheduleCooperativeTask(continueBudgetedFullScan);
};

const continueBudgetedAddedScan = deadline => {
    scanTimer = undefined;
    const state = budgetedAddedScan;
    if ( state === undefined || active === false ) { return; }
    deadline = cooperativeDeadline(deadline);
    let scanned = 0;
    while (
        (state.walkers.length !== 0 || state.rootIndex < state.roots.length) &&
        scanned < FULL_SCAN_NODE_SLICE &&
        monotonicNow() < deadline
    ) {
        let node;
        if ( state.walkers.length !== 0 ) {
            const walker = state.walkers.at(-1);
            if ( walker.nextNode() === false ) {
                state.walkers.pop();
                continue;
            }
            node = walker.currentNode;
        } else {
            const root = state.roots[state.rootIndex++];
            if (
                (root instanceof Element === false &&
                    root instanceof DocumentFragment === false) ||
                state.seenScanRoots.has(root)
            ) {
                continue;
            }
            state.seenScanRoots.add(root);
            if (
                (root instanceof Element && root.isConnected === false) ||
                (root instanceof DocumentFragment &&
                    root.host instanceof Element &&
                    root.host.isConnected === false)
            ) {
                continue;
            }
            try {
                state.walkers.push(document.createTreeWalker(
                    root,
                    self.NodeFilter?.SHOW_ELEMENT || 1
                ));
            } catch {
            }
            if ( root instanceof Element ) {
                node = root;
            } else {
                continue;
            }
        }
        if ( node instanceof Element === false || state.seenElements.has(node) ) {
            continue;
        }
        state.seenElements.add(node);
        scanned += 1;
        let shadowRoot;
        try { shadowRoot = getOpenOrClosedShadowRoot(node); } catch {
            shadowRoot = null;
        }
        if (
            shadowRoot instanceof DocumentFragment === false ||
            state.seenRoots.has(shadowRoot)
        ) {
            continue;
        }
        state.seenRoots.add(shadowRoot);
        state.nextRoots.push(shadowRoot);
        rootHosts.set(shadowRoot, node);
        try {
            state.walkers.push(document.createTreeWalker(
                shadowRoot,
                self.NodeFilter?.SHOW_ELEMENT || 1
            ));
        } catch {
        }
    }
    if ( state.walkers.length !== 0 || state.rootIndex < state.roots.length ) {
        scanTimer = scheduleCooperativeTask(continueBudgetedAddedScan);
        return;
    }
    budgetedAddedScan = undefined;
    applyKnownRoots(state.nextRoots);
    if (
        pendingFullRescan ||
        pendingAddedNodes.length !== 0 ||
        pendingRemovedNodes.length !== 0
    ) {
        scheduleRescan(0);
    }
};

const startBudgetedAddedScan = roots => {
    if (
        budgetedAddedScan !== undefined ||
        budgetedFullScan !== undefined ||
        Array.isArray(roots) === false ||
        roots.length === 0
    ) {
        return false;
    }
    budgetedAddedScan = {
        roots: roots.slice(0, MAX_PENDING_MUTATION_NODES),
        rootIndex: 0,
        walkers: [],
        nextRoots: knownRoots.slice(),
        seenRoots: new Set(knownRoots),
        seenElements: new WeakSet(),
        seenScanRoots: new WeakSet(),
    };
    scanTimer = scheduleCooperativeTask(continueBudgetedAddedScan);
    return true;
};

const rescanNow = ( ) => {
    if ( rescanTimer !== undefined ) {
        try { clearTimeout(rescanTimer); } catch { }
        rescanTimer = undefined;
    }
    if ( scanTimer !== undefined ) {
        try { cancelCooperativeTask(scanTimer); } catch { }
        scanTimer = undefined;
    }
    pendingAddedNodes = [];
    pendingRemovedNodes = [];
    pendingFullRescan = false;
    budgetedFullScan = undefined;
    budgetedAddedScan = undefined;
    const nextRoots = [];
    const seenRoots = new Set();
    scanTree(document, nextRoots, seenRoots);
    applyKnownRoots(nextRoots);
    return knownRoots.slice();
};

const isWithinRemovedTree = (node, removedNode) => {
    let current = node;
    while ( current ) {
        if ( current === removedNode ) { return true; }
        current = current.parentNode || current.host || null;
    }
    return false;
};

const pruneRemovedRoots = removedNodes => {
    if ( removedNodes.length === 0 || knownRoots.length === 0 ) { return false; }
    const nextRoots = knownRoots.filter(root => {
        const host = rootHosts.get(root) || root.host;
        if ( host === undefined || host === null ) { return true; }
        return removedNodes.some(node => isWithinRemovedTree(host, node)) === false;
    });
    return applyKnownRoots(nextRoots);
};

const resumeBudgetedScan = () => {
    if ( budgetedFullScan !== undefined ) {
        if ( scanTimer === undefined ) {
            scanTimer = scheduleCooperativeTask(continueBudgetedFullScan);
        }
        return true;
    }
    if ( budgetedAddedScan !== undefined ) {
        if ( scanTimer === undefined ) {
            scanTimer = scheduleCooperativeTask(continueBudgetedAddedScan);
        }
        return true;
    }
    return false;
};

const flushPendingRescan = () => {
    rescanTimer = undefined;
    if ( pendingFullRescan ) {
        if ( resumeBudgetedScan() ) { return; }
        pendingFullRescan = false;
        startBudgetedFullScan();
        return;
    }
    // A budgeted scan owns the authoritative root snapshot until it completes.
    // Keep mutations queued so an incremental pass can reconcile anything
    // inserted behind the current TreeWalker position.
    if ( resumeBudgetedScan() ) { return; }
    const addedNodes = pendingAddedNodes.slice();
    pendingAddedNodes = [];
    const removedNodes = pendingRemovedNodes.slice();
    pendingRemovedNodes = [];
    const changed = pruneRemovedRoots(removedNodes);
    if ( startBudgetedAddedScan(addedNodes) === false && changed === false ) {
        syncObservers(knownRoots);
    }
};

const scheduleRescan = (delay = RESCAN_DELAY_MS) => {
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : RESCAN_DELAY_MS;
    if ( rescanTimer !== undefined ) {
        if ( wait !== 0 ) { return; }
        try { clearTimeout(rescanTimer); } catch { }
    }
    rescanTimer = self.setTimeout(flushPendingRescan, wait);
};

const schedulePostLoadRescans = ( ) => {
    if ( postLoadTimers.size !== 0 ) { return; }
    for ( const delay of POST_LOAD_RESCAN_DELAYS_MS ) {
        const timer = self.setTimeout(( ) => {
            postLoadTimers.delete(timer);
            pendingFullRescan = true;
            scheduleRescan(0);
        }, delay);
        postLoadTimers.add(timer);
    }
};

const observedRootForMutationTarget = target => {
    let current = target;
    while ( current ) {
        if ( observedRoots.has(current) ) { return current; }
        current = current.parentNode || current.host || null;
    }
    return null;
};

const shadowMutationObserver = new MutationObserver(mutations => {
    const changedRoots = new Set();
    const contentAddedNodes = [];
    const contentRemovedNodes = [];
    let overflowed = false;
    let contentOverflowed = false;
    for ( const mutation of mutations ) {
        const changedRoot = observedRootForMutationTarget(mutation.target);
        if (
            changedRoot !== null &&
            (mutation.addedNodes?.length || mutation.removedNodes?.length)
        ) {
            changedRoots.add(changedRoot);
        }
        if ( mutation.removedNodes?.length ) {
            for ( const node of mutation.removedNodes ) {
                if ( queuePendingMutationNode(pendingRemovedNodes, node) === false ) {
                    overflowed = true;
                    break;
                }
                if (
                    changedRoot !== null &&
                    contentRemovedNodes.length < MAX_CONTENT_EVENT_NODES
                ) {
                    contentRemovedNodes.push(node);
                } else if ( changedRoot !== null ) {
                    contentOverflowed = true;
                }
            }
        }
        if ( overflowed ) { break; }
        for ( const node of mutation.addedNodes || [] ) {
            if ( queuePendingMutationNode(pendingAddedNodes, node) === false ) {
                overflowed = true;
                break;
            }
            if (
                changedRoot !== null &&
                contentAddedNodes.length < MAX_CONTENT_EVENT_NODES
            ) {
                contentAddedNodes.push(node);
            } else if ( changedRoot !== null ) {
                contentOverflowed = true;
            }
        }
        if ( overflowed ) { break; }
    }
    dispatchContentChanged(
        Array.from(changedRoots),
        contentAddedNodes,
        contentRemovedNodes,
        overflowed || contentOverflowed
    );
    scheduleRescan();
});

const onDomContentLoaded = () => {
    schedulePostLoadRescans();
};

const onLoad = () => {
    schedulePostLoadRescans();
};

const stop = () => {
    active = false;
    try { shadowMutationObserver.disconnect(); } catch {
    }
    observerConnected = false;
    observedRoots.clear();
    if ( rescanTimer !== undefined ) {
        try { clearTimeout(rescanTimer); } catch {
        }
        rescanTimer = undefined;
    }
    if ( scanTimer !== undefined ) {
        try { cancelCooperativeTask(scanTimer); } catch {
        }
        scanTimer = undefined;
    }
    for ( const timer of postLoadTimers ) {
        try { clearTimeout(timer); } catch {
        }
    }
    postLoadTimers.clear();
    pendingAddedNodes = [];
    pendingRemovedNodes = [];
    pendingFullRescan = false;
    budgetedFullScan = undefined;
    budgetedAddedScan = undefined;
    knownRoots = [];
    rootHosts.clear();
    document.removeEventListener?.('DOMContentLoaded', onDomContentLoaded);
    self.removeEventListener?.('load', onLoad);
};

const attachLifecycleListeners = () => {
    if ( document.readyState === 'loading' ) {
        document.addEventListener('DOMContentLoaded', onDomContentLoaded, { once: true });
    } else {
        schedulePostLoadRescans();
    }
    self.addEventListener?.('load', onLoad, { once: true });
    if ( document.readyState === 'complete' ) {
        schedulePostLoadRescans();
    }
};

const start = () => {
    if ( active ) { return knownRoots.slice(); }
    active = true;
    observeDocument();
    syncObservers(knownRoots);
    attachLifecycleListeners();
    startBudgetedFullScan();
    return knownRoots.slice();
};

self.TalonShadowRootController = {
    ROOTS_CHANGED_EVENT,
    CONTENT_CHANGED_EVENT,
    enumerateRoots() {
        return knownRoots.slice();
    },
    rescanNow,
    scheduleRescan,
    start,
    stop,
};

observeDocument();
attachLifecycleListeners();

pendingFullRescan = true;
scheduleRescan(0);

})();

void 0;
