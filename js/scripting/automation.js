/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_automation() {

const DIRECTIVES_PATH = 'automation/directives.json';
const PUBLIC_REMOTE_DIRECTIVES_KEY = 'communityBundlePublicDirectives';
const PRIVATE_REMOTE_DIRECTIVES_KEY = 'communityBundlePrivateDirectives';
const LEGACY_REMOTE_DIRECTIVES_KEY = 'communityBundleDirectives';

const runtime = self.browser?.runtime || self.chrome?.runtime;
const getURL = runtime?.getURL?.bind(runtime) || (p => p);
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
const guard = self.TalonBreakageGuard;
const blockHints = self.TalonBlockHintsController;
const AUTOMATION_MARK_ATTR = 'data-ubol-automation';
const AUTOMATION_STYLE_MARKER_ATTR = 'data-ubol-automation-style';
const shadowController = self.TalonShadowRootController;
const shadowRootsChangedEvent = shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
const DEFAULT_REAPPLY_DELAYS_MS = Object.freeze([ 0, 500, 2000, 10000, 30000 ]);
const REAPPLY_RESET_AFTER_MS = 5 * 60 * 1000;

if ( self.TalonAutomationController ) {
    self.TalonAutomationController.refresh().catch(( ) => {});
    return;
}

let directivesPromise;
let remoteDirectivesPromise;

const mergeDirectiveArrays = (...inputs) => {
    const out = [];
    for ( const input of inputs ) {
        if ( Array.isArray(input) === false ) { continue; }
        out.push(...input);
    }
    return out;
};

const loadRemoteDirectives = ( ) => {
    if ( remoteDirectivesPromise !== undefined ) { return remoteDirectivesPromise; }
    if ( storage?.get === undefined ) {
        remoteDirectivesPromise = Promise.resolve([]);
        return remoteDirectivesPromise;
    }
    const keys = [
        PUBLIC_REMOTE_DIRECTIVES_KEY,
        PRIVATE_REMOTE_DIRECTIVES_KEY,
        LEGACY_REMOTE_DIRECTIVES_KEY,
    ];
    try {
        const maybePromise = storage.get(keys);
        if ( maybePromise?.then ) {
            remoteDirectivesPromise = maybePromise.then(bin => mergeDirectiveArrays(
                bin?.[PUBLIC_REMOTE_DIRECTIVES_KEY],
                bin?.[PRIVATE_REMOTE_DIRECTIVES_KEY],
                bin?.[LEGACY_REMOTE_DIRECTIVES_KEY],
            ))
                .catch(( ) => []);
            return remoteDirectivesPromise;
        }
    } catch {
    }
    remoteDirectivesPromise = new Promise(resolve => {
        try {
            storage.get(keys, bin => resolve(mergeDirectiveArrays(
                bin?.[PUBLIC_REMOTE_DIRECTIVES_KEY],
                bin?.[PRIVATE_REMOTE_DIRECTIVES_KEY],
                bin?.[LEGACY_REMOTE_DIRECTIVES_KEY],
            )));
        } catch {
            resolve([]);
        }
    });
    return remoteDirectivesPromise;
};

const loadDirectives = ( ) => {
    if ( directivesPromise !== undefined ) { return directivesPromise; }
    const localPromise = fetch(getURL(DIRECTIVES_PATH)).then(r => {
        if ( r.ok === false ) { throw new Error(r.statusText); }
        return r.json();
    }).catch(( ) => []);
    directivesPromise = Promise.all([ localPromise, loadRemoteDirectives() ])
        .then(([ localDirs, remoteDirs ]) => {
            const out = [];
            if ( Array.isArray(localDirs) ) { out.push(...localDirs); }
            if ( Array.isArray(remoteDirs) ) { out.push(...remoteDirs); }
            return out;
        })
        .catch(( ) => []);
    return directivesPromise;
};

const hostname = (self.location && self.location.hostname || '').toLowerCase();
if ( hostname === '' ) { return; }

const normalizeHostnameCandidate = value => {
    if ( typeof value !== 'string' ) { return ''; }
    return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
};

const normalizeScopedHostPattern = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const trimmed = value.trim().toLowerCase();
    if ( trimmed === '' ) { return ''; }
    if ( trimmed.includes('://') || trimmed.includes('/') ) { return ''; }
    if ( trimmed === '*' || trimmed === 'all-urls' ) { return trimmed; }

    const normalizeBareHostname = candidate => {
        const normalized = normalizeHostnameCandidate(candidate);
        if ( normalized === '' ) { return ''; }
        if ( normalized.includes('*') || normalized === 'all-urls' ) { return ''; }
        return normalized;
    };

    if ( trimmed.startsWith('=') ) {
        const bare = normalizeBareHostname(trimmed.slice(1));
        return bare === '' ? '' : `=${bare}`;
    }
    if ( trimmed.startsWith('*.') ) {
        const bare = normalizeBareHostname(trimmed.slice(2));
        return bare === '' ? '' : `*.${bare}`;
    }
    if ( trimmed.endsWith('.*') ) {
        const bare = normalizeBareHostname(trimmed.slice(0, -2));
        return bare === '' ? '' : `${bare}.*`;
    }
    return normalizeBareHostname(trimmed);
};

