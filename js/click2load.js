/*******************************************************************************

    Talon Defender - click-to-load helper

*******************************************************************************/

const allowedProtocols = new Set([ 'http:', 'https:' ]);

const expandCandidates = raw => {
    const out = [];
    if ( typeof raw !== 'string' ) { return out; }

    let value = raw.trim();
    if ( value === '' ) { return out; }
    out.push(value);

    // The redirect payload may be URL-encoded once or twice.
    for ( let i = 0; i < 2; i += 1 ) {
        try {
            const decoded = decodeURIComponent(value);
            if ( decoded === value ) { break; }
            value = decoded.trim();
            if ( value === '' ) { break; }
            out.push(value);
        } catch {
            break;
        }
    }

    return out;
};

const toTargetURL = candidate => {
    try {
        const url = new URL(candidate);
        if ( allowedProtocols.has(url.protocol) ) {
            return url;
        }
    } catch {
    }
    return null;
};

const resolveTargetURL = ( ) => {
    const params = new URLSearchParams(self.location.search);
    const rawCandidates = [
        params.get('url'),
        params.get('aliasURL'),
        params.get('target'),
        self.location.hash.startsWith('#')
            ? self.location.hash.slice(1)
            : '',
    ];

    for ( const raw of rawCandidates ) {
        for ( const candidate of expandCandidates(raw) ) {
            const url = toTargetURL(candidate);
            if ( url !== null ) { return url; }
        }
    }

    return null;
};

const qs = selector => self.document.querySelector(selector);

const targetURL = resolveTargetURL();
const targetLine = qs('#targetLine');
const targetLabel = qs('#targetURL');
const loadNowButton = qs('#loadNow');
const openInTabLink = qs('#openInTab');
const missingTargetText = qs('#missingTargetText');

const setUnavailableState = ( ) => {
    targetLine.classList.add('hidden');
    missingTargetText.classList.remove('hidden');
    loadNowButton.disabled = true;
    openInTabLink.classList.add('disabled');
    openInTabLink.removeAttribute('href');
};

if ( targetURL === null ) {
    setUnavailableState();
} else {
    const href = targetURL.href;
    targetLine.classList.remove('hidden');
    targetLabel.textContent = href;
    openInTabLink.href = href;
    loadNowButton.addEventListener('click', ( ) => {
        self.location.replace(href);
    });
}

self.document.body.classList.remove('loading');
