/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_postHideCleanup() {

const runtime = self.browser?.runtime || self.chrome?.runtime;
const guard = self.TalonBreakageGuard;
if ( runtime === undefined ) { return; }

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
    if ( adSized === false && (rect.height < 50 || rect.width < 100) ) {
        return false;
    }

    if ( hasAdHint(container) === false && adSized === false ) {
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

const pending = [];
const seen = new WeakSet();
let pendingIndex = 0;

const enqueue = el => {
    if ( el instanceof Element === false ) { return; }
    if ( seen.has(el) ) { return; }
    seen.add(el);
    pending.push(el);
};

const collect = root => {
    let nodes = [];
    try {
        nodes = (root === document ? document : root).querySelectorAll(selectorText);
    } catch {
        nodes = [];
    }
    for ( const node of nodes ) {
        if ( isVisible(node) === false ) { continue; }
        enqueue(node);
        if ( node.parentElement ) { enqueue(node.parentElement); }
    }
};

let processTimer;
const MAX_TIME_SLICE_MS = 4;

const processPending = ( ) => {
    processTimer = undefined;
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

// Shadow DOM support (open roots only), scanned conservatively.
let shadowScanTimer;
const MAX_SHADOW_SCAN_NODES = 1000;

const collectShadowRootsFrom = node => {
    if ( node instanceof Element === false ) { return; }
    const roots = [];
    if ( node.shadowRoot instanceof DocumentFragment ) {
        roots.push(node.shadowRoot);
    }
    try {
        const walker = document.createTreeWalker(
            node,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
        let scanned = 0;
        while ( walker.nextNode() ) {
            const el = walker.currentNode;
            if ( el.shadowRoot instanceof DocumentFragment ) {
                roots.push(el.shadowRoot);
            }
            if ( ++scanned >= 150 ) { break; }
        }
    } catch {
    }
    for ( const sr of roots ) {
        collect(sr);
    }
};

const scanOpenShadowRoots = root => {
    if ( root instanceof Element === false ) { return; }
    try {
        const walker = document.createTreeWalker(
            root,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
        let scanned = 0;
        while ( walker.nextNode() ) {
            const el = walker.currentNode;
            if ( el.shadowRoot instanceof DocumentFragment ) {
                collect(el.shadowRoot);
            }
            if ( ++scanned >= MAX_SHADOW_SCAN_NODES ) { break; }
        }
    } catch {
    }
};

const scheduleShadowScan = (delay = 1500) => {
    if ( shadowScanTimer !== undefined ) { return; }
    shadowScanTimer = self.setTimeout(( ) => {
        shadowScanTimer = undefined;
        scanOpenShadowRoots(document.body);
        scheduleProcess();
    }, delay);
};

const observer = new MutationObserver(mutations => {
    for ( const m of mutations ) {
        for ( const n of m.addedNodes ) {
            if ( n.nodeType !== 1 ) { continue; }
            collect(n);
            collectShadowRootsFrom(n);
        }
    }
    scheduleShadowScan();
    scheduleProcess();
});

(async ( ) => {
    await guard?.whenReady?.();
    if ( guard?.shouldRunSubsystem?.('postHideCleanup') === false ) { return; }
    collect(document);
    scheduleShadowScan(0);
    scheduleProcess();
    observer.observe(document, { childList: true, subtree: true });
})();

})();

void 0;
