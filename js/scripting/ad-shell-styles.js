/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_adShellStyles() {

if ( self.TalonAdShellStylesController ) {
    self.TalonAdShellStylesController.refresh?.();
    return;
}

const BASE_SELECTORS = [
    '.freestar-ads',
    '[class*="freestar" i]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    '.OUTBRAIN',
    '.ob-widget',
    '#taboola-below-article-thumbnails',
    'div[id^="taboola-"]',
    'div[class*="taboola" i]',
    '[id^="div-gpt-ad-"]',
    '[id^="google_ads_iframe_"]',
    'iframe[id^="google_ads_iframe_"]',
];

const HOST_SCOPED_SELECTORS = Object.freeze([
    {
        host: 'foxnews.com',
        selectors: [
            '.ad-container[class*="ad-h-" i][class*="ad-w-" i]',
        ],
    },
    {
        host: 'foxweather.com',
        selectors: [
            '.pre-content:has(> .ad-container[class*="ad-h-" i][class*="ad-w-" i])',
            '.ad-container[class*="ad-h-" i][class*="ad-w-" i]',
        ],
    },
    {
        host: 'sdin.jp',
        selectors: [
            'aside .rec3:has(> ins.adsbygoogle)',
            'main > #vdo3:has(> #min > #vdo-fourm)',
        ],
    },
]);

const hostname = (self.location?.hostname || '').toLowerCase();
const matchesHost = (pattern, candidate) =>
    typeof pattern === 'string' &&
    pattern !== '' &&
    typeof candidate === 'string' &&
    candidate !== '' &&
    (candidate === pattern || candidate.endsWith(`.${pattern}`));

const selectors = BASE_SELECTORS.slice();
for ( const entry of HOST_SCOPED_SELECTORS ) {
    if ( matchesHost(entry.host, hostname) === false ) { continue; }
    selectors.push(...entry.selectors);
}

const STYLE_TEXT =
    `${selectors.join(',')}` +
    '{display:none!important;visibility:hidden!important;height:0!important;' +
    'min-height:0!important;max-height:0!important;margin:0!important;' +
    'padding:0!important;border:0!important;overflow:hidden!important;}';

const STYLE_ID = 'ubol-ad-shell-styles';
const SUBSYSTEM_ID = 'adShellStyles';
const blockHints = self.TalonBlockHintsController;

const remove = () => {
    try {
        document.getElementById(STYLE_ID)?.remove();
    } catch {
    }
};

const markMatchedShells = () => {
    if ( typeof blockHints?.noteElement !== 'function' ) { return 0; }
    const seen = new Set();
    let count = 0;
    for ( const selector of selectors ) {
        let nodes = [];
        try {
            nodes = document.querySelectorAll?.(selector) || [];
        } catch {
            nodes = [];
        }
        for ( const node of nodes ) {
            if ( node instanceof Element === false || seen.has(node) ) { continue; }
            seen.add(node);
            count += blockHints.noteElement(node, { ancestors: 1 });
        }
    }
    return count;
};

const applyPrepaint = () => {
    try {
        if ( document.getElementById(STYLE_ID) === null ) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = STYLE_TEXT;
            (document.head || document.documentElement || document).append(style);
        }
        markMatchedShells();
        return true;
    } catch {
    }
    return false;
};

const shouldRun = async () => {
    const guard = self.TalonBreakageGuard;
    try {
        await guard?.whenReady?.();
        return guard?.shouldRunSubsystem?.(SUBSYSTEM_ID) !== false;
    } catch {
    }
    return true;
};

const inject = async () => {
    if ( await shouldRun() === false ) {
        remove();
        return { applied: false };
    }
    return { applied: applyPrepaint() };
};

self.TalonAdShellStylesController = {
    refresh: inject,
    stop: remove,
};

if ( document.documentElement ) {
    applyPrepaint();
    inject().catch(() => {});
} else {
    document.addEventListener('readystatechange', () => {
        applyPrepaint();
        inject().catch(() => {});
    }, { once: true });
}

})();

void 0;
