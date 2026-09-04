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

import { webext } from './ext-compat.js';
import { isIgnorableRuntimeError } from './runtime-errors.js';

/******************************************************************************/

export const browser = webext;
export const i18n = browser.i18n;
export const runtime = browser.runtime;

export const webextFlavor = (( ) => {
    const extURL = runtime.getURL('');
    if ( extURL.startsWith('safari-web-extension:') ) { return 'safari'; }
    return extURL.startsWith('moz-extension:') ? 'firefox' : 'chromium';
})();

export const isUserScriptsAvailable = () => {
    try {
        // On Chrome 122 even reading the namespace can throw while Developer
        // Mode is off. Keep the complete capability probe inside this guard.
        if ( browser.userScripts instanceof Object === false ) { return false; }
        if ( typeof browser.userScripts.getScripts !== 'function' ) { return false; }
        if ( typeof browser.userScripts.register !== 'function' ) { return false; }
        // Chrome recommends a method-call probe: before Chrome 138 the API can
        // be present while Developer Mode is off, and after 138 a revoked
        // Allow User Scripts toggle can leave the namespace defined until this
        // worker is reloaded while method calls throw.
        const probe = browser.userScripts.getScripts();
        if ( probe && typeof probe.catch === 'function' ) {
            probe.catch(() => {});
        }
        return true;
    } catch {
    }
    return false;
};

// Capability and current availability are intentionally separate. On
// Chromium the userScripts namespace can disappear while the user-controlled
// Allow User Scripts/Developer Mode switch is off, even though this extension
// targets a version which supports the declared permission.
const declaredPermissions = runtime.getManifest?.()?.permissions;
export const supportsUserScripts =
    browser.offscreen !== undefined &&
    Array.isArray(declaredPermissions) &&
    declaredPermissions.includes('userScripts');

/******************************************************************************/

// The extension's service worker can be evicted at any time, so when we
// send a message, we try a few more times when the message fails to be sent.

export function sendMessage(msg) {
    return runtime.sendMessage(msg).catch(reason => {
        if ( isIgnorableRuntimeError(reason) ) { return; }
        console.error('runtime.sendMessage failed', reason);
    });
}

/******************************************************************************/

export async function localRead(key) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.local instanceof Object === false ) { return; }
    try {
        const bin = await browser.storage.local.get(key);
        if ( bin instanceof Object === false ) { return; }
        return bin[key] ?? undefined;
    } catch {
    }
}

export async function localWrite(key, value) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.local instanceof Object === false ) { return; }
    return browser.storage.local.set({ [key]: value });
}

export async function localRemove(key) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.local instanceof Object === false ) { return; }
    return browser.storage.local.remove(key);
}

export async function localKeys() {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.local instanceof Object === false ) { return; }
    if ( browser.storage.local.getKeys ) {
        return browser.storage.local.getKeys();
    }
    const bin = await browser.storage.local.get(null);
    if ( bin instanceof Object === false ) { return; }
    return Object.keys(bin);
}

/******************************************************************************/

export async function sessionRead(key) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.session instanceof Object === false ) { return; }
    try {
        const bin = await browser.storage.session.get(key);
        if ( bin instanceof Object === false ) { return; }
        return bin[key] ?? undefined;
    } catch {
    }
}

export async function sessionWrite(key, value) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.session instanceof Object === false ) { return; }
    return browser.storage.session.set({ [key]: value });
}

export async function sessionRemove(key) {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.session instanceof Object === false ) { return; }
    return browser.storage.session.remove(key);
}

export async function sessionKeys() {
    if ( browser.storage instanceof Object === false ) { return; }
    if ( browser.storage.session instanceof Object === false ) { return; }
    if ( browser.storage.session.getKeys ) {
        return browser.storage.session.getKeys();
    }
    const bin = await browser.storage.session.get(null);
    if ( bin instanceof Object === false ) { return; }
    return Object.keys(bin);
}

export async function sessionAccessLevel(level) {
    if ( typeof browser.storage?.session?.setAccessLevel !== 'function' ) {
        throw new Error('session storage access-level API unavailable');
    }
    return browser.storage.session.setAccessLevel(level);
}

/******************************************************************************/

export async function adminRead(key) {
    if ( browser.storage?.managed?.get === undefined ) { return; }
    const bin = await browser.storage.managed.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid managed storage response for ${key}`);
    }
    return Object.hasOwn(bin, key) ? bin[key] : undefined;
}

/******************************************************************************/
