/******************************************************************************/
// Important!
// Runs in the page world so YouTube playback guards install before player setup.
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
const PLAYBACK_WALL_SELECTORS = Object.freeze([
    'ytd-enforcement-message-view-model',
    'ytd-player-error-message-renderer',
    'yt-playability-error-supported-renderers',
    '#player-error-message-container',
    '#error-screen',
]);
const RESET_LITE_RELOAD_FLAG = 'talon.youtube.resetLite.reloaded.v5';
const RESET_LITE_WINDOW_NAME_TOKEN = 'talon-youtube-reset-lite-reloaded-v5';
const PLAYBACK_WALL_TEXT_PATTERN_RE =
    /Ad\s+blockers\s+violate\s+YouTube(?:['\u2019]|&#(?:39|x27);)s\s+Terms\s+of\s+Service/i;
const MAX_PLAYBACK_WALL_BODY_TEXT_LENGTH = 1000000;
const WALL_RECOVERY_CHECK_INTERVAL_MS = 500;
const WALL_RECOVERY_CHECK_WINDOW_MS = 20000;
const WALL_RECOVERY_MUTATION_DELAY_MS = 50;
const RESET_LITE_COOKIE_NAMES = Object.freeze([
    'GPS',
    'PREF',
    'VISITOR_INFO1_LIVE',
    'VISITOR_PRIVACY_METADATA',
    'YSC',
]);
const RESET_LITE_STORAGE_KEY_PATTERNS = Object.freeze([
    /ad[-_]?block/i,
    /ad[-_]?blocker/i,
    /anti[-_]?ad/i,
    /blocker[-_]?detected/i,
    /enforcement/i,
    /playback[-_]?(?:block|blocked|wall)/i,
    /abnormality/i,
    /interruption/i,
]);
const ABNORMALITY_CALLBACK_TEXT_RE =
    /(?:onAbnormalityDetected|abnormality|ad[-_\s]?block(?:er)?[^}]{0,160}(?:detect|enforce|violate|wall|block)|(?:detect|enforce|violate|wall|block)[^}]{0,160}ad[-_\s]?block(?:er)?|playback[-_\s]?blocked)/i;

const markGuard = value => {
    try {
        global.document?.documentElement?.setAttribute('data-talon-youtube-guard-main', value);
    } catch {
    }
};

