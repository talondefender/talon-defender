/******************************************************************************/
// Runs isolated so Chrome loads it consistently, then injects the page-world guard.
(function talonYoutubePlayerGuardLoader(global) {

if ( global.__talonYoutubePlayerGuardLoaderInstalled === true ) { return; }
global.__talonYoutubePlayerGuardLoaderInstalled = true;

const YOUTUBE_HOST_RE = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const GUARD_SCRIPT_ID = 'talon-youtube-player-guard-script';
const GUARD_SCRIPT_PATH = 'js/scripting/youtube-player-guard.js';
const doc = global.document;

if ( !doc || YOUTUBE_HOST_RE.test(String(global.location?.hostname || '')) === false ) {
    return;
}

const mark = (name, value) => {
    try {
        doc.documentElement?.setAttribute(`data-talon-youtube-${name}`, value);
    } catch {
    }
};

mark('guard-loader', 'installed');

const removeScript = script => {
    try {
        script.remove();
    } catch {
    }
};

const injectGuard = () => {
    if ( doc.getElementById(GUARD_SCRIPT_ID) ) { return true; }
    const target = doc.head || doc.documentElement;
    if ( !target ) { return false; }

    const script = doc.createElement('script');
    script.id = GUARD_SCRIPT_ID;
    script.async = false;
    script.src = chrome.runtime.getURL(GUARD_SCRIPT_PATH);
    script.onload = () => removeScript(script);
    script.onerror = () => {
        mark('guard-loader-error', 'script-load');
        removeScript(script);
    };
    target.appendChild(script);
    mark('guard-loader-injected', 'true');
    return true;
};

try {
    if ( injectGuard() === false ) {
        doc.addEventListener?.('readystatechange', injectGuard, { once: true });
        doc.addEventListener?.('DOMContentLoaded', injectGuard, { once: true });
    }
} catch {
}

})(globalThis);

void 0;
