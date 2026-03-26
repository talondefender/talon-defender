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

const syncObservers = roots => {
    shadowMutationObserver.disconnect();
    observedRoots.clear();

    try {
        shadowMutationObserver.observe(document, {
            childList: true,
            subtree: true,
        });
        observerConnected = true;
    } catch {
        observerConnected = false;
    }

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

const rescanNow = ( ) => {
    if ( rescanTimer !== undefined ) {
        try { clearTimeout(rescanTimer); } catch { }
        rescanTimer = undefined;
    }

    const nextRoots = [];
    const seenRoots = new Set();
    scanTree(document, nextRoots, seenRoots);

    if ( rootsEqual(knownRoots, nextRoots) ) {
        syncObservers(knownRoots);
        return knownRoots.slice();
    }

    knownRoots = nextRoots;
    syncObservers(knownRoots);
    dispatchRootsChanged(knownRoots);
    return knownRoots.slice();
};

const scheduleRescan = (delay = RESCAN_DELAY_MS) => {
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : RESCAN_DELAY_MS;
    if ( rescanTimer !== undefined ) {
        if ( wait !== 0 ) { return; }
        try { clearTimeout(rescanTimer); } catch { }
    }
    rescanTimer = self.setTimeout(( ) => {
        rescanTimer = undefined;
        rescanNow();
    }, wait);
};

const schedulePostLoadRescans = ( ) => {
    if ( postLoadTimers.size !== 0 ) { return; }
    for ( const delay of POST_LOAD_RESCAN_DELAYS_MS ) {
        const timer = self.setTimeout(( ) => {
            postLoadTimers.delete(timer);
            scheduleRescan(0);
        }, delay);
        postLoadTimers.add(timer);
    }
};

const shadowMutationObserver = new MutationObserver(( ) => {
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

if ( document.readyState === 'loading' ) {
    document.addEventListener('DOMContentLoaded', () => {
        scheduleRescan(0);
    }, { once: true });
} else {
    scheduleRescan(0);
}

self.addEventListener?.('load', () => {
    scheduleRescan(0);
    schedulePostLoadRescans();
}, { once: true });

if ( document.readyState === 'complete' ) {
    schedulePostLoadRescans();
}

rescanNow();

})();

void 0;
