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
const AUTOMATION_MARK_ATTR = 'data-ubol-automation';
const shadowController = self.TalonShadowRootController;
const shadowRootsChangedEvent = shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';

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

const ensureHideStyle = id => {
    const attrSelector = `[${AUTOMATION_MARK_ATTR}="${escapeAttrValue(id)}"]`;
    const styleId = styleIdForDirective(id);
    const styleText = `${attrSelector}{display:none!important;visibility:hidden!important;}`;
    try {
        const existing = document.getElementById(styleId);
        if ( existing instanceof HTMLStyleElement ) {
            if ( existing.textContent !== styleText ) {
                existing.textContent = styleText;
            }
            return;
        }
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = styleText;
        (document.head || document.documentElement || document).append(style);
    } catch {
    }
};

const removeHideStyle = id => {
    try {
        const style = document.getElementById(styleIdForDirective(id));
        if ( style ) {
            style.remove();
        }
    } catch {
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
    ensureHideStyle(id);
    for ( const selector of selectors ) {
        const targets = queryTargets(selector);
        if ( targets.length === 0 ) { continue; }
        let groupChanged = false;
        for ( const el of targets ) {
            if ( el === document.body || el === document.documentElement ) { continue; }
            if ( el.getAttribute?.(AUTOMATION_MARK_ATTR) && isVisible(el) === false ) { continue; }
            const decision = guard?.canMutateElement?.(el, {
                riskTier,
                source: 'automation-hide',
            });
            if ( decision?.allowed === false ) { continue; }
            markApplied(el, id);
            groupChanged = true;
        }
        if ( groupChanged ) {
            changed = true;
            break;
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

const MAX_APPLIES_DEFAULT = 3;
const OBSERVED_ATTRIBUTE_FILTER = [ 'style', 'class', 'hidden', 'open', 'aria-hidden' ];
const directiveCounts = new Map();

let activeDirectives = [];
let observerConnected = false;
let sweepTimer;

const cleanupDirectiveStyles = directives => {
    const styleIds = new Set();
    for ( const directive of directives || [] ) {
        const id = directive?.id || '(unknown)';
        styleIds.add(id);
    }
    for ( const id of styleIds ) {
        removeHideStyle(id);
    }
};

const applyDirective = directive => {
    const id = directive.id || '(unknown)';
    const count = directiveCounts.get(id) || 0;
    const maxApplies = Number.isFinite(directive.maxApplies)
        ? directive.maxApplies
        : MAX_APPLIES_DEFAULT;
    if ( count >= maxApplies ) { return false; }

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
        directiveCounts.set(id, count + 1);
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
    let changed = false;
    for ( const directive of activeDirectives ) {
        if ( applyDirective(directive) ) { changed = true; }
    }
    if ( changed === false && directiveCounts.size !== 0 ) {
        const allMaxed = activeDirectives.every(d => {
            const id = d.id || '(unknown)';
            const count = directiveCounts.get(id) || 0;
            const maxApplies = Number.isFinite(d.maxApplies)
                ? d.maxApplies
                : MAX_APPLIES_DEFAULT;
            return count >= maxApplies;
        });
        if ( allMaxed ) {
            domObserver.disconnect();
            observerConnected = false;
        }
    }
};

const scheduleSweep = (delay = 250) => {
    if ( sweepTimer !== undefined ) { return; }
    sweepTimer = self.setTimeout(sweep, delay);
};

const domObserver = new MutationObserver(( ) => {
    shadowController?.scheduleRescan?.();
    scheduleSweep();
});

self.addEventListener?.(shadowRootsChangedEvent, ( ) => {
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
    cleanupDirectiveStyles(activeDirectives);
    activeDirectives = [];
    directiveCounts.clear();
};

const refresh = async ( ) => {
    remoteDirectivesPromise = undefined;
    directivesPromise = undefined;

    await guard?.whenReady?.();
    if ( guard?.shouldRunSubsystem?.('automation') === false ) {
        await stop();
        return { applied: false, directives: 0 };
    }

    const previousDirectives = activeDirectives.slice();
    const directives = await loadDirectives();
    activeDirectives = directives
        .filter(hostMatchesDirective)
        .map(directive => ({ ...directive }))
        .filter(directive => guard?.shouldAllowDirective?.(directive) !== false);

    cleanupDirectiveStyles(previousDirectives.filter(previous =>
        activeDirectives.some(next => next.id === previous.id) === false
    ));

    directiveCounts.clear();
    if ( activeDirectives.length === 0 ) {
        if ( observerConnected ) {
            domObserver.disconnect();
            observerConnected = false;
        }
        return { applied: false, directives: 0 };
    }

    for ( const directive of activeDirectives ) {
        if ( directive.action === 'hide' ) {
            ensureHideStyle(directive.id || '(unknown)');
        }
        if ( directive.fallbackAction === 'hide' ) {
            ensureHideStyle(directive.id || '(unknown)');
        }
    }

    shadowController?.rescanNow?.();
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
