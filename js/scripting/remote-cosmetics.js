/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_remoteCosmetics() {

const STORAGE_KEY = 'communityBundleCosmetics';
const MAX_CHUNK_CSS_LENGTH = 110000;
const CSS_RULE_SUFFIX = '{display:none!important;visibility:hidden!important;}';

const runtime = self.browser?.runtime || self.chrome?.runtime;
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
const guard = self.TalonBreakageGuard;
const shadowController = self.TalonShadowRootController;
const blockHints = self.TalonBlockHintsController;
const shadowRootsChangedEvent =
    shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
const protectionChangedEvent =
    guard?.PROTECTION_CHANGED_EVENT || 'talon-protection-changed';
if ( runtime?.sendMessage === undefined || storage?.get === undefined ) { return; }

if ( self.TalonRemoteCosmeticsController ) { return; }

const hostname = (() => {
    const hostnameFrom = value => {
        if (
            typeof value !== 'string' ||
            value === '' ||
            value.length > 2048
        ) { return ''; }
        try {
            const parsed = new URL(value);
            if ( parsed.protocol === 'http:' || parsed.protocol === 'https:' ) {
                return parsed.hostname.toLowerCase();
            }
            if (
                (parsed.protocol === 'blob:' || parsed.protocol === 'filesystem:') &&
                /^https?:\/\//i.test(parsed.origin)
            ) {
                return new URL(parsed.origin).hostname.toLowerCase();
            }
        } catch {
        }
        return '';
    };
    const candidates = [
        self.location?.origin,
        self.location?.href,
        document.referrer,
        ...Array.from(self.location?.ancestorOrigins || []),
    ];
    for ( const candidate of candidates ) {
        const resolved = hostnameFrom(candidate);
        if ( resolved !== '' ) { return resolved; }
    }
    try {
        return hostnameFrom(self.opener?.location?.origin);
    } catch {
    }
    return '';
})();
if ( hostname === '' ) { return; }

const registrableDomain = hostname => {
    const resolved = guard?.registrableDomain?.(hostname);
    if ( typeof resolved === 'string' && resolved !== '' ) { return resolved; }
    if ( typeof hostname !== 'string' ) { return ''; }
    return hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
};
const pageDomain = registrableDomain(hostname);

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

const isExactHostPattern = value => {
    const delegated = guard?.isExactHostPattern;
    if ( typeof delegated === 'function' ) {
        return delegated(value) === true;
    }
    return normalizeScopedHostPattern(value).startsWith('=');
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

const sendMessage = message => {
    try {
        return runtime.sendMessage(message).catch(( ) => {});
    } catch {
    }
    return Promise.resolve();
};

const getCosmetics = ( ) => {
    try {
        const maybePromise = storage.get(STORAGE_KEY);
        if ( maybePromise?.then ) {
            return maybePromise.then(bin => bin?.[STORAGE_KEY]);
        }
    } catch (reason) {
        return Promise.reject(reason);
    }
    return new Promise((resolve, reject) => {
        try {
            storage.get(STORAGE_KEY, bin => {
                const lastError = runtime?.lastError;
                if ( lastError ) {
                    reject(new Error(lastError.message || 'storage.get failed'));
                    return;
                }
                resolve(bin?.[STORAGE_KEY]);
            });
        } catch (reason) {
            reject(reason);
        }
    });
};

const UNSAFE_REMOTE_PSEUDO_RE = /:(?:has|visited|target|focus(?:-within|-visible)?|checked|indeterminate|valid|invalid|user-valid|user-invalid)\b/i;

const isSafeRemoteSelector = selector => {
    if (
        selector === '' ||
        selector.length > 256 ||
        /[\u0000-\u001F\u007F{};@]/.test(selector) ||
        UNSAFE_REMOTE_PSEUDO_RE.test(selector)
    ) {
        return false;
    }
    const combinatorCount = (selector.match(/[>+~]|\s+(?=[.#[:*a-z])/gi) || []).length;
    const pseudoCount = (selector.match(/:{1,2}[a-z-]+/gi) || []).length;
    const attributeCount = (selector.match(/\[/g) || []).length;
    if ( combinatorCount > 8 || pseudoCount > 8 || attributeCount > 12 ) {
        return false;
    }
    try {
        const probe = document.createElement('div');
        probe.matches(selector);
    } catch {
        return false;
    }
    return true;
};

const normalizeSelectors = selectors => {
    const out = [];
    const seen = new Set();
    for ( const sel of selectors ) {
        if ( typeof sel !== 'string' ) { continue; }
        const s = sel.trim();
        if ( isSafeRemoteSelector(s) === false ) { continue; }
        if ( seen.has(s) ) { continue; }
        seen.add(s);
        out.push(s);
    }
    return out;
};

const buildCssChunks = selectors => {
    const chunks = [];
    let droppedAtApply = 0;
    let currentRules = [];
    let currentLength = 0;

    const flush = ( ) => {
        if ( currentRules.length === 0 ) { return; }
        chunks.push(currentRules.join('\n'));
        currentRules = [];
        currentLength = 0;
    };

    for ( const selector of selectors ) {
        if ( typeof selector !== 'string' || selector === '' ) { continue; }
        const rule = `${selector}${CSS_RULE_SUFFIX}`;
        const ruleLength = rule.length + (currentRules.length === 0 ? 0 : 1);
        if (
            currentRules.length !== 0 &&
            (currentLength + ruleLength) > MAX_CHUNK_CSS_LENGTH
        ) {
            flush();
        }
        if ( rule.length > MAX_CHUNK_CSS_LENGTH ) {
            droppedAtApply += 1;
            continue;
        }
        currentRules.push(rule);
        currentLength += ruleLength;
    }

    flush();

    return {
        chunks,
        cssText: chunks.join('\n'),
        droppedAtApply,
    };
};

const STYLE_MARKER_ATTR = 'data-talon-remote-cosmetics';
const STYLE_SCOPE_ATTR = 'data-talon-remote-cosmetics-scope';
const SCOPE_GLOBAL = 'global';
const SCOPE_HOST = 'host';
const SCOPE_CONFIG = Object.freeze({
    [SCOPE_GLOBAL]: {
        documentStyleId: 'talon-remote-cosmetics-global-style',
    },
    [SCOPE_HOST]: {
        documentStyleId: 'talon-remote-cosmetics-host-style',
    },
});

const scopeStates = new Map([
    [ SCOPE_GLOBAL, {
        cssText: '',
        documentStyle: undefined,
        shadowStyleMap: new Map(),
        sharedSheet: undefined,
        sharedSheetCssText: '',
        adoptedRoots: new Set(),
        installed: false,
        generation: 0,
    } ],
    [ SCOPE_HOST, {
        cssText: '',
        documentStyle: undefined,
        shadowStyleMap: new Map(),
        sharedSheet: undefined,
        sharedSheetCssText: '',
        adoptedRoots: new Set(),
        installed: false,
        generation: 0,
    } ],
]);
const runtimeStatsByScope = new Map();

const getScopeState = scope => scopeStates.get(scope) || null;
const isValidScope = scope => scope === SCOPE_GLOBAL || scope === SCOPE_HOST;

const getDocumentStyleParent = ( ) =>
    document.head || document.documentElement || document;

const upsertStyleText = (style, cssText) => {
    if ( style instanceof HTMLStyleElement === false ) { return false; }
    if ( style.textContent === cssText ) { return true; }
    style.textContent = cssText;
    return true;
};

const ensureDocumentStyle = (scope, cssText) => {
    if ( cssText === '' ) { return null; }
    const scopeState = getScopeState(scope);
    const scopeConfig = SCOPE_CONFIG[scope];
    if ( scopeState === null || scopeConfig === undefined ) { return null; }
    let style = scopeState.documentStyle;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            if ( document.getElementById(scopeConfig.documentStyleId) === null ) {
                style.id = scopeConfig.documentStyleId;
            }
            style.setAttribute(STYLE_MARKER_ATTR, '1');
            style.setAttribute(STYLE_SCOPE_ATTR, scope);
            const parent = getDocumentStyleParent();
            parent?.append?.(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    scopeState.documentStyle = style;
    upsertStyleText(style, cssText);
    return style;
};

const ensureSharedSheet = (scope, cssText) => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null || typeof self.CSSStyleSheet !== 'function' ) {
        return null;
    }
    let sheet = scopeState.sharedSheet;
    if ( sheet === undefined ) {
        try { sheet = new self.CSSStyleSheet(); } catch {
            return null;
        }
        scopeState.sharedSheet = sheet;
    }
    if ( scopeState.sharedSheetCssText !== cssText ) {
        try {
            sheet.replaceSync(cssText);
            scopeState.sharedSheetCssText = cssText;
        } catch {
            // Keep ownership cleanup possible if a browser rejects an update
            // (for example under stylesheet resource pressure). An orphaned
            // adopted sheet would otherwise keep stale selectors active.
            for ( const root of scopeState.adoptedRoots ) {
                try {
                    root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets || [])
                        .filter(candidate => candidate !== sheet);
                } catch {
                }
            }
            scopeState.adoptedRoots.clear();
            scopeState.sharedSheet = undefined;
            scopeState.sharedSheetCssText = '';
            return null;
        }
    }
    return sheet;
};

const ensureShadowRootStyle = (scope, root, cssText) => {
    if ( root instanceof DocumentFragment === false ) { return null; }
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return null; }
    const sharedSheet = ensureSharedSheet(scope, cssText);
    if ( sharedSheet !== null && 'adoptedStyleSheets' in root ) {
        try {
            const current = Array.from(root.adoptedStyleSheets || []);
            if ( current.includes(sharedSheet) === false ) {
                root.adoptedStyleSheets = [ ...current, sharedSheet ];
            }
            scopeState.adoptedRoots.add(root);
            const oldStyle = scopeState.shadowStyleMap.get(root);
            if ( oldStyle instanceof HTMLStyleElement ) { oldStyle.remove(); }
            scopeState.shadowStyleMap.delete(root);
            return sharedSheet;
        } catch {
        }
    }
    let style = scopeState.shadowStyleMap.get(root) || null;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.setAttribute(STYLE_MARKER_ATTR, '1');
            style.setAttribute(STYLE_SCOPE_ATTR, scope);
            root.append?.(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    scopeState.shadowStyleMap.set(root, style);
    upsertStyleText(style, cssText);
    return style;
};

const removeDocumentStyle = scope => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return; }
    if ( scopeState.documentStyle instanceof HTMLStyleElement ) {
        try { scopeState.documentStyle.remove(); } catch {
        }
    }
    scopeState.documentStyle = undefined;
};

const removeShadowStyle = (scope, root) => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return; }
    const style = scopeState.shadowStyleMap.get(root);
    if ( style instanceof HTMLStyleElement ) {
        try { style.remove(); } catch {
        }
    }
    scopeState.shadowStyleMap.delete(root);
    if ( scopeState.adoptedRoots.has(root) && scopeState.sharedSheet !== undefined ) {
        try {
            root.adoptedStyleSheets = Array.from(root.adoptedStyleSheets || [])
                .filter(sheet => sheet !== scopeState.sharedSheet);
        } catch {
        }
        scopeState.adoptedRoots.delete(root);
    }
};

const syncShadowStyles = scope => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return; }
    if ( scopeState.cssText === '' ) {
        const appliedRoots = new Set([
            ...scopeState.shadowStyleMap.keys(),
            ...scopeState.adoptedRoots,
        ]);
        for ( const root of appliedRoots ) {
            removeShadowStyle(scope, root);
        }
        return;
    }
    const roots = shadowController?.enumerateRoots?.() || [];
    const activeRoots = new Set();
    for ( const root of roots ) {
        if ( root instanceof DocumentFragment === false ) { continue; }
        activeRoots.add(root);
        ensureShadowRootStyle(scope, root, scopeState.cssText);
    }
    const appliedRoots = new Set([
        ...scopeState.shadowStyleMap.keys(),
        ...scopeState.adoptedRoots,
    ]);
    for ( const root of appliedRoots ) {
        if ( activeRoots.has(root) ) { continue; }
        removeShadowStyle(scope, root);
    }
};

