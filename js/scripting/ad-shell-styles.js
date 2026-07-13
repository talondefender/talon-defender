/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_adShellStyles() {

if ( self.TalonAdShellStylesController ) {
    const readiness = self.TalonAdShellStylesController.refresh?.() ||
        Promise.resolve({ applied: false });
    self.TalonAdShellStylesReady = readiness;
    readiness.catch(( ) => {});
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
    {
        host: 'cnn.com',
        selectors: [
            '.ad-slot-header__wrapper',
        ],
    },
]);

const HOST_SCOPED_STYLES = Object.freeze([
    {
        host: 'cnn.com',
        styles: [
            '.header__wrapper-outer:has(.ad-slot-header__wrapper)' +
                '{min-height:0!important;}',
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
const hostScopedStyles = [];
for ( const entry of HOST_SCOPED_STYLES ) {
    if ( matchesHost(entry.host, hostname) === false ) { continue; }
    hostScopedStyles.push(...entry.styles);
}

const STYLE_TEXT =
    `${selectors.join(',')}` +
    '{display:none!important;visibility:hidden!important;height:0!important;' +
    'min-height:0!important;max-height:0!important;margin:0!important;' +
    'padding:0!important;border:0!important;overflow:hidden!important;}' +
    hostScopedStyles.join('');

const STYLE_ID = 'ubol-ad-shell-styles';
const STYLE_MARKER_ATTR = 'data-talon-owned-ad-shell-styles';
const SUBSYSTEM_ID = 'adShellStyles';
const MAX_MARKED_SHELLS = 96;
const blockHints = self.TalonBlockHintsController;
let ownedStyle;
let runGeneration = 0;
let protectionListenerConnected = false;

const removeStyle = () => {
    runGeneration += 1;
    try {
        ownedStyle?.remove();
    } catch {
    }
    ownedStyle = undefined;
};

const onProtectionChanged = () => {
    self.TalonAdShellStylesController?.refresh?.().catch?.(() => {});
};

const connectProtectionListener = () => {
    if ( protectionListenerConnected ) { return; }
    const eventName = self.TalonBreakageGuard?.PROTECTION_CHANGED_EVENT ||
        'talon-protection-changed';
    self.addEventListener?.(eventName, onProtectionChanged);
    protectionListenerConnected = true;
};

const stop = () => {
    const eventName = self.TalonBreakageGuard?.PROTECTION_CHANGED_EVENT ||
        'talon-protection-changed';
    if ( protectionListenerConnected ) {
        self.removeEventListener?.(eventName, onProtectionChanged);
        protectionListenerConnected = false;
    }
    removeStyle();
};

const markMatchedShells = () => {
    if ( typeof blockHints?.noteElement !== 'function' ) { return 0; }
    let nodes = [];
    try {
        // A selector list lets the browser traverse the page once instead of
        // repeating a full query for every ad vendor selector.
        nodes = document.querySelectorAll?.(selectors.join(',')) || [];
    } catch {
        nodes = [];
    }
    let count = 0;
    let marked = 0;
    for ( const node of nodes ) {
        if ( node instanceof Element === false ) { continue; }
        count += blockHints.noteElement(node, { ancestors: 1 });
        marked += 1;
        if ( marked >= MAX_MARKED_SHELLS ) { break; }
    }
    return count;
};

const applyPrepaint = () => {
    try {
        if (
            ownedStyle instanceof HTMLStyleElement === false ||
            ownedStyle.isConnected === false
        ) {
            const style = document.createElement('style');
            if ( document.getElementById(STYLE_ID) === null ) {
                style.id = STYLE_ID;
            }
            style.setAttribute(STYLE_MARKER_ATTR, '1');
            style.textContent = STYLE_TEXT;
            (document.head || document.documentElement || document).append(style);
            ownedStyle = style;
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
    const generation = ++runGeneration;
    if ( await shouldRun() === false ) {
        if ( generation === runGeneration ) { removeStyle(); }
        return { applied: false };
    }
    if ( generation !== runGeneration ) { return { applied: false }; }
    return { applied: applyPrepaint() };
};

const refresh = () => {
    connectProtectionListener();
    return inject();
};

self.TalonAdShellStylesController = {
    refresh,
    stop,
};

const start = () => {
    // These selectors are deliberately conservative and the registration is
    // already excluded from persisted subsystem backoffs. Insert before the
    // asynchronous guard waits for DOM classification so this is truly a
    // prepaint lane; refresh removes the owned sheet if policy later says no.
    applyPrepaint();
    const readiness = refresh();
    self.TalonAdShellStylesReady = readiness;
    readiness.catch(() => {});
};

if ( document.documentElement ) {
    start();
} else {
    document.addEventListener('readystatechange', start, { once: true });
}

})();

void 0;