const patternMatchesHostname = (pattern, hn) => {
    const delegated = guard?.hostPatternMatches;
    if ( typeof delegated === 'function' ) {
        return delegated(pattern, hn) === true;
    }
    const p = normalizeScopedHostPattern(pattern);
    const normalizedHostname = normalizeHostnameCandidate(hn);
    if ( p === '' || normalizedHostname === '' ) { return false; }
    if ( p === '*' || p === 'all-urls' ) { return true; }
    if ( p.startsWith('=') ) {
        return normalizedHostname === p.slice(1);
    }
    if ( p.startsWith('*.') ) {
        const bare = p.slice(2);
        return normalizedHostname === bare || normalizedHostname.endsWith(`.${bare}`);
    }
    if ( p.endsWith('.*') ) {
        const bare = p.slice(0, -2);
        return normalizedHostname === bare || normalizedHostname.startsWith(`${bare}.`);
    }
    return normalizedHostname === p || normalizedHostname.endsWith(`.${p}`);
};

const hostMatchesDirective = directive => {
    const hosts = directive.hosts;
    if ( Array.isArray(hosts) === false ) { return false; }
    for ( const h of hosts ) {
        if ( patternMatchesHostname(h, hostname) ) { return true; }
    }
    return false;
};

const isVisible = el => {
    if ( el instanceof Element === false ) { return false; }
    const style = self.getComputedStyle(el);
    if ( style.display === 'none' ) { return false; }
    if ( style.visibility === 'hidden' ) { return false; }
    if ( Number(style.opacity) === 0 ) { return false; }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
};

const queryTargetsInRoot = (root, selector) => {
    const out = [];
    if ( typeof selector !== 'string' || selector === '' ) { return out; }
    let nodes;
    try {
        nodes = (root === document ? document : root).querySelectorAll(selector);
    } catch {
        return out;
    }
    for ( const node of nodes ) {
        if ( isVisible(node) === false ) { continue; }
        out.push(node);
    }
    return out;
};

const queryTargets = selector => {
    const out = [];
    const seen = new Set();
    const roots = [ document, ...(shadowController?.enumerateRoots?.() || []) ];
    for ( const root of roots ) {
        const hits = queryTargetsInRoot(root, selector);
        for ( const hit of hits ) {
            if ( seen.has(hit) ) { continue; }
            seen.add(hit);
            out.push(hit);
        }
    }
    return out;
};

const markApplied = (el, id) => {
    try {
        el.setAttribute(AUTOMATION_MARK_ATTR, String(id || ''));
    } catch {
    }
};