const clearAppliedCss = (scope, { invalidate = true } = {}) => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return Promise.resolve(); }
    if ( invalidate ) { scopeState.generation += 1; }
    scopeState.cssText = '';
    runtimeStatsByScope.delete(scope);
    removeDocumentStyle(scope);
    syncShadowStyles(scope);
    scopeState.sharedSheet = undefined;
    scopeState.sharedSheetCssText = '';
    return Promise.resolve();
};

const sendRuntimeStats = (scope, {
    chunkCount = 0,
    selectorCount = 0,
    hostSpecificSelectorCount = 0,
    droppedAtApply = 0,
} = {}) => {
    const nextStats = {
        chunkCount,
        selectorCount,
        hostSpecificSelectorCount,
        droppedAtApply,
    };
    const previous = runtimeStatsByScope.get(scope);
    if (
        previous?.chunkCount === nextStats.chunkCount &&
        previous?.selectorCount === nextStats.selectorCount &&
        previous?.hostSpecificSelectorCount === nextStats.hostSpecificSelectorCount &&
        previous?.droppedAtApply === nextStats.droppedAtApply
    ) {
        return Promise.resolve();
    }
    runtimeStatsByScope.set(scope, nextStats);
    sendMessage({
        what: 'recordRemoteCosmeticsRuntimeStats',
        hostname,
        laneScope: scope,
        ...nextStats,
    }).catch(() => {});
    return Promise.resolve();
};