markGuard('entered');

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const nativeJSONParse = win.JSON?.parse;
    const nativeJSONStringify = win.JSON?.stringify;
    const nativePromiseThen = win.Promise?.prototype?.then;
    const nativeFunctionToString = win.Function?.prototype?.toString ||
        Function.prototype.toString;
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
    let storageResetLiteInstalled = false;
    let storageResetLiteReads = 0;
    let storageResetLiteWrites = 0;
    let storageResetLiteDeletes = 0;
    let nativeStorageKey;
    let nativeStorageRemoveItem;
    let persistentResetLiteRuns = 0;
    let persistentResetLiteDeletes = 0;
    let persistentResetLiteCookieClears = 0;
    let wallRecoveryObserverInstalled = false;
    let wallRecoveryTriggered = false;
    let wallRecoveryReloads = 0;
    let wallRecoveryMutationObserver;
    let wallRecoveryCheckIntervalId;
    let wallRecoveryCheckStopTimerId;
    let wallRecoveryCheckPending = false;

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
            matched = ABNORMALITY_CALLBACK_TEXT_RE.test(name);
        } catch {
        }
        if ( matched === false ) {
            try {
                matched = ABNORMALITY_CALLBACK_TEXT_RE.test(
                    nativeFunctionToString.call(value) || ''
                );
            } catch {
            }
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
                    for ( const index of [ 0, 1 ] ) {
                        if ( isAbnormalityCallback(args?.[index]) === false ) { continue; }
                        abnormalityGuardHits += 1;
                        args[index] = function talonIgnoredYouTubeAbnormality() {};
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

    const shouldShieldStorageKey = key => {
        if ( typeof key !== 'string' && typeof key !== 'number' ) { return false; }
        const normalized = String(key);
        if ( normalized === '' ) { return false; }
        return RESET_LITE_STORAGE_KEY_PATTERNS.some(pattern =>
            pattern.test(normalized)
        );
    };

    const installStorageResetLiteGuard = () => {
        if ( storageResetLiteInstalled ) { return true; }
        const proto = win.Storage?.prototype;
        if ( isObject(proto) === false ||
            typeof win.Proxy !== 'function' ||
            typeof win.Reflect?.apply !== 'function' ) {
            return false;
        }
        const nativeGetItem = proto.getItem;
        const nativeSetItem = proto.setItem;
        const nativeKey = proto.key;
        const nativeRemoveItem = proto.removeItem;
        try {
            nativeStorageKey = nativeStorageKey || nativeKey;
            nativeStorageRemoveItem = nativeStorageRemoveItem || nativeRemoveItem;
            if ( typeof nativeGetItem === 'function' ) {
                proto.getItem = new win.Proxy(nativeGetItem, {
                    apply(target, thisArg, args) {
                        if ( shouldShieldStorageKey(args?.[0]) ) {
                            storageResetLiteReads += 1;
                            return null;
                        }
                        return win.Reflect.apply(target, thisArg, args);
                    },
                });
            }
            if ( typeof nativeSetItem === 'function' ) {
                proto.setItem = new win.Proxy(nativeSetItem, {
                    apply(target, thisArg, args) {
                        if ( shouldShieldStorageKey(args?.[0]) ) {
                            storageResetLiteWrites += 1;
                            return undefined;
                        }
                        return win.Reflect.apply(target, thisArg, args);
                    },
                });
            }
            if ( typeof nativeKey === 'function' ) {
                proto.key = new win.Proxy(nativeKey, {
                    apply(target, thisArg, args) {
                        const requested = Number(args?.[0]);
                        if ( Number.isInteger(requested) === false ||
                            requested < 0 ) {
                            return win.Reflect.apply(target, thisArg, args);
                        }
                        let visibleIndex = 0;
                        const length = Number(thisArg?.length) || 0;
                        for ( let i = 0; i < length; i++ ) {
                            const key = win.Reflect.apply(target, thisArg, [ i ]);
                            if ( shouldShieldStorageKey(key) ) { continue; }
                            if ( visibleIndex === requested ) { return key; }
                            visibleIndex += 1;
                        }
                        return null;
                    },
                });
            }
            storageResetLiteInstalled = true;
            return true;
        } catch {
        }
        return false;
    };

    const removeStorageKeys = (store, options = {}) => {
        const keyFn = typeof nativeStorageKey === 'function'
            ? nativeStorageKey
            : store?.key;
        const removeFn = typeof nativeStorageRemoveItem === 'function'
            ? nativeStorageRemoveItem
            : store?.removeItem;
        if ( isObject(store) === false || typeof removeFn !== 'function' ) {
            return 0;
        }
        const removeAll = options.all === true;
        const keepKeys = options.keepKeys || new Set();
        let removed = 0;
        let length = 0;
        try {
            length = Number(store.length) || 0;
        } catch {
            return 0;
        }
        for ( let i = length - 1; i >= 0; i-- ) {
            let key;
            try {
                key = typeof keyFn === 'function' ? keyFn.call(store, i) : null;
            } catch {
                continue;
            }
            if ( typeof key !== 'string' || keepKeys.has(key) ) { continue; }
            if ( removeAll === false && shouldShieldStorageKey(key) === false ) { continue; }
            try {
                removeFn.call(store, key);
                removed += 1;
            } catch {
            }
        }
        storageResetLiteDeletes += removed;
        return removed;
    };

    const cleanupSuspiciousWebStorage = () => {
        let removed = 0;
        try {
            removed += removeStorageKeys(win.localStorage);
        } catch {
        }
        try {
            removed += removeStorageKeys(win.sessionStorage);
        } catch {
        }
        return removed;
    };

    const markResetLite = value => {
        try {
            doc?.documentElement?.setAttribute('data-talon-youtube-reset-lite', value);
        } catch {
        }
    };

    const clearWebStorageForWall = () => {
        const keepKeys = new Set([ RESET_LITE_RELOAD_FLAG ]);
        let removed = 0;
        try {
            removed += removeStorageKeys(win.localStorage, { all: true });
        } catch {
        }
        try {
            removed += removeStorageKeys(win.sessionStorage, { all: true, keepKeys });
        } catch {
        }
        persistentResetLiteDeletes += removed;
        return removed;
    };

    const clearVisitorCookiesForWall = () => {
        const hostname = String(win.location?.hostname || '');
        const domainCandidates = new Set([ '', hostname ]);
        if ( /(^|\.)youtube\.com$/i.test(hostname) ) {
            domainCandidates.add('youtube.com');
            domainCandidates.add('.youtube.com');
        }
        const paths = [ '/', '/watch', '/shorts' ];
        let attempts = 0;
        for ( const name of RESET_LITE_COOKIE_NAMES ) {
            for ( const domain of domainCandidates ) {
                for ( const path of paths ) {
                    try {
                        const domainPart = domain ? `; domain=${domain}` : '';
                        doc.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domainPart}; SameSite=Lax`;
                        doc.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${path}${domainPart}; Secure; SameSite=None`;
                        attempts += 2;
                    } catch {
                    }
                }
            }
        }
        persistentResetLiteCookieClears += attempts;
        return attempts;
    };

    const deleteIndexedDatabase = name => new win.Promise(resolve => {
        if ( typeof name !== 'string' || name === '' || !win.indexedDB?.deleteDatabase ) {
            resolve(false);
            return;
        }
        let request;
        try {
            request = win.indexedDB.deleteDatabase(name);
        } catch {
            resolve(false);
            return;
        }
        const done = value => { resolve(value); };
        request.onsuccess = () => done(true);
        request.onerror = () => done(false);
        request.onblocked = () => done(false);
    });

    const clearIndexedDatabasesForWall = async () => {
        if ( typeof win.indexedDB?.databases !== 'function' ) { return 0; }
        let databases;
        try {
            databases = await win.indexedDB.databases();
        } catch {
            return 0;
        }
        if ( Array.isArray(databases) === false ) { return 0; }
        const results = await win.Promise.all(databases.map(db =>
            deleteIndexedDatabase(String(db?.name || ''))
        ));
        const removed = results.filter(Boolean).length;
        persistentResetLiteDeletes += removed;
        return removed;
    };

    const clearCachesForWall = async () => {
        if ( typeof win.caches?.keys !== 'function' ||
            typeof win.caches?.delete !== 'function' ) {
            return 0;
        }
        let keys;
        try {
            keys = await win.caches.keys();
        } catch {
            return 0;
        }
        if ( Array.isArray(keys) === false ) { return 0; }
        const results = await win.Promise.all(keys.map(key =>
            win.caches.delete(key).catch(() => false)
        ));
        const removed = results.filter(Boolean).length;
        persistentResetLiteDeletes += removed;
        return removed;
    };

    const unregisterServiceWorkersForWall = async () => {
        if ( typeof win.navigator?.serviceWorker?.getRegistrations !== 'function' ) {
            return 0;
        }
        let registrations;
        try {
            registrations = await win.navigator.serviceWorker.getRegistrations();
        } catch {
            return 0;
        }
        if ( Array.isArray(registrations) === false ) { return 0; }
        const origin = String(win.location?.origin || '');
        const sameOriginRegistrations = registrations.filter(registration =>
            typeof registration?.scope === 'string' &&
            (origin === '' || registration.scope.startsWith(origin))
        );
        const results = await win.Promise.all(sameOriginRegistrations.map(registration =>
            registration.unregister().catch(() => false)
        ));
        const removed = results.filter(Boolean).length;
        persistentResetLiteDeletes += removed;
        return removed;
    };

    const runPersistentWallResetLite = async () => {
        if ( isYouTubeHost() === false ) { return false; }
        persistentResetLiteRuns += 1;
        clearWebStorageForWall();
        clearVisitorCookiesForWall();
        await win.Promise.allSettled([
            clearIndexedDatabasesForWall(),
            clearCachesForWall(),
            unregisterServiceWorkersForWall(),
        ]);
        return true;
    };

    const wasWallRecoveryReloaded = () => {
        try {
            return win.sessionStorage?.getItem(RESET_LITE_RELOAD_FLAG) === '1';
        } catch {
        }
        try {
            return String(win.name || '').includes(RESET_LITE_WINDOW_NAME_TOKEN);
        } catch {
        }
        return false;
    };

    const markWallRecoveryReloaded = () => {
        let marked = false;
        try {
            win.sessionStorage?.setItem(RESET_LITE_RELOAD_FLAG, '1');
            marked = true;
        } catch {
        }
        try {
            const name = String(win.name || '');
            if ( name.includes(RESET_LITE_WINDOW_NAME_TOKEN) === false ) {
                win.name = `${name}${name ? ';' : ''}${RESET_LITE_WINDOW_NAME_TOKEN}`;
            }
            marked = true;
        } catch {
        }
        return marked;
    };

    const isPlaybackWallPresent = () => {
        try {
            for ( const selector of PLAYBACK_WALL_SELECTORS ) {
                const element = doc?.querySelector?.(selector);
                if ( PLAYBACK_WALL_TEXT_PATTERN_RE.test(String(element?.textContent || '')) ) {
                    return true;
                }
            }
        } catch {
        }
        try {
            const bodyText = String(doc?.body?.textContent || '');
            if ( bodyText.length > MAX_PLAYBACK_WALL_BODY_TEXT_LENGTH ) {
                return false;
            }
            return PLAYBACK_WALL_TEXT_PATTERN_RE.test(bodyText);
        } catch {
        }
        return false;
    };

    const triggerWallRecovery = () => {
        if ( wallRecoveryTriggered ) {
            markResetLite('wall-present-no-reload');
            return;
        }
        wallRecoveryTriggered = true;
        markResetLite('wall-present-no-reload');
    };

    const installWallRecoveryObserver = () => {
        if ( wallRecoveryObserverInstalled ) { return true; }
        wallRecoveryObserverInstalled = true;
        markResetLite('observer-installed');

        const check = () => {
            if ( isPlaybackWallPresent() ) {
                markResetLite('wall-present');
                triggerWallRecovery();
            }
        };

        const stopWatchWindow = () => {
            if ( wallRecoveryCheckIntervalId !== undefined ) {
                try {
                    win.clearInterval?.(wallRecoveryCheckIntervalId);
                } catch {
                }
                wallRecoveryCheckIntervalId = undefined;
            }
            if ( wallRecoveryCheckStopTimerId !== undefined ) {
                try {
                    win.clearTimeout?.(wallRecoveryCheckStopTimerId);
                } catch {
                }
                wallRecoveryCheckStopTimerId = undefined;
            }
            if ( wallRecoveryMutationObserver !== undefined ) {
                try {
                    wallRecoveryMutationObserver.disconnect();
                } catch {
                }
                wallRecoveryMutationObserver = undefined;
            }
            wallRecoveryCheckPending = false;
        };

        const scheduleCheck = delay => {
            if ( wallRecoveryTriggered || wallRecoveryCheckPending ) { return; }
            wallRecoveryCheckPending = true;
            try {
                win.setTimeout?.(() => {
                    wallRecoveryCheckPending = false;
                    check();
                }, Math.max(0, Number(delay) || 0));
            } catch {
                wallRecoveryCheckPending = false;
                check();
            }
        };

        const startWatchWindow = () => {
            if ( wallRecoveryTriggered ) { return; }
            const root = doc?.documentElement || doc?.body;
            if ( !root ) {
                check();
                return;
            }
            if ( typeof win.MutationObserver === 'function' &&
                wallRecoveryMutationObserver === undefined ) {
                try {
                    wallRecoveryMutationObserver = new win.MutationObserver(() => {
                        scheduleCheck(WALL_RECOVERY_MUTATION_DELAY_MS);
                    });
                    wallRecoveryMutationObserver.observe(root, {
                        childList: true,
                        subtree: true,
                        characterData: true,
                    });
                } catch {
                    wallRecoveryMutationObserver = undefined;
                }
            }
            if ( wallRecoveryCheckIntervalId === undefined &&
                typeof win.setInterval === 'function' ) {
                try {
                    wallRecoveryCheckIntervalId = win.setInterval(
                        check,
                        WALL_RECOVERY_CHECK_INTERVAL_MS
                    );
                } catch {
                    wallRecoveryCheckIntervalId = undefined;
                }
            }
            if ( wallRecoveryCheckStopTimerId !== undefined ) {
                try {
                    win.clearTimeout?.(wallRecoveryCheckStopTimerId);
                } catch {
                }
                wallRecoveryCheckStopTimerId = undefined;
            }
            try {
                wallRecoveryCheckStopTimerId = win.setTimeout?.(
                    stopWatchWindow,
                    WALL_RECOVERY_CHECK_WINDOW_MS
                );
            } catch {
                wallRecoveryCheckStopTimerId = undefined;
            }
            check();
        };

        if ( !doc?.documentElement && !doc?.body ) {
            markResetLite('observer-no-document');
            return true;
        }
        try {
            doc?.addEventListener?.('DOMContentLoaded', startWatchWindow, { once: true });
            win.addEventListener?.('pageshow', startWatchWindow);
            doc?.addEventListener?.('yt-navigate-finish', () => {
                startWatchWindow();
                scheduleCheck(250);
            });
            doc?.addEventListener?.('yt-navigate-start', startWatchWindow);
            win.setTimeout?.(startWatchWindow, 500);
            win.setTimeout?.(startWatchWindow, 2000);
            win.setTimeout?.(startWatchWindow, 5000);
        } catch {
        }
        startWatchWindow();
        return true;
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
        installStorageResetLiteGuard();
        cleanupSuspiciousWebStorage();
        // YouTube now treats player-response ad metadata pruning as an
        // ad-blocker signal. Keep the reset/timing guards, but leave player
        // response payloads intact so playback can proceed.
        // Keep the targeted abnormality shield, but leave DOM append and
        // Array push proxies opt-in so YouTube SPA rendering stays responsive.
        installAbnormalityGuard();
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
        getDetectorTimerGuardStats: () => ({
            installed: false,
            hits: 0,
        }),
        getStorageResetLiteStats: () => ({
            installed: storageResetLiteInstalled,
            reads: storageResetLiteReads,
            writes: storageResetLiteWrites,
            deletes: storageResetLiteDeletes,
            persistentRuns: persistentResetLiteRuns,
            persistentDeletes: persistentResetLiteDeletes,
            persistentCookieClears: persistentResetLiteCookieClears,
            wallRecoveryReloads,
        }),
        cleanupSuspiciousWebStorage,
        clearVisitorCookiesForWall,
        clearWebStorageForWall,
        install,
        installAbnormalityGuard,
        installIframeFetchBridge,
        installFetchGuard,
        installJsonParseGuard,
        installResponsePropertyGuard,
        installSsapGuard,
        installStorageResetLiteGuard,
        installWallRecoveryObserver,
        installXhrGuard,
        runPersistentWallResetLite,
        isSsapExperimentEnabled,
        isPlaybackWallPresent,
        isPlayerResponseUrl,
        pruneAds,
        recordSsapRange,
        refresh: install,
        sanitizeJsonText,
        shouldShieldStorageKey,
        textMayContainAdMetadata,
    };
};

if ( global.__talonYoutubePlayerGuardTest === true ) {
    global.__talonYoutubePlayerGuardCreateController = createController;
    return;
}

const controller = createController(global);
global.TalonYoutubePlayerGuardController = controller;
markGuard(controller.install() ? 'installed' : 'not-installed');

})(globalThis);

void 0;
