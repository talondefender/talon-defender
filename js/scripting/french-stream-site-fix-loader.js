/******************************************************************************/
// Runs isolated so French Stream can wake the background registration lane even
// when dynamic content-script registration has not been restored yet.
(function talonFrenchStreamSiteFixLoader(global) {

if ( global.__talonFrenchStreamSiteFixLoaderInstalled === true ) { return; }
global.__talonFrenchStreamSiteFixLoaderInstalled = true;

const FRENCH_STREAM_HOSTS = new Set([
    'french-stream.one',
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
]);
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [ 250, 750, 1500 ];
const doc = global.document;

const hostname = String(global.location?.hostname || '').toLowerCase();
const isCoveredHost = host =>
    FRENCH_STREAM_HOSTS.has(host) ||
    Array.from(FRENCH_STREAM_HOSTS).some(root => host.endsWith(`.${root}`));

if ( !doc || isCoveredHost(hostname) === false ) {
    return;
}

const mark = (name, value) => {
    try {
        doc.documentElement?.setAttribute(`data-talon-french-stream-${name}`, value);
    } catch {
    }
};

let attempts = 0;
let done = false;

const sendWakeup = () => {
    if ( done || attempts >= MAX_ATTEMPTS ) { return; }
    attempts += 1;
    mark('site-fix-loader', `attempt-${attempts}`);
    try {
        chrome.runtime.sendMessage({
            what: 'ensureFrenchStreamSiteFix',
            url: String(global.location?.href || ''),
        }, response => {
            if ( chrome.runtime.lastError ) {
                mark('site-fix-loader-error', 'runtime');
            } else if ( response?.ok === true ) {
                done = true;
                mark('site-fix-loader', 'ok');
                return;
            } else {
                mark('site-fix-loader-error', String(response?.error || 'unknown'));
            }
            if ( done === false && attempts < MAX_ATTEMPTS ) {
                global.setTimeout(sendWakeup, RETRY_DELAYS_MS[attempts - 1] || 1500);
            }
        });
    } catch {
        mark('site-fix-loader-error', 'send');
        if ( attempts < MAX_ATTEMPTS ) {
            global.setTimeout(sendWakeup, RETRY_DELAYS_MS[attempts - 1] || 1500);
        }
    }
};

sendWakeup();
doc.addEventListener?.('DOMContentLoaded', sendWakeup, { once: true });

})(globalThis);

void 0;