const resolveScopeSelectors = (scope, cosmetics) => {
    const selectors = [];
    const hostSpecific = new Set();

    if ( scope === SCOPE_GLOBAL && Array.isArray(cosmetics.all) ) {
        selectors.push(...cosmetics.all);
    }

    const hosts = cosmetics.hosts;
    if ( hosts instanceof Object ) {
        for ( const [ hostPattern, hostSelectors ] of Object.entries(hosts) ) {
            if ( Array.isArray(hostSelectors) === false || hostSelectors.length === 0 ) { continue; }
            const exactHostPattern = isExactHostPattern(hostPattern);
            if ( scope === SCOPE_GLOBAL && exactHostPattern ) { continue; }
            if ( scope === SCOPE_HOST && exactHostPattern === false ) { continue; }
            if (
                patternMatchesHostname(hostPattern, hostname) === false &&
                (
                    exactHostPattern ||
                    patternMatchesHostname(hostPattern, pageDomain) === false
                )
            ) {
                continue;
            }
            selectors.push(...hostSelectors);
            if ( scope !== SCOPE_HOST ) { continue; }
            for ( const selector of hostSelectors ) {
                if ( typeof selector !== 'string' ) { continue; }
                hostSpecific.add(selector.trim());
            }
        }
    }

    return {
        selectors,
        hostSpecific,
    };
};

