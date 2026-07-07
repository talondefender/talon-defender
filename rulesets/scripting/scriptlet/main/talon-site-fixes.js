/*******************************************************************************

    Talon Defender - site compatibility fixes
    Copyright (C) 2026 Talon Defender

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
*/

// ruleset: talon-site-fixes

(function talonSiteFixes() {

/******************************************************************************/

const frenchStreamHostnames = new Set([ 'french-stream.one' ]);
const frenchStreamPlayerHostnames = new Set([
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
]);

const hostnameFromUrl = url => {
    try {
        return new URL(String(url || ''), document.location.href).hostname;
    } catch {
    }
    return '';
};

const hostname = document.location.hostname;
const referrerHostname = hostnameFromUrl(document.referrer);
const isFrenchStreamPage = frenchStreamHostnames.has(hostname);
const isFrenchStreamPlayerFrame =
    frenchStreamPlayerHostnames.has(hostname) &&
    frenchStreamHostnames.has(referrerHostname);

if ( isFrenchStreamPage === false && isFrenchStreamPlayerFrame === false ) {
    return;
}
if ( self.__talonFrenchStreamPopupGuard === true ) { return; }
Object.defineProperty(self, '__talonFrenchStreamPopupGuard', {
    value: true,
});

const nativeOpen = self.open;
const nativeWindowOpen = Window.prototype.open;
const nativeAnchorClick = HTMLAnchorElement.prototype.click;
const nativeFormSubmit = HTMLFormElement.prototype.submit;
const nativeFormRequestSubmit = HTMLFormElement.prototype.requestSubmit;
const nativeElementSetAttribute = Element.prototype.setAttribute;
const nativeWindowPostMessage = Window.prototype.postMessage;
const nativeElementRequestFullscreen = Element.prototype.requestFullscreen;
const nativeElementWebkitRequestFullscreen = Element.prototype.webkitRequestFullscreen;
const nativeElementMozRequestFullScreen = Element.prototype.mozRequestFullScreen;
const nativeElementMsRequestFullscreen = Element.prototype.msRequestFullscreen;
const noopWindow = {
    closed: false,
    close() { this.closed = true; },
    blur() {},
    focus() {},
    postMessage() {},
    opener: null,
    location: { href: '' },
};

const isSameOrigin = url => {
    try {
        const parsed = new URL(String(url || ''), document.location.href);
        return parsed.origin === document.location.origin;
    } catch {
    }
    return false;
};

const shouldBlockPopupUrl = url => {
    if ( typeof url !== 'string' || url.trim() === '' ) { return true; }
    if ( url.startsWith('#') ) { return false; }
    return isSameOrigin(url) === false;
};

const shouldBlockNavigationUrl = url => {
    if ( typeof url !== 'string' ) { return true; }
    const value = url.trim();
    if ( value === '' || value.startsWith('#') ) { return false; }
    return isSameOrigin(value) === false;
};

const sameDocumentTargetNames = new Set([ '', '_self', '_top', '_parent' ]);

const normalizeTargetName = target =>
    String(target || '').trim().toLowerCase();

const isPopupTargetName = target =>
    sameDocumentTargetNames.has(normalizeTargetName(target)) === false;

const getBaseTargetName = ( ) => {
    const base = document.querySelector('base[target]');
    return normalizeTargetName(base?.getAttribute('target') || '');
};

const getNavigationTargetName = element => {
    let target = normalizeTargetName(element?.getAttribute?.('target') || '');
    if ( target === '' ) {
        target = getBaseTargetName();
    }
    return target;
};

const getNavigationUrl = element => {
    if ( element instanceof HTMLAnchorElement ) {
        return element.getAttribute('href') || element.href || '';
    }
    if ( element instanceof HTMLFormElement ) {
        return element.getAttribute('action') || element.action || document.location.href;
    }
    return '';
};

const topPlayerGestureSelector = [
    '#main-player',
    '#video-iframe',
    '#trailer-iframe',
    'iframe[src*="fsvid.lol"]',
    'iframe[src*="kakaflix.lol"]',
    'iframe[src*="uqload.is"]',
    'iframe[src*="vidzy.cc"]',
    '.plyr',
    '.jwplayer',
    '.video-js',
    '[id*="player" i]',
    '[class*="player" i]',
    '[data-plyr]',
].join(',');

const eventPathContainsTopPlayer = ev => {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    return path.some(entry =>
        entry instanceof Element &&
        entry.matches?.(topPlayerGestureSelector)
    );
};

const playerGestureWindowMs = 5000;
let recentPlayerGestureAt = 0;
let recentCreativeMessageAt = 0;

const recordPlayerGesture = ( ) => {
    recentPlayerGestureAt = Date.now();
};

const recordCreativeMessage = ( ) => {
    recentCreativeMessageAt = Date.now();
};

const hasRecentPlayerGesture = ( ) =>
    Date.now() - recentPlayerGestureAt <= playerGestureWindowMs;

const hasRecentCreativeMessage = ( ) =>
    Date.now() - recentCreativeMessageAt <= playerGestureWindowMs;

const isTopPlayerGestureEvent = ev => {
    if ( isFrenchStreamPage === false || ev?.isTrusted !== true ) { return false; }
    const target = ev.target instanceof Element ? ev.target : null;
    return (
        target?.closest?.(topPlayerGestureSelector) instanceof Element ||
        eventPathContainsTopPlayer(ev)
    );
};

const shouldBlockPlayerGesturePopupUrl = url => {
    if ( isFrenchStreamPlayerFrame === false && isFrenchStreamPage === false ) {
        return false;
    }
    if ( hasRecentPlayerGesture() === false && hasRecentCreativeMessage() === false ) {
        return false;
    }
    if ( typeof url !== 'string' || url.trim() === '' ) { return true; }
    if ( isFrenchStreamPage ) {
        return shouldBlockNavigationUrl(url);
    }
    return url.trim().startsWith('#') === false;
};

const shouldBlockPlayerGestureNavigationUrl = url => {
    if ( isFrenchStreamPlayerFrame === false && isFrenchStreamPage === false ) {
        return false;
    }
    if ( hasRecentPlayerGesture() === false && hasRecentCreativeMessage() === false ) {
        return false;
    }
    if ( typeof url !== 'string' ) { return true; }
    const value = url.trim();
    if ( value === '' || value.startsWith('#') ) { return false; }
    if ( isFrenchStreamPage ) {
        return shouldBlockNavigationUrl(value);
    }
    return true;
};

const shouldBlockPopupOpen = url =>
    shouldBlockPlayerGesturePopupUrl(url) || shouldBlockPopupUrl(url);

const shouldBlockPopupNavigation = element => {
    if (
        element instanceof HTMLAnchorElement === false &&
        element instanceof HTMLFormElement === false
    ) {
        return false;
    }
    const url = getNavigationUrl(element);
    if ( shouldBlockPlayerGestureNavigationUrl(url) ) { return true; }
    if ( isPopupTargetName(getNavigationTargetName(element)) === false ) { return false; }
    return shouldBlockNavigationUrl(url);
};

const safeFrenchStreamContentClickEvents = new Set([
    'pointerdown',
    'mousedown',
    'touchstart',
    'click',
]);

const shouldShieldFrenchStreamContentNavigation = (ev, element) => {
    if ( isFrenchStreamPage === false || ev?.isTrusted !== true ) { return false; }
    if ( element instanceof HTMLAnchorElement === false ) { return false; }
    if ( safeFrenchStreamContentClickEvents.has(ev.type) === false ) { return false; }
    if ( ev.type !== 'touchstart' && ev.button !== 0 ) { return false; }
    if ( ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey ) { return false; }
    if ( isPopupTargetName(getNavigationTargetName(element)) ) { return false; }
    const url = getNavigationUrl(element).trim();
    if ( url === '' || url.startsWith('#') ) { return false; }
    if ( shouldBlockNavigationUrl(url) ) { return false; }
    return element.matches?.([
        'a[href*="newsid"]',
        'a.short-poster[href]',
        '.short a[href]',
        '.sect-c a[href]',
    ].join(','));
};

const blockAnchorPopup = anchor => {
    if ( anchor instanceof HTMLAnchorElement === false ) { return false; }
    return shouldBlockPopupNavigation(anchor);
};

const blockFormPopup = form => {
    if ( form instanceof HTMLFormElement === false ) { return false; }
    return shouldBlockPopupNavigation(form);
};

const shouldNeutralizePopupTargetAssignment = (element, target) => {
    if ( isPopupTargetName(target) === false ) { return false; }
    if ( element instanceof HTMLBaseElement ) {
        return isFrenchStreamPage || isFrenchStreamPlayerFrame;
    }
    if (
        element instanceof HTMLAnchorElement === false &&
        element instanceof HTMLFormElement === false
    ) {
        return false;
    }
    if ( hasRecentPlayerGesture() || hasRecentCreativeMessage() ) { return true; }
    return shouldBlockNavigationUrl(getNavigationUrl(element));
};

const neutralizePopupTarget = element => {
    if ( element instanceof Element === false ) { return; }
    if ( shouldNeutralizePopupTargetAssignment(element, element.getAttribute('target')) === false ) {
        return;
    }
    try {
        Reflect.apply(nativeElementSetAttribute, element, [ 'target', '_self' ]);
    } catch {
        try {
            element.removeAttribute('target');
        } catch {
        }
    }
};

const neutralizePopupBaseTargets = ( ) => {
    if ( isFrenchStreamPage === false && isFrenchStreamPlayerFrame === false ) { return; }
    for ( const base of document.querySelectorAll('base[target]') ) {
        neutralizePopupTarget(base);
    }
};

const navigationElementFromEvent = ev => {
    const target = ev.target instanceof Element ? ev.target : null;
    return target?.closest?.('a[href],form') || null;
};

const preventPopupNavigation = ev => {
    if ( isTopPlayerGestureEvent(ev) ) {
        recordPlayerGesture();
    }
    neutralizePopupBaseTargets();
    const element = navigationElementFromEvent(ev);
    if ( shouldBlockPopupNavigation(element) ) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
    }
    if ( shouldShieldFrenchStreamContentNavigation(ev, element) ) {
        ev.stopImmediatePropagation();
    }
};

const parseMessageData = data => {
    if ( typeof data === 'string' ) {
        try {
            return JSON.parse(data);
        } catch {
        }
        return null;
    }
    if ( data instanceof Object ) { return data; }
    return null;
};

const shouldBlockCreativeMessage = data => {
    const parsed = parseMessageData(data);
    if ( parsed?.itIsMessageForCreative !== true ) { return false; }
    recordCreativeMessage();
    return true;
};

const fullscreenIntentWindowMs = 3500;
let recentFullscreenIntentAt = 0;
const fullscreenControlSelector = [
    '[data-plyr="fullscreen"]',
    '.vjs-fullscreen-control',
    '.jw-icon-fullscreen',
    '.plyr__control--fullscreen',
    '[aria-label*="fullscreen" i]',
    '[title*="fullscreen" i]',
    '[class*="fullscreen" i]',
].join(',');

const recordFullscreenIntent = ( ) => {
    recentFullscreenIntentAt = Date.now();
};

const hasRecentFullscreenIntent = ( ) =>
    Date.now() - recentFullscreenIntentAt <= fullscreenIntentWindowMs;

const originHostnameFromEvent = ev => {
    try {
        return new URL(String(ev.origin || '')).hostname;
    } catch {
    }
    return '';
};

const isTrustedFullscreenControlEvent = ev => {
    if ( ev.isTrusted !== true ) { return false; }
    const target = ev.target instanceof Element ? ev.target : null;
    return target?.closest?.(fullscreenControlSelector) instanceof Element;
};

const postTopFullscreenIntent = ( ) => {
    if ( self.parent === self ) { return; }
    let targetOrigin = '*';
    try {
        targetOrigin = new URL(document.referrer).origin || targetOrigin;
    } catch {
    }
    try {
        self.parent.postMessage({
            __talonFrenchStreamFullscreenIntent: true,
            at: Date.now(),
        }, targetOrigin);
    } catch {
    }
};

const recordPlayerFullscreenIntent = ev => {
    if ( isTrustedFullscreenControlEvent(ev) === false ) { return; }
    recordFullscreenIntent();
    postTopFullscreenIntent();
};

const preventUnsolicitedFullscreenMessage = ev => {
    const data = parseMessageData(ev.data);
    if (
        data?.__talonFrenchStreamFullscreenIntent === true &&
        frenchStreamPlayerHostnames.has(originHostnameFromEvent(ev))
    ) {
        recordFullscreenIntent();
        ev.stopImmediatePropagation();
        return;
    }
    if (
        isFrenchStreamPage &&
        frenchStreamPlayerHostnames.has(originHostnameFromEvent(ev)) &&
        data?.action === 'enter_fullscreen' &&
        hasRecentFullscreenIntent() === false
    ) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
    }
};

