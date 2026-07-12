/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_blockHints() {

const HINT_ATTR = 'data-talon-block-hint';
const HINTS_CHANGED_EVENT = 'talon-block-hints-changed';
const ELEMENT_TTL_MS = 5000;
const NETWORK_TTL_MS = 5000;
const MAX_TRACKED_ELEMENTS = 96;
const MAX_SELECTOR_MATCHES = 24;
const MAX_HINT_SELECTORS = 128;

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

const notifyHintsChanged = count => {
    if ( count === 0 ) { return; }
    try {
        self.dispatchEvent?.(new CustomEvent(HINTS_CHANGED_EVENT, {
            detail: { count },
        }));
    } catch {
    }
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
        notify = true,
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
        if ( notify ) {
            notifyHintsChanged(count);
        }
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
    const selectorText = selectors
        .filter(selector => typeof selector === 'string' && selector !== '')
        .slice(0, MAX_HINT_SELECTORS)
        .join(',');
    if ( selectorText === '' ) { return 0; }
    const seen = new Set();
    let matched = 0;
    for ( const root of enumerateQueryRoots() ) {
        if ( matched >= maxMatches ) { break; }
        let nodes = [];
        try {
            // Run one selector-list query per root instead of traversing the
            // same document once for every remotely supplied selector.
            nodes = root.querySelectorAll?.(selectorText) || [];
        } catch {
            nodes = [];
        }
        for ( const node of nodes ) {
            if ( node instanceof Element === false || seen.has(node) ) { continue; }
            seen.add(node);
            noteElement(node, { ancestors, notify: false });
            matched += 1;
            if ( matched >= maxMatches ) { break; }
        }
    }
    notifyHintsChanged(matched);
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
        // trackedElements is hard-capped, so containment checks avoid an
        // unbounded selector walk through a newly inserted large subtree.
        for ( const hinted of trackedElements ) {
            if ( hinted instanceof Element === false ) { continue; }
            if ( hasActiveHintAttr(hinted, now) === false ) { continue; }
            try {
                if ( el.contains(hinted) ) { return true; }
            } catch {
            }
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
    notifyHintsChanged(1);
    return true;
};

const hasRecentNetworkHit = ( ) => networkHitUntil > Date.now();

const getRecentElements = ( ) => {
    scheduleCleanup();
    const now = Date.now();
    return trackedElements.filter(el =>
        el instanceof Element &&
        el.isConnected !== false &&
        hasActiveHintAttr(el, now)
    );
};

self.TalonBlockHintsController = {
    HINT_ATTR,
    HINTS_CHANGED_EVENT,
    noteElement,
    noteSelectorMatches,
    noteNetworkHit,
    hasRecentHint,
    hasRecentNetworkHit,
    getRecentElements,
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
