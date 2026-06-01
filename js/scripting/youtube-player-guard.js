/******************************************************************************/
// Important!
// Runs in the page world so YouTube sees sanitized player data before playback.
(function talonYoutubePlayerGuard(global) {

if ( global.TalonYoutubePlayerGuardController ) {
    global.TalonYoutubePlayerGuardController.refresh?.();
    return;
}

const YOUTUBE_HOST_RE = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const PLAYER_RESPONSE_URL_RE =
    /(?:\/youtubei\/v1\/player\b|\/player(?:\?|$)|\/watch\?|\/get_watch\?|\/playlist\?list=)/i;
const DRM_LICENSE_RE = /get_drm_license/i;
const AD_KEYS = Object.freeze([ 'adPlacements', 'adSlots', 'playerAds' ]);
const MAX_PRUNE_DEPTH = 8;
const SSAP_NAMESPACE = 'ssap';
const SSAP_MAX_RANGES = 16;
const SSAP_LOOP_CHECK_MS = 250;
const SSAP_LOOP_WINDOW_MS = 15000;
const YOUTUBE_URL_FALLBACK = 'https:' + '//www.youtube.com/';

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const nativeJSONParse = win.JSON?.parse;
    const nativeJSONStringify = win.JSON?.stringify;
    const nativePromiseThen = win.Promise?.prototype?.then;
    const nativeAppendChild = win.Node?.prototype?.appendChild;
    let installed = false;
    let lastHref = String(win.location?.href || '');
    let ssapRanges = [];
    let ssapRangeIds = [];
    let ssapCaptureArmed = false;
    let lastCorrectedRangeKey = '';
    let ssapIntervalId;
    let ssapIntervalStartedAt = 0;
    let ssapObserver;
    let ssapGuardInstalled = false;
    let abnormalityGuardInstalled = false;
    let abnormalityGuardHits = 0;
    const abnormalityCallbackCache = new WeakMap();
    let iframeFetchBridgeInstalled = false;

    const isYouTubeHost = () =>
        YOUTUBE_HOST_RE.test(String(win.location?.hostname || ''));

    const currentHref = () => String(win.location?.href || '');

    const refreshNavigationState = () => {
        const href = currentHref();
        if ( href === lastHref ) { return; }
        lastHref = href;
        ssapRanges = [];
        ssapRangeIds = [];
        ssapCaptureArmed = false;
        lastCorrectedRangeKey = '';
    };

    const getRequestUrl = input => {
        if ( typeof input === 'string' ) { return input; }
        if ( input instanceof Object && typeof input.url === 'string' ) {
            return input.url;
        }
        return '';
    };

    const isPlayerResponseUrl = input => {
        const rawUrl = getRequestUrl(input);
        if ( rawUrl === '' || DRM_LICENSE_RE.test(rawUrl) ) { return false; }
        let url;
        try {
            url = new win.URL(rawUrl, win.location?.href || YOUTUBE_URL_FALLBACK);
        } catch {
            return PLAYER_RESPONSE_URL_RE.test(rawUrl);
        }
        if ( YOUTUBE_HOST_RE.test(url.hostname) === false ) { return false; }
        return PLAYER_RESPONSE_URL_RE.test(`${url.pathname}${url.search}`);
    };

    const isObject = value =>
        value !== null && (typeof value === 'object' || typeof value === 'function');

    const isShortsAdEntry = value => {
        if ( isObject(value) === false ) { return false; }
        const endpoint = value.reelWatchEndpoint ||
            value.reelItemRenderer?.navigationEndpoint?.reelWatchEndpoint ||
            value.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint;
        return isObject(endpoint?.adClientParams);
    };

    const pruneAds = (value, seen = new WeakSet(), depth = 0) => {
        if ( isObject(value) === false || seen.has(value) || depth > MAX_PRUNE_DEPTH ) {
            return value;
        }
        seen.add(value);

        for ( const key of AD_KEYS ) {
            try {
                if ( Object.prototype.hasOwnProperty.call(value, key) ) {
                    delete value[key];
                }
            } catch {
            }
        }

        if ( Array.isArray(value) ) {
            for ( let i = value.length - 1; i >= 0; i-- ) {
                if ( isShortsAdEntry(value[i]) ) {
                    value.splice(i, 1);
                    continue;
                }
                pruneAds(value[i], seen, depth + 1);
            }
            return value;
        }

        let keys;
        try {
            keys = Object.keys(value);
        } catch {
            return value;
        }
        for ( const key of keys ) {
            pruneAds(value[key], seen, depth + 1);
        }
        return value;
    };

    const textMayContainAdMetadata = text =>
        AD_KEYS.some(key => text.includes(key)) ||
        text.includes('adClientParams');

    const sanitizeJsonText = text => {
        if ( typeof text !== 'string' || text === '' ) { return text; }
        if ( typeof nativeJSONParse !== 'function' ||
            typeof nativeJSONStringify !== 'function' ) {
            return text;
        }

        const xssiPrefix = text.startsWith(")]}'")
            ? text.slice(0, text.indexOf('\n') + 1 || 0)
            : '';
        const body = xssiPrefix === '' ? text : text.slice(xssiPrefix.length);
        if ( textMayContainAdMetadata(body) === false ) { return text; }
        let parsed;
        try {
            parsed = nativeJSONParse.call(win.JSON, body);
        } catch {
            return text;
        }
        pruneAds(parsed);
        try {
            return `${xssiPrefix}${nativeJSONStringify.call(win.JSON, parsed)}`;
        } catch {
            return text;
        }
    };

    const installResponsePropertyGuard = propertyName => {
        let current = pruneAds(win[propertyName]);
        try {
            Object.defineProperty(win, propertyName, {
                configurable: true,
                get() {
                    return current;
                },
                set(value) {
                    current = pruneAds(value);
                },
            });
        } catch {
        }
    };

    const installJsonParseGuard = () => {
        if ( typeof nativeJSONParse !== 'function' ) { return false; }
        try {
            win.JSON.parse = new win.Proxy(nativeJSONParse, {
                apply(target, thisArg, args) {
                    const parsed = win.Reflect.apply(target, thisArg, args);
                    if ( String(win.location?.pathname || '').startsWith('/shorts/') ) {
                        pruneAds(parsed);
                    }
                    return parsed;
                },
            });
            return true;
        } catch {
        }
        return false;
    };

    const promiseThen = (value, onFulfilled) => {
        const promise = win.Promise.resolve(value);
        if ( typeof nativePromiseThen === 'function' ) {
            return nativePromiseThen.call(promise, onFulfilled);
        }
        return promise.then(onFulfilled);
    };

    const wrapPlayerResponse = response => {
        if ( isObject(response) === false || typeof win.Proxy !== 'function' ) {
            return response;
        }
        try {
            return new win.Proxy(response, {
                get(target, property, receiver) {
                    if ( property === 'json' && typeof target.json === 'function' ) {
                        return (...args) =>
                            promiseThen(
                                win.Reflect.apply(target.json, target, args),
                                value => pruneAds(value)
                            );
                    }
                    if ( property === 'text' && typeof target.text === 'function' ) {
                        return (...args) =>
                            promiseThen(
                                win.Reflect.apply(target.text, target, args),
                                text => sanitizeJsonText(text)
                            );
                    }
                    if ( property === 'clone' && typeof target.clone === 'function' ) {
                        return (...args) =>
                            wrapPlayerResponse(
                                win.Reflect.apply(target.clone, target, args)
                            );
                    }
                    const value = win.Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        } catch {
        }
        return response;
    };

    const installFetchGuard = () => {
        if ( typeof win.fetch !== 'function' ) { return false; }
        const nativeFetch = win.fetch;
        try {
            win.fetch = new win.Proxy(nativeFetch, {
                apply(target, thisArg, args) {
                    const shouldSanitize = isPlayerResponseUrl(args[0]);
                    const responsePromise = win.Reflect.apply(target, thisArg, args);
                    if ( shouldSanitize === false ) { return responsePromise; }
                    return promiseThen(responsePromise, wrapPlayerResponse);
                },
            });
            return true;
        } catch {
        }
        return false;
    };

    const patchXhrText = (xhr, text) => {
        const sanitizedText = sanitizeJsonText(text);
        if ( sanitizedText === text ) { return; }
        try {
            Object.defineProperty(xhr, 'responseText', {
                configurable: true,
                get: () => sanitizedText,
            });
        } catch {
        }
        try {
            Object.defineProperty(xhr, 'response', {
                configurable: true,
                get: () => sanitizedText,
            });
        } catch {
        }
    };

    const installXhrGuard = () => {
        const proto = win.XMLHttpRequest?.prototype;
        if ( isObject(proto) === false ||
            typeof proto.open !== 'function' ||
            typeof proto.send !== 'function' ) {
            return false;
        }

        const urls = new WeakMap();
        const nativeOpen = proto.open;
        const nativeSend = proto.send;
        try {
            proto.open = new win.Proxy(nativeOpen, {
                apply(target, thisArg, args) {
                    urls.set(thisArg, getRequestUrl(args[1]));
                    return win.Reflect.apply(target, thisArg, args);
                },
            });
            proto.send = new win.Proxy(nativeSend, {
                apply(target, thisArg, args) {
                    const url = urls.get(thisArg) || '';
                    if ( isPlayerResponseUrl(url) ) {
                        try {
                            thisArg.addEventListener('readystatechange', () => {
                                if ( thisArg.readyState !== 4 ) { return; }
                                const responseType = `${thisArg.responseType || ''}`;
                                if ( responseType === 'json' ) {
                                    pruneAds(thisArg.response);
                                    return;
                                }
                                if ( responseType !== '' && responseType !== 'text' ) { return; }
                                patchXhrText(thisArg, thisArg.responseText);
                            });
                        } catch {
                        }
                    }
                    return win.Reflect.apply(target, thisArg, args);
                },
            });
            return true;
        } catch {
        }
        return false;
    };

    const isSsapExperimentEnabled = () => {
        try {
            return win.yt?.config_?.EXPERIMENT_FLAGS?.html5_enable_ssap_entity_id === true;
        } catch {
        }
        return false;
    };

    const recordSsapRange = value => {
        refreshNavigationState();
        if ( isSsapExperimentEnabled() === false ||
            isObject(value) === false ||
            value === win ||
            value.namespace !== SSAP_NAMESPACE ) {
            return false;
        }
        const start = Number(value.start);
        const end = Number(value.end);
        const id = typeof value.id === 'string' ? value.id : '';
        if ( Number.isFinite(start) === false ||
            Number.isFinite(end) === false ||
            id === '' ||
            start < 0 ||
            end <= start ) {
            return false;
        }
        if ( ssapCaptureArmed === false ) {
            if ( start !== 0 || ssapRangeIds.includes(id) ) { return false; }
            ssapRanges = [];
            ssapRangeIds = [];
            ssapCaptureArmed = true;
        } else if ( start === 0 || ssapRangeIds.includes(id) ) {
            return false;
        }
        ssapRanges.push({
            start,
            end,
            id,
            href: currentHref(),
        });
        ssapRangeIds.push(id);
        if ( ssapRanges.length > SSAP_MAX_RANGES ) {
            ssapRanges = ssapRanges.slice(-SSAP_MAX_RANGES);
            ssapRangeIds = ssapRangeIds.slice(-SSAP_MAX_RANGES);
        }
        startSsapLoopCheck();
        return true;
    };

    const getLatestSsapRange = () => {
        refreshNavigationState();
        for ( let i = ssapRanges.length - 1; i >= 0; i-- ) {
            const range = ssapRanges[i];
            if ( range.href === lastHref ) { return range; }
        }
        return null;
    };

    const queryVideo = () => {
        try {
            return doc?.querySelector?.('video') || null;
        } catch {
        }
        return null;
    };

    const correctSsapLoop = () => {
        if ( isSsapExperimentEnabled() === false ) { return false; }
        const range = getLatestSsapRange();
        if ( range === null ) { return false; }
        const video = queryVideo();
        if ( video === null ) { return false; }

        const duration = Number(video.duration);
        const currentTime = Number(video.currentTime);
        const startSeconds = range.start / 1000;
        const endSeconds = range.end / 1000;
        if ( Number.isFinite(duration) === false ||
            Number.isFinite(currentTime) === false ||
            duration <= 0 ||
            endSeconds <= 0 ) {
            return false;
        }
        if ( Math.abs(duration - endSeconds) > 0.75 ) { return false; }
        if ( currentTime + 0.5 >= startSeconds ) { return false; }
        const rangeKey = ssapRangeIds.join(',');
        if ( video.loop !== true && lastCorrectedRangeKey === rangeKey ) {
            return false;
        }

        try {
            video.currentTime = Math.min(duration, startSeconds + 0.01);
            lastCorrectedRangeKey = rangeKey;
            ssapCaptureArmed = false;
            return true;
        } catch {
        }
        return false;
    };

    function startSsapLoopCheck() {
        if ( ssapIntervalId !== undefined || typeof win.setInterval !== 'function' ) {
            return;
        }
        ssapIntervalStartedAt = Date.now();
        ssapIntervalId = win.setInterval(() => {
            correctSsapLoop();
            if ( (Date.now() - ssapIntervalStartedAt) <= SSAP_LOOP_WINDOW_MS ) {
                return;
            }
            stopSsapLoopCheck();
        }, SSAP_LOOP_CHECK_MS);
    }

    const stopSsapLoopCheck = () => {
        if ( ssapIntervalId === undefined ) { return; }
        try {
            win.clearInterval(ssapIntervalId);
        } catch {
        }
        ssapIntervalId = undefined;
    };

    const installSsapGuard = () => {
        if ( ssapGuardInstalled ) { return true; }
        if ( isSsapExperimentEnabled() === false ) { return false; }
        const nativePush = win.Array?.prototype?.push;
        if ( typeof nativePush !== 'function' ) { return false; }
        try {
            win.Array.prototype.push = new win.Proxy(nativePush, {
                apply(target, thisArg, args) {
                    for ( const value of args ) {
                        recordSsapRange(value);
                    }
                    const result = win.Reflect.apply(target, thisArg, args);
                    correctSsapLoop();
                    return result;
                },
            });
            ssapGuardInstalled = true;
            return true;
        } catch {
        }
        return false;
    };

    const isAbnormalityCallback = value => {
        if ( typeof value !== 'function' ) { return false; }
        if ( abnormalityCallbackCache.has(value) ) {
            return abnormalityCallbackCache.get(value);
        }
        let matched = false;
        try {
            const name = typeof value.name === 'string' ? value.name : '';
            matched = name.includes('onAbnormalityDetected') ||
                String(value).includes('onAbnormalityDetected');
        } catch {
        }
        try {
            abnormalityCallbackCache.set(value, matched);
        } catch {
        }
        return matched;
    };

    const installAbnormalityGuard = () => {
        if ( abnormalityGuardInstalled ||
            typeof nativePromiseThen !== 'function' ||
            typeof win.Proxy !== 'function' ) {
            return false;
        }
        try {
            win.Promise.prototype.then = new win.Proxy(nativePromiseThen, {
                apply(target, thisArg, args) {
                    if ( isAbnormalityCallback(args?.[0]) ) {
                        abnormalityGuardHits += 1;
                        args[0] = function talonIgnoredYouTubeAbnormality() {};
                    }
                    return win.Reflect.apply(target, thisArg, args);
                },
            });
            abnormalityGuardInstalled = true;
            return true;
        } catch {
        }
        return false;
    };

    const bridgeFetchIntoIframe = iframe => {
        if ( iframe instanceof win.HTMLIFrameElement === false ) { return false; }
        const src = typeof iframe.src === 'string' ? iframe.src : '';
        if ( src !== '' && src !== 'about:blank' ) { return false; }
        try {
            const frameWindow = iframe.contentWindow;
            if ( isObject(frameWindow) === false ) { return false; }
            frameWindow.fetch = win.fetch;
            frameWindow.Request = win.Request;
            return true;
        } catch {
        }
        return false;
    };

    const installIframeFetchBridge = () => {
        if ( iframeFetchBridgeInstalled ||
            typeof nativeAppendChild !== 'function' ||
            typeof win.Proxy !== 'function' ||
            typeof win.fetch !== 'function' ||
            typeof win.Request !== 'function' ||
            typeof win.HTMLIFrameElement !== 'function' ) {
            return false;
        }
        try {
            win.Node.prototype.appendChild = new win.Proxy(nativeAppendChild, {
                apply(target, thisArg, args) {
                    const result = win.Reflect.apply(target, thisArg, args);
                    bridgeFetchIntoIframe(result);
                    return result;
                },
            });
            iframeFetchBridgeInstalled = true;
            return true;
        } catch {
        }
        return false;
    };

    const startSsapObserver = () => {
        if ( ssapObserver !== undefined ||
            typeof win.MutationObserver !== 'function' ||
            isSsapExperimentEnabled() === false ) {
            return;
        }
        try {
            ssapObserver = new win.MutationObserver(() => {
                refreshNavigationState();
                correctSsapLoop();
            });
            ssapObserver.observe(doc?.documentElement || doc, {
                childList: true,
                subtree: true,
            });
            correctSsapLoop();
        } catch {
            ssapObserver = undefined;
        }
    };

    const ensureSsapGuards = () => {
        if ( installSsapGuard() ) {
            startSsapObserver();
        }
    };

    const installNavigationListeners = () => {
        const onNavigate = () => {
            refreshNavigationState();
            ensureSsapGuards();
            correctSsapLoop();
        };
        try {
            doc?.addEventListener?.('yt-navigate-start', onNavigate);
            doc?.addEventListener?.('yt-navigate-finish', onNavigate);
            doc?.addEventListener?.('DOMContentLoaded', onNavigate);
            win.addEventListener?.('popstate', onNavigate);
            win.addEventListener?.('pagehide', stopSsapLoopCheck, { once: true });
        } catch {
        }
    };

    const install = () => {
        if ( installed || isYouTubeHost() === false ) { return false; }
        installed = true;
        installResponsePropertyGuard('ytInitialPlayerResponse');
        installResponsePropertyGuard('playerResponse');
        installJsonParseGuard();
        installFetchGuard();
        installXhrGuard();
        ensureSsapGuards();
        installAbnormalityGuard();
        installIframeFetchBridge();
        installNavigationListeners();
        return true;
    };

    return {
        correctSsapLoop,
        getLatestSsapRange,
        getAbnormalityGuardStats: () => ({
            installed: abnormalityGuardInstalled,
            hits: abnormalityGuardHits,
        }),
        install,
        installAbnormalityGuard,
        installIframeFetchBridge,
        installFetchGuard,
        installJsonParseGuard,
        installResponsePropertyGuard,
        installSsapGuard,
        installXhrGuard,
        isSsapExperimentEnabled,
        isPlayerResponseUrl,
        pruneAds,
        recordSsapRange,
        refresh: install,
        sanitizeJsonText,
        textMayContainAdMetadata,
    };
};

if ( global.__talonYoutubePlayerGuardTest === true ) {
    global.__talonYoutubePlayerGuardCreateController = createController;
    return;
}

const controller = createController(global);
global.TalonYoutubePlayerGuardController = controller;
controller.install();

})(globalThis);

void 0;
