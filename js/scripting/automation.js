/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_automation() {

const DIRECTIVES_PATH = 'automation/directives.json';
const PUBLIC_REMOTE_DIRECTIVES_KEY = 'communityBundlePublicDirectives';
const PRIVATE_REMOTE_DIRECTIVES_KEY = 'communityBundlePrivateDirectives';
const LEGACY_REMOTE_DIRECTIVES_KEY = 'communityBundleDirectives';
const RULESET_CONFIG_KEY = 'rulesetConfig';

const runtime = self.browser?.runtime || self.chrome?.runtime;
const getURL = runtime?.getURL?.bind(runtime) || (p => p);
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
const guard = self.TalonBreakageGuard;
const blockHints = self.TalonBlockHintsController;
const AUTOMATION_MARK_ATTR = 'data-ubol-automation';
const AUTOMATION_STYLE_MARKER_ATTR = 'data-ubol-automation-style';
const AUTOMATION_READY_MARK_ATTR = 'data-ubol-flag-talon-automation-controller';
const shadowController = self.TalonShadowRootController;
const shadowRootsChangedEvent = shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
const shadowContentChangedEvent = shadowController?.CONTENT_CHANGED_EVENT || 'talon-shadow-content-changed';
const protectionChangedEvent = guard?.PROTECTION_CHANGED_EVENT || 'talon-protection-changed';
const DEFAULT_REAPPLY_DELAYS_MS = Object.freeze([ 0, 500, 2000, 10000, 30000 ]);
const REAPPLY_RESET_AFTER_MS = 5 * 60 * 1000;
const MAX_MISS_BACKOFF_MS = 30000;
const MAX_MUTATION_ROUTE_NODES = 32;
const MAX_TARGETS_PER_SELECTOR = 24;
const MAX_TARGETS_PER_QUERY = 48;
const MUTATION_ROUTE_DELAY_MS = 50;

const setAutomationReadyMarker = enabled => {
    const root = document.documentElement;
    if (
        root === null ||
        typeof root !== 'object' ||
        typeof root.setAttribute !== 'function'
    ) {
        return;
    }
    try {
        if ( enabled ) {
            root.setAttribute(AUTOMATION_READY_MARK_ATTR, '1');
        } else {
            root.removeAttribute(AUTOMATION_READY_MARK_ATTR);
        }
    } catch {
    }
};

if ( self.TalonAutomationController ) {
    setAutomationReadyMarker(true);
    const readiness = self.TalonAutomationController.refresh();
    self.TalonAutomationReady = readiness;
    readiness.catch(( ) => {});
    return;
}

let directivesPromise;
let remoteDirectivesPromise;
let enabledRulesetsPromise;

const normalizeRulesetId = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    return normalized === '' ? '' : normalized;
};

const normalizeRulesetIds = values => {
    if ( Array.isArray(values) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const value of values ) {
        const id = normalizeRulesetId(value);
        if ( id === '' || seen.has(id) ) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
};

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
            ));
            return remoteDirectivesPromise;
        }
    } catch (reason) {
        remoteDirectivesPromise = Promise.reject(reason);
        remoteDirectivesPromise.catch(( ) => {});
        return remoteDirectivesPromise;
    }
    remoteDirectivesPromise = new Promise((resolve, reject) => {
        try {
            storage.get(keys, bin => {
                const lastError = runtime?.lastError;
                if ( lastError ) {
                    reject(new Error(lastError.message || 'storage.get failed'));
                    return;
                }
                resolve(mergeDirectiveArrays(
                    bin?.[PUBLIC_REMOTE_DIRECTIVES_KEY],
                    bin?.[PRIVATE_REMOTE_DIRECTIVES_KEY],
                    bin?.[LEGACY_REMOTE_DIRECTIVES_KEY],
                ));
            });
        } catch (reason) {
            reject(reason);
        }
    });
    return remoteDirectivesPromise;
};

const loadDirectives = ( ) => {
    if ( directivesPromise !== undefined ) { return directivesPromise; }
    const localPromise = fetch(getURL(DIRECTIVES_PATH)).then(r => {
        if ( r.ok === false ) { throw new Error(r.statusText); }
        return r.json();
    });
    directivesPromise = Promise.all([ localPromise, loadRemoteDirectives() ])
        .then(([ localDirs, remoteDirs ]) => {
            const out = [];
            if ( Array.isArray(localDirs) ) { out.push(...localDirs); }
            if ( Array.isArray(remoteDirs) ) { out.push(...remoteDirs); }
            return out;
        });
    return directivesPromise;
};

