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
if ( runtime?.sendMessage === undefined || storage?.get === undefined ) { return; }

if ( self.TalonRemoteCosmeticsController ) { return; }

const hostname = (self.location?.hostname || '').toLowerCase();
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
    } catch {
    }
    return new Promise(resolve => {
        try {
            storage.get(STORAGE_KEY, bin => resolve(bin?.[STORAGE_KEY]));
        } catch {
            resolve(undefined);
        }
    });
};

const normalizeSelectors = selectors => {
    const out = [];
    const seen = new Set();
    for ( const sel of selectors ) {
        if ( typeof sel !== 'string' ) { continue; }
        const s = sel.trim();
        if ( s === '' || s.length > 256 ) { continue; }
        if ( seen.has(s) ) { continue; }
        seen.add(s);
        out.push(s);
    }
    return out;
};

const buildCssChunks = selectors => {
    const chunks = [];
    let droppedAtApply = 0;
    let currentSelectors = [];
    let currentLength = CSS_RULE_SUFFIX.length;

    const flush = ( ) => {
        if ( currentSelectors.length === 0 ) { return; }
        chunks.push(`${currentSelectors.join(',')}${CSS_RULE_SUFFIX}`);
        currentSelectors = [];
        currentLength = CSS_RULE_SUFFIX.length;
    };

    for ( const selector of selectors ) {
        if ( typeof selector !== 'string' || selector === '' ) { continue; }
        const selectorLength = selector.length + (currentSelectors.length === 0 ? 0 : 1);
        if (
            currentSelectors.length !== 0 &&
            (currentLength + selectorLength) > MAX_CHUNK_CSS_LENGTH
        ) {
            flush();
        }
        if ( (CSS_RULE_SUFFIX.length + selector.length) > MAX_CHUNK_CSS_LENGTH ) {
            droppedAtApply += 1;
            continue;
        }
        currentSelectors.push(selector);
        currentLength += selectorLength;
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
        installed: false,
    } ],
    [ SCOPE_HOST, {
        cssText: '',
        documentStyle: undefined,
        shadowStyleMap: new Map(),
        installed: false,
    } ],
]);

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

const getScopeStyleSelector = scope =>
    `style[${STYLE_MARKER_ATTR}="1"][${STYLE_SCOPE_ATTR}="${scope}"]`;

const ensureDocumentStyle = (scope, cssText) => {
    if ( cssText === '' ) { return null; }
    const scopeState = getScopeState(scope);
    const scopeConfig = SCOPE_CONFIG[scope];
    if ( scopeState === null || scopeConfig === undefined ) { return null; }
    let style = scopeState.documentStyle;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.getElementById(scopeConfig.documentStyleId);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.querySelector?.(getScopeStyleSelector(scope)) || null;
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.id = scopeConfig.documentStyleId;
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

const ensureShadowRootStyle = (scope, root, cssText) => {
    if ( root instanceof DocumentFragment === false ) { return null; }
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return null; }
    let style = scopeState.shadowStyleMap.get(root) || null;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = root.querySelector?.(getScopeStyleSelector(scope)) || null;
        } catch {
            style = null;
        }
    }
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
};

const syncShadowStyles = scope => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return; }
    if ( scopeState.cssText === '' ) {
        for ( const root of Array.from(scopeState.shadowStyleMap.keys()) ) {
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
    for ( const root of Array.from(scopeState.shadowStyleMap.keys()) ) {
        if ( activeRoots.has(root) ) { continue; }
        removeShadowStyle(scope, root);
    }
};

const clearAppliedCss = scope => {
    const scopeState = getScopeState(scope);
    if ( scopeState === null ) { return Promise.resolve(); }
    scopeState.cssText = '';
    removeDocumentStyle(scope);
    syncShadowStyles(scope);
    return Promise.resolve();
};

const sendRuntimeStats = (scope, {
    chunkCount = 0,
    selectorCount = 0,
    hostSpecificSelectorCount = 0,
    droppedAtApply = 0,
} = {}) => sendMessage({
    what: 'recordRemoteCosmeticsRuntimeStats',
    hostname,
    laneScope: scope,
    chunkCount,
    selectorCount,
    hostSpecificSelectorCount,
    droppedAtApply,
});

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

    await guard?.whenReady?.();
    if ( guard?.shouldRunSubsystem?.('remoteCosmetics') === false ) {
        await clearAppliedCss(scope);
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
    if ( cosmetics instanceof Object === false ) {
        await clearAppliedCss(scope);
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
            await clearAppliedCss(scope);
        } else {
            ensureDocumentStyle(scope, cssText);
            shadowController?.rescanNow?.();
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

    if ( scope === SCOPE_HOST && hostSpecificNormalized.length !== 0 ) {
        blockHints?.noteSelectorMatches?.(hostSpecificNormalized, {
            ancestors: 1,
        });
    }

    if (
        scope === SCOPE_HOST &&
        hostSpecificNormalized.length >= 3 &&
        guard?.isProtectedSurface?.() !== true
    ) {
        await sendMessage({
            what: 'promoteGenericHigh',
            hostname: pageDomain || hostname,
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

const shadowRootsChangedListener = ( ) => {
    for ( const [ scope, state ] of scopeStates ) {
        if ( state.cssText === '' ) { continue; }
        syncShadowStyles(scope);
    }
};

self.addEventListener?.(shadowRootsChangedEvent, shadowRootsChangedListener);

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