const shouldBlockFullscreenRequest = element => {
    if ( isFrenchStreamPage === false ) { return false; }
    if ( element instanceof HTMLIFrameElement === false ) { return false; }
    if ( element.id !== 'video-iframe' ) { return false; }
    const frameHostname = hostnameFromUrl(element.getAttribute('src') || element.src || '');
    if ( frenchStreamPlayerHostnames.has(frameHostname) === false ) { return false; }
    return hasRecentFullscreenIntent() === false;
};

const blockedFullscreenPromise = ( ) => Promise.resolve();

const hiddenFrenchStreamFrameSelector = [
    'iframe[src^="https://fsurl.lol/sso.php"]',
    'iframe[src^="http://fsurl.lol/sso.php"]',
].join(',');

const wrapFullscreenRequest = (nativeMethod, propertyName) => {
    if ( typeof nativeMethod !== 'function' ) { return; }
    try {
        Object.defineProperty(Element.prototype, propertyName, {
            configurable: true,
            writable: true,
            value: function talonFrenchStreamRequestFullscreen(...args) {
                if ( shouldBlockFullscreenRequest(this) ) {
                    return blockedFullscreenPromise();
                }
                return Reflect.apply(nativeMethod, this, args);
            },
        });
    } catch {
    }
};

const removeStartupFlickerFrames = ( ) => {
    if ( isFrenchStreamPage === false ) { return; }
    for ( const frame of document.querySelectorAll(hiddenFrenchStreamFrameSelector) ) {
        frame.remove();
    }
};