const readEnabledRulesets = bin => {
    const hasConfig = bin !== null &&
        typeof bin === 'object' &&
        Object.prototype.hasOwnProperty.call(bin, RULESET_CONFIG_KEY);
    if ( hasConfig === false ) { return null; }
    const config = bin[RULESET_CONFIG_KEY];
    if ( config === null || typeof config !== 'object' ) { return null; }
    const enabled = Array.isArray(config.enabledRulesets)
        ? config.enabledRulesets
        : null;
    if ( enabled === null ) { return null; }
    return new Set(normalizeRulesetIds(enabled));
};

const loadEnabledRulesets = ( ) => {
    if ( enabledRulesetsPromise !== undefined ) { return enabledRulesetsPromise; }
    if ( storage?.get === undefined ) {
        enabledRulesetsPromise = Promise.resolve(null);
        return enabledRulesetsPromise;
    }
    try {
        const maybePromise = storage.get(RULESET_CONFIG_KEY);
        if ( maybePromise?.then ) {
            enabledRulesetsPromise = maybePromise.then(readEnabledRulesets);
            return enabledRulesetsPromise;
        }
    } catch (reason) {
        enabledRulesetsPromise = Promise.reject(reason);
        enabledRulesetsPromise.catch(( ) => {});
        return enabledRulesetsPromise;
    }
    enabledRulesetsPromise = new Promise((resolve, reject) => {
        try {
            storage.get(RULESET_CONFIG_KEY, bin => {
                const lastError = runtime?.lastError;
                if ( lastError ) {
                    reject(new Error(lastError.message || 'storage.get failed'));
                    return;
                }
                resolve(readEnabledRulesets(bin));
            });
        } catch (reason) {
            reject(reason);
        }
    });
    return enabledRulesetsPromise;
};

const hostname = (self.location && self.location.hostname || '').toLowerCase();
if ( hostname === '' ) {
    self.TalonAutomationReady = Promise.resolve({
        applied: false,
        directives: 0,
    });
    return;
}

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

const rulesetsMatchDirective = (directive, enabledRulesets) => {
    const requiredRulesets = normalizeRulesetIds(directive?.requiresRulesets);
    if ( requiredRulesets.length === 0 ) { return true; }
    if ( enabledRulesets instanceof Set === false ) { return false; }
    return requiredRulesets.every(id => enabledRulesets.has(id));
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
        if ( out.length >= MAX_TARGETS_PER_SELECTOR ) { break; }
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
            if ( out.length >= MAX_TARGETS_PER_QUERY ) { return out; }
        }
    }
    return out;
};

const ownedMarks = new Map();
const ownedScrollStyles = new Map();

const markApplied = (el, id) => {
    try {
        let record = ownedMarks.get(el);
        if ( record === undefined ) {
            record = {
                hadAttribute: el.getAttribute?.(AUTOMATION_MARK_ATTR) !== null,
                value: el.getAttribute?.(AUTOMATION_MARK_ATTR),
                appliedValue: '',
            };
            ownedMarks.set(el, record);
        }
        record.appliedValue = String(id || '');
        el.setAttribute(AUTOMATION_MARK_ATTR, record.appliedValue);
    } catch {
    }
};

const restoreAppliedMarkFor = element => {
    const original = ownedMarks.get(element);
    if ( original === undefined ) { return false; }
    try {
        if ( element.getAttribute?.(AUTOMATION_MARK_ATTR) === original.appliedValue ) {
            if ( original.hadAttribute ) {
                element.setAttribute(AUTOMATION_MARK_ATTR, original.value || '');
            } else {
                element.removeAttribute(AUTOMATION_MARK_ATTR);
            }
        }
    } catch {
    }
    ownedMarks.delete(element);
    return true;
};

const pruneDisconnectedAppliedMarks = ( ) => {
    for ( const element of Array.from(ownedMarks.keys()) ) {
        if ( element.isConnected !== false ) { continue; }
        restoreAppliedMarkFor(element);
    }
};

const restoreAppliedMarks = ( ) => {
    for ( const element of Array.from(ownedMarks.keys()) ) {
        restoreAppliedMarkFor(element);
    }
};

