/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_remoteCosmetics() {

const STORAGE_KEY = 'communityBundleCosmetics';

const runtime = self.browser?.runtime || self.chrome?.runtime;
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
if ( runtime?.sendMessage === undefined || storage?.get === undefined ) { return; }

const hostname = (self.location?.hostname || '').toLowerCase();
if ( hostname === '' ) { return; }

const registrableDomain = hn => {
    const parts = hn.split('.').filter(Boolean);
    if ( parts.length <= 2 ) { return hn; }
    return parts.slice(-2).join('.');
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

const insertCSS = css => {
    try {
        runtime.sendMessage({ what: 'insertCSS', css }).catch(( ) => {});
    } catch {
    }
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
        if ( out.length >= 400 ) { break; }
    }
    return out;
};

getCosmetics().then(cosmetics => {
    if ( cosmetics instanceof Object === false ) { return; }
    const selectors = [];
    const hostSpecific = [];

    if ( Array.isArray(cosmetics.all) ) {
        selectors.push(...cosmetics.all);
    }

    const hosts = cosmetics.hosts;
    if ( hosts instanceof Object ) {
        for ( const [ hostPattern, hostSelectors ] of Object.entries(hosts) ) {
            if ( patternMatchesHostname(hostPattern, hostname) === false &&
                 patternMatchesHostname(hostPattern, pageDomain) === false ) {
                continue;
            }
            if ( Array.isArray(hostSelectors) ) {
                selectors.push(...hostSelectors);
                hostSpecific.push(...hostSelectors);
            }
        }
    }

    const normalized = normalizeSelectors(selectors);
    if ( normalized.length === 0 ) { return; }

    insertCSS(`${normalized.join(',')}{display:none!important;visibility:hidden!important;}`);

    const hostSpecificNormalized = normalizeSelectors(hostSpecific);
    if ( hostSpecificNormalized.length >= 3 ) {
        try {
            runtime.sendMessage({
                what: 'promoteGenericHigh',
                hostname: pageDomain || hostname,
            }).catch(( ) => {});
        } catch {
        }
    }
});

})();

void 0;