const applyScopeCosmetics = async scope => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) {
        return {
            applied: false,
            laneScope: scope,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        };
    }
    const generation = ++scopeState.generation;

    await guard?.whenReady?.();
    if ( generation !== scopeState.generation ) {
        return { applied: false, laneScope: scope, stale: true };
    }
    if ( guard?.shouldRunSubsystem?.('remoteCosmetics') === false ) {
        await clearAppliedCss(scope, { invalidate: false });
        await sendRuntimeStats(scope);
        return {
            applied: false,
            laneScope: scope,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        };
    }

    const cosmetics = await getCosmetics();
    if ( generation !== scopeState.generation ) {
        return { applied: false, laneScope: scope, stale: true };
    }
    if ( cosmetics instanceof Object === false ) {
        await clearAppliedCss(scope, { invalidate: false });
        await sendRuntimeStats(scope);
        return {
            applied: false,
            laneScope: scope,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        };
    }

    const { selectors, hostSpecific } = resolveScopeSelectors(scope, cosmetics);
    const normalized = normalizeSelectors(selectors).filter(selector =>
        guard?.shouldAllowRemoteCosmeticSelector?.(selector, {
            hostSpecific: scope === SCOPE_HOST && hostSpecific.has(selector),
        }) !== false
    );
    const { cssText, chunks, droppedAtApply } = buildCssChunks(normalized);

    if ( scopeState.cssText !== cssText ) {
        scopeState.cssText = cssText;
        if ( cssText === '' ) {
            await clearAppliedCss(scope, { invalidate: false });
        } else {
            ensureDocumentStyle(scope, cssText);
            syncShadowStyles(scope);
        }
    }

    const hostSpecificNormalized = scope === SCOPE_HOST
        ? normalized.filter(selector => hostSpecific.has(selector))
        : [];
    await sendRuntimeStats(scope, {
        chunkCount: chunks.length,
        selectorCount: normalized.length,
        hostSpecificSelectorCount: hostSpecificNormalized.length,
        droppedAtApply,
    });
    if ( generation !== scopeState.generation ) {
        return { applied: false, laneScope: scope, stale: true };
    }

    if ( scope === SCOPE_HOST && hostSpecificNormalized.length !== 0 ) {
        blockHints?.noteSelectorMatches?.(hostSpecificNormalized, {
            ancestors: 1,
        });
    }

    return {
        applied: chunks.length !== 0,
        laneScope: scope,
        chunkCount: chunks.length,
        selectorCount: normalized.length,
        hostSpecificSelectorCount: hostSpecificNormalized.length,
        droppedAtApply,
    };
};