const hidePopupOverlays = ( ) => {
    if (
        document.documentElement instanceof Element &&
        document.getElementById('talon-french-stream-popup-style') === null
    ) {
        const style = document.createElement('style');
        style.id = 'talon-french-stream-popup-style';
        style.textContent = [
            '#dontfoid{',
            'display:none!important;',
            'visibility:hidden!important;',
            'pointer-events:none!important;',
            '}',
            hiddenFrenchStreamFrameSelector,
            '{',
            'display:none!important;',
            'visibility:hidden!important;',
            'pointer-events:none!important;',
            'opacity:0!important;',
            'width:0!important;',
            'height:0!important;',
            '}',
            '#trailer-iframe{',
            'pointer-events:none!important;',
            '}',
        ].join('');
        document.documentElement.append(style);
    }
    for ( const overlay of document.querySelectorAll('#dontfoid') ) {
        overlay.remove();
    }
    neutralizePopupBaseTargets();
    removeStartupFlickerFrames();
};

const startOverlayObserver = ( ) => {
    hidePopupOverlays();
    if ( self.__talonFrenchStreamOverlayObserver instanceof MutationObserver ) {
        return;
    }
    const observer = new MutationObserver(hidePopupOverlays);
    Object.defineProperty(self, '__talonFrenchStreamOverlayObserver', {
        value: observer,
    });
    const target = document.documentElement instanceof Element
        ? document.documentElement
        : document;
    observer.observe(target, {
        childList: true,
        subtree: true,
    });
    if ( target === document ) {
        document.addEventListener('DOMContentLoaded', ( ) => {
            try {
                observer.disconnect();
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                });
            } catch {
            }
            hidePopupOverlays();
        }, { once: true });
    }
};

