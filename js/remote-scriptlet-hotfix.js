const REMOTE_SCRIPTLET_ID_PREFIX = 'remote-scriptlet.';
const PACKAGED_STATIC_SCRIPTLET_ID_RE =
    /^[a-z0-9][a-z0-9._-]*\.(?:main|isolated)$/i;
const PACKAGED_STATIC_SCRIPTLET_SPECIAL_IDS = new Set([
    'talon-site-fixes-main',
]);

// These exported names and the storage key are retained for persisted-state
// compatibility. The hint now also carries packaged static scriptlet
// registration transitions, which have the same document-reload semantics.
export const REMOTE_SCRIPTLET_RELOAD_REASON = 'remoteScriptletHotfix';
export const PENDING_REMOTE_SCRIPTLET_RELOAD_HINT_KEY =
    'pendingRemoteScriptletReloadHintV1';

export const isRemoteScriptletDirectiveId = id =>
    typeof id === 'string' && id.startsWith(REMOTE_SCRIPTLET_ID_PREFIX);

export const isPackagedStaticScriptletDirectiveId = id =>
    typeof id === 'string' && (
        PACKAGED_STATIC_SCRIPTLET_ID_RE.test(id) ||
        PACKAGED_STATIC_SCRIPTLET_SPECIAL_IDS.has(id)
    );

export const isReloadTrackedScriptletDirectiveId = id =>
    isRemoteScriptletDirectiveId(id) ||
    isPackagedStaticScriptletDirectiveId(id);

const normalizeStringArray = input => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of input ) {
        if ( typeof entry !== 'string' ) { continue; }
        const normalized = entry.trim();
        if ( normalized === '' || seen.has(normalized) ) { continue; }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
};

const normalizeDirective = input => {
    if ( input instanceof Object === false ) { return null; }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if ( isReloadTrackedScriptletDirectiveId(id) === false ) { return null; }
    const matches = normalizeStringArray(input.matches);
    const excludeMatches = normalizeStringArray(input.excludeMatches);
    if ( matches.length === 0 ) { return null; }
    return {
        id,
        matches,
        excludeMatches,
    };
};

const normalizeDirectiveList = input => {
    if ( Array.isArray(input) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of input ) {
        const normalized = normalizeDirective(entry);
        if ( normalized === null ) { continue; }
        const key = JSON.stringify(normalized);
        if ( seen.has(key) ) { continue; }
        seen.add(key);
        out.push(normalized);
    }
    return out;
};

export const normalizeRemoteScriptletReloadHint = input => {
    const before = normalizeDirectiveList(input?.before);
    const after = normalizeDirectiveList(input?.after);
    if ( before.length === 0 && after.length === 0 ) { return null; }
    return { before, after };
};

export const mergeRemoteScriptletReloadHints = (...inputs) =>
    normalizeRemoteScriptletReloadHint({
        before: inputs.flatMap(input => Array.isArray(input?.before)
            ? input.before
            : []),
        after: inputs.flatMap(input => Array.isArray(input?.after)
            ? input.after
            : []),
    });

const parseUrl = value => {
    if ( typeof value !== 'string' || value.trim() === '' ) { return null; }
    try {
        return new URL(value);
    } catch {
    }
    return null;
};

const hostPatternMatches = (pattern, hostname) => {
    if ( pattern === '*' ) { return true; }
    if ( pattern.startsWith('*.') ) {
        const bare = pattern.slice(2);
        return hostname === bare || hostname.endsWith(`.${bare}`);
    }
    return hostname === pattern;
};

const matchPatternMatchesUrl = (pattern, url) => {
    if ( url instanceof URL === false ) { return false; }
    if ( pattern === '<all_urls>' || pattern === '*://*/*' ) {
        return url.protocol === 'https:' || url.protocol === 'http:';
    }
    const match = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/]+|[^/]+)\/\*$/.exec(pattern);
    if ( match === null ) { return false; }
    const [, scheme, hostPattern ] = match;
    if ( scheme !== '*' && `${scheme}:` !== url.protocol ) { return false; }
    if ( scheme === '*' && url.protocol !== 'https:' && url.protocol !== 'http:' ) {
        return false;
    }
    if ( hostPattern === '*' ) { return true; }
    return hostPatternMatches(hostPattern, url.hostname.toLowerCase());
};

export const directiveMatchesUrl = (directive, url) => {
    const normalizedDirective = normalizeDirective(directive);
    if ( normalizedDirective === null ) { return false; }
    const parsedUrl = url instanceof URL ? url : parseUrl(url);
    if ( parsedUrl === null ) { return false; }
    if ( normalizedDirective.matches.some(pattern => matchPatternMatchesUrl(pattern, parsedUrl)) === false ) {
        return false;
    }
    if ( normalizedDirective.excludeMatches.some(pattern => matchPatternMatchesUrl(pattern, parsedUrl)) ) {
        return false;
    }
    return true;
};

export const urlMatchesRemoteScriptletReloadHint = (url, hint) => {
    const normalizedHint = normalizeRemoteScriptletReloadHint(hint);
    if ( normalizedHint === null ) { return false; }
    for ( const directive of normalizedHint.before ) {
        if ( directiveMatchesUrl(directive, url) ) { return true; }
    }
    for ( const directive of normalizedHint.after ) {
        if ( directiveMatchesUrl(directive, url) ) { return true; }
    }
    return false;
};

export const shouldReloadForFrameUrls = (frameUrls, hint) => {
    if ( Array.isArray(frameUrls) === false ) { return false; }
    return frameUrls.some(url => urlMatchesRemoteScriptletReloadHint(url, hint));
};
