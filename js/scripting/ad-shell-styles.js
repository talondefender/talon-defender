/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_adShellStyles() {

const SELECTORS = [
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

const STYLE_TEXT = `${SELECTORS.join(',')}{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;margin:0!important;padding:0!important;border:0!important;}`;

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