const styleIdForDirective = id =>
    `ubol-automation-style-${String(id || 'directive').replace(/[^a-z0-9_-]/gi, '_')}`;

const escapeAttrValue = value => String(value || '').replace(/["\\]/g, '\\$&');

const buildHideStyleText = id => {
    const attrSelector = `[${AUTOMATION_MARK_ATTR}="${escapeAttrValue(id)}"]`;
    return `${attrSelector}{display:none!important;visibility:hidden!important;}`;
};

const documentStyleMap = new Map();
const shadowStyleMap = new Map();

const upsertStyleText = (style, cssText) => {
    if ( style instanceof HTMLStyleElement === false ) { return false; }
    if ( style.textContent === cssText ) { return true; }
    style.textContent = cssText;
    return true;
};

const ensureDocumentHideStyle = (styleId, cssText) => {
    let style = documentStyleMap.get(styleId) || null;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.getElementById(styleId);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.id = styleId;
            style.setAttribute(AUTOMATION_STYLE_MARKER_ATTR, styleId);
            (document.head || document.documentElement || document).append(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    documentStyleMap.set(styleId, style);
    upsertStyleText(style, cssText);
    return style;
};

const ensureShadowRootHideStyle = (root, styleId, cssText) => {
    if ( root instanceof DocumentFragment === false ) { return null; }
    let rootStyles = shadowStyleMap.get(root);
    if ( rootStyles instanceof Map === false ) {
        rootStyles = new Map();
        shadowStyleMap.set(root, rootStyles);
    }
    let style = rootStyles.get(styleId) || null;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = root.querySelector?.(
                `style[${AUTOMATION_STYLE_MARKER_ATTR}="${escapeAttrValue(styleId)}"]`
            ) || null;
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.setAttribute(AUTOMATION_STYLE_MARKER_ATTR, styleId);
            root.append?.(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    rootStyles.set(styleId, style);
    upsertStyleText(style, cssText);
    return style;
};

const removeDocumentHideStyle = styleId => {
    const style = documentStyleMap.get(styleId);
    if ( style instanceof HTMLStyleElement ) {
        try { style.remove(); } catch {
        }
    }
    documentStyleMap.delete(styleId);
};

const removeShadowRootHideStyle = (root, styleId) => {
    const rootStyles = shadowStyleMap.get(root);
    if ( rootStyles instanceof Map === false ) { return; }
    const style = rootStyles.get(styleId);
    if ( style instanceof HTMLStyleElement ) {
        try { style.remove(); } catch {
        }
    }
    rootStyles.delete(styleId);
    if ( rootStyles.size === 0 ) {
        shadowStyleMap.delete(root);
    }
};

const clearHideStyles = ( ) => {
    for ( const styleId of Array.from(documentStyleMap.keys()) ) {
        removeDocumentHideStyle(styleId);
    }
    for ( const root of Array.from(shadowStyleMap.keys()) ) {
        const rootStyles = shadowStyleMap.get(root);
        if ( rootStyles instanceof Map === false ) { continue; }
        for ( const styleId of Array.from(rootStyles.keys()) ) {
            removeShadowRootHideStyle(root, styleId);
        }
    }
};

const collectActiveHideStyles = directives => {
    const out = new Map();
    for ( const directive of directives || [] ) {
        const id = directive?.id || '(unknown)';
        if ( directive?.action === 'hide' ) {
            out.set(styleIdForDirective(id), buildHideStyleText(id));
        }
        if ( directive?.fallbackAction === 'hide' ) {
            out.set(styleIdForDirective(id), buildHideStyleText(id));
        }
    }
    return out;
};

const syncHideStyles = (directives = activeDirectives) => {
    const nextEntries = collectActiveHideStyles(directives);
    if ( nextEntries.size === 0 ) {
        clearHideStyles();
        return;
    }

    for ( const [ styleId, cssText ] of nextEntries ) {
        ensureDocumentHideStyle(styleId, cssText);
    }
    for ( const styleId of Array.from(documentStyleMap.keys()) ) {
        if ( nextEntries.has(styleId) ) { continue; }
        removeDocumentHideStyle(styleId);
    }

    const roots = shadowController?.enumerateRoots?.() || [];
    const activeRoots = new Set();
    for ( const root of roots ) {
        if ( root instanceof DocumentFragment === false ) { continue; }
        activeRoots.add(root);
        for ( const [ styleId, cssText ] of nextEntries ) {
            ensureShadowRootHideStyle(root, styleId, cssText);
        }
        const rootStyles = shadowStyleMap.get(root);
        if ( rootStyles instanceof Map === false ) { continue; }
        for ( const styleId of Array.from(rootStyles.keys()) ) {
            if ( nextEntries.has(styleId) ) { continue; }
            removeShadowRootHideStyle(root, styleId);
        }
    }
    for ( const root of Array.from(shadowStyleMap.keys()) ) {
        if ( activeRoots.has(root) ) { continue; }
        const rootStyles = shadowStyleMap.get(root);
        if ( rootStyles instanceof Map === false ) {
            shadowStyleMap.delete(root);
            continue;
        }
        for ( const styleId of Array.from(rootStyles.keys()) ) {
            removeShadowRootHideStyle(root, styleId);
        }
    }
};

const resolveMutationRiskTier = context => {
    if ( context?.category === 'consent' ) {
        return guard?.RISK_TIERS?.medium || 2;
    }
    return guard?.RISK_TIERS?.high || 3;
};

const applyClick = (id, selectors) => {
    const riskTier = resolveMutationRiskTier(null);
    for ( const selector of selectors ) {
        const targets = queryTargets(selector);
        if ( targets.length === 0 ) { continue; }
        for ( const el of targets ) {
            if ( el.getAttribute?.(AUTOMATION_MARK_ATTR) ) { continue; }
            const decision = guard?.canMutateElement?.(el, {
                riskTier,
                source: 'automation-click',
            });
            if ( decision?.allowed === false ) { continue; }
            try { el.click(); } catch { continue; }
            markApplied(el, id);
            guard?.auditAfterMutation?.('automation-click');
            return true;
        }
    }
    return false;
};

const applyHide = (id, selectors, context) => {
    let changed = false;
    const riskTier = resolveMutationRiskTier(context);
    for ( const selector of selectors ) {
        const targets = queryTargets(selector);
        if ( targets.length === 0 ) { continue; }
        for ( const el of targets ) {
            if ( el === document.body || el === document.documentElement ) { continue; }
            if ( el.getAttribute?.(AUTOMATION_MARK_ATTR) && isVisible(el) === false ) { continue; }
            const decision = guard?.canMutateElement?.(el, {
                riskTier,
                source: 'automation-hide',
            });
            if ( decision?.allowed === false ) { continue; }
            markApplied(el, id);
            blockHints?.noteElement?.(el, { ancestors: 1 });
            changed = true;
        }
    }
    if ( changed ) {
        guard?.auditAfterMutation?.('automation-hide');
    }
    return changed;
};

const applyRemove = (id, selectors, context) => {
    let changed = false;
    const riskTier = resolveMutationRiskTier(context);
    for ( const selector of selectors ) {
        const targets = queryTargets(selector);
        if ( targets.length === 0 ) { continue; }
        let groupChanged = false;
        for ( const el of targets ) {
            if ( el === document.body || el === document.documentElement ) { continue; }
            if ( el.getAttribute?.(AUTOMATION_MARK_ATTR) ) { continue; }
            const decision = guard?.canMutateElement?.(el, {
                riskTier,
                source: 'automation-remove',
            });
            if ( decision?.allowed === false ) { continue; }
            blockHints?.noteElement?.(el.parentElement || el, { ancestors: 1 });
            try { el.remove(); } catch { continue; }
            groupChanged = true;
        }
        if ( groupChanged ) {
            changed = true;
            break;
        }
    }
    if ( changed ) {
        guard?.auditAfterMutation?.('automation-remove');
    }
    return changed;
};

const ACTIONS = {
    click: applyClick,
    hide: applyHide,
    remove: applyRemove,
};

const unlockScroll = ( ) => {
    const html = document.documentElement;
    const body = document.body;
    if ( html && self.getComputedStyle(html).overflow === 'hidden' ) {
        html.style.setProperty('overflow', 'auto', 'important');
    }
    if ( body && self.getComputedStyle(body).overflow === 'hidden' ) {
        body.style.setProperty('overflow', 'auto', 'important');
    }
    if ( body && self.getComputedStyle(body).position === 'fixed' ) {
        body.style.setProperty('position', 'static', 'important');
    }
};

const POST_ACTIONS = {
    unlockScroll,
};

const OBSERVED_ATTRIBUTE_FILTER = [ 'style', 'class', 'hidden', 'open', 'aria-hidden' ];
const directiveState = new Map();

let activeDirectives = [];
let observerConnected = false;
let sweepTimer;
let sweepTimerAt = 0;

const now = ( ) => Date.now();

const hasExplicitMaxApplies = directive =>
    Number.isFinite(Number(directive?.maxApplies));

const getDirectiveId = directive => directive?.id || '(unknown)';

const getDefaultReapplyDelayMs = successfulApplies => {
    const delays = DEFAULT_REAPPLY_DELAYS_MS;
    const index = Math.min(
        delays.length - 1,
        Math.max(0, Math.floor(successfulApplies) - 1)
    );
    return delays[index];
};

const getDirectiveState = (directive, currentNow = now()) => {
    const id = getDirectiveId(directive);
    let state = directiveState.get(id);
    if ( state instanceof Object === false ) {
        state = {
            successfulApplies: 0,
            lastAppliedAt: 0,
            nextEligibleAt: 0,
        };
        directiveState.set(id, state);
    }
    if (
        hasExplicitMaxApplies(directive) === false &&
        state.lastAppliedAt > 0 &&
        (currentNow - state.lastAppliedAt) >= REAPPLY_RESET_AFTER_MS
    ) {
        state.successfulApplies = 0;
        state.lastAppliedAt = 0;
        state.nextEligibleAt = 0;
    }
    return state;
};

const recordDirectiveSuccess = (directive, currentNow = now()) => {
    const state = getDirectiveState(directive, currentNow);
    state.successfulApplies += 1;
    state.lastAppliedAt = currentNow;
    if ( hasExplicitMaxApplies(directive) ) {
        state.nextEligibleAt = 0;
        return;
    }
    state.nextEligibleAt = currentNow + getDefaultReapplyDelayMs(state.successfulApplies);
};

const canApplyDirectiveNow = (directive, currentNow = now()) => {
    const state = getDirectiveState(directive, currentNow);
    if ( hasExplicitMaxApplies(directive) ) {
        return state.successfulApplies < Number(directive.maxApplies);
    }
    return state.nextEligibleAt <= currentNow;
};

const getDirectiveNextEligibleAt = (directive, currentNow = now()) => {
    if ( hasExplicitMaxApplies(directive) ) { return 0; }
    const state = getDirectiveState(directive, currentNow);
    return state.nextEligibleAt > currentNow ? state.nextEligibleAt : 0;
};

const applyDirective = (directive, currentNow = now()) => {
    if ( canApplyDirectiveNow(directive, currentNow) === false ) { return false; }
    const id = getDirectiveId(directive);
    const action = ACTIONS[directive.action];
    if ( typeof action !== 'function' ) { return false; }
    const selectors = Array.isArray(directive.selectors) ? directive.selectors : [];
    if ( selectors.length === 0 ) { return false; }

    let did = action(id, selectors, directive);
    if ( did === false && directive.fallbackAction && directive.fallbackSelectors ) {
        const fallback = ACTIONS[directive.fallbackAction];
        const fbSelectors = Array.isArray(directive.fallbackSelectors)
            ? directive.fallbackSelectors
            : [];
        if ( typeof fallback === 'function' && fbSelectors.length !== 0 ) {
            did = fallback(id, fbSelectors, directive);
        }
    }

    if ( did ) {
        recordDirectiveSuccess(directive, currentNow);
        const post = directive.postActions;
        if ( Array.isArray(post) ) {
            for ( const token of post ) {
                POST_ACTIONS[token]?.();
            }
        }
    }

    return did;
};

const sweep = ( ) => {
    sweepTimer = undefined;
    sweepTimerAt = 0;
    const currentNow = now();
    let changed = false;
    let earliestEligibleAt = 0;
    for ( const directive of activeDirectives ) {
        if ( applyDirective(directive, currentNow) ) {
            changed = true;
        }
        const nextEligibleAt = getDirectiveNextEligibleAt(directive, currentNow);
        if ( nextEligibleAt === 0 ) { continue; }
        if ( earliestEligibleAt === 0 || nextEligibleAt < earliestEligibleAt ) {
            earliestEligibleAt = nextEligibleAt;
        }
    }
    if ( changed ) {
        syncHideStyles(activeDirectives);
    }
    if ( earliestEligibleAt > currentNow ) {
        scheduleSweep(earliestEligibleAt - currentNow);
    }
};

const scheduleSweep = (delay = 250) => {
    const normalizedDelay = Number.isFinite(delay)
        ? Math.max(0, delay)
        : 250;
    const targetAt = now() + normalizedDelay;
    if ( sweepTimer !== undefined ) {
        if ( targetAt >= sweepTimerAt ) { return; }
        try { clearTimeout(sweepTimer); } catch { }
    }
    sweepTimerAt = targetAt;
    sweepTimer = self.setTimeout(sweep, normalizedDelay);
};

const domObserver = new MutationObserver(( ) => {
    shadowController?.scheduleRescan?.();
    scheduleSweep();
});

self.addEventListener?.(shadowRootsChangedEvent, ( ) => {
    syncHideStyles(activeDirectives);
    scheduleSweep(0);
});

const stop = async ( ) => {
    if ( observerConnected ) {
        domObserver.disconnect();
        observerConnected = false;
    }
    if ( sweepTimer !== undefined ) {
        try { clearTimeout(sweepTimer); } catch { }
        sweepTimer = undefined;
    }
    sweepTimerAt = 0;
    clearHideStyles();
    activeDirectives = [];
    directiveState.clear();
};

const refresh = async ( ) => {
    remoteDirectivesPromise = undefined;
    directivesPromise = undefined;

    await guard?.whenReady?.();
    if ( guard?.shouldRunSubsystem?.('automation') === false ) {
        await stop();
        return { applied: false, directives: 0 };
    }

    const directives = await loadDirectives();
    activeDirectives = directives
        .filter(hostMatchesDirective)
        .map(directive => ({ ...directive }))
        .filter(directive => guard?.shouldAllowDirective?.(directive) !== false);

    directiveState.clear();
    if ( activeDirectives.length === 0 ) {
        clearHideStyles();
        if ( observerConnected ) {
            domObserver.disconnect();
            observerConnected = false;
        }
        return { applied: false, directives: 0 };
    }

    shadowController?.rescanNow?.();
    syncHideStyles(activeDirectives);
    scheduleSweep(0);
    if ( observerConnected === false ) {
        domObserver.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: OBSERVED_ATTRIBUTE_FILTER,
        });
        observerConnected = true;
    }
    return { applied: true, directives: activeDirectives.length };
};

self.TalonAutomationController = {
    refresh,
    stop,
};

self.TalonAutomationController.refresh().catch(( ) => {});

})();

void 0;