const setOwnedScrollStyle = (element, property, value) => {
    if ( element instanceof Element === false ) { return; }
    let properties = ownedScrollStyles.get(element);
    if ( properties instanceof Map === false ) {
        properties = new Map();
        ownedScrollStyles.set(element, properties);
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
    element.style.setProperty(property, value, 'important');
    record.appliedValue = element.style.getPropertyValue?.(property) || String(value);
    record.appliedPriority = element.style.getPropertyPriority?.(property) || 'important';
};

const restoreScrollStyles = ( ) => {
    for ( const [ element, properties ] of ownedScrollStyles ) {
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
    }
    ownedScrollStyles.clear();
};

const styleIdForDirective = id =>
    `ubol-automation-style-${String(id || 'directive').replace(/[^a-z0-9_-]/gi, '_')}`;

const escapeAttrValue = value => String(value || '').replace(/["\\]/g, '\\$&');

const buildHideStyleText = directive => {
    const id = directive?.id || 'directive';
    const selectors = [];
    if ( directive?.directStyle === true ) {
        if ( Array.isArray(directive.selectors) ) {
            selectors.push(...directive.selectors);
        }
        if ( directive?.fallbackAction === 'hide' && Array.isArray(directive.fallbackSelectors) ) {
            selectors.push(...directive.fallbackSelectors);
        }
    } else {
        selectors.push(`[${AUTOMATION_MARK_ATTR}="${escapeAttrValue(id)}"]`);
    }
    const dedupedSelectors = [];
    const seen = new Set();
    for ( const selector of selectors ) {
        if ( typeof selector !== 'string' ) { continue; }
        const normalized = selector.trim();
        if ( normalized === '' || seen.has(normalized) ) { continue; }
        seen.add(normalized);
        dedupedSelectors.push(normalized);
    }
    if ( dedupedSelectors.length === 0 ) { return ''; }
    return dedupedSelectors
        .map(selector => `${selector}{display:none!important;visibility:hidden!important;}`)
        .join('\n');
};

const documentStyleMap = new Map();
const shadowStyleMap = new Map();

const upsertStyleText = (style, cssText) => {
    if ( style instanceof HTMLStyleElement === false ) { return false; }
    if ( style.textContent === cssText ) { return true; }
    style.textContent = cssText;
    return true;
};

const isDocumentHideStyleConnected = style => {
    if (
        style instanceof HTMLStyleElement === false ||
        style.ownerDocument !== document ||
        style.isConnected === false
    ) {
        return false;
    }
    try {
        if ( typeof style.getRootNode === 'function' ) {
            return style.getRootNode() === document;
        }
    } catch {
        return false;
    }
    let root = style;
    while ( root?.parentNode ) { root = root.parentNode; }
    return root === document;
};

const ensureDocumentHideStyle = (styleId, cssText) => {
    let style = documentStyleMap.get(styleId) || null;
    if ( style instanceof HTMLStyleElement && isDocumentHideStyleConnected(style) === false ) {
        try { style.remove(); } catch {
        }
        documentStyleMap.delete(styleId);
        style = null;
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            if ( document.getElementById(styleId) === null ) {
                style.id = styleId;
            }
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
    if (
        style instanceof HTMLStyleElement &&
        style.parentNode !== root
    ) {
        try { style.remove(); } catch {
        }
        rootStyles.delete(styleId);
        style = null;
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
            out.set(styleIdForDirective(id), buildHideStyleText(directive));
        }
        if ( directive?.fallbackAction === 'hide' ) {
            out.set(styleIdForDirective(id), buildHideStyleText(directive));
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

let hideStyleRepairTimer;

const hasDetachedHideStyle = ( ) => {
    for ( const style of documentStyleMap.values() ) {
        if ( isDocumentHideStyleConnected(style) === false ) {
            return true;
        }
    }
    for ( const [ root, rootStyles ] of shadowStyleMap ) {
        if ( rootStyles instanceof Map === false ) { return true; }
        for ( const style of rootStyles.values() ) {
            if (
                style instanceof HTMLStyleElement === false ||
                style.parentNode !== root
            ) {
                return true;
            }
        }
    }
    return false;
};

const scheduleHideStyleRepair = ( ) => {
    if ( hideStyleRepairTimer !== undefined || activeDirectives.length === 0 ) {
        return;
    }
    if ( hasDetachedHideStyle() === false ) { return; }
    hideStyleRepairTimer = self.setTimeout(() => {
        hideStyleRepairTimer = undefined;
        syncHideStyles(activeDirectives);
    }, 0);
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
            if ( ownedMarks.has(el) ) { continue; }
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
            if ( ownedMarks.has(el) && isVisible(el) === false ) { continue; }
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
        setOwnedScrollStyle(html, 'overflow', 'auto');
    }
    if ( body && self.getComputedStyle(body).overflow === 'hidden' ) {
        setOwnedScrollStyle(body, 'overflow', 'auto');
    }
    if ( body && self.getComputedStyle(body).position === 'fixed' ) {
        setOwnedScrollStyle(body, 'position', 'static');
    }
};

const POST_ACTIONS = {
    unlockScroll,
};

const OBSERVED_ATTRIBUTE_FILTER = [ 'style', 'class', 'hidden', 'open', 'aria-hidden' ];
const directiveState = new Map();

let activeDirectives = [];
let observerConnected = false;
let shadowListenersConnected = false;
let protectionListenerConnected = false;
let storageListenerConnected = false;
let sweepTimer;
let sweepTimerAt = 0;
let refreshRunId = 0;

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
            consecutiveMisses: 0,
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
        state.consecutiveMisses = 0;
        state.lastAppliedAt = 0;
        state.nextEligibleAt = 0;
    }
    return state;
};

const recordDirectiveSuccess = (directive, currentNow = now()) => {
    const state = getDirectiveState(directive, currentNow);
    state.successfulApplies += 1;
    state.consecutiveMisses = 0;
    state.lastAppliedAt = currentNow;
    if ( hasExplicitMaxApplies(directive) ) {
        state.nextEligibleAt = 0;
        return;
    }
    state.nextEligibleAt = currentNow + getDefaultReapplyDelayMs(state.successfulApplies);
};

const recordDirectiveMiss = (directive, currentNow = now()) => {
    const state = getDirectiveState(directive, currentNow);
    state.consecutiveMisses = Math.min(16, state.consecutiveMisses + 1);
    const delay = Math.min(
        MAX_MISS_BACKOFF_MS,
        250 * (2 ** Math.min(7, state.consecutiveMisses - 1))
    );
    state.nextEligibleAt = currentNow + delay;
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
    if (
        directive?.directStyle === true &&
        directive?.action === 'hide' &&
        directive?.fallbackAction === undefined
    ) {
        return false;
    }
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
    } else {
        recordDirectiveMiss(directive, currentNow);
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

const selectorsForDirective = directive => [
    ...(Array.isArray(directive?.selectors) ? directive.selectors : []),
    ...(Array.isArray(directive?.fallbackSelectors) ? directive.fallbackSelectors : []),
];

const nodeMatchesDirective = (node, directive, includeSubtree = true) => {
    if ( node instanceof Element === false ) { return false; }
    const selectors = selectorsForDirective(directive);
    for ( const selector of selectors ) {
        try {
            if ( node.matches?.(selector) ) { return true; }
        } catch {
        }
    }
    if ( includeSubtree === false || selectors.length === 0 ) { return false; }
    try {
        // One selector query is substantially cheaper than walking the same
        // inserted subtree once for every selector in the directive.
        return node.querySelector?.(selectors.join(',')) instanceof Element;
    } catch {
    }
    return false;
};

const wakeMatchingDirectives = entries => {
    const currentNow = now();
    let earliestDelay;
    for ( const directive of activeDirectives ) {
        if (
            directive?.directStyle === true &&
            directive?.action === 'hide' &&
            directive?.fallbackAction === undefined
        ) {
            continue;
        }
        if (
            hasExplicitMaxApplies(directive) &&
            getDirectiveState(directive, currentNow).successfulApplies >= Number(directive.maxApplies)
        ) {
            continue;
        }
        if (
            entries.some(({ node, includeSubtree }) =>
                nodeMatchesDirective(node, directive, includeSubtree)
            ) === false
        ) {
            continue;
        }
        const state = getDirectiveState(directive, currentNow);
        if ( state.consecutiveMisses !== 0 ) {
            state.consecutiveMisses = 0;
            state.nextEligibleAt = 0;
        }
        const delay = Math.max(0, state.nextEligibleAt - currentNow);
        if ( earliestDelay === undefined || delay < earliestDelay ) {
            earliestDelay = delay;
        }
    }
    if ( earliestDelay !== undefined ) { scheduleSweep(earliestDelay); }
};

const wakeAllMissedDirectives = ( ) => {
    const currentNow = now();
    for ( const directive of activeDirectives ) {
        const state = getDirectiveState(directive, currentNow);
        if ( state.consecutiveMisses === 0 ) { continue; }
        state.consecutiveMisses = 0;
        state.nextEligibleAt = 0;
    }
    scheduleSweep(0);
};

let mutationRouteTimer;
let pendingMutationRouteEntries = [];
const pendingMutationRouteNodes = new Map();
let pendingMutationRouteOverflowed = false;
let pendingMutationSawRemoval = false;

const clearMutationRouteTimer = ( ) => {
    if ( mutationRouteTimer === undefined ) { return; }
    try { self.clearTimeout(mutationRouteTimer); } catch {
    }
    mutationRouteTimer = undefined;
};

const resetMutationRouting = ( ) => {
    clearMutationRouteTimer();
    pendingMutationRouteEntries = [];
    pendingMutationRouteNodes.clear();
    pendingMutationRouteOverflowed = false;
    pendingMutationSawRemoval = false;
};

const flushMutationRouting = ( ) => {
    mutationRouteTimer = undefined;
    const entries = pendingMutationRouteEntries;
    const overflowed = pendingMutationRouteOverflowed;
    const sawRemoval = pendingMutationSawRemoval;
    pendingMutationRouteEntries = [];
    pendingMutationRouteNodes.clear();
    pendingMutationRouteOverflowed = false;
    pendingMutationSawRemoval = false;

    if ( sawRemoval || overflowed ) { pruneDisconnectedAppliedMarks(); }
    if ( entries.length !== 0 ) { wakeMatchingDirectives(entries); }
    if ( overflowed ) { wakeAllMissedDirectives(); }
};

const scheduleMutationRouting = ( ) => {
    if ( mutationRouteTimer !== undefined ) { return; }
    mutationRouteTimer = self.setTimeout(flushMutationRouting, MUTATION_ROUTE_DELAY_MS);
};

const queueMutationRouteNode = (node, includeSubtree) => {
    if ( node instanceof Element === false ) { return true; }
    const existing = pendingMutationRouteNodes.get(node);
    if ( existing !== undefined ) {
        if ( includeSubtree && existing.includeSubtree === false ) {
            existing.includeSubtree = true;
        }
        return true;
    }
    if ( pendingMutationRouteEntries.length >= MAX_MUTATION_ROUTE_NODES ) {
        pendingMutationRouteOverflowed = true;
        return false;
    }
    const entry = { node, includeSubtree: includeSubtree === true };
    pendingMutationRouteNodes.set(node, entry);
    pendingMutationRouteEntries.push(entry);
    return true;
};

const domObserver = new MutationObserver(mutations => {
    if ( mutations.length === 0 ) {
        scheduleSweep();
        return;
    }
    for ( const mutation of mutations ) {
        if ( mutation.removedNodes?.length ) { pendingMutationSawRemoval = true; }
        if ( mutation.type === 'attributes' && mutation.target instanceof Element ) {
            queueMutationRouteNode(mutation.target, false);
        }
        for ( const node of mutation.addedNodes || [] ) {
            if ( queueMutationRouteNode(node, true) === false ) { break; }
        }
        if ( pendingMutationRouteOverflowed ) { break; }
    }
    if ( pendingMutationSawRemoval || pendingMutationRouteOverflowed ) {
        scheduleHideStyleRepair();
    }
    scheduleMutationRouting();
});

const onShadowRootsChanged = event => {
    if ( event?.detail?.removedRoots?.length ) {
        pruneDisconnectedAppliedMarks();
    }
    syncHideStyles(activeDirectives);
    scheduleSweep(0);
};

const onShadowContentChanged = event => {
    if ( event?.detail?.overflowed === true ) {
        pruneDisconnectedAppliedMarks();
        scheduleHideStyleRepair();
        wakeAllMissedDirectives();
        return;
    }
    const nodes = Array.isArray(event?.detail?.addedNodes)
        ? event.detail.addedNodes.filter(node => node instanceof Element)
        : [];
    if ( event?.detail?.removedNodes?.length ) {
        pendingMutationSawRemoval = true;
        scheduleHideStyleRepair();
    }
    for ( const node of nodes ) {
        if ( queueMutationRouteNode(node, true) === false ) { break; }
    }
    if ( nodes.length !== 0 || pendingMutationSawRemoval ) {
        scheduleMutationRouting();
    }
};

const onProtectionChanged = () => {
    self.TalonAutomationController?.refresh?.().catch(() => {});
};

const stop = async ({ preserveProtectionListener = false } = {}) => {
    refreshRunId += 1;
    resetMutationRouting();
    if ( observerConnected ) {
        domObserver.disconnect();
        observerConnected = false;
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
    if ( storageListenerConnected && preserveProtectionListener === false ) {
        storageEvents?.removeListener?.(onStorageChanged);
        storageListenerConnected = false;
    }
    if ( sweepTimer !== undefined ) {
        try { clearTimeout(sweepTimer); } catch { }
        sweepTimer = undefined;
    }
    if ( hideStyleRepairTimer !== undefined ) {
        try { self.clearTimeout(hideStyleRepairTimer); } catch { }
        hideStyleRepairTimer = undefined;
    }
    sweepTimerAt = 0;
    clearHideStyles();
    restoreAppliedMarks();
    restoreScrollStyles();
    activeDirectives = [];
    directiveState.clear();
    if ( preserveProtectionListener === false ) {
        setAutomationReadyMarker(false);
    }
};

const refresh = async ( ) => {
    const runId = ++refreshRunId;
    setAutomationReadyMarker(true);
    connectStorageListener();
    remoteDirectivesPromise = undefined;
    directivesPromise = undefined;
    enabledRulesetsPromise = undefined;

    await guard?.whenReady?.();
    if ( runId !== refreshRunId ) { return { applied: false, directives: 0 }; }
    if ( protectionListenerConnected === false ) {
        self.addEventListener?.(protectionChangedEvent, onProtectionChanged);
        protectionListenerConnected = true;
    }
    if ( guard?.shouldRunSubsystem?.('automation') === false ) {
        await stop({ preserveProtectionListener: true });
        return { applied: false, directives: 0 };
    }

    const directives = await loadDirectives();
    if ( runId !== refreshRunId ) { return { applied: false, directives: 0 }; }
    const hostMatchedDirectives = directives.filter(hostMatchesDirective);
    const requiresRulesetGate = hostMatchedDirectives.some(directive =>
        normalizeRulesetIds(directive?.requiresRulesets).length !== 0
    );
    const enabledRulesets = requiresRulesetGate
        ? await loadEnabledRulesets()
        : null;
    if ( runId !== refreshRunId ) { return { applied: false, directives: 0 }; }
    const nextActiveDirectives = hostMatchedDirectives
        .filter(directive => rulesetsMatchDirective(directive, enabledRulesets))
        .map(directive => ({ ...directive }))
        .filter(directive => guard?.shouldAllowDirective?.(directive) !== false);

    resetMutationRouting();
    restoreAppliedMarks();
    restoreScrollStyles();
    activeDirectives = nextActiveDirectives;
    directiveState.clear();
    if ( activeDirectives.length === 0 ) {
        clearHideStyles();
        if ( observerConnected ) {
            domObserver.disconnect();
            observerConnected = false;
        }
        if ( shadowListenersConnected ) {
            self.removeEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
            self.removeEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
            shadowListenersConnected = false;
        }
        return { applied: false, directives: 0 };
    }

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
    if ( shadowListenersConnected === false ) {
        self.addEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
        self.addEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
        shadowListenersConnected = true;
    }
    return { applied: true, directives: activeDirectives.length };
};

self.TalonAutomationController = {
    refresh,
    stop,
};
setAutomationReadyMarker(true);

const storageEvents =
    self.browser?.storage?.onChanged ||
    self.chrome?.storage?.onChanged;
const onStorageChanged = (changes, areaName) => {
    if ( areaName !== 'local' ) { return; }
    if ( changes instanceof Object === false ) { return; }
    const relevantKeys = [
        RULESET_CONFIG_KEY,
        PUBLIC_REMOTE_DIRECTIVES_KEY,
        PRIVATE_REMOTE_DIRECTIVES_KEY,
        LEGACY_REMOTE_DIRECTIVES_KEY,
    ];
    if ( relevantKeys.some(key => changes[key] !== undefined) === false ) { return; }
    const readiness = self.TalonAutomationController.refresh();
    self.TalonAutomationReady = readiness;
    readiness.catch(( ) => {});
};
const connectStorageListener = () => {
    if ( storageListenerConnected ) { return; }
    storageEvents?.addListener?.(onStorageChanged);
    storageListenerConnected = true;
};
connectStorageListener();

const readiness = self.TalonAutomationController.refresh();
self.TalonAutomationReady = readiness;
readiness.catch(( ) => {});

})();

self.TalonAutomationReady;
