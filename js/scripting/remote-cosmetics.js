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
const shadowRootsChangedEvent = shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
if ( runtime?.sendMessage === undefined || storage?.get === undefined ) { return; }

if ( self.TalonRemoteCosmeticsController ) {
    self.TalonRemoteCosmeticsController.refresh().catch(( ) => {});
    return;
}

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
        if ( currentSelectors.length !== 0 &&
            (currentLength + selectorLength) > MAX_CHUNK_CSS_LENGTH ) {
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
const DOCUMENT_STYLE_ID = 'talon-remote-cosmetics-style';

let documentStyle;
let currentCssText = '';
const shadowStyleMap = new Map();

const getDocumentStyleParent = ( ) =>
    document.head || document.documentElement || document;

const upsertStyleText = (style, cssText) => {
    if ( style instanceof HTMLStyleElement === false ) { return false; }
    if ( style.textContent === cssText ) { return true; }
    style.textContent = cssText;
    return true;
};

const ensureDocumentStyle = cssText => {
    if ( cssText === '' ) { return null; }
    let style = documentStyle;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.getElementById(DOCUMENT_STYLE_ID);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.id = DOCUMENT_STYLE_ID;
            style.setAttribute(STYLE_MARKER_ATTR, '1');
            const parent = getDocumentStyleParent();
            parent?.append?.(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    documentStyle = style;
    upsertStyleText(style, cssText);
    return style;
};

const ensureShadowRootStyle = (root, cssText) => {
    if ( root instanceof DocumentFragment === false ) { return null; }
    let style = shadowStyleMap.get(root) || null;
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = root.querySelector?.(`style[${STYLE_MARKER_ATTR}="1"]`) || null;
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) {
        try {
            style = document.createElement('style');
            style.setAttribute(STYLE_MARKER_ATTR, '1');
            root.append?.(style);
        } catch {
            style = null;
        }
    }
    if ( style instanceof HTMLStyleElement === false ) { return null; }
    shadowStyleMap.set(root, style);
    upsertStyleText(style, cssText);
    return style;
};

const removeDocumentStyle = ( ) => {
    if ( documentStyle instanceof HTMLStyleElement ) {
        try { documentStyle.remove(); } catch {
        }
    }
    documentStyle = undefined;
};

const removeShadowStyle = root => {
    const style = shadowStyleMap.get(root);
    if ( style instanceof HTMLStyleElement ) {
        try { style.remove(); } catch {
        }
    }
    shadowStyleMap.delete(root);
};

const syncShadowStyles = ( ) => {
    if ( currentCssText === '' ) {
        for ( const root of Array.from(shadowStyleMap.keys()) ) {
            removeShadowStyle(root);
        }
        return;
    }
    const roots = shadowController?.enumerateRoots?.() || [];
    const activeRoots = new Set();
    for ( const root of roots ) {
        if ( root instanceof DocumentFragment === false ) { continue; }
        activeRoots.add(root);
        ensureShadowRootStyle(root, currentCssText);
    }
    for ( const root of Array.from(shadowStyleMap.keys()) ) {
        if ( activeRoots.has(root) ) { continue; }
        removeShadowStyle(root);
    }
};

const clearAppliedCss = async ( ) => {
    currentCssText = '';
    removeDocumentStyle();
    syncShadowStyles();
};

const applyCurrentCosmetics = async ( ) => {
    await guard?.whenReady?.();
    if ( guard?.shouldRunSubsystem?.('remoteCosmetics') === false ) {
        await clearAppliedCss();
        await sendMessage({
            what: 'recordRemoteCosmeticsRuntimeStats',
            hostname,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        });
        return {
            applied: false,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        };
    }

    const cosmetics = await getCosmetics();
    if ( cosmetics instanceof Object === false ) {
        await clearAppliedCss();
        await sendMessage({
            what: 'recordRemoteCosmeticsRuntimeStats',
            hostname,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        });
        return {
            applied: false,
            chunkCount: 0,
            selectorCount: 0,
            hostSpecificSelectorCount: 0,
            droppedAtApply: 0,
        };
    }

    const selectors = [];
    const hostSpecific = new Set();

    if ( Array.isArray(cosmetics.all) ) {
        selectors.push(...cosmetics.all);
    }

    const hosts = cosmetics.hosts;
    if ( hosts instanceof Object ) {
        for ( const [ hostPattern, hostSelectors ] of Object.entries(hosts) ) {
            const exactHostPattern = isExactHostPattern(hostPattern);
            if (
                patternMatchesHostname(hostPattern, hostname) === false &&
                (
                    exactHostPattern ||
                    patternMatchesHostname(hostPattern, pageDomain) === false
                )
            ) {
                continue;
            }
            if ( Array.isArray(hostSelectors) ) {
                selectors.push(...hostSelectors);
                for ( const selector of hostSelectors ) {
                    if ( typeof selector !== 'string' ) { continue; }
                    hostSpecific.add(selector.trim());
                }
            }
        }
    }

    const normalized = normalizeSelectors(selectors).filter(selector =>
        guard?.shouldAllowRemoteCosmeticSelector?.(selector, {
            hostSpecific: hostSpecific.has(selector),
        }) !== false
    );
    const { cssText, chunks, droppedAtApply } = buildCssChunks(normalized);

    if ( currentCssText !== cssText ) {
        currentCssText = cssText;
        if ( cssText === '' ) {
            await clearAppliedCss();
        } else {
            ensureDocumentStyle(cssText);
            shadowController?.rescanNow?.();
            syncShadowStyles();
        }
    }

    const hostSpecificNormalized = normalized.filter(selector => hostSpecific.has(selector));
    await sendMessage({
        what: 'recordRemoteCosmeticsRuntimeStats',
        hostname,
        chunkCount: chunks.length,
        selectorCount: normalized.length,
        hostSpecificSelectorCount: hostSpecificNormalized.length,
        droppedAtApply,
    });

    if ( hostSpecificNormalized.length >= 3 && guard?.isProtectedSurface?.() !== true ) {
        await sendMessage({
            what: 'promoteGenericHigh',
            hostname: pageDomain || hostname,
        });
    }

    return {
        applied: chunks.length !== 0,
        chunkCount: chunks.length,
        selectorCount: normalized.length,
        hostSpecificSelectorCount: hostSpecificNormalized.length,
        droppedAtApply,
    };
};

self.TalonRemoteCosmeticsController = {
    refresh() {
        return applyCurrentCosmetics();
    },
    clear() {
        return clearAppliedCss();
    },
    stop() {
        return clearAppliedCss();
    },
};

self.addEventListener?.(shadowRootsChangedEvent, ( ) => {
    if ( currentCssText === '' ) { return; }
    syncShadowStyles();
});

self.TalonRemoteCosmeticsController.refresh().catch(( ) => {});

})();

void 0;