const refreshScopes = scopes => Promise.all(scopes.map(scope => applyScopeCosmetics(scope)));

const shadowRootsChangedListener = event => {
    const addedRoots = Array.isArray(event?.detail?.addedRoots)
        ? event.detail.addedRoots
        : null;
    const removedRoots = Array.isArray(event?.detail?.removedRoots)
        ? event.detail.removedRoots
        : [];
    for ( const [ scope, state ] of scopeStates ) {
        if ( state.cssText === '' ) { continue; }
        if ( addedRoots === null ) {
            syncShadowStyles(scope);
            continue;
        }
        for ( const root of removedRoots ) {
            removeShadowStyle(scope, root);
        }
        for ( const root of addedRoots ) {
            if ( root instanceof DocumentFragment === false ) { continue; }
            ensureShadowRootStyle(scope, root, state.cssText);
        }
    }
};

const protectionChangedListener = () => {
    self.TalonRemoteCosmeticsController?.refresh?.().catch(() => {});
};

self.addEventListener?.(shadowRootsChangedEvent, shadowRootsChangedListener);
self.addEventListener?.(protectionChangedEvent, protectionChangedListener);

self.TalonRemoteCosmeticsController = {
    install(options = {}) {
        const scope = isValidScope(options?.scope) ? options.scope : '';
        if ( scope === '' ) { return Promise.resolve([]); }
        const scopeState = getScopeState(scope);
        if ( scopeState !== null ) {
            scopeState.installed = true;
        }
        return applyScopeCosmetics(scope);
    },
    refresh(options = {}) {
        const scope = isValidScope(options?.scope) ? options.scope : '';
        if ( scope !== '' ) {
            return applyScopeCosmetics(scope);
        }
        const scopes = Array.from(scopeStates.entries())
            .filter(([, state]) => state.installed)
            .map(([name]) => name);
        return refreshScopes(scopes);
    },
    clear(options = {}) {
        const scope = isValidScope(options?.scope) ? options.scope : '';
        if ( scope !== '' ) {
            return clearAppliedCss(scope);
        }
        return Promise.all(Array.from(scopeStates.keys()).map(clearAppliedCss));
    },
    stop(options = {}) {
        const scope = isValidScope(options?.scope) ? options.scope : '';
        if ( scope !== '' ) {
            const scopeState = getScopeState(scope);
            if ( scopeState !== null ) {
                scopeState.installed = false;
            }
            return clearAppliedCss(scope);
        }
        self.removeEventListener?.(shadowRootsChangedEvent, shadowRootsChangedListener);
        self.removeEventListener?.(protectionChangedEvent, protectionChangedListener);
        for ( const [, state] of scopeStates ) {
            state.installed = false;
        }
        return Promise.all(Array.from(scopeStates.keys()).map(clearAppliedCss)).then(() => {
            try {
                delete self.TalonRemoteCosmeticsController;
            } catch {
                self.TalonRemoteCosmeticsController = undefined;
            }
            return true;
        });
    },
};

})();

void 0;
