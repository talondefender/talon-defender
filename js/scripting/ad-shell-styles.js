/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_adShellStyles() {

const BASE_SELECTORS = [
    '.container--ads',
    '.container--ads-leaderboard-atf',
    '.container--ads-leaderboard-btf',
    '.in-article-ads',
    '.ad-slot',
    '.ad-slot-rail__container',
    '.ads__slot',
    '.ads__title',
    '.freestar-ads',
    '[data-ad]',
    '[data-ad-unit]',
    '[data-ad-slot]',
    '[data-ad-client]',
    '[data-advertisement]',
    'ins.adsbygoogle',
    '.adsbygoogle',
    '.OUTBRAIN',
    '.ob-widget',
    '#taboola-below-article-thumbnails',
    'div[id^="taboola-"]',
    'div[class*="taboola" i]',
    '[id^="div-gpt-ad-"]',
    '[id*="ad-slot" i]',
    '[class*="ad-slot" i]',
    '[class*="container--ads" i]',
    '[class*="freestar" i]',
];

const HOST_SCOPED_SELECTORS = Object.freeze([
    {
        host: 'foxnews.com',
        selectors: [
            '.ad-container[class*="ad-h-" i][class*="ad-w-" i]',
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

const inject = () => {
    try {
        if ( document.getElementById('ubol-ad-shell-styles') ) { return; }
        const style = document.createElement('style');
        style.id = 'ubol-ad-shell-styles';
        style.textContent = STYLE_TEXT;
        (document.head || document.documentElement || document).append(style);
    } catch {
    }
};

if ( document.documentElement ) {
    inject();
} else {
    document.addEventListener('readystatechange', inject, { once: true });
}

})();

void 0;
