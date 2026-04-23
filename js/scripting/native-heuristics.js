/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_nativeHeuristics() {

    if ( self.TalonNativeHeuristicsController ) {
        self.TalonNativeHeuristicsController.refresh().catch(() => {});
        return;
    }

    const CONFIG_PATH = 'automation/native-heuristics.json';
    const REMOTE_CONFIG_KEY = 'communityBundleHeuristics';
    const BOOST_STORAGE_PREFIX = 'nativeHeuristicsBoost';
    const BOOST_TTL_MS = 7 * 24 * 3600 * 1000;
    const BOOST_THRESHOLD = 12;
    const BOOST_MAX = 50;

    const runtime = self.browser?.runtime || self.chrome?.runtime;
    const getURL = runtime?.getURL?.bind(runtime) || (p => p);
    const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
    const guard = self.TalonBreakageGuard;
    const shadowController = self.TalonShadowRootController;
    const blockHints = self.TalonBlockHintsController;
    const shadowRootsChangedEvent =
        shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
    const registrableDomain = hostname => {
        const resolved = guard?.registrableDomain?.(hostname);
        if ( typeof resolved === 'string' && resolved !== '' ) { return resolved; }
        if ( typeof hostname !== 'string' ) { return ''; }
        return hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    };

    const defaultConfig = {
        disableHosts: [],
        labelRegexes: [
            '\\b(sponsored|promoted|advertisement|advertising|ad\\s?supported|paid partnership|partner content|paid post|paid promotion|sponsored content)\\b',
            '\\b(paid\\s*content|partner\\s*story|partner\\s*post|sponsored\\s*links)\\b',
            '(?:реклама|спонсор|спонсируемый|партнерский материал|платное партнерство)',
            '(?:広告|スポンサー|スポンサード|プロモーション|広告記事)',
            '(?:广告|廣告|赞助|贊助|推广|推廣|赞助内容|推广内容)',
            '(?:광고|스폰서|후원|프로모션|유료\\s*광고)',
            '\\b(patrocinado|promocionado|publicidad|anuncio|contenido patrocinado)\\b',
            '\\b(sponsorisé|publicité|annonce|contenu sponsorisé)\\b',
            '\\b(gesponsert|anzeige|werbung|werbeanzeige|bezahlte partnerschaft)\\b',
            '\\b(sponsorizzato|pubblicità|annuncio|contenuto sponsorizzato)\\b',
            '\\b(patrocinado|publicidade|anúncio|conteúdo patrocinado)\\b',
            '\\b(gesponsord|advertentie|betaalde samenwerking)\\b',
            '\\b(sponsorowane|reklama|ogłoszenie|treść sponsorowana)\\b',
            '(спонсор|реклама|промо|партн[её]рск(ий|ое) материал)',
            '(广告|赞助|推广|赞助内容)',
            '(広告|スポンサー|プロモーション|提供)',
            '(광고|스폰서|프로모션)',
            '(إعلان|برعاية|ممول)',
        ],
        labelSelectors: [],
        widgetSelectors: [],
        containerStopSelectors: [
            'article',
            'li',
            'section',
            'aside',
            '.ad-slot',
            '.ad-slot-rail__container',
        ],
        maxLabelTextLength: 40,
        minContainerHeight: 60,
        minContainerWidth: 120,
        minScore: 4,
        minScoreLowConfidence: 5,
    };

    let configPromise;
    const loadConfig = () => {
        if (configPromise !== undefined) { return configPromise; }
        configPromise = fetch(getURL(CONFIG_PATH)).then(r => {
            if (r.ok === false) { throw new Error(r.statusText); }
            return r.json();
        }).catch(() => defaultConfig);
        return configPromise;
    };

    let remoteConfigPromise;
    const loadRemoteConfig = () => {
        if (remoteConfigPromise !== undefined) { return remoteConfigPromise; }
        if (storage?.get === undefined) {
            remoteConfigPromise = Promise.resolve(null);
            return remoteConfigPromise;
        }
        try {
            const maybePromise = storage.get(REMOTE_CONFIG_KEY);
            if (maybePromise?.then) {
                remoteConfigPromise = maybePromise.then(bin => bin?.[REMOTE_CONFIG_KEY] || null)
                    .catch(() => null);
                return remoteConfigPromise;
            }
        } catch {
        }
        remoteConfigPromise = new Promise(resolve => {
            try {
                storage.get(REMOTE_CONFIG_KEY, bin => resolve(bin?.[REMOTE_CONFIG_KEY] || null));
            } catch {
                resolve(null);
            }
        });
        return remoteConfigPromise;
    };

    const getLocalValue = key => {
        if (storage?.get === undefined) { return Promise.resolve(undefined); }
        try {
            const maybePromise = storage.get(key);
            if (maybePromise?.then) {
                return maybePromise.then(bin => bin?.[key]);
            }
        } catch {
        }
        return new Promise(resolve => {
            try {
                storage.get(key, bin => resolve(bin?.[key]));
            } catch {
                resolve(undefined);
            }
        });
    };

    const setLocalValue = (key, value) => {
        if (storage?.set === undefined) { return Promise.resolve(false); }
        try {
            const maybePromise = storage.set({ [key]: value });
            if (maybePromise?.then) {
                return maybePromise.then(() => true).catch(() => false);
            }
        } catch {
        }
        return new Promise(resolve => {
            try {
                storage.set({ [key]: value }, () => resolve(true));
            } catch {
                resolve(false);
            }
        });
    };

    const hostname = (self.location?.hostname || '').toLowerCase();
    if (hostname === '') { return; }
    const isTopDocument = (() => {
        try {
            return self.top === self;
        } catch {
            return false;
        }
    })();
    const isYouTubeMinimalSurface = hostname === 'www.youtube.com' && isTopDocument === true;

    const pageDomain = registrableDomain(hostname);
    let hostProtection = guard?.getProtection?.() || {
        category: '',
        allowedRiskTier: 3,
        matchedBy: '',
    };
    const boostDomain = pageDomain || hostname;
    const BOOST_STORAGE_KEY = boostDomain
        ? `${BOOST_STORAGE_PREFIX}.${boostDomain}`
        : null;

    // Dynamic boosts: after repeated heuristic hides, promote stronger cosmetics.
    let hideCount = 0;
    let strongHideCount = 0;
    let aggressionBoost = 0; // session-only, max 1
    let persistedBoostState = null;
    let strongHidesSincePersist = 0;
    let persistTimer;
    let genericHighSent = false;
    let completeSent = false;
    let youtubeWatchNavigationHandler;
    let youtubeWatchPointerSignalHandler;
    let youtubeWatchScrollHandler;
    let youtubeWatchMutationTimer;
    let youtubeWatchBroadcastChannel;
    const YOUTUBE_WATCH_CURRENT_ENVELOPE_KEY = '__td_yw_track_a_envelope_v1';
    const YOUTUBE_WATCH_LATEST_ENVELOPE_KEY = '__td_yw_track_a_envelope_latest_v1';
    const YOUTUBE_WATCH_DIAGNOSTIC_KEY = '__td_yw_diagnostic';
    const YOUTUBE_WATCH_LAST_KEY = '__td_yw_last_watch';
    const YOUTUBE_WATCH_ORIGIN = 'https://www.youtube.com';
    const YOUTUBE_WATCH_BROADCAST_NAME = 'talon-youtube-watch-envelope-v1';
    const YOUTUBE_WATCH_FETCH_REQUEST_MESSAGE = 'talon-youtube-watch-fetch-request';
    const YOUTUBE_WATCH_FETCH_RESPONSE_MESSAGE = 'talon-youtube-watch-fetch-response';
    const YOUTUBE_WATCH_EXACT_STRATEGY = 'track-a-exact-anchor-intent-lease';
    const YOUTUBE_WATCH_BASELINE_STRATEGY = 'baseline';
    const YOUTUBE_WATCH_ARCH_COOKIE = 'td_yw_arch';
    const YOUTUBE_WATCH_PREWARM_COOKIE = 'td_yw_prewarm';
    const YOUTUBE_WATCH_LEASE_TTL_MS = 2500;
    const YOUTUBE_WATCH_CLICK_HOLD_MS = 120;
    const YOUTUBE_WATCH_BASELINE_SW_BYPASS_TIMEOUT_MS = 250;
    const youtubeWatchLeases = new Map();
    const youtubeWatchBridgeRequests = new Map();
    let youtubeWatchBridgeResponseHandler;
    let youtubeWatchBridgeSequence = 0;

    const readCookieValue = name => {
        if (typeof name !== 'string' || name === '') { return ''; }
        const cookieSource = typeof self.document?.cookie === 'string'
            ? self.document.cookie
            : '';
        if (cookieSource === '') { return ''; }
        const encodedName = `${encodeURIComponent(name)}=`;
        for (const part of cookieSource.split(';')) {
            const trimmed = part.trim();
            if (trimmed.startsWith(encodedName) === false) { continue; }
            try {
                return decodeURIComponent(trimmed.slice(encodedName.length));
            } catch {
                return trimmed.slice(encodedName.length);
            }
        }
        return '';
    };

    const copySortedSearchEntries = searchParams =>
        Array.from(searchParams.entries())
            .map(entry => [ String(entry[0]), String(entry[1]) ])
            .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    const resolveYouTubeWatchUrl = value => {
        if (typeof value !== 'string' || value === '') { return null; }
        let url;
        try {
            url = new URL(value, self.location.href);
        } catch {
            return null;
        }
        if (url.origin !== 'https://www.youtube.com') { return null; }
        if (url.pathname !== '/watch') { return null; }
        if ((url.searchParams.get('v') || '').trim() === '') { return null; }
        const normalized = new URL('https://www.youtube.com/watch');
        for (const [ key, entryValue ] of copySortedSearchEntries(url.searchParams)) {
            normalized.searchParams.append(key, entryValue);
        }
        normalized.hash = '';
        return normalized;
    };

    const buildYouTubeWatchRelayUrl = targetUrl => {
        if (!(targetUrl instanceof URL)) { return ''; }
        const runtimeApi =
            self.chrome?.runtime && typeof self.chrome.runtime.getURL === 'function'
                ? self.chrome.runtime
                : self.browser?.runtime && typeof self.browser.runtime.getURL === 'function'
                    ? self.browser.runtime
                    : null;
        if (!runtimeApi) { return ''; }
        try {
            const relayUrl = new URL(
                runtimeApi.getURL('web_accessible_resources/youtube-watch-relay.html')
            );
            relayUrl.searchParams.set('target', targetUrl.toString());
            return relayUrl.toString();
        } catch {
            return '';
        }
    };

    const extractYouTubeWatchVideoId = url => {
        if (!(url instanceof URL)) { return ''; }
        return (url.searchParams.get('v') || '').trim();
    };

    const findClosestAnchorFromEvent = event => {
        const target = event?.target;
        if (target instanceof Element) {
            const anchor = target.closest('a[href]');
            if (anchor instanceof HTMLAnchorElement) { return anchor; }
        }
        if (typeof event?.composedPath !== 'function') { return null; }
        for (const entry of event.composedPath()) {
            if (entry instanceof HTMLAnchorElement) { return entry; }
            if (entry instanceof Element) {
                const anchor = entry.closest?.('a[href]');
                if (anchor instanceof HTMLAnchorElement) { return anchor; }
            }
        }
        return null;
    };

    const readJsonSessionValue = key => {
        try {
            const raw = self.sessionStorage?.getItem(key) || '';
            if (raw === '') { return null; }
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };

    const writeJsonSessionValue = (key, value) => {
        try {
            self.sessionStorage?.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    };

    const writeYouTubeWatchDiagnostic = patch => {
        const current = readJsonSessionValue(YOUTUBE_WATCH_DIAGNOSTIC_KEY) || {};
        writeJsonSessionValue(YOUTUBE_WATCH_DIAGNOSTIC_KEY, Object.assign(current, patch));
    };

    const getYouTubeNavigationArchitecture = () => {
        const raw = readCookieValue(YOUTUBE_WATCH_ARCH_COOKIE);
        return raw === YOUTUBE_WATCH_BASELINE_STRATEGY
            ? YOUTUBE_WATCH_BASELINE_STRATEGY
            : YOUTUBE_WATCH_EXACT_STRATEGY;
    };

    const getYouTubePrewarmMode = () => {
        const raw = readCookieValue(YOUTUBE_WATCH_PREWARM_COOKIE).trim().toLowerCase();
        return raw === 'off' ? 'off' : 'visible-candidates+pointerdown';
    };

    const isPlainObject = value =>
        value instanceof Object &&
        Object.getPrototypeOf(value) === Object.prototype;

    const sanitizeYouTubeBootstrapValue = (value, depth = 0) => {
        if (depth > 24) { return undefined; }
        if (value === null) { return null; }
        if (Array.isArray(value)) {
            const out = [];
            for (const entry of value) {
                const sanitized = sanitizeYouTubeBootstrapValue(entry, depth + 1);
                if (sanitized === undefined) { continue; }
                out.push(sanitized);
            }
            return out;
        }
        if (isPlainObject(value)) {
            const out = {};
            for (const [ key, entryValue ] of Object.entries(value)) {
                if (
                    key === 'adPlacements' ||
                    key === 'adSlots' ||
                    key === 'playerAds' ||
                    key === 'adBreakHeartbeatParams' ||
                    key === 'ad3Module' ||
                    key === 'adSafetyReason'
                ) {
                    continue;
                }
                if (/^(?:ad_|ad[A-Z]|ads[A-Z]|playerAds$)/.test(key)) { continue; }
                const sanitized = sanitizeYouTubeBootstrapValue(entryValue, depth + 1);
                if (sanitized === undefined) { continue; }
                out[key] = sanitized;
            }
            return out;
        }
        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            return value;
        }
        return undefined;
    };

    const findBalancedObjectText = (text, startIndex) => {
        if (typeof text !== 'string' || text === '') { return ''; }
        if (Number.isInteger(startIndex) === false || startIndex < 0) { return ''; }
        let depth = 0;
        let quote = '';
        let escape = false;
        for (let index = startIndex; index < text.length; index += 1) {
            const ch = text[index];
            if (quote !== '') {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\') {
                    escape = true;
                    continue;
                }
                if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === '\'') {
                quote = ch;
                continue;
            }
            if (ch === '{') {
                depth += 1;
                continue;
            }
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(startIndex, index + 1);
                }
            }
        }
        return '';
    };

    const extractObjectAfterMarkers = (text, markers) => {
        if (typeof text !== 'string' || text === '') { return undefined; }
        for (const marker of markers) {
            let offset = text.indexOf(marker);
            while (offset !== -1) {
                const braceStart = text.indexOf('{', offset + marker.length);
                if (braceStart !== -1) {
                    const objectText = findBalancedObjectText(text, braceStart);
                    if (objectText !== '') {
                        try {
                            return JSON.parse(objectText);
                        } catch {
                        }
                    }
                }
                offset = text.indexOf(marker, offset + marker.length);
            }
        }
        return undefined;
    };

    const buildYouTubeWatchEnvelope = (targetUrl, text, sourceKind) => {
        const rawPlayerResponse = extractObjectAfterMarkers(text, [
            'var ytInitialPlayerResponse = ',
            'ytInitialPlayerResponse = ',
            'window["ytInitialPlayerResponse"] = ',
        ]);
        const rawInitialData = extractObjectAfterMarkers(text, [
            'var ytInitialData = ',
            'ytInitialData = ',
            'window["ytInitialData"] = ',
        ]);
        const rawYtcfg = extractObjectAfterMarkers(text, [
            'ytcfg.set(',
            'ytcfg\\.set(',
        ]);
        if (isPlainObject(rawPlayerResponse) === false || isPlainObject(rawYtcfg) === false) {
            return null;
        }
        const ytInitialPlayerResponse = sanitizeYouTubeBootstrapValue(rawPlayerResponse);
        const ytInitialData = sanitizeYouTubeBootstrapValue(rawInitialData);
        const videoPlaybackUstreamerConfig = sanitizeYouTubeBootstrapValue(
            rawYtcfg.videoPlaybackUstreamerConfig ||
            extractObjectAfterMarkers(text, [ 'videoPlaybackUstreamerConfig":', 'videoPlaybackUstreamerConfig = ' ])
        );
        const ytcfg = sanitizeYouTubeBootstrapValue(rawYtcfg);
        if (isPlainObject(ytcfg.PLAYER_VARS) === false) {
            ytcfg.PLAYER_VARS = {};
        }
        ytcfg.PLAYER_VARS.raw_player_response = JSON.stringify(ytInitialPlayerResponse);
        if (videoPlaybackUstreamerConfig !== undefined) {
            ytcfg.videoPlaybackUstreamerConfig = videoPlaybackUstreamerConfig;
        }
        const now = Date.now();
        return {
            version: 1,
            leaseId: `ytw-${now}-${Math.random().toString(36).slice(2, 10)}`,
            targetUrl: targetUrl.toString(),
            videoId: extractYouTubeWatchVideoId(targetUrl),
            createdAtEpochMs: now,
            expiresAtEpochMs: now + YOUTUBE_WATCH_LEASE_TTL_MS,
            ytcfg,
            ytInitialPlayerResponse,
            ytInitialData,
            videoPlaybackUstreamerConfig,
            playerBundleId: typeof rawYtcfg.PLAYER_JS_URL === 'string' ? rawYtcfg.PLAYER_JS_URL : '',
            canaryState: {
                loggedIn: rawYtcfg.LOGGED_IN === true,
            },
            sourceKind,
            sanitizerVersion: 'exact-anchor-intent-lease-v1',
        };
    };

    const ensureYouTubeBroadcastChannel = () => {
        if (youtubeWatchBroadcastChannel !== undefined) { return youtubeWatchBroadcastChannel; }
        try {
            youtubeWatchBroadcastChannel = new BroadcastChannel(YOUTUBE_WATCH_BROADCAST_NAME);
        } catch {
            youtubeWatchBroadcastChannel = null;
        }
        return youtubeWatchBroadcastChannel;
    };

    const ensureYouTubeFetchBridgeReceiver = () => {
        if (youtubeWatchBridgeResponseHandler !== undefined) { return; }
        youtubeWatchBridgeResponseHandler = event => {
            if (event?.source !== self) { return; }
            if (
                typeof event.origin === 'string' &&
                event.origin !== '' &&
                event.origin !== YOUTUBE_WATCH_ORIGIN
            ) {
                return;
            }
            if (event?.data?.type !== YOUTUBE_WATCH_FETCH_RESPONSE_MESSAGE) { return; }
            const requestId = typeof event?.data?.id === 'string'
                ? event.data.id
                : '';
            if (requestId === '') { return; }
            const pending = youtubeWatchBridgeRequests.get(requestId);
            if (pending === undefined) { return; }
            youtubeWatchBridgeRequests.delete(requestId);
            clearTimeout(pending.timeoutId);
            pending.resolve({
                ok: event.data?.ok === true,
                status: Number(event.data?.status) || 0,
                text: typeof event.data?.text === 'string' ? event.data.text : '',
                error: typeof event.data?.error === 'string' ? event.data.error : '',
                resolvedAtEpochMs: Number(event.data?.resolvedAtEpochMs) || Date.now(),
            });
        };
        self.addEventListener?.(
            'message',
            youtubeWatchBridgeResponseHandler,
            true
        );
    };

    const requestYouTubeWatchHtmlViaBridge = targetUrl => {
        ensureYouTubeFetchBridgeReceiver();
        const requestId = `ytw-fetch-${Date.now()}-${++youtubeWatchBridgeSequence}`;
        return new Promise(resolve => {
            const timeoutId = self.setTimeout(() => {
                youtubeWatchBridgeRequests.delete(requestId);
                resolve({
                    ok: false,
                    status: 0,
                    text: '',
                    error: 'bridge-timeout',
                    resolvedAtEpochMs: Date.now(),
                });
            }, 4000);
            youtubeWatchBridgeRequests.set(requestId, {
                resolve,
                timeoutId,
            });
            self.postMessage({
                type: YOUTUBE_WATCH_FETCH_REQUEST_MESSAGE,
                id: requestId,
                url: targetUrl.toString(),
            }, YOUTUBE_WATCH_ORIGIN);
        });
    };

    const writeEnvelopeToYouTubeStorage = (envelope, diagnosticPatch = {}) => {
        let raw;
        try {
            raw = JSON.stringify(envelope);
        } catch {
            return false;
        }
        let currentOk = false;
        let latestOk = false;
        try {
            self.sessionStorage?.setItem(YOUTUBE_WATCH_CURRENT_ENVELOPE_KEY, raw);
            currentOk = true;
        } catch {
        }
        try {
            self.sessionStorage?.setItem(YOUTUBE_WATCH_LATEST_ENVELOPE_KEY, raw);
            latestOk = true;
        } catch {
        }
        try {
            self.sessionStorage?.setItem(YOUTUBE_WATCH_LAST_KEY, envelope.targetUrl);
        } catch {
        }
        const readback = (() => {
            try {
                return self.sessionStorage?.getItem(YOUTUBE_WATCH_CURRENT_ENVELOPE_KEY) || '';
            } catch {
                return '';
            }
        })();
        writeYouTubeWatchDiagnostic(Object.assign({
            trackAStoredAtEpochMs: Date.now(),
            trackAStoredBytes: raw.length,
            trackAStoredWriteOk: currentOk === true && latestOk === true,
            trackAStoredReadbackOk: readback === raw,
            trackAStoredTargetMatch: readback.includes(`"targetUrl":"${envelope.targetUrl.replace(/"/g, '\\"')}"`),
            envelopeSummary: {
                targetUrl: envelope.targetUrl,
                videoId: envelope.videoId,
                sourceKind: envelope.sourceKind,
                playerBundleId: envelope.playerBundleId,
            },
        }, diagnosticPatch));
        const channel = ensureYouTubeBroadcastChannel();
        try {
            channel?.postMessage({
                type: 'youtube-watch-envelope',
                raw,
                targetUrl: envelope.targetUrl,
                createdAtEpochMs: envelope.createdAtEpochMs,
            });
        } catch {
        }
        return currentOk === true;
    };

    const cleanupStaleYouTubeLeases = () => {
        const now = Date.now();
        for (const [ key, entry ] of youtubeWatchLeases) {
            const expiresAt = Number(entry?.expiresAtEpochMs || entry?.createdAtEpochMs || 0);
            if (expiresAt !== 0 && expiresAt >= now) { continue; }
            youtubeWatchLeases.delete(key);
        }
    };

    const primeYouTubeWatchLease = (targetUrl, sourceKind, extraPatch = {}) => {
        if (!(targetUrl instanceof URL)) { return null; }
        cleanupStaleYouTubeLeases();
        const key = targetUrl.toString();
        const existing = youtubeWatchLeases.get(key);
        if (existing && existing.expiresAtEpochMs > Date.now()) { return existing; }
        const createdAtEpochMs = Date.now();
        const entry = {
            targetUrl: key,
            createdAtEpochMs,
            expiresAtEpochMs: createdAtEpochMs + YOUTUBE_WATCH_LEASE_TTL_MS,
            readyAtEpochMs: 0,
            envelope: null,
            error: '',
            promise: null,
        };
        youtubeWatchLeases.set(key, entry);
        writeYouTubeWatchDiagnostic(Object.assign({
            donorStartedAtEpochMs: createdAtEpochMs,
            architectureEntryStrategy: YOUTUBE_WATCH_EXACT_STRATEGY,
            handoffSurface: 'sessionStorage',
            prewarmRequested: sourceKind !== 'click',
        }, extraPatch));
        entry.promise = requestYouTubeWatchHtmlViaBridge(targetUrl).then(result => {
            if (result?.ok !== true) {
                throw new Error(
                    typeof result?.error === 'string' && result.error !== ''
                        ? result.error
                        : `watch-fetch-${Number(result?.status) || 0}`
                );
            }
            const envelope = buildYouTubeWatchEnvelope(targetUrl, result.text, sourceKind);
            if (envelope === null) {
                throw new Error('watch-bootstrap-missing');
            }
            entry.envelope = envelope;
            entry.readyAtEpochMs = Number(result?.resolvedAtEpochMs) || Date.now();
            entry.expiresAtEpochMs = envelope.expiresAtEpochMs;
            writeYouTubeWatchDiagnostic({
                donorReadyAtEpochMs: entry.readyAtEpochMs,
                prewarmEntryCreatedAtEpochMs: createdAtEpochMs,
                prewarmEntryAgeMs: entry.readyAtEpochMs - createdAtEpochMs,
                prewarmPredictionHit: sourceKind !== 'click',
            });
            return envelope;
        }).catch(error => {
            entry.error = error instanceof Error ? error.message : String(error);
            youtubeWatchLeases.delete(key);
            writeYouTubeWatchDiagnostic({
                architectureFailureCategory: 'donor-fetch',
                backgroundPrefetchError: entry.error,
            });
            return null;
        });
        return entry;
    };

    const collectVisibleYouTubeWatchCandidates = () => {
        if (getYouTubePrewarmMode() === 'off') { return []; }
        const anchors = Array.from(self.document.querySelectorAll('a[href*="/watch?"]'));
        const seen = new Set();
        const visible = [];
        for (const anchor of anchors) {
            if (!(anchor instanceof HTMLAnchorElement)) { continue; }
            const watchUrl = resolveYouTubeWatchUrl(anchor.href || anchor.getAttribute('href') || '');
            if (watchUrl === null) { continue; }
            const key = watchUrl.toString();
            if (seen.has(key)) { continue; }
            const rect = anchor.getBoundingClientRect();
            if (rect.width < 32 || rect.height < 32) { continue; }
            if (rect.bottom < 0 || rect.top > self.innerHeight) { continue; }
            seen.add(key);
            visible.push({ anchor, watchUrl, rect });
        }
        visible.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        return visible.slice(0, 2);
    };

    const scheduleYouTubeVisiblePrewarm = reason => {
        if (hostname !== 'www.youtube.com' || isTopDocument === false) { return; }
        if (getYouTubeNavigationArchitecture() !== YOUTUBE_WATCH_EXACT_STRATEGY) { return; }
        if (getYouTubePrewarmMode() === 'off') { return; }
        if (youtubeWatchMutationTimer !== undefined) {
            clearTimeout(youtubeWatchMutationTimer);
        }
        youtubeWatchMutationTimer = self.setTimeout(() => {
            youtubeWatchMutationTimer = undefined;
            for (const candidate of collectVisibleYouTubeWatchCandidates()) {
                primeYouTubeWatchLease(candidate.watchUrl, 'visible-candidate', {
                    prewarmRequested: true,
                    prewarmPredictionHit: false,
                    prewarmPredictionMiss: false,
                    prewarmEntryStale: false,
                    prewarmSignalType: reason,
                });
            }
        }, 60);
    };

    const waitForLease = async entry => {
        if (entry?.envelope && entry.expiresAtEpochMs > Date.now()) {
            return entry.envelope;
        }
        if (entry?.promise instanceof Promise === false) { return null; }
        return Promise.race([
            entry.promise.catch(() => null),
            new Promise(resolve => self.setTimeout(() => resolve(null), YOUTUBE_WATCH_CLICK_HOLD_MS)),
        ]);
    };

    const attemptYouTubePageServiceWorkerBypass = async () => {
        const serviceWorker = self.navigator?.serviceWorker;
        if (typeof serviceWorker?.getRegistrations !== 'function') {
            return {
                attempted: false,
                changed: false,
                timedOut: false,
            };
        }
        const work = (async () => {
            const registrations = await serviceWorker.getRegistrations();
            let attempted = false;
            let changed = false;
            for (const registration of registrations) {
                const scope = typeof registration?.scope === 'string'
                    ? registration.scope
                    : '';
                if (scope === '' || scope.startsWith(self.location.origin) === false) { continue; }
                attempted = true;
                try {
                    changed = (await registration.unregister()) === true || changed;
                } catch {
                }
            }
            return {
                attempted,
                changed,
                timedOut: false,
            };
        })().catch(() => ({
            attempted: true,
            changed: false,
            timedOut: false,
        }));
        const timeout = new Promise(resolve => {
            self.setTimeout(() => resolve({
                attempted: true,
                changed: false,
                timedOut: true,
            }), YOUTUBE_WATCH_BASELINE_SW_BYPASS_TIMEOUT_MS);
        });
        return Promise.race([ work, timeout ]);
    };

    const installYouTubeWatchNavigationHardening = () => {
        if (hostname !== 'www.youtube.com' || isTopDocument === false) { return; }
        if (youtubeWatchNavigationHandler) { return; }

        youtubeWatchPointerSignalHandler = event => {
            if (event?.isTrusted !== true) { return; }
            const anchor = findClosestAnchorFromEvent(event);
            if (!(anchor instanceof HTMLAnchorElement)) { return; }
            const watchUrl = resolveYouTubeWatchUrl(anchor.href || anchor.getAttribute('href') || '');
            if (watchUrl === null) { return; }
            const navigationArchitecture = getYouTubeNavigationArchitecture();
            const signalType = event.type === 'pointerdown' ? 'pointerdown' : 'pointerenter';
            writeYouTubeWatchDiagnostic({
                anchorSeenAtEpochMs: Date.now(),
                preclickSignalType: signalType,
                probeEventType: signalType,
                probeAnchorHref: anchor.href || '',
                probeAnchorClassName: anchor.className || '',
                probeTargetUrl: watchUrl.toString(),
            });
            if (
                navigationArchitecture === YOUTUBE_WATCH_EXACT_STRATEGY &&
                (signalType === 'pointerdown' || getYouTubePrewarmMode() !== 'off')
            ) {
                primeYouTubeWatchLease(watchUrl, signalType, {
                    prewarmRequested: true,
                    preclickSignalType: signalType,
                });
            }
        };

        youtubeWatchScrollHandler = () => {
            scheduleYouTubeVisiblePrewarm('scroll');
        };

        youtubeWatchNavigationHandler = async event => {
            if (event?.defaultPrevented) { return; }
            if (event?.isTrusted !== true) { return; }
            if (event?.button !== 0) { return; }
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) { return; }

            const anchor = findClosestAnchorFromEvent(event);
            if (!(anchor instanceof HTMLAnchorElement)) { return; }
            if (anchor.hasAttribute('download')) { return; }

            const target = typeof anchor.target === 'string'
                ? anchor.target.trim().toLowerCase()
                : '';
            if (target !== '' && target !== '_self') { return; }

            const watchUrl = resolveYouTubeWatchUrl(anchor.href || anchor.getAttribute('href') || '');
            if (watchUrl === null) { return; }

            let currentUrl;
            try {
                currentUrl = new URL(self.location.href);
            } catch {
                currentUrl = null;
            }
            if (
                currentUrl !== null &&
                currentUrl.origin === watchUrl.origin &&
                currentUrl.pathname === watchUrl.pathname &&
                currentUrl.search === watchUrl.search &&
                currentUrl.hash === watchUrl.hash
            ) {
                return;
            }

            writeYouTubeWatchDiagnostic({
                clickAtEpochMs: Date.now(),
                probeEventType: 'click',
                probeReason: 'same-tab-watch-click',
                probeAnchorHref: anchor.href || '',
                probeAnchorClassName: anchor.className || '',
                probeTargetUrl: watchUrl.toString(),
                architectureEntryStrategy: getYouTubeNavigationArchitecture(),
                handoffSurface: 'sessionStorage',
            });

            try {
                anchor.href = watchUrl.toString();
            } catch {
            }

            if (getYouTubeNavigationArchitecture() === YOUTUBE_WATCH_BASELINE_STRATEGY) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const relayUrl = buildYouTubeWatchRelayUrl(watchUrl);
                if (relayUrl !== '') {
                    const serviceWorkerBypass = await attemptYouTubePageServiceWorkerBypass();
                    writeYouTubeWatchDiagnostic({
                        preNavigationServiceWorkerBypassAttempted:
                            serviceWorkerBypass?.attempted === true,
                        preNavigationServiceWorkerBypassChanged:
                            serviceWorkerBypass?.changed === true,
                        preNavigationServiceWorkerBypassTimedOut:
                            serviceWorkerBypass?.timedOut === true,
                        preNavigationRelayUsed: true,
                    });
                    try {
                        self.location.assign(relayUrl);
                    } catch {
                    }
                    return;
                }
                writeYouTubeWatchDiagnostic({
                    preNavigationRelayUsed: false,
                });
                try {
                    self.location.assign(watchUrl.toString());
                } catch {
                }
                return;
            }

            const entry = primeYouTubeWatchLease(watchUrl, 'click', {
                preclickSignalType: 'click',
            });
            const readyEnvelope = entry?.envelope && entry.expiresAtEpochMs > Date.now()
                ? entry.envelope
                : null;
            if (readyEnvelope !== null) {
                writeEnvelopeToYouTubeStorage(readyEnvelope, {
                    leaseHit: true,
                    leaseMiss: false,
                    donorReadyBeforeClick: true,
                    navigationHoldDurationMs: 0,
                });
                event.preventDefault();
                event.stopImmediatePropagation();
                try {
                    self.location.assign(watchUrl.toString());
                } catch {
                }
                return;
            }

            event.preventDefault();
            event.stopImmediatePropagation();
            const waitStartedAt = Date.now();
            const lateEnvelope = await waitForLease(entry);
            writeYouTubeWatchDiagnostic({
                leaseHit: lateEnvelope !== null,
                leaseMiss: lateEnvelope === null,
                donorReadyBeforeClick: false,
                navigationHoldDurationMs: Date.now() - waitStartedAt,
                timeoutOccurred: lateEnvelope === null,
            });
            if (lateEnvelope !== null) {
                writeEnvelopeToYouTubeStorage(lateEnvelope, {
                    leaseHit: true,
                    leaseMiss: false,
                    donorReadyBeforeClick: false,
                    navigationHoldDurationMs: Date.now() - waitStartedAt,
                });
            }
            self.setTimeout(() => {
                try {
                    self.location.assign(watchUrl.toString());
                } catch {
                }
            }, 0);
        };

        self.addEventListener('pointerenter', youtubeWatchPointerSignalHandler, {
            capture: true,
            passive: true,
        });
        self.addEventListener('pointerdown', youtubeWatchPointerSignalHandler, {
            capture: true,
            passive: true,
        });
        self.addEventListener('click', youtubeWatchNavigationHandler, {
            capture: true,
            passive: false,
        });
        self.addEventListener('scroll', youtubeWatchScrollHandler, {
            capture: true,
            passive: true,
        });
        self.addEventListener('yt-navigate-finish', youtubeWatchScrollHandler, {
            capture: true,
            passive: true,
        });
        scheduleYouTubeVisiblePrewarm('init');
    };

    const removeYouTubeWatchNavigationHardening = () => {
        if (youtubeWatchPointerSignalHandler !== undefined) {
            self.removeEventListener('pointerenter', youtubeWatchPointerSignalHandler, true);
            self.removeEventListener('pointerdown', youtubeWatchPointerSignalHandler, true);
            youtubeWatchPointerSignalHandler = undefined;
        }
        if (youtubeWatchNavigationHandler !== undefined) {
            self.removeEventListener('click', youtubeWatchNavigationHandler, true);
            youtubeWatchNavigationHandler = undefined;
        }
        if (youtubeWatchScrollHandler !== undefined) {
            self.removeEventListener('scroll', youtubeWatchScrollHandler, true);
            self.removeEventListener('yt-navigate-finish', youtubeWatchScrollHandler, true);
            youtubeWatchScrollHandler = undefined;
        }
        if (youtubeWatchMutationTimer !== undefined) {
            clearTimeout(youtubeWatchMutationTimer);
            youtubeWatchMutationTimer = undefined;
        }
        youtubeWatchLeases.clear();
        if (youtubeWatchBridgeResponseHandler !== undefined) {
            self.removeEventListener?.(
                'message',
                youtubeWatchBridgeResponseHandler,
                true
            );
            youtubeWatchBridgeResponseHandler = undefined;
        }
        for (const pending of youtubeWatchBridgeRequests.values()) {
            clearTimeout(pending.timeoutId);
            pending.resolve({
                ok: false,
                status: 0,
                text: '',
                error: 'bridge-stopped',
                resolvedAtEpochMs: Date.now(),
            });
        }
        youtubeWatchBridgeRequests.clear();
        try {
            youtubeWatchBroadcastChannel?.close?.();
        } catch {
        }
        youtubeWatchBroadcastChannel = undefined;
    };

    const schedulePersistStrongHide = () => {
        if (BOOST_STORAGE_KEY === null) { return; }
        if (storage?.set === undefined) { return; }
        strongHidesSincePersist += 1;
        if (persistTimer !== undefined) { return; }
        persistTimer = self.setTimeout(async () => {
            persistTimer = undefined;
            if (strongHidesSincePersist === 0) { return; }
            const now = Date.now();
            let state = persistedBoostState;
            if (state === null) {
                const stored = await getLocalValue(BOOST_STORAGE_KEY);
                state = stored instanceof Object ? stored : { count: 0, lastTs: 0 };
            }
            let count = Number(state.count) || 0;
            let lastTs = Number(state.lastTs) || 0;
            if (lastTs === 0 || (now - lastTs) > BOOST_TTL_MS) {
                count = 0;
            }
            count = Math.min(BOOST_MAX, count + strongHidesSincePersist);
            strongHidesSincePersist = 0;
            persistedBoostState = { count, lastTs: now };
            await setLocalValue(BOOST_STORAGE_KEY, persistedBoostState);
        }, 2500);
    };

    const recordHeuristicHide = (isStrong = false) => {
        hideCount += 1;

        if (isStrong) {
            strongHideCount += 1;
            if (guard?.isProtectedSurface?.() !== true &&
                aggressionBoost === 0 &&
                strongHideCount >= 4) {
                aggressionBoost = 1;
            }
            schedulePersistStrongHide();
        }
        if (guard?.isProtectedSurface?.() !== true &&
            genericHighSent === false &&
            hideCount >= 3) {
            genericHighSent = true;
            try {
                runtime?.sendMessage?.({
                    what: 'promoteGenericHigh',
                    hostname: pageDomain || hostname,
                }).catch(() => { });
            } catch {
            }
        }
        if (guard?.isProtectedSurface?.() !== true &&
            completeSent === false &&
            hideCount >= 6) {
            completeSent = true;
            try {
                runtime?.sendMessage?.({
                    what: 'promoteComplete',
                    hostname: pageDomain || hostname,
                }).catch(() => { });
            } catch {
            }
        }
    };

    const normalizeHostnameCandidate = value => {
        if ( typeof value !== 'string' ) { return ''; }
        return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    };

    const normalizeScopedHostPattern = value => {
        if ( typeof value !== 'string' ) { return ''; }
        const trimmed = value.trim().toLowerCase();
        if ( trimmed === '' ) { return ''; }
        if ( trimmed.includes('://') || trimmed.includes('/') ) { return ''; }
        if ( trimmed === '*' || trimmed === 'all-urls' ) { return trimmed; }

        const normalizeBareHostname = candidate => {
            const normalized = normalizeHostnameCandidate(candidate);
            if ( normalized === '' ) { return ''; }
            if ( normalized.includes('*') || normalized === 'all-urls' ) { return ''; }
            return normalized;
        };

        if ( trimmed.startsWith('=') ) {
            const bare = normalizeBareHostname(trimmed.slice(1));
            return bare === '' ? '' : `=${bare}`;
        }
        if ( trimmed.startsWith('*.') ) {
            const bare = normalizeBareHostname(trimmed.slice(2));
            return bare === '' ? '' : `*.${bare}`;
        }
        if ( trimmed.endsWith('.*') ) {
            const bare = normalizeBareHostname(trimmed.slice(0, -2));
            return bare === '' ? '' : `${bare}.*`;
        }
        return normalizeBareHostname(trimmed);
    };

    const patternMatchesHostname = (pattern, hn) => {
        const delegated = guard?.hostPatternMatches;
        if ( typeof delegated === 'function' ) {
            return delegated(pattern, hn) === true;
        }
        const p = normalizeScopedHostPattern(pattern);
        const normalizedHostname = normalizeHostnameCandidate(hn);
        if ( p === '' || normalizedHostname === '' ) { return false; }
        if (p === '*' || p === 'all-urls') { return true; }
        if (p.startsWith('=')) {
            return normalizedHostname === p.slice(1);
        }
        if (p.startsWith('*.')) {
            const bare = p.slice(2);
            return normalizedHostname === bare || normalizedHostname.endsWith(`.${bare}`);
        }
        if (p.endsWith('.*')) {
            const bare = p.slice(0, -2);
            return normalizedHostname === bare || normalizedHostname.startsWith(`${bare}.`);
        }
        return normalizedHostname === p || normalizedHostname.endsWith(`.${p}`);
    };

    const isVisible = el => {
        if (el instanceof Element === false) { return false; }
        const style = self.getComputedStyle(el);
        if (style.display === 'none') { return false; }
        if (style.visibility === 'hidden') { return false; }
        if (Number(style.opacity) === 0) { return false; }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const TEXT_LABEL_SELECTOR = 'span,small,a,div,p,strong,em,label';

    let pendingLabels = [];
    let pendingIndex = 0;
    let seenLabels = new WeakSet();
    let hiddenContainers = new WeakSet();
    let iframeCandidates = new WeakSet();

    let labelRegexes = [];
    let labelSelectors = [];
    let widgetSelectors = [];
    let stopSelectorText = '';
    let attrHintRe = /\b(sponsor|sponsored|promoted|advert|advertisement|adchoices|outbrain|taboola|ad-slot|adslot|adsbygoogle|adunit|adserver|doubleclick|googlesyndication|prebid|criteo|native-ad|banner-ad|paid\s*post|paid\s*partner|partner\s*content|promo|dfp|gpt|admanager|adsense|revcontent|mgid|teads|adthrive|mediavine|adzerk|rubicon|openx|pubmatic|appnexus|adnxs|spotx|yieldlove|ezoic)\b/i;
    const STRONG_LABEL_RE = /\b(sponsored|advertisement|advertorial|ad\s?supported|paid partnership|partner content|paid promotion|paid post|paid content|promoted)\b/i;

    const COMMON_AD_SIZES = [
        [300, 250],
        [300, 600],
        [160, 600],
        [120, 600],
        [728, 90],
        [970, 250],
        [970, 90],
        [320, 50],
        [320, 100],
        [336, 280],
        [468, 60],
        [234, 60],
        [250, 250],
        [200, 200],
        [300, 50],
        [300, 100],
        [320, 480],
        [480, 320],
    ];
    const AD_SIZE_TOLERANCE_PX = 10;

    const isStandardAdSize = rect => {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        for (const [aw, ah] of COMMON_AD_SIZES) {
            if (
                Math.abs(w - aw) <= AD_SIZE_TOLERANCE_PX &&
                Math.abs(h - ah) <= AD_SIZE_TOLERANCE_PX
            ) {
                return true;
            }
        }
        return false;
    };

    const isThirdPartyFrame = frame => {
        const src = frame.getAttribute('src');
        if (typeof src !== 'string' || src === '') { return false; }
        let u;
        try {
            u = new URL(src, self.location.href);
        } catch {
            return false;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
        const domain = registrableDomain(u.hostname.toLowerCase());
        return domain !== '' && domain !== pageDomain;
    };

    const isAdIframeCandidate = frame => {
        if (frame instanceof HTMLIFrameElement === false) { return false; }
        if (isVisible(frame) === false) { return false; }
        const rect = frame.getBoundingClientRect();
        const standardSized = isStandardAdSize(rect);
        if (standardSized === false) {
            if (rect.width < 200 || rect.height < 100) { return false; }
        }

        const hintParts = [
            frame.id,
            frame.className,
            frame.getAttribute('title') || '',
            frame.getAttribute('aria-label') || '',
            frame.getAttribute('data-ad') || '',
            frame.getAttribute('data-ad-unit') || '',
            frame.getAttribute('data-ad-slot') || '',
            frame.getAttribute('src') || '',
            frame.name || '',
        ].join(' ');

        if (standardSized) {
            return attrHintRe.test(hintParts) || isThirdPartyFrame(frame);
        }
        // Non-standard sizes require stronger hints to avoid false positives.
        return attrHintRe.test(hintParts) && isThirdPartyFrame(frame);
    };

    let minContainerHeight = defaultConfig.minContainerHeight;
    let minContainerWidth = defaultConfig.minContainerWidth;
    let minScore = defaultConfig.minScore;
    let minScoreLowConfidence = defaultConfig.minScoreLowConfidence;

    const enqueueLabel = el => {
        if (el instanceof Element === false) { return; }
        if (seenLabels.has(el)) { return; }
        seenLabels.add(el);
        pendingLabels.push(el);
    };

    const collectCandidates = root => {
        if (
            root !== document &&
            root instanceof Element === false &&
            root instanceof DocumentFragment === false
        ) {
            return;
        }
        const selectorList = [...labelSelectors, ...widgetSelectors]
            .filter(s => typeof s === 'string' && s !== '');
        if (selectorList.length !== 0) {
            let nodes;
            try {
                nodes = (root === document ? document : root).querySelectorAll(
                    selectorList.join(',')
                );
            } catch {
                nodes = [];
            }
            for (const node of nodes) {
                if (isVisible(node) === false) { continue; }
                enqueueLabel(node);
            }
        }

        // Text label scan – capped for safety.
        // Standard ad-size iframes (unlabeled) scan.
        let frames;
        try {
            frames = (root === document ? document : root).querySelectorAll('iframe');
        } catch {
            frames = [];
        }
        let scannedFrames = 0;
        const maxFrames = root === document ? 80 : 20;
        for (const frame of frames) {
            if (scannedFrames++ >= maxFrames) { break; }
            if (isAdIframeCandidate(frame) === false) { continue; }
            iframeCandidates.add(frame);
            enqueueLabel(frame);
        }

        let textNodes;
        try {
            textNodes = (root === document ? document.body : root).querySelectorAll(TEXT_LABEL_SELECTOR);
        } catch {
            return;
        }
        let scanned = 0;
        const maxScan = root === document ? 800 : 200;
        for (const node of textNodes) {
            if (scanned++ >= maxScan) { break; }
            if (isVisible(node) === false) { continue; }
            const text = node.textContent?.trim() || '';
            if (text === '') { continue; }
            if (text.length > (config.maxLabelTextLength || 40)) { continue; }
            if (labelRegexes.some(re => re.test(text)) === false) { continue; }
            enqueueLabel(node);
        }
    };

    const hasOutboundLink = container => {
        const links = container.querySelectorAll('a[href]');
        for (const a of links) {
            const href = a.getAttribute('href');
            if (typeof href !== 'string') { continue; }
            let u;
            try {
                u = new URL(href, self.location.href);
            } catch {
                continue;
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') { continue; }
            const domain = registrableDomain(u.hostname.toLowerCase());
            if (domain !== '' && domain !== pageDomain) {
                return true;
            }
        }
        return false;
    };

    const hasAdChoicesHint = container => {
        return container.querySelector(
            'a[href*="adchoices" i], [alt*="adchoices" i], [aria-label*="adchoices" i]'
        ) !== null;
    };

    const hasAttrHint = (container, labelEl) => {
        const parts = [
            container.id,
            container.className,
            container.getAttribute('aria-label') || '',
            container.getAttribute('role') || '',
            container.getAttribute('data-ad') || '',
            container.getAttribute('data-ad-unit') || '',
            container.getAttribute('data-ad-slot') || '',
            container.getAttribute('data-ad-client') || '',
            container.getAttribute('data-advertisement') || '',
            container.getAttribute('data-sponsored') || '',
            labelEl.id,
            labelEl.className,
            labelEl.getAttribute('aria-label') || '',
        ].join(' ');
        return attrHintRe.test(parts);
    };

    const isWidgetCandidate = el => {
        if (iframeCandidates.has(el)) { return true; }
        for (const sel of widgetSelectors) {
            try {
                if (el.matches(sel)) { return true; }
                if (el.closest(sel)) { return true; }
            } catch {
                continue;
            }
        }
        return false;
    };

    const isSelectorCandidate = el => {
        for (const sel of labelSelectors) {
            try {
                if (el.matches(sel)) { return true; }
                if (el.closest(sel)) { return true; }
            } catch {
                continue;
            }
        }
        return false;
    };

    const isTextLabelCandidate = el => {
        const text = el.textContent?.trim() || '';
        if (text === '') { return false; }
        return labelRegexes.some(re => re.test(text));
    };

    const canUseSelfAsContainer = el => {
        if (el instanceof Element === false) { return false; }
        if (el === document.body || el === document.documentElement) { return false; }
        if (el.closest('nav,header,footer')) { return false; }

        const rect = el.getBoundingClientRect();
        if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
            return false;
        }

        if (iframeCandidates.has(el)) { return true; }
        if (isWidgetCandidate(el) || isSelectorCandidate(el)) { return true; }

        const parts = [
            el.id,
            el.className,
            el.getAttribute('aria-label') || '',
            el.getAttribute('role') || '',
            el.getAttribute('data-ad') || '',
            el.getAttribute('data-ad-unit') || '',
            el.getAttribute('data-ad-slot') || '',
            el.getAttribute('data-ad-client') || '',
            el.getAttribute('data-advertisement') || '',
            el.getAttribute('data-sponsored') || '',
        ].join(' ');
        if (attrHintRe.test(parts)) { return true; }

        // Large label-bearing containers should hide themselves rather than
        // their parent wrapper, otherwise a single ad rail can blank content.
        if (isTextLabelCandidate(el) && el.childElementCount !== 0) { return true; }

        return false;
    };

    const findContainer = el => {
        if (canUseSelfAsContainer(el)) { return el; }

        let container;
        try {
            container = stopSelectorText ? el.closest(stopSelectorText) : null;
        } catch {
            container = null;
        }
        if (container === null) {
            container = el.parentElement;
        }
        if (container === null) { return null; }
        if (container === document.body || container === document.documentElement) { return null; }
        if (container.closest('nav,header,footer')) { return null; }
        if (guard?.canMutateElement?.(container, {
            riskTier: guard?.RISK_TIERS?.high || 3,
            source: 'native-heuristics-find-container',
        })?.allowed === false) {
            return null;
        }
        return container;
    };

    const shouldHideContainer = (container, labelEl) => {
        const rect = container.getBoundingClientRect();
        if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
            return false;
        }
        if (guard?.isLikelyPrimaryContent?.(container)) {
            return { shouldHide: false, isStrong: false, score: 0, needed: 0 };
        }

        const widgetHint = isWidgetCandidate(labelEl);
        const selectorHint = isSelectorCandidate(labelEl);
        const labelHint = isTextLabelCandidate(labelEl);
        if (widgetHint === false && selectorHint === false && labelHint === false) {
            return { shouldHide: false, isStrong: false, score: 0, needed: 0 };
        }

        const attrHint = hasAttrHint(container, labelEl);
        const adChoicesHint = hasAdChoicesHint(container);
        const outboundHint = hasOutboundLink(container);
        const sizeHint = isStandardAdSize(rect);
        const recentBlockHint = blockHints?.hasRecentHint?.(container, {
            includeSubtree: true,
        }) === true || blockHints?.hasRecentHint?.(labelEl) === true;
        const recentNetworkHit = blockHints?.hasRecentNetworkHit?.() === true;

        let score = 0;
        if (widgetHint) { score += 4; }
        if (selectorHint) { score += 3; }
        let strongLabel = false;
        if (labelHint) {
            score += 3;
            const text = labelEl.textContent?.trim() || '';
            if (text !== '' && STRONG_LABEL_RE.test(text)) {
                strongLabel = true;
                score += 1;
            }
        }
        if (attrHint) { score += 1; }
        if (adChoicesHint) { score += 1; }
        if (outboundHint) { score += 1; }
        if (sizeHint) { score += 1; }
        if (recentBlockHint) { score += 1; }
        if (recentNetworkHit) { score += 1; }

        let overlayHint = 0;
        try {
            const style = self.getComputedStyle(container);
            const pos = style.position;
            if (pos === 'fixed' || pos === 'sticky') {
                overlayHint = 1;
                const z = parseInt(style.zIndex, 10);
                if (Number.isFinite(z) && z >= 1000) {
                    overlayHint = 2;
                }
            }
        } catch {
        }
        if (overlayHint) { score += overlayHint; }

        const lowConfidenceOnly = labelHint &&
            widgetHint === false &&
            selectorHint === false &&
            strongLabel === false;
        const needed = lowConfidenceOnly
            ? minScoreLowConfidence
            : Math.max(1, minScore - aggressionBoost);
        let shouldHide = score >= needed;
        if (hostProtection.allowedRiskTier < (guard?.RISK_TIERS?.high || 3)) {
            if (lowConfidenceOnly) {
                shouldHide = false;
            }
            if (rect.height >= self.innerHeight * 0.45 || rect.width >= self.innerWidth * 0.7) {
                shouldHide = false;
            }
            if (widgetHint === false && selectorHint === false && attrHint === false && sizeHint === false) {
                shouldHide = false;
            }
        }
        const isStrong = Boolean(
            widgetHint ||
            selectorHint ||
            strongLabel ||
            adChoicesHint ||
            attrHint ||
            sizeHint
        );
        return { shouldHide, isStrong, score, needed, overlayHint };
    };

    const unlockScrollIfNeeded = () => {
        let htmlOverflowHidden = false;
        let bodyOverflowHidden = false;
        let bodyFixed = false;

        const html = document.documentElement;
        const body = document.body;

        try {
            if (html && self.getComputedStyle(html).overflow === 'hidden') {
                htmlOverflowHidden = true;
            }
        } catch {
        }

        try {
            if (body) {
                const style = self.getComputedStyle(body);
                bodyOverflowHidden = style.overflow === 'hidden';
                bodyFixed = style.position === 'fixed';
            }
        } catch {
        }

        if (htmlOverflowHidden === false && bodyOverflowHidden === false && bodyFixed === false) {
            return false;
        }

        try {
            if (htmlOverflowHidden) {
                html.style.setProperty('overflow', 'auto', 'important');
            }
        } catch {
        }

        let restoreY;
        if (bodyFixed && body) {
            try {
                const topValue = self.getComputedStyle(body).top;
                const topPx = parseInt(topValue, 10);
                if (Number.isFinite(topPx)) {
                    restoreY = Math.abs(topPx);
                }
            } catch {
            }
        }

        try {
            if (body && bodyOverflowHidden) {
                body.style.setProperty('overflow', 'auto', 'important');
            }
            if (body && bodyFixed) {
                body.style.setProperty('position', 'static', 'important');
                body.style.setProperty('top', 'auto', 'important');
            }
        } catch {
        }

        if (restoreY !== undefined) {
            try { self.scrollTo(0, restoreY); } catch { }
        }

        return true;
    };

    const hideContainer = (container, isStrong = false, overlayHint) => {
        const decision = guard?.canMutateElement?.(container, {
            riskTier: guard?.RISK_TIERS?.high || 3,
            source: 'native-heuristics-hide',
        });
        if (decision?.allowed === false) {
            return;
        }
        try {
            if (container.dataset?.uBolNativeHidden) {
                if (isVisible(container)) {
                    container.style.setProperty('display', 'none', 'important');
                    container.style.setProperty('visibility', 'hidden', 'important');
                }
                return;
            }
            container.style.setProperty('display', 'none', 'important');
            container.style.setProperty('visibility', 'hidden', 'important');
            container.dataset.uBolNativeHidden = '1';
            blockHints?.noteElement?.(container, { ancestors: 1 });
            recordHeuristicHide(isStrong);

            let hint = Number.isFinite(overlayHint) ? overlayHint : 0;
            if (hint === 0) {
                try {
                    const style = self.getComputedStyle(container);
                    const pos = style.position;
                    if (pos === 'fixed' || pos === 'sticky') {
                        hint = 1;
                        const z = parseInt(style.zIndex, 10);
                        if (Number.isFinite(z) && z >= 1000) {
                            hint = 2;
                        }
                    }
                } catch {
                }
            }
            if (hint) {
                unlockScrollIfNeeded();
            }
            guard?.auditAfterMutation?.('native-heuristics-hide');
        } catch {
        }
    };

    const hideWrapperIfPresent = container => {
        if (container instanceof Element === false) { return; }
        let wrapper;
        try {
            wrapper = container.closest('.ad-slot-rail__container');
        } catch {
            wrapper = null;
        }
        if (wrapper === null || wrapper === container) { return; }
        hideContainer(wrapper, true);
        ensureStaysHidden(wrapper);
    };

    let rehideObserved = new WeakSet();
    let rehideObservers = new Set();
    const ensureStaysHidden = container => {
        if (container instanceof Element === false) { return; }
        if (rehideObserved.has(container)) { return; }
        rehideObserved.add(container);
        try {
            const obs = new MutationObserver(() => {
                if (container.isConnected === false) {
                    obs.disconnect();
                    rehideObservers.delete(obs);
                    return;
                }
                if (isVisible(container)) {
                    hideContainer(container);
                    collapseEmptyParent(container);
                }
            });
            obs.observe(container, {
                attributes: true,
                attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
            });
            rehideObservers.add(obs);
        } catch {
        }
    };

    const collapseEmptyParent = container => {
        const parent = container.parentElement;
        if (parent === null) { return; }
        if (parent === document.body || parent === document.documentElement) { return; }
        if (parent.dataset?.uBolNativeCollapsed) { return; }
        if (parent.closest('nav,header,footer')) { return; }
        if (guard?.canMutateElement?.(parent, {
            riskTier: guard?.RISK_TIERS?.medium || 2,
            source: 'native-heuristics-collapse-parent',
        })?.allowed === false) {
            return;
        }
        if (guard?.isLikelyPrimaryContent?.(parent)) { return; }

        const kids = parent.children;
        if (kids.length > 12) { return; }
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (child === container) { continue; }
            if (isVisible(child)) { return; }
        }

        const rect = parent.getBoundingClientRect();
        const adSized = isStandardAdSize(rect);
        if (adSized === false) {
            if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
                return;
            }
        }

        const hintParts = [
            parent.id,
            parent.className,
            parent.getAttribute('aria-label') || '',
            parent.getAttribute('data-ad') || '',
            parent.getAttribute('data-ad-unit') || '',
        ].join(' ');
        if (
            attrHintRe.test(hintParts) === false &&
            adSized === false &&
            blockHints?.hasRecentHint?.(parent, { includeSubtree: true }) !== true
        ) {
            return;
        }

        try {
            parent.style.setProperty('display', 'none', 'important');
            parent.style.setProperty('visibility', 'hidden', 'important');
            parent.dataset.uBolNativeCollapsed = '1';
            blockHints?.noteElement?.(parent, { ancestors: 1 });
            ensureStaysHidden(parent);
            unlockScrollIfNeeded();
            guard?.auditAfterMutation?.('native-heuristics-collapse');
        } catch {
        }
    };

    let processTimer;
    const MAX_TIME_SLICE_MS = 4;

    const processPending = () => {
        processTimer = undefined;
        const deadline = self.performance.now() + MAX_TIME_SLICE_MS;
        for (; pendingIndex < pendingLabels.length; pendingIndex++) {
            if (self.performance.now() >= deadline) { break; }
            const labelEl = pendingLabels[pendingIndex];
            if (isVisible(labelEl) === false) { continue; }
            const container = findContainer(labelEl);
            if (container === null) { continue; }
            if (hiddenContainers.has(container)) { continue; }
            const decision = shouldHideContainer(container, labelEl);
            if (decision?.shouldHide !== true) { continue; }
            hideContainer(container, decision.isStrong, decision.overlayHint);
            collapseEmptyParent(container);
            hideWrapperIfPresent(container);
            ensureStaysHidden(container);
            hiddenContainers.add(container);
        }

        if (pendingIndex >= pendingLabels.length) {
            pendingLabels.length = 0;
            pendingIndex = 0;
            return;
        }
        scheduleProcess();
    };

    const scheduleProcess = () => {
        if (processTimer !== undefined) { return; }
        processTimer = self.requestAnimationFrame(processPending);
    };

    const collectKnownShadowRootCandidates = roots => {
        const knownRoots = Array.isArray(roots)
            ? roots
            : (shadowController?.enumerateRoots?.() || []);
        for ( const root of knownRoots ) {
            collectCandidates(root);
        }
    };

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) { continue; }
                collectCandidates(n);
            }
        }
        shadowController?.scheduleRescan?.();
        scheduleYouTubeVisiblePrewarm('mutation');
        scheduleProcess();
    });

    self.addEventListener?.(shadowRootsChangedEvent, event => {
        const roots = Array.isArray(event?.detail?.roots)
            ? event.detail.roots
            : undefined;
        collectKnownShadowRootCandidates(roots);
        scheduleYouTubeVisiblePrewarm('shadow-roots');
        scheduleProcess();
    });

    let observerConnected = false;

    const resetState = () => {
        remoteConfigPromise = undefined;
        pendingLabels = [];
        pendingIndex = 0;
        seenLabels = new WeakSet();
        hiddenContainers = new WeakSet();
        iframeCandidates = new WeakSet();
        rehideObserved = new WeakSet();
        hideCount = 0;
        strongHideCount = 0;
        aggressionBoost = 0;
        persistedBoostState = null;
        strongHidesSincePersist = 0;
        genericHighSent = false;
        completeSent = false;
        hostProtection = guard?.getProtection?.() || {
            category: '',
            allowedRiskTier: 3,
            matchedBy: '',
        };
    };

    const stop = async () => {
        removeYouTubeWatchNavigationHardening();
        if (observerConnected) {
            observer.disconnect();
            observerConnected = false;
        }
        for (const obs of rehideObservers) {
            try { obs.disconnect(); } catch { }
        }
        rehideObservers.clear();
        if (processTimer !== undefined) {
            try { self.cancelAnimationFrame(processTimer); } catch { }
            processTimer = undefined;
        }
        if (persistTimer !== undefined) {
            try { clearTimeout(persistTimer); } catch { }
            persistTimer = undefined;
        }
        resetState();
    };

    const init = async () => {
        await guard?.whenReady?.();
        if (guard?.shouldRunSubsystem?.('nativeHeuristics') === false) {
            await stop();
            return { applied: false };
        }
        await stop();
        hostProtection = guard?.getProtection?.() || hostProtection;
        config = await loadConfig();
        const remoteConfig = await loadRemoteConfig();
        if (remoteConfig instanceof Object) {
            const mergeStringArray = (base, extra) => {
                const out = [];
                const seen = new Set();
                const pushAll = arr => {
                    if (Array.isArray(arr) === false) { return; }
                    for (const item of arr) {
                        if (typeof item !== 'string') { continue; }
                        const s = item.trim();
                        if (s === '' || seen.has(s)) { continue; }
                        seen.add(s);
                        out.push(s);
                    }
                };
                pushAll(base);
                pushAll(extra);
                return out;
            };

            config = Object.assign({}, config);
            config.disableHosts = mergeStringArray(config.disableHosts, remoteConfig.disableHosts);
            config.labelRegexes = mergeStringArray(config.labelRegexes, remoteConfig.labelRegexes);
            config.labelSelectors = mergeStringArray(config.labelSelectors, remoteConfig.labelSelectors);
            config.widgetSelectors = mergeStringArray(config.widgetSelectors, remoteConfig.widgetSelectors);
            config.containerStopSelectors = mergeStringArray(
                config.containerStopSelectors,
                remoteConfig.containerStopSelectors
            );

            const mergeNumber = (key, min, max) => {
                const v = Number(remoteConfig[key]);
                if (Number.isFinite(v) === false) { return; }
                config[key] = Math.min(max, Math.max(min, v));
            };
            mergeNumber('maxLabelTextLength', 10, 80);
            mergeNumber('minContainerHeight', 30, 300);
            mergeNumber('minContainerWidth', 60, 600);
            mergeNumber('minScore', 1, 10);
            mergeNumber('minScoreLowConfidence', 1, 12);
        }
        if (Array.isArray(config.disableHosts)) {
            for (const p of config.disableHosts) {
                if (patternMatchesHostname(p, hostname)) { return; }
            }
        }

        if (isYouTubeMinimalSurface) {
            installYouTubeWatchNavigationHardening();
            return {
                applied: true,
                mode: 'youtube-minimal',
            };
        }

        if (BOOST_STORAGE_KEY) {
            const storedBoost = await getLocalValue(BOOST_STORAGE_KEY);
            if (storedBoost instanceof Object) {
                const now = Date.now();
                let count = Number(storedBoost.count) || 0;
                let lastTs = Number(storedBoost.lastTs) || 0;
                if (lastTs === 0 || (now - lastTs) > BOOST_TTL_MS) {
                    count = 0;
                    lastTs = 0;
                }
                persistedBoostState = { count, lastTs };
                if (guard?.isProtectedSurface?.() !== true && count >= BOOST_THRESHOLD) {
                    aggressionBoost = 1;
                }
            } else {
                persistedBoostState = { count: 0, lastTs: 0 };
            }
        }

        labelRegexes = (Array.isArray(config.labelRegexes) ? config.labelRegexes : [])
            .map(s => {
                try { return new RegExp(s, 'i'); } catch { return null; }
            })
            .filter(Boolean);
        if (labelRegexes.length === 0) {
            labelRegexes = defaultConfig.labelRegexes.map(s => new RegExp(s, 'i'));
        }

        labelSelectors = Array.isArray(config.labelSelectors) ? config.labelSelectors : [];
        widgetSelectors = Array.isArray(config.widgetSelectors) ? config.widgetSelectors : [];
        stopSelectorText = (Array.isArray(config.containerStopSelectors)
            ? config.containerStopSelectors
            : defaultConfig.containerStopSelectors
        ).join(',');

        const toNum = (value, fallback) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : fallback;
        };
        minContainerHeight = toNum(config.minContainerHeight, defaultConfig.minContainerHeight);
        minContainerWidth = toNum(config.minContainerWidth, defaultConfig.minContainerWidth);
        minScore = Math.max(1, toNum(config.minScore, defaultConfig.minScore));
        minScoreLowConfidence = Math.max(
            minScore,
            toNum(config.minScoreLowConfidence, minScore + 1)
        );

        collectCandidates(document);
        shadowController?.rescanNow?.();
        collectKnownShadowRootCandidates();
        scheduleProcess();

        observer.observe(document, { childList: true, subtree: true });
        observerConnected = true;
        return { applied: true };
    };

    let config = defaultConfig;
    self.TalonNativeHeuristicsController = {
        refresh: init,
        stop,
    };

    self.TalonNativeHeuristicsController.refresh().catch(() => {});

})();

void 0;