startOverlayObserver();

const guardedOpen = function(url, ...args) {
    if ( shouldBlockPopupOpen(url) ) {
        return noopWindow;
    }
    const opener = typeof nativeWindowOpen === 'function' ? nativeWindowOpen : nativeOpen;
    const receiver = this instanceof Window ? this : self;
    return Reflect.apply(opener, receiver, [ url, ...args ]);
};

try {
    Object.defineProperty(Window.prototype, 'open', {
        configurable: true,
        writable: true,
        value: guardedOpen,
    });
} catch {
}

try {
    Object.defineProperty(self, 'open', {
        configurable: true,
        get() {
            return guardedOpen;
        },
        set() {
        },
    });
} catch {
    self.open = guardedOpen;
}

const wrapTargetSetAttribute = prototype => {
    if ( typeof nativeElementSetAttribute !== 'function' ) { return; }
    try {
        Object.defineProperty(prototype, 'setAttribute', {
            configurable: true,
            writable: true,
            value: function setAttribute(name, value) {
                let nextValue = value;
                if (
                    String(name || '').toLowerCase() === 'target' &&
                    shouldNeutralizePopupTargetAssignment(this, value)
                ) {
                    nextValue = '_self';
                }
                return Reflect.apply(nativeElementSetAttribute, this, [ name, nextValue ]);
            },
        });
    } catch {
    }
};

