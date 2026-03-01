/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_automation() {

const DIRECTIVES_PATH = 'automation/directives.json';
const REMOTE_DIRECTIVES_KEY = 'communityBundleDirectives';

const runtime = self.browser?.runtime || self.chrome?.runtime;
const getURL = runtime?.getURL?.bind(runtime) || (p => p);
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;

let directivesPromise;

let remoteDirectivesPromise;
const loadRemoteDirectives = ( ) => {
    if ( remoteDirectivesPromise !== undefined ) { return remoteDirectivesPromise; }
    if ( storage?.get === undefined ) {
        remoteDirectivesPromise = Promise.resolve([]);
        return remoteDirectivesPromise;
    }
    try {
        const maybePromise = storage.get(REMOTE_DIRECTIVES_KEY);
        if ( maybePromise?.then ) {
            remoteDirectivesPromise = maybePromise.then(bin => bin?.[REMOTE_DIRECTIVES_KEY] || [])
                .catch(( ) => []);
            return remoteDirectivesPromise;
        }
    } catch {
    }
    remoteDirectivesPromise = new Promise(resolve => {
        try {
            storage.get(REMOTE_DIRECTIVES_KEY, bin => resolve(bin?.[REMOTE_DIRECTIVES_KEY] || []));
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

const queryTargetsInRoot = (root, selectors) => {
    const out = [];
    for ( const sel of selectors ) {
        if ( typeof sel !== 'string' || sel === '' ) { continue; }
        let nodes;
        try {
            nodes = (root === document ? document : root).querySelectorAll(sel);
        } catch {
            continue;
        }
        for ( const node of nodes ) {
            if ( isVisible(node) === false ) { continue; }
            out.push(node);
        }
        if ( out.length !== 0 ) { break; }
    }
    return out;
};

const queryTargets = selectors => {
    const lightDomHits = queryTargetsInRoot(document, selectors);
    if ( lightDomHits.length !== 0 ) { return lightDomHits; }

    // Fallback: scan open shadow roots for consent overlays.
    const roots = [];
    try {
        const walker = document.createTreeWalker(
            document.body,
            self.NodeFilter?.SHOW_ELEMENT || 1
        );
        let scanned = 0;
        while ( walker.nextNode() ) {
            const el = walker.currentNode;
            if ( el.shadowRoot instanceof DocumentFragment ) {
                roots.push(el.shadowRoot);
            }
            if ( ++scanned >= 800 ) { break; }
        }
    } catch {
    }
    for ( const sr of roots ) {
        const hits = queryTargetsInRoot(sr, selectors);
        if ( hits.length !== 0 ) { return hits; }
    }

    return [];
};

const markApplied = (el, id) => {
    try {
        el.dataset.uBolAutomation = id;
    } catch {
    }
};

const applyClick = (id, selectors) => {
    const targets = queryTargets(selectors);
    for ( const el of targets ) {
        if ( el.dataset.uBolAutomation ) { continue; }
        try { el.click(); } catch { continue; }
        markApplied(el, id);
        return true;
    }
    return false;
};

const applyHide = (id, selectors) => {
    let changed = false;
    const targets = queryTargets(selectors);
    for ( const el of targets ) {
        if ( el === document.body || el === document.documentElement ) { continue; }
        if ( el.dataset.uBolAutomation ) { continue; }
        try {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
        } catch {
            continue;
        }
        markApplied(el, id);
        changed = true;
    }
    return changed;
};

const applyRemove = (id, selectors) => {
    let changed = false;
    const targets = queryTargets(selectors);
    for ( const el of targets ) {
        if ( el === document.body || el === document.documentElement ) { continue; }
        if ( el.dataset.uBolAutomation ) { continue; }
        try { el.remove(); } catch { continue; }
        changed = true;
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
const directiveCounts = new Map();

let activeDirectives = [];

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

    let did = action(id, selectors);
    if ( did === false && directive.fallbackAction && directive.fallbackSelectors ) {
        const fallback = ACTIONS[directive.fallbackAction];
        const fbSelectors = Array.isArray(directive.fallbackSelectors)
            ? directive.fallbackSelectors
            : [];
        if ( typeof fallback === 'function' && fbSelectors.length !== 0 ) {
            did = fallback(id, fbSelectors);
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

let sweepTimer;

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
        }
    }
};

const scheduleSweep = (delay = 250) => {
    if ( sweepTimer !== undefined ) { return; }
    sweepTimer = self.setTimeout(sweep, delay);
};

const domObserver = new MutationObserver(( ) => {
    scheduleSweep();
});

const init = async ( ) => {
    const directives = await loadDirectives();
    activeDirectives = directives.filter(hostMatchesDirective);
    if ( activeDirectives.length === 0 ) { return; }
    scheduleSweep(0);
    domObserver.observe(document, { childList: true, subtree: true });
};

init();

})();

void 0;
