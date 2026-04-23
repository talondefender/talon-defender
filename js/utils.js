/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    browser,
    runtime,
} from './ext.js';
import {
    isIgnorableRuntimeError,
    ignoreRuntimeError,
} from './runtime-errors.js';

/******************************************************************************/

function parsedURLromOrigin(origin) {
    try {
        return new URL(origin);
    } catch {
    }
}

const toBroaderHostname = hn => {
    if (hn === '*') { return ''; }
    const pos = hn.indexOf('.');
    return pos !== -1 ? hn.slice(pos + 1) : '*';
};

/******************************************************************************/

// Is hna descendant hostname of hnb?

const isDescendantHostname = (hna, hnb) => {
    if (hnb === 'all-urls') { return true; }
    if (hna.endsWith(hnb) === false) { return false; }
    if (hna === hnb) { return false; }
    return hna.charCodeAt(hna.length - hnb.length - 1) === 0x2E /* '.' */;
};

/**
 * Returns whether a hostname is part of a collection, or is descendant of an
 * item in the collection.
 * @param hna - the hostname representing the needle.
 * @param iterb - an iterable representing the haystack of hostnames.
 */

const isDescendantHostnameOfIter = (hna, iterb) => {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if (setb.has('all-urls') || setb.has('*')) { return true; }
    let hn = hna;
    while (hn) {
        const pos = hn.indexOf('.');
        if (pos === -1) { break; }
        hn = hn.slice(pos + 1);
        if (setb.has(hn)) { return true; }
    }
    return false;
};

/**
 * Returns all hostnames in the first collection which are equal or descendant
 * of hostnames in the second collection.
 * @param itera - an iterable which hostnames must be filtered out.
 * @param iterb - an iterable which hostnames must be matched.
 */

const intersectHostnameIters = (itera, iterb) => {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if (setb.has('all-urls') || setb.has('*')) { return Array.from(itera); }
    const out = [];
    for (const hna of itera) {
        if (setb.has(hna) || isDescendantHostnameOfIter(hna, setb)) {
            out.push(hna);
        }
    }
    return out;
};

const subtractHostnameIters = (itera, iterb) => {
    const setb = iterb instanceof Set ? iterb : new Set(iterb);
    if (setb.has('all-urls') || setb.has('*')) { return []; }
    const out = [];
    for (const hna of itera) {
        if (setb.has(hna)) { continue; }
        if (isDescendantHostnameOfIter(hna, setb)) { continue; }
        out.push(hna);
    }
    return out;
};

/******************************************************************************/

export const matchFromHostname = hn =>
    hn === '*' || hn === 'all-urls' ? '<all_urls>' : `*://*.${hn}/*`;

export const matchesFromHostnames = hostnames => {
    const out = [];
    for (const hn of hostnames) {
        out.push(matchFromHostname(hn));
    }
    return out;
};

export const hostnameFromMatch = origin => {
    if (origin === '<all_urls>' || origin === '*://*/*') { return 'all-urls'; }
    const match = /^\*:\/\/(?:\*\.)?([^/]+)\/\*/.exec(origin);
    if (match === null) { return ''; }
    return match[1];
};

export const hostnamesFromMatches = origins => {
    const out = [];
    for (const origin of origins) {
        const hn = hostnameFromMatch(origin);
        if (hn === '') { continue; }
        out.push(hn);
    }
    return out;
};

/******************************************************************************/

const broadcastMessage = message => {
    const bc = new self.BroadcastChannel('uBOL');
    bc.postMessage(message);
};

/******************************************************************************/

// https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions#requested_permissions_and_user_prompts
// "Users can grant or revoke host permissions on an ad hoc basis. Therefore,
// most browsers treat host_permissions as optional."

async function hasBroadHostPermissions() {
    return browser.permissions.getAll().then(permissions =>
        permissions.origins.includes('<all_urls>') ||
        permissions.origins.includes('*://*/*')
    ).catch(() => false);
}

/******************************************************************************/

const MAX_NAVIGATION_URL_LENGTH = 4096;
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;
const OVERLAY_SESSION_TOKEN_RE = /^[a-f0-9]{32}$/;
const OVERLAY_SESSION_FILES = new Set([
    '/picker-ui.html',
    '/unpicker-ui.html',
]);

export const OVERLAY_SESSION_TTL_MS = 15 * 1000;

