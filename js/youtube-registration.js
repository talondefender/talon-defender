const ROOTS = [ 'youtube.com', 'youtube-nocookie.com' ];
const covers = (parent, host) => host === parent || host.endsWith(`.${parent}`);
const pattern = host => `*://*.${host}/*`;
const exactPattern = host => `*://${host}/*`;

// Keep document-start eligibility consistent with mode-manager's lookup:
// bucket priority wins over hostname specificity, and all-urls disables that
// bucket's ancestor walk while retaining its exact-host entries.
export function getYouTubeRegistrationScopes(details = {}, suppressed = []) {
    const buckets = [ 'none', 'basic', 'optimal', 'complete' ].map((name, level) => ({
        hosts: new Set([...(details[name] || [])].filter(host => typeof host === 'string')),
        level,
    }));
    const globalMode = buckets.find(bucket => bucket.hosts.has('all-urls'))?.level ?? 1;
    const modeAt = (host, descendants = false) => {
        for ( const { hosts, level } of buckets ) {
            if ( !descendants && hosts.has(host) ) { return level; }
            if ( hosts.has('all-urls') ) { continue; }
            if ( hosts.has('*') ) { return level; }
            if ( [...hosts].some(parent => covers(parent, host)) ) { return level; }
        }
        return globalMode;
    };
    const relevant = host => ROOTS.some(root => covers(root, host));
    const candidates = [...new Set([ ...ROOTS, ...buckets.flatMap(bucket => [...bucket.hosts]) ])]
        .filter(relevant).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const regions = [];
    for ( const host of candidates ) {
        const parent = regions.findLast(region => covers(region.host, host));
        const enabled = modeAt(host) !== 0;
        const descendantsEnabled = modeAt(host, true) !== 0;
        if ( parent && enabled === parent.descendantsEnabled && descendantsEnabled === enabled ) { continue; }
        regions.push({ host, parent, enabled, descendantsEnabled });
    }
    const groups = new Map();
    for ( const region of regions ) {
        const { host, enabled, descendantsEnabled } = region;
        if ( !enabled && !descendantsEnabled ) { continue; }
        if ( suppressed.some(parent => covers(parent, host)) ) { continue; }
        // Each changed child owns its subtree. Exact exclusions preserve the
        // global-none case where an opt-out applies only to that hostname.
        const excludeMatches = descendantsEnabled ? [...new Set([
            ...regions.filter(child => child.parent === region).map(child => pattern(child.host)),
            ...suppressed.filter(candidate => covers(host, candidate)).map(pattern),
            ...(enabled ? [] : [ exactPattern(host) ]),
        ])].sort() : [];
        const key = JSON.stringify(excludeMatches);
        if ( !groups.has(key) ) { groups.set(key, { matches: [], excludeMatches }); }
        groups.get(key).matches.push(descendantsEnabled ? pattern(host) : exactPattern(host));
    }
    return [...groups.values()].map(scope => ({
        matches: scope.matches.sort(), excludeMatches: scope.excludeMatches,
    }));
}
