/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_shadowDomHelper() {

if ( self.TalonShadowRootController ) { return; }

const ROOTS_CHANGED_EVENT = 'talon-shadow-roots-changed';
const RESCAN_DELAY_MS = 120;
const POST_LOAD_RESCAN_DELAYS_MS = [ 250, 1000, 2500 ];

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
let rescanTimer;
let observerConnected = false;
const observedRoots = new Set();
const postLoadTimers = new Set();
let pendingAddedNodes = [];
let pendingFullRescan = false;

const rootsEqual = (left, right) => {
    if ( left.length !== right.length ) { return false; }
    for ( let i = 0; i < left.length; i++ ) {
        if ( left[i] !== right[i] ) { return false; }
    }
    return true;
};

const dispatchRootsChanged = roots => {
    const detail = { roots: roots.slice() };
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

const observeDocument = () => {
    if ( observerConnected ) { return; }
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
        out.push(shadowRoot);
        scanTree(shadowRoot, out, seenRoots);
    }
};

const applyKnownRoots = nextRoots => {
    if ( rootsEqual(knownRoots, nextRoots) ) {
        syncObservers(knownRoots);
        return false;
    }
    knownRoots = nextRoots;
    syncObservers(knownRoots);
    dispatchRootsChanged(knownRoots);
    return true;
};

const rescanNow = ( ) => {
    if ( rescanTimer !== undefined ) {
        try { clearTimeout(rescanTimer); } catch { }
        rescanTimer = undefined;
    }
    pendingAddedNodes = [];
    pendingFullRescan = false;
    const nextRoots = [];
    const seenRoots = new Set();
    scanTree(document, nextRoots, seenRoots);
    applyKnownRoots(nextRoots);
    return knownRoots.slice();
};

const scanAddedNodeTree = node => {
    if ( node instanceof Element === false && node instanceof DocumentFragment === false ) {
        return false;
    }
    const nextRoots = knownRoots.slice();
    const seenRoots = new Set(nextRoots);
    if ( node instanceof Element ) {
        try {
            const ownRoot = getOpenOrClosedShadowRoot(node);
            if ( ownRoot instanceof DocumentFragment && seenRoots.has(ownRoot) === false ) {
                seenRoots.add(ownRoot);
                nextRoots.push(ownRoot);
                scanTree(ownRoot, nextRoots, seenRoots);
            }
        } catch {
        }
    }
    scanTree(node, nextRoots, seenRoots);
    return applyKnownRoots(nextRoots);
};

const flushPendingRescan = () => {
    rescanTimer = undefined;
    if ( pendingFullRescan ) {
        rescanNow();
        return;
    }
    const addedNodes = pendingAddedNodes.slice();
    pendingAddedNodes = [];
    let changed = false;
    for ( const node of addedNodes ) {
        changed = scanAddedNodeTree(node) || changed;
    }
    if ( changed === false ) {
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

const shadowMutationObserver = new MutationObserver(mutations => {
    for ( const mutation of mutations ) {
        if ( mutation.removedNodes?.length ) {
            pendingFullRescan = true;
        }
        if ( pendingFullRescan ) { continue; }
        for ( const node of mutation.addedNodes || [] ) {
            pendingAddedNodes.push(node);
        }
    }
    scheduleRescan();
});

self.TalonShadowRootController = {
    ROOTS_CHANGED_EVENT,
    enumerateRoots() {
        return knownRoots.slice();
    },
    rescanNow,
    scheduleRescan,
};

observeDocument();

if ( document.readyState === 'loading' ) {
    document.addEventListener('DOMContentLoaded', () => {
        pendingFullRescan = true;
        scheduleRescan(0);
    }, { once: true });
} else {
    pendingFullRescan = true;
    scheduleRescan(0);
}

self.addEventListener?.('load', () => {
    pendingFullRescan = true;
    scheduleRescan(0);
    schedulePostLoadRescans();
}, { once: true });

if ( document.readyState === 'complete' ) {
    schedulePostLoadRescans();
}

rescanNow();

})();

void 0;