const normalizeNavigationURL = url => {
    if ( typeof url !== 'string' ) { return null; }
    const trimmed = url.trim();
    if ( trimmed === '' ) { return null; }
    if ( trimmed.length > MAX_NAVIGATION_URL_LENGTH ) { return null; }
    if ( CONTROL_CHARS_RE.test(trimmed) ) { return null; }
    let pageURL;
    try {
        pageURL = new URL(trimmed, runtime.getURL('/'));
    } catch {
        return null;
    }
    if ( pageURL.username !== '' || pageURL.password !== '' ) {
        pageURL.username = '';
        pageURL.password = '';
    }

    const extensionOrigin = runtime.getURL('').replace(/\/$/, '').toLowerCase();
    if ( pageURL.origin.toLowerCase() === extensionOrigin ) {
        return pageURL;
    }
    if ( pageURL.protocol !== 'https:' ) { return null; }
    return pageURL;
};

/******************************************************************************/

export const normalizeOverlaySessionToken = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const token = value.trim().toLowerCase();
    return OVERLAY_SESSION_TOKEN_RE.test(token) ? token : '';
};

export const normalizeOverlaySessionFile = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const file = value.trim();
    return OVERLAY_SESSION_FILES.has(file) ? file : '';
};

export const normalizeOverlaySessionPageUrl = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const trimmed = value.trim();
    if ( trimmed === '' ) { return ''; }
    if ( trimmed.length > MAX_NAVIGATION_URL_LENGTH ) { return ''; }
    if ( CONTROL_CHARS_RE.test(trimmed) ) { return ''; }
    try {
        const pageURL = new URL(trimmed);
        if ( pageURL.protocol !== 'http:' && pageURL.protocol !== 'https:' ) {
            return '';
        }
        pageURL.username = '';
        pageURL.password = '';
        return pageURL.href;
    } catch {
    }
    return '';
};

const normalizeOverlaySessionId = value => {
    const id = Number(value);
    return Number.isInteger(id) && id >= 0 ? id : -1;
};

export function createOverlaySessionStore({
    now = ( ) => Date.now(),
    ttlMs = OVERLAY_SESSION_TTL_MS,
} = {}) {
    const sessions = new Map();
    const normalizedTtlMs = Math.max(
        1000,
        Math.floor(Number(ttlMs) || OVERLAY_SESSION_TTL_MS)
    );
    const currentTime = ( ) => Math.max(0, Math.floor(Number(now()) || 0));

    const prune = (referenceTime = currentTime()) => {
        for ( const [ token, session ] of sessions ) {
            if ( session.expiresAt > referenceTime ) { continue; }
            sessions.delete(token);
        }
        return sessions.size;
    };

    const normalizeSession = input => {
        const token = normalizeOverlaySessionToken(input?.token);
        const file = normalizeOverlaySessionFile(input?.file);
        const pageUrl = normalizeOverlaySessionPageUrl(input?.pageUrl);
        return {
            token,
            file,
            pageUrl,
            tabId: normalizeOverlaySessionId(input?.tabId),
            frameId: normalizeOverlaySessionId(input?.frameId),
        };
    };

    return {
        register(input = {}) {
            const createdAt = currentTime();
            prune(createdAt);

            const session = normalizeSession(input);
            if (
                session.token === '' ||
                session.file === '' ||
                session.pageUrl === '' ||
                session.tabId === -1 ||
                session.frameId === -1
            ) {
                return { ok: false, error: 'invalid_session' };
            }
            if ( sessions.has(session.token) ) {
                return { ok: false, error: 'duplicate_token' };
            }

            const expiresAt = createdAt + normalizedTtlMs;
            sessions.set(session.token, {
                ...session,
                createdAt,
                expiresAt,
            });
            return { ok: true, expiresAt };
        },

        claim(input = {}) {
            const claimedAt = currentTime();
            const token = normalizeOverlaySessionToken(input?.token);
            if ( token === '' ) {
                return { ok: false, error: 'invalid_token' };
            }
            const entry = sessions.get(token);
            if ( entry === undefined ) {
                prune(claimedAt);
                return { ok: false, error: 'unknown_token' };
            }
            sessions.delete(token);

            if ( entry.expiresAt <= claimedAt ) {
                return { ok: false, error: 'expired_token' };
            }

            const file = normalizeOverlaySessionFile(input?.file);
            const pageUrl = normalizeOverlaySessionPageUrl(input?.pageUrl);
            if ( file === '' || pageUrl === '' ) {
                return { ok: false, error: 'invalid_session' };
            }
            if ( entry.file !== file || entry.pageUrl !== pageUrl ) {
                return { ok: false, error: 'session_mismatch' };
            }

            return {
                ok: true,
                file: entry.file,
                pageUrl: entry.pageUrl,
                tabId: entry.tabId,
                frameId: entry.frameId,
            };
        },

        prune,
        clear() {
            sessions.clear();
        },
        get size() {
            prune();
            return sessions.size;
        },
    };
}