const findTargetPropertyDescriptor = prototype => {
    for (
        let current = prototype;
        current instanceof Object;
        current = Object.getPrototypeOf(current)
    ) {
        const descriptor = Object.getOwnPropertyDescriptor(current, 'target');
        if ( descriptor !== undefined ) { return descriptor; }
    }
    return undefined;
};

const wrapTargetProperty = prototype => {
    const descriptor = findTargetPropertyDescriptor(prototype);
    if (
        descriptor instanceof Object === false ||
        typeof descriptor.get !== 'function' ||
        typeof descriptor.set !== 'function'
    ) {
        return;
    }
    try {
        Object.defineProperty(prototype, 'target', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
                return Reflect.apply(descriptor.get, this, []);
            },
            set(value) {
                const nextValue = shouldNeutralizePopupTargetAssignment(this, value)
                    ? '_self'
                    : value;
                return Reflect.apply(descriptor.set, this, [ nextValue ]);
            },
        });
    } catch {
    }
};

wrapTargetProperty(HTMLAnchorElement.prototype);
wrapTargetProperty(HTMLFormElement.prototype);
wrapTargetProperty(HTMLBaseElement.prototype);
wrapTargetSetAttribute(HTMLAnchorElement.prototype);
wrapTargetSetAttribute(HTMLFormElement.prototype);
wrapTargetSetAttribute(HTMLBaseElement.prototype);

HTMLAnchorElement.prototype.click = function click() {
    if ( blockAnchorPopup(this) ) { return; }
    return Reflect.apply(nativeAnchorClick, this, arguments);
};

HTMLFormElement.prototype.submit = function submit() {
    if ( blockFormPopup(this) ) { return; }
    return Reflect.apply(nativeFormSubmit, this, arguments);
};

if ( typeof nativeFormRequestSubmit === 'function' ) {
    HTMLFormElement.prototype.requestSubmit = function requestSubmit(submitter) {
        if ( blockFormPopup(this) ) { return; }
        return Reflect.apply(nativeFormRequestSubmit, this, [ submitter ]);
    };
}

if ( typeof nativeWindowPostMessage === 'function' ) {
    Window.prototype.postMessage = function postMessage(message, ...args) {
        if ( shouldBlockCreativeMessage(message) ) { return; }
        return Reflect.apply(nativeWindowPostMessage, this, [ message, ...args ]);
    };
}

for ( const eventName of [ 'pointerdown', 'mousedown', 'touchstart', 'click', 'auxclick' ] ) {
    document.addEventListener(eventName, preventPopupNavigation, {
        capture: true,
        passive: false,
    });
}
window.addEventListener('message', preventUnsolicitedFullscreenMessage, true);

if ( isFrenchStreamPlayerFrame ) {
    for ( const eventName of [ 'pointerdown', 'mousedown', 'touchstart', 'click', 'auxclick' ] ) {
        window.addEventListener(eventName, ev => {
            if ( ev.isTrusted === true ) { recordPlayerGesture(); }
        }, true);
        document.addEventListener(eventName, ev => {
            if ( ev.isTrusted === true ) { recordPlayerGesture(); }
        }, true);
    }
    document.addEventListener('pointerdown', recordPlayerFullscreenIntent, true);
    document.addEventListener('click', recordPlayerFullscreenIntent, true);
}

if ( isFrenchStreamPage ) {
    document.addEventListener('pointerdown', ev => {
        if ( isTrustedFullscreenControlEvent(ev) ) { recordFullscreenIntent(); }
    }, true);
    document.addEventListener('click', ev => {
        if ( isTrustedFullscreenControlEvent(ev) ) { recordFullscreenIntent(); }
    }, true);
    wrapFullscreenRequest(nativeElementRequestFullscreen, 'requestFullscreen');
    wrapFullscreenRequest(nativeElementWebkitRequestFullscreen, 'webkitRequestFullscreen');
    wrapFullscreenRequest(nativeElementMozRequestFullScreen, 'mozRequestFullScreen');
    wrapFullscreenRequest(nativeElementMsRequestFullscreen, 'msRequestFullscreen');
}

const preventFormPopup = ev => {
    neutralizePopupBaseTargets();
    if ( blockFormPopup(ev.target) === false ) { return; }
    ev.preventDefault();
    ev.stopImmediatePropagation();
};

document.addEventListener('submit', preventFormPopup, true);

/******************************************************************************/

})();

void 0;
