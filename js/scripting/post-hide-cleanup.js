/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_postHideCleanup() {

const runtime = self.browser?.runtime || self.chrome?.runtime;
const guard = self.TalonBreakageGuard;
const shadowController = self.TalonShadowRootController;
const blockHints = self.TalonBlockHintsController;
const shadowRootsChangedEvent =
    shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
const blockHintsChangedEvent =
    blockHints?.HINTS_CHANGED_EVENT || 'talon-block-hints-changed';
if ( runtime === undefined ) { return; }

if ( self.TalonPostHideCleanupController ) {
    self.TalonPostHideCleanupController.refresh().catch(( ) => {});
    return;
}

const hostname = (self.location?.hostname || '').toLowerCase();
if ( hostname === '' ) { return; }

const isVisible = el => {
    if ( el instanceof Element === false ) { return false; }
    const style = self.getComputedStyle(el);
    if ( style.display === 'none' ) { return false; }
    if ( style.visibility === 'hidden' ) { return false; }
    if ( Number(style.opacity) === 0 ) { return false; }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
};

const COMMON_AD_SIZES = [
    [ 300, 250 ],
    [ 300, 600 ],
    [ 160, 600 ],
    [ 120, 600 ],
    [ 728, 90 ],
    [ 970, 250 ],
    [ 970, 90 ],
    [ 320, 50 ],
    [ 320, 100 ],
    [ 336, 280 ],
    [ 468, 60 ],
    [ 234, 60 ],
    [ 250, 250 ],
    [ 200, 200 ],
    [ 300, 50 ],
    [ 300, 100 ],
];
const AD_SIZE_TOLERANCE_PX = 4;

const isStandardAdSize = rect => {
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    for ( const [ aw, ah ] of COMMON_AD_SIZES ) {
        if (
            Math.abs(w - aw) <= AD_SIZE_TOLERANCE_PX &&
            Math.abs(h - ah) <= AD_SIZE_TOLERANCE_PX
        ) {
            return true;
        }
    }
    return false;
};

const attrHintRe = /\b(sponsor|sponsored|promoted|advert|advertisement|adchoices|outbrain|taboola|ad-slot|adslot|adsbygoogle|adunit|adserver|doubleclick|googlesyndication|prebid|criteo|native-ad|banner-ad|paid\s*post|paid\s*partner|partner\s*content|promo|dfp|gpt|admanager|adsense|revcontent|mgid|teads|adthrive|mediavine|adzerk|rubicon|openx|pubmatic|appnexus|adnxs|spotx|yieldlove|ezoic|container--ads|ads__slot|ads__title|freestar-ads|leaderboard|fs-sticky-footer)\b/i;
const trivialChromeRe = /\b(advertisement|adchoices|close|dismiss|collapse|skip\s*ad|remove\s*ad|x)\b/i;

const getHintParts = el => [
    el.id,
    el.className,
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('role') || '',
    el.getAttribute?.('data-ad') || '',
    el.getAttribute?.('data-ad-unit') || '',
    el.getAttribute?.('data-ad-slot') || '',
    el.getAttribute?.('data-ad-client') || '',
    el.textContent || '',
].join(' ');

const hasAdHint = el => attrHintRe.test(getHintParts(el));

const hasBlockHint = el =>
    blockHints?.hasRecentHint?.(el, { includeSubtree: true }) === true;

const isTrivialAdChrome = el => {
    if ( el instanceof Element === false ) { return false; }
    const rect = el.getBoundingClientRect();
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const hintParts = getHintParts(el);
    if ( /ads__close-button|close-button|banner_logo/i.test(hintParts) ) {
        return true;
    }
    if ( text !== '' && text.length <= 32 && trivialChromeRe.test(text) ) {
        return true;
    }
    if ( hasAdHint(el) && text === '' && el.children.length === 0 ) {
        return true;
    }
    if ( rect.width <= 64 && rect.height <= 40 && (text === '' || trivialChromeRe.test(text)) ) {
        return true;
    }
    return false;
};

const hasMeaningfulVisibleDescendant = (el, depth = 0) => {
    if ( el instanceof Element === false ) { return false; }
    if ( depth > 2 ) { return false; }
    const kids = el.children;
    for ( let i = 0; i < kids.length; i++ ) {
        const child = kids[i];
        if ( isVisible(child) === false ) { continue; }
        if ( isTrivialAdChrome(child) ) { continue; }
        if ( hasAdHint(child) && hasMeaningfulVisibleDescendant(child, depth + 1) === false ) {
            continue;
        }
        return true;
    }
    return false;
};

const shouldCollapse = container => {
    if ( container instanceof Element === false ) { return false; }
    if ( container === document.body || container === document.documentElement ) { return false; }
    if ( container.closest('nav,header,footer') ) { return false; }
    if ( container.dataset?.uBolCleanupCollapsed ) { return false; }
    if ( guard?.canMutateElement?.(container, {
        riskTier: guard?.RISK_TIERS?.medium || 2,
        source: 'post-hide-cleanup',
    })?.allowed === false ) {
        return false;
    }
    if ( guard?.isLikelyPrimaryContent?.(container) ) { return false; }

    const rect = container.getBoundingClientRect();
    if ( rect.width <= 0 || rect.height <= 0 ) { return false; }

    const adSized = isStandardAdSize(rect);
    const recentBlockHint = blockHints?.hasRecentHint?.(container, {
        includeSubtree: true,
    }) === true;
    const recentNetworkHit = blockHints?.hasRecentNetworkHit?.() === true;
    if ( adSized === false && (rect.height < 50 || rect.width < 100) ) {
        return false;
    }

    if (
        hasAdHint(container) === false &&
        adSized === false &&
        recentBlockHint === false &&
        recentNetworkHit === false
    ) {
        return false;
    }

    const kids = container.children;
    if ( kids.length > 24 ) { return false; }
    for ( let i = 0; i < kids.length; i++ ) {
        const child = kids[i];
        if ( isVisible(child) === false ) { continue; }
        if ( isTrivialAdChrome(child) ) { continue; }
        if ( hasAdHint(child) && hasMeaningfulVisibleDescendant(child) === false ) {
            continue;
        }
        return false;
    }

    return true;
};

const isOverlayLike = el => {
    try {
        const style = self.getComputedStyle(el);
        const pos = style.position;
        if ( pos !== 'fixed' && pos !== 'sticky' ) { return false; }
        const z = parseInt(style.zIndex, 10);
        return Number.isFinite(z) && z >= 1000;
    } catch {
    }
    return false;
};

const unlockScrollIfNeeded = ( ) => {
    let htmlOverflowHidden = false;
    let bodyOverflowHidden = false;
    let bodyFixed = false;

    const html = document.documentElement;
    const body = document.body;

    try {
        if ( html && self.getComputedStyle(html).overflow === 'hidden' ) {
            htmlOverflowHidden = true;
        }
    } catch {
    }

    try {
        if ( body ) {
            const style = self.getComputedStyle(body);
            bodyOverflowHidden = style.overflow === 'hidden';
            bodyFixed = style.position === 'fixed';
        }
    } catch {
    }

    if ( htmlOverflowHidden === false && bodyOverflowHidden === false && bodyFixed === false ) {
        return false;
    }

    try {
        if ( htmlOverflowHidden ) {
            html.style.setProperty('overflow', 'auto', 'important');
        }
    } catch {
    }

    let restoreY;
    if ( bodyFixed && body ) {
        try {
            const topValue = self.getComputedStyle(body).top;
            const topPx = parseInt(topValue, 10);
            if ( Number.isFinite(topPx) ) {
                restoreY = Math.abs(topPx);
            }
        } catch {
        }
    }

    try {
        if ( body && bodyOverflowHidden ) {
            body.style.setProperty('overflow', 'auto', 'important');
        }
        if ( body && bodyFixed ) {
            body.style.setProperty('position', 'static', 'important');
            body.style.setProperty('top', 'auto', 'important');
        }
    } catch {
    }

    if ( restoreY !== undefined ) {
        try { self.scrollTo(0, restoreY); } catch { }
    }

    return true;
};

const collapse = container => {
    if ( shouldCollapse(container) === false ) { return false; }
    try {
        container.style.setProperty('display', 'none', 'important');
        container.style.setProperty('visibility', 'hidden', 'important');
        container.dataset.uBolCleanupCollapsed = '1';
        if ( isOverlayLike(container) ) {
            unlockScrollIfNeeded();
        }
        blockHints?.noteElement?.(container, { ancestors: 1 });
        guard?.auditAfterMutation?.('post-hide-cleanup');
        return true;
    } catch {
    }
    return false;
};

const CANDIDATE_SELECTORS = [
    '[data-ad]',
    '[data-ad-unit]',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[data-advertisement]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    '.ad-slot',
    '.ad-slot-rail__container',
    '.container--ads',
    '.ads',
    '.ads__slot',
    '.ads__title',
    '.ads__close-button',
    '.freestar-ads',
    '.OUTBRAIN',
    '.ob-widget',
    '#taboola-below-article-thumbnails',
    'div[id^="taboola-"]',
    'div[class*="taboola" i]',
    '[id*="ad-slot" i]',
    '[class*="ad-slot" i]',
    '[id*="sponsor" i]',
    '[class*="sponsor" i]',
    '.native-ad',
    '[id*="native-ad" i]',
    '[class*="native-ad" i]',
    '[id*="advert" i]',
    '[class*="advert" i]',
    '[class*="leaderboard" i]',
    '[class*="container--ads" i]',
    '[class*="ads__" i]',
    '[id^="ad-"]',
    '[id^="ad_"]',
    '[class^="ad-"]',
    '[class^="ad_"]',
];
const selectorText = CANDIDATE_SELECTORS.join(',');
const HIDDEN_AD_SHELL_SELECTORS = [
    '.freestar-ads',
    '[class*="freestar" i]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    '.OUTBRAIN',
    '.ob-widget',
    '#taboola-below-article-thumbnails',
    'div[id^="taboola-"]',
    'div[class*="taboola" i]',
    '[id^="div-gpt-ad-"]',
    '[id^="google_ads_iframe_"]',
    'iframe[id^="google_ads_iframe_"]',
];
const hiddenAdShellSelectorText = HIDDEN_AD_SHELL_SELECTORS.join(',');
const collectionSelectorText = `${selectorText},${hiddenAdShellSelectorText}`;

let pending = [];
let seen = new WeakSet();
let pendingIndex = 0;

const enqueue = el => {
    if ( el instanceof Element === false ) { return; }
    if ( seen.has(el) ) { return; }
    seen.add(el);
    pending.push(el);
};

const isHiddenAdShellCandidate = el => {
    if ( el instanceof Element === false ) { return false; }
    try {
        return el.matches?.(hiddenAdShellSelectorText) === true;
    } catch {
    }
    return false;
};

const noteAdShellHint = el => {
    if ( el instanceof Element === false ) { return; }
    try {
        blockHints?.noteElement?.(el, { ancestors: 1 });
    } catch {
    }
};

const enqueueCandidate = node => {
    if ( node instanceof Element === false ) { return; }
    const nodeHasHint = hasBlockHint(node);
    const hiddenAdShell = isHiddenAdShellCandidate(node);
    if ( hiddenAdShell ) {
        noteAdShellHint(node);
    }
    if ( isVisible(node) || nodeHasHint || hiddenAdShell ) {
        enqueue(node);
    }
    if (
        node.parentElement &&
        (
            isVisible(node.parentElement) ||
            nodeHasHint ||
            hiddenAdShell ||
            hasBlockHint(node.parentElement)
        )
    ) {
        enqueue(node.parentElement);
    }
};

const collect = root => {
    let nodes = [];
    try {
        nodes = (root === document ? document : root).querySelectorAll(collectionSelectorText);
    } catch {
        nodes = [];
    }
    if ( root instanceof Element ) {
        try {
            if (
                root.matches?.(selectorText) ||
                isHiddenAdShellCandidate(root)
            ) {
                enqueueCandidate(root);
            }
        } catch {
        }
    }
    for ( const node of nodes ) {
        enqueueCandidate(node);
    }
};

const collectHintedElements = ( ) => {
    const hinted = blockHints?.getRecentElements?.() || [];
    for ( const node of hinted ) {
        if ( node instanceof Element === false ) { continue; }
        if ( isVisible(node) ) {
            enqueue(node);
        }
        if ( node.parentElement ) {
            enqueue(node.parentElement);
        }
    }
};

let processTimer;
const MAX_TIME_SLICE_MS = 4;
let cleanupReady = false;

const processPending = ( ) => {
    processTimer = undefined;
    if ( cleanupReady === false ) { return; }
    const deadline = self.performance.now() + MAX_TIME_SLICE_MS;
    for ( ; pendingIndex < pending.length; pendingIndex++ ) {
        if ( self.performance.now() >= deadline ) { break; }
        const el = pending[pendingIndex];
        if ( isVisible(el) === false ) { continue; }
        if ( collapse(el) ) {
            if ( el.parentElement ) { collapse(el.parentElement); }
        }
    }

    if ( pendingIndex >= pending.length ) {
        pending.length = 0;
        pendingIndex = 0;
        return;
    }
    scheduleProcess();
};

const scheduleProcess = ( ) => {
    if ( processTimer !== undefined ) { return; }
    processTimer = self.requestAnimationFrame(processPending);
};

const collectKnownShadowRoots = roots => {
    const knownRoots = Array.isArray(roots)
        ? roots
        : (shadowController?.enumerateRoots?.() || []);
    for ( const root of knownRoots ) {
        collect(root);
    }
};

const observer = new MutationObserver(mutations => {
    for ( const m of mutations ) {
        for ( const n of m.addedNodes ) {
            if ( n.nodeType !== 1 ) { continue; }
            collect(n);
        }
    }
    shadowController?.scheduleRescan?.();
    if ( cleanupReady ) {
        scheduleProcess();
    }
});

const onBlockHintsChanged = ( ) => {
    collectHintedElements();
    if ( cleanupReady ) {
        scheduleProcess();
    }
};

self.addEventListener?.(shadowRootsChangedEvent, event => {
    const roots = Array.isArray(event?.detail?.roots)
        ? event.detail.roots
        : undefined;
    collectKnownShadowRoots(roots);
    if ( cleanupReady ) {
        scheduleProcess();
    }
});

let observerConnected = false;
let blockHintListenerConnected = false;
let refreshRunId = 0;

const resetState = ( ) => {
    pending = [];
    seen = new WeakSet();
    pendingIndex = 0;
};

const stop = async ( ) => {
    refreshRunId += 1;
    cleanupReady = false;
    if ( observerConnected ) {
        observer.disconnect();
        observerConnected = false;
    }
    if ( blockHintListenerConnected ) {
        self.removeEventListener?.(blockHintsChangedEvent, onBlockHintsChanged);
        blockHintListenerConnected = false;
    }
    if ( processTimer !== undefined ) {
        try { self.cancelAnimationFrame(processTimer); } catch { }
        processTimer = undefined;
    }
    resetState();
};

const refresh = async ( ) => {
    await stop();
    const runId = refreshRunId + 1;
    refreshRunId = runId;

    collect(document);
    collectHintedElements();
    shadowController?.rescanNow?.();
    collectKnownShadowRoots();
    observer.observe(document, { childList: true, subtree: true });
    observerConnected = true;
    self.addEventListener?.(blockHintsChangedEvent, onBlockHintsChanged);
    blockHintListenerConnected = true;

    await guard?.whenReady?.();
    if ( runId !== refreshRunId ) {
        return { applied: false };
    }
    if ( guard?.shouldRunSubsystem?.('postHideCleanup') === false ) {
        await stop();
        return { applied: false };
    }
    cleanupReady = true;
    collectHintedElements();
    scheduleProcess();
    return { applied: true };
};

self.TalonPostHideCleanupController = {
    refresh,
    stop,
};

self.TalonPostHideCleanupController.refresh().catch(( ) => {});

})();

void 0;