/******************************************************************************/

async function gotoURL(url, type) {
    const pageURL = normalizeNavigationURL(url);
    if ( pageURL === null ) {
        throw new Error('Invalid navigation URL');
    }
    const windowType = type === 'popup' ? 'popup' : 'normal';
    let tabs = [];
    try {
        tabs = await browser.tabs.query({
            url: pageURL.href,
            windowType,
        });
    } catch (error) {
        if ( isIgnorableRuntimeError(error) === false ) {
            throw error;
        }
    }

    if (Array.isArray(tabs) && tabs.length !== 0) {
        const { windowId, id } = tabs[0];
        try {
            await Promise.all([
                browser.windows.update(windowId, { focused: true })
                    .catch(ignoreRuntimeError),
                browser.tabs.update(id, { active: true })
                    .catch(ignoreRuntimeError),
            ]);
            return;
        } catch (error) {
            if ( isIgnorableRuntimeError(error) === false ) {
                throw error;
            }
        }
    }

    if (windowType === 'popup') {
        return browser.windows.create({
            type: 'popup',
            url: pageURL.href,
        });
    }

    return browser.tabs.create({
        active: true,
        url: pageURL.href,
    });
}

/******************************************************************************/

// Important: We need to sort the arrays for fast comparison
const strArrayEq = (a = [], b = [], sort = true) => {
    const alen = a.length;
    if (alen !== b.length) { return false; }
    if (sort) { a.sort(); b.sort(); }
    for (let i = 0; i < alen; i++) {
        if (a[i] !== b[i]) { return false; }
    }
    return true;
};

/******************************************************************************/

// The goal is just to be able to find out whether a specific version is older
// than another one.

export function intFromVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (match === null) { return 0; }
    const year = parseInt(match[1], 10);
    const monthday = parseInt(match[2], 10);
    const min = parseInt(match[3], 10);
    return (year - 2022) * (1232 * 2400) + monthday * 2400 + min;
}

/******************************************************************************/

export {
    broadcastMessage,
    parsedURLromOrigin,
    isIgnorableRuntimeError,
    ignoreRuntimeError,
    toBroaderHostname,
    isDescendantHostname,
    isDescendantHostnameOfIter,
    intersectHostnameIters,
    subtractHostnameIters,
    hasBroadHostPermissions,
    gotoURL,
    strArrayEq,
    getRuleCategory, // Export new helper
};

/******************************************************************************/

function getRuleCategory(rulesetId, type) {
    const id = String(rulesetId || "").toLowerCase();
    const rType = String(type || "").toLowerCase();

    // 1. Explicit Privacy/Spyware Lists
    if (id.includes("privacy") || id.includes("spyware") || id.includes("social")) {
        return "tracker";
    }

    // 2. Explicit Malware/Security Lists
    if (id.includes("malware") || id.includes("badware") || id.includes("urlhaus") || id.includes("phishing")) {
        return "malware"; // Maps to "Malicious Scripts"
    }

    // 3. Explicit Ad Lists
    if (id.includes("ads") || id.includes("easylist") || id.includes("pgl")) {
        // Even if it is an explicit AD list, certain types are almost always trackers
        if (rType === "xmlhttprequest" || rType === "ping" || rType === "beacon" || rType === "image") {
            return "tracker";
        }
        return "ad";
    }

    // 4. Generic/Unknown Rulesets (e.g. ublock-filters, dynamic rules)
    // Use Resource Type to guess category
    if (rType === "script") {
        // If a generic script is blocked, it's safer/more impactful to label it as a potential risk/script
        // User wanted "Malicious Scripts". We can count generic blocked scripts here?
        // Or just "Ad"?
        // Let's stick to "Ad" for generic scripts to be safe, UNLESS user insists on "Malicious".
        // Let's use "malware" if we want to populate that field?
        // No, let's keep it honest. Generic script block -> Ad (usually).
        return "ad";
    }

    if (rType === "xmlhttprequest" || rType === "ping" || rType === "beacon" || rType === "image") {
        return "tracker";
    }

    // 5. Default Fallback
    return "ad";
}
