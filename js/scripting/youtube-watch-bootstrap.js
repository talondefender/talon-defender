/******************************************************************************/
// Important!
// MAIN-world bootstrap for signed-in YouTube watch follow-up navigations.
(function talonYouTubeWatchBootstrap() {

    if (self.__talonYouTubeWatchBootstrapInstalled === true) { return; }
    self.__talonYouTubeWatchBootstrapInstalled = true;

    const WATCH_ORIGIN = 'https://www.youtube.com';
    const CURRENT_ENVELOPE_KEY = '__td_yw_track_a_envelope_v1';
    const LATEST_ENVELOPE_KEY = '__td_yw_track_a_envelope_latest_v1';
    const DIAGNOSTIC_KEY = '__td_yw_diagnostic';
    const SANITIZER_HEALTH_KEY = '__td_yw_sanitizer_health';
    const BRIDGE_HEALTH_KEY = '__td_yw_bridge_health';
    const BASELINE_RELAY_ESCAPE_KEY = '__td_yw_baseline_relay_escape_v1';
    const ARCH_COOKIE = 'td_yw_arch';
    const DIAG_COOKIE = 'td_yw_diag';
    const OWNER_COOKIE = 'td_yw_owner';
    const LANE_COOKIE = 'td_yw_lane';
    const EXACT_STRATEGY = 'track-a-exact-anchor-intent-lease';
    const FETCH_REQUEST_MESSAGE = 'talon-youtube-watch-fetch-request';
    const FETCH_RESPONSE_MESSAGE = 'talon-youtube-watch-fetch-response';
    const FETCH_BRIDGE_TIMEOUT_MS = 2500;
    const MAX_FREEZE_MS = 2500;
    const RECOVERY_DEADLINE_MS = 1500;
    const SERVICE_WORKER_RECOVERY_TIMEOUT_MS = 250;
    const SERVICE_WORKER_RECOVERY_POLL_MS = 25;
    const SERVICE_WORKER_RECOVERY_SETTLE_MS = 200;
    const TINY_RN1_MAX_BYTES = 1024;
    const SUBSTANTIVE_RN1_MIN_BYTES = 8192;
    const BASELINE_RELAY_ESCAPE_TIMEOUT_MS = 250;
    const PLAYER_RECOVERY_SETTLE_MS = 750;
    const YOUTUBE_INLINE_SCRIPT_MARKERS = Object.freeze([
        'window,"fetch"',
        'onAbnormalityDetected',
    ]);
    const YOUTUBE_PLAYER_RESPONSE_CACHE_KEYS = Object.freeze([
        'bootstrapPlayerResponse',
        'bootstrapPlayerResponse_',
        'cachedPlayerResponse',
        'currentPlayerResponse',
        'playerResponse',
        'playerResponse_',
    ]);
    const YOUTUBE_ANTI_ADBLOCK_TEXT_MARKERS = Object.freeze([
        'Ad blockers violate YouTube\'s Terms of Service',
        'Allow YouTube Ads',
        'Try YouTube Premium',
        'Not using an ad blocker? Report issue',
    ]);

    const startedAtEpochMs = Date.now();
    const startedAtPerfMs = typeof self.performance?.now === 'function'
        ? Number(self.performance.now())
        : 0;
    const locationHref = typeof self.location?.href === 'string' ? self.location.href : '';
    const locationHostname = (self.location?.hostname || '').toLowerCase();
    const isTopDocument = (() => {
        try {
            return self.top === self;
        } catch {
            return false;
        }
    })();

    const safeSessionStorageGet = key => {
        try {
            return self.sessionStorage?.getItem(key) || '';
        } catch {
            return '';
        }
    };

    const safeSessionStorageSet = (key, value) => {
        try {
            self.sessionStorage?.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    };

    const safeSessionStorageRemove = key => {
        try {
            self.sessionStorage?.removeItem(key);
        } catch {
        }
    };

    const clone = value => {
        if (value === undefined) { return undefined; }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    };

    const isPlainObject = value =>
        value instanceof Object &&
        Object.getPrototypeOf(value) === Object.prototype;

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

    const readJsonStorage = key => {
        const raw = safeSessionStorageGet(key);
        if (raw === '') { return null; }
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };

    const writeJsonStorage = (key, value) => {
        try {
            return safeSessionStorageSet(key, JSON.stringify(value));
        } catch {
            return false;
        }
    };

    const copyEntries = entries =>
        entries
            .map(entry => [ String(entry[0]), entry[1] ])
            .sort((a, b) => a[0].localeCompare(b[0]) || String(a[1]).localeCompare(String(b[1])));

    const normalizeWatchUrl = value => {
        if (typeof value !== 'string' || value === '') { return ''; }
        let url;
        try {
            url = new URL(value, locationHref || WATCH_ORIGIN);
        } catch {
            return '';
        }
        if (url.origin !== WATCH_ORIGIN || url.pathname !== '/watch') { return ''; }
        const videoId = (url.searchParams.get('v') || '').trim();
        if (videoId === '') { return ''; }
        const normalized = new URL(`${WATCH_ORIGIN}/watch`);
        for (const [ key, entryValue ] of copyEntries(Array.from(url.searchParams.entries()))) {
            normalized.searchParams.append(key, entryValue);
        }
        normalized.hash = '';
        return normalized.toString();
    };

    const buildRelayUrl = targetUrl => {
        if (typeof targetUrl !== 'string' || targetUrl === '') { return ''; }
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
            relayUrl.searchParams.set('target', targetUrl);
            return relayUrl.toString();
        } catch {
            return '';
        }
    };

    const isTrustedFetchBridgeEvent = event => {
        if (event?.source !== self) { return false; }
        if (typeof event.origin === 'string' && event.origin !== '' && event.origin !== WATCH_ORIGIN) {
            return false;
        }
        return event?.data?.type === FETCH_REQUEST_MESSAGE;
    };

    const fetchWatchDocument = requestedUrl => {
        const options = { credentials: 'include' };
        if (typeof self.AbortController === 'function') {
            const controller = new self.AbortController();
            options.signal = controller.signal;
            const timeoutId = self.setTimeout(() => {
                try {
                    controller.abort();
                } catch {
                }
            }, FETCH_BRIDGE_TIMEOUT_MS);
            return fetch(requestedUrl, options).finally(() => {
                self.clearTimeout(timeoutId);
            });
        }
        let timeoutId;
        const timeout = new Promise((_, reject) => {
            timeoutId = self.setTimeout(() => {
                reject(new Error('watch-fetch-timeout'));
            }, FETCH_BRIDGE_TIMEOUT_MS);
        });
        return Promise.race([
            fetch(requestedUrl, options),
            timeout,
        ]).finally(() => {
            self.clearTimeout(timeoutId);
        });
    };

    const currentWatchUrl = normalizeWatchUrl(locationHref);
    const currentVideoId = (() => {
        if (currentWatchUrl === '') { return ''; }
        try {
            return new URL(currentWatchUrl).searchParams.get('v') || '';
        } catch {
            return '';
        }
    })();

    const architectureCookie = readCookieValue(ARCH_COOKIE);
    const navigationArchitecture = architectureCookie === 'baseline'
        ? 'baseline'
        : EXACT_STRATEGY;
    const diagnosticsEnabled = readCookieValue(DIAG_COOKIE) !== '0';

    const readYouTubeInlineScriptText = node => {
        if (!(node instanceof self.HTMLScriptElement)) { return ''; }
        const candidates = [
            node.text,
            node.textContent,
            node.innerHTML,
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate !== '') {
                return candidate;
            }
        }
        return '';
    };

    const findYouTubeInlineScriptMarker = text => {
        if (typeof text !== 'string' || text === '') { return ''; }
        for (const marker of YOUTUBE_INLINE_SCRIPT_MARKERS) {
            if (text.includes(marker)) {
                return marker;
            }
        }
        return '';
    };

    const neutralizeYouTubeInlineScriptNode = node => {
        if (!(node instanceof self.HTMLScriptElement)) { return false; }
        if ((node.src || '').trim() !== '') { return false; }
        if (node.__talonYouTubeInlineScriptNeutralized === true) { return false; }
        const marker = findYouTubeInlineScriptMarker(readYouTubeInlineScriptText(node));
        if (marker === '') { return false; }
        try {
            node.__talonYouTubeInlineScriptNeutralized = true;
        } catch {
        }
        try {
            node.type = 'application/x-talon-neutralized-script';
        } catch {
        }
        try {
            node.text = '';
        } catch {
        }
        try {
            node.textContent = '';
        } catch {
        }
        try {
            node.innerHTML = '';
        } catch {
        }
        return true;
    };

    const installYouTubeInlineScriptNeutralizer = () => {
        if (locationHostname !== 'www.youtube.com' || isTopDocument === false) { return; }
        if (self.__talonYouTubeInlineScriptNeutralizerInstalled === true) { return; }
        self.__talonYouTubeInlineScriptNeutralizerInstalled = true;

        const wrapScriptInsertionMethod = (prototype, methodName) => {
            const original = prototype?.[methodName];
            if (typeof original !== 'function') { return; }
            prototype[methodName] = function(...args) {
                neutralizeYouTubeInlineScriptNode(args[0]);
                return Reflect.apply(original, this, args);
            };
        };

        wrapScriptInsertionMethod(self.Node?.prototype, 'appendChild');
        wrapScriptInsertionMethod(self.Node?.prototype, 'insertBefore');
        wrapScriptInsertionMethod(self.Node?.prototype, 'replaceChild');
    };

    installYouTubeInlineScriptNeutralizer();

    const installFetchBridge = () => {
        if (locationHostname !== 'www.youtube.com' || isTopDocument === false) { return; }
        if (self.__talonYouTubeWatchFetchBridgeInstalled === true) { return; }
        self.__talonYouTubeWatchFetchBridgeInstalled = true;
        self.addEventListener?.('message', async event => {
            if (isTrustedFetchBridgeEvent(event) === false) { return; }
            const requestId = typeof event?.data?.id === 'string'
                ? event.data.id
                : '';
            const requestedUrl = normalizeWatchUrl(event?.data?.url || '');
            if (requestId === '' || requestedUrl === '') { return; }
            let payload;
            try {
                const response = await fetchWatchDocument(requestedUrl);
                payload = {
                    type: FETCH_RESPONSE_MESSAGE,
                    id: requestId,
                    ok: response.ok === true,
                    status: Number(response.status) || 0,
                    text: response.ok ? await response.text() : '',
                    error: response.ok ? '' : `watch-fetch-${response.status}`,
                    resolvedAtEpochMs: Date.now(),
                };
            } catch (error) {
                payload = {
                    type: FETCH_RESPONSE_MESSAGE,
                    id: requestId,
                    ok: false,
                    status: 0,
                    text: '',
                    error: error instanceof Error ? error.message : String(error),
                    resolvedAtEpochMs: Date.now(),
                };
            }
            self.postMessage(payload, WATCH_ORIGIN);
        }, { capture: true });
    };

    installFetchBridge();

    const protectedKeySet = new Set([
        'moviePlayerResponse',
        'ytInitialPlayerResponse',
        'ytInitialData',
        'ytcfg',
        'ytplayer',
        'videoPlaybackUstreamerConfig',
    ]);
    const adKeySet = new Set([
        'adPlacements',
        'adSlots',
        'playerAds',
        'adBreakHeartbeatParams',
        'ad3Module',
        'adSafetyReason',
        'adParams',
        'adPlacementConfig',
        'adTrackingParams',
        'adLoggingData',
        'adVideoId',
    ]);
    const adTrackingParamKeyPattern = /^(?:yt_ad|is_ad|ad_|ad[A-Z]|ads[A-Z])/;
    const adPreloadMessageNamePattern = /^(?:ad[A-Z]|ads[A-Z]|ad_|aboutThisAd|inPlayerAd|instreamVideoAd|panelAd|playerAd|playerBytesAd|playerLegacyDesktopWatchAds|skipAd|timedPieCountdown|videoInterstitial|visitAdvertiserLink)/;

    const hasPlayableStreamingData = value => {
        if (isPlainObject(value) === false || isPlainObject(value.streamingData) === false) {
            return false;
        }
        const formats = Array.isArray(value.streamingData.formats)
            ? value.streamingData.formats.length
            : 0;
        const adaptiveFormats = Array.isArray(value.streamingData.adaptiveFormats)
            ? value.streamingData.adaptiveFormats.length
            : 0;
        return formats > 0 || adaptiveFormats > 0;
    };

    const isPlayerResponseOk = value =>
        typeof value?.playabilityStatus?.status === 'string' &&
        value.playabilityStatus.status === 'OK';

    const hasAntiAdblockEnforcement = value =>
        isPlainObject(value?.playabilityStatus?.errorScreen?.enforcementMessageViewModel);

    const hasAntiAdblockAuxiliaryUi = value =>
        isPlainObject(value?.auxiliaryUi?.messageRenderers?.bkaEnforcementMessageViewModel);

    const hasAntiAdblockPayload = value =>
        hasAntiAdblockEnforcement(value) || hasAntiAdblockAuxiliaryUi(value);

    const repairAntiAdblockPlayerResponse = value => {
        if (isPlainObject(value) === false) { return value; }
        if (hasPlayableStreamingData(value) === false) { return value; }
        if (hasAntiAdblockPayload(value) === false) { return value; }
        delete value.auxiliaryUi;
        if (isPlainObject(value.playabilityStatus)) {
            value.playabilityStatus = {
                ...value.playabilityStatus,
                status: 'OK',
            };
            delete value.playabilityStatus.reason;
            delete value.playabilityStatus.errorScreen;
        }
        return value;
    };

    const sanitizeServiceTrackingParams = (entries, depth) => {
        const out = [];
        for (const entry of entries) {
            if (isPlainObject(entry) === false) {
                const sanitized = sanitizeStructure(entry, depth + 1);
                if (sanitized !== undefined) {
                    out.push(sanitized);
                }
                continue;
            }
            const nextEntry = {};
            for (const [ key, entryValue ] of Object.entries(entry)) {
                if (key === 'params' && Array.isArray(entryValue)) {
                    const params = [];
                    for (const param of entryValue) {
                        if (isPlainObject(param) === false) {
                            const sanitized = sanitizeStructure(param, depth + 1);
                            if (sanitized !== undefined) {
                                params.push(sanitized);
                            }
                            continue;
                        }
                        const trackingKey = typeof param.key === 'string'
                            ? param.key
                            : '';
                        if (adTrackingParamKeyPattern.test(trackingKey)) {
                            continue;
                        }
                        const sanitized = sanitizeStructure(param, depth + 1);
                        if (sanitized !== undefined) {
                            params.push(sanitized);
                        }
                    }
                    if (params.length > 0) {
                        nextEntry.params = params;
                    }
                    continue;
                }
                const sanitized = sanitizeStructure(entryValue, depth + 1);
                if (sanitized === undefined) { continue; }
                nextEntry[key] = sanitized;
            }
            if (Object.keys(nextEntry).length > 0) {
                out.push(nextEntry);
            }
        }
        return out;
    };

    const sanitizePreloadMessageNames = entries => {
        const out = [];
        for (const entry of entries) {
            if (typeof entry !== 'string') {
                const sanitized = sanitizeStructure(entry, 1);
                if (sanitized !== undefined) {
                    out.push(sanitized);
                }
                continue;
            }
            if (adPreloadMessageNamePattern.test(entry)) {
                continue;
            }
            out.push(entry);
        }
        return out;
    };

    const sanitizeStructure = (value, depth = 0) => {
        if (depth > 24) { return undefined; }
        if (value === null) { return null; }
        if (Array.isArray(value)) {
            const out = [];
            for (const entry of value) {
                const sanitized = sanitizeStructure(entry, depth + 1);
                if (sanitized === undefined) { continue; }
                out.push(sanitized);
            }
            return out;
        }
        if (isPlainObject(value)) {
            const out = {};
            for (const [ key, entryValue ] of Object.entries(value)) {
                if (adKeySet.has(key)) { continue; }
                if (/^(?:ad_|ad[A-Z]|ads[A-Z]|playerAds$)/.test(key)) { continue; }
                if (key === 'serviceTrackingParams' && Array.isArray(entryValue)) {
                    const sanitized = sanitizeServiceTrackingParams(entryValue, depth + 1);
                    if (sanitized.length > 0) {
                        out[key] = sanitized;
                    }
                    continue;
                }
                if (key === 'preloadMessageNames' && Array.isArray(entryValue)) {
                    const sanitized = sanitizePreloadMessageNames(entryValue);
                    if (sanitized.length > 0) {
                        out[key] = sanitized;
                    }
                    continue;
                }
                const sanitized = sanitizeStructure(entryValue, depth + 1);
                if (sanitized === undefined) { continue; }
                out[key] = sanitized;
            }
            return repairAntiAdblockPlayerResponse(out);
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

    const buildProtectedYtcfg = (source, playerResponse, ustreamerConfig) => {
        const ytcfg = sanitizeStructure(source);
        const out = isPlainObject(ytcfg) ? ytcfg : {};
        const rawPlayerResponse = playerResponse === undefined
            ? ''
            : JSON.stringify(playerResponse);
        if (rawPlayerResponse !== '') {
            if (isPlainObject(out.PLAYER_VARS) === false) {
                out.PLAYER_VARS = {};
            }
            out.PLAYER_VARS.raw_player_response = rawPlayerResponse;
            if (isPlainObject(out.WEB_PLAYER_CONTEXT_CONFIGS)) {
                for (const entryValue of Object.values(out.WEB_PLAYER_CONTEXT_CONFIGS)) {
                    if (isPlainObject(entryValue) === false) { continue; }
                    entryValue.raw_player_response = rawPlayerResponse;
                }
            }
        }
        if (ustreamerConfig !== undefined) {
            out.videoPlaybackUstreamerConfig = sanitizeStructure(ustreamerConfig);
        }
        return out;
    };

    const buildProtectedPlayerConfig = (playerResponse, ytcfg, ustreamerConfig) => {
        const out = {
            args: {},
        };
        if (playerResponse !== undefined) {
            out.args.raw_player_response = JSON.stringify(playerResponse);
        }
        if (isPlainObject(ytcfg) && Number.isFinite(Number(ytcfg.STS))) {
            out.sts = Number(ytcfg.STS);
        }
        if (ustreamerConfig !== undefined) {
            out.videoPlaybackUstreamerConfig = sanitizeStructure(ustreamerConfig);
        }
        return out;
    };

    const envelopeSummary = envelope => ({
        leaseId: typeof envelope?.leaseId === 'string' ? envelope.leaseId : '',
        targetUrl: typeof envelope?.targetUrl === 'string' ? envelope.targetUrl : '',
        videoId: typeof envelope?.videoId === 'string' ? envelope.videoId : '',
        sourceKind: typeof envelope?.sourceKind === 'string' ? envelope.sourceKind : '',
        playerBundleId: typeof envelope?.playerBundleId === 'string' ? envelope.playerBundleId : '',
        sanitizerVersion: typeof envelope?.sanitizerVersion === 'string'
            ? envelope.sanitizerVersion
            : '',
        createdAtEpochMs: Number.isFinite(Number(envelope?.createdAtEpochMs))
            ? Number(envelope.createdAtEpochMs)
            : null,
        expiresAtEpochMs: Number.isFinite(Number(envelope?.expiresAtEpochMs))
            ? Number(envelope.expiresAtEpochMs)
            : null,
        hasYtcfg: isPlainObject(envelope?.ytcfg),
        hasInitialPlayerResponse: isPlainObject(envelope?.ytInitialPlayerResponse),
        hasInitialData: envelope?.ytInitialData !== undefined,
        hasUstreamerConfig: envelope?.videoPlaybackUstreamerConfig !== undefined,
    });

    const diagnosticState = Object.assign(
        {
            architectureEntryStrategy: navigationArchitecture,
            handoffSurface: 'sessionStorage',
            leaseHit: false,
            leaseMiss: false,
            donorReadyBeforeClick: false,
            envelopeConsumed: false,
            freezeHeld: false,
            freezeReleasedBy: '',
            tinyRn1Recovered: false,
            recoveryFallbackUsed: false,
            serviceWorkerRecoveryAttempted: false,
            serviceWorkerRecoveryChanged: false,
            serviceWorkerRecoveryTimedOut: false,
            serviceWorkerRecoveryError: '',
        },
        readJsonStorage(DIAGNOSTIC_KEY) || {}
    );

    const persistDiagnosticState = () => {
        if (diagnosticsEnabled === false) { return; }
        writeJsonStorage(DIAGNOSTIC_KEY, diagnosticState);
    };

    const emitHealth = (bridgePatch = {}) => {
        const sanitizerHealth = {
            watchSanitizerReady: true,
            executedAtEpochMs: startedAtEpochMs,
            architectureEntryStrategy: navigationArchitecture,
            architectureHandoffSurface: 'sessionStorage',
            currentWatchUrl,
            currentVideoId,
            diagnosticsEnabled,
        };
        const bridgeHealth = Object.assign(
            {
                architectureEntryStrategy: navigationArchitecture,
                architectureHandoffSurface: 'sessionStorage',
                ownerProfile: readCookieValue(OWNER_COOKIE) || 'talon-current',
                runtimeLane: readCookieValue(LANE_COOKIE) || 'talon-current',
            },
            bridgePatch
        );
        writeJsonStorage(SANITIZER_HEALTH_KEY, sanitizerHealth);
        writeJsonStorage(BRIDGE_HEALTH_KEY, bridgeHealth);
    };

    const applyDiagnosticGlobals = () => {
        self.__talonYouTubeWatchSanitizer = true;
        self.__talonYouTubeWatchDiagnosticsEnabled = diagnosticsEnabled;
        self.__talonYouTubeWatchDiagnosticTokens = [
            navigationArchitecture,
            currentVideoId,
        ].filter(Boolean);
        self.__talonYouTubeWatchSanitizerExecutedAt = startedAtEpochMs;
        self.__talonYouTubeWatchSanitizerExecutedPerfMs = startedAtPerfMs;
        self.__talonYouTubeWatchEntryStrategy = navigationArchitecture;
        self.__talonYouTubeWatchArchitectureEntryStrategy = navigationArchitecture;
        self.__talonYouTubeWatchArchitectureHandoffSurface = 'sessionStorage';
        self.__talonYouTubeWatchRuntimeLane = readCookieValue(LANE_COOKIE) || 'talon-current';
        self.__talonYouTubeWatchRewriteMode = 'shadow-bootstrap-v1';
        self.__talonYouTubeWatchArchitectureTrackAIntentLeaseHit =
            diagnosticState.leaseHit === true;
        self.__talonYouTubeWatchArchitectureTrackAIntentLeaseMiss =
            diagnosticState.leaseMiss === true;
        self.__talonYouTubeWatchArchitectureReadyBeforeClick =
            diagnosticState.donorReadyBeforeClick === true;
        self.__talonYouTubeWatchArchitectureEnvelopeReadyBeforeNavigationRelease =
            diagnosticState.donorReadyBeforeClick === true;
        if (Number.isFinite(Number(diagnosticState.donorStartedAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureDonorStartedAt =
                Number(diagnosticState.donorStartedAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.donorReadyAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureDonorReadyAt =
                Number(diagnosticState.donorReadyAtEpochMs);
            self.__talonYouTubeWatchArchitectureReadyAt =
                Number(diagnosticState.donorReadyAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.anchorSeenAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureAnchorSeenAt =
                Number(diagnosticState.anchorSeenAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.clickAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureClickAt =
                Number(diagnosticState.clickAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.navigationHoldDurationMs))) {
            self.__talonYouTubeWatchArchitectureNavigationHoldDurationMs =
                Number(diagnosticState.navigationHoldDurationMs);
        }
        if (Number.isFinite(Number(diagnosticState.trackAStoredAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureTrackAStoredAt =
                Number(diagnosticState.trackAStoredAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.trackAStoredBytes))) {
            self.__talonYouTubeWatchArchitectureTrackAStoredBytes =
                Number(diagnosticState.trackAStoredBytes);
        }
        self.__talonYouTubeWatchArchitectureTrackAStoredWriteOk =
            diagnosticState.trackAStoredWriteOk === true;
        self.__talonYouTubeWatchArchitectureTrackAStoredReadbackOk =
            diagnosticState.trackAStoredReadbackOk === true;
        self.__talonYouTubeWatchArchitectureTrackAStoredTargetMatch =
            diagnosticState.trackAStoredTargetMatch === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmRequested =
            diagnosticState.prewarmRequested === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionHit =
            diagnosticState.prewarmPredictionHit === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionMiss =
            diagnosticState.prewarmPredictionMiss === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryStale =
            diagnosticState.prewarmEntryStale === true;
        if (Number.isFinite(Number(diagnosticState.prewarmEntryCreatedAtEpochMs))) {
            self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryCreatedAt =
                Number(diagnosticState.prewarmEntryCreatedAtEpochMs);
        }
        if (Number.isFinite(Number(diagnosticState.prewarmEntryAgeMs))) {
            self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryAgeMs =
                Number(diagnosticState.prewarmEntryAgeMs);
        }
        self.__talonYouTubeWatchArchitectureFallbackPathUsed =
            diagnosticState.recoveryFallbackUsed === true;
        self.__talonYouTubeWatchArchitectureTimeoutOccurred =
            diagnosticState.timeoutOccurred === true;
        self.__talonYouTubeWatchArchitectureInvalidReason =
            typeof diagnosticState.invalidReason === 'string'
                ? diagnosticState.invalidReason
                : '';
        self.__talonYouTubeWatchDiagnosticReport = clone(diagnosticState);
    };

    applyDiagnosticGlobals();
    emitHealth();
    persistDiagnosticState();

    if (locationHostname !== 'www.youtube.com' || isTopDocument === false) { return; }

    const controllerScriptUrl =
        typeof self.navigator?.serviceWorker?.controller?.scriptURL === 'string'
            ? self.navigator.serviceWorker.controller.scriptURL
            : '';
    const relayEscapeState = readJsonStorage(BASELINE_RELAY_ESCAPE_KEY);
    if (
        currentWatchUrl !== '' &&
        navigationArchitecture === 'baseline' &&
        controllerScriptUrl === '' &&
        relayEscapeState?.targetUrl === currentWatchUrl
    ) {
        safeSessionStorageRemove(BASELINE_RELAY_ESCAPE_KEY);
    }
    if (
        currentWatchUrl !== '' &&
        navigationArchitecture === 'baseline' &&
        controllerScriptUrl !== '' &&
        (!relayEscapeState ||
            relayEscapeState.targetUrl !== currentWatchUrl ||
            Number(relayEscapeState.attemptCount) < 1)
    ) {
        const relayUrl = buildRelayUrl(currentWatchUrl);
        if (relayUrl !== '') {
            writeJsonStorage(BASELINE_RELAY_ESCAPE_KEY, {
                targetUrl: currentWatchUrl,
                attemptCount:
                    relayEscapeState?.targetUrl === currentWatchUrl
                        ? Math.max(1, Number(relayEscapeState.attemptCount) + 1 || 1)
                        : 1,
                requestedAtEpochMs: Date.now(),
            });
            diagnosticState.postCommitRelayEscapeAttempted = true;
            diagnosticState.postCommitRelayEscapeControllerHash = controllerScriptUrl !== ''
                ? controllerScriptUrl
                : null;
            persistDiagnosticState();
            applyDiagnosticGlobals();
            (async () => {
                const serviceWorker = self.navigator?.serviceWorker;
                const unregisterWork = (async () => {
                    if (typeof serviceWorker?.getRegistrations !== 'function') {
                        return {
                            attempted: false,
                            changed: false,
                            timedOut: false,
                        };
                    }
                    const registrations = await serviceWorker.getRegistrations();
                    let attempted = false;
                    let changed = false;
                    for (const registration of registrations) {
                        const scope = typeof registration?.scope === 'string'
                            ? registration.scope
                            : '';
                        if (scope === '' || scope.startsWith(WATCH_ORIGIN) === false) { continue; }
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
                const timeoutWork = new Promise(resolve => {
                    self.setTimeout(() => resolve({
                        attempted: true,
                        changed: false,
                        timedOut: true,
                    }), BASELINE_RELAY_ESCAPE_TIMEOUT_MS);
                });
                const result = await Promise.race([ unregisterWork, timeoutWork ]);
                diagnosticState.postCommitRelayEscapeChanged = result?.changed === true;
                diagnosticState.postCommitRelayEscapeTimedOut = result?.timedOut === true;
                persistDiagnosticState();
                applyDiagnosticGlobals();
                self.location.replace(relayUrl);
            })();
            return;
        }
    }

    const parseEnvelope = (raw, source) => {
        self.__talonYouTubeWatchArchitectureTrackAReadAt = Date.now();
        self.__talonYouTubeWatchArchitectureTrackAReadRawPresent = raw !== '';
        self.__talonYouTubeWatchArchitectureTrackAReadRawBytes = raw.length;
        if (raw === '') { return null; }
        let envelope;
        try {
            envelope = JSON.parse(raw);
            self.__talonYouTubeWatchArchitectureTrackAReadParseOk = true;
        } catch {
            diagnosticState.invalidReason = `${source}:parse`;
            return null;
        }
        const normalizedTargetUrl = normalizeWatchUrl(envelope?.targetUrl || '');
        if (normalizedTargetUrl === '') {
            diagnosticState.invalidReason = `${source}:target`;
            return null;
        }
        if (currentWatchUrl !== '' && normalizedTargetUrl !== currentWatchUrl) {
            diagnosticState.invalidReason = `${source}:target-mismatch`;
            return null;
        }
        const expiresAtEpochMs = Number(envelope?.expiresAtEpochMs) || 0;
        if (expiresAtEpochMs !== 0 && expiresAtEpochMs < Date.now()) {
            diagnosticState.invalidReason = `${source}:expired`;
            return null;
        }
        self.__talonYouTubeWatchArchitectureTrackAReadTargetMatch = true;
        return envelope;
    };

    const currentEnvelopeRaw = safeSessionStorageGet(CURRENT_ENVELOPE_KEY);
    const latestEnvelopeRaw = safeSessionStorageGet(LATEST_ENVELOPE_KEY);
    let envelopeSource = '';
    let activeEnvelope = null;
    let activeEnvelopeRaw = '';

    if (navigationArchitecture === EXACT_STRATEGY && currentWatchUrl !== '') {
        activeEnvelope = parseEnvelope(currentEnvelopeRaw, 'current');
        if (activeEnvelope !== null) {
            envelopeSource = 'current';
            activeEnvelopeRaw = currentEnvelopeRaw;
        } else {
            activeEnvelope = parseEnvelope(latestEnvelopeRaw, 'latest');
            if (activeEnvelope !== null) {
                envelopeSource = 'latest';
                activeEnvelopeRaw = latestEnvelopeRaw;
            }
        }
    }

    if (activeEnvelope !== null) {
        diagnosticState.envelopeConsumed = true;
        diagnosticState.trackAReadConsumed = true;
        diagnosticState.documentCommitAtEpochMs = Date.now();
        diagnosticState.documentCommitEnvelopePresent = true;
        diagnosticState.documentCommitEnvelopeSource = envelopeSource;
        self.__talonYouTubeWatchArchitectureDocumentCommitAt =
            diagnosticState.documentCommitAtEpochMs;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = true;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource = envelopeSource;
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeLoadedSummary =
            envelopeSummary(activeEnvelope);
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded = true;
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededAt = Date.now();
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededSource = envelopeSource;
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededSummary =
            envelopeSummary(activeEnvelope);
        safeSessionStorageRemove(CURRENT_ENVELOPE_KEY);
        self.__talonYouTubeWatchArchitectureTrackAReadCleared = true;
        emitHealth({
            architectureDocumentCommitEnvelopePresent: true,
            architectureDocumentCommitEnvelopeSource: envelopeSource,
        });
    } else if (currentWatchUrl !== '') {
        diagnosticState.documentCommitAtEpochMs = Date.now();
        diagnosticState.documentCommitEnvelopePresent = false;
        diagnosticState.documentCommitEnvelopeSource = '';
        self.__talonYouTubeWatchArchitectureDocumentCommitAt =
            diagnosticState.documentCommitAtEpochMs;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = false;
        emitHealth({
            architectureDocumentCommitEnvelopePresent: false,
            architectureDocumentCommitEnvelopeSource: '',
        });
    }

    persistDiagnosticState();
    applyDiagnosticGlobals();

    if (currentWatchUrl === '') { return; }

    const markLivePlayerResponseSanitized = () => {
        self.__talonYouTubeWatchPlayerResponseSeen = true;
        self.__talonYouTubeWatchPlayerResponseSeenAt = Date.now();
        self.__talonYouTubeWatchPlayerResponseSanitized = true;
        self.__talonYouTubeWatchPlayerResponseSanitizedAt = Date.now();
    };

    const sanitizeRawPlayerResponseString = rawValue => {
        if (typeof rawValue !== 'string' || rawValue === '') { return rawValue; }
        try {
            return JSON.stringify(sanitizeStructure(JSON.parse(rawValue)));
        } catch {
            return rawValue;
        }
    };

    const sanitizeLivePlayerConfig = target => {
        if (target instanceof Object === false) { return target; }
        if (isPlainObject(target.config) === false) { return target; }
        if (isPlainObject(target.config.args) === false) { return target; }
        const nextRawPlayerResponse = sanitizeRawPlayerResponseString(
            target.config.args.raw_player_response
        );
        if (nextRawPlayerResponse === target.config.args.raw_player_response) {
            return target;
        }
        target.config.args.raw_player_response = nextRawPlayerResponse;
        markLivePlayerResponseSanitized();
        return target;
    };

    const sanitizeLiveYtcfgBag = bag => {
        if (isPlainObject(bag) === false) { return false; }
        let changed = false;
        if (isPlainObject(bag.PLAYER_VARS)) {
            const nextRawPlayerResponse = sanitizeRawPlayerResponseString(
                bag.PLAYER_VARS.raw_player_response
            );
            if (nextRawPlayerResponse !== bag.PLAYER_VARS.raw_player_response) {
                bag.PLAYER_VARS.raw_player_response = nextRawPlayerResponse;
                changed = true;
            }
        }
        if (isPlainObject(bag.WEB_PLAYER_CONTEXT_CONFIGS)) {
            for (const entryValue of Object.values(bag.WEB_PLAYER_CONTEXT_CONFIGS)) {
                if (isPlainObject(entryValue) === false) { continue; }
                const nextRawPlayerResponse = sanitizeRawPlayerResponseString(
                    entryValue.raw_player_response
                );
                if (nextRawPlayerResponse === entryValue.raw_player_response) { continue; }
                entryValue.raw_player_response = nextRawPlayerResponse;
                changed = true;
            }
        }
        if (bag.videoPlaybackUstreamerConfig !== undefined) {
            const nextUstreamerConfig = sanitizeStructure(bag.videoPlaybackUstreamerConfig);
            if (
                JSON.stringify(nextUstreamerConfig) !== JSON.stringify(bag.videoPlaybackUstreamerConfig)
            ) {
                bag.videoPlaybackUstreamerConfig = nextUstreamerConfig;
                self.__talonYouTubeWatchPlayerBootstrapSanitized = true;
                self.__talonYouTubeWatchPlayerBootstrapSanitizedAt = Date.now();
                changed = true;
            }
        }
        if (changed) {
            markLivePlayerResponseSanitized();
        }
        return changed;
    };

    const sanitizeLiveYtcfgConfigPatch = patch => {
        if (isPlainObject(patch) === false) { return patch; }
        sanitizeLiveYtcfgBag(patch);
        return patch;
    };

    const sanitizeLiveYtcfg = target => {
        if (target instanceof Object === false) { return target; }
        sanitizeLiveYtcfgBag(target.data_);
        sanitizeLiveYtcfgBag(target.data);
        const nativeSet = typeof target.set === 'function'
            ? target.set.bind(target)
            : null;
        target.set = (keyOrMap, value) => {
            if (typeof keyOrMap === 'string') {
                const patch = sanitizeLiveYtcfgConfigPatch({ [keyOrMap]: value });
                const nextValue = patch[keyOrMap];
                const result = nativeSet ? nativeSet(keyOrMap, nextValue) : true;
                sanitizeLiveYtcfgBag(target.data_);
                sanitizeLiveYtcfgBag(target.data);
                return result;
            }
            const nextPatch = sanitizeLiveYtcfgConfigPatch(keyOrMap);
            const result = nativeSet ? nativeSet(nextPatch) : true;
            sanitizeLiveYtcfgBag(target.data_);
            sanitizeLiveYtcfgBag(target.data);
            return result;
        };
        return target;
    };

    let restoreDefineProperty;
    if (activeEnvelope === null) {
        let liveMoviePlayerResponse = sanitizeStructure(self.moviePlayerResponse);
        if (isPlainObject(liveMoviePlayerResponse)) {
            markLivePlayerResponseSanitized();
        }
        Object.defineProperty(self, 'moviePlayerResponse', {
            configurable: true,
            enumerable: true,
            get() {
                return liveMoviePlayerResponse;
            },
            set(nextValue) {
                liveMoviePlayerResponse = sanitizeStructure(nextValue);
                if (isPlainObject(liveMoviePlayerResponse)) {
                    markLivePlayerResponseSanitized();
                }
            },
        });

        let livePlayerResponse = sanitizeStructure(self.ytInitialPlayerResponse);
        if (isPlainObject(livePlayerResponse)) {
            markLivePlayerResponseSanitized();
        }
        Object.defineProperty(self, 'ytInitialPlayerResponse', {
            configurable: true,
            enumerable: true,
            get() {
                return livePlayerResponse;
            },
            set(nextValue) {
                livePlayerResponse = sanitizeStructure(nextValue);
                if (isPlainObject(livePlayerResponse)) {
                    markLivePlayerResponseSanitized();
                }
            },
        });

        let liveYtcfg = sanitizeLiveYtcfg(self.ytcfg);
        Object.defineProperty(self, 'ytcfg', {
            configurable: true,
            enumerable: true,
            get() {
                return liveYtcfg;
            },
            set(nextValue) {
                liveYtcfg = sanitizeLiveYtcfg(nextValue);
            },
        });

        let liveYtplayer = sanitizeLivePlayerConfig(self.ytplayer);
        Object.defineProperty(self, 'ytplayer', {
            configurable: true,
            enumerable: true,
            get() {
                return liveYtplayer;
            },
            set(nextValue) {
                liveYtplayer = sanitizeLivePlayerConfig(nextValue);
            },
        });

        const liveProtectedAssignments = new Map([
            [ 'moviePlayerResponse', nextValue => {
                liveMoviePlayerResponse = sanitizeStructure(nextValue);
                if (isPlainObject(liveMoviePlayerResponse)) {
                    markLivePlayerResponseSanitized();
                }
            } ],
            [ 'ytInitialPlayerResponse', nextValue => {
                livePlayerResponse = sanitizeStructure(nextValue);
                if (isPlainObject(livePlayerResponse)) {
                    markLivePlayerResponseSanitized();
                }
            } ],
            [ 'ytcfg', nextValue => {
                liveYtcfg = sanitizeLiveYtcfg(nextValue);
            } ],
            [ 'ytplayer', nextValue => {
                liveYtplayer = sanitizeLivePlayerConfig(nextValue);
            } ],
        ]);
        const originalDefineProperty = Object.defineProperty;
        const originalReflectDefineProperty =
            typeof Reflect?.defineProperty === 'function'
                ? Reflect.defineProperty.bind(Reflect)
                : null;
        const captureLiveProtectedAssignment = (property, descriptor) => {
            const assignValue = liveProtectedAssignments.get(String(property));
            if (typeof assignValue !== 'function') { return false; }
            if (descriptor instanceof Object === false) {
                assignValue(undefined);
                return true;
            }
            if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                assignValue(descriptor.value);
                return true;
            }
            if (typeof descriptor.get === 'function') {
                try {
                    assignValue(descriptor.get.call(self));
                } catch {
                }
                return true;
            }
            return true;
        };
        Object.defineProperty = (target, property, descriptor) => {
            if (
                target === self &&
                protectedKeySet.has(String(property)) &&
                captureLiveProtectedAssignment(property, descriptor)
            ) {
                return target;
            }
            return originalDefineProperty(target, property, descriptor);
        };
        if (originalReflectDefineProperty !== null) {
            Reflect.defineProperty = (target, property, descriptor) => {
                if (
                    target === self &&
                    protectedKeySet.has(String(property)) &&
                    captureLiveProtectedAssignment(property, descriptor)
                ) {
                    return true;
                }
                return originalReflectDefineProperty(target, property, descriptor);
            };
        }
        restoreDefineProperty = () => {
            Object.defineProperty = originalDefineProperty;
            if (originalReflectDefineProperty !== null) {
                Reflect.defineProperty = originalReflectDefineProperty;
            }
            restoreDefineProperty = undefined;
        };
    }

    const readYtcfgValue = key => {
        if (typeof key !== 'string' || key === '') { return undefined; }
        try {
            if (typeof self.ytcfg?.get === 'function') {
                const value = self.ytcfg.get(key);
                if (value !== undefined) { return value; }
            }
        } catch {
        }
        const bags = [
            self.ytcfg?.data_,
            self.ytcfg?.data,
            self.ytcfg_,
        ];
        for (const bag of bags) {
            if (isPlainObject(bag) && bag[key] !== undefined) {
                return bag[key];
            }
        }
        return undefined;
    };

    const freezeEligible =
        navigationArchitecture === EXACT_STRATEGY &&
        activeEnvelope !== null;

    const currentProtection = {
        freezeHeld: freezeEligible,
        freezeReleasedBy: '',
        recoveryTriggered: false,
        firstTinyRn1Bytes: 0,
        firstSubstantiveRn1Bytes: 0,
        firstTinyRn1AtEpochMs: 0,
        firstSubstantiveRn1AtEpochMs: 0,
        playbackProgressSeen: false,
        latestEnvelopeRaw: freezeEligible ? latestEnvelopeRaw : '',
        navigationKey: typeof activeEnvelope?.leaseId === 'string' && activeEnvelope.leaseId !== ''
            ? activeEnvelope.leaseId
            : currentWatchUrl,
    };
    diagnosticState.freezeHeld = currentProtection.freezeHeld;
    self.__talonYouTubeWatchPlayerBootstrapDefinedAt = Date.now();

    const persistRuntimeState = () => {
        diagnosticState.freezeHeld = currentProtection.freezeHeld;
        diagnosticState.freezeReleasedBy = currentProtection.freezeReleasedBy;
        diagnosticState.tinyRn1Recovered = currentProtection.recoveryTriggered;
        diagnosticState.recoveryFallbackUsed = currentProtection.recoveryTriggered;
        persistDiagnosticState();
        applyDiagnosticGlobals();
        emitHealth({
            freezeHeld: currentProtection.freezeHeld,
            freezeReleasedBy: currentProtection.freezeReleasedBy,
            firstTinyRn1Bytes: currentProtection.firstTinyRn1Bytes,
            firstSubstantiveRn1Bytes: currentProtection.firstSubstantiveRn1Bytes,
        });
    };

    const releaseFreeze = reason => {
        if (currentProtection.freezeHeld === false) { return; }
        currentProtection.freezeHeld = false;
        currentProtection.freezeReleasedBy = reason;
        safeSessionStorageRemove(LATEST_ENVELOPE_KEY);
        persistRuntimeState();
        if (typeof restoreDefineProperty === 'function') {
            restoreDefineProperty();
        }
    };

    if (freezeEligible) {
        const protectedPlayerResponse = sanitizeStructure(activeEnvelope.ytInitialPlayerResponse);
        const protectedInitialData = sanitizeStructure(activeEnvelope.ytInitialData);
        const protectedUstreamerConfig = sanitizeStructure(activeEnvelope.videoPlaybackUstreamerConfig);
        const protectedYtcfg = buildProtectedYtcfg(
            activeEnvelope.ytcfg,
            protectedPlayerResponse,
            protectedUstreamerConfig
        );
        const protectedPlayerConfig = buildProtectedPlayerConfig(
            protectedPlayerResponse,
            protectedYtcfg,
            protectedUstreamerConfig
        );
        const protectedValues = new Map([
            [ 'moviePlayerResponse', protectedPlayerResponse ],
            [ 'ytInitialPlayerResponse', protectedPlayerResponse ],
            [ 'ytInitialData', protectedInitialData ],
            [ 'videoPlaybackUstreamerConfig', protectedUstreamerConfig ],
        ]);
        let ytcfgObject = null;
        let ytplayerObject = null;

        const mergeProtectedObject = (target, protectedShape) => {
            if (isPlainObject(target) === false || isPlainObject(protectedShape) === false) {
                return clone(protectedShape);
            }
            const out = clone(target);
            for (const [ key, protectedValue ] of Object.entries(protectedShape)) {
                if (isPlainObject(protectedValue) && isPlainObject(out[key])) {
                    out[key] = mergeProtectedObject(out[key], protectedValue);
                    continue;
                }
                out[key] = clone(protectedValue);
            }
            return out;
        };

        const installProtectedValue = (name, initialValue) => {
            let currentValue = clone(initialValue);
            Object.defineProperty(self, name, {
                configurable: true,
                enumerable: true,
                get() {
                    return currentValue;
                },
                set(nextValue) {
                    const sanitized = sanitizeStructure(nextValue);
                    currentValue = currentProtection.freezeHeld
                        ? mergeProtectedObject(sanitized, protectedValues.get(name))
                        : sanitized;
                    if (name === 'moviePlayerResponse' || name === 'ytInitialPlayerResponse') {
                        self.__talonYouTubeWatchPlayerResponseSeen = true;
                        self.__talonYouTubeWatchPlayerResponseSeenAt = Date.now();
                        self.__talonYouTubeWatchPlayerResponseSanitized = true;
                        self.__talonYouTubeWatchPlayerResponseSanitizedAt = Date.now();
                        self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetAt =
                            self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetAt || Date.now();
                        self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetPerfMs =
                            typeof self.performance?.now === 'function'
                                ? Number(self.performance.now())
                                : 0;
                        self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetSummary =
                            envelopeSummary(activeEnvelope);
                    }
                    if (name === 'ytInitialData') {
                        self.__talonYouTubeWatchBootstrapSanitized = true;
                        self.__talonYouTubeWatchBootstrapSanitizedAt = Date.now();
                    }
                    if (name === 'videoPlaybackUstreamerConfig') {
                        self.__talonYouTubeWatchPlayerBootstrapSanitized = true;
                        self.__talonYouTubeWatchPlayerBootstrapSanitizedAt = Date.now();
                    }
                },
            });
        };

        const decorateYtcfg = target => {
            if (target instanceof Object === false) { return null; }
            if (isPlainObject(target.data_) === false) {
                target.data_ = {};
            }
            target.data_ = currentProtection.freezeHeld
                ? mergeProtectedObject(target.data_, protectedYtcfg)
                : mergeProtectedObject(protectedYtcfg, target.data_);
            target.get = typeof target.get === 'function'
                ? target.get.bind(target)
                : ((key, fallback) =>
                    Object.prototype.hasOwnProperty.call(target.data_, key)
                        ? target.data_[key]
                        : fallback);
            target.has = typeof target.has === 'function'
                ? target.has.bind(target)
                : (key => Object.prototype.hasOwnProperty.call(target.data_, key));
            target.set = (keyOrMap, value) => {
                if (isPlainObject(keyOrMap)) {
                    const sanitized = sanitizeStructure(keyOrMap);
                    target.data_ = currentProtection.freezeHeld
                        ? mergeProtectedObject(sanitized, protectedYtcfg)
                        : mergeProtectedObject(target.data_, sanitized);
                } else if (typeof keyOrMap === 'string') {
                    const patch = { [keyOrMap]: sanitizeStructure(value) };
                    target.data_ = currentProtection.freezeHeld
                        ? mergeProtectedObject(patch, protectedYtcfg)
                        : mergeProtectedObject(target.data_, patch);
                }
                return true;
            };
            return target;
        };

        const decorateYtplayer = target => {
            if (target instanceof Object === false) { return null; }
            target.config = currentProtection.freezeHeld
                ? mergeProtectedObject(target.config, protectedPlayerConfig)
                : mergeProtectedObject(protectedPlayerConfig, target.config);
            return target;
        };

        installProtectedValue('moviePlayerResponse', protectedPlayerResponse);
        installProtectedValue('ytInitialPlayerResponse', protectedPlayerResponse);
        installProtectedValue('ytInitialData', protectedInitialData);
        installProtectedValue('videoPlaybackUstreamerConfig', protectedUstreamerConfig);

        Object.defineProperty(self, 'ytcfg', {
            configurable: true,
            enumerable: true,
            get() {
                if (ytcfgObject === null) {
                    ytcfgObject = decorateYtcfg({
                        data_: clone(protectedYtcfg),
                    });
                }
                return ytcfgObject;
            },
            set(nextValue) {
                const decorated = decorateYtcfg(nextValue);
                if (decorated !== null) {
                    ytcfgObject = decorated;
                }
            },
        });

        Object.defineProperty(self, 'ytplayer', {
            configurable: true,
            enumerable: true,
            get() {
                if (ytplayerObject === null) {
                    ytplayerObject = decorateYtplayer({
                        config: clone(protectedPlayerConfig),
                    });
                }
                return ytplayerObject;
            },
            set(nextValue) {
                const decorated = decorateYtplayer(nextValue);
                if (decorated !== null) {
                    ytplayerObject = decorated;
                }
            },
        });

        self.__talonYouTubeWatchPlayerResponseSeen = true;
        self.__talonYouTubeWatchPlayerResponseSeenAt = Date.now();
        self.__talonYouTubeWatchPlayerResponseSanitized = true;
        self.__talonYouTubeWatchPlayerResponseSanitizedAt = Date.now();
        self.__talonYouTubeWatchBootstrapSanitized = true;
        self.__talonYouTubeWatchBootstrapSanitizedAt = Date.now();
        self.__talonYouTubeWatchPlayerBootstrapSeen = true;
        self.__talonYouTubeWatchPlayerBootstrapSeenAt = Date.now();
        self.__talonYouTubeWatchPlayerBootstrapSanitized = true;
        self.__talonYouTubeWatchPlayerBootstrapSanitizedAt = Date.now();
        self.__talonYouTubeWatchPlayerBootstrapFirstReport = envelopeSummary(activeEnvelope);
        self.__talonYouTubeWatchPlayerBootstrapLastReport = envelopeSummary(activeEnvelope);
        self.__talonYouTubeWatchPrefetchedPlayerResponseAvailable = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponseApplied = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedAt = Date.now();
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedVideoId = currentVideoId;
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedSource = envelopeSource;
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedSummary =
            envelopeSummary(activeEnvelope);

        const originalDefineProperty = Object.defineProperty;
        const originalReflectDefineProperty =
            typeof Reflect?.defineProperty === 'function'
                ? Reflect.defineProperty.bind(Reflect)
                : null;
        const patchedDefineProperty = (target, property, descriptor) => {
            if (
                currentProtection.freezeHeld &&
                target === self &&
                protectedKeySet.has(String(property))
            ) {
                return target;
            }
            return originalDefineProperty(target, property, descriptor);
        };
        Object.defineProperty = patchedDefineProperty;
        if (originalReflectDefineProperty !== null) {
            Reflect.defineProperty = (target, property, descriptor) => {
                if (
                    currentProtection.freezeHeld &&
                    target === self &&
                    protectedKeySet.has(String(property))
                ) {
                    return true;
                }
                return originalReflectDefineProperty(target, property, descriptor);
            };
        }
        restoreDefineProperty = () => {
            Object.defineProperty = originalDefineProperty;
            if (originalReflectDefineProperty !== null) {
                Reflect.defineProperty = originalReflectDefineProperty;
            }
            restoreDefineProperty = undefined;
        };
    }

    persistRuntimeState();

    const attemptOriginServiceWorkerRecovery = () => {
        const recoveryWork = (async () => {
            const deadline = Date.now() + SERVICE_WORKER_RECOVERY_TIMEOUT_MS;
            let attempted = false;
            let changed = false;
            while (Date.now() <= deadline && attempted === false) {
                const serviceWorker = self.navigator?.serviceWorker;
                if (typeof serviceWorker?.getRegistrations === 'function') {
                    const registrations = await serviceWorker.getRegistrations();
                    for (const registration of registrations) {
                        const scope = typeof registration?.scope === 'string'
                            ? registration.scope
                            : '';
                        if (scope === '' || scope.startsWith(WATCH_ORIGIN) === false) { continue; }
                        attempted = true;
                        try {
                            changed = (await registration.unregister()) === true || changed;
                        } catch {
                        }
                    }
                    if (attempted === true) { break; }
                }
                await new Promise(resolve => {
                    self.setTimeout(resolve, SERVICE_WORKER_RECOVERY_POLL_MS);
                });
            }
            return {
                attempted,
                changed,
                timedOut: false,
                error: '',
            };
        })().catch(error => ({
            attempted: true,
            changed: false,
            timedOut: false,
            error: error instanceof Error ? error.message : String(error),
        }));
        const timeoutWork = new Promise(resolve => {
            self.setTimeout(() => resolve({
                attempted: true,
                changed: false,
                timedOut: true,
                error: 'timeout',
            }), SERVICE_WORKER_RECOVERY_TIMEOUT_MS);
        });
        return Promise.race([ recoveryWork, timeoutWork ]);
    };

    const waitForServiceWorkerRecoverySettle = result => new Promise(resolve => {
        if (result?.changed !== true) {
            resolve('unchanged');
            return;
        }
        let settled = false;
        const finish = reason => {
            if (settled) { return; }
            settled = true;
            resolve(reason);
        };
        try {
            const serviceWorker = self.navigator?.serviceWorker;
            if (typeof serviceWorker?.addEventListener === 'function') {
                serviceWorker.addEventListener('controllerchange', () => {
                    finish('controllerchange');
                }, { once: true });
            }
        } catch {
        }
        self.setTimeout(() => {
            finish('timeout');
        }, SERVICE_WORKER_RECOVERY_SETTLE_MS);
    });

    const recoveryUsedKey = '__td_yw_recovery_used';
    const scheduleRecovery = reason => {
        if (currentProtection.recoveryTriggered === true) { return false; }
        if (safeSessionStorageGet(recoveryUsedKey) === currentProtection.navigationKey) {
            return false;
        }
        currentProtection.recoveryTriggered = true;
        safeSessionStorageSet(recoveryUsedKey, currentProtection.navigationKey);
        diagnosticState.tinyRn1Recovered = true;
        diagnosticState.recoveryFallbackUsed = true;
        diagnosticState.recoveryReason = reason;
        self.__talonYouTubeWatchLateRecoveryTriggered = true;
        self.__talonYouTubeWatchLateRecoveryAt = Date.now();
        self.__talonYouTubeWatchLateRecoveryReason = reason;
        self.__talonYouTubeWatchLateRecoveryVideoId = currentVideoId;
        self.__talonYouTubeWatchArchitectureFallbackPathUsed = true;
        if (currentProtection.latestEnvelopeRaw !== '') {
            safeSessionStorageSet(CURRENT_ENVELOPE_KEY, currentProtection.latestEnvelopeRaw);
        }
        persistRuntimeState();
        void attemptOriginServiceWorkerRecovery()
            .then(async result => {
                diagnosticState.serviceWorkerRecoveryAttempted = result.attempted === true;
                diagnosticState.serviceWorkerRecoveryChanged = result.changed === true;
                diagnosticState.serviceWorkerRecoveryTimedOut = result.timedOut === true;
                diagnosticState.serviceWorkerRecoveryError =
                    typeof result.error === 'string' ? result.error : '';
                persistRuntimeState();
                await waitForServiceWorkerRecoverySettle(result);
            })
            .finally(() => {
            try {
                self.location.replace(currentWatchUrl || locationHref);
            } catch {
            }
        });
        return true;
    };

    const YOUTUBE_PLAYER_RECOVERY_USER_AGENT_VARIANTS = Object.freeze([
        'channel',
        'adunit',
        '',
    ]);
    const readInnertubeClient = () => {
        const candidates = [
            self.ytcfg?.data_?.INNERTUBE_CONTEXT?.client,
            self.ytcfg?.data?.INNERTUBE_CONTEXT?.client,
            self.ytcfg_?.INNERTUBE_CONTEXT?.client,
        ];
        for (const candidate of candidates) {
            if (isPlainObject(candidate)) { return candidate; }
        }
        return null;
    };
    const originalInnertubeUserAgent = (() => {
        const client = readInnertubeClient();
        return typeof client?.userAgent === 'string' ? client.userAgent : '';
    })();
    let playerRecoveryAttemptIndex = 0;
    let playerRecoveryPending = false;
    let playerRecoveryLastVideoId = '';
    let playerRecoveryConsumedAt = 0;
    const applyPlayerRecoveryUserAgentVariant = token => {
        const client = readInnertubeClient();
        if (client === null || originalInnertubeUserAgent === '') { return false; }
        const nextUserAgent = token === ''
            ? originalInnertubeUserAgent
            : originalInnertubeUserAgent.replace(
                /(Mozilla\/5\.0 \([^)]+)/,
                `$1; ${token}`
            );
        if (typeof nextUserAgent !== 'string' || nextUserAgent === '') { return false; }
        client.userAgent = nextUserAgent;
        return true;
    };
    const installOnAbnormalityDetectedGuard = () => {
        if (self.__talonYouTubeWatchAbnormalityGuardInstalled === true) { return; }
        const originalThen = self.Promise?.prototype?.then;
        if (typeof originalThen !== 'function') { return; }
        self.Promise.prototype.then = function(onFulfilled, onRejected) {
            const nextOnFulfilled =
                typeof onFulfilled === 'function' &&
                onFulfilled.toString().includes('onAbnormalityDetected')
                    ? function() {}
                    : onFulfilled;
            return Reflect.apply(originalThen, this, [ nextOnFulfilled, onRejected ]);
        };
        self.__talonYouTubeWatchAbnormalityGuardInstalled = true;
    };
    const installMoviePlayerRecovery = () => {
        if (self.__talonYouTubeWatchPlayerRecoveryInstalled === true) { return; }
        self.__talonYouTubeWatchPlayerRecoveryInstalled = true;
        const normalizeVisibleText = value =>
            typeof value === 'string'
                ? value.replace(/\s+/g, ' ').trim()
                : '';
        const isAntiAdblockOverlayText = value => {
            const normalized = normalizeVisibleText(value);
            if (normalized === '') { return false; }
            return YOUTUBE_ANTI_ADBLOCK_TEXT_MARKERS.every(marker => normalized.includes(marker));
        };
        const hideElement = element => {
            if (!(element instanceof self.Element)) { return false; }
            try {
                element.remove();
                return true;
            } catch {
            }
            try {
                element.setAttribute('hidden', 'hidden');
                element.style.setProperty('display', 'none', 'important');
                element.style.setProperty('visibility', 'hidden', 'important');
                element.style.setProperty('pointer-events', 'none', 'important');
                return true;
            } catch {
            }
            return false;
        };
        const findOverlayContainer = element => {
            if (!(element instanceof self.Element)) { return null; }
            const selector = [
                '#error-screen',
                '[role="dialog"]',
                'tp-yt-paper-dialog',
                'ytd-enforcement-message-view-model',
                'ytd-popup-container',
                'yt-playability-error-supported-renderers',
            ].join(',');
            const directContainer = element.closest?.(selector);
            if (directContainer instanceof self.Element) {
                return directContainer;
            }
            let current = element;
            let best = null;
            while (current instanceof self.Element) {
                const text = normalizeVisibleText(current.textContent || current.innerText || '');
                if (isAntiAdblockOverlayText(text)) {
                    best = current;
                }
                current = current.parentElement;
            }
            return best;
        };
        const removeAntiAdblockOverlayDom = () => {
            let removed = false;
            const selector = [
                '#error-screen',
                '[role="dialog"]',
                'tp-yt-paper-dialog',
                'ytd-enforcement-message-view-model',
                'ytd-popup-container',
                'yt-playability-error-supported-renderers',
                'button',
                'a',
            ].join(',');
            const nodes = self.document?.querySelectorAll?.(selector) || [];
            for (const node of nodes) {
                if (!(node instanceof self.Element)) { continue; }
                const text = normalizeVisibleText(node.textContent || node.innerText || '');
                if (
                    isAntiAdblockOverlayText(text) === false &&
                    text !== 'Allow YouTube Ads' &&
                    text !== 'Try YouTube Premium'
                ) {
                    continue;
                }
                const container = findOverlayContainer(node) || node;
                removed = hideElement(container) || removed;
            }
            if (removed) {
                self.__talonYouTubeWatchOverlayRemoved = true;
                self.__talonYouTubeWatchOverlayRemovedAt = Date.now();
            }
            return removed;
        };
        const readRawPlayerResponse = player => {
            if (!(player instanceof Object)) { return null; }
            const originalReader =
                typeof player.__talonOriginalGetPlayerResponse === 'function'
                    ? player.__talonOriginalGetPlayerResponse
                    : null;
            const response = originalReader
                ? originalReader()
                : player.getPlayerResponse?.();
            return isPlainObject(response) ? response : null;
        };
        const syncRecoveredRawPlayerResponse = repairedResponse => {
            if (isPlainObject(repairedResponse) === false) { return ''; }
            let rawPlayerResponse = '';
            try {
                rawPlayerResponse = JSON.stringify(repairedResponse);
            } catch {
                return '';
            }
            try {
                self.moviePlayerResponse = repairedResponse;
            } catch {
            }
            try {
                self.ytInitialPlayerResponse = repairedResponse;
            } catch {
            }
            const ytcfgBags = [
                self.ytcfg?.data_,
                self.ytcfg?.data,
                self.ytcfg_,
            ];
            for (const bag of ytcfgBags) {
                if (isPlainObject(bag) === false) { continue; }
                if (isPlainObject(bag.PLAYER_VARS) === false) {
                    bag.PLAYER_VARS = {};
                }
                bag.PLAYER_VARS.raw_player_response = rawPlayerResponse;
                if (isPlainObject(bag.WEB_PLAYER_CONTEXT_CONFIGS)) {
                    for (const entryValue of Object.values(bag.WEB_PLAYER_CONTEXT_CONFIGS)) {
                        if (isPlainObject(entryValue) === false) { continue; }
                        entryValue.raw_player_response = rawPlayerResponse;
                    }
                }
            }
            if (self.ytplayer instanceof Object) {
                if (isPlainObject(self.ytplayer.config) === false) {
                    self.ytplayer.config = {};
                }
                if (isPlainObject(self.ytplayer.config.args) === false) {
                    self.ytplayer.config.args = {};
                }
                self.ytplayer.config.args.raw_player_response = rawPlayerResponse;
            }
            self.__talonYouTubeWatchPlayerResponseRecovered = true;
            self.__talonYouTubeWatchPlayerResponseRecoveredAt = Date.now();
            return rawPlayerResponse;
        };
        const installRecoveredPlayerResponse = (player, response) => {
            if (!(player instanceof Object) || isPlainObject(response) === false) { return false; }
            const repairedResponse = sanitizeStructure(clone(response));
            if (isPlainObject(repairedResponse) === false) { return false; }
            const rawPlayerResponse = syncRecoveredRawPlayerResponse(repairedResponse);
            for (const key of YOUTUBE_PLAYER_RESPONSE_CACHE_KEYS) {
                try {
                    player[key] = repairedResponse;
                } catch {
                }
            }
            if (
                typeof player.getPlayerResponse === 'function' &&
                typeof player.__talonOriginalGetPlayerResponse !== 'function'
            ) {
                player.__talonOriginalGetPlayerResponse = player.getPlayerResponse.bind(player);
            }
            player.getPlayerResponse = () => repairedResponse;
            player.__talonRecoveredPlayerResponse = repairedResponse;
            player.__talonRecoveredRawPlayerResponse = rawPlayerResponse;
            playerRecoveryConsumedAt = Date.now();
            self.__talonYouTubeWatchPlayerRecoveryConsumed = true;
            self.__talonYouTubeWatchPlayerRecoveryConsumedAt = playerRecoveryConsumedAt;
            return true;
        };
        const forceRecoveredPlayback = player => {
            let attempted = false;
            if (player instanceof Object && typeof player.playVideo === 'function') {
                attempted = true;
                try {
                    player.playVideo();
                } catch {
                }
            }
            const video = self.document?.querySelector?.('video');
            if (video instanceof self.HTMLVideoElement) {
                attempted = true;
                try {
                    const playPromise = video.play?.();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(() => {});
                    }
                } catch {
                }
            }
            if (attempted) {
                self.__talonYouTubeWatchForcePlayAttempted = true;
                self.__talonYouTubeWatchForcePlayAttemptedAt = Date.now();
            }
            return attempted;
        };
        const consumeRecoveredPlayerState = player => {
            if (!(player instanceof Object)) { return false; }
            const response = readRawPlayerResponse(player);
            if (hasPlayableStreamingData(response) === false) { return false; }
            if (isPlayerResponseOk(response) === false) { return false; }
            const installed = installRecoveredPlayerResponse(player, response);
            const overlayRemoved = removeAntiAdblockOverlayDom();
            const playAttempted = forceRecoveredPlayback(player);
            return installed || overlayRemoved || playAttempted;
        };
        const attemptPlayerRecovery = () => {
            if (playerRecoveryPending === true) { return false; }
            const player = self.document?.getElementById?.('movie_player');
            if (!(player instanceof Object) || typeof player.loadVideoById !== 'function') {
                return false;
            }
            const response = readRawPlayerResponse(player) || self.moviePlayerResponse || self.ytInitialPlayerResponse;
            if (hasPlayableStreamingData(response) === false) { return false; }
            if (isPlayerResponseOk(response) === true) { return false; }
            const videoId = typeof response?.videoDetails?.videoId === 'string' && response.videoDetails.videoId !== ''
                ? response.videoDetails.videoId
                : currentVideoId;
            if (videoId === '') { return false; }
            const variant = YOUTUBE_PLAYER_RECOVERY_USER_AGENT_VARIANTS[playerRecoveryAttemptIndex] ?? '';
            playerRecoveryAttemptIndex = Math.min(
                playerRecoveryAttemptIndex + 1,
                YOUTUBE_PLAYER_RECOVERY_USER_AGENT_VARIANTS.length
            );
            applyPlayerRecoveryUserAgentVariant(variant);
            playerRecoveryPending = true;
            playerRecoveryLastVideoId = videoId;
            self.__talonYouTubeWatchPlayerRecoveryAttempted = true;
            self.__talonYouTubeWatchPlayerRecoveryAttemptedAt = Date.now();
            self.__talonYouTubeWatchPlayerRecoveryAttemptedVideoId = videoId;
            self.__talonYouTubeWatchPlayerRecoveryUserAgentVariant = variant;
            self.__talonYouTubeWatchPlayerRecoveryResponseHash =
                typeof response === 'object' && response !== null
                    ? JSON.stringify(response).slice(0, 256)
                    : '';
            try {
                player.loadVideoById(
                    videoId,
                    response?.playerConfig?.playbackStartConfig?.startSeconds ?? 0
                );
            } catch {
                playerRecoveryPending = false;
                return false;
            }
            self.setTimeout(() => {
                playerRecoveryPending = false;
            }, PLAYER_RECOVERY_SETTLE_MS);
            return true;
        };
        const monitorPlayerRecovery = () => {
            const player = self.document?.getElementById?.('movie_player');
            consumeRecoveredPlayerState(player);
            const video = self.document?.querySelector?.('video');
            if (video instanceof HTMLVideoElement && video.readyState >= 3 && video.currentTime > 0.1) {
                applyPlayerRecoveryUserAgentVariant('');
                return;
            }
            if (Date.now() - playerRecoveryConsumedAt < PLAYER_RECOVERY_SETTLE_MS) {
                return;
            }
            if (playerRecoveryAttemptIndex >= YOUTUBE_PLAYER_RECOVERY_USER_AGENT_VARIANTS.length) {
                return;
            }
            const response = readRawPlayerResponse(player);
            const responseVideoId =
                typeof response?.videoDetails?.videoId === 'string' ? response.videoDetails.videoId : '';
            if (
                responseVideoId !== '' &&
                responseVideoId !== playerRecoveryLastVideoId &&
                isPlayerResponseOk(response) === true
            ) {
                applyPlayerRecoveryUserAgentVariant('');
                return;
            }
            attemptPlayerRecovery();
        };
        if (self.document?.readyState === 'loading') {
            self.document.addEventListener('DOMContentLoaded', monitorPlayerRecovery, { once: true });
        } else {
            monitorPlayerRecovery();
        }
        const observer = new self.MutationObserver(() => {
            monitorPlayerRecovery();
        });
        observer.observe(self.document, { childList: true, subtree: true });
    };
    installOnAbnormalityDetectedGuard();
    installMoviePlayerRecovery();

    const observePlaybackProgress = () => {
        const video = self.document?.querySelector?.('video');
        if (!(video instanceof HTMLVideoElement)) { return false; }
        if (video.readyState >= 3 && video.currentTime > 0.1) {
            currentProtection.playbackProgressSeen = true;
            releaseFreeze('playback-progress');
            return true;
        }
        return false;
    };

    if (typeof self.PerformanceObserver === 'function') {
        try {
            const observer = new self.PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    if (typeof entry?.name !== 'string' || entry.name.includes('videoplayback') === false) {
                        continue;
                    }
                    let entryUrl;
                    try {
                        entryUrl = new URL(entry.name);
                    } catch {
                        continue;
                    }
                    if ((entryUrl.searchParams.get('rn') || '') !== '1') { continue; }
                    const size = Number(entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0);
                    if (size <= TINY_RN1_MAX_BYTES && currentProtection.firstTinyRn1AtEpochMs === 0) {
                        currentProtection.firstTinyRn1AtEpochMs = Date.now();
                        currentProtection.firstTinyRn1Bytes = size;
                        persistRuntimeState();
                        self.setTimeout(() => {
                            if (currentProtection.firstSubstantiveRn1AtEpochMs !== 0) { return; }
                            scheduleRecovery('tiny-rn1');
                        }, 0);
                    }
                    if (size >= SUBSTANTIVE_RN1_MIN_BYTES && currentProtection.firstSubstantiveRn1AtEpochMs === 0) {
                        currentProtection.firstSubstantiveRn1AtEpochMs = Date.now();
                        currentProtection.firstSubstantiveRn1Bytes = size;
                        releaseFreeze('rn1-substantive');
                        persistRuntimeState();
                    }
                }
            });
            observer.observe({ type: 'resource', buffered: true });
        } catch {
        }
    }

    const progressTimer = self.setInterval(() => {
        if (observePlaybackProgress()) {
            self.clearInterval(progressTimer);
        }
    }, 150);

    self.setTimeout(() => {
        try {
            self.clearInterval(progressTimer);
        } catch {
        }
        if (currentProtection.firstSubstantiveRn1AtEpochMs !== 0) { return; }
        if (currentProtection.playbackProgressSeen === true) { return; }
        if (currentProtection.firstTinyRn1AtEpochMs !== 0) {
            scheduleRecovery('tiny-rn1-timeout');
            return;
        }
        scheduleRecovery('no-substantive-rn1');
    }, RECOVERY_DEADLINE_MS);

    self.setTimeout(() => {
        releaseFreeze(currentProtection.firstSubstantiveRn1AtEpochMs !== 0
            ? 'rn1-substantive'
            : 'timeout');
    }, MAX_FREEZE_MS);

    self.addEventListener('pagehide', () => {
        if (currentProtection.freezeHeld) {
            releaseFreeze('pagehide');
        }
    }, { once: true });

})();

void 0;
