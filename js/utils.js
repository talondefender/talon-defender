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

/******************************************************************************/

function parsedURLromOrigin(origin) {
    try {
        return new URL(origin);
    } catch {
    }
}

/******************************************************************************/

const IGNORABLE_RUNTIME_ERRORS = [
    'No tab with id',
    'No window with id',
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
];

const errorMessageFrom = error => {
    if ( error && typeof error.message === 'string' ) { return error.message; }
    if ( typeof error === 'string' ) { return error; }
    return '';
};

const isIgnorableRuntimeError = error => {
    const message = errorMessageFrom(error);
    if ( message === '' ) { return false; }
    return IGNORABLE_RUNTIME_ERRORS.some(snippet => message.includes(snippet));
};

const ignoreRuntimeError = error => {
    // Some browser APIs may reject with an empty reason; do not turn that into "Uncaught undefined".
    if ( error === undefined || error === null ) { return; }
    if ( isIgnorableRuntimeError(error) ) { return; }
    throw error;
};

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
