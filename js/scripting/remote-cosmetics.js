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

const patternMatchesHostname = (pattern, hn) => {
    if ( typeof pattern !== 'string' ) { return false; }
    const p = pattern.toLowerCase();
    if ( p === '*' || p === 'all-urls' ) { return true; }
    if ( p.startsWith('*.') ) {
        const bare = p.slice(2);
        return hn === bare || hn.endsWith(`.${bare}`);
    }
    if ( p.endsWith('.*') ) {
        const bare = p.slice(0, -2);
        return hn === bare || hn.startsWith(`${bare}.`);
    }
    return hn === p || hn.endsWith(`.${p}`);
};

const sendMessage = message => {
    try {
        return runtime.sendMessage(message).catch(( ) => {});
    } catch {
    }
    return Promise.resolve();
};

const insertCSS = css => sendMessage({ what: 'insertCSS', css });
const removeCSS = css => sendMessage({ what: 'removeCSS', css });

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

    return { chunks, droppedAtApply };
};

let currentCssChunks = [];

const clearAppliedCss = async ( ) => {
    if ( currentCssChunks.length === 0 ) { return; }
    const removeChunks = currentCssChunks.slice();
    currentCssChunks = [];
    await Promise.all(removeChunks.map(css => removeCSS(css)));
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
            if (
                patternMatchesHostname(hostPattern, hostname) === false &&
                patternMatchesHostname(hostPattern, pageDomain) === false
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
    const { chunks, droppedAtApply } = buildCssChunks(normalized);

    if ( JSON.stringify(currentCssChunks) !== JSON.stringify(chunks) ) {
        await clearAppliedCss();
        if ( chunks.length !== 0 ) {
            await Promise.all(chunks.map(css => insertCSS(css)));
        }
        currentCssChunks = chunks.slice();
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

self.TalonRemoteCosmeticsController.refresh().catch(( ) => {});

})();

void 0;
