/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_blockHints() {

const HINT_ATTR = 'data-talon-block-hint';
const ELEMENT_TTL_MS = 5000;
const NETWORK_TTL_MS = 5000;
const MAX_TRACKED_ELEMENTS = 96;
const MAX_SELECTOR_MATCHES = 24;

if ( self.TalonBlockHintsController ) { return; }

const shadowController = self.TalonShadowRootController;

let trackedElements = [];
let cleanupTimer = 0;
let networkHitUntil = 0;

const clearCleanupTimer = ( ) => {
    if ( cleanupTimer === 0 ) { return; }
    self.clearTimeout(cleanupTimer);
    cleanupTimer = 0;
};

const getHintExpiry = el => {
    if ( el instanceof Element === false ) { return 0; }
    return Number(el.getAttribute(HINT_ATTR)) || 0;
};

const hasActiveHintAttr = (el, now = Date.now()) => {
    const expiresAt = getHintExpiry(el);
    if ( expiresAt <= now ) {
        if ( expiresAt !== 0 ) {
            try { el.removeAttribute(HINT_ATTR); } catch {
            }
        }
        return false;
    }
    return true;
};

const rememberElement = el => {
    if ( el instanceof Element === false ) { return; }
    trackedElements = trackedElements.filter(entry => entry !== el);
    trackedElements.push(el);
    while ( trackedElements.length > MAX_TRACKED_ELEMENTS ) {
        const removed = trackedElements.shift();
        if ( removed instanceof Element === false ) { continue; }
        try { removed.removeAttribute(HINT_ATTR); } catch {
        }
    }
};

const scheduleCleanup = ( ) => {
    clearCleanupTimer();
    const now = Date.now();
    let nextExpiry = networkHitUntil > now ? networkHitUntil : 0;
    trackedElements = trackedElements.filter(el => {
        if ( el instanceof Element === false || el.isConnected === false ) {
            try { el?.removeAttribute?.(HINT_ATTR); } catch {
            }
            return false;
        }
        const expiresAt = getHintExpiry(el);
        if ( expiresAt <= now ) {
            try { el.removeAttribute(HINT_ATTR); } catch {
            }
            return false;
        }
        if ( nextExpiry === 0 || expiresAt < nextExpiry ) {
            nextExpiry = expiresAt;
        }
        return true;
    });
    if ( nextExpiry === 0 ) { return; }
    cleanupTimer = self.setTimeout(() => {
        cleanupTimer = 0;
        scheduleCleanup();
    }, Math.max(50, nextExpiry - now));
};

const getNextHintTarget = current => {
    if ( current instanceof Element === false ) { return null; }
    const root = current.getRootNode?.();
    if ( root?.host instanceof Element ) { return root.host; }
    return current.parentElement || null;
};

const noteElement = (
    el,
    {
        ancestors = 1,
    } = {}
) => {
    if ( el instanceof Element === false ) { return 0; }
    const expiresAt = Date.now() + ELEMENT_TTL_MS;
    let count = 0;
    let current = el;
    for ( let depth = 0; current instanceof Element && depth <= ancestors; depth += 1 ) {
        if ( current === document.body || current === document.documentElement ) { break; }
        try {
            current.setAttribute(HINT_ATTR, String(expiresAt));
            rememberElement(current);
            count += 1;
        } catch {
        }
        current = getNextHintTarget(current);
    }
    if ( count !== 0 ) {
        scheduleCleanup();
    }
    return count;
};

const enumerateQueryRoots = ( ) => {
    const roots = [ document ];
    for ( const root of shadowController?.enumerateRoots?.() || [] ) {
        if ( root instanceof DocumentFragment === false ) { continue; }
        roots.push(root);
    }
    return roots;
};

const noteSelectorMatches = (
    selectors,
    {
        ancestors = 1,
        maxMatches = MAX_SELECTOR_MATCHES,
    } = {}
) => {
    if ( Array.isArray(selectors) === false || selectors.length === 0 ) { return 0; }
    const seen = new Set();
    let matched = 0;
    for ( const selector of selectors ) {
        if ( typeof selector !== 'string' || selector === '' || matched >= maxMatches ) { continue; }
        for ( const root of enumerateQueryRoots() ) {
            if ( matched >= maxMatches ) { break; }
            let nodes = [];
            try {
                nodes = root.querySelectorAll?.(selector) || [];
            } catch {
                nodes = [];
            }
            for ( const node of nodes ) {
                if ( node instanceof Element === false || seen.has(node) ) { continue; }
                seen.add(node);
                noteElement(node, { ancestors });
                matched += 1;
                if ( matched >= maxMatches ) { break; }
            }
        }
    }
    return matched;
};

const hasRecentHint = (
    el,
    {
        includeSubtree = false,
    } = {}
) => {
    if ( el instanceof Element === false ) { return false; }
    const now = Date.now();
    if ( hasActiveHintAttr(el, now) ) { return true; }
    if ( includeSubtree ) {
        try {
            const hinted = el.querySelector?.(`[${HINT_ATTR}]`);
            if ( hinted instanceof Element && hasActiveHintAttr(hinted, now) ) {
                return true;
            }
        } catch {
        }
    }
    let current = getNextHintTarget(el);
    for ( let depth = 0; current instanceof Element && depth < 2; depth += 1 ) {
        if ( hasActiveHintAttr(current, now) ) { return true; }
        current = getNextHintTarget(current);
    }
    return false;
};

const noteNetworkHit = ( ) => {
    networkHitUntil = Date.now() + NETWORK_TTL_MS;
    scheduleCleanup();
    return true;
};

const hasRecentNetworkHit = ( ) => networkHitUntil > Date.now();

self.TalonBlockHintsController = {
    noteElement,
    noteSelectorMatches,
    noteNetworkHit,
    hasRecentHint,
    hasRecentNetworkHit,
    stop() {
        clearCleanupTimer();
        networkHitUntil = 0;
        for ( const el of trackedElements ) {
            if ( el instanceof Element === false ) { continue; }
            try { el.removeAttribute(HINT_ATTR); } catch {
            }
        }
        trackedElements = [];
        return Promise.resolve(true);
    },
};

})();

void 0;
