/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_postHideCleanup() {

const runtime = self.browser?.runtime || self.chrome?.runtime;
const guard = self.TalonBreakageGuard;
const shadowController = self.TalonShadowRootController;
const blockHints = self.TalonBlockHintsController;
const cooperativeScheduler = self.TalonCooperativeScheduler;
const COOPERATIVE_FALLBACK_BUDGET_MS = 4;
const scheduleCooperativeTask = callback => {
    if ( typeof cooperativeScheduler?.schedule === 'function' ) {
        return cooperativeScheduler.schedule(callback);
    }
    return self.requestAnimationFrame(() => callback(
        self.performance.now() + COOPERATIVE_FALLBACK_BUDGET_MS
    ));
};
const cancelCooperativeTask = task => {
    if ( task === undefined ) { return; }
    if ( typeof cooperativeScheduler?.cancel === 'function' ) {
        cooperativeScheduler.cancel(task);
        return;
    }
    self.cancelAnimationFrame(task);
};
const cooperativeDeadline = deadline => Number.isFinite(deadline)
    ? deadline
    : self.performance.now() + COOPERATIVE_FALLBACK_BUDGET_MS;
const shadowRootsChangedEvent =
    shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
const shadowContentChangedEvent =
    shadowController?.CONTENT_CHANGED_EVENT || 'talon-shadow-content-changed';
const protectionChangedEvent =
    guard?.PROTECTION_CHANGED_EVENT || 'talon-protection-changed';
const blockHintsChangedEvent =
    blockHints?.HINTS_CHANGED_EVENT || 'talon-block-hints-changed';
if ( runtime === undefined ) { return; }

if ( self.TalonPostHideCleanupController ) {
    const readiness = self.TalonPostHideCleanupController.refresh();
    self.TalonPostHideCleanupReady = readiness;
    readiness.catch(( ) => {});
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

const ownedStyles = new Map();

const setOwnedStyle = (element, property, value, priority = 'important') => {
    if ( element instanceof Element === false ) { return false; }
    let properties = ownedStyles.get(element);
    if ( properties instanceof Map === false ) {
        properties = new Map();
        ownedStyles.set(element, properties);
    }
    let record = properties.get(property);
    if ( record === undefined ) {
        record = {
            originalValue: element.style.getPropertyValue?.(property) || '',
            originalPriority: element.style.getPropertyPriority?.(property) || '',
            appliedValue: '',
            appliedPriority: '',
        };
        properties.set(property, record);
    }
    element.style.setProperty(property, value, priority);
    record.appliedValue = element.style.getPropertyValue?.(property) || String(value);
    record.appliedPriority = element.style.getPropertyPriority?.(property) || priority;
    return true;
};

const restoreOwnedStylesFor = element => {
    const properties = ownedStyles.get(element);
    if ( properties instanceof Map === false ) { return false; }
    for ( const [ property, record ] of properties ) {
        const currentValue = element.style.getPropertyValue?.(property) || '';
        const currentPriority = element.style.getPropertyPriority?.(property) || '';
        if ( currentValue !== record.appliedValue ) { continue; }
        if ( currentPriority !== record.appliedPriority ) { continue; }
        if ( record.originalValue === '' ) {
            if ( typeof element.style.removeProperty === 'function' ) {
                element.style.removeProperty(property);
            } else {
                element.style.setProperty(property, '');
            }
        } else {
            element.style.setProperty(
                property,
                record.originalValue,
                record.originalPriority
            );
        }
    }
    ownedStyles.delete(element);
    return true;
};

const pruneDisconnectedOwnedStyles = ( ) => {
    for ( const element of Array.from(ownedStyles.keys()) ) {
        if ( element.isConnected !== false ) { continue; }
        restoreOwnedStylesFor(element);
        seen.delete(element);
    }
};

const restoreOwnedStyles = ( ) => {
    for ( const element of Array.from(ownedStyles.keys()) ) {
        restoreOwnedStylesFor(element);
    }
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

const getBoundedText = (el, maxLength = 160) => {
    const childNodes = el?.childNodes;
    if ( childNodes === undefined ) {
        const fallback = typeof el?.textContent === 'string' ? el.textContent : '';
        return fallback.length <= maxLength ? fallback : '';
    }
    if ( childNodes.length > 24 ) { return ''; }
    const queue = [];
    for ( let i = 0; i < childNodes.length; i++ ) {
        queue.push({ node: childNodes[i], depth: 0 });
    }
    let text = '';
    let visited = 0;
    while ( queue.length !== 0 && visited++ < 24 ) {
        const { node, depth } = queue.shift();
        if ( node?.nodeType === 3 ) {
            text += node.nodeValue || '';
            if ( text.length > maxLength ) { return ''; }
            continue;
        }
        if ( depth >= 1 || node?.childNodes === undefined ) { continue; }
        if ( node.childNodes.length > 24 ) { return ''; }
        for ( let i = 0; i < node.childNodes.length && queue.length < 24; i++ ) {
            queue.push({ node: node.childNodes[i], depth: depth + 1 });
        }
    }
    return text;
};

const getHintParts = el => [
    el.id,
    el.className,
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('role') || '',
    el.getAttribute?.('data-ad') || '',
    el.getAttribute?.('data-ad-unit') || '',
    el.getAttribute?.('data-ad-slot') || '',
    el.getAttribute?.('data-ad-client') || '',
    getBoundedText(el),
].join(' ');

const hasAdHint = el => attrHintRe.test(getHintParts(el));

const hasStructuralAdHint = el => attrHintRe.test([
    el?.id,
    el?.className,
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('data-ad') || '',
    el?.getAttribute?.('data-ad-unit') || '',
    el?.getAttribute?.('data-ad-slot') || '',
    el?.getAttribute?.('data-ad-client') || '',
].join(' '));

const hasBlockHint = el =>
    blockHints?.hasRecentHint?.(el, { includeSubtree: true }) === true;

const isTrivialAdChrome = el => {
    if ( el instanceof Element === false ) { return false; }
    const rect = el.getBoundingClientRect();
    const text = getBoundedText(el, 64).trim().replace(/\s+/g, ' ');
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
    if ( kids.length > 32 ) { return true; }
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

const hasProtectedInteractiveContent = container => {
    let node;
    try {
        node = container.querySelector(
            'form,input,select,textarea,video,audio,canvas,[contenteditable="true"],iframe[allow*="payment" i]'
        );
    } catch {
        node = null;
    }
    if ( node !== null && isVisible(node) ) { return true; }

    let buttons = [];
    try { buttons = container.querySelectorAll('button,[role="button"]'); } catch {
    }
    for ( const button of buttons ) {
        if ( isVisible(button) === false ) { continue; }
        if ( isTrivialAdChrome(button) ) { continue; }
        return true;
    }
    return false;
};

const shouldCollapse = container => {
    if ( container instanceof Element === false ) { return false; }
    if ( container === document.body || container === document.documentElement ) { return false; }
    if ( container.closest('nav,header,footer') ) { return false; }
    if ( ownedStyles.has(container) ) { return false; }
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
    if ( adSized === false && (rect.height < 50 || rect.width < 100) ) {
        return false;
    }

    if (
        hasAdHint(container) === false &&
        recentBlockHint === false
    ) {
        return false;
    }
    if ( hasProtectedInteractiveContent(container) ) { return false; }

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
            setOwnedStyle(html, 'overflow', 'auto');
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
            setOwnedStyle(body, 'overflow', 'auto');
        }
        if ( body && bodyFixed ) {
            setOwnedStyle(body, 'position', 'static');
            setOwnedStyle(body, 'top', 'auto');
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
        setOwnedStyle(container, 'display', 'none');
        setOwnedStyle(container, 'visibility', 'hidden');
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
const MAX_PENDING_CANDIDATES = 512;
const PENDING_RECOVERY_DELAY_MS = 100;
let pendingOverflowed = false;
let pendingRecoveryTimer;

const compactPending = ( ) => {
    if ( pendingIndex === 0 ) { return; }
    if ( pendingIndex < 256 && pendingIndex * 2 < pending.length ) { return; }
    pending.splice(0, pendingIndex);
    pendingIndex = 0;
};

const pendingHasCapacity = ( ) => {
    compactPending();
    return (pending.length - pendingIndex) < MAX_PENDING_CANDIDATES;
};

const enqueue = el => {
    if ( el instanceof Element === false ) { return false; }
    if ( seen.has(el) ) { return true; }
    if ( pendingHasCapacity() === false ) {
        pendingOverflowed = true;
        return false;
    }
    seen.add(el);
    pending.push(el);
    return true;
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

let collectionJobs = [];
let collectionJobIndex = 0;
let collectionTimer;
let collectionOverflowed = false;
let queuedCollectionRoots = new WeakSet();
const MAX_COLLECTION_SCAN_JOBS = 256;
const MAX_COLLECTION_SCAN_NODES_PER_SLICE = 128;

const compactCollectionJobs = ( ) => {
    if ( collectionJobIndex === 0 ) { return; }
    if (
        collectionJobIndex < 64 &&
        collectionJobIndex * 2 < collectionJobs.length
    ) {
        return;
    }
    collectionJobs.splice(0, collectionJobIndex);
    collectionJobIndex = 0;
};

const createCollectionJob = root => {
    const scanRoot = root === document
        ? (document.body || document.documentElement)
        : root;
    if (
        scanRoot instanceof Element === false &&
        scanRoot instanceof DocumentFragment === false
    ) {
        return null;
    }
    let walker;
    try {
        walker = document.createTreeWalker(
            scanRoot,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
    } catch {
        return null;
    }
    return {
        root: scanRoot,
        walker,
        includeRoot: scanRoot instanceof Element,
        directOnly: false,
    };
};

const createDirectCollectionJob = node => {
    if ( node instanceof Element === false ) { return null; }
    return {
        root: node,
        walker: null,
        includeRoot: true,
        directOnly: true,
    };
};

const collectionRootIsDisconnected = root => {
    if ( root instanceof Element ) { return root.isConnected === false; }
    const host = root?.host;
    return host instanceof Element && host.isConnected === false;
};

const inspectCollectionNode = node => {
    if ( node instanceof Element === false ) { return; }
    try {
        if ( node.matches?.(collectionSelectorText) !== true ) { return; }
    } catch {
        return;
    }
    enqueueCandidate(node);
};

const processCollectionJobs = sharedDeadline => {
    collectionTimer = undefined;
    const deadline = cooperativeDeadline(sharedDeadline);
    const pendingBefore = pending.length;
    let scanned = 0;
    while (
        collectionJobIndex < collectionJobs.length &&
        scanned < MAX_COLLECTION_SCAN_NODES_PER_SLICE &&
        self.performance.now() < deadline
    ) {
        const job = collectionJobs[collectionJobIndex];
        if ( collectionRootIsDisconnected(job.root) ) {
            queuedCollectionRoots.delete(job.root);
            collectionJobIndex += 1;
            continue;
        }
        let node;
        if ( job.includeRoot ) {
            job.includeRoot = false;
            node = job.root;
            if ( job.directOnly ) {
                queuedCollectionRoots.delete(job.root);
                collectionJobIndex += 1;
            }
        } else if ( job.directOnly ) {
            queuedCollectionRoots.delete(job.root);
            collectionJobIndex += 1;
            continue;
        } else if ( job.walker.nextNode() ) {
            node = job.walker.currentNode;
        } else {
            queuedCollectionRoots.delete(job.root);
            collectionJobIndex += 1;
            continue;
        }
        scanned += 1;
        inspectCollectionNode(node);
    }
    if ( pending.length !== pendingBefore ) { scheduleProcess(); }
    if ( collectionJobIndex >= collectionJobs.length ) {
        const needsFullScan = collectionOverflowed;
        collectionJobs = [];
        collectionJobIndex = 0;
        collectionOverflowed = false;
        queuedCollectionRoots = new WeakSet();
        if ( needsFullScan ) { collect(document); }
        return;
    }
    compactCollectionJobs();
    collectionTimer = scheduleCooperativeTask(processCollectionJobs);
};

const collect = (root, priority = false) => {
    const job = createCollectionJob(root);
    if ( job === null || queuedCollectionRoots.has(job.root) ) { return true; }
    compactCollectionJobs();
    if (
        (collectionJobs.length - collectionJobIndex) >=
        MAX_COLLECTION_SCAN_JOBS
    ) {
        collectionOverflowed = true;
        return false;
    }
    queuedCollectionRoots.add(job.root);
    if ( priority ) {
        collectionJobs.splice(collectionJobIndex, 0, job);
    } else {
        collectionJobs.push(job);
    }
    if ( collectionTimer === undefined ) {
        collectionTimer = scheduleCooperativeTask(processCollectionJobs);
    }
    return true;
};

const collectDirectCandidate = (node, priority = false) => {
    const job = createDirectCollectionJob(node);
    if ( job === null || queuedCollectionRoots.has(job.root) ) { return true; }
    compactCollectionJobs();
    if (
        (collectionJobs.length - collectionJobIndex) >=
        MAX_COLLECTION_SCAN_JOBS
    ) {
        return false;
    }
    queuedCollectionRoots.add(job.root);
    if ( priority ) {
        collectionJobs.splice(collectionJobIndex, 0, job);
    } else {
        collectionJobs.push(job);
    }
    if ( collectionTimer === undefined ) {
        collectionTimer = scheduleCooperativeTask(processCollectionJobs);
    }
    return true;
};

const schedulePendingRecovery = ( ) => {
    if ( pendingOverflowed === false || pendingRecoveryTimer !== undefined ) { return; }
    pendingRecoveryTimer = self.setTimeout(() => {
        pendingRecoveryTimer = undefined;
        if ( (pending.length - pendingIndex) !== 0 ) {
            schedulePendingRecovery();
            return;
        }
        pendingOverflowed = false;
        collectHintedElements();
        if ( pendingIndex < pending.length ) { scheduleProcess(); }
        if (
            collectionTimer !== undefined ||
            collectionJobIndex < collectionJobs.length
        ) {
            collectionOverflowed = true;
            return;
        }
        collect(document);
    }, PENDING_RECOVERY_DELAY_MS);
};

const collectHintedElements = ( ) => {
    const hinted = blockHints?.getRecentElements?.() || [];
    for ( const node of hinted ) {
        if ( pendingHasCapacity() === false ) { break; }
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
let cleanupReady = false;

const processPending = sharedDeadline => {
    processTimer = undefined;
    if ( cleanupReady === false ) { return; }
    const deadline = cooperativeDeadline(sharedDeadline);
    for ( ; pendingIndex < pending.length; pendingIndex++ ) {
        if ( self.performance.now() >= deadline ) { break; }
        const el = pending[pendingIndex];
        if ( el.isConnected === false ) { continue; }
        if ( isVisible(el) === false ) { continue; }
        if ( collapse(el) ) {
            if ( el.parentElement ) { collapse(el.parentElement); }
        }
    }

    if ( pendingIndex >= pending.length ) {
        pending.length = 0;
        pendingIndex = 0;
        schedulePendingRecovery();
        return;
    }
    compactPending();
    scheduleProcess();
};

const scheduleProcess = ( ) => {
    if ( processTimer !== undefined ) { return; }
    processTimer = scheduleCooperativeTask(processPending);
};

const collectKnownShadowRoots = (roots, priority = false) => {
    const knownRoots = Array.isArray(roots)
        ? roots
        : (shadowController?.enumerateRoots?.() || []);
    for ( const root of knownRoots ) {
        if ( collect(root, priority) === false ) { break; }
    }
};

const MAX_DIRECT_ATTRIBUTE_CANDIDATES = 128;
const observer = new MutationObserver(mutations => {
    let sawRemoval = false;
    let overloaded = false;
    const attributeTargets = new Set();
    for ( const m of mutations ) {
        if ( m.type === 'attributes' && m.target instanceof Element ) {
            if ( attributeTargets.size < MAX_DIRECT_ATTRIBUTE_CANDIDATES ) {
                attributeTargets.add(m.target);
            } else {
                overloaded = true;
            }
        }
        for ( const n of m.addedNodes ) {
            if ( n.nodeType !== 1 ) { continue; }
            if ( collect(n, true) === false ) {
                overloaded = true;
                break;
            }
        }
        if ( m.removedNodes?.length ) { sawRemoval = true; }
        if ( m.removedNodes?.length && m.target instanceof Element ) {
            let shouldRecheck = hasStructuralAdHint(m.target) || hasBlockHint(m.target);
            for (
                let i = 0;
                shouldRecheck === false && i < m.removedNodes.length && i < 16;
                i++
            ) {
                const removed = m.removedNodes[i];
                if ( removed instanceof Element === false ) { continue; }
                shouldRecheck = isHiddenAdShellCandidate(removed) ||
                    hasStructuralAdHint(removed) ||
                    hasBlockHint(removed);
            }
            if ( shouldRecheck ) {
                seen.delete(m.target);
                if ( collectDirectCandidate(m.target) === false ) {
                    overloaded = true;
                }
            }
        }
        if ( overloaded ) { break; }
    }
    for ( const target of attributeTargets ) {
        seen.delete(target);
        if ( target.parentElement ) { seen.delete(target.parentElement); }
        if ( collectDirectCandidate(target) === false ) { overloaded = true; }
        if ( collectDirectCandidate(target.parentElement) === false ) {
            overloaded = true;
        }
    }
    if ( overloaded ) {
        pendingOverflowed = true;
        schedulePendingRecovery();
    }
    if ( sawRemoval || overloaded ) { pruneDisconnectedOwnedStyles(); }
    if ( cleanupReady && pendingIndex < pending.length ) {
        scheduleProcess();
    }
});

const onBlockHintsChanged = ( ) => {
    collectHintedElements();
    if ( cleanupReady && pendingIndex < pending.length ) {
        scheduleProcess();
    }
};

const onShadowRootsChanged = event => {
    const roots = Array.isArray(event?.detail?.addedRoots)
        ? event.detail.addedRoots
        : (Array.isArray(event?.detail?.roots) ? event.detail.roots : undefined);
    collectKnownShadowRoots(roots, true);
    if ( event?.detail?.removedRoots?.length ) {
        pruneDisconnectedOwnedStyles();
    }
    if ( cleanupReady && pendingIndex < pending.length ) {
        scheduleProcess();
    }
};

const onShadowContentChanged = event => {
    if ( event?.detail?.overflowed === true ) {
        collectKnownShadowRoots(undefined, true);
        pruneDisconnectedOwnedStyles();
        if ( cleanupReady && pendingIndex < pending.length ) { scheduleProcess(); }
        return;
    }
    const addedNodes = Array.isArray(event?.detail?.addedNodes)
        ? event.detail.addedNodes
        : [];
    for ( const node of addedNodes ) {
        if ( collect(node, true) === false ) { break; }
    }
    if ( event?.detail?.removedNodes?.length ) {
        pruneDisconnectedOwnedStyles();
    }
    if ( cleanupReady && pendingIndex < pending.length ) { scheduleProcess(); }
};

const onProtectionChanged = () => {
    self.TalonPostHideCleanupController?.refresh?.().catch(() => {});
};

let observerConnected = false;
let blockHintListenerConnected = false;
let shadowListenersConnected = false;
let protectionListenerConnected = false;
let refreshRunId = 0;

const resetState = ( ) => {
    pending = [];
    seen = new WeakSet();
    pendingIndex = 0;
    collectionJobs = [];
    collectionJobIndex = 0;
    collectionOverflowed = false;
    pendingOverflowed = false;
    queuedCollectionRoots = new WeakSet();
};

const stop = async ({ preserveProtectionListener = false } = {}) => {
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
    if ( shadowListenersConnected ) {
        self.removeEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
        self.removeEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
        shadowListenersConnected = false;
    }
    if ( protectionListenerConnected && preserveProtectionListener === false ) {
        self.removeEventListener?.(protectionChangedEvent, onProtectionChanged);
        protectionListenerConnected = false;
    }
    if ( processTimer !== undefined ) {
        try { cancelCooperativeTask(processTimer); } catch { }
        processTimer = undefined;
    }
    if ( collectionTimer !== undefined ) {
        try { cancelCooperativeTask(collectionTimer); } catch { }
        collectionTimer = undefined;
    }
    if ( pendingRecoveryTimer !== undefined ) {
        try { self.clearTimeout(pendingRecoveryTimer); } catch { }
        pendingRecoveryTimer = undefined;
    }
    restoreOwnedStyles();
    resetState();
};

const refresh = async ( ) => {
    await stop({ preserveProtectionListener: true });
    const runId = refreshRunId + 1;
    refreshRunId = runId;

    await guard?.whenReady?.();
    if ( runId !== refreshRunId ) {
        return { applied: false };
    }
    if ( protectionListenerConnected === false ) {
        self.addEventListener?.(protectionChangedEvent, onProtectionChanged);
        protectionListenerConnected = true;
    }
    if ( guard?.shouldRunSubsystem?.('postHideCleanup') === false ) {
        return { applied: false };
    }
    collect(document);
    collectHintedElements();
    collectKnownShadowRoots();
    observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
            'class',
            'id',
            'style',
            'hidden',
            'aria-hidden',
            'aria-label',
            'title',
            'src',
            'name',
            'role',
            'data-ad',
            'data-ad-label-text',
            'data-sponsored',
            'data-ad-unit',
            'data-ad-slot',
            'data-ad-client',
            'data-advertisement',
        ],
    });
    observerConnected = true;
    self.addEventListener?.(blockHintsChangedEvent, onBlockHintsChanged);
    blockHintListenerConnected = true;
    self.addEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
    self.addEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
    shadowListenersConnected = true;
    cleanupReady = true;
    collectHintedElements();
    scheduleProcess();
    return { applied: true };
};

self.TalonPostHideCleanupController = {
    refresh,
    stop,
};

const readiness = self.TalonPostHideCleanupController.refresh();
self.TalonPostHideCleanupReady = readiness;
readiness.catch(( ) => {});

})();

void 0;
