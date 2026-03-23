// Targeted YouTube watch-page sanitizer.
// This runs before page scripts and owns the current request/response
// compatibility workarounds needed for desktop watch playback.
(function talonYouTubeWatchSanitizer() {
    const SANITIZER_HEALTH_SESSION_KEY = '__td_yw_sanitizer_health';
    const persistSanitizerHealth = patch => {
        if ( patch === null || typeof patch !== 'object' ) { return; }
        try {
            const previous = self.__talonYouTubeWatchSanitizerHealth &&
                typeof self.__talonYouTubeWatchSanitizerHealth === 'object'
                ? self.__talonYouTubeWatchSanitizerHealth
                : {};
            const next = {
                ...previous,
                ...patch,
                updatedAt: Date.now(),
            };
            self.__talonYouTubeWatchSanitizerHealth = next;
            self.sessionStorage?.setItem(SANITIZER_HEALTH_SESSION_KEY, JSON.stringify(next));
        } catch {}
    };
    const markSanitizerFatal = reason => {
        const message = `${reason}`;
        self.__talonYouTubeWatchSanitizerFatalError = message;
        self.__talonYouTubeWatchSanitizerFatalAt = Date.now();
        persistSanitizerHealth({
            stage: 'fatal',
            fatalError: message,
            fatalAt: self.__talonYouTubeWatchSanitizerFatalAt,
        });
    };
    persistSanitizerHealth({
        stage: 'started',
        startedAt: Date.now(),
    });
    try {
    const WATCH_BOOT_COOKIE = 'td_yw_boot';
    const FOLLOWUP_ENTRY_STRATEGY_COOKIE = 'td_yw_arch';
    const PLAYER_REWRITE_MODE_COOKIE = 'td_yw_rw';
    const RUNTIME_LANE_COOKIE = 'td_yw_lane';
    const OWNER_PROFILE_COOKIE = 'td_yw_owner';
    const OWNER_PROFILE_TALON_CURRENT = 'talon-current';
    const OWNER_PROFILE_UPSTREAM_CORE = 'upstream-core';
    const OWNER_PROFILE_UPSTREAM_CORE_TALON_WINS = 'upstream-core+talon-wins';
    const UPSTREAM_REFERENCE_SNAPSHOT = '2026.322.1735';
    const FOLLOWUP_ENTRY_STRATEGY_BASELINE = 'baseline';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_A = 'track-a-controlled-entry';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT = 'track-a-same-origin-commit';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM = 'track-a-prewarm-pool';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE = 'track-a-exact-anchor-intent-lease';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER = 'track-a-exact-target-donor-tab-owner';
    const FOLLOWUP_ENTRY_STRATEGY_TRACK_B = 'track-b-background-relay';
    const PLAYER_REWRITE_MODE_OFF = 'off';
    const PLAYER_REWRITE_MODE_PLAYER = 'player';
    const PLAYER_REWRITE_MODE_PLAYER_BOOTSTRAP = 'player+bootstrap';
    const RUNTIME_LANE_BASELINE = 'baseline';
    const RUNTIME_LANE_TRANSPORT_SMOOTH = 'transport-smooth';
    const RUNTIME_LANE_BOOTSTRAP_OWNER = 'bootstrap-owner';
    const RUNTIME_LANE_USTREAMER_FLAG_PATCH = 'ustreamer-flag-patch';
    const RUNTIME_LANE_USTREAMER_RN1_36 = 'ustreamer-rn1-36';
    const RUNTIME_LANE_USTREAMER_RN1_39 = 'ustreamer-rn1-39';
    const RUNTIME_LANE_USTREAMER_RN1_155 = 'ustreamer-rn1-155';
    const RUNTIME_LANE_USTREAMER_RN1_278 = 'ustreamer-rn1-278';
    const RUNTIME_LANE_USTREAMER_RN1_36_39 = 'ustreamer-rn1-36-39';
    const RUNTIME_LANE_USTREAMER_RN1_155_278 = 'ustreamer-rn1-155-278';
    const USTREAMER_RN1_EXACT_PATCH_LANES = new Set([
        RUNTIME_LANE_USTREAMER_RN1_36,
        RUNTIME_LANE_USTREAMER_RN1_39,
        RUNTIME_LANE_USTREAMER_RN1_155,
        RUNTIME_LANE_USTREAMER_RN1_278,
        RUNTIME_LANE_USTREAMER_RN1_36_39,
        RUNTIME_LANE_USTREAMER_RN1_155_278,
    ]);
    const readWatchBootstrapCookie = () => {
        const cookieSource = typeof document?.cookie === 'string'
            ? document.cookie
            : '';
        if ( cookieSource === '' ) { return ''; }
        const needle = `${WATCH_BOOT_COOKIE}=`;
        for ( const part of cookieSource.split(/;\s*/) ) {
            if ( part.startsWith(needle) ) {
                return part.slice(needle.length).trim();
            }
        }
        return '';
    };
    const readNamedCookie = name => {
        if ( typeof name !== 'string' || name === '' ) { return ''; }
        const cookieSource = typeof document?.cookie === 'string'
            ? document.cookie
            : '';
        if ( cookieSource === '' ) { return ''; }
        const needle = `${name}=`;
        for ( const part of cookieSource.split(/;\s*/) ) {
            if ( part.startsWith(needle) ) {
                return part.slice(needle.length).trim();
            }
        }
        return '';
    };
    const readFollowupEntryStrategy = () => {
        const raw = readNamedCookie(FOLLOWUP_ENTRY_STRATEGY_COOKIE);
        switch ( raw ) {
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_A:
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT:
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM:
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE:
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER:
        case FOLLOWUP_ENTRY_STRATEGY_TRACK_B:
        case FOLLOWUP_ENTRY_STRATEGY_BASELINE:
            return raw;
        default:
            return FOLLOWUP_ENTRY_STRATEGY_BASELINE;
        }
    };
    const readPlayerRewriteMode = () => {
        const raw = readNamedCookie(PLAYER_REWRITE_MODE_COOKIE);
        switch ( raw ) {
        case PLAYER_REWRITE_MODE_PLAYER:
        case PLAYER_REWRITE_MODE_PLAYER_BOOTSTRAP:
        case PLAYER_REWRITE_MODE_OFF:
            return raw;
        default:
            return PLAYER_REWRITE_MODE_OFF;
        }
    };
    const readRuntimeLane = () => {
        const raw = readNamedCookie(RUNTIME_LANE_COOKIE);
        switch ( raw ) {
        case RUNTIME_LANE_TRANSPORT_SMOOTH:
        case RUNTIME_LANE_BOOTSTRAP_OWNER:
        case RUNTIME_LANE_USTREAMER_FLAG_PATCH:
        case RUNTIME_LANE_USTREAMER_RN1_36:
        case RUNTIME_LANE_USTREAMER_RN1_39:
        case RUNTIME_LANE_USTREAMER_RN1_155:
        case RUNTIME_LANE_USTREAMER_RN1_278:
        case RUNTIME_LANE_USTREAMER_RN1_36_39:
        case RUNTIME_LANE_USTREAMER_RN1_155_278:
        case RUNTIME_LANE_BASELINE:
            return raw;
        default:
            return RUNTIME_LANE_BASELINE;
        }
    };
    const readOwnerProfile = () => {
        const raw = readNamedCookie(OWNER_PROFILE_COOKIE);
        switch ( raw ) {
        case OWNER_PROFILE_UPSTREAM_CORE:
        case OWNER_PROFILE_UPSTREAM_CORE_TALON_WINS:
        case OWNER_PROFILE_TALON_CURRENT:
            return raw;
        default:
            return OWNER_PROFILE_TALON_CURRENT;
        }
    };
    const getOwnerProfileConfig = profile => {
        switch ( profile ) {
        case OWNER_PROFILE_UPSTREAM_CORE:
            return {
                activeUpstreamTacticFamilies: [
                    'trusted-prevent-dom-bypass',
                    'window-fetch-neutralizer',
                    'player-request-mutators',
                    'player-response-prune-replace',
                ],
                retainedTalonWinFamilies: [
                    'followup-diagnostics',
                ],
                disabledTalonOverlapFamilies: [
                    'inline-player-response-sanitizer',
                    'get-watch-response-sanitizer',
                    'player-bootstrap-owner',
                ],
                enableWindowFetchNeutralizer: true,
                enableInlinePlayerResponseSanitizer: false,
                enableGetWatchResponseSanitizer: false,
                enableTalonPlayerBootstrapOwner: false,
            };
        case OWNER_PROFILE_UPSTREAM_CORE_TALON_WINS:
            return {
                activeUpstreamTacticFamilies: [
                    'trusted-prevent-dom-bypass',
                    'window-fetch-neutralizer',
                    'player-request-mutators',
                    'player-response-prune-replace',
                ],
                retainedTalonWinFamilies: [
                    'inline-player-response-sanitizer',
                    'get-watch-response-sanitizer',
                    'player-bootstrap-owner',
                    'followup-diagnostics',
                ],
                disabledTalonOverlapFamilies: [],
                enableWindowFetchNeutralizer: true,
                enableInlinePlayerResponseSanitizer: true,
                enableGetWatchResponseSanitizer: true,
                enableTalonPlayerBootstrapOwner: true,
            };
        default:
            return {
                activeUpstreamTacticFamilies: [],
                retainedTalonWinFamilies: [
                    'inline-player-response-sanitizer',
                    'get-watch-response-sanitizer',
                    'followup-diagnostics',
                ],
                disabledTalonOverlapFamilies: [],
                enableWindowFetchNeutralizer: false,
                enableInlinePlayerResponseSanitizer: true,
                enableGetWatchResponseSanitizer: true,
                enableTalonPlayerBootstrapOwner: false,
            };
        }
    };
    const watchBootstrapCookie = readWatchBootstrapCookie();
    const followupEntryStrategy = readFollowupEntryStrategy();
    const playerRewriteMode = readPlayerRewriteMode();
    const runtimeLane = readRuntimeLane();
    const ownerProfile = readOwnerProfile();
    const ownerProfileConfig = getOwnerProfileConfig(ownerProfile);
    if ( watchBootstrapCookie === '0' ) {
        persistSanitizerHealth({
            stage: 'disabled-by-cookie',
        });
        return;
    }
    if ( self.__talonYouTubeWatchSanitizer === true ) {
        persistSanitizerHealth({
            stage: 'already-installed',
        });
        return;
    }
    self.__talonYouTubeWatchSanitizer = true;
    self.__talonYouTubeWatchSanitizerExecutedAt = Date.now();
    self.__talonYouTubeWatchSanitizerExecutedPerfMs =
        self.performance && typeof self.performance.now === 'function'
            ? self.performance.now()
            : 0;
    self.__talonYouTubeWatchOwnerProfile = ownerProfile;
    self.__talonYouTubeWatchUpstreamReferenceSnapshot = UPSTREAM_REFERENCE_SNAPSHOT;
    self.__talonYouTubeWatchActiveUpstreamTacticFamilies =
        ownerProfileConfig.activeUpstreamTacticFamilies.slice();
    self.__talonYouTubeWatchRetainedTalonWinFamilies =
        ownerProfileConfig.retainedTalonWinFamilies.slice();
    self.__talonYouTubeWatchDisabledTalonOverlapFamilies =
        ownerProfileConfig.disabledTalonOverlapFamilies.slice();
    self.__talonYouTubeWatchRewriteMode = playerRewriteMode;
    self.__talonYouTubeWatchRuntimeLane = runtimeLane;
    persistSanitizerHealth({
        stage: 'executed',
        executedAt: self.__talonYouTubeWatchSanitizerExecutedAt,
        executedPerfMs: self.__talonYouTubeWatchSanitizerExecutedPerfMs,
        ownerProfile,
        upstreamReferenceSnapshot: UPSTREAM_REFERENCE_SNAPSHOT,
        activeUpstreamTacticFamilies: ownerProfileConfig.activeUpstreamTacticFamilies,
        retainedTalonWinFamilies: ownerProfileConfig.retainedTalonWinFamilies,
        disabledTalonOverlapFamilies: ownerProfileConfig.disabledTalonOverlapFamilies,
        followupEntryStrategy,
        playerRewriteMode,
        runtimeLane,
    });
    self.__talonYouTubeWatchEntryStrategy = followupEntryStrategy;

    const DROP_KEYS = new Set([
        'adSlots',
        'adSlotsCount',
        'playerAds',
        'adBreakHeartbeatParams',
        'no_ads',
    ]);
    const INLINE_DROP_KEYS = new Set([
        ...DROP_KEYS,
        'adPlacements',
        'adPlacementsCount',
    ]);
    const DROP_RENDERERS = new Set([
        'playerLegacyDesktopWatchAdsRenderer',
        'adPlacementRenderer',
        'clientForecastingAdRenderer',
        'adBreakServiceRenderer',
        'adSlotRenderer',
        'playerBytesAdLayoutRenderer',
        'playerBytesSequentialLayoutRenderer',
        'aboveFeedAdLayoutRenderer',
        'instreamVideoAdRenderer',
        'inPlayerAdLayoutRenderer',
        'adPreviewViewModel',
        'adImageViewModel',
        'adAvatarLockupViewModel',
        'adAvatarViewModel',
        'adDetailsLineViewModel',
        'adButtonViewModel',
        'visitAdvertiserLinkViewModel',
        'topBannerImageTextIconButtonedLayoutViewModel',
        'adPodIndexViewModel',
        'skipAdViewModel',
        'skipAdButtonViewModel',
        'playerAdAvatarLockupCardButtonedViewModel',
        'adBadgeViewModel',
        'adDurationRemainingRenderer',
        'adHoverTextButtonRenderer',
        'aboutThisAdRenderer',
        'adsEngagementPanelContentRenderer',
    ]);
    const PLAYER_SANITIZE_RESPONSE_RE = /\/youtubei\/v1\/player\?prettyPrint=false(?:$|&)|\/player\?prettyPrint=false(?:$|&)/;
    const GET_WATCH_SANITIZE_RESPONSE_RE = /\/youtubei\/v1\/get_watch\?prettyPrint=false(?:$|&)|\/get_watch\?prettyPrint=false(?:$|&)/;
    const PLAYER_REQUEST_RE = /\/youtubei\/v1\/player\?prettyPrint=false(?:$|&)|\/player\?prettyPrint=false(?:$|&)/;
    const PAGEAD_ID_RE = /^(?:https?:)?\/\/googleads\.g\.doubleclick\.net\/pagead\/id(?:[/?#]|$)/i;
    const QOE_RE = /^(?:https?:)?\/\/www\.youtube\.com\/api\/stats\/qoe(?:[/?#]|$)/i;
    const PTRACKING_RE = /^(?:https?:)?\/\/www\.youtube\.com\/ptracking(?:[/?#]|$)/i;
    const VIEWTHROUGH_RE = /^(?:https?:)?\/\/www\.youtube\.com\/pagead\/viewthroughconversion(?:[/?#]|$)/i;
    const USER_LIST_RE = /^(?:https?:)?\/\/www\.google\.[^/]+\/pagead\/1p-user-list(?:[/?#]|$)/i;
    const LVZ_RE = /^(?:https?:)?\/\/www\.google\.[^/]+\/pagead\/lvz(?:[/?#]|$)/i;
    const AD_STATUS_RE = /^(?:https?:)?\/\/static\.doubleclick\.net\/instream\/ad_status\.js(?:[/?#]|$)/i;
    const LOG_EVENT_RE = /\/youtubei\/v1\/log_event(?:\?|$)|\/log_event(?:\?|$)/i;
    const NEXT_REQUEST_RE = /\/youtubei\/v1\/next\?prettyPrint=false(?:$|&)|\/next\?prettyPrint=false(?:$|&)/i;
    const WATCH_URL_RE = /^https:\/\/www\.youtube\.com\/watch\?/i;
    const GOOGLEVIDEO_HOST_RE = /(?:^|\.)googlevideo\.com$/i;
    const FOLLOWUP_WATCH_SESSION_KEY = '__td_yw_last_watch';
    const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_SESSION_KEY = '__td_yw_prefetched_pr_sections';
    const FOLLOWUP_NAV_DEBUG_SESSION_KEY = '__td_yw_followup_nav_debug';
    const FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY = '__td_yw_track_a_envelope';
    const FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY = '__td_yw_track_a_commit_envelope';
    const FOLLOWUP_COOKIE_CLEAR_REQUEST_EVENT = 'td-yw-followup-cookie-clear';
    const FOLLOWUP_COOKIE_CLEAR_RESPONSE_EVENT = 'td-yw-followup-cookie-clear-result';
    const FOLLOWUP_PREFETCH_REQUEST_EVENT = 'td-yw-followup-prefetch-sections';
    const FOLLOWUP_PREFETCH_RESPONSE_EVENT = 'td-yw-followup-prefetch-sections-result';
    const FOLLOWUP_PREFETCH_DONOR_CAPTURE_EVENT = 'td-yw-followup-prefetch-donor-capture';
    const FOLLOWUP_TAB_NAVIGATE_REQUEST_EVENT = 'td-yw-followup-tab-navigate';
    const FOLLOWUP_TAB_NAVIGATE_RESPONSE_EVENT = 'td-yw-followup-tab-navigate-result';
    const FOLLOWUP_NEXT_RELEASE_EVENT = 'td-yw-followup-next-release';
    const FOLLOWUP_ARCHITECTURE_REQUEST_EVENT = 'td-yw-followup-architecture-proof';
    const FOLLOWUP_ARCHITECTURE_RESPONSE_EVENT = 'td-yw-followup-architecture-proof-result';
    const REPLAY_POISON_FIRST_PAYLOAD_MAX_BYTES = 1024;
    const REPLAY_POISON_RECOVERY_DELAY_MS = 75;
    const REPLAY_POISON_RECOVERY_MODE = 'pause';
    const FOLLOWUP_NEXT_DELAY_TIMEOUT_MS = 30000;
    const FOLLOWUP_PRECLICK_RELEASE_TIMEOUT_MS = 4000;
    const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TIMEOUT_MS = 1500;
    const FOLLOWUP_BACKGROUND_PREFETCH_TIMEOUT_MS = 5000;
    const FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TTL_MS = 30000;
    const FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES = 1024;
    const FOLLOWUP_PRECLICK_TARGET_TTL_MS = 15000;
    const FOLLOWUP_PRECLICK_ANCHOR_STABLE_DELAY_MS = 75;
    const FOLLOWUP_DONOR_OWNER_POLL_INTERVAL_MS = 100;
    const FOLLOWUP_TRACK_A_PREWARM_SOURCE_VIDEO_ID = '48HUaf5Jenc';
    const FOLLOWUP_TRACK_A_PREWARM_TARGET_VIDEO_IDS = new Set([
        'FEPL1Ndjn7U',
        'xAiXGMvhfGs',
    ]);
    const PLAYER_RESPONSE_LITERAL_ANCHORS = Object.freeze([
        'var ytInitialPlayerResponse =',
        'window["ytInitialPlayerResponse"] =',
        'ytInitialPlayerResponse =',
    ]);
    const INITIAL_DATA_LITERAL_ANCHORS = Object.freeze([
        'var ytInitialData =',
        'window["ytInitialData"] =',
        'ytInitialData =',
    ]);
    const SHOULD_USE_EDGE_NEUTRAL_HOP =
        /\bEdg\//.test(typeof navigator?.userAgent === 'string' ? navigator.userAgent : '');
    const ENABLE_FORCED_WATCH_HARD_NAV = true;
    const ENABLE_UPSTREAM_WINDOW_FETCH_NEUTRALIZER =
        ownerProfileConfig.enableWindowFetchNeutralizer === true;
    const ENABLE_INLINE_PLAYER_RESPONSE_SANITIZER =
        ownerProfileConfig.enableInlinePlayerResponseSanitizer === true;
    const ENABLE_TRANSPORT_SMOOTHING = runtimeLane === RUNTIME_LANE_TRANSPORT_SMOOTH;
    const ENABLE_USTREAMER_FLAG_PATCH = runtimeLane === RUNTIME_LANE_USTREAMER_FLAG_PATCH;
    const ENABLE_USTREAMER_RN1_EXACT_PATCH =
        USTREAMER_RN1_EXACT_PATCH_LANES.has(runtimeLane);
    const ENABLE_USTREAMER_REQUEST_PATCH =
        ENABLE_USTREAMER_FLAG_PATCH ||
        ENABLE_USTREAMER_RN1_EXACT_PATCH;
    const ENABLE_PLAYER_BOOTSTRAP_OWNER =
        runtimeLane === RUNTIME_LANE_BOOTSTRAP_OWNER ||
        ENABLE_USTREAMER_REQUEST_PATCH ||
        ownerProfileConfig.enableTalonPlayerBootstrapOwner === true;
    const ENABLE_RESPONSE_SANITIZER =
        playerRewriteMode === PLAYER_REWRITE_MODE_PLAYER ||
        playerRewriteMode === PLAYER_REWRITE_MODE_PLAYER_BOOTSTRAP;
    const ENABLE_GET_WATCH_RESPONSE_SANITIZER =
        ownerProfileConfig.enableGetWatchResponseSanitizer === true;
    const ENABLE_BOOTSTRAP_ALIGNMENT =
        ENABLE_INLINE_PLAYER_RESPONSE_SANITIZER &&
        playerRewriteMode === PLAYER_REWRITE_MODE_PLAYER_BOOTSTRAP;
    const ENABLE_PLAYER_REQUEST_PATCH = false;
    const ENABLE_AD_ENDPOINT_DOM_STUBS = false;
    const ENABLE_AD_ENDPOINT_FETCH_STUBS = ENABLE_TRANSPORT_SMOOTHING;
    const ENABLE_AD_MEDIA_FETCH_STUBS = false;
    // Let watch-page XHR ad endpoints resolve as fast no-op responses instead
    // of hard network failures. Current YouTube builds can fall into a slower
    // media retry path when pagead/log_event XHRs are blocked outright.
    const ENABLE_AD_ENDPOINT_XHR_STUBS = ENABLE_TRANSPORT_SMOOTHING;
    const ENABLE_PAGEHIDE_TEARDOWN = false;
    const ENABLE_SIDEBAR_PREVIEW_GUARDS = false;
    // The legacy upstream quick-fix appended #reloadxhr across a broad set of
    // watch-player userAgent markers. On current desktop sidebar navigations
    // that can push the player into a slower retry loop before content starts.
    // Keep the reload rewrite only for clearly ad-scoped requests.
    const PLAYER_REFERER_RELOAD_RE = /adunit|instream/i;
    const STUB_HEADER_TEXT = 'cache-control: no-cache\r\ncontent-type: application/json; charset=utf-8\r\n';
    const STUB_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const STUB_PIXEL_URL = 'data:image/gif;base64,R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=';
    const MAIN_PLAYER_AD_SELECTOR =
        '.ytp-ad-image-overlay,' +
        '.ytp-ad-module,' +
        '.ytp-ad-player-overlay,' +
        '.ytp-ad-simple-ad-badge';
    const SPA_AD_FALLBACK_DELAYS_MS = [ 0, 75, 250, 750, 1500, 3000, 5000 ];
    const SIDEBAR_SPA_HARD_NAV_PLAYABLE_GRACE_MS = 3000;
    let pendingSidebarSpaWatchUrl = '';
    let pendingSidebarSpaFallbackToken = 0;
    let pendingFollowupCookieClearToken = 0;
    let pendingFollowupNavigationPreparation = null;
    let pendingFollowupArchitectureTargetUrl = '';
    const pendingTrackAPrewarmTargetUrls = new Set();
    const trackAIntentLeaseTargets = new Map();
    const trackADonorOwnerTargets = new Map();
    const pendingPreclickAnchorExposureTimers = new Map();
    let followupNextSuppressionUntilEpochMs = 0;
    let followupNextSuppressionTargetUrl = '';
    const getSanitizeMode = url => {
        if ( typeof url !== 'string' ) { return ''; }
        if ( ENABLE_RESPONSE_SANITIZER && PLAYER_SANITIZE_RESPONSE_RE.test(url) ) {
            return 'player';
        }
        if ( ENABLE_GET_WATCH_RESPONSE_SANITIZER && GET_WATCH_SANITIZE_RESPONSE_RE.test(url) ) {
            return 'get_watch';
        }
        return '';
    };
    const shouldPatchPlayerRequest = url =>
        ENABLE_PLAYER_REQUEST_PATCH && typeof url === 'string' && PLAYER_REQUEST_RE.test(url);
    const shouldStubPageadId = url => typeof url === 'string' && PAGEAD_ID_RE.test(url);
    const shouldStubLogEvent = url => typeof url === 'string' && LOG_EVENT_RE.test(url);
    const shouldSuppressPendingFollowupNextRequest = url =>
        typeof url === 'string' &&
        NEXT_REQUEST_RE.test(url) &&
        followupNextSuppressionTargetUrl !== '' &&
        Date.now() <= followupNextSuppressionUntilEpochMs;
    const shouldDelayFollowupNextRequest = url =>
        followupWatchNavigationState.isFollowupNavigation === true &&
        typeof url === 'string' &&
        NEXT_REQUEST_RE.test(url);
    const shouldStubNoContent = url =>
        typeof url === 'string' && (PTRACKING_RE.test(url) || VIEWTHROUGH_RE.test(url));
    const shouldStubPixelImage = url =>
        typeof url === 'string' && (USER_LIST_RE.test(url) || LVZ_RE.test(url));
    const shouldStubAdStatusScript = url => typeof url === 'string' && AD_STATUS_RE.test(url);
    const shouldStubAdMediaFetch = url => {
        if ( typeof url !== 'string' || url === '' ) { return false; }
        let parsed;
        try {
            parsed = new URL(url, location.href);
        } catch {
            return false;
        }
        if ( GOOGLEVIDEO_HOST_RE.test(parsed.hostname) === false ) { return false; }
        if ( parsed.pathname !== '/videoplayback' ) { return false; }
        const params = parsed.searchParams;
        if ( params.get('source') !== 'youtube' ) { return false; }
        if ( params.get('itag') !== '18' ) { return false; }
        if ( params.get('mime') !== 'video/mp4' ) { return false; }
        if ( params.has('cpn') ) { return false; }
        const duration = Number(params.get('dur') || 0);
        return Number.isFinite(duration) && duration >= 1000000;
    };
    const classifyTransportSmoothEndpoint = url => {
        if ( typeof url !== 'string' || url === '' ) { return ''; }
        if ( shouldStubPageadId(url) ) { return 'pagead-id'; }
        if ( shouldStubLogEvent(url) ) { return 'log-event'; }
        if ( PTRACKING_RE.test(url) ) { return 'ptracking'; }
        if ( VIEWTHROUGH_RE.test(url) ) { return 'viewthroughconversion'; }
        if ( USER_LIST_RE.test(url) ) { return '1p-user-list'; }
        if ( LVZ_RE.test(url) ) { return 'lvz'; }
        return '';
    };
    const stubbedEndpointCounts = Object.create(null);
    const noteStubbedEndpoint = (url, transport) => {
        const endpointId = classifyTransportSmoothEndpoint(url);
        if ( endpointId === '' ) { return; }
        stubbedEndpointCounts[endpointId] = (stubbedEndpointCounts[endpointId] || 0) + 1;
        self.__talonYouTubeWatchStubbedEndpointCounts = { ...stubbedEndpointCounts };
        self.__talonYouTubeWatchLastStubbedEndpoint = endpointId;
        self.__talonYouTubeWatchLastStubbedEndpointTransport =
            typeof transport === 'string' ? transport : '';
        self.__talonYouTubeWatchLastStubbedEndpointAt = Date.now();
    };
    const shouldForceDocumentNavigation = anchor => {
        if ( self.HTMLAnchorElement === undefined || anchor instanceof self.HTMLAnchorElement === false ) {
            return false;
        }
        const inFollowupRail =
            anchor.closest('#secondary') !== null ||
            anchor.closest('yt-lockup-view-model') !== null ||
            anchor.classList.contains('yt-lockup-view-model__content-image') ||
            anchor.classList.contains('yt-lockup-view-model__title') ||
            anchor.classList.contains('yt-lockup-metadata-view-model__title');
        if ( inFollowupRail === false ) { return false; }
        if ( WATCH_URL_RE.test(anchor.href) === false ) { return false; }
        return anchor.target === '' || anchor.target === '_self';
    };
    const isCurrentWatchDocumentForUrl = targetUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        const targetVideoId = getWatchVideoIdFromUrl(normalizedTargetUrl);
        if ( normalizedTargetUrl === '' || targetVideoId === '' ) { return false; }
        if ( normalizeWatchUrl(location.href) !== normalizedTargetUrl ) { return false; }
        return followupWatchNavigationState.currentVideoId === targetVideoId;
    };
    const normalizeWatchUrl = input => {
        if ( typeof input !== 'string' || input === '' ) { return ''; }
        let parsed;
        try {
            parsed = new URL(input, location.href);
        } catch {
            return '';
        }
        if ( parsed.hostname !== 'www.youtube.com' || parsed.pathname !== '/watch' ) {
            return '';
        }
        const videoId = parsed.searchParams.get('v');
        if ( typeof videoId !== 'string' || videoId.trim() === '' ) { return ''; }
        return `${parsed.origin}/watch?v=${videoId.trim()}`;
    };
    const readPersistedFollowupNavigationDebug = () => {
        try {
            const raw = self.sessionStorage?.getItem(FOLLOWUP_NAV_DEBUG_SESSION_KEY) || '';
            if ( raw === '' ) { return null; }
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {}
        return null;
    };
    const persistFollowupNavigationDebug = patch => {
        if ( patch === null || typeof patch !== 'object' ) { return; }
        try {
            const previous = readPersistedFollowupNavigationDebug() || {};
            self.sessionStorage?.setItem(FOLLOWUP_NAV_DEBUG_SESSION_KEY, JSON.stringify({
                ...previous,
                ...patch,
                updatedAt: Date.now(),
            }));
        } catch {}
    };
    const hydratePersistedFollowupNavigationDebug = () => {
        const persisted = readPersistedFollowupNavigationDebug();
        if ( persisted === null ) { return; }
        const currentWatchUrl = normalizeWatchUrl(location.href);
        const targetUrl =
            typeof persisted.targetUrl === 'string'
                ? normalizeWatchUrl(persisted.targetUrl)
                : '';
        try {
            if ( currentWatchUrl === '' || targetUrl === '' || currentWatchUrl !== targetUrl ) {
                self.sessionStorage?.removeItem(FOLLOWUP_NAV_DEBUG_SESSION_KEY);
                return;
            }
            if ( typeof persisted.forcedNavigationEventType === 'string' ) {
                self.__talonYouTubeWatchForcedNavigationEventType = persisted.forcedNavigationEventType;
            }
            if ( typeof persisted.targetUrl === 'string' ) {
                self.__talonYouTubeWatchForcedNavigationTargetUrl = persisted.targetUrl;
            }
            if ( typeof persisted.forcedNavigationAt === 'number' ) {
                self.__talonYouTubeWatchForcedNavigationAt = persisted.forcedNavigationAt;
            }
            if ( typeof persisted.forcedNavigationPerfMs === 'number' ) {
                self.__talonYouTubeWatchForcedNavigationPerfMs = persisted.forcedNavigationPerfMs;
            }
            if ( typeof persisted.followupPreparationRequestedAt === 'number' ) {
                self.__talonYouTubeWatchFollowupPreparationRequestedAt =
                    persisted.followupPreparationRequestedAt;
            }
            if ( typeof persisted.followupPreparationRequestedUrl === 'string' ) {
                self.__talonYouTubeWatchFollowupPreparationRequestedUrl =
                    persisted.followupPreparationRequestedUrl;
            }
            if ( typeof persisted.followupPreparationResolvedAt === 'number' ) {
                self.__talonYouTubeWatchFollowupPreparationResolvedAt =
                    persisted.followupPreparationResolvedAt;
            }
            self.__talonYouTubeWatchFollowupPreparationPrefetchedSections =
                persisted.followupPreparationPrefetchedSections === true;
            self.__talonYouTubeWatchFollowupPreparationNeutralHopArmed =
                persisted.followupPreparationNeutralHopArmed === true;
            if ( typeof persisted.backgroundNavigationRequestedAt === 'number' ) {
                self.__talonYouTubeWatchBackgroundNavigationRequestedAt =
                    persisted.backgroundNavigationRequestedAt;
            }
            if ( typeof persisted.backgroundNavigationRequestedUrl === 'string' ) {
                self.__talonYouTubeWatchBackgroundNavigationRequestedUrl =
                    persisted.backgroundNavigationRequestedUrl;
            }
            if ( typeof persisted.backgroundNavigationResolvedAt === 'number' ) {
                self.__talonYouTubeWatchBackgroundNavigationResolvedAt =
                    persisted.backgroundNavigationResolvedAt;
            }
            self.__talonYouTubeWatchBackgroundNavigationOk =
                persisted.backgroundNavigationOk === true;
            if ( typeof persisted.hardNavigateTargetUrl === 'string' ) {
                self.__talonYouTubeWatchHardNavigateTargetUrl = persisted.hardNavigateTargetUrl;
            }
            if ( typeof persisted.hardNavigateAt === 'number' ) {
                self.__talonYouTubeWatchHardNavigateAt = persisted.hardNavigateAt;
            }
            if ( typeof persisted.hardNavigatePerfMs === 'number' ) {
                self.__talonYouTubeWatchHardNavigatePerfMs = persisted.hardNavigatePerfMs;
            }
            if ( typeof persisted.followupProbeEventType === 'string' ) {
                self.__talonYouTubeWatchFollowupProbeEventType = persisted.followupProbeEventType;
            }
            if ( typeof persisted.followupProbeReason === 'string' ) {
                self.__talonYouTubeWatchFollowupProbeReason = persisted.followupProbeReason;
            }
            if ( typeof persisted.followupProbeAnchorHref === 'string' ) {
                self.__talonYouTubeWatchFollowupProbeAnchorHref = persisted.followupProbeAnchorHref;
            }
            if ( typeof persisted.followupProbeAnchorClassName === 'string' ) {
                self.__talonYouTubeWatchFollowupProbeAnchorClassName =
                    persisted.followupProbeAnchorClassName;
            }
            if ( typeof persisted.followupProbeTargetUrl === 'string' ) {
                self.__talonYouTubeWatchFollowupProbeTargetUrl = persisted.followupProbeTargetUrl;
            }
            if ( typeof persisted.followupProbeAt === 'number' ) {
                self.__talonYouTubeWatchFollowupProbeAt = persisted.followupProbeAt;
            }
            if ( typeof persisted.followupListenerEventType === 'string' ) {
                self.__talonYouTubeWatchFollowupListenerEventType =
                    persisted.followupListenerEventType;
            }
            if ( typeof persisted.followupListenerAnchorHref === 'string' ) {
                self.__talonYouTubeWatchFollowupListenerAnchorHref =
                    persisted.followupListenerAnchorHref;
            }
            if ( typeof persisted.followupListenerAnchorClassName === 'string' ) {
                self.__talonYouTubeWatchFollowupListenerAnchorClassName =
                    persisted.followupListenerAnchorClassName;
            }
            if ( typeof persisted.followupListenerTargetUrl === 'string' ) {
                self.__talonYouTubeWatchFollowupListenerTargetUrl =
                    persisted.followupListenerTargetUrl;
            }
            if ( typeof persisted.followupListenerAt === 'number' ) {
                self.__talonYouTubeWatchFollowupListenerAt = persisted.followupListenerAt;
            }
            if ( typeof persisted.backgroundPrefetchBootstrapEnvelopeReceivedAt === 'number' ) {
                self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedAt =
                    persisted.backgroundPrefetchBootstrapEnvelopeReceivedAt;
            }
            self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceived =
                persisted.backgroundPrefetchBootstrapEnvelopeReceived === true;
            if (
                persisted.backgroundPrefetchBootstrapEnvelopeReceivedSummary &&
                typeof persisted.backgroundPrefetchBootstrapEnvelopeReceivedSummary === 'object'
            ) {
                self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedSummary =
                    persisted.backgroundPrefetchBootstrapEnvelopeReceivedSummary;
            }
            if ( typeof persisted.backgroundPrefetchError === 'string' ) {
                self.__talonYouTubeWatchBackgroundPrefetchError =
                    persisted.backgroundPrefetchError;
            }
            self.__talonYouTubeWatchBackgroundPrefetchHasBootstrapEnvelope =
                persisted.backgroundPrefetchHasBootstrapEnvelope === true;
            if (
                persisted.backgroundPrefetchDonorHealth &&
                typeof persisted.backgroundPrefetchDonorHealth === 'object'
            ) {
                self.__talonYouTubeWatchBackgroundPrefetchDonorHealth =
                    persisted.backgroundPrefetchDonorHealth;
            }
            if ( typeof persisted.architectureEntryStrategy === 'string' ) {
                self.__talonYouTubeWatchArchitectureEntryStrategy =
                    persisted.architectureEntryStrategy;
            }
            if ( typeof persisted.architectureHandoffSurface === 'string' ) {
                self.__talonYouTubeWatchArchitectureHandoffSurface =
                    persisted.architectureHandoffSurface;
            }
            if ( typeof persisted.architectureDonorStartedAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureDonorStartedAt =
                    persisted.architectureDonorStartedAt;
            }
            if ( typeof persisted.architectureDonorReadyAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureDonorReadyAt =
                    persisted.architectureDonorReadyAt;
            }
            if ( typeof persisted.architectureHandoffReadyAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureHandoffReadyAt =
                    persisted.architectureHandoffReadyAt;
            }
            if ( typeof persisted.architectureAnchorSeenAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureAnchorSeenAt =
                    persisted.architectureAnchorSeenAt;
            }
            if ( typeof persisted.architectureClickAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureClickAt =
                    persisted.architectureClickAt;
            }
            if ( typeof persisted.architectureReadyAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureReadyAt =
                    persisted.architectureReadyAt;
            }
            self.__talonYouTubeWatchArchitectureReadyBeforeClick =
                persisted.architectureReadyBeforeClick === true;
            self.__talonYouTubeWatchArchitectureReadyAfterClick =
                persisted.architectureReadyAfterClick === true;
            if ( typeof persisted.architectureFailureCategory === 'string' ) {
                self.__talonYouTubeWatchArchitectureFailureCategory =
                    persisted.architectureFailureCategory;
            }
            if ( typeof persisted.architecturePreclickSignalType === 'string' ) {
                self.__talonYouTubeWatchArchitecturePreclickSignalType =
                    persisted.architecturePreclickSignalType;
            }
            if ( typeof persisted.architectureTargetNavigationAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureTargetNavigationAt =
                    persisted.architectureTargetNavigationAt;
            }
            if ( typeof persisted.architectureNavigationHoldDurationMs === 'number' ) {
                self.__talonYouTubeWatchArchitectureNavigationHoldDurationMs =
                    persisted.architectureNavigationHoldDurationMs;
            }
            if ( typeof persisted.architectureInvalidReason === 'string' ) {
                self.__talonYouTubeWatchArchitectureInvalidReason =
                    persisted.architectureInvalidReason;
            }
            self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionHit =
                persisted.architectureTrackAPrewarmPredictionHit === true;
            self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionMiss =
                persisted.architectureTrackAPrewarmPredictionMiss === true;
            self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryStale =
                persisted.architectureTrackAPrewarmEntryStale === true;
            self.__talonYouTubeWatchArchitectureTrackAPrewarmRequested =
                persisted.architectureTrackAPrewarmRequested === true;
            if ( typeof persisted.architectureTrackAPrewarmEntryCreatedAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryCreatedAt =
                    persisted.architectureTrackAPrewarmEntryCreatedAt;
            }
            if ( typeof persisted.architectureTrackAPrewarmEntryAgeMs === 'number' ) {
                self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryAgeMs =
                    persisted.architectureTrackAPrewarmEntryAgeMs;
            }
            self.__talonYouTubeWatchArchitectureTrackAIntentLeaseHit =
                persisted.architectureTrackAIntentLeaseHit === true;
            self.__talonYouTubeWatchArchitectureTrackAIntentLeaseMiss =
                persisted.architectureTrackAIntentLeaseMiss === true;
            self.__talonYouTubeWatchArchitectureDonorOwnerTransferOk =
                persisted.architectureDonorOwnerTransferOk === true;
            self.__talonYouTubeWatchArchitectureDonorOwnerReuseDetected =
                persisted.architectureDonorOwnerReuseDetected === true;
            self.__talonYouTubeWatchArchitectureDonorOwnerContaminationDetected =
                persisted.architectureDonorOwnerContaminationDetected === true;
            if ( typeof persisted.architectureDonorOwnerStartLatencyMs === 'number' ) {
                self.__talonYouTubeWatchArchitectureDonorOwnerStartLatencyMs =
                    persisted.architectureDonorOwnerStartLatencyMs;
            }
            self.__talonYouTubeWatchArchitectureEnvelopeReadyBeforeNavigationRelease =
                persisted.architectureEnvelopeReadyBeforeNavigationRelease === true;
            self.__talonYouTubeWatchArchitectureFallbackPathUsed =
                persisted.architectureFallbackPathUsed === true;
            self.__talonYouTubeWatchArchitectureTimeoutOccurred =
                persisted.architectureTimeoutOccurred === true;
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent =
                persisted.architectureDocumentCommitEnvelopePresent === true;
            if ( typeof persisted.architectureDocumentCommitEnvelopeSource === 'string' ) {
                self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
                    persisted.architectureDocumentCommitEnvelopeSource;
            }
            if ( typeof persisted.architectureTrackAStoredAt === 'number' ) {
                self.__talonYouTubeWatchArchitectureTrackAStoredAt =
                    persisted.architectureTrackAStoredAt;
            }
            self.__talonYouTubeWatchArchitectureTrackAStoredWriteOk =
                persisted.architectureTrackAStoredWriteOk === true;
            if ( typeof persisted.architectureTrackAStoredBytes === 'number' ) {
                self.__talonYouTubeWatchArchitectureTrackAStoredBytes =
                    persisted.architectureTrackAStoredBytes;
            }
            self.__talonYouTubeWatchArchitectureTrackAStoredReadbackOk =
                persisted.architectureTrackAStoredReadbackOk === true;
            self.__talonYouTubeWatchArchitectureTrackAStoredTargetMatch =
                persisted.architectureTrackAStoredTargetMatch === true;
        } catch {}
        try {
            self.sessionStorage?.removeItem(FOLLOWUP_NAV_DEBUG_SESSION_KEY);
        } catch {}
    };
    const getCurrentWatchVideoId = () => {
        let parsed;
        try {
            parsed = new URL(location.href);
        } catch {
            return '';
        }
        if ( parsed.hostname !== 'www.youtube.com' || parsed.pathname !== '/watch' ) {
            return '';
        }
        const videoId = parsed.searchParams.get('v');
        return typeof videoId === 'string' ? videoId.trim() : '';
    };
    const getNowPerfMs = () =>
        self.performance && typeof self.performance.now === 'function'
            ? self.performance.now()
            : 0;
    hydratePersistedFollowupNavigationDebug();
    const readFollowupPrefetchDonorToken = () => {
        if ( typeof location?.hash !== 'string' || location.hash === '' ) { return ''; }
        try {
            const params = new URLSearchParams(location.hash.slice(1));
            const token = params.get('td-yw-donor');
            return typeof token === 'string' ? token.trim() : '';
        } catch {
        }
        return '';
    };
    const armFollowupNextSuppression = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        followupNextSuppressionTargetUrl = normalizedTargetUrl;
        followupNextSuppressionUntilEpochMs = Date.now() + FOLLOWUP_NEXT_DELAY_TIMEOUT_MS;
        self.__talonYouTubeWatchFollowupNextSuppressionTarget = normalizedTargetUrl;
        self.__talonYouTubeWatchFollowupNextSuppressionArmedAt = Date.now();
        self.__talonYouTubeWatchFollowupNextSuppressionArmedPerfMs = getNowPerfMs();
    };
    const readFollowupWatchNavigationState = () => {
        const currentVideoId = getCurrentWatchVideoId();
        let previousVideoId = '';
        let isFollowupNavigation = false;
        try {
            const previousRaw = self.sessionStorage?.getItem(FOLLOWUP_WATCH_SESSION_KEY) || '';
            if ( previousRaw !== '' ) {
                const previous = JSON.parse(previousRaw);
                if ( previous && typeof previous.videoId === 'string' ) {
                    previousVideoId = previous.videoId;
                    isFollowupNavigation =
                        currentVideoId !== '' &&
                        previousVideoId !== '' &&
                        previousVideoId !== currentVideoId;
                }
            }
            if ( currentVideoId !== '' ) {
                self.sessionStorage?.setItem(FOLLOWUP_WATCH_SESSION_KEY, JSON.stringify({
                    videoId: currentVideoId,
                    seenAt: Date.now(),
                }));
            }
        } catch {}
        return {
            currentVideoId,
            previousVideoId,
            isFollowupNavigation,
        };
    };
    let followupWatchNavigationState = {
        currentVideoId: '',
        previousVideoId: '',
        isFollowupNavigation: false,
    };
    const refreshFollowupWatchNavigationState = () => {
        followupWatchNavigationState = readFollowupWatchNavigationState();
        self.__talonYouTubeWatchReplayFollowupNavigation =
            followupWatchNavigationState.isFollowupNavigation;
        self.__talonYouTubeWatchReplayPreviousVideoId =
            followupWatchNavigationState.previousVideoId;
        self.__talonYouTubeWatchReplayCurrentVideoId =
            followupWatchNavigationState.currentVideoId;
        return followupWatchNavigationState;
    };
    refreshFollowupWatchNavigationState();
    const safeJsonParse = value => {
        if ( typeof value !== 'string' || value === '' ) { return null; }
        try {
            return JSON.parse(value);
        } catch {
        }
        return null;
    };
    const extractBalancedLiteral = (source, startIndex) => {
        if ( typeof source !== 'string' || Number.isInteger(startIndex) === false || startIndex < 0 ) {
            return null;
        }
        const opener = source[startIndex];
        const closer = opener === '{' ? '}' : opener === '[' ? ']' : null;
        if ( closer === null ) { return null; }
        let depth = 0;
        let quote = null;
        let escaped = false;
        for ( let index = startIndex; index < source.length; index += 1 ) {
            const character = source[index];
            if ( quote !== null ) {
                if ( escaped ) {
                    escaped = false;
                    continue;
                }
                if ( character === '\\' ) {
                    escaped = true;
                    continue;
                }
                if ( character === quote ) {
                    quote = null;
                }
                continue;
            }
            if ( character === '\'' || character === '"' || character === '`' ) {
                quote = character;
                continue;
            }
            if ( character === opener ) {
                depth += 1;
                continue;
            }
            if ( character === closer ) {
                depth -= 1;
                if ( depth === 0 ) {
                    return source.slice(startIndex, index + 1);
                }
            }
        }
        return null;
    };
    const extractLiteralAfterAnchor = (source, anchor) => {
        if ( typeof source !== 'string' || typeof anchor !== 'string' || anchor === '' ) {
            return null;
        }
        const anchorIndex = source.indexOf(anchor);
        if ( anchorIndex === -1 ) { return null; }
        for ( let index = anchorIndex + anchor.length; index < source.length; index += 1 ) {
            const character = source[index];
            if ( character === '{' || character === '[' ) {
                return extractBalancedLiteral(source, index);
            }
            if ( /\s|=|:|\(|\)/.test(character) ) { continue; }
            break;
        }
        return null;
    };
    const extractFirstLiteralFromAnchors = (source, anchors) => {
        if ( Array.isArray(anchors) === false ) { return null; }
        for ( const anchor of anchors ) {
            const literal = extractLiteralAfterAnchor(source, anchor);
            if ( literal !== null ) { return literal; }
        }
        return null;
    };
    const isVideoplaybackResourceUrl = input => {
        if ( typeof input !== 'string' || input === '' ) { return false; }
        let parsed;
        try {
            parsed = new URL(input, location.href);
        } catch {
            return false;
        }
        return GOOGLEVIDEO_HOST_RE.test(parsed.hostname) && parsed.pathname === '/videoplayback';
    };

    const clonePayload = value => {
        if ( typeof self.structuredClone === 'function' ) {
            return self.structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    };
    const isFollowupArchitectureTrackA =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_A;
    const isFollowupArchitectureTrackACommit =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT;
    const isFollowupArchitectureTrackAPrewarm =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM;
    const isFollowupArchitectureTrackAIntentLease =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE;
    const isFollowupArchitectureTrackADonorOwner =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER;
    const usesTrackASessionStorageArchitecture =
        isFollowupArchitectureTrackA ||
        isFollowupArchitectureTrackAPrewarm ||
        isFollowupArchitectureTrackAIntentLease ||
        isFollowupArchitectureTrackADonorOwner;
    const usesTrackASameOriginCommitArchitecture = isFollowupArchitectureTrackACommit;
    const isFollowupArchitectureTrackB =
        followupEntryStrategy === FOLLOWUP_ENTRY_STRATEGY_TRACK_B;
    const isFollowupArchitectureProofMode =
        usesTrackASessionStorageArchitecture ||
        usesTrackASameOriginCommitArchitecture ||
        isFollowupArchitectureTrackB;
    const markArchitectureInvalidReason = reason => {
        if ( typeof reason !== 'string' || reason === '' ) { return; }
        if ( typeof self.__talonYouTubeWatchArchitectureInvalidReason !== 'string' ||
            self.__talonYouTubeWatchArchitectureInvalidReason === '' ) {
            self.__talonYouTubeWatchArchitectureInvalidReason = reason;
        }
    };
    const setArchitectureEntryMetrics = payload => {
        if ( payload === null || typeof payload !== 'object' ) { return; }
        self.__talonYouTubeWatchArchitectureEntryStrategy =
            typeof payload.strategy === 'string' ? payload.strategy : followupEntryStrategy;
        self.__talonYouTubeWatchArchitectureHandoffSurface =
            typeof payload.handoffSurface === 'string' ? payload.handoffSurface : '';
        self.__talonYouTubeWatchArchitectureDonorStartedAt =
            typeof payload.donorStartedAt === 'number' ? payload.donorStartedAt : null;
        self.__talonYouTubeWatchArchitectureDonorReadyAt =
            typeof payload.donorReadyAt === 'number' ? payload.donorReadyAt : null;
        self.__talonYouTubeWatchArchitectureHandoffReadyAt =
            typeof payload.handoffReadyAt === 'number' ? payload.handoffReadyAt : null;
        self.__talonYouTubeWatchArchitectureAnchorSeenAt =
            typeof payload.anchorSeenAt === 'number' ? payload.anchorSeenAt : null;
        self.__talonYouTubeWatchArchitectureClickAt =
            typeof payload.clickAt === 'number' ? payload.clickAt : null;
        self.__talonYouTubeWatchArchitectureReadyAt =
            typeof payload.readyAt === 'number' ? payload.readyAt : null;
        self.__talonYouTubeWatchArchitectureReadyBeforeClick =
            payload.readyBeforeClick === true;
        self.__talonYouTubeWatchArchitectureReadyAfterClick =
            payload.readyAfterClick === true;
        self.__talonYouTubeWatchArchitectureFailureCategory =
            typeof payload.failureCategory === 'string' ? payload.failureCategory : '';
        self.__talonYouTubeWatchArchitecturePreclickSignalType =
            typeof payload.preclickSignalType === 'string' ? payload.preclickSignalType : '';
        self.__talonYouTubeWatchArchitectureTrackAIntentLeaseHit =
            payload.trackAIntentLeaseHit === true;
        self.__talonYouTubeWatchArchitectureTrackAIntentLeaseMiss =
            payload.trackAIntentLeaseMiss === true;
        self.__talonYouTubeWatchArchitectureDonorOwnerTransferOk =
            payload.donorOwnerTransferOk === true;
        self.__talonYouTubeWatchArchitectureDonorOwnerReuseDetected =
            payload.donorOwnerReuseDetected === true;
        self.__talonYouTubeWatchArchitectureDonorOwnerContaminationDetected =
            payload.donorOwnerContaminationDetected === true;
        self.__talonYouTubeWatchArchitectureDonorOwnerStartLatencyMs =
            typeof payload.donorOwnerStartLatencyMs === 'number'
                ? payload.donorOwnerStartLatencyMs
                : null;
        self.__talonYouTubeWatchArchitectureTargetNavigationAt =
            typeof payload.targetNavigationAt === 'number' ? payload.targetNavigationAt : null;
        self.__talonYouTubeWatchArchitectureEnvelopeReadyBeforeNavigationRelease =
            payload.envelopeReadyBeforeNavigationRelease === true;
        self.__talonYouTubeWatchArchitectureNavigationHoldDurationMs =
            typeof payload.navigationHoldDurationMs === 'number'
                ? payload.navigationHoldDurationMs
                : null;
        self.__talonYouTubeWatchArchitectureFallbackPathUsed =
            payload.fallbackPathUsed === true;
        self.__talonYouTubeWatchArchitectureTimeoutOccurred =
            payload.timeoutOccurred === true;
        if ( typeof payload.invalidReason === 'string' ) {
            self.__talonYouTubeWatchArchitectureInvalidReason = payload.invalidReason;
        }
        if ( typeof payload.backgroundPrefetchError === 'string' ) {
            self.__talonYouTubeWatchBackgroundPrefetchError = payload.backgroundPrefetchError;
        }
        self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionHit =
            payload.trackAPrewarmPredictionHit === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmPredictionMiss =
            payload.trackAPrewarmPredictionMiss === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryStale =
            payload.trackAPrewarmEntryStale === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmRequested =
            payload.trackAPrewarmRequested === true;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryCreatedAt =
            typeof payload.trackAPrewarmEntryCreatedAt === 'number'
                ? payload.trackAPrewarmEntryCreatedAt
                : null;
        self.__talonYouTubeWatchArchitectureTrackAPrewarmEntryAgeMs =
            typeof payload.trackAPrewarmEntryAgeMs === 'number'
                ? payload.trackAPrewarmEntryAgeMs
                : null;
    };
    const sanitizeArchitectureProofEntry = value => {
        if ( value === null || typeof value !== 'object' ) { return null; }
        const targetUrl = normalizeWatchUrl(value.targetUrl);
        if ( targetUrl === '' ) { return null; }
        const targetVideoId = (() => {
            if ( typeof value.targetVideoId === 'string' && value.targetVideoId.trim() !== '' ) {
                return value.targetVideoId.trim();
            }
            try {
                return new URL(targetUrl).searchParams.get('v')?.trim?.() || '';
            } catch {
            }
            return '';
        })();
        const sections =
            value.sections && typeof value.sections === 'object'
                ? clonePayload(value.sections)
                : null;
        const bootstrapEnvelope =
            value.bootstrapEnvelope && typeof value.bootstrapEnvelope === 'object'
                ? clonePayload(value.bootstrapEnvelope)
                : null;
        if ( sections === null && bootstrapEnvelope === null ) { return null; }
        const proof =
            value.proof && typeof value.proof === 'object'
                ? clonePayload(value.proof)
                : {};
        const health =
            value.health && typeof value.health === 'object'
                ? clonePayload(value.health)
                : null;
        return {
            kind: typeof value.kind === 'string' ? value.kind : '',
            strategy: typeof value.strategy === 'string' ? value.strategy : followupEntryStrategy,
            handoffSurface: typeof value.handoffSurface === 'string' ? value.handoffSurface : '',
            targetUrl,
            targetVideoId,
            prefetchedAt: typeof value.prefetchedAt === 'number' ? value.prefetchedAt : Date.now(),
            sections,
            bootstrapEnvelope,
            health,
            proof,
        };
    };
    const clearTrackAArchitectureEntry = () => {
        try {
            self.sessionStorage?.removeItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY);
        } catch {}
    };
    const clearTrackACommitArchitectureEntry = () => {
        try {
            self.localStorage?.removeItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY);
        } catch {}
    };
    const readStoredTrackAArchitectureEntry = () => {
        try {
            const raw = self.sessionStorage?.getItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY) || '';
            if ( raw === '' ) { return null; }
            return sanitizeArchitectureProofEntry(JSON.parse(raw));
        } catch {}
        return null;
    };
    const readStoredTrackACommitArchitectureEntry = () => {
        try {
            const raw = self.localStorage?.getItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY) || '';
            if ( raw === '' ) { return null; }
            return sanitizeArchitectureProofEntry(JSON.parse(raw));
        } catch {}
        return null;
    };
    const storeTrackAArchitectureEntry = entry => {
        const sanitized = sanitizeArchitectureProofEntry(entry);
        if ( sanitized === null ) { return false; }
        let raw = '';
        try {
            raw = JSON.stringify(sanitized);
        } catch {
            return false;
        }
        const storedAt = Date.now();
        let writeOk = false;
        let storedBytes = raw.length;
        let readbackOk = false;
        let targetMatch = false;
        try {
            self.sessionStorage?.setItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY, raw);
            writeOk = true;
            const readbackRaw =
                self.sessionStorage?.getItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY) || '';
            if ( readbackRaw !== '' ) {
                storedBytes = readbackRaw.length;
                readbackOk = readbackRaw === raw;
                try {
                    const readbackEntry = sanitizeArchitectureProofEntry(JSON.parse(readbackRaw));
                    targetMatch =
                        readbackEntry !== null &&
                        readbackEntry.targetUrl === sanitized.targetUrl;
                } catch {}
            }
        } catch {}
        self.__talonYouTubeWatchArchitectureTrackAStoredAt = storedAt;
        self.__talonYouTubeWatchArchitectureTrackAStoredWriteOk = writeOk;
        self.__talonYouTubeWatchArchitectureTrackAStoredBytes = storedBytes;
        self.__talonYouTubeWatchArchitectureTrackAStoredReadbackOk = readbackOk;
        self.__talonYouTubeWatchArchitectureTrackAStoredTargetMatch = targetMatch;
        persistFollowupNavigationDebug({
            targetUrl: sanitized.targetUrl,
            architectureTrackAStoredAt: storedAt,
            architectureTrackAStoredWriteOk: writeOk,
            architectureTrackAStoredBytes: storedBytes,
            architectureTrackAStoredReadbackOk: readbackOk,
            architectureTrackAStoredTargetMatch: targetMatch,
        });
        return writeOk;
    };
    const storeTrackACommitArchitectureEntry = entry => {
        const sanitized = sanitizeArchitectureProofEntry(entry);
        if ( sanitized === null ) { return null; }
        let raw = '';
        try {
            raw = JSON.stringify(sanitized);
        } catch {
            return null;
        }
        const storedAt = Date.now();
        let writeOk = false;
        let storedBytes = raw.length;
        let readbackOk = false;
        let targetMatch = false;
        try {
            self.localStorage?.setItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY, raw);
            writeOk = true;
            const readbackRaw =
                self.localStorage?.getItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY) || '';
            if ( readbackRaw !== '' ) {
                storedBytes = readbackRaw.length;
                readbackOk = readbackRaw === raw;
                try {
                    const readbackEntry = sanitizeArchitectureProofEntry(JSON.parse(readbackRaw));
                    targetMatch =
                        readbackEntry !== null &&
                        readbackEntry.targetUrl === sanitized.targetUrl;
                } catch {}
            }
        } catch {}
        self.__talonYouTubeWatchArchitectureTrackAStoredAt = storedAt;
        self.__talonYouTubeWatchArchitectureTrackAStoredWriteOk = writeOk;
        self.__talonYouTubeWatchArchitectureTrackAStoredBytes = storedBytes;
        self.__talonYouTubeWatchArchitectureTrackAStoredReadbackOk = readbackOk;
        self.__talonYouTubeWatchArchitectureTrackAStoredTargetMatch = targetMatch;
        persistFollowupNavigationDebug({
            targetUrl: sanitized.targetUrl,
            architectureTrackAStoredAt: storedAt,
            architectureTrackAStoredWriteOk: writeOk,
            architectureTrackAStoredBytes: storedBytes,
            architectureTrackAStoredReadbackOk: readbackOk,
            architectureTrackAStoredTargetMatch: targetMatch,
        });
        return {
            storedAt,
            writeOk,
            storedBytes,
            readbackOk,
            targetMatch,
        };
    };
    const readTrackAArchitectureEntryForCurrentPage = () => {
        const normalizedTargetUrl = normalizeWatchUrl(location.href);
        const readAt = Date.now();
        let raw = '';
        let parsed = null;
        let parseOk = false;
        try {
            raw = self.sessionStorage?.getItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY) || '';
            if ( raw !== '' ) {
                parsed = JSON.parse(raw);
                parseOk = true;
            }
        } catch {}
        const rawPresent = raw !== '';
        const rawBytes = rawPresent ? raw.length : 0;
        const entry = sanitizeArchitectureProofEntry(parsed);
        const targetMatch = entry !== null && entry.targetUrl === normalizedTargetUrl;
        clearTrackAArchitectureEntry();
        let cleared = false;
        try {
            cleared =
                (self.sessionStorage?.getItem(FOLLOWUP_TRACK_A_ENVELOPE_SESSION_KEY) || '') === '';
        } catch {}
        const consumed = targetMatch;
        self.__talonYouTubeWatchArchitectureTrackAReadAt = readAt;
        self.__talonYouTubeWatchArchitectureTrackAReadRawPresent = rawPresent;
        self.__talonYouTubeWatchArchitectureTrackAReadRawBytes = rawBytes;
        self.__talonYouTubeWatchArchitectureTrackAReadParseOk = parseOk;
        self.__talonYouTubeWatchArchitectureTrackAReadTargetMatch = targetMatch;
        self.__talonYouTubeWatchArchitectureTrackAReadCleared = cleared;
        self.__talonYouTubeWatchArchitectureTrackAReadConsumed = consumed;
        if ( consumed !== true ) {
            self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = false;
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
                'track-a-session-storage';
        }
        if ( entry === null ) { return null; }
        if ( targetMatch !== true ) {
            markArchitectureInvalidReason('hybrid-release');
            return null;
        }
        setArchitectureEntryMetrics({
            ...entry.proof,
            strategy: entry.strategy,
            handoffSurface: entry.handoffSurface || 'sessionStorage',
        });
        self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent =
            entry.bootstrapEnvelope instanceof Object || entry.sections instanceof Object;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource = 'track-a-session-storage';
        return entry;
    };
    const readTrackACommitArchitectureEntryForCurrentPage = () => {
        const normalizedTargetUrl = normalizeWatchUrl(location.href);
        const readAt = Date.now();
        let raw = '';
        let parsed = null;
        let parseOk = false;
        try {
            raw = self.localStorage?.getItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY) || '';
            if ( raw !== '' ) {
                parsed = JSON.parse(raw);
                parseOk = true;
            }
        } catch {}
        const rawPresent = raw !== '';
        const rawBytes = rawPresent ? raw.length : 0;
        const entry = sanitizeArchitectureProofEntry(parsed);
        const targetMatch = entry !== null && entry.targetUrl === normalizedTargetUrl;
        clearTrackACommitArchitectureEntry();
        let cleared = false;
        try {
            cleared =
                (self.localStorage?.getItem(FOLLOWUP_TRACK_A_COMMIT_LOCAL_STORAGE_KEY) || '') === '';
        } catch {}
        const consumed = targetMatch;
        self.__talonYouTubeWatchArchitectureTrackAReadAt = readAt;
        self.__talonYouTubeWatchArchitectureTrackAReadRawPresent = rawPresent;
        self.__talonYouTubeWatchArchitectureTrackAReadRawBytes = rawBytes;
        self.__talonYouTubeWatchArchitectureTrackAReadParseOk = parseOk;
        self.__talonYouTubeWatchArchitectureTrackAReadTargetMatch = targetMatch;
        self.__talonYouTubeWatchArchitectureTrackAReadCleared = cleared;
        self.__talonYouTubeWatchArchitectureTrackAReadConsumed = consumed;
        if ( consumed !== true ) {
            self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = false;
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
                'track-a-same-origin-storage';
        }
        if ( entry === null ) { return null; }
        if ( targetMatch !== true ) {
            markArchitectureInvalidReason('hybrid-release');
            return null;
        }
        setArchitectureEntryMetrics({
            ...entry.proof,
            strategy: entry.strategy,
            handoffSurface: entry.handoffSurface || 'localStorage',
        });
        self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent =
            entry.bootstrapEnvelope instanceof Object || entry.sections instanceof Object;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
            'track-a-same-origin-storage';
        return entry;
    };
    const consumeTrackBArchitectureEntryForCurrentPage = () => {
        if ( isFollowupArchitectureTrackB === false ) { return null; }
        const rawWindowName = typeof self.name === 'string' ? self.name : '';
        const payloadBytes = rawWindowName === '' ? 0 : rawWindowName.length;
        self.__talonYouTubeWatchArchitectureWindowNamePayloadBytes = payloadBytes;
        self.__talonYouTubeWatchArchitectureWindowNamePayloadTooLarge =
            payloadBytes > 256000;
        let parsed = null;
        try {
            parsed = rawWindowName === '' ? null : JSON.parse(rawWindowName);
        } catch {}
        try {
            self.name = '';
            self.__talonYouTubeWatchArchitectureWindowNamePayloadCleared = true;
        } catch {
            self.__talonYouTubeWatchArchitectureWindowNamePayloadCleared = false;
        }
        if ( parsed === null || parsed.kind !== 'td-yw-track-b-bootstrap-envelope' ) {
            return null;
        }
        const entry = sanitizeArchitectureProofEntry(parsed.entry);
        if ( entry === null ) {
            setArchitectureEntryMetrics({
                ...(parsed.proof && typeof parsed.proof === 'object' ? parsed.proof : {}),
                strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_B,
                handoffSurface: 'windowName',
            });
            self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = false;
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource = 'track-b-window-name';
            return null;
        }
        const normalizedTargetUrl = normalizeWatchUrl(location.href);
        if ( entry.targetUrl !== normalizedTargetUrl ) {
            markArchitectureInvalidReason('hybrid-release');
            return null;
        }
        setArchitectureEntryMetrics({
            ...entry.proof,
            strategy: entry.strategy,
            handoffSurface: 'windowName',
        });
        self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent =
            entry.bootstrapEnvelope instanceof Object || entry.sections instanceof Object;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource = 'track-b-window-name';
        return entry;
    };
    const stableStringifyFragment = value => {
        const seen = new WeakSet();
        const normalize = input => {
            if ( input === null || typeof input !== 'object' ) {
                return input;
            }
            if ( seen.has(input) ) {
                return '[Circular]';
            }
            seen.add(input);
            if ( Array.isArray(input) ) {
                return input.map(normalize);
            }
            const output = {};
            for ( const key of Object.keys(input).sort() ) {
                output[key] = normalize(input[key]);
            }
            return output;
        };
        try {
            return JSON.stringify(normalize(value));
        } catch {
        }
        return '';
    };
    const hashTextFragment = value => {
        if ( typeof value !== 'string' || value === '' ) { return null; }
        let hash = 0x811c9dc5;
        for ( let index = 0; index < value.length; index += 1 ) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return `${hash >>> 0}`.padStart(10, '0');
    };
    const summarizeUrlValueForPrefetch = value => {
        if ( typeof value !== 'string' || value === '' ) { return null; }
        try {
            const parsed = new URL(value, location.href);
            const selectedParams = {};
            for ( const key of [
                'ei',
                'n',
                'ns',
                'cpn',
                'cver',
                'cps',
                'met',
                'sabr',
                'spc',
                'id',
                'cl',
                'docid',
                'plid',
                'vm',
                'of',
            ] ) {
                if ( parsed.searchParams.has(key) ) {
                    selectedParams[key] = parsed.searchParams.get(key);
                }
            }
            return {
                host: parsed.host,
                pathname: parsed.pathname,
                queryKeys: Array.from(parsed.searchParams.keys()).sort(),
                selectedParams: Object.keys(selectedParams).length > 0 ? selectedParams : null,
                hash: hashTextFragment(value),
            };
        } catch {
        }
        return {
            host: null,
            pathname: null,
            queryKeys: [],
            selectedParams: null,
            hash: hashTextFragment(value),
        };
    };
    const summarizePrefetchedFollowupPlayerResponseSections = sections => {
        if ( sections === null || typeof sections !== 'object' ) { return null; }
        const fullPlayerResponse =
            sections.fullPlayerResponse && typeof sections.fullPlayerResponse === 'object'
                ? sections.fullPlayerResponse
                : null;
        const effectiveValue = fullPlayerResponse || sections;
        const playerConfig =
            sections.playerConfig && typeof sections.playerConfig === 'object'
                ? sections.playerConfig
                : effectiveValue.playerConfig && typeof effectiveValue.playerConfig === 'object'
                    ? effectiveValue.playerConfig
                    : null;
        const streamingData =
            sections.streamingData && typeof sections.streamingData === 'object'
                ? sections.streamingData
                : effectiveValue.streamingData && typeof effectiveValue.streamingData === 'object'
                    ? effectiveValue.streamingData
                    : null;
        const responseContext =
            sections.responseContext && typeof sections.responseContext === 'object'
                ? sections.responseContext
                : effectiveValue.responseContext && typeof effectiveValue.responseContext === 'object'
                    ? effectiveValue.responseContext
                    : null;
        const playbackTracking =
            sections.playbackTracking && typeof sections.playbackTracking === 'object'
                ? sections.playbackTracking
                : effectiveValue.playbackTracking && typeof effectiveValue.playbackTracking === 'object'
                    ? effectiveValue.playbackTracking
                    : null;
        const ytInitialData =
            sections.ytInitialData && typeof sections.ytInitialData === 'object'
                ? sections.ytInitialData
                : null;
        const playabilityStatus =
            effectiveValue.playabilityStatus && typeof effectiveValue.playabilityStatus === 'object'
                ? effectiveValue.playabilityStatus
                : null;
        const mediaCommonConfig =
            playerConfig?.mediaCommonConfig && typeof playerConfig.mediaCommonConfig === 'object'
                ? playerConfig.mediaCommonConfig
                : null;
        const ustreamerConfig =
            mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig ?? null;
        return {
            hasYtInitialData: ytInitialData !== null,
            hasFullPlayerResponse: fullPlayerResponse !== null,
            playabilityStatus: playabilityStatus ? {
                status: playabilityStatus.status || null,
                reason: playabilityStatus.reason || null,
                contextParams: playabilityStatus.contextParams || null,
            } : null,
            adSummary: {
                adPlacementsCount: Array.isArray(effectiveValue.adPlacements)
                    ? effectiveValue.adPlacements.length
                    : 0,
                playerAdsCount: Array.isArray(effectiveValue.playerAds)
                    ? effectiveValue.playerAds.length
                    : 0,
                adSlotsCount: Array.isArray(effectiveValue.adSlots)
                    ? effectiveValue.adSlots.length
                    : 0,
            },
            sectionHashes: {
                ytInitialData: hashTextFragment(stableStringifyFragment(ytInitialData)),
                responseContext: hashTextFragment(stableStringifyFragment(responseContext)),
                streamingData: hashTextFragment(stableStringifyFragment(streamingData)),
                playbackTracking: hashTextFragment(stableStringifyFragment(playbackTracking)),
                playerConfig: hashTextFragment(stableStringifyFragment(playerConfig)),
            },
            streamingDataSummary: streamingData ? {
                formats: Array.isArray(streamingData.formats) ? streamingData.formats.length : 0,
                adaptiveFormats: Array.isArray(streamingData.adaptiveFormats)
                    ? streamingData.adaptiveFormats.length
                    : 0,
                serverAbrStreamingUrl: summarizeUrlValueForPrefetch(streamingData.serverAbrStreamingUrl),
                firstFormatUrl: summarizeUrlValueForPrefetch(streamingData.formats?.[0]?.url),
                firstAdaptiveUrl: summarizeUrlValueForPrefetch(
                    streamingData.adaptiveFormats?.[0]?.url
                ),
            } : null,
            responseContextSummary: responseContext ? {
                mainTrackingParam:
                    responseContext.mainAppWebResponseContext?.trackingParam || null,
                serviceTrackingParamServices: Array.isArray(responseContext.serviceTrackingParams)
                    ? responseContext.serviceTrackingParams
                        .map(entry => entry?.service || null)
                        .filter(Boolean)
                        .sort()
                    : [],
            } : null,
            playerConfigSummary: playerConfig ? {
                keys: Object.keys(playerConfig).sort(),
                hasDaiConfig:
                    playerConfig.daiConfig && typeof playerConfig.daiConfig === 'object',
                daiConfigKeys:
                    playerConfig.daiConfig && typeof playerConfig.daiConfig === 'object'
                        ? Object.keys(playerConfig.daiConfig).sort()
                        : [],
                daiConfigHash: hashTextFragment(
                    stableStringifyFragment(playerConfig.daiConfig || null)
                ),
                streamSelectionConfigHash: hashTextFragment(
                    stableStringifyFragment(playerConfig.streamSelectionConfig || null)
                ),
                mediaCommonConfigHash: hashTextFragment(stableStringifyFragment(mediaCommonConfig)),
                videoPlaybackUstreamerConfigHash: hashTextFragment(
                    typeof ustreamerConfig === 'string' ? ustreamerConfig : ''
                ),
            } : null,
        };
    };
    const readPrefetchedFollowupBootstrapRawPlayerResponse = configValue => {
        const args = configValue?.args;
        let candidate = args && typeof args === 'object' ? args.raw_player_response : null;
        if ( typeof candidate === 'string' && candidate !== '' ) {
            candidate = safeJsonParse(candidate);
        }
        if ( candidate === null || typeof candidate !== 'object' ) {
            candidate = args && typeof args === 'object' ? args.player_response : null;
            if ( typeof candidate === 'string' && candidate !== '' ) {
                candidate = safeJsonParse(candidate);
            }
        }
        return candidate && typeof candidate === 'object'
            ? candidate
            : null;
    };
    const extractPrefetchedFollowupBootstrapWebPlayerContextConfigFromYtcfg = ytcfg =>
        ytcfg?.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH &&
            typeof ytcfg.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH === 'object'
            ? ytcfg.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH
            : null;
    const summarizePrefetchedFollowupBootstrapEnvelope = envelope => {
        if ( envelope === null || typeof envelope !== 'object' ) { return null; }
        return {
            ytcfgHash: hashTextFragment(stableStringifyFragment(envelope.ytcfg || null)),
            ytInitialDataHash: hashTextFragment(
                stableStringifyFragment(envelope.ytInitialData || null)
            ),
            ytInitialPlayerResponseHash: hashTextFragment(
                stableStringifyFragment(envelope.ytInitialPlayerResponse || null)
            ),
            ytPlayerConfigHash: hashTextFragment(
                stableStringifyFragment(envelope.ytPlayerConfig || null)
            ),
            rawPlayerResponseHash: hashTextFragment(
                stableStringifyFragment(envelope.rawPlayerResponse || null)
            ),
            bootstrapPlayerResponseHash: hashTextFragment(
                stableStringifyFragment(envelope.bootstrapPlayerResponse || null)
            ),
            bootstrapWebPlayerContextConfigHash: hashTextFragment(
                stableStringifyFragment(envelope.bootstrapWebPlayerContextConfig || null)
            ),
            wizGlobalDataHash: hashTextFragment(
                stableStringifyFragment(envelope.wizGlobalData || null)
            ),
        };
    };
    const getWatchVideoIdFromUrl = input => {
        const normalized = normalizeWatchUrl(input);
        if ( normalized === '' ) { return ''; }
        try {
            return new URL(normalized).searchParams.get('v') || '';
        } catch {
        }
        return '';
    };
    const shouldPrewarmTrackATargetOnCurrentPage = () =>
        isFollowupArchitectureTrackAPrewarm &&
        getCurrentWatchVideoId() === FOLLOWUP_TRACK_A_PREWARM_SOURCE_VIDEO_ID;
    const collectTrackAPrewarmTargetUrls = root => {
        if ( shouldPrewarmTrackATargetOnCurrentPage() === false ) {
            return [];
        }
        const candidates = [];
        if ( self.HTMLAnchorElement !== undefined && root instanceof self.HTMLAnchorElement ) {
            candidates.push(root);
        }
        const queryRoot =
            root && typeof root.querySelectorAll === 'function'
                ? root
                : document;
        if ( queryRoot && typeof queryRoot.querySelectorAll === 'function' ) {
            for ( const anchor of queryRoot.querySelectorAll('#secondary a[href]') ) {
                candidates.push(anchor);
            }
        }
        const targetUrls = [];
        const seen = new Set();
        for ( const anchor of candidates ) {
            if ( shouldForceDocumentNavigation(anchor) === false ) { continue; }
            if ( typeof anchor.closest === 'function' && anchor.closest('#secondary') === null ) {
                continue;
            }
            const normalizedTargetUrl = normalizeWatchUrl(anchor.href);
            const targetVideoId = getWatchVideoIdFromUrl(normalizedTargetUrl);
            if (
                normalizedTargetUrl === '' ||
                FOLLOWUP_TRACK_A_PREWARM_TARGET_VIDEO_IDS.has(targetVideoId) === false ||
                seen.has(normalizedTargetUrl)
            ) {
                continue;
            }
            seen.add(normalizedTargetUrl);
            targetUrls.push(normalizedTargetUrl);
        }
        return targetUrls;
    };
    const startTrackAPrewarmTarget = targetUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingTrackAPrewarmTargetUrls.has(normalizedTargetUrl) ) { return; }
        pendingTrackAPrewarmTargetUrls.add(normalizedTargetUrl);
        requestFollowupArchitectureProof(
            'prewarm-target',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
            normalizedTargetUrl
        ).catch(() => null).then(() => {
            pendingTrackAPrewarmTargetUrls.delete(normalizedTargetUrl);
        });
    };
    const maybePrewarmTrackATargets = root => {
        for ( const targetUrl of collectTrackAPrewarmTargetUrls(root) ) {
            startTrackAPrewarmTarget(targetUrl);
        }
    };
    const clearPrefetchedFollowupPlayerResponseSections = () => {
        try {
            self.sessionStorage?.removeItem(FOLLOWUP_PLAYER_RESPONSE_PREFETCH_SESSION_KEY);
        } catch {}
    };
    const persistPrefetchedFollowupPlayerResponseSections = (
        targetUrl,
        sections,
        bootstrapEnvelope = null
    ) => {
        if ( sections === null || typeof sections !== 'object' ) { return false; }
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        const targetVideoId = getWatchVideoIdFromUrl(normalizedTargetUrl);
        if ( normalizedTargetUrl === '' || targetVideoId === '' ) { return false; }
        const sectionsSummary = summarizePrefetchedFollowupPlayerResponseSections(sections);
        const envelopeSummary = summarizePrefetchedFollowupBootstrapEnvelope(bootstrapEnvelope);
        const ytInitialData =
            sections.ytInitialData && typeof sections.ytInitialData === 'object'
                ? clonePayload(sections.ytInitialData)
                : null;
        const fullPlayerResponse =
            sections.fullPlayerResponse && typeof sections.fullPlayerResponse === 'object'
                ? clonePayload(sections.fullPlayerResponse)
                : null;
        const streamingData = sections.streamingData && typeof sections.streamingData === 'object'
            ? clonePayload(sections.streamingData)
            : null;
        const playerConfig = sections.playerConfig && typeof sections.playerConfig === 'object'
            ? clonePayload(sections.playerConfig)
            : null;
        const responseContext =
            sections.responseContext && typeof sections.responseContext === 'object'
                ? clonePayload(sections.responseContext)
                : null;
        const playbackTracking =
            sections.playbackTracking && typeof sections.playbackTracking === 'object'
                ? clonePayload(sections.playbackTracking)
                : null;
        const bootstrapEnvelopeClone =
            bootstrapEnvelope && typeof bootstrapEnvelope === 'object'
                ? clonePayload(bootstrapEnvelope)
                : null;
        if (
            fullPlayerResponse === null &&
            (streamingData === null || playerConfig === null)
        ) {
            return false;
        }
        try {
            self.sessionStorage?.setItem(FOLLOWUP_PLAYER_RESPONSE_PREFETCH_SESSION_KEY, JSON.stringify({
                targetUrl: normalizedTargetUrl,
                targetVideoId,
                expiresAt: Date.now() + FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TTL_MS,
                prefetchedAt: Date.now(),
                sections: {
                    ytInitialData,
                    fullPlayerResponse,
                    responseContext,
                    streamingData,
                    playbackTracking,
                    playerConfig,
                },
                bootstrapEnvelope: bootstrapEnvelopeClone,
            }));
            self.__talonYouTubeWatchPrefetchedPlayerResponseTargetUrl = normalizedTargetUrl;
            self.__talonYouTubeWatchPrefetchedPlayerResponseVideoId = targetVideoId;
            self.__talonYouTubeWatchPrefetchedPlayerResponseStoredAt = Date.now();
            self.__talonYouTubeWatchPrefetchedPlayerResponseStoredSummary = sectionsSummary;
            self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeStoredAt = Date.now();
            self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeStoredSummary = envelopeSummary;
            return true;
        } catch {
        }
        return false;
    };
    const readStoredPrefetchedFollowupPlayerResponseSections = () => {
        let raw = '';
        try {
            raw = self.sessionStorage?.getItem(FOLLOWUP_PLAYER_RESPONSE_PREFETCH_SESSION_KEY) || '';
        } catch {
        }
        if ( raw === '' ) { return null; }
        const parsed = safeJsonParse(raw);
        if ( parsed === null || typeof parsed !== 'object' ) {
            clearPrefetchedFollowupPlayerResponseSections();
            return null;
        }
        const normalizedTargetUrl =
            typeof parsed.targetUrl === 'string' ? normalizeWatchUrl(parsed.targetUrl) : '';
        const targetVideoId =
            typeof parsed.targetVideoId === 'string' ? parsed.targetVideoId.trim() : '';
        const expiresAt = Number(parsed.expiresAt) || 0;
        const prefetchedAt = Number(parsed.prefetchedAt) || 0;
        const sections = parsed.sections && typeof parsed.sections === 'object'
            ? parsed.sections
            : null;
        const bootstrapEnvelope =
            parsed.bootstrapEnvelope && typeof parsed.bootstrapEnvelope === 'object'
                ? parsed.bootstrapEnvelope
                : null;
        if (
            normalizedTargetUrl === '' ||
            targetVideoId === '' ||
            expiresAt < Date.now() ||
            sections === null ||
            (
                (sections.fullPlayerResponse === null || typeof sections.fullPlayerResponse !== 'object') &&
                (sections.streamingData === null || sections.playerConfig === null)
            )
        ) {
            clearPrefetchedFollowupPlayerResponseSections();
            return null;
        }
        return {
            targetUrl: normalizedTargetUrl,
            targetVideoId,
            prefetchedAt,
            sections: {
                ytInitialData:
                    sections.ytInitialData && typeof sections.ytInitialData === 'object'
                        ? clonePayload(sections.ytInitialData)
                        : null,
                fullPlayerResponse:
                    sections.fullPlayerResponse && typeof sections.fullPlayerResponse === 'object'
                        ? clonePayload(sections.fullPlayerResponse)
                        : null,
                responseContext:
                    sections.responseContext && typeof sections.responseContext === 'object'
                        ? clonePayload(sections.responseContext)
                        : null,
                streamingData: clonePayload(sections.streamingData),
                playbackTracking:
                    sections.playbackTracking && typeof sections.playbackTracking === 'object'
                        ? clonePayload(sections.playbackTracking)
                        : null,
                playerConfig: clonePayload(sections.playerConfig),
            },
            bootstrapEnvelope:
                bootstrapEnvelope && typeof bootstrapEnvelope === 'object'
                    ? clonePayload(bootstrapEnvelope)
                    : null,
        };
    };
    const extractPrefetchedFollowupPlayerResponseSections = watchDocumentBody => {
        const initialDataLiteral = extractFirstLiteralFromAnchors(
            watchDocumentBody,
            INITIAL_DATA_LITERAL_ANCHORS
        );
        const initialData = safeJsonParse(initialDataLiteral);
        const literal = extractFirstLiteralFromAnchors(watchDocumentBody, PLAYER_RESPONSE_LITERAL_ANCHORS);
        const parsed = safeJsonParse(literal);
        if ( parsed === null || typeof parsed !== 'object' ) { return null; }
        const streamingData = parsed.streamingData && typeof parsed.streamingData === 'object'
            ? parsed.streamingData
            : null;
        const playerConfig = parsed.playerConfig && typeof parsed.playerConfig === 'object'
            ? parsed.playerConfig
            : null;
        const responseContext =
            parsed.responseContext && typeof parsed.responseContext === 'object'
                ? parsed.responseContext
                : null;
        const playbackTracking =
            parsed.playbackTracking && typeof parsed.playbackTracking === 'object'
                ? parsed.playbackTracking
                : null;
        if ( streamingData === null || playerConfig === null ) { return null; }
        return {
            ytInitialData: initialData && typeof initialData === 'object'
                ? initialData
                : null,
            fullPlayerResponse: parsed,
            responseContext,
            streamingData,
            playbackTracking,
            playerConfig,
        };
    };
    const readPrefetchedFollowupPlayerResponseSectionsForCurrentPage = () => {
        const normalizedTargetUrl = normalizeWatchUrl(location.href);
        if ( normalizedTargetUrl === '' ) { return null; }
        const parsed = readStoredPrefetchedFollowupPlayerResponseSections();
        if ( parsed === null || parsed.targetUrl !== normalizedTargetUrl ) {
            return null;
        }
        self.__talonYouTubeWatchPrefetchedPlayerResponseTargetUrl = parsed.targetUrl;
        self.__talonYouTubeWatchPrefetchedPlayerResponseVideoId = parsed.targetVideoId;
        self.__talonYouTubeWatchPrefetchedPlayerResponseAvailable = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponseLoadedAt = Date.now();
        self.__talonYouTubeWatchPrefetchedPlayerResponseLoadedSummary =
            summarizePrefetchedFollowupPlayerResponseSections(parsed.sections);
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeLoadedSummary =
            summarizePrefetchedFollowupBootstrapEnvelope(parsed.bootstrapEnvelope);
        return parsed;
    };
    const readArchitectureProofEntryForCurrentPage = () => {
        if ( isFollowupArchitectureProofMode === false ) { return null; }
        const baselineEntry = readStoredPrefetchedFollowupPlayerResponseSections();
        if ( baselineEntry !== null ) {
            markArchitectureInvalidReason('baseline-handoff-observed');
        }
        if ( usesTrackASessionStorageArchitecture ) {
            const trackBPayloadPresent = typeof self.name === 'string' && self.name !== '';
            if ( trackBPayloadPresent ) {
                try {
                    const parsed = JSON.parse(self.name);
                    if ( parsed?.kind === 'td-yw-track-b-bootstrap-envelope' ) {
                        markArchitectureInvalidReason('cross-track-state-observed');
                    }
                } catch {}
            }
            return readTrackAArchitectureEntryForCurrentPage();
        }
        if ( usesTrackASameOriginCommitArchitecture ) {
            const trackBPayloadPresent = typeof self.name === 'string' && self.name !== '';
            if ( trackBPayloadPresent ) {
                try {
                    const parsed = JSON.parse(self.name);
                    if ( parsed?.kind === 'td-yw-track-b-bootstrap-envelope' ) {
                        markArchitectureInvalidReason('cross-track-state-observed');
                    }
                } catch {}
            }
            if ( readStoredTrackAArchitectureEntry() !== null ) {
                markArchitectureInvalidReason('cross-track-state-observed');
            }
            return readTrackACommitArchitectureEntryForCurrentPage();
        }
        if ( isFollowupArchitectureTrackB ) {
            if ( readStoredTrackAArchitectureEntry() !== null ) {
                markArchitectureInvalidReason('cross-track-state-observed');
            }
            return consumeTrackBArchitectureEntryForCurrentPage();
        }
        return null;
    };
    const pendingPrefetchedFollowupPlayerResponseSections =
        isFollowupArchitectureProofMode
            ? readArchitectureProofEntryForCurrentPage()
            : readPrefetchedFollowupPlayerResponseSectionsForCurrentPage();
    if ( isFollowupArchitectureProofMode && pendingPrefetchedFollowupPlayerResponseSections === null ) {
        self.__talonYouTubeWatchArchitectureDocumentCommitAt = Date.now();
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent = false;
        self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
            usesTrackASessionStorageArchitecture
                ? 'track-a-session-storage'
                : usesTrackASameOriginCommitArchitecture
                    ? 'track-a-same-origin-storage'
                : 'track-b-window-name';
    }
    let consumedPrefetchedFollowupPlayerResponseSectionsKey = '';
    const followupPrefetchDonorToken = readFollowupPrefetchDonorToken();
    let emittedFollowupPrefetchDonorSections = false;
    const followupDonorCaptureState = followupPrefetchDonorToken === ''
        ? null
        : {
            sections: null,
            bootstrapEnvelope: null,
            bootstrapEnvelopeProbeStartedAt: 0,
            bootstrapEnvelopeProbeDeadlineAt: 0,
            firstPayloadBytes: -1,
            firstPayloadHost: '',
            firstPayloadSubstantive: false,
            loadedMetadataSeen: false,
            loadedDataSeen: false,
            emitTimerId: 0,
            settleReadyAt: 0,
        };
    const isPrefetchedFollowupBootstrapEnvelopeReady = envelope => (
        envelope instanceof Object &&
        envelope.ytcfg instanceof Object &&
        envelope.ytInitialPlayerResponse instanceof Object &&
        envelope.ytPlayerConfig instanceof Object &&
        envelope.bootstrapWebPlayerContextConfig instanceof Object
    );
    const markPrefetchedFollowupPlayerResponseApplied = (targetVideoId, source = '') => {
        if ( self.__talonYouTubeWatchPrefetchedPlayerResponseFirstApplied !== true ) {
            self.__talonYouTubeWatchPrefetchedPlayerResponseFirstApplied = true;
            self.__talonYouTubeWatchPrefetchedPlayerResponseFirstAppliedAt = Date.now();
            self.__talonYouTubeWatchPrefetchedPlayerResponseFirstAppliedVideoId =
                typeof targetVideoId === 'string' ? targetVideoId : '';
            self.__talonYouTubeWatchPrefetchedPlayerResponseFirstAppliedSource =
                typeof source === 'string' ? source : '';
        }
        self.__talonYouTubeWatchPrefetchedPlayerResponseApplied = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedAt = Date.now();
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedVideoId =
            typeof targetVideoId === 'string' ? targetVideoId : '';
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedSource =
            typeof source === 'string' ? source : '';
    };
    const getPlayerResponseVideoId = value => {
        if ( value === null || typeof value !== 'object' ) { return ''; }
        const videoDetails = value.videoDetails;
        if ( videoDetails && typeof videoDetails.videoId === 'string' ) {
            return videoDetails.videoId.trim();
        }
        const watchEndpoint = value.currentVideoEndpoint?.watchEndpoint;
        if ( watchEndpoint && typeof watchEndpoint.videoId === 'string' ) {
            return watchEndpoint.videoId.trim();
        }
        return '';
    };
    const applyPrefetchedFollowupPlayerResponseSectionsFromEntry = (value, entry) => {
        if ( value === null || typeof value !== 'object' || entry === null ) {
            return value;
        }
        const consumeKey = `${entry.targetVideoId}:${entry.prefetchedAt}`;
        if ( consumedPrefetchedFollowupPlayerResponseSectionsKey === consumeKey ) {
            return value;
        }
        if (
            entry.sections?.fullPlayerResponse === null &&
            (
                entry.sections?.streamingData === null ||
                entry.sections?.playerConfig === null
            )
        ) {
            return value;
        }
        let clonedValue;
        const prefetchedSummary = summarizePrefetchedFollowupPlayerResponseSections(entry.sections);
        try {
            if (
                entry.sections.fullPlayerResponse &&
                typeof entry.sections.fullPlayerResponse === 'object'
            ) {
                clonedValue = clonePayload(entry.sections.fullPlayerResponse);
            } else {
                clonedValue = clonePayload(value);
                if (
                    entry.sections.responseContext &&
                    typeof entry.sections.responseContext === 'object'
                ) {
                    clonedValue.responseContext = clonePayload(entry.sections.responseContext);
                }
                clonedValue.streamingData = clonePayload(
                    entry.sections.streamingData
                );
                if (
                    entry.sections.playbackTracking &&
                    typeof entry.sections.playbackTracking === 'object'
                ) {
                    clonedValue.playbackTracking = clonePayload(
                        entry.sections.playbackTracking
                    );
                }
                clonedValue.playerConfig = clonePayload(
                    entry.sections.playerConfig
                );
            }
        } catch {
            return value;
        }
        consumedPrefetchedFollowupPlayerResponseSectionsKey = consumeKey;
        clearPrefetchedFollowupPlayerResponseSections();
        markPrefetchedFollowupPlayerResponseApplied(
            entry.targetVideoId,
            entry.sections.fullPlayerResponse ? 'player-response-full' : 'player-response'
        );
        self.__talonYouTubeWatchPrefetchedPlayerResponseAppliedSummary = prefetchedSummary;
        if ( self.__talonYouTubeWatchPrefetchedPlayerResponseFirstAppliedSummary === undefined ) {
            self.__talonYouTubeWatchPrefetchedPlayerResponseFirstAppliedSummary = prefetchedSummary;
        }
        return clonedValue;
    };
    const applyPrefetchedFollowupPlayerResponseSections = value => {
        const targetVideoId = getPlayerResponseVideoId(value) || getCurrentWatchVideoId();
        if (
            pendingPrefetchedFollowupPlayerResponseSections !== null &&
            pendingPrefetchedFollowupPlayerResponseSections.targetVideoId === targetVideoId
        ) {
            return applyPrefetchedFollowupPlayerResponseSectionsFromEntry(
                value,
                pendingPrefetchedFollowupPlayerResponseSections
            );
        }
        if ( targetVideoId === '' ) { return value; }
        const dynamicEntry = readStoredPrefetchedFollowupPlayerResponseSections();
        if ( dynamicEntry === null || dynamicEntry.targetVideoId !== targetVideoId ) {
            return value;
        }
        self.__talonYouTubeWatchPrefetchedPlayerResponseAvailable = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponseLoadedAt = Date.now();
        seedPrefetchedFollowupPlayerResponseFromEntry(dynamicEntry, 'dynamic-read');
        return applyPrefetchedFollowupPlayerResponseSectionsFromEntry(value, dynamicEntry);
    };
    const applyPrefetchedFollowupPlayerResponseSectionsToArgs = args => {
        if ( args === null || typeof args !== 'object' ) { return false; }
        let changed = false;
        for ( const key of [ 'raw_player_response', 'player_response' ] ) {
            const currentValue = args[key];
            const isStringValue = typeof currentValue === 'string' && currentValue !== '';
            const isObjectValue =
                currentValue !== null &&
                typeof currentValue === 'object' &&
                Array.isArray(currentValue) === false;
            if ( isStringValue === false && isObjectValue === false ) { continue; }
            let parsedValue = currentValue;
            if ( isStringValue ) {
                parsedValue = safeJsonParse(currentValue);
            }
            if ( parsedValue === null || typeof parsedValue !== 'object' ) { continue; }
            const nextValue = applyPrefetchedFollowupPlayerResponseSections(parsedValue);
            if ( nextValue === parsedValue ) { continue; }
            try {
                args[key] = isStringValue ? JSON.stringify(nextValue) : nextValue;
                const targetVideoId = getPlayerResponseVideoId(nextValue) || getCurrentWatchVideoId();
                markPrefetchedFollowupPlayerResponseApplied(targetVideoId, `ytplayer-args:${key}`);
                changed = true;
            } catch {}
        }
        return changed;
    };
    const buildPrefetchedFollowupPlayerResponseSeed = entry => {
        if ( entry === null || typeof entry !== 'object' ) { return null; }
        const fullPlayerResponse =
            entry.sections?.fullPlayerResponse &&
            typeof entry.sections.fullPlayerResponse === 'object'
                ? clonePayload(entry.sections.fullPlayerResponse)
                : null;
        if ( fullPlayerResponse !== null ) { return fullPlayerResponse; }
        const streamingData =
            entry.sections?.streamingData &&
            typeof entry.sections.streamingData === 'object'
                ? clonePayload(entry.sections.streamingData)
                : null;
        const playerConfig =
            entry.sections?.playerConfig &&
            typeof entry.sections.playerConfig === 'object'
                ? clonePayload(entry.sections.playerConfig)
                : null;
        if ( streamingData === null || playerConfig === null ) { return null; }
        const nextValue = {
            streamingData,
            playerConfig,
        };
        if (
            entry.sections?.responseContext &&
            typeof entry.sections.responseContext === 'object'
        ) {
            nextValue.responseContext = clonePayload(entry.sections.responseContext);
        }
        if (
            entry.sections?.playbackTracking &&
            typeof entry.sections.playbackTracking === 'object'
        ) {
            nextValue.playbackTracking = clonePayload(entry.sections.playbackTracking);
        }
        const targetVideoId =
            typeof entry.targetVideoId === 'string' ? entry.targetVideoId.trim() : '';
        if ( targetVideoId !== '' ) {
            nextValue.videoDetails = {
                videoId: targetVideoId,
            };
            nextValue.currentVideoEndpoint = {
                watchEndpoint: {
                    videoId: targetVideoId,
                },
            };
        }
        return nextValue;
    };
    const buildPrefetchedFollowupInitialDataSeed = entry => {
        if ( entry === null || typeof entry !== 'object' ) { return null; }
        return entry.sections?.ytInitialData && typeof entry.sections.ytInitialData === 'object'
            ? clonePayload(entry.sections.ytInitialData)
            : null;
    };
    const buildPrefetchedFollowupBootstrapEnvelopeSeed = entry => {
        if ( entry === null || typeof entry !== 'object' ) { return null; }
        const envelope =
            entry.bootstrapEnvelope && typeof entry.bootstrapEnvelope === 'object'
                ? entry.bootstrapEnvelope
                : null;
        if ( envelope === null ) { return null; }
        const ytcfg =
            envelope.ytcfg && typeof envelope.ytcfg === 'object'
                ? clonePayload(envelope.ytcfg)
                : null;
        const ytInitialData =
            envelope.ytInitialData && typeof envelope.ytInitialData === 'object'
                ? clonePayload(envelope.ytInitialData)
                : null;
        const ytInitialPlayerResponse =
            envelope.ytInitialPlayerResponse && typeof envelope.ytInitialPlayerResponse === 'object'
                ? clonePayload(envelope.ytInitialPlayerResponse)
                : null;
        const ytPlayerConfig =
            envelope.ytPlayerConfig && typeof envelope.ytPlayerConfig === 'object'
                ? clonePayload(envelope.ytPlayerConfig)
                : null;
        const rawPlayerResponse =
            envelope.rawPlayerResponse && typeof envelope.rawPlayerResponse === 'object'
                ? clonePayload(envelope.rawPlayerResponse)
                : readPrefetchedFollowupBootstrapRawPlayerResponse(ytPlayerConfig);
        const bootstrapPlayerResponse =
            envelope.bootstrapPlayerResponse && typeof envelope.bootstrapPlayerResponse === 'object'
                ? clonePayload(envelope.bootstrapPlayerResponse)
                : rawPlayerResponse && typeof rawPlayerResponse === 'object'
                    ? clonePayload(rawPlayerResponse)
                    : null;
        const bootstrapWebPlayerContextConfig =
            envelope.bootstrapWebPlayerContextConfig &&
            typeof envelope.bootstrapWebPlayerContextConfig === 'object'
                ? clonePayload(envelope.bootstrapWebPlayerContextConfig)
                : extractPrefetchedFollowupBootstrapWebPlayerContextConfigFromYtcfg(ytcfg)
                    ? clonePayload(
                        extractPrefetchedFollowupBootstrapWebPlayerContextConfigFromYtcfg(ytcfg)
                    )
                    : null;
        const wizGlobalData =
            envelope.wizGlobalData && typeof envelope.wizGlobalData === 'object'
                ? clonePayload(envelope.wizGlobalData)
                : null;
        if (
            ytcfg === null ||
            ytInitialPlayerResponse === null ||
            ytPlayerConfig === null ||
            bootstrapWebPlayerContextConfig === null
        ) {
            return null;
        }
        return {
            ytcfg,
            ytInitialData,
            ytInitialPlayerResponse,
            ytPlayerConfig,
            rawPlayerResponse,
            bootstrapPlayerResponse,
            bootstrapWebPlayerContextConfig,
            wizGlobalData,
        };
    };
    const installManagedPrefetchedFollowupBootstrapEnvelopeFromSeed = (
        seed,
        source = ''
    ) => {
        if ( seed === null || typeof seed !== 'object' ) { return false; }
        const donorYtcfg =
            seed.ytcfg && typeof seed.ytcfg === 'object'
                ? clonePayload(seed.ytcfg)
                : null;
        const donorYtInitialData =
            seed.ytInitialData && typeof seed.ytInitialData === 'object'
                ? clonePayload(seed.ytInitialData)
                : null;
        const donorYtInitialPlayerResponse =
            seed.ytInitialPlayerResponse && typeof seed.ytInitialPlayerResponse === 'object'
                ? clonePayload(seed.ytInitialPlayerResponse)
                : null;
        const donorYtplayerConfig =
            seed.ytPlayerConfig && typeof seed.ytPlayerConfig === 'object'
                ? clonePayload(seed.ytPlayerConfig)
                : {};
        const donorRawPlayerResponse =
            seed.rawPlayerResponse && typeof seed.rawPlayerResponse === 'object'
                ? clonePayload(seed.rawPlayerResponse)
                : donorYtInitialPlayerResponse && typeof donorYtInitialPlayerResponse === 'object'
                    ? clonePayload(donorYtInitialPlayerResponse)
                    : null;
        const donorBootstrapPlayerResponse =
            seed.bootstrapPlayerResponse && typeof seed.bootstrapPlayerResponse === 'object'
                ? clonePayload(seed.bootstrapPlayerResponse)
                : donorRawPlayerResponse && typeof donorRawPlayerResponse === 'object'
                    ? clonePayload(donorRawPlayerResponse)
                    : null;
        const donorBootstrapWebPlayerContextConfig =
            seed.bootstrapWebPlayerContextConfig &&
            typeof seed.bootstrapWebPlayerContextConfig === 'object'
                ? clonePayload(seed.bootstrapWebPlayerContextConfig)
                : null;
        const donorWizGlobalData =
            seed.wizGlobalData && typeof seed.wizGlobalData === 'object'
                ? clonePayload(seed.wizGlobalData)
                : null;
        if (
            donorYtcfg === null ||
            donorYtInitialPlayerResponse === null ||
            donorBootstrapWebPlayerContextConfig === null
        ) {
            return false;
        }
        const mergeTopLevelObject = (target, sourceObject) => {
            if (
                target === null || typeof target !== 'object' ||
                sourceObject === null || typeof sourceObject !== 'object'
            ) {
                return target;
            }
            for ( const [ key, value ] of Object.entries(sourceObject) ) {
                target[key] = clonePayload(value);
            }
            return target;
        };
        const syncPlayerConfigArgs = (configValue, playerResponseValue) => {
            const nextConfig =
                configValue && typeof configValue === 'object'
                    ? clonePayload(configValue)
                    : {};
            const nextArgs =
                nextConfig.args && typeof nextConfig.args === 'object'
                    ? nextConfig.args
                    : {};
            const effectivePlayerResponse =
                playerResponseValue && typeof playerResponseValue === 'object'
                    ? clonePayload(playerResponseValue)
                    : null;
            if ( effectivePlayerResponse !== null ) {
                nextArgs.raw_player_response = JSON.stringify(clonePayload(effectivePlayerResponse));
                nextArgs.player_response = clonePayload(effectivePlayerResponse);
            }
            nextConfig.args = nextArgs;
            return nextConfig;
        };
        const buildManagedYtcfg = value => {
            const next = value && typeof value === 'object' ? value : {};
            const data = next.data_ && typeof next.data_ === 'object' ? next.data_ : {};
            next.data_ = data;
            mergeTopLevelObject(next.data_, donorYtcfg);
            next.d = function() {
                return next.data_ || (next.data_ = {});
            };
            next.get = function(key, fallback) {
                const resolved = next.d();
                return key in resolved ? resolved[key] : fallback;
            };
            next.set = function() {
                if ( arguments.length > 1 ) {
                    next.d()[arguments[0]] = arguments[1];
                    return;
                }
                const value = arguments[0];
                if ( value && typeof value === 'object' ) {
                    mergeTopLevelObject(next.d(), value);
                }
            };
            return next;
        };
        const installWindowValueProperty = (name, initialValue) => {
            let storedValue =
                initialValue && typeof initialValue === 'object'
                    ? clonePayload(initialValue)
                    : initialValue;
            try {
                Object.defineProperty(self, name, {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return storedValue;
                    },
                    set(value) {
                        storedValue =
                            value && typeof value === 'object'
                                ? clonePayload(value)
                                : value;
                    },
                });
            } catch {
                self[name] = storedValue;
            }
            return {
                set(value) {
                    storedValue =
                        value && typeof value === 'object'
                            ? clonePayload(value)
                            : value;
                },
            };
        };
        let storedYtInitialPlayerResponse = clonePayload(donorYtInitialPlayerResponse);
        let storedYtplayerConfig = syncPlayerConfigArgs(
            donorYtplayerConfig,
            donorRawPlayerResponse || donorYtInitialPlayerResponse
        );
        let storedYtcfg = buildManagedYtcfg(self.ytcfg);
        try {
            Object.defineProperty(self, 'ytcfg', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedYtcfg;
                },
                set(value) {
                    storedYtcfg = buildManagedYtcfg(value);
                },
            });
        } catch {
            self.ytcfg = storedYtcfg;
        }
        const ytInitialDataProperty = installWindowValueProperty(
            'ytInitialData',
            donorYtInitialData
        );
        const wizGlobalDataProperty = installWindowValueProperty(
            'WIZ_global_data',
            donorWizGlobalData
        );
        const refreshManagedPlayerConfig = value => {
            const effectivePlayerResponse =
                value && typeof value === 'object'
                    ? clonePayload(value)
                    : storedYtInitialPlayerResponse && typeof storedYtInitialPlayerResponse === 'object'
                        ? clonePayload(storedYtInitialPlayerResponse)
                        : donorRawPlayerResponse && typeof donorRawPlayerResponse === 'object'
                            ? clonePayload(donorRawPlayerResponse)
                            : null;
            storedYtplayerConfig = syncPlayerConfigArgs(storedYtplayerConfig, effectivePlayerResponse);
            try {
                if ( self.ytplayer && typeof self.ytplayer === 'object' ) {
                    self.ytplayer.config = storedYtplayerConfig;
                }
            } catch {}
        };
        const buildManagedYtplayer = value => {
            const base = value && typeof value === 'object' ? value : {};
            let configStore = syncPlayerConfigArgs(
                base.config && typeof base.config === 'object'
                    ? base.config
                    : storedYtplayerConfig,
                storedYtInitialPlayerResponse || donorRawPlayerResponse
            );
            let bootstrapPlayerResponseStore =
                base.bootstrapPlayerResponse && typeof base.bootstrapPlayerResponse === 'object'
                    ? clonePayload(base.bootstrapPlayerResponse)
                    : donorBootstrapPlayerResponse && typeof donorBootstrapPlayerResponse === 'object'
                        ? clonePayload(donorBootstrapPlayerResponse)
                        : null;
            let bootstrapContextStore =
                base.bootstrapWebPlayerContextConfig &&
                typeof base.bootstrapWebPlayerContextConfig === 'object'
                    ? clonePayload(base.bootstrapWebPlayerContextConfig)
                    : clonePayload(donorBootstrapWebPlayerContextConfig);
            try {
                Object.defineProperty(base, 'config', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return configStore;
                    },
                    set(nextValue) {
                        configStore = syncPlayerConfigArgs(
                            nextValue && typeof nextValue === 'object' ? nextValue : {},
                            storedYtInitialPlayerResponse || donorRawPlayerResponse
                        );
                        storedYtplayerConfig = configStore;
                    },
                });
            } catch {
                base.config = configStore;
            }
            try {
                Object.defineProperty(base, 'bootstrapPlayerResponse', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return bootstrapPlayerResponseStore;
                    },
                    set(nextValue) {
                        bootstrapPlayerResponseStore =
                            nextValue && typeof nextValue === 'object'
                                ? clonePayload(nextValue)
                                : nextValue;
                    },
                });
            } catch {
                base.bootstrapPlayerResponse = bootstrapPlayerResponseStore;
            }
            try {
                Object.defineProperty(base, 'bootstrapWebPlayerContextConfig', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return bootstrapContextStore;
                    },
                    set(nextValue) {
                        bootstrapContextStore =
                            nextValue && typeof nextValue === 'object'
                                ? clonePayload(nextValue)
                                : nextValue;
                    },
                });
            } catch {
                base.bootstrapWebPlayerContextConfig = bootstrapContextStore;
            }
            return base;
        };
        let storedYtplayer = buildManagedYtplayer(self.ytplayer);
        try {
            Object.defineProperty(self, 'ytplayer', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedYtplayer;
                },
                set(nextValue) {
                    storedYtplayer = buildManagedYtplayer(nextValue);
                },
            });
        } catch {
            self.ytplayer = storedYtplayer;
        }
        ytInitialDataProperty.set(donorYtInitialData);
        wizGlobalDataProperty.set(donorWizGlobalData);
        try {
            self.ytInitialPlayerResponse = clonePayload(donorYtInitialPlayerResponse);
            storedYtInitialPlayerResponse = clonePayload(donorYtInitialPlayerResponse);
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseeded = true;
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseededAt = Date.now();
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseededSource =
                typeof source === 'string' ? source : '';
        } catch (reason) {
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedError = `${reason}`;
        }
        refreshManagedPlayerConfig(storedYtInitialPlayerResponse);
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeSyncPlayerResponse = value => {
            storedYtInitialPlayerResponse =
                value && typeof value === 'object'
                    ? clonePayload(value)
                    : value;
            refreshManagedPlayerConfig(storedYtInitialPlayerResponse);
        };
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded = true;
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededAt = Date.now();
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededSource =
            typeof source === 'string' ? source : '';
        self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseededSummary =
            summarizePrefetchedFollowupBootstrapEnvelope(seed);
        return true;
    };
    const seedPrefetchedFollowupPlayerResponseFromEntry = (entry, source = '') => {
        self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedAttempted = true;
        self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedAttemptedAt = Date.now();
        self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedAttemptSource =
            typeof source === 'string' ? source : '';
        if ( entry === null || typeof entry !== 'object' ) { return false; }
        const seededInitialData = buildPrefetchedFollowupInitialDataSeed(entry);
        const seededPlayerResponse = buildPrefetchedFollowupPlayerResponseSeed(entry);
        const seededBootstrapEnvelope = buildPrefetchedFollowupBootstrapEnvelopeSeed(entry);
        self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedBuilt =
            seededPlayerResponse !== null ||
            seededInitialData !== null ||
            seededBootstrapEnvelope !== null;
        if (
            seededPlayerResponse === null &&
            seededInitialData === null &&
            seededBootstrapEnvelope === null
        ) {
            return false;
        }
        const bootstrapEnvelopePreseeded =
            seededBootstrapEnvelope !== null &&
            installManagedPrefetchedFollowupBootstrapEnvelopeFromSeed(
                seededBootstrapEnvelope,
                source
            ) === true;
        if ( bootstrapEnvelopePreseeded === false && seededInitialData !== null ) {
            try {
                self.ytInitialData = clonePayload(seededInitialData);
                self.__talonYouTubeWatchPrefetchedInitialDataPreseeded = true;
                self.__talonYouTubeWatchPrefetchedInitialDataPreseededAt = Date.now();
                self.__talonYouTubeWatchPrefetchedInitialDataPreseededSource =
                    typeof source === 'string' ? source : '';
            } catch (reason) {
                self.__talonYouTubeWatchPrefetchedInitialDataPreseedError = `${reason}`;
            }
        }
        try {
            if ( bootstrapEnvelopePreseeded === false && seededPlayerResponse !== null ) {
                self.ytInitialPlayerResponse = clonePayload(seededPlayerResponse);
                self.__talonYouTubeWatchPrefetchedPlayerResponsePreseeded = true;
                self.__talonYouTubeWatchPrefetchedPlayerResponsePreseededAt = Date.now();
                self.__talonYouTubeWatchPrefetchedPlayerResponsePreseededSource =
                    typeof source === 'string' ? source : '';
            }
        } catch (reason) {
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseedError =
                `${reason}`;
        }
        try {
            if ( bootstrapEnvelopePreseeded === false && seededPlayerResponse !== null ) {
                const nextYtplayer =
                    self.ytplayer && typeof self.ytplayer === 'object'
                        ? self.ytplayer
                        : {};
                const nextConfig =
                    nextYtplayer.config && typeof nextYtplayer.config === 'object'
                        ? nextYtplayer.config
                        : {};
                const nextArgs =
                    nextConfig.args && typeof nextConfig.args === 'object'
                        ? nextConfig.args
                        : {};
                nextArgs.raw_player_response = JSON.stringify(clonePayload(seededPlayerResponse));
                nextArgs.player_response = clonePayload(seededPlayerResponse);
                nextConfig.args = nextArgs;
                nextYtplayer.config = nextConfig;
                self.ytplayer = nextYtplayer;
                self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPreseeded = true;
                self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPreseededAt = Date.now();
                self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPreseededSource =
                    typeof source === 'string' ? source : '';
            }
        } catch (reason) {
            self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPreseedError =
                `${reason}`;
        }
        return self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded === true ||
            self.__talonYouTubeWatchPrefetchedInitialDataPreseeded === true ||
            self.__talonYouTubeWatchPrefetchedPlayerResponsePreseeded === true ||
            self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPreseeded === true;
    };
    const preseedPrefetchedFollowupPlayerResponse = () => {
        const entry =
            pendingPrefetchedFollowupPlayerResponseSections !== null
                ? pendingPrefetchedFollowupPlayerResponseSections
                : readPrefetchedFollowupPlayerResponseSectionsForCurrentPage();
        if ( entry === null ) { return; }
        seedPrefetchedFollowupPlayerResponseFromEntry(entry, 'initial-preseed');
    };
    const applyPrefetchedFollowupInitialDataFromEntry = entry => {
        if ( entry === null || typeof entry !== 'object' ) { return null; }
        const seededInitialData = buildPrefetchedFollowupInitialDataSeed(entry);
        return seededInitialData && typeof seededInitialData === 'object'
            ? seededInitialData
            : null;
    };
    const installPrefetchedFollowupInitialDataPatch = () => {
        if ( followupWatchNavigationState.isFollowupNavigation === false ) { return; }
        const resolveEntry = () => {
            if ( pendingPrefetchedFollowupPlayerResponseSections !== null ) {
                return pendingPrefetchedFollowupPlayerResponseSections;
            }
            return readPrefetchedFollowupPlayerResponseSectionsForCurrentPage();
        };
        const applyValue = value => {
            const entry = resolveEntry();
            const targetVideoId =
                typeof entry?.targetVideoId === 'string' ? entry.targetVideoId.trim() : '';
            if ( targetVideoId === '' || targetVideoId !== getCurrentWatchVideoId() ) {
                return value;
            }
            const seededInitialData = applyPrefetchedFollowupInitialDataFromEntry(entry);
            if ( seededInitialData === null ) { return value; }
            self.__talonYouTubeWatchPrefetchedInitialDataApplied = true;
            self.__talonYouTubeWatchPrefetchedInitialDataAppliedAt = Date.now();
            self.__talonYouTubeWatchPrefetchedInitialDataAppliedVideoId = targetVideoId;
            return seededInitialData;
        };
        let storedInitialData = applyValue(self.ytInitialData);
        try {
            const descriptor = Object.getOwnPropertyDescriptor(self, 'ytInitialData');
            if ( descriptor?.configurable === false ) {
                return;
            }
            Object.defineProperty(self, 'ytInitialData', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedInitialData;
                },
                set(value) {
                    storedInitialData = applyValue(value);
                },
            });
        } catch {}
    };
    const installPrefetchedFollowupYtplayerPatch = () => {
        if ( followupWatchNavigationState.isFollowupNavigation === false ) { return; }
        const markArgsPatched = () => {
            if (
                typeof self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPatchedAt !== 'number'
            ) {
                self.__talonYouTubeWatchPrefetchedPlayerResponseArgsPatchedAt = Date.now();
            }
        };
        const installArgsHook = config => {
            if ( config === null || typeof config !== 'object' ) { return false; }
            const hookFlag = '__talonYouTubeWatchArgsHookInstalled';
            if ( config[hookFlag] === true ) {
                return applyPrefetchedFollowupPlayerResponseSectionsToArgs(config.args);
            }
            let storedArgs = config.args;
            let applied = false;
            try {
                applied = applyPrefetchedFollowupPlayerResponseSectionsToArgs(storedArgs) || applied;
            } catch {}
            try {
                const descriptor = Object.getOwnPropertyDescriptor(config, 'args');
                if ( descriptor?.configurable === false ) {
                    config[hookFlag] = true;
                    return applied;
                }
                Object.defineProperty(config, 'args', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return storedArgs;
                    },
                    set(value) {
                        storedArgs = value;
                        try {
                            if ( applyPrefetchedFollowupPlayerResponseSectionsToArgs(storedArgs) ) {
                                markArgsPatched();
                            }
                        } catch {}
                    },
                });
                config[hookFlag] = true;
            } catch {}
            return applied;
        };
        const tryApplyToYtplayer = candidate => {
            const config = candidate?.config;
            if ( config === null || typeof config !== 'object' ) { return false; }
            const applied = installArgsHook(config);
            return applyPrefetchedFollowupPlayerResponseSectionsToArgs(config.args) || applied;
        };
        let applied = false;
        try {
            applied = tryApplyToYtplayer(self.ytplayer) || applied;
        } catch {}
        let storedYtplayer = self.ytplayer;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(self, 'ytplayer');
            if ( descriptor?.configurable === false ) {
                throw new Error('ytplayer-non-configurable');
            }
            if ( typeof descriptor?.get === 'function' || typeof descriptor?.set === 'function' ) {
                throw new Error('ytplayer-accessor-present');
            }
            Object.defineProperty(self, 'ytplayer', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedYtplayer;
                },
                set(value) {
                    storedYtplayer = value;
                    try {
                        if ( tryApplyToYtplayer(storedYtplayer) ) {
                            markArgsPatched();
                        }
                    } catch {}
                },
            });
        } catch {}
        const deadlineAt = Date.now() + 10000;
        const scan = () => {
            try {
                if ( tryApplyToYtplayer(self.ytplayer) ) {
                    markArgsPatched();
                    return;
                }
            } catch {}
            if ( Date.now() >= deadlineAt ) { return; }
            self.setTimeout(scan, 50);
        };
        if ( applied ) {
            markArgsPatched();
        }
        scan();
    };
    const scheduleFollowupPrefetchDonorEmit = (delayMs = 0) => {
        if ( followupDonorCaptureState === null ) { return; }
        if ( followupDonorCaptureState.emitTimerId !== 0 ) { return; }
        followupDonorCaptureState.emitTimerId = self.setTimeout(() => {
            followupDonorCaptureState.emitTimerId = 0;
            tryEmitFollowupPrefetchDonorSections();
        }, delayMs);
    };
    const tryEmitFollowupPrefetchDonorSections = () => {
        if (
            emittedFollowupPrefetchDonorSections === true ||
            followupPrefetchDonorToken === '' ||
            followupDonorCaptureState === null ||
            followupDonorCaptureState.sections === null ||
            followupDonorCaptureState.firstPayloadSubstantive !== true ||
            followupDonorCaptureState.loadedMetadataSeen !== true
        ) {
            return;
        }
        if ( followupDonorCaptureState.settleReadyAt === 0 ) {
            followupDonorCaptureState.settleReadyAt = Date.now() + 150;
            scheduleFollowupPrefetchDonorEmit(175);
            return;
        }
        if ( Date.now() < followupDonorCaptureState.settleReadyAt ) {
            scheduleFollowupPrefetchDonorEmit(
                Math.max(25, followupDonorCaptureState.settleReadyAt - Date.now())
            );
            return;
        }
        const bootstrapEnvelope = extractFollowupPrefetchBootstrapEnvelope();
        if ( isPrefetchedFollowupBootstrapEnvelopeReady(bootstrapEnvelope) === false ) {
            if ( followupDonorCaptureState.bootstrapEnvelopeProbeStartedAt === 0 ) {
                followupDonorCaptureState.bootstrapEnvelopeProbeStartedAt = Date.now();
                followupDonorCaptureState.bootstrapEnvelopeProbeDeadlineAt = Date.now() + 2000;
            }
            self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeReady = false;
            self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeReadyAt = 0;
            self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeProbeStartedAt =
                followupDonorCaptureState.bootstrapEnvelopeProbeStartedAt;
            self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeProbeDeadlineAt =
                followupDonorCaptureState.bootstrapEnvelopeProbeDeadlineAt;
            if ( Date.now() < followupDonorCaptureState.bootstrapEnvelopeProbeDeadlineAt ) {
                scheduleFollowupPrefetchDonorEmit(50);
                return;
            }
            self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeProbeTimedOut = true;
            return;
        }
        followupDonorCaptureState.bootstrapEnvelope = bootstrapEnvelope;
        self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeReady = true;
        self.__talonYouTubeWatchFollowupDonorBootstrapEnvelopeReadyAt = Date.now();
        let sameOriginCommit = null;
        if ( isFollowupArchitectureTrackACommit ) {
            sameOriginCommit = storeTrackACommitArchitectureEntry({
                kind: 'td-yw-architecture-envelope',
                strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT,
                handoffSurface: 'localStorage',
                targetUrl: normalizeWatchUrl(location.href),
                targetVideoId: getCurrentWatchVideoId(),
                prefetchedAt: Date.now(),
                sections: clonePayload(followupDonorCaptureState.sections),
                bootstrapEnvelope: clonePayload(followupDonorCaptureState.bootstrapEnvelope),
                health: {
                    firstPayloadBytes: followupDonorCaptureState.firstPayloadBytes,
                    firstPayloadSubstantive:
                        followupDonorCaptureState.firstPayloadSubstantive === true,
                    firstPayloadHost: followupDonorCaptureState.firstPayloadHost,
                    loadedMetadataSeen:
                        followupDonorCaptureState.loadedMetadataSeen === true,
                    loadedDataSeen:
                        followupDonorCaptureState.loadedDataSeen === true,
                    adShowing: /\bad-showing\b/.test(
                        document.querySelector('#movie_player')?.className || ''
                    ),
                    capturedAt: Date.now(),
                },
                proof: {
                    handoffSurface: 'localStorage',
                },
            });
        }
        emittedFollowupPrefetchDonorSections = true;
        self.__talonYouTubeWatchFollowupDonorCaptured = true;
        self.__talonYouTubeWatchFollowupDonorCapturedAt = Date.now();
        try {
            document.dispatchEvent(new CustomEvent(FOLLOWUP_PREFETCH_DONOR_CAPTURE_EVENT, {
                detail: {
                    donorToken: followupPrefetchDonorToken,
                    targetUrl: normalizeWatchUrl(location.href),
                    targetVideoId: getCurrentWatchVideoId(),
                    sections: clonePayload(followupDonorCaptureState.sections),
                    bootstrapEnvelope: clonePayload(followupDonorCaptureState.bootstrapEnvelope),
                    health: {
                        firstPayloadBytes: followupDonorCaptureState.firstPayloadBytes,
                        firstPayloadSubstantive:
                            followupDonorCaptureState.firstPayloadSubstantive === true,
                        firstPayloadHost: followupDonorCaptureState.firstPayloadHost,
                        loadedMetadataSeen:
                            followupDonorCaptureState.loadedMetadataSeen === true,
                        loadedDataSeen:
                            followupDonorCaptureState.loadedDataSeen === true,
                        adShowing: /\bad-showing\b/.test(
                            document.querySelector('#movie_player')?.className || ''
                        ),
                        capturedAt: Date.now(),
                    },
                    sameOriginCommit,
                },
            }));
        } catch {}
    };
    const extractFollowupPrefetchBootstrapEnvelope = () => {
        const ytcfg =
            self.ytcfg?.data_ && typeof self.ytcfg.data_ === 'object'
                ? clonePayload(self.ytcfg.data_)
                : null;
        const ytInitialData =
            self.ytInitialData && typeof self.ytInitialData === 'object'
                ? clonePayload(self.ytInitialData)
                : null;
        const ytInitialPlayerResponse =
            self.ytInitialPlayerResponse && typeof self.ytInitialPlayerResponse === 'object'
                ? clonePayload(self.ytInitialPlayerResponse)
                : null;
        const ytPlayerConfig =
            self.ytplayer?.config && typeof self.ytplayer.config === 'object'
                ? clonePayload(self.ytplayer.config)
                : null;
        const rawPlayerResponse = readPrefetchedFollowupBootstrapRawPlayerResponse(
            self.ytplayer?.config
        );
        const bootstrapPlayerResponse =
            self.ytplayer?.bootstrapPlayerResponse &&
            typeof self.ytplayer.bootstrapPlayerResponse === 'object'
                ? clonePayload(self.ytplayer.bootstrapPlayerResponse)
                : null;
        const bootstrapWebPlayerContextConfig =
            self.ytplayer?.bootstrapWebPlayerContextConfig &&
            typeof self.ytplayer.bootstrapWebPlayerContextConfig === 'object'
                ? clonePayload(self.ytplayer.bootstrapWebPlayerContextConfig)
                : extractPrefetchedFollowupBootstrapWebPlayerContextConfigFromYtcfg(ytcfg)
                    ? clonePayload(
                        extractPrefetchedFollowupBootstrapWebPlayerContextConfigFromYtcfg(ytcfg)
                    )
                    : null;
        const wizGlobalData =
            self.WIZ_global_data && typeof self.WIZ_global_data === 'object'
                ? clonePayload(self.WIZ_global_data)
                : null;
        const envelope = {
            ytcfg,
            ytInitialData,
            ytInitialPlayerResponse,
            ytPlayerConfig,
            rawPlayerResponse: rawPlayerResponse ? clonePayload(rawPlayerResponse) : null,
            bootstrapPlayerResponse,
            bootstrapWebPlayerContextConfig,
            wizGlobalData,
        };
        if ( isPrefetchedFollowupBootstrapEnvelopeReady(envelope) === false ) {
            return null;
        }
        return envelope;
    };
    const emitFollowupPrefetchDonorSections = value => {
        if (
            emittedFollowupPrefetchDonorSections === true ||
            followupPrefetchDonorToken === '' ||
            followupDonorCaptureState === null ||
            value === null ||
            typeof value !== 'object'
        ) {
            return;
        }
        const streamingData = value.streamingData && typeof value.streamingData === 'object'
            ? value.streamingData
            : null;
        const playerConfig = value.playerConfig && typeof value.playerConfig === 'object'
            ? value.playerConfig
            : null;
        const responseContext =
            value.responseContext && typeof value.responseContext === 'object'
                ? value.responseContext
                : null;
        const playbackTracking =
            value.playbackTracking && typeof value.playbackTracking === 'object'
                ? value.playbackTracking
                : null;
        if ( streamingData === null || playerConfig === null ) { return; }
        followupDonorCaptureState.sections = {
            ytInitialData:
                self.ytInitialData && typeof self.ytInitialData === 'object'
                    ? clonePayload(self.ytInitialData)
                    : null,
            fullPlayerResponse: clonePayload(value),
            responseContext: responseContext ? clonePayload(responseContext) : null,
            streamingData: clonePayload(streamingData),
            playbackTracking: playbackTracking ? clonePayload(playbackTracking) : null,
            playerConfig: clonePayload(playerConfig),
        };
        followupDonorCaptureState.bootstrapEnvelope = extractFollowupPrefetchBootstrapEnvelope();
        tryEmitFollowupPrefetchDonorSections();
    };
    if ( followupDonorCaptureState !== null ) {
        const attachFollowupDonorVideo = video => {
            if ( video === null || followupDonorCaptureState.attachedVideo === video ) { return; }
            followupDonorCaptureState.attachedVideo = video;
            video.addEventListener('loadedmetadata', () => {
                followupDonorCaptureState.loadedMetadataSeen = true;
                self.__talonYouTubeWatchFollowupDonorLoadedMetadata = true;
                self.__talonYouTubeWatchFollowupDonorLoadedMetadataAt = Date.now();
                scheduleFollowupPrefetchDonorEmit(0);
            }, { capture: true });
            video.addEventListener('loadeddata', () => {
                followupDonorCaptureState.loadedDataSeen = true;
                self.__talonYouTubeWatchFollowupDonorLoadedData = true;
                self.__talonYouTubeWatchFollowupDonorLoadedDataAt = Date.now();
                scheduleFollowupPrefetchDonorEmit(0);
            }, { capture: true });
        };
        const scanFollowupDonorVideo = () => {
            const video = document.querySelector('#movie_player video') || document.querySelector('video');
            attachFollowupDonorVideo(video);
        };
        scanFollowupDonorVideo();
        if ( self.MutationObserver ) {
            const rootNode = document.documentElement || document;
            if ( rootNode ) {
                const observer = new MutationObserver(() => {
                    scanFollowupDonorVideo();
                });
                observer.observe(rootNode, {
                    childList: true,
                    subtree: true,
                });
            }
        } else {
            self.setInterval(scanFollowupDonorVideo, 250);
        }
    }
    if ( followupDonorCaptureState !== null && self.PerformanceObserver ) {
        try {
            const donorResourceObserver = new self.PerformanceObserver(list => {
                if ( followupDonorCaptureState.firstPayloadBytes >= 0 ) { return; }
                for ( const entry of list.getEntries() ) {
                    if ( isVideoplaybackResourceUrl(entry.name) === false ) { continue; }
                    const size = Math.max(
                        Number(entry.encodedBodySize) || 0,
                        Number(entry.transferSize) || 0,
                        Number(entry.decodedBodySize) || 0,
                    );
                    let host = '';
                    try {
                        host = new URL(entry.name, location.href).hostname;
                    } catch {}
                    followupDonorCaptureState.firstPayloadBytes = size;
                    followupDonorCaptureState.firstPayloadHost = host;
                    followupDonorCaptureState.firstPayloadSubstantive =
                        size > FOLLOWUP_DONOR_MIN_FIRST_PAYLOAD_BYTES;
                    self.__talonYouTubeWatchFollowupDonorFirstPayloadBytes = size;
                    self.__talonYouTubeWatchFollowupDonorFirstPayloadHost = host;
                    self.__talonYouTubeWatchFollowupDonorFirstPayloadSubstantive =
                        followupDonorCaptureState.firstPayloadSubstantive === true;
                    scheduleFollowupPrefetchDonorEmit(0);
                    break;
                }
            });
            donorResourceObserver.observe({
                type: 'resource',
                buffered: true,
            });
        } catch {}
    }
    const prefetchFollowupPlayerResponseSections = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if (
            normalizedTargetUrl === '' ||
            typeof self.fetch !== 'function' ||
            typeof self.Response === 'undefined'
        ) {
            return Promise.resolve(false);
        }
        self.__talonYouTubeWatchPrefetchedPlayerResponseRequestedAt = Date.now();
        self.__talonYouTubeWatchPrefetchedPlayerResponseRequestedUrl = normalizedTargetUrl;
        let timeoutId = 0;
        let abortController = null;
        if ( typeof self.AbortController === 'function' ) {
            abortController = new self.AbortController();
        }
        const timeoutPromise = new Promise(resolve => {
            timeoutId = self.setTimeout(() => {
                try {
                    abortController?.abort();
                } catch {}
                resolve(false);
            }, FOLLOWUP_PLAYER_RESPONSE_PREFETCH_TIMEOUT_MS);
        });
        const fetchPromise = self.fetch(normalizedTargetUrl, {
            credentials: 'include',
            redirect: 'follow',
            cache: 'no-store',
            signal: abortController?.signal,
        }).then(response => {
            if ( response instanceof Response === false || response.ok === false ) {
                return false;
            }
            return response.text().then(body => {
                const sections = extractPrefetchedFollowupPlayerResponseSections(body);
                if ( sections === null ) { return false; }
                return persistPrefetchedFollowupPlayerResponseSections(normalizedTargetUrl, sections);
            }).catch(() => false);
        }).catch(() => false).finally(() => {
            if ( timeoutId !== 0 ) {
                self.clearTimeout(timeoutId);
            }
        });
        return Promise.race([fetchPromise, timeoutPromise]).then(ok => {
            self.__talonYouTubeWatchPrefetchedPlayerResponseResolvedAt = Date.now();
            self.__talonYouTubeWatchPrefetchedPlayerResponseOk = ok === true;
            return ok === true;
        });
    };
    const requestBackgroundFollowupPlayerResponseSections = targetUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) {
            return Promise.resolve(false);
        }
        const requestId = `td-yw-prefetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        self.__talonYouTubeWatchBackgroundPrefetchRequestedAt = Date.now();
        self.__talonYouTubeWatchBackgroundPrefetchRequestedUrl = normalizedTargetUrl;
        return new Promise(resolve => {
            let settled = false;
            const cleanup = () => {
                document.removeEventListener(FOLLOWUP_PREFETCH_RESPONSE_EVENT, onResponse, true);
                self.clearTimeout(timeoutId);
            };
            const finish = ok => {
                if ( settled ) { return; }
                settled = true;
                cleanup();
                self.__talonYouTubeWatchBackgroundPrefetchResolvedAt = Date.now();
                self.__talonYouTubeWatchBackgroundPrefetchOk = ok === true;
                resolve(ok === true);
            };
            const onResponse = event => {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if ( detail?.requestId !== requestId ) { return; }
                const sections = detail.sections && typeof detail.sections === 'object'
                    ? detail.sections
                    : null;
                const bootstrapEnvelope =
                    detail.bootstrapEnvelope && typeof detail.bootstrapEnvelope === 'object'
                        ? detail.bootstrapEnvelope
                        : null;
                self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedAt = Date.now();
                self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceived =
                    bootstrapEnvelope !== null;
                self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedSummary =
                    summarizePrefetchedFollowupBootstrapEnvelope(bootstrapEnvelope);
                self.__talonYouTubeWatchBackgroundPrefetchError =
                    typeof detail?.error === 'string' ? detail.error : '';
                self.__talonYouTubeWatchBackgroundPrefetchHasBootstrapEnvelope =
                    detail?.hasBootstrapEnvelope === true;
                self.__talonYouTubeWatchBackgroundPrefetchDonorHealth =
                    detail?.health && typeof detail.health === 'object'
                        ? clonePayload(detail.health)
                        : null;
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    backgroundPrefetchBootstrapEnvelopeReceivedAt:
                        self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedAt,
                    backgroundPrefetchBootstrapEnvelopeReceived:
                        self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceived,
                    backgroundPrefetchBootstrapEnvelopeReceivedSummary:
                        self.__talonYouTubeWatchBackgroundPrefetchBootstrapEnvelopeReceivedSummary,
                    backgroundPrefetchError:
                        self.__talonYouTubeWatchBackgroundPrefetchError,
                    backgroundPrefetchHasBootstrapEnvelope:
                        self.__talonYouTubeWatchBackgroundPrefetchHasBootstrapEnvelope,
                    backgroundPrefetchDonorHealth:
                        self.__talonYouTubeWatchBackgroundPrefetchDonorHealth,
                });
                if (
                    sections !== null &&
                    persistPrefetchedFollowupPlayerResponseSections(
                        normalizedTargetUrl,
                        sections,
                        bootstrapEnvelope
                    )
                ) {
                    finish(true);
                    return;
                }
                finish(false);
            };
            const timeoutId = self.setTimeout(() => {
                finish(false);
            }, FOLLOWUP_BACKGROUND_PREFETCH_TIMEOUT_MS);
            document.addEventListener(FOLLOWUP_PREFETCH_RESPONSE_EVENT, onResponse, true);
            try {
                document.dispatchEvent(new CustomEvent(FOLLOWUP_PREFETCH_REQUEST_EVENT, {
                    detail: {
                        requestId,
                        targetUrl: normalizedTargetUrl,
                    },
                }));
            } catch {
                finish(false);
            }
        });
    };
    const triggerCurrentPageFollowupPlayerResponsePrefetch = () => {
        if ( isFollowupArchitectureProofMode ) {
            self.__talonYouTubeWatchArchitectureBaselinePrefetchIgnored = true;
            return;
        }
        if ( followupWatchNavigationState.isFollowupNavigation === false ) { return; }
        const normalizedTargetUrl = normalizeWatchUrl(location.href);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingPrefetchedFollowupPlayerResponseSections !== null ) { return; }
        const stored = readPrefetchedFollowupPlayerResponseSectionsForCurrentPage();
        if ( stored !== null ) {
            seedPrefetchedFollowupPlayerResponseFromEntry(stored, 'current-page-stored');
            return;
        }
        self.__talonYouTubeWatchCurrentPageFollowupPrefetchRequestedAt = Date.now();
        self.__talonYouTubeWatchCurrentPageFollowupPrefetchRequestedUrl = normalizedTargetUrl;
        requestBackgroundFollowupPlayerResponseSections(normalizedTargetUrl).catch(() => false).then(
            ok => ok === true
                ? true
                : prefetchFollowupPlayerResponseSections(normalizedTargetUrl).catch(() => false)
        ).then(ok => {
            self.__talonYouTubeWatchCurrentPageFollowupPrefetchResolvedAt = Date.now();
            self.__talonYouTubeWatchCurrentPageFollowupPrefetchOk = ok === true;
            if ( ok === true ) {
                const stored = readPrefetchedFollowupPlayerResponseSectionsForCurrentPage();
                if ( stored !== null ) {
                    seedPrefetchedFollowupPlayerResponseFromEntry(stored, 'current-page-prefetch');
                }
            }
        });
    };
    triggerCurrentPageFollowupPlayerResponsePrefetch();

    const REWRITE_TRACE_MAX_PATHS = 64;
    const buildTracePath = segments => {
        if ( Array.isArray(segments) === false || segments.length === 0 ) { return ''; }
        let output = '';
        for ( const segment of segments ) {
            if ( typeof segment === 'number' ) {
                output += `[${segment}]`;
                continue;
            }
            if ( typeof segment !== 'string' || segment === '' ) { continue; }
            output += output === '' ? segment : `.${segment}`;
        }
        return output;
    };
    const recordTracePath = (trace, segments) => {
        if ( trace === null || typeof trace !== 'object' ) { return; }
        const path = buildTracePath(segments);
        if ( path === '' ) { return; }
        if ( trace.droppedKeyPaths.includes(path) ) { return; }
        if ( trace.droppedKeyPaths.length >= REWRITE_TRACE_MAX_PATHS ) { return; }
        trace.droppedKeyPaths.push(path);
    };
    const recordTraceRenderer = (trace, rendererType, segments) => {
        if ( trace === null || typeof trace !== 'object' ) { return; }
        if ( typeof rendererType === 'string' && rendererType !== '' ) {
            trace.removedRendererTypes.add(rendererType);
        }
        recordTracePath(trace, segments);
    };
    const resolvePlayerLikePayload = value =>
        value && typeof value === 'object' && value.playerResponse && typeof value.playerResponse === 'object'
            ? value.playerResponse
            : value;
    const collectRendererTypes = (value, out = new Set(), seen = new WeakSet()) => {
        if ( value === null || typeof value !== 'object' ) { return out; }
        if ( seen.has(value) ) { return out; }
        seen.add(value);
        if ( Array.isArray(value) ) {
            for ( const entry of value ) {
                if ( typeof entry === 'string' && DROP_RENDERERS.has(entry) ) {
                    out.add(entry);
                    continue;
                }
                collectRendererTypes(entry, out, seen);
            }
            return out;
        }
        for ( const key of Object.keys(value) ) {
            if ( DROP_RENDERERS.has(key) ) {
                out.add(key);
            }
            collectRendererTypes(value[key], out, seen);
        }
        return out;
    };
    const summarizeRemainingAdMarkers = value => {
        const playerValue = resolvePlayerLikePayload(value);
        if ( playerValue === null || typeof playerValue !== 'object' ) {
            return {
                adPlacementsCount: 0,
                playerAdsCount: 0,
                adSlotsCount: 0,
                adBreakCount: 0,
                rendererTypes: [],
            };
        }
        return {
            adPlacementsCount: Array.isArray(playerValue.adPlacements) ? playerValue.adPlacements.length : 0,
            playerAdsCount: Array.isArray(playerValue.playerAds) ? playerValue.playerAds.length : 0,
            adSlotsCount: Array.isArray(playerValue.adSlots) ? playerValue.adSlots.length : 0,
            adBreakCount: playerValue.adBreakHeartbeatParams ? 1 : 0,
            rendererTypes: Array.from(collectRendererTypes(playerValue)).sort(),
        };
    };
    const summarizePlaybackPreserved = (rawValue, sanitizedValue) => {
        const before = resolvePlayerLikePayload(rawValue);
        const after = resolvePlayerLikePayload(sanitizedValue);
        const roots = [
            'playabilityStatus',
            'streamingData',
            'videoDetails',
            'captions',
            'playbackTracking',
            'responseContext',
            'playerConfig',
        ];
        const out = {};
        for ( const key of roots ) {
            const beforePresent = before && typeof before === 'object' && before[key] !== undefined;
            const afterPresent = after && typeof after === 'object' && after[key] !== undefined;
            out[key] = beforePresent ? afterPresent : true;
        }
        return out;
    };
    const buildRewriteTrace = (surface, source = '', url = '') => ({
        rewriteMode: playerRewriteMode,
        surface,
        source,
        url,
        seenAtEpochMs: Date.now(),
        droppedKeyPaths: [],
        removedRendererTypes: new Set(),
    });
    const finalizeRewriteReport = (surface, rawValue, sanitizedValue, trace) => {
        const report = {
            rewriteMode: playerRewriteMode,
            surface,
            source: typeof trace?.source === 'string' ? trace.source : '',
            url: typeof trace?.url === 'string' ? trace.url : '',
            seenAtEpochMs: typeof trace?.seenAtEpochMs === 'number' ? trace.seenAtEpochMs : Date.now(),
            sanitizedAtEpochMs: Date.now(),
            rawSummary: summarizePlayerResponse(resolvePlayerLikePayload(rawValue)),
            sanitizedSummary: summarizePlayerResponse(resolvePlayerLikePayload(sanitizedValue)),
            droppedKeyPaths: Array.isArray(trace?.droppedKeyPaths) ? trace.droppedKeyPaths.slice() : [],
            removedRendererTypes: Array.from(trace?.removedRendererTypes || []).sort(),
            remainingAdMarkers: summarizeRemainingAdMarkers(sanitizedValue),
            playbackPreserved: summarizePlaybackPreserved(rawValue, sanitizedValue),
        };
        report.changed =
            report.droppedKeyPaths.length !== 0 ||
            report.removedRendererTypes.length !== 0;
        return report;
    };
    const persistRewriteReport = (surface, report) => {
        if ( report === null || typeof report !== 'object' ) { return report; }
        if ( surface === 'player' ) {
            self.__talonYouTubeWatchPlayerResponseSeen = true;
            if ( typeof self.__talonYouTubeWatchPlayerResponseSeenAt !== 'number' ) {
                self.__talonYouTubeWatchPlayerResponseSeenAt = report.seenAtEpochMs;
            }
            self.__talonYouTubeWatchPlayerResponseSanitized = true;
            self.__talonYouTubeWatchPlayerResponseSanitizedAt = report.sanitizedAtEpochMs;
            self.__talonYouTubeWatchPlayerResponseRewriteLastReport = report;
            if (
                self.__talonYouTubeWatchPlayerResponseRewriteFirstReport === undefined ||
                self.__talonYouTubeWatchPlayerResponseRewriteFirstReport === null
            ) {
                self.__talonYouTubeWatchPlayerResponseRewriteFirstReport = report;
            }
            persistSanitizerHealth({
                playerRewriteMode,
                playerResponseSanitized: true,
                playerResponseSanitizedAt: report.sanitizedAtEpochMs,
            });
            return report;
        }
        if ( surface === 'player-bootstrap' ) {
            self.__talonYouTubeWatchPlayerBootstrapSeen = true;
            if ( typeof self.__talonYouTubeWatchPlayerBootstrapSeenAt !== 'number' ) {
                self.__talonYouTubeWatchPlayerBootstrapSeenAt = report.seenAtEpochMs;
            }
            self.__talonYouTubeWatchPlayerBootstrapSanitized = true;
            self.__talonYouTubeWatchPlayerBootstrapSanitizedAt = report.sanitizedAtEpochMs;
            self.__talonYouTubeWatchPlayerBootstrapLastReport = report;
            if (
                self.__talonYouTubeWatchPlayerBootstrapFirstReport === undefined ||
                self.__talonYouTubeWatchPlayerBootstrapFirstReport === null
            ) {
                self.__talonYouTubeWatchPlayerBootstrapFirstReport = report;
            }
            persistSanitizerHealth({
                runtimeLane,
                playerBootstrapSeen: true,
                playerBootstrapSeenAt: self.__talonYouTubeWatchPlayerBootstrapSeenAt,
                playerBootstrapSanitized: true,
                playerBootstrapSanitizedAt: report.sanitizedAtEpochMs,
            });
            return report;
        }
        self.__talonYouTubeWatchBootstrapSanitized = true;
        self.__talonYouTubeWatchBootstrapSanitizedAt = report.sanitizedAtEpochMs;
        self.__talonYouTubeWatchBootstrapRewriteLastReport = report;
        if (
            self.__talonYouTubeWatchBootstrapRewriteFirstReport === undefined ||
            self.__talonYouTubeWatchBootstrapRewriteFirstReport === null
        ) {
            self.__talonYouTubeWatchBootstrapRewriteFirstReport = report;
        }
        persistSanitizerHealth({
            playerRewriteMode,
            bootstrapSanitized: true,
            bootstrapSanitizedAt: report.sanitizedAtEpochMs,
        });
        return report;
    };
    const sanitizePayload = (value, seen = new WeakSet(), trace = null, path = []) => {
        if ( value === null || typeof value !== 'object' ) { return value; }
        if ( seen.has(value) ) { return value; }
        seen.add(value);
        if ( Array.isArray(value) ) {
            for ( let i = value.length - 1; i >= 0; i -= 1 ) {
                const entry = value[i];
                if ( typeof entry === 'string' && DROP_RENDERERS.has(entry) ) {
                    recordTraceRenderer(trace, entry, [ ...path, i ]);
                    value.splice(i, 1);
                    continue;
                }
                sanitizePayload(entry, seen, trace, [ ...path, i ]);
            }
            return value;
        }
        for ( const key of Object.keys(value) ) {
            if ( DROP_KEYS.has(key) ) {
                recordTracePath(trace, [ ...path, key ]);
                delete value[key];
                continue;
            }
            if ( DROP_RENDERERS.has(key) ) {
                recordTraceRenderer(trace, key, [ ...path, key ]);
                delete value[key];
                continue;
            }
            sanitizePayload(value[key], seen, trace, [ ...path, key ]);
        }
        return value;
    };

    const USTREAMER_FLAG_PATCH_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 43, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 28, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_SLOW_START_CONFIG_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 25, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_PRIMARY_VERSION_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 163, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_PRIMARY_DESCRIPTOR_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 164, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_FEATURE_315_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 315, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_FEATURE_317_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 317, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_VERSION_STRING_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 329, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_TIMEOUT_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 331, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_START_BUDGET_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 43, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 3, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_RN1_FIELD_36_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 36, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_RN1_FIELD_39_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 39, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_RN1_FIELD_155_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 5, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 155, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_RN1_FIELD_278_PATH = Object.freeze([
        Object.freeze({ fieldNumber: 5, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 1, occurrenceIndex: 0 }),
        Object.freeze({ fieldNumber: 278, occurrenceIndex: 0 }),
    ]);
    const USTREAMER_STABLE_VERSION_STRING_BYTES = new self.TextEncoder().encode('v20250922_1226.00');
    const base64UrlToBytes = value => {
        if ( typeof value !== 'string' || value === '' ) { return new Uint8Array(0); }
        let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        while ( normalized.length % 4 !== 0 ) {
            normalized += '=';
        }
        const decoded = self.atob(normalized);
        const bytes = new Uint8Array(decoded.length);
        for ( let i = 0; i < decoded.length; i += 1 ) {
            bytes[i] = decoded.charCodeAt(i);
        }
        return bytes;
    };
    const bytesToBase64Url = bytes => {
        let binary = '';
        for ( let offset = 0; offset < bytes.length; offset += 0x8000 ) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return self.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };
    const USTREAMER_RN1_EXACT_TARGET_VALUES = Object.freeze({
        FEPL1Ndjn7U: Object.freeze({
            field36: 14n,
            field39: 69n,
            field155Bytes: base64UrlToBytes('VHRrZ0FReEhRVVVYSHBrK1VxM1JzQXlFeXBDS09vRExaYzJ0'),
            field278Bytes: base64UrlToBytes('Q0FNU0ZCVVZ1TGJKREpVQ25BNkFDdkVDdFFZQVdQMEc'),
        }),
        xAiXGMvhfGs: Object.freeze({
            field36: 15n,
            field39: 61n,
            field155Bytes: base64UrlToBytes('SmZzUmNNQkRjSCtJbkpMSXRuS3E0VksxVSs5Zk8wRXVRVlB2'),
            field278Bytes: base64UrlToBytes('Q0FNU0VoVVh1TGJKREpVQ25BNkFDdkVDdFFZQVdBPT0'),
        }),
    });
    const getUstreamerRn1ExactPatchPlan = targetVideoId => {
        const targetValues =
            typeof targetVideoId === 'string' && targetVideoId !== ''
                ? USTREAMER_RN1_EXACT_TARGET_VALUES[targetVideoId] || null
                : null;
        if ( targetValues === null ) { return null; }
        switch ( runtimeLane ) {
        case RUNTIME_LANE_USTREAMER_RN1_36:
            return {
                id: 'field-36',
                targetValues,
                applyField36: true,
                applyField39: false,
                applyField155: false,
                applyField278: false,
            };
        case RUNTIME_LANE_USTREAMER_RN1_39:
            return {
                id: 'field-39',
                targetValues,
                applyField36: false,
                applyField39: true,
                applyField155: false,
                applyField278: false,
            };
        case RUNTIME_LANE_USTREAMER_RN1_155:
            return {
                id: 'field-155',
                targetValues,
                applyField36: false,
                applyField39: false,
                applyField155: true,
                applyField278: false,
            };
        case RUNTIME_LANE_USTREAMER_RN1_278:
            return {
                id: 'field-278',
                targetValues,
                applyField36: false,
                applyField39: false,
                applyField155: false,
                applyField278: true,
            };
        case RUNTIME_LANE_USTREAMER_RN1_36_39:
            return {
                id: 'field-36-39',
                targetValues,
                applyField36: true,
                applyField39: true,
                applyField155: false,
                applyField278: false,
            };
        case RUNTIME_LANE_USTREAMER_RN1_155_278:
            return {
                id: 'field-155-278',
                targetValues,
                applyField36: false,
                applyField39: false,
                applyField155: true,
                applyField278: true,
            };
        default:
            return null;
        }
    };
    const readProtoVarint = (bytes, offset) => {
        let result = 0n;
        let shift = 0n;
        let position = offset;
        while ( position < bytes.length ) {
            const byte = BigInt(bytes[position]);
            result |= (byte & 0x7Fn) << shift;
            position += 1;
            if ( (byte & 0x80n) === 0n ) {
                return { value: result, nextOffset: position };
            }
            shift += 7n;
        }
        throw new Error('unterminated protobuf varint');
    };
    const encodeProtoVarint = value => {
        let remaining = BigInt(value);
        const out = [];
        while ( remaining >= 0x80n ) {
            out.push(Number((remaining & 0x7Fn) | 0x80n));
            remaining >>= 7n;
        }
        out.push(Number(remaining));
        return new Uint8Array(out);
    };
    const concatProtoBytes = chunks => {
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const out = new Uint8Array(totalLength);
        let offset = 0;
        for ( const chunk of chunks ) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    };
    const parseProtoMessage = bytes => {
        const fields = [];
        let offset = 0;
        while ( offset < bytes.length ) {
            const tag = readProtoVarint(bytes, offset);
            const fieldNumber = Number(tag.value >> 3n);
            const wireType = Number(tag.value & 0x07n);
            offset = tag.nextOffset;
            let rawValue;
            if ( wireType === 0 ) {
                const value = readProtoVarint(bytes, offset);
                rawValue = bytes.slice(offset, value.nextOffset);
                offset = value.nextOffset;
            } else if ( wireType === 1 ) {
                rawValue = bytes.slice(offset, offset + 8);
                offset += 8;
            } else if ( wireType === 2 ) {
                const length = readProtoVarint(bytes, offset);
                const byteLength = Number(length.value);
                offset = length.nextOffset;
                rawValue = bytes.slice(offset, offset + byteLength);
                offset += byteLength;
            } else if ( wireType === 5 ) {
                rawValue = bytes.slice(offset, offset + 4);
                offset += 4;
            } else {
                throw new Error(`unsupported protobuf wire type: ${wireType}`);
            }
            fields.push({ fieldNumber, wireType, rawValue });
        }
        return fields;
    };
    const serializeProtoMessage = fields => {
        const chunks = [];
        for ( const field of fields ) {
            chunks.push(encodeProtoVarint((BigInt(field.fieldNumber) << 3n) | BigInt(field.wireType)));
            if ( field.wireType === 2 ) {
                chunks.push(encodeProtoVarint(field.rawValue.length));
            }
            chunks.push(field.rawValue);
        }
        return concatProtoBytes(chunks);
    };
    const cloneProtoField = field => ({
        fieldNumber: field.fieldNumber,
        wireType: field.wireType,
        rawValue: field.rawValue.slice(),
    });
    const locateProtoFieldIndex = (fields, segment) => {
        let seen = 0;
        for ( let index = 0; index < fields.length; index += 1 ) {
            if ( fields[index].fieldNumber !== segment.fieldNumber ) { continue; }
            if ( seen === segment.occurrenceIndex ) { return index; }
            seen += 1;
        }
        return -1;
    };
    const tryParseNestedProtoField = field => {
        if ( field?.wireType !== 2 || field.rawValue.length === 0 ) { return null; }
        try {
            return parseProtoMessage(field.rawValue);
        } catch {}
        return null;
    };
    const rewriteProtoFieldAtPath = (rootFields, pathSegments, writer) => {
        let currentFields = rootFields;
        const stack = [];
        for ( let depth = 0; depth < pathSegments.length - 1; depth += 1 ) {
            const segment = pathSegments[depth];
            const index = locateProtoFieldIndex(currentFields, segment);
            if ( index === -1 ) { return false; }
            const nestedFields = tryParseNestedProtoField(currentFields[index]);
            if ( nestedFields === null ) { return false; }
            stack.push({ parentFields: currentFields, index });
            currentFields = nestedFields;
        }
        writer(currentFields, pathSegments[pathSegments.length - 1]);
        for ( let depth = stack.length - 1; depth >= 0; depth -= 1 ) {
            const { parentFields, index } = stack[depth];
            parentFields[index] = {
                ...parentFields[index],
                rawValue: serializeProtoMessage(currentFields),
            };
            currentFields = parentFields;
        }
        return true;
    };
    const getProtoFieldAtPath = (rootFields, pathSegments) => {
        let currentFields = rootFields;
        for ( let depth = 0; depth < pathSegments.length - 1; depth += 1 ) {
            const segment = pathSegments[depth];
            const index = locateProtoFieldIndex(currentFields, segment);
            if ( index === -1 ) { return null; }
            const nestedFields = tryParseNestedProtoField(currentFields[index]);
            if ( nestedFields === null ) { return null; }
            currentFields = nestedFields;
        }
        const index = locateProtoFieldIndex(currentFields, pathSegments[pathSegments.length - 1]);
        if ( index === -1 ) { return null; }
        return currentFields[index];
    };
    const setProtoVarintFieldAtPath = (rootFields, pathSegments, value) => {
        const lastSegment = pathSegments[pathSegments.length - 1];
        return rewriteProtoFieldAtPath(rootFields, pathSegments, (fields, targetSegment) => {
            const index = locateProtoFieldIndex(fields, targetSegment);
            const replacement = {
                fieldNumber: lastSegment.fieldNumber,
                wireType: 0,
                rawValue: encodeProtoVarint(value),
            };
            if ( index === -1 ) {
                fields.push(replacement);
                return;
            }
            fields[index] = cloneProtoField(replacement);
        });
    };
    const setProtoBytesFieldAtPath = (rootFields, pathSegments, rawValue) => {
        const lastSegment = pathSegments[pathSegments.length - 1];
        return rewriteProtoFieldAtPath(rootFields, pathSegments, (fields, targetSegment) => {
            const index = locateProtoFieldIndex(fields, targetSegment);
            const replacement = {
                fieldNumber: lastSegment.fieldNumber,
                wireType: 2,
                rawValue: rawValue.slice(),
            };
            if ( index === -1 ) {
                fields.push(replacement);
                return;
            }
            fields[index] = cloneProtoField(replacement);
        });
    };
    const removeProtoFieldAtPath = (rootFields, pathSegments) => rewriteProtoFieldAtPath(
        rootFields,
        pathSegments,
        (fields, targetSegment) => {
            const index = locateProtoFieldIndex(fields, targetSegment);
            if ( index === -1 ) { return; }
            fields.splice(index, 1);
        }
    );
    const maybePatchUstreamerFlag = encodedBlob => {
        if ( ENABLE_USTREAMER_REQUEST_PATCH === false ) { return encodedBlob; }
        if ( typeof encodedBlob !== 'string' || encodedBlob === '' ) { return encodedBlob; }
        const beforeHash = hashTextFragment(encodedBlob);
        try {
            const rootFields = parseProtoMessage(base64UrlToBytes(encodedBlob));
            const currentVideoId = getCurrentWatchVideoId();
            const exactPlan = getUstreamerRn1ExactPatchPlan(currentVideoId);
            const patchedPaths = [];
            const patchedFlag = setProtoVarintFieldAtPath(rootFields, USTREAMER_FLAG_PATCH_PATH, 3n);
            let normalizedSlowProfile = false;
            let removedSlowStartConfig = false;
            if ( ENABLE_USTREAMER_FLAG_PATCH ) {
                const currentSlowStartConfig = getProtoFieldAtPath(rootFields, USTREAMER_SLOW_START_CONFIG_PATH);
                const primaryVersionField = getProtoFieldAtPath(rootFields, USTREAMER_PRIMARY_VERSION_PATH);
                const primaryDescriptorField = getProtoFieldAtPath(rootFields, USTREAMER_PRIMARY_DESCRIPTOR_PATH);
                const stableFeature315Field = getProtoFieldAtPath(rootFields, USTREAMER_STABLE_FEATURE_315_PATH);
                const stableFeature317Field = getProtoFieldAtPath(rootFields, USTREAMER_STABLE_FEATURE_317_PATH);
                const stableVersionStringField = getProtoFieldAtPath(rootFields, USTREAMER_STABLE_VERSION_STRING_PATH);
                const stableTimeoutField = getProtoFieldAtPath(rootFields, USTREAMER_STABLE_TIMEOUT_PATH);
                const stableStartBudgetField = getProtoFieldAtPath(rootFields, USTREAMER_STABLE_START_BUDGET_PATH);
                const stableVersionStringMissing =
                    stableVersionStringField?.wireType !== 2 ||
                    stableVersionStringField.rawValue.length === 0;
                const stableTimeoutDisabled =
                    stableTimeoutField?.wireType !== 0 ||
                    readProtoVarint(stableTimeoutField.rawValue, 0).value === 0n;
                const stableStartBudgetReduced =
                    stableStartBudgetField?.wireType !== 0 ||
                    readProtoVarint(stableStartBudgetField.rawValue, 0).value < 3600000n;
                const shouldNormalizeSlowProfile =
                    stableFeature315Field === null ||
                    stableFeature317Field === null ||
                    stableVersionStringMissing ||
                    stableTimeoutDisabled ||
                    stableStartBudgetReduced;
                if ( shouldNormalizeSlowProfile ) {
                    normalizedSlowProfile =
                        setProtoVarintFieldAtPath(rootFields, USTREAMER_STABLE_FEATURE_315_PATH, 1n) ||
                        normalizedSlowProfile;
                    normalizedSlowProfile =
                        setProtoVarintFieldAtPath(rootFields, USTREAMER_STABLE_FEATURE_317_PATH, 1n) ||
                        normalizedSlowProfile;
                    normalizedSlowProfile =
                        setProtoBytesFieldAtPath(
                            rootFields,
                            USTREAMER_STABLE_VERSION_STRING_PATH,
                            USTREAMER_STABLE_VERSION_STRING_BYTES
                        ) || normalizedSlowProfile;
                    normalizedSlowProfile =
                        setProtoVarintFieldAtPath(rootFields, USTREAMER_STABLE_TIMEOUT_PATH, 5000n) ||
                        normalizedSlowProfile;
                    normalizedSlowProfile =
                        setProtoVarintFieldAtPath(rootFields, USTREAMER_STABLE_START_BUDGET_PATH, 3600000n) ||
                        normalizedSlowProfile;
                }
                const shouldRemoveSlowStartConfig =
                    shouldNormalizeSlowProfile &&
                    currentSlowStartConfig !== null &&
                    primaryVersionField === null &&
                    primaryDescriptorField === null;
                removedSlowStartConfig = shouldRemoveSlowStartConfig
                    ? removeProtoFieldAtPath(rootFields, USTREAMER_SLOW_START_CONFIG_PATH)
                    : false;
            }
            if ( patchedFlag === false ) {
                persistSanitizerHealth({
                    runtimeLane,
                    ustreamerFlagPatchAttempted: true,
                    ustreamerFlagPatchApplied: false,
                    ustreamerFlagPatchBeforeHash: beforeHash,
                    ustreamerFlagPatchReason: 'path-missing',
                });
                return encodedBlob;
            }
            if ( exactPlan ) {
                if ( exactPlan.applyField36 ) {
                    if ( setProtoVarintFieldAtPath(rootFields, USTREAMER_RN1_FIELD_36_PATH, exactPlan.targetValues.field36) ) {
                        patchedPaths.push('1.36');
                    }
                }
                if ( exactPlan.applyField39 ) {
                    if ( setProtoVarintFieldAtPath(rootFields, USTREAMER_RN1_FIELD_39_PATH, exactPlan.targetValues.field39) ) {
                        patchedPaths.push('1.39');
                    }
                }
                if ( exactPlan.applyField155 ) {
                    if ( setProtoBytesFieldAtPath(rootFields, USTREAMER_RN1_FIELD_155_PATH, exactPlan.targetValues.field155Bytes) ) {
                        patchedPaths.push('5.1.1.155');
                    }
                }
                if ( exactPlan.applyField278 ) {
                    if ( setProtoBytesFieldAtPath(rootFields, USTREAMER_RN1_FIELD_278_PATH, exactPlan.targetValues.field278Bytes) ) {
                        patchedPaths.push('5.1.1.278');
                    }
                }
            }
            const patchedBlob = bytesToBase64Url(serializeProtoMessage(rootFields));
            persistSanitizerHealth({
                runtimeLane,
                ustreamerFlagPatchAttempted: true,
                ustreamerFlagPatchApplied: patchedBlob !== encodedBlob,
                ustreamerFlagPatchBeforeHash: beforeHash,
                ustreamerFlagPatchAfterHash: hashTextFragment(patchedBlob),
                ustreamerSlowProfileNormalized: normalizedSlowProfile,
                ustreamerSlowStartConfigRemoved: removedSlowStartConfig,
                ustreamerRn1ExactPatchPlan: exactPlan?.id || null,
                ustreamerRn1ExactPatchTargetVideoId: currentVideoId || '',
                ustreamerRn1ExactPatchAppliedPaths: patchedPaths,
            });
            return patchedBlob;
        } catch ( error ) {
            persistSanitizerHealth({
                runtimeLane,
                ustreamerFlagPatchAttempted: true,
                ustreamerFlagPatchApplied: false,
                ustreamerFlagPatchBeforeHash: beforeHash,
                ustreamerFlagPatchError: `${error}`,
            });
        }
        return encodedBlob;
    };
    const maybePatchPlayerResponseUstreamerConfig = value => {
        if ( ENABLE_USTREAMER_REQUEST_PATCH === false ) { return; }
        if ( value === null || typeof value !== 'object' || Array.isArray(value) ) { return; }
        const config =
            value.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig;
        if ( config && typeof config.videoPlaybackUstreamerConfig === 'string' ) {
            config.videoPlaybackUstreamerConfig = maybePatchUstreamerFlag(
                config.videoPlaybackUstreamerConfig
            );
        }
    };

    const sanitizeInlinePlayerResponse = (value, seen = new WeakSet(), trace = null, path = []) => {
        if ( value === null || typeof value !== 'object' ) { return value; }
        if ( seen.has(value) ) { return value; }
        seen.add(value);
        maybePatchPlayerResponseUstreamerConfig(value);
        if ( Array.isArray(value) ) {
            for ( let i = value.length - 1; i >= 0; i -= 1 ) {
                const entry = value[i];
                if ( typeof entry === 'string' && DROP_RENDERERS.has(entry) ) {
                    recordTraceRenderer(trace, entry, [ ...path, i ]);
                    value.splice(i, 1);
                    continue;
                }
                sanitizeInlinePlayerResponse(entry, seen, trace, [ ...path, i ]);
            }
            return value;
        }
        for ( const key of Object.keys(value) ) {
            if ( INLINE_DROP_KEYS.has(key) ) {
                recordTracePath(trace, [ ...path, key ]);
                delete value[key];
                continue;
            }
            if ( DROP_RENDERERS.has(key) ) {
                recordTraceRenderer(trace, key, [ ...path, key ]);
                delete value[key];
                continue;
            }
            sanitizeInlinePlayerResponse(value[key], seen, trace, [ ...path, key ]);
        }
        return value;
    };

    const sanitizeBootstrapPayloadValue = (value, source = '', url = location.href) => {
        if ( value === null || typeof value !== 'object' ) {
            return { value, report: null };
        }
        const rawValue = clonePayload(value);
        const trace = buildRewriteTrace('bootstrap', source, url);
        const sanitizedValue = sanitizeInlinePlayerResponse(value, new WeakSet(), trace);
        const report = persistRewriteReport(
            'bootstrap',
            finalizeRewriteReport('bootstrap', rawValue, sanitizedValue, trace)
        );
        return {
            value: sanitizedValue,
            report,
        };
    };

    const notePlayerBootstrapDefined = source => {
        if ( typeof self.__talonYouTubeWatchPlayerBootstrapDefinedAt !== 'number' ) {
            self.__talonYouTubeWatchPlayerBootstrapDefinedAt = Date.now();
            self.__talonYouTubeWatchPlayerBootstrapDefinedPerfMs = getNowPerfMs();
            if ( typeof source === 'string' && source !== '' ) {
                self.__talonYouTubeWatchPlayerBootstrapDefinedSource = source;
            }
        }
        persistSanitizerHealth({
            runtimeLane,
            playerBootstrapDefinedAt: self.__talonYouTubeWatchPlayerBootstrapDefinedAt,
        });
    };
    const notePlayerBootstrapIntercepted = source => {
        if ( typeof self.__talonYouTubeWatchPlayerBootstrapInterceptedAt !== 'number' ) {
            self.__talonYouTubeWatchPlayerBootstrapInterceptedAt = Date.now();
            self.__talonYouTubeWatchPlayerBootstrapInterceptedPerfMs = getNowPerfMs();
            if ( typeof source === 'string' && source !== '' ) {
                self.__talonYouTubeWatchPlayerBootstrapInterceptedSource = source;
            }
        }
        persistSanitizerHealth({
            runtimeLane,
            playerBootstrapInterceptedAt: self.__talonYouTubeWatchPlayerBootstrapInterceptedAt,
        });
    };
    const notePlayerBootstrapSeen = source => {
        self.__talonYouTubeWatchPlayerBootstrapSeen = true;
        if ( typeof self.__talonYouTubeWatchPlayerBootstrapSeenAt !== 'number' ) {
            self.__talonYouTubeWatchPlayerBootstrapSeenAt = Date.now();
            self.__talonYouTubeWatchPlayerBootstrapSeenPerfMs = getNowPerfMs();
            if ( typeof source === 'string' && source !== '' ) {
                self.__talonYouTubeWatchPlayerBootstrapSeenSource = source;
            }
        }
        persistSanitizerHealth({
            runtimeLane,
            playerBootstrapSeen: true,
            playerBootstrapSeenAt: self.__talonYouTubeWatchPlayerBootstrapSeenAt,
        });
    };
    const sanitizePlayerBootstrapPayloadValue = (value, source = '', url = location.href) => {
        if ( value === null || typeof value !== 'object' ) {
            return { value, report: null };
        }
        const rawValue = clonePayload(value);
        const trace = buildRewriteTrace('player-bootstrap', source, url);
        const sanitizedValue = sanitizeInlinePlayerResponse(value, new WeakSet(), trace);
        const report = persistRewriteReport(
            'player-bootstrap',
            finalizeRewriteReport('player-bootstrap', rawValue, sanitizedValue, trace)
        );
        return {
            value: sanitizedValue,
            report,
        };
    };

    const sanitizeObjectKeys = (value, trace = null, path = []) => {
        if ( value === null || typeof value !== 'object' || Array.isArray(value) ) { return value; }
        for ( const key of DROP_KEYS ) {
            if ( Object.prototype.hasOwnProperty.call(value, key) ) {
                recordTracePath(trace, [ ...path, key ]);
                delete value[key];
            }
        }
        return value;
    };

    const sanitizeGetWatchPayload = (value, metadata = {}) => {
        if ( value === null || typeof value !== 'object' ) { return value; }
        const rawValue = clonePayload(value);
        const trace = buildRewriteTrace(
            'bootstrap',
            typeof metadata?.source === 'string' ? metadata.source : 'get_watch',
            typeof metadata?.url === 'string' ? metadata.url : location.href
        );
        sanitizeObjectKeys(value, trace);
        if ( value.playerResponse && typeof value.playerResponse === 'object' ) {
            const targetVideoId =
                getPlayerResponseVideoId(value.playerResponse) ||
                getWatchVideoIdFromUrl(location.href);
            const preparedPlayerResponse = applyPrefetchedFollowupPlayerResponseSections(value.playerResponse);
            value.playerResponse = sanitizeInlinePlayerResponse(
                preparedPlayerResponse,
                new WeakSet(),
                trace,
                [ 'playerResponse' ]
            );
            if ( targetVideoId !== '' ) {
                self.__talonYouTubeWatchGetWatchSanitizedVideoId = targetVideoId;
            }
            sanitizeObjectKeys(value.playerResponse, trace, [ 'playerResponse' ]);
        }
        persistRewriteReport('bootstrap', finalizeRewriteReport('bootstrap', rawValue, value, trace));
        return value;
    };

    const sanitizePayloadForMode = (mode, value, metadata = {}) => {
        if ( mode === 'player' ) {
            if ( value === null || typeof value !== 'object' ) { return value; }
            const rawValue = clonePayload(value);
            const trace = buildRewriteTrace(
                'player',
                typeof metadata?.source === 'string' ? metadata.source : 'player',
                typeof metadata?.url === 'string' ? metadata.url : location.href
            );
            const sanitizedValue = sanitizePayload(value, new WeakSet(), trace);
            persistRewriteReport('player', finalizeRewriteReport('player', rawValue, sanitizedValue, trace));
            return sanitizedValue;
        }
        if ( mode === 'get_watch' ) {
            return sanitizeGetWatchPayload(value, metadata);
        }
        return value;
    };

    const summarizePlayerResponse = value => {
        if ( value === null || typeof value !== 'object' ) { return null; }
        const playabilityStatus = value.playabilityStatus || null;
        const streamingData = value.streamingData || null;
        return {
            adPlacementsCount: Array.isArray(value.adPlacements) ? value.adPlacements.length : 0,
            playerAdsCount: Array.isArray(value.playerAds) ? value.playerAds.length : 0,
            adSlotsCount: Array.isArray(value.adSlots) ? value.adSlots.length : 0,
            playabilityStatus: playabilityStatus ? {
                status: playabilityStatus.status || null,
                reason: playabilityStatus.reason || null,
            } : null,
            streamingData: streamingData ? {
                hasStreamingData: true,
                formats: Array.isArray(streamingData.formats) ? streamingData.formats.length : 0,
                adaptiveFormats: Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats.length : 0,
            } : {
                hasStreamingData: false,
                formats: 0,
                adaptiveFormats: 0,
            },
        };
    };

    const installSanitizedGlobal = propertyName => {
        if ( ENABLE_INLINE_PLAYER_RESPONSE_SANITIZER === false || typeof propertyName !== 'string' ) {
            return;
        }
        const applyValue = (value, source) => {
            const preparedValue =
                propertyName === 'ytInitialPlayerResponse'
                    ? applyPrefetchedFollowupPlayerResponseSections(value)
                    : value;
            return sanitizeBootstrapPayloadValue(
                preparedValue,
                `${propertyName}:${source}`,
                location.href
            ).value;
        };
        let storedValue;
        let sawFirstMeaningfulSet = false;
        try {
            storedValue = applyValue(self[propertyName], 'init');
        } catch {
            storedValue = undefined;
        }
        try {
            Object.defineProperty(self, propertyName, {
                configurable: true,
                enumerable: true,
                get() {
                    return storedValue;
                },
                set(value) {
                    emitFollowupPrefetchDonorSections(value);
                    storedValue = applyValue(value, 'set');
                    if (
                        propertyName === 'ytInitialPlayerResponse' &&
                        typeof self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeSyncPlayerResponse === 'function'
                    ) {
                        try {
                            self.__talonYouTubeWatchPrefetchedBootstrapEnvelopeSyncPlayerResponse(
                                storedValue
                            );
                        } catch {}
                    }
                    const summary = summarizePlayerResponse(storedValue);
                    self.__talonYouTubeWatchSanitizerPlayerResponseLastSummary = summary;
                    if ( sawFirstMeaningfulSet || summary === null ) { return; }
                    sawFirstMeaningfulSet = true;
                    self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetAt = Date.now();
                    self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetPerfMs =
                        self.performance && typeof self.performance.now === 'function'
                            ? self.performance.now()
                            : 0;
                    self.__talonYouTubeWatchSanitizerPlayerResponseFirstSetSummary = summary;
                },
            });
        } catch {
            return;
        }
        if ( storedValue && typeof storedValue === 'object' ) {
            sanitizeInlinePlayerResponse(storedValue);
        }
    };

    const installPlayerBootstrapOwnerPatch = () => {
        if ( ENABLE_PLAYER_BOOTSTRAP_OWNER === false ) { return; }
        const OWNER_MARK = '__td_yw_player_bootstrap_owner';
        const CONFIG_OWNER_MARK = '__td_yw_player_bootstrap_config_owner';
        const ARGS_OWNER_MARK = '__td_yw_player_bootstrap_args_owner';
        const markOwned = (target, marker) => {
            if ( target === null || typeof target !== 'object' ) { return false; }
            try {
                if ( target[marker] === true ) { return false; }
                Object.defineProperty(target, marker, {
                    value: true,
                    configurable: true,
                    enumerable: false,
                    writable: false,
                });
                return true;
            } catch {}
            return false;
        };
        const sanitizePlayerBootstrapJsonCandidate = (value, source) => {
            notePlayerBootstrapIntercepted(source);
            if ( value && typeof value === 'object' ) {
                notePlayerBootstrapSeen(source);
                return sanitizePlayerBootstrapPayloadValue(value, source, location.href).value;
            }
            if ( typeof value !== 'string' || value === '' ) { return value; }
            let parsedValue;
            try {
                parsedValue = JSON.parse(value);
            } catch {
                return value;
            }
            if ( parsedValue === null || typeof parsedValue !== 'object' ) { return value; }
            notePlayerBootstrapSeen(source);
            const result = sanitizePlayerBootstrapPayloadValue(parsedValue, source, location.href);
            try {
                return JSON.stringify(result.value);
            } catch {}
            return value;
        };
        const installArgsOwner = (args, source) => {
            if ( args === null || typeof args !== 'object' ) { return args; }
            if ( markOwned(args, ARGS_OWNER_MARK) === false ) {
                for ( const key of [ 'raw_player_response', 'player_response' ] ) {
                    if ( args[key] !== undefined ) {
                        args[key] = sanitizePlayerBootstrapJsonCandidate(
                            args[key],
                            `${source}:${key}:scan`
                        );
                    }
                }
                return args;
            }
            for ( const key of [ 'raw_player_response', 'player_response' ] ) {
                let storedValue = sanitizePlayerBootstrapJsonCandidate(
                    args[key],
                    `${source}:${key}:init`
                );
                try {
                    Object.defineProperty(args, key, {
                        configurable: true,
                        enumerable: true,
                        get() {
                            return storedValue;
                        },
                        set(value) {
                            storedValue = sanitizePlayerBootstrapJsonCandidate(
                                value,
                                `${source}:${key}:set`
                            );
                        },
                    });
                } catch {}
            }
            return args;
        };
        const installConfigOwner = (config, source) => {
            if ( config === null || typeof config !== 'object' ) { return config; }
            if ( markOwned(config, CONFIG_OWNER_MARK) === false ) {
                if ( config.args && typeof config.args === 'object' ) {
                    installArgsOwner(config.args, `${source}:args:scan`);
                }
                return config;
            }
            let argsStore =
                config.args && typeof config.args === 'object'
                    ? installArgsOwner(config.args, `${source}:args:init`)
                    : config.args;
            try {
                Object.defineProperty(config, 'args', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return argsStore;
                    },
                    set(value) {
                        notePlayerBootstrapIntercepted(`${source}:args:set`);
                        argsStore =
                            value && typeof value === 'object'
                                ? installArgsOwner(value, `${source}:args:set`)
                                : value;
                    },
                });
            } catch {}
            return config;
        };
        const installYtplayerOwner = (candidate, source) => {
            const base = candidate && typeof candidate === 'object' ? candidate : {};
            markOwned(base, OWNER_MARK);
            let bootstrapPlayerResponseStore = sanitizePlayerBootstrapJsonCandidate(
                base.bootstrapPlayerResponse,
                `${source}:bootstrapPlayerResponse:init`
            );
            let configStore =
                base.config && typeof base.config === 'object'
                    ? installConfigOwner(base.config, `${source}:config:init`)
                    : base.config;
            try {
                Object.defineProperty(base, 'bootstrapPlayerResponse', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return bootstrapPlayerResponseStore;
                    },
                    set(value) {
                        bootstrapPlayerResponseStore = sanitizePlayerBootstrapJsonCandidate(
                            value,
                            `${source}:bootstrapPlayerResponse:set`
                        );
                    },
                });
            } catch {}
            try {
                Object.defineProperty(base, 'config', {
                    configurable: true,
                    enumerable: true,
                    get() {
                        return configStore;
                    },
                    set(value) {
                        notePlayerBootstrapIntercepted(`${source}:config:set`);
                        configStore =
                            value && typeof value === 'object'
                                ? installConfigOwner(value, `${source}:config:set`)
                                : value;
                    },
                });
            } catch {}
            if ( base.bootstrapPlayerResponse !== bootstrapPlayerResponseStore ) {
                try {
                    base.bootstrapPlayerResponse = bootstrapPlayerResponseStore;
                } catch {}
            }
            if ( base.config !== configStore ) {
                try {
                    base.config = configStore;
                } catch {}
            }
            return base;
        };

        notePlayerBootstrapDefined('ytplayer-owner:install');
        let storedYtplayer = installYtplayerOwner(self.ytplayer, 'ytplayer:init');
        try {
            const descriptor = Object.getOwnPropertyDescriptor(self, 'ytplayer');
            if ( descriptor?.configurable === false ) {
                throw new Error('ytplayer-non-configurable');
            }
            Object.defineProperty(self, 'ytplayer', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedYtplayer;
                },
                set(value) {
                    notePlayerBootstrapIntercepted('window.ytplayer:set');
                    storedYtplayer = installYtplayerOwner(value, 'ytplayer:set');
                },
            });
        } catch {}
        try {
            if ( storedYtplayer && typeof storedYtplayer === 'object' ) {
                self.ytplayer = storedYtplayer;
            }
        } catch {}
        const deadlineAt = Date.now() + 10000;
        const scan = () => {
            try {
                storedYtplayer = installYtplayerOwner(self.ytplayer, 'ytplayer:scan');
            } catch {}
            if ( Date.now() >= deadlineAt ) { return; }
            self.setTimeout(scan, 25);
        };
        scan();
    };

    const installBootstrapAlignmentPatch = () => {
        if ( ENABLE_BOOTSTRAP_ALIGNMENT === false ) { return; }
        const sanitizeArgs = (args, source) => {
            if ( args === null || typeof args !== 'object' ) { return false; }
            let changed = false;
            for ( const key of [ 'raw_player_response', 'player_response' ] ) {
                const currentValue = args[key];
                if ( currentValue && typeof currentValue === 'object' ) {
                    const result = sanitizeBootstrapPayloadValue(
                        currentValue,
                        `${source}:${key}`,
                        location.href
                    );
                    args[key] = result.value;
                    changed = result.report?.changed === true || changed;
                    continue;
                }
                if ( typeof currentValue !== 'string' || currentValue === '' ) { continue; }
                let parsedValue;
                try {
                    parsedValue = JSON.parse(currentValue);
                } catch {
                    continue;
                }
                if ( parsedValue === null || typeof parsedValue !== 'object' ) { continue; }
                const result = sanitizeBootstrapPayloadValue(
                    parsedValue,
                    `${source}:${key}`,
                    location.href
                );
                try {
                    args[key] = JSON.stringify(result.value);
                    changed = result.report?.changed === true || changed;
                } catch {}
            }
            return changed;
        };
        const sanitizeYtplayer = (candidate, source) => {
            if ( candidate === null || typeof candidate !== 'object' ) { return false; }
            let changed = false;
            if (
                candidate.bootstrapPlayerResponse &&
                typeof candidate.bootstrapPlayerResponse === 'object'
            ) {
                const result = sanitizeBootstrapPayloadValue(
                    candidate.bootstrapPlayerResponse,
                    `${source}:bootstrapPlayerResponse`,
                    location.href
                );
                candidate.bootstrapPlayerResponse = result.value;
                changed = result.report?.changed === true || changed;
            }
            if ( sanitizeArgs(candidate?.config?.args, `${source}:config.args`) ) {
                changed = true;
            }
            return changed;
        };
        try {
            sanitizeYtplayer(self.ytplayer, 'ytplayer:init');
        } catch {}
        let storedYtplayer = self.ytplayer;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(self, 'ytplayer');
            if ( descriptor?.configurable === false ) {
                throw new Error('ytplayer-non-configurable');
            }
            Object.defineProperty(self, 'ytplayer', {
                configurable: true,
                enumerable: true,
                get() {
                    return storedYtplayer;
                },
                set(value) {
                    storedYtplayer = value;
                    try {
                        sanitizeYtplayer(storedYtplayer, 'ytplayer:set');
                    } catch {}
                },
            });
        } catch {}
        const deadlineAt = Date.now() + 10000;
        const scan = () => {
            try {
                if ( sanitizeYtplayer(self.ytplayer, 'ytplayer:scan') ) {
                    return;
                }
            } catch {}
            if ( Date.now() >= deadlineAt ) { return; }
            self.setTimeout(scan, 50);
        };
        scan();
    };

    const installWindowFetchNeutralizer = () => {
        if ( ENABLE_UPSTREAM_WINDOW_FETCH_NEUTRALIZER === false ) { return; }
        if ( self.__talonYouTubeWatchWindowFetchNeutralizerInstalled === true ) { return; }
        self.__talonYouTubeWatchWindowFetchNeutralizerInstalled = true;
        self.__talonYouTubeWatchWindowFetchNeutralizedScriptCount = 0;
        const WINDOW_FETCH_INLINE_RE = /window,\s*"fetch"/;
        const noteNeutralizedScript = source => {
            self.__talonYouTubeWatchWindowFetchNeutralizedScriptCount += 1;
            self.__talonYouTubeWatchWindowFetchNeutralizedAt = Date.now();
            self.__talonYouTubeWatchWindowFetchNeutralizedLastSource =
                typeof source === 'string' ? source : '';
            persistSanitizerHealth({
                runtimeLane,
                ownerProfile,
                windowFetchNeutralizedScriptCount:
                    self.__talonYouTubeWatchWindowFetchNeutralizedScriptCount,
                windowFetchNeutralizedAt: self.__talonYouTubeWatchWindowFetchNeutralizedAt,
            });
        };
        const neutralizeInlineScript = (candidate, source) => {
            if ( self.HTMLScriptElement === undefined || candidate instanceof self.HTMLScriptElement === false ) {
                return false;
            }
            const src = candidate.getAttribute('src') || candidate.src || '';
            if ( src !== '' ) { return false; }
            const text = candidate.textContent || candidate.innerText || '';
            if ( text === '' || WINDOW_FETCH_INLINE_RE.test(text) === false ) {
                return false;
            }
            try { candidate.textContent = ''; } catch {}
            try { candidate.type = 'application/x-talon-noop'; } catch {}
            noteNeutralizedScript(source);
            return true;
        };
        const neutralizeNodeTree = (node, source) => {
            if ( node === null || typeof node !== 'object' ) { return false; }
            let changed = false;
            if ( neutralizeInlineScript(node, source) ) {
                changed = true;
            }
            if ( typeof node.querySelectorAll === 'function' ) {
                for ( const script of node.querySelectorAll('script') ) {
                    if ( neutralizeInlineScript(script, source) ) {
                        changed = true;
                    }
                }
            }
            return changed;
        };
        const patchNodeInsert = methodName => {
            const target = self.Node && self.Node.prototype
                ? self.Node.prototype[methodName]
                : undefined;
            if ( typeof target !== 'function' ) { return; }
            self.Node.prototype[methodName] = new Proxy(target, {
                apply(original, thisArg, args) {
                    neutralizeNodeTree(args[0], `node:${methodName}`);
                    return Reflect.apply(original, thisArg, args);
                },
            });
        };
        patchNodeInsert('appendChild');
        patchNodeInsert('insertBefore');
        patchNodeInsert('replaceChild');
        try {
            if ( document?.documentElement ) {
                neutralizeNodeTree(document.documentElement, 'document-scan');
            }
        } catch {}
    };

    installWindowFetchNeutralizer();
    preseedPrefetchedFollowupPlayerResponse();
    if ( self.__talonYouTubeWatchPrefetchedBootstrapEnvelopePreseeded !== true ) {
        installPrefetchedFollowupInitialDataPatch();
        installPrefetchedFollowupYtplayerPatch();
    }
    installSanitizedGlobal('ytInitialPlayerResponse');
    installPlayerBootstrapOwnerPatch();
    installBootstrapAlignmentPatch();

    const walkObjects = (value, visitor) => {
        if ( value === null || typeof value !== 'object' ) { return; }
        visitor(value);
        if ( Array.isArray(value) ) {
            for ( const entry of value ) {
                walkObjects(entry, visitor);
            }
            return;
        }
        for ( const entry of Object.values(value) ) {
            walkObjects(entry, visitor);
        }
    };

    const patchPlayerRequestPayload = payload => {
        if ( payload === null || typeof payload !== 'object' ) { return false; }
        let changed = false;
        walkObjects(payload, node => {
            if ( Array.isArray(node) || node === null || typeof node !== 'object' ) {
                return;
            }
            if ( typeof node.userAgent !== 'string' ) { return; }
            const userAgent = node.userAgent;
            const shouldSetChannelScreen = userAgent.includes('channel');
            const shouldReloadReferer = PLAYER_REFERER_RELOAD_RE.test(userAgent);
            if ( shouldSetChannelScreen === false && shouldReloadReferer === false ) {
                return;
            }
            walkObjects(node, candidate => {
                if ( Array.isArray(candidate) || candidate === null || typeof candidate !== 'object' ) {
                    return;
                }
                if (
                    shouldSetChannelScreen &&
                    candidate.clientName === 'WEB' &&
                    candidate.clientScreen !== 'CHANNEL'
                ) {
                    candidate.clientScreen = 'CHANNEL';
                    changed = true;
                }
                if (
                    shouldReloadReferer &&
                    typeof candidate.referer === 'string' &&
                    candidate.referer.endsWith('#reloadxhr') === false
                ) {
                    candidate.referer = `${candidate.referer}#reloadxhr`;
                    changed = true;
                }
            });
        });
        return changed;
    };

    const patchPlayerRequestBody = body => {
        if ( typeof body !== 'string' ) { return body; }
        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return body;
        }
        if ( patchPlayerRequestPayload(payload) === false ) {
            return body;
        }
        return JSON.stringify(payload);
    };

    const buildStubId = () => {
        const bytes = new Uint8Array(72);
        if ( self.crypto && typeof self.crypto.getRandomValues === 'function' ) {
            self.crypto.getRandomValues(bytes);
        } else {
            for ( let i = 0; i < bytes.length; i += 1 ) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }
        return Array.from(bytes, byte => STUB_ALPHABET[byte % STUB_ALPHABET.length]).join('');
    };

    const buildPageadIdResponseText = () =>
        `)]}'\n\n{"id":"ANyPxKr${buildStubId()}","type":4}`;

    const buildStubProfile = url => {
        if ( typeof url !== 'string' || url === '' ) { return null; }
        if ( shouldStubPageadId(url) ) {
            return {
                status: 200,
                statusText: 'OK',
                body: buildPageadIdResponseText(),
                headersText: STUB_HEADER_TEXT,
                contentType: 'application/json; charset=utf-8',
            };
        }
        if ( shouldStubLogEvent(url) ) {
            return {
                status: 200,
                statusText: 'OK',
                body: '{}',
                headersText: STUB_HEADER_TEXT,
                contentType: 'application/json; charset=utf-8',
            };
        }
        if ( shouldStubNoContent(url) || shouldStubPixelImage(url) || shouldStubAdMediaFetch(url) ) {
            return {
                status: 204,
                statusText: 'No Content',
                body: '',
                headersText: 'cache-control: no-cache\r\n',
                contentType: '',
            };
        }
        return null;
    };
    const buildAdMediaFetchStubProfile = url => {
        if ( shouldStubAdMediaFetch(url) === false ) { return null; }
        return {
            status: 204,
            statusText: 'No Content',
            body: '',
            headersText: 'cache-control: no-cache\r\n',
            contentType: '',
        };
    };

    const buildTextResponse = (url, text) => {
        const response = new Response(text, {
            status: 200,
            statusText: 'OK',
            headers: {
                'cache-control': 'no-cache',
                'content-type': 'application/json; charset=utf-8',
            },
        });
        Object.defineProperties(response, {
            ok: { value: true },
            redirected: { value: false },
            type: { value: 'basic' },
            url: { value: url },
        });
        return response;
    };

    const buildNoContentResponse = url => {
        const response = new Response(null, {
            status: 204,
            statusText: 'No Content',
            headers: {
                'cache-control': 'no-cache',
            },
        });
        Object.defineProperties(response, {
            ok: { value: true },
            redirected: { value: false },
            type: { value: 'basic' },
            url: { value: url },
        });
        return response;
    };

    const buildFetchStubResponse = (url, stubProfile) => {
        if ( stubProfile === null || typeof stubProfile !== 'object' ) { return null; }
        if ( stubProfile.status === 204 ) {
            return buildNoContentResponse(url);
        }
        return buildTextResponse(url, stubProfile.body || '');
    };

    const rebuildJsonResponse = (responseBefore, payload) => {
        const headers = new Headers(responseBefore.headers);
        headers.delete('content-length');
        const responseAfter = Response.json(payload, {
            status: responseBefore.status,
            statusText: responseBefore.statusText,
            headers,
        });
        Object.defineProperties(responseAfter, {
            ok: { value: responseBefore.ok },
            redirected: { value: responseBefore.redirected },
            type: { value: responseBefore.type },
            url: { value: responseBefore.url },
        });
        return responseAfter;
    };

    const getRequestUrl = input => {
        if ( typeof input === 'string' ) { return input; }
        if ( input && typeof input.url === 'string' ) { return input.url; }
        return '';
    };

    const getCurrentVideo = () => {
        const currentVideo = document.querySelector('video');
        return currentVideo instanceof self.HTMLMediaElement ? currentVideo : null;
    };
    const createFollowupNextDelayGate = () => {
        if ( followupWatchNavigationState.isFollowupNavigation === false ) {
            return {
                shouldDelay() {
                    return false;
                },
                wait() {
                    return Promise.resolve();
                },
            };
        }
        let released = false;
        let timeoutId = 0;
        let resolveWait;
        const waitPromise = new Promise(resolve => {
            resolveWait = resolve;
        });
        const release = reason => {
            if ( released ) { return; }
            released = true;
            if ( timeoutId !== 0 ) {
                self.clearTimeout(timeoutId);
                timeoutId = 0;
            }
            self.__talonYouTubeWatchFollowupNextDelayed = true;
            self.__talonYouTubeWatchFollowupNextReleasedAt = Date.now();
            self.__talonYouTubeWatchFollowupNextReleasedPerfMs = getNowPerfMs();
            self.__talonYouTubeWatchFollowupNextReleaseReason = reason;
            if ( reason !== 'timeout' ) {
                try {
                    document.dispatchEvent(new CustomEvent(FOLLOWUP_NEXT_RELEASE_EVENT));
                } catch {}
            }
            resolveWait();
        };
        timeoutId = self.setTimeout(() => {
            release('timeout');
        }, FOLLOWUP_NEXT_DELAY_TIMEOUT_MS);
        const isVideoPlayableEnough = video =>
            video !== null &&
            video.closest('#movie_player') !== null &&
            (
                (typeof video.readyState === 'number' && video.readyState >= 3) ||
                (Number.isFinite(video.currentTime) && video.currentTime > 0.25)
            );
        const attachToVideo = video => {
            if ( released || video === null ) { return; }
            if ( video.closest('#movie_player') === null ) { return; }
            if ( isVideoPlayableEnough(video) ) {
                release('playable');
                return;
            }
            video.addEventListener('loadeddata', () => {
                if ( isVideoPlayableEnough(video) ) {
                    release('loadeddata');
                }
            }, { capture: true, once: true });
            video.addEventListener('canplay', () => {
                if ( isVideoPlayableEnough(video) ) {
                    release('canplay');
                }
            }, { capture: true, once: true });
            video.addEventListener('playing', () => {
                if ( isVideoPlayableEnough(video) ) {
                    release('playing');
                }
            }, { capture: true, once: true });
            video.addEventListener('timeupdate', () => {
                if ( isVideoPlayableEnough(video) ) {
                    release('timeupdate');
                }
            }, { capture: true, once: true });
        };
        const scanCurrentVideo = () => {
            attachToVideo(getCurrentVideo());
        };
        scanCurrentVideo();
        if ( released === false && self.MutationObserver ) {
            const root = document.documentElement || document;
            if ( root ) {
                const observer = new MutationObserver(() => {
                    if ( released ) {
                        observer.disconnect();
                        return;
                    }
                    scanCurrentVideo();
                });
                observer.observe(root, {
                    childList: true,
                    subtree: true,
                });
            }
        }
        return {
            shouldDelay() {
                return released === false;
            },
            wait() {
                self.__talonYouTubeWatchFollowupNextDelayStartedAt = Date.now();
                self.__talonYouTubeWatchFollowupNextDelayStartedPerfMs = getNowPerfMs();
                return waitPromise;
            },
        };
    };
    const followupNextDelayGate = createFollowupNextDelayGate();

    const NativeFetch = typeof self.fetch === 'function'
        ? self.fetch
        : undefined;
    if (
        (ENABLE_AD_ENDPOINT_FETCH_STUBS || ENABLE_AD_MEDIA_FETCH_STUBS || followupWatchNavigationState.isFollowupNavigation) &&
        typeof NativeFetch === 'function'
    ) {
        self.fetch = new Proxy(NativeFetch, {
            apply(target, thisArg, args) {
                const url = getRequestUrl(args[0]);
                const stubProfile =
                    buildAdMediaFetchStubProfile(url) ||
                    (ENABLE_AD_ENDPOINT_FETCH_STUBS ? buildStubProfile(url) : null);
                if ( stubProfile ) {
                    noteStubbedEndpoint(url, 'fetch');
                    return Promise.resolve(buildFetchStubResponse(url, stubProfile));
                }
                if ( shouldSuppressPendingFollowupNextRequest(url) ) {
                    self.__talonYouTubeWatchFollowupNextSuppressedAt = Date.now();
                    self.__talonYouTubeWatchFollowupNextSuppressedPerfMs = getNowPerfMs();
                    self.__talonYouTubeWatchFollowupNextSuppressedRequestUrl = url;
                    return Promise.resolve(buildTextResponse(url, '{}'));
                }
                if ( shouldDelayFollowupNextRequest(url) && followupNextDelayGate.shouldDelay() ) {
                    self.__talonYouTubeWatchFollowupNextDelayedRequestUrl = url;
                    return followupNextDelayGate.wait().then(() =>
                        Reflect.apply(target, thisArg, args)
                    );
                }
                return Reflect.apply(target, thisArg, args);
            },
        });
    }

    const teardownCurrentVideo = () => {
        const currentVideo = document.querySelector('video');
        if ( currentVideo instanceof self.HTMLMediaElement ) {
            try { currentVideo.pause(); } catch {}
            try { currentVideo.removeAttribute('src'); } catch {}
            try { currentVideo.load(); } catch {}
        }
    };
    const getMoviePlayer = () => document.getElementById('movie_player');
    const installReplayPoisonedBootstrapGuard = () => {
        if ( followupWatchNavigationState.isFollowupNavigation === false ) { return; }
        if ( self.HTMLMediaElement === undefined ) { return; }
        const currentWatchUrl = normalizeWatchUrl(location.href);
        const state = {
            attachedVideo: null,
            firstPlayBeforeMetadataPerfMs: 0,
            firstWaitingBeforeMetadataPerfMs: 0,
            firstLoadedMetadataPerfMs: 0,
            firstPayloadBytes: -1,
            firstPayloadHost: '',
            firstAlternateHost: '',
            firstAlternateHostPerfMs: 0,
            recoveryTriggered: false,
        };
        const maybeTriggerRecovery = reason => {
            if ( state.recoveryTriggered ) { return; }
            if ( state.attachedVideo === null ) { return; }
            if ( state.firstPlayBeforeMetadataPerfMs === 0 ) { return; }
            if ( state.firstWaitingBeforeMetadataPerfMs === 0 ) { return; }
            if ( state.firstLoadedMetadataPerfMs !== 0 ) { return; }
            if ( state.firstPayloadBytes < 0 || state.firstPayloadBytes > REPLAY_POISON_FIRST_PAYLOAD_MAX_BYTES ) {
                return;
            }
            if ( state.attachedVideo.readyState !== 0 ) { return; }
            state.recoveryTriggered = true;
            self.__talonYouTubeWatchReplayPoisonPatternTriggered = true;
            self.__talonYouTubeWatchReplayPoisonPatternTriggeredAt = Date.now();
            self.__talonYouTubeWatchReplayPoisonPatternTriggeredPerfMs = getNowPerfMs();
            self.__talonYouTubeWatchReplayPoisonPatternReason = reason;
            self.__talonYouTubeWatchReplayRecoveryMode = REPLAY_POISON_RECOVERY_MODE;
            try { state.attachedVideo.pause(); } catch {}
            if ( REPLAY_POISON_RECOVERY_MODE === 'pause-stop' ) {
                const player = getMoviePlayer();
                if ( player && typeof player.stopVideo === 'function' ) {
                    try { player.stopVideo(); } catch {}
                }
                return;
            }
            if ( REPLAY_POISON_RECOVERY_MODE === 'pause-delayed-play' ) {
                self.setTimeout(() => {
                    if ( normalizeWatchUrl(location.href) !== currentWatchUrl ) { return; }
                    const currentVideo = getCurrentVideo();
                    if ( currentVideo && currentVideo.readyState >= 1 ) { return; }
                    const nextPlayer = getMoviePlayer();
                    if ( nextPlayer && typeof nextPlayer.playVideo === 'function' ) {
                        try { nextPlayer.playVideo(); } catch {}
                    }
                }, REPLAY_POISON_RECOVERY_DELAY_MS);
            }
        };
        const noteFirstPayload = entry => {
            if ( state.firstPayloadBytes !== -1 ) { return; }
            const size = Math.max(
                Number(entry.encodedBodySize) || 0,
                Number(entry.transferSize) || 0,
                Number(entry.decodedBodySize) || 0,
            );
            let host = '';
            try {
                host = new URL(entry.name, location.href).hostname;
            } catch {}
            state.firstPayloadBytes = size;
            state.firstPayloadHost = host;
            self.__talonYouTubeWatchReplayFirstPayloadBytes = size;
            self.__talonYouTubeWatchReplayFirstPayloadHost = host;
            self.__talonYouTubeWatchReplayFirstPayloadTiny =
                size >= 0 && size <= REPLAY_POISON_FIRST_PAYLOAD_MAX_BYTES;
            if ( state.firstWaitingBeforeMetadataPerfMs !== 0 ) {
                maybeTriggerRecovery('tiny-first-payload-waiting-before-metadata');
            }
        };
        const noteAlternateHost = entry => {
            if ( state.firstPayloadHost === '' || state.firstAlternateHost !== '' ) { return; }
            let host = '';
            try {
                host = new URL(entry.name, location.href).hostname;
            } catch {}
            if ( host === '' || host === state.firstPayloadHost ) { return; }
            state.firstAlternateHost = host;
            state.firstAlternateHostPerfMs = Number(entry.startTime) || 0;
            self.__talonYouTubeWatchReplayAlternateHost = host;
            self.__talonYouTubeWatchReplayAlternateHostPerfMs = state.firstAlternateHostPerfMs;
        };
        if ( self.PerformanceObserver ) {
            try {
                const resourceObserver = new self.PerformanceObserver(list => {
                    for ( const entry of list.getEntries() ) {
                        if ( isVideoplaybackResourceUrl(entry.name) === false ) { continue; }
                        noteFirstPayload(entry);
                        noteAlternateHost(entry);
                    }
                });
                resourceObserver.observe({
                    type: 'resource',
                    buffered: true,
                });
            } catch {}
        }
        const attachToVideo = video => {
            if ( video === null || state.attachedVideo === video ) { return; }
            if ( video.closest('#movie_player') === null ) { return; }
            state.attachedVideo = video;
            self.__talonYouTubeWatchReplayGuardAttachedAt = Date.now();
            self.__talonYouTubeWatchReplayGuardAttachedPerfMs = getNowPerfMs();
            video.addEventListener('play', () => {
                if ( state.firstLoadedMetadataPerfMs !== 0 || state.firstPlayBeforeMetadataPerfMs !== 0 ) {
                    return;
                }
                state.firstPlayBeforeMetadataPerfMs = getNowPerfMs();
                self.__talonYouTubeWatchReplayPreMetadataPlayPerfMs = state.firstPlayBeforeMetadataPerfMs;
            }, { capture: true });
            video.addEventListener('waiting', () => {
                if ( state.firstLoadedMetadataPerfMs !== 0 || state.firstWaitingBeforeMetadataPerfMs !== 0 ) {
                    return;
                }
                if ( video.readyState !== 0 ) { return; }
                state.firstWaitingBeforeMetadataPerfMs = getNowPerfMs();
                self.__talonYouTubeWatchReplayPreMetadataWaitingPerfMs =
                    state.firstWaitingBeforeMetadataPerfMs;
                maybeTriggerRecovery('waiting-before-metadata-after-early-play');
            }, { capture: true });
            video.addEventListener('loadedmetadata', () => {
                if ( state.firstLoadedMetadataPerfMs !== 0 ) { return; }
                state.firstLoadedMetadataPerfMs = getNowPerfMs();
                self.__talonYouTubeWatchReplayLoadedMetadataPerfMs = state.firstLoadedMetadataPerfMs;
            }, { capture: true });
        };
        const scanCurrentVideo = () => {
            attachToVideo(getCurrentVideo());
        };
        scanCurrentVideo();
        if ( self.MutationObserver ) {
            const root = document.documentElement || document;
            if ( root ) {
                const observer = new MutationObserver(() => {
                    scanCurrentVideo();
                });
                observer.observe(root, {
                    childList: true,
                    subtree: true,
                });
            }
        } else {
            self.setInterval(scanCurrentVideo, 250);
        }
    };
    const hasMainPlayerAdState = () => {
        const player = getMoviePlayer();
        if ( player === null ) { return false; }
        if ( player.classList.contains('ad-showing') ) { return true; }
        return player.querySelector(MAIN_PLAYER_AD_SELECTOR) !== null;
    };
    const isMainPlayerPlayable = () => {
        const currentVideo = getCurrentVideo();
        if ( currentVideo === null ) { return false; }
        if ( Number.isFinite(currentVideo.currentTime) && currentVideo.currentTime > 0.25 ) {
            return true;
        }
        return typeof currentVideo.readyState === 'number' && currentVideo.readyState >= 3;
    };
    const shouldEscalateSidebarSpaFallback = elapsedMs => {
        if ( hasMainPlayerAdState() ) { return true; }
        if ( elapsedMs < SIDEBAR_SPA_HARD_NAV_PLAYABLE_GRACE_MS ) { return false; }
        const player = getMoviePlayer();
        const currentVideo = getCurrentVideo();
        if ( player === null || currentVideo === null ) { return false; }
        const currentTime = Number.isFinite(currentVideo.currentTime)
            ? currentVideo.currentTime
            : 0;
        const readyState = typeof currentVideo.readyState === 'number'
            ? currentVideo.readyState
            : 0;
        if ( currentTime > 0.25 || readyState >= 3 ) { return false; }
        return (
            player.classList.contains('unstarted-mode') ||
            player.classList.contains('buffering-mode')
        );
    };
    installReplayPoisonedBootstrapGuard();
    const markForcedWatchNavigationEvent = (eventType, targetUrl) => {
        self.__talonYouTubeWatchForcedNavigationEventType =
            typeof eventType === 'string' ? eventType : '';
        self.__talonYouTubeWatchForcedNavigationTargetUrl =
            typeof targetUrl === 'string' ? targetUrl : '';
        self.__talonYouTubeWatchForcedNavigationAt = Date.now();
        self.__talonYouTubeWatchForcedNavigationPerfMs = getNowPerfMs();
        persistFollowupNavigationDebug({
            targetUrl,
            forcedNavigationEventType: self.__talonYouTubeWatchForcedNavigationEventType,
            forcedNavigationAt: self.__talonYouTubeWatchForcedNavigationAt,
            forcedNavigationPerfMs: self.__talonYouTubeWatchForcedNavigationPerfMs,
        });
    };
    const markForcedWatchNavigationProbe = (eventType, reason, anchor, targetUrl) => {
        self.__talonYouTubeWatchFollowupProbeEventType =
            typeof eventType === 'string' ? eventType : '';
        self.__talonYouTubeWatchFollowupProbeReason =
            typeof reason === 'string' ? reason : '';
        self.__talonYouTubeWatchFollowupProbeAnchorHref =
            anchor && typeof anchor.href === 'string' ? anchor.href : '';
        self.__talonYouTubeWatchFollowupProbeAnchorClassName =
            anchor && typeof anchor.className === 'string' ? anchor.className : '';
        self.__talonYouTubeWatchFollowupProbeTargetUrl =
            typeof targetUrl === 'string' ? targetUrl : '';
        self.__talonYouTubeWatchFollowupProbeAt = Date.now();
        persistFollowupNavigationDebug({
            targetUrl,
            followupProbeEventType: self.__talonYouTubeWatchFollowupProbeEventType,
            followupProbeReason: self.__talonYouTubeWatchFollowupProbeReason,
            followupProbeAnchorHref: self.__talonYouTubeWatchFollowupProbeAnchorHref,
            followupProbeAnchorClassName: self.__talonYouTubeWatchFollowupProbeAnchorClassName,
            followupProbeTargetUrl: self.__talonYouTubeWatchFollowupProbeTargetUrl,
            followupProbeAt: self.__talonYouTubeWatchFollowupProbeAt,
        });
    };
    const markForcedWatchNavigationListenerEvent = event => {
        const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
        const anchor = path.find(node =>
            self.HTMLAnchorElement !== undefined && node instanceof self.HTMLAnchorElement
        );
        const anchorHref = anchor && typeof anchor.href === 'string' ? anchor.href : '';
        const normalizedTargetUrl = normalizeWatchUrl(anchorHref);
        self.__talonYouTubeWatchFollowupListenerEventType =
            typeof event?.type === 'string' ? event.type : '';
        self.__talonYouTubeWatchFollowupListenerAnchorHref = anchorHref;
        self.__talonYouTubeWatchFollowupListenerAnchorClassName =
            anchor && typeof anchor.className === 'string' ? anchor.className : '';
        self.__talonYouTubeWatchFollowupListenerTargetUrl = normalizedTargetUrl;
        self.__talonYouTubeWatchFollowupListenerAt = Date.now();
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            followupListenerEventType: self.__talonYouTubeWatchFollowupListenerEventType,
            followupListenerAnchorHref: self.__talonYouTubeWatchFollowupListenerAnchorHref,
            followupListenerAnchorClassName:
                self.__talonYouTubeWatchFollowupListenerAnchorClassName,
            followupListenerTargetUrl: self.__talonYouTubeWatchFollowupListenerTargetUrl,
            followupListenerAt: self.__talonYouTubeWatchFollowupListenerAt,
        });
    };
    const hardNavigateToWatch = nextUrl => {
        self.__talonYouTubeWatchHardNavigateTargetUrl =
            typeof nextUrl === 'string' ? nextUrl : '';
        self.__talonYouTubeWatchHardNavigateAt = Date.now();
        self.__talonYouTubeWatchHardNavigatePerfMs = getNowPerfMs();
        persistFollowupNavigationDebug({
            targetUrl: self.__talonYouTubeWatchHardNavigateTargetUrl,
            hardNavigateTargetUrl: self.__talonYouTubeWatchHardNavigateTargetUrl,
            hardNavigateAt: self.__talonYouTubeWatchHardNavigateAt,
            hardNavigatePerfMs: self.__talonYouTubeWatchHardNavigatePerfMs,
        });
        teardownCurrentVideo();
        try { self.stop(); } catch {}
        try {
            location.assign(nextUrl);
            return;
        } catch {
        }
        const anchor = document.createElement('a');
        anchor.href = nextUrl;
        anchor.target = '_self';
        anchor.style.display = 'none';
        (document.documentElement || document.body).append(anchor);
        anchor.click();
        anchor.remove();
    };
    const isPrimarySidebarNavigationEvent = event => {
        if ( event.defaultPrevented ) { return false; }
        if ( event.button !== 0 ) { return false; }
        if ( event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ) { return false; }
        return true;
    };
    const getForcedWatchNavigationTargetFromEvent = event => {
        if ( isPrimarySidebarNavigationEvent(event) === false ) {
            markForcedWatchNavigationProbe(event?.type, 'not-primary', null, '');
            return '';
        }
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        const pathAnchor = path.find(node =>
            self.HTMLAnchorElement !== undefined && node instanceof self.HTMLAnchorElement
        );
        const anchor = path.find(node => shouldForceDocumentNavigation(node));
        if ( anchor === undefined ) {
            markForcedWatchNavigationProbe(
                event.type,
                pathAnchor === undefined ? 'no-anchor-in-path' : 'anchor-not-eligible',
                pathAnchor,
                ''
            );
            return '';
        }
        const normalizedTargetUrl = normalizeWatchUrl(anchor.href);
        if ( normalizedTargetUrl === '' ) {
            markForcedWatchNavigationProbe(event.type, 'not-watch-url', anchor, '');
            return '';
        }
        if ( isCurrentWatchDocumentForUrl(normalizedTargetUrl) ) {
            markForcedWatchNavigationProbe(event.type, 'current-watch-document', anchor, normalizedTargetUrl);
            return '';
        }
        markForcedWatchNavigationProbe(event.type, 'matched', anchor, normalizedTargetUrl);
        return normalizedTargetUrl;
    };
    const requestFollowupCookieClear = targetUrl => {
        const requestId = `td-yw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise(resolve => {
            let settled = false;
            const cleanup = () => {
                document.removeEventListener(FOLLOWUP_COOKIE_CLEAR_RESPONSE_EVENT, onResponse, true);
                self.clearTimeout(timeoutId);
            };
            const finish = ok => {
                if ( settled ) { return; }
                settled = true;
                cleanup();
                resolve(ok === true);
            };
            const onResponse = event => {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if ( detail?.requestId !== requestId ) { return; }
                finish(detail.ok === true);
            };
            const timeoutId = self.setTimeout(() => {
                finish(false);
            }, 750);
            document.addEventListener(FOLLOWUP_COOKIE_CLEAR_RESPONSE_EVENT, onResponse, true);
            try {
                document.dispatchEvent(new CustomEvent(FOLLOWUP_COOKIE_CLEAR_REQUEST_EVENT, {
                    detail: {
                        requestId,
                        targetUrl: normalizeWatchUrl(targetUrl),
                    },
                }));
            } catch {
                finish(false);
            }
        });
    };
    const requestBackgroundFollowupNavigation = targetUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) {
            return Promise.resolve(false);
        }
        self.__talonYouTubeWatchBackgroundNavigationRequestedAt = Date.now();
        self.__talonYouTubeWatchBackgroundNavigationRequestedUrl = normalizedTargetUrl;
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            backgroundNavigationRequestedAt:
                self.__talonYouTubeWatchBackgroundNavigationRequestedAt,
            backgroundNavigationRequestedUrl:
                self.__talonYouTubeWatchBackgroundNavigationRequestedUrl,
        });
        const requestId = `td-yw-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise(resolve => {
            let settled = false;
            const cleanup = () => {
                document.removeEventListener(FOLLOWUP_TAB_NAVIGATE_RESPONSE_EVENT, onResponse, true);
                self.clearTimeout(timeoutId);
            };
            const finish = ok => {
                if ( settled ) { return; }
                settled = true;
                self.__talonYouTubeWatchBackgroundNavigationResolvedAt = Date.now();
                self.__talonYouTubeWatchBackgroundNavigationOk = ok === true;
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    backgroundNavigationResolvedAt:
                        self.__talonYouTubeWatchBackgroundNavigationResolvedAt,
                    backgroundNavigationOk: self.__talonYouTubeWatchBackgroundNavigationOk,
                });
                cleanup();
                resolve(ok === true);
            };
            const onResponse = event => {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if ( detail?.requestId !== requestId ) { return; }
                finish(detail.ok === true);
            };
            const timeoutId = self.setTimeout(() => {
                finish(false);
            }, 1500);
            document.addEventListener(FOLLOWUP_TAB_NAVIGATE_RESPONSE_EVENT, onResponse, true);
            try {
                document.dispatchEvent(new CustomEvent(FOLLOWUP_TAB_NAVIGATE_REQUEST_EVENT, {
                    detail: {
                        requestId,
                        targetUrl: normalizedTargetUrl,
                    },
                }));
            } catch {
                finish(false);
            }
        });
    };
    const requestFollowupArchitectureProof = (action, strategy, targetUrl) => {
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) {
            return Promise.resolve({ ok: false, error: 'invalid-target-url' });
        }
        const requestId = `td-yw-arch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise(resolve => {
            let settled = false;
            const cleanup = () => {
                document.removeEventListener(FOLLOWUP_ARCHITECTURE_RESPONSE_EVENT, onResponse, true);
                self.clearTimeout(timeoutId);
            };
            const finish = payload => {
                if ( settled ) { return; }
                settled = true;
                cleanup();
                resolve(payload && typeof payload === 'object' ? payload : { ok: false });
            };
            const onResponse = event => {
                const detail = event instanceof CustomEvent ? event.detail : null;
                if ( detail?.requestId !== requestId ) { return; }
                finish(detail);
            };
            const timeoutId = self.setTimeout(() => {
                finish({ ok: false, error: 'bridge-timeout' });
            }, FOLLOWUP_BACKGROUND_PREFETCH_TIMEOUT_MS + 1500);
            document.addEventListener(FOLLOWUP_ARCHITECTURE_RESPONSE_EVENT, onResponse, true);
            try {
                document.dispatchEvent(new CustomEvent(FOLLOWUP_ARCHITECTURE_REQUEST_EVENT, {
                    detail: {
                        requestId,
                        action,
                        strategy,
                        targetUrl: normalizedTargetUrl,
                    },
                }));
            } catch {
                finish({ ok: false, error: 'dispatch-failed' });
            }
        });
    };
    const sleepFor = milliseconds => new Promise(resolve => {
        self.setTimeout(resolve, Math.max(0, Number(milliseconds) || 0));
    });
    const waitForPreclickReleaseTimeout = clickAt => {
        const deadlineAt =
            (typeof clickAt === 'number' ? clickAt : Date.now()) +
            FOLLOWUP_PRECLICK_RELEASE_TIMEOUT_MS;
        return sleepFor(deadlineAt - Date.now()).then(() => deadlineAt);
    };
    const didTrackAStoreVerificationPass = () =>
        self.__talonYouTubeWatchArchitectureTrackAStoredWriteOk === true &&
        self.__talonYouTubeWatchArchitectureTrackAStoredReadbackOk === true &&
        self.__talonYouTubeWatchArchitectureTrackAStoredTargetMatch === true;
    const persistArchitectureOutcome = patch => {
        if ( patch === null || typeof patch !== 'object' ) { return; }
        const targetUrl = normalizeWatchUrl(
            typeof patch.targetUrl === 'string' ? patch.targetUrl : ''
        );
        const nextPatch = {
            ...patch,
            targetUrl,
        };
        persistFollowupNavigationDebug(nextPatch);
        setArchitectureEntryMetrics({
            strategy: nextPatch.architectureEntryStrategy,
            handoffSurface: nextPatch.architectureHandoffSurface,
            donorStartedAt: nextPatch.architectureDonorStartedAt,
            donorReadyAt: nextPatch.architectureDonorReadyAt,
            handoffReadyAt: nextPatch.architectureHandoffReadyAt,
            anchorSeenAt: nextPatch.architectureAnchorSeenAt,
            clickAt: nextPatch.architectureClickAt,
            readyAt: nextPatch.architectureReadyAt,
            readyBeforeClick: nextPatch.architectureReadyBeforeClick,
            readyAfterClick: nextPatch.architectureReadyAfterClick,
            failureCategory: nextPatch.architectureFailureCategory,
            preclickSignalType: nextPatch.architecturePreclickSignalType,
            trackAIntentLeaseHit: nextPatch.architectureTrackAIntentLeaseHit,
            trackAIntentLeaseMiss: nextPatch.architectureTrackAIntentLeaseMiss,
            donorOwnerTransferOk: nextPatch.architectureDonorOwnerTransferOk,
            donorOwnerReuseDetected: nextPatch.architectureDonorOwnerReuseDetected,
            donorOwnerContaminationDetected:
                nextPatch.architectureDonorOwnerContaminationDetected,
            donorOwnerStartLatencyMs: nextPatch.architectureDonorOwnerStartLatencyMs,
            targetNavigationAt: nextPatch.architectureTargetNavigationAt,
            envelopeReadyBeforeNavigationRelease:
                nextPatch.architectureEnvelopeReadyBeforeNavigationRelease,
            navigationHoldDurationMs: nextPatch.architectureNavigationHoldDurationMs,
            fallbackPathUsed: nextPatch.architectureFallbackPathUsed,
            timeoutOccurred: nextPatch.architectureTimeoutOccurred,
            invalidReason: nextPatch.architectureInvalidReason,
            backgroundPrefetchError: nextPatch.backgroundPrefetchError,
        });
        if ( typeof nextPatch.architectureDocumentCommitEnvelopePresent === 'boolean' ) {
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopePresent =
                nextPatch.architectureDocumentCommitEnvelopePresent;
        }
        if ( typeof nextPatch.architectureDocumentCommitEnvelopeSource === 'string' ) {
            self.__talonYouTubeWatchArchitectureDocumentCommitEnvelopeSource =
                nextPatch.architectureDocumentCommitEnvelopeSource;
        }
    };
    const createPreclickTargetState = (targetUrl, strategy) => ({
        targetUrl,
        targetVideoId: getWatchVideoIdFromUrl(targetUrl),
        strategy,
        anchorSeenAt: 0,
        firstSignalType: '',
        lastSignalType: '',
        lastSignalAt: 0,
        acquisitionStartedAt: 0,
        donorStartedAt: null,
        donorReadyAt: null,
        readyAt: null,
        response: null,
        error: '',
        status: 'idle',
        expiresAt: 0,
    });
    const touchPreclickTargetState = state => {
        if ( state === null || typeof state !== 'object' ) { return state; }
        state.expiresAt = Date.now() + FOLLOWUP_PRECLICK_TARGET_TTL_MS;
        return state;
    };
    const getOrCreatePreclickTargetState = (collection, targetUrl, strategy) => {
        if ( collection instanceof Map === false ) { return null; }
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) { return null; }
        let state = collection.get(normalizedTargetUrl);
        if ( state instanceof Object === false ) {
            state = createPreclickTargetState(normalizedTargetUrl, strategy);
            collection.set(normalizedTargetUrl, state);
        }
        return touchPreclickTargetState(state);
    };
    const getActivePreclickTargetState = (collection, targetUrl) => {
        if ( collection instanceof Map === false ) { return null; }
        const normalizedTargetUrl = normalizeWatchUrl(targetUrl);
        if ( normalizedTargetUrl === '' ) { return null; }
        const state = collection.get(normalizedTargetUrl);
        if ( state instanceof Object === false ) { return null; }
        if ( Number.isFinite(state.expiresAt) && state.expiresAt > 0 && state.expiresAt < Date.now() ) {
            collection.delete(normalizedTargetUrl);
            return null;
        }
        return touchPreclickTargetState(state);
    };
    const ensureTrackAIntentLeaseStarted = state => {
        if ( state === null || typeof state !== 'object' ) {
            return Promise.resolve({ ok: false, error: 'lease-miss' });
        }
        if ( state.promise instanceof Promise ) { return state.promise; }
        touchPreclickTargetState(state);
        state.acquisitionStartedAt = Date.now();
        state.status = 'pending';
        state.promise = requestFollowupArchitectureProof(
            'acquire-and-wait',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE,
            state.targetUrl
        ).then(response => {
            const nextResponse =
                response && typeof response === 'object'
                    ? response
                    : { ok: false, error: 'lease-failed' };
            state.response = nextResponse;
            state.donorStartedAt =
                typeof nextResponse?.donorStartedAt === 'number'
                    ? nextResponse.donorStartedAt
                    : state.acquisitionStartedAt;
            state.donorReadyAt =
                typeof nextResponse?.donorReadyAt === 'number'
                    ? nextResponse.donorReadyAt
                    : null;
            state.readyAt = state.donorReadyAt;
            state.status =
                nextResponse?.ok === true && nextResponse?.entry instanceof Object
                    ? 'ready'
                    : 'failed';
            state.error =
                typeof nextResponse?.error === 'string' ? nextResponse.error : '';
            return nextResponse;
        }).catch(reason => {
            const nextResponse = { ok: false, error: `${reason}` };
            state.response = nextResponse;
            state.donorStartedAt = state.acquisitionStartedAt;
            state.donorReadyAt = null;
            state.readyAt = null;
            state.status = 'failed';
            state.error = nextResponse.error;
            return nextResponse;
        });
        return state.promise;
    };
    const ensureTrackADonorOwnerStarted = state => {
        if ( state === null || typeof state !== 'object' ) {
            return Promise.resolve({ ok: false, error: 'owner-miss' });
        }
        if ( state.startPromise instanceof Promise ) { return state.startPromise; }
        touchPreclickTargetState(state);
        state.acquisitionStartedAt = Date.now();
        state.status = 'pending';
        state.startPromise = requestFollowupArchitectureProof(
            'start-donor-owner',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER,
            state.targetUrl
        ).then(response => {
            const nextResponse =
                response && typeof response === 'object'
                    ? response
                    : { ok: false, error: 'owner-start-failed' };
            state.startResponse = nextResponse;
            state.donorStartedAt =
                typeof nextResponse?.donorStartedAt === 'number'
                    ? nextResponse.donorStartedAt
                    : state.acquisitionStartedAt;
            state.donorReadyAt =
                typeof nextResponse?.donorReadyAt === 'number'
                    ? nextResponse.donorReadyAt
                    : null;
            state.readyAt = state.donorReadyAt;
            if ( nextResponse?.ok === true || nextResponse?.started === true ) {
                state.status = nextResponse?.ready === true ? 'ready' : 'pending';
                state.error = '';
            } else {
                state.status = 'failed';
                state.error =
                    typeof nextResponse?.error === 'string'
                        ? nextResponse.error
                        : 'owner-start-failed';
            }
            return nextResponse;
        }).catch(reason => {
            const nextResponse = { ok: false, error: `${reason}` };
            state.startResponse = nextResponse;
            state.donorStartedAt = state.acquisitionStartedAt;
            state.donorReadyAt = null;
            state.readyAt = null;
            state.status = 'failed';
            state.error = nextResponse.error;
            return nextResponse;
        });
        return state.startPromise;
    };
    const waitForTrackAIntentLeaseResult = (state, deadlineAt) => {
        if ( state === null || typeof state !== 'object' ) {
            return Promise.resolve({ ok: false, error: 'lease-miss' });
        }
        if ( state.acquisitionStartedAt === 0 && state.anchorSeenAt > 0 ) {
            ensureTrackAIntentLeaseStarted(state);
        }
        if ( state.response && typeof state.response === 'object' ) {
            return Promise.resolve(state.response);
        }
        if ( state.promise instanceof Promise === false ) {
            return Promise.resolve({ ok: false, error: 'lease-miss' });
        }
        return Promise.race([
            state.promise,
            sleepFor(Math.max(0, deadlineAt - Date.now())).then(() => ({
                ok: false,
                error: 'timeout',
                timedOut: true,
            })),
        ]);
    };
    const waitForTrackADonorOwnerResult = (state, deadlineAt) => {
        if ( state === null || typeof state !== 'object' ) {
            return Promise.resolve({ ok: false, error: 'owner-miss' });
        }
        const poll = () => requestFollowupArchitectureProof(
            'consume-donor-owner',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER,
            state.targetUrl
        ).then(response => {
            const nextResponse =
                response && typeof response === 'object'
                    ? response
                    : { ok: false, error: 'owner-miss' };
            state.response = nextResponse;
            if ( typeof nextResponse?.donorStartedAt === 'number' ) {
                state.donorStartedAt = nextResponse.donorStartedAt;
            }
            if ( typeof nextResponse?.donorReadyAt === 'number' ) {
                state.donorReadyAt = nextResponse.donorReadyAt;
                state.readyAt = nextResponse.donorReadyAt;
            }
            if ( nextResponse?.ok === true && nextResponse?.entry instanceof Object ) {
                state.status = 'ready';
                state.error = '';
                return nextResponse;
            }
            if ( nextResponse?.error === 'owner-pending' && Date.now() < deadlineAt ) {
                return sleepFor(FOLLOWUP_DONOR_OWNER_POLL_INTERVAL_MS).then(poll);
            }
            state.status = 'failed';
            state.error =
                typeof nextResponse?.error === 'string' ? nextResponse.error : 'owner-miss';
            return nextResponse;
        });
        if ( state.acquisitionStartedAt === 0 && state.anchorSeenAt > 0 ) {
            ensureTrackADonorOwnerStarted(state);
        }
        if ( state.acquisitionStartedAt === 0 ) {
            return Promise.resolve({ ok: false, error: 'owner-miss' });
        }
        return ensureTrackADonorOwnerStarted(state).then(startResponse => {
            if (
                startResponse?.ok !== true &&
                startResponse?.started !== true &&
                typeof startResponse?.error === 'string'
            ) {
                state.response = startResponse;
                state.status = 'failed';
                state.error = startResponse.error;
                return startResponse;
            }
            return poll();
        });
    };
    const notePreclickTargetSignal = (anchor, signalType) => {
        if (
            isFollowupArchitectureTrackAIntentLease === false &&
            isFollowupArchitectureTrackADonorOwner === false
        ) {
            return;
        }
        if ( self.HTMLAnchorElement === undefined || anchor instanceof self.HTMLAnchorElement === false ) {
            return;
        }
        if ( shouldForceDocumentNavigation(anchor) === false ) { return; }
        const normalizedTargetUrl = normalizeWatchUrl(anchor.href);
        if ( normalizedTargetUrl === '' || isCurrentWatchDocumentForUrl(normalizedTargetUrl) ) {
            return;
        }
        const now = Date.now();
        if ( isFollowupArchitectureTrackAIntentLease ) {
            const state = getOrCreatePreclickTargetState(
                trackAIntentLeaseTargets,
                normalizedTargetUrl,
                FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE
            );
            if ( state === null ) { return; }
            state.anchorSeenAt ||= now;
            state.firstSignalType ||= signalType;
            state.lastSignalType = signalType;
            state.lastSignalAt = now;
            ensureTrackAIntentLeaseStarted(state);
            return;
        }
        const state = getOrCreatePreclickTargetState(
            trackADonorOwnerTargets,
            normalizedTargetUrl,
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER
        );
        if ( state === null ) { return; }
        state.anchorSeenAt ||= now;
        state.firstSignalType ||= signalType;
        state.lastSignalType = signalType;
        state.lastSignalAt = now;
        ensureTrackADonorOwnerStarted(state);
    };
    const schedulePreclickAnchorExposure = anchor => {
        if (
            isFollowupArchitectureTrackAIntentLease === false &&
            isFollowupArchitectureTrackADonorOwner === false
        ) {
            return;
        }
        if ( self.HTMLAnchorElement === undefined || anchor instanceof self.HTMLAnchorElement === false ) {
            return;
        }
        if ( shouldForceDocumentNavigation(anchor) === false ) { return; }
        const normalizedTargetUrl = normalizeWatchUrl(anchor.href);
        if ( normalizedTargetUrl === '' || isCurrentWatchDocumentForUrl(normalizedTargetUrl) ) {
            return;
        }
        if ( pendingPreclickAnchorExposureTimers.has(normalizedTargetUrl) ) { return; }
        const timerId = self.setTimeout(() => {
            pendingPreclickAnchorExposureTimers.delete(normalizedTargetUrl);
            if ( anchor.isConnected !== true ) { return; }
            if ( normalizeWatchUrl(anchor.href) !== normalizedTargetUrl ) { return; }
            notePreclickTargetSignal(anchor, 'anchor-exposed');
        }, FOLLOWUP_PRECLICK_ANCHOR_STABLE_DELAY_MS);
        pendingPreclickAnchorExposureTimers.set(normalizedTargetUrl, timerId);
    };
    const capturePreclickAnchorFromEvent = event => {
        const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
        return path.find(node => shouldForceDocumentNavigation(node)) || null;
    };
    const buildPreclickOutcomePatch = ({
        strategy,
        targetUrl,
        state,
        clickAt,
        handoffReadyAt = null,
        targetNavigationAt = null,
        navigationHoldDurationMs = null,
        envelopeReadyBeforeNavigationRelease = false,
        timeoutOccurred = false,
        failureCategory = '',
        backgroundPrefetchError = '',
        trackAIntentLeaseHit = false,
        trackAIntentLeaseMiss = false,
        donorOwnerTransferOk = false,
        donorOwnerReuseDetected = false,
        donorOwnerContaminationDetected = false,
    }) => {
        const anchorSeenAt =
            typeof state?.anchorSeenAt === 'number' ? state.anchorSeenAt : null;
        const donorStartedAt =
            typeof state?.donorStartedAt === 'number' ? state.donorStartedAt : null;
        const donorReadyAt =
            typeof state?.donorReadyAt === 'number' ? state.donorReadyAt : null;
        const readyAt =
            envelopeReadyBeforeNavigationRelease === true
                ? (
                    typeof state?.readyAt === 'number'
                        ? state.readyAt
                        : donorReadyAt !== null
                            ? donorReadyAt
                            : handoffReadyAt
                )
                : null;
        return {
            targetUrl,
            architectureEntryStrategy: strategy,
            architectureHandoffSurface: 'sessionStorage',
            architectureAnchorSeenAt: anchorSeenAt,
            architecturePreclickSignalType:
                typeof state?.firstSignalType === 'string' ? state.firstSignalType : '',
            architectureClickAt: clickAt,
            architectureReadyAt: readyAt,
            architectureReadyBeforeClick:
                readyAt !== null && typeof clickAt === 'number' && readyAt <= clickAt,
            architectureReadyAfterClick:
                readyAt !== null && typeof clickAt === 'number' && readyAt > clickAt,
            architectureDonorStartedAt: donorStartedAt,
            architectureDonorReadyAt: donorReadyAt,
            architectureHandoffReadyAt: handoffReadyAt,
            architectureTargetNavigationAt: targetNavigationAt,
            architectureEnvelopeReadyBeforeNavigationRelease:
                envelopeReadyBeforeNavigationRelease === true,
            architectureNavigationHoldDurationMs: navigationHoldDurationMs,
            architectureFallbackPathUsed: false,
            architectureTimeoutOccurred: timeoutOccurred === true,
            architectureFailureCategory: failureCategory,
            architectureDocumentCommitEnvelopePresent:
                envelopeReadyBeforeNavigationRelease === true,
            architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
            architectureTrackAIntentLeaseHit: trackAIntentLeaseHit === true,
            architectureTrackAIntentLeaseMiss: trackAIntentLeaseMiss === true,
            architectureDonorOwnerTransferOk: donorOwnerTransferOk === true,
            architectureDonorOwnerReuseDetected: donorOwnerReuseDetected === true,
            architectureDonorOwnerContaminationDetected:
                donorOwnerContaminationDetected === true,
            architectureDonorOwnerStartLatencyMs:
                anchorSeenAt !== null && donorStartedAt !== null
                    ? Math.max(0, donorStartedAt - anchorSeenAt)
                    : null,
            backgroundPrefetchError,
            architectureInvalidReason:
                typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                    ? self.__talonYouTubeWatchArchitectureInvalidReason
                    : '',
        };
    };
    const navigateThroughNeutralHop = () => {
        teardownCurrentVideo();
        try { self.stop(); } catch {}
        try {
            location.replace('about:blank#td-yw-followup-hop');
            return true;
        } catch {
        }
        return false;
    };
    const unregisterFollowupServiceWorkers = () => {
        const serviceWorker = navigator.serviceWorker;
        if ( serviceWorker?.getRegistrations === undefined ) {
            return Promise.resolve(false);
        }
        return serviceWorker.getRegistrations().then(async registrations => {
            let unregistered = false;
            for ( const registration of registrations ) {
                try {
                    if ( await registration.unregister() ) {
                        unregistered = true;
                    }
                } catch {
                }
            }
            return unregistered;
        }).catch(() => false);
    };
    const prepareFollowupNavigation = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) {
            pendingFollowupNavigationPreparation = null;
            return Promise.resolve({
                normalizedTargetUrl: '',
                neutralHopArmed: false,
            });
        }
        if ( pendingFollowupNavigationPreparation?.normalizedTargetUrl === normalizedTargetUrl ) {
            return pendingFollowupNavigationPreparation.promise;
        }
        self.__talonYouTubeWatchFollowupPreparationRequestedAt = Date.now();
        self.__talonYouTubeWatchFollowupPreparationRequestedUrl = normalizedTargetUrl;
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            followupPreparationRequestedAt:
                self.__talonYouTubeWatchFollowupPreparationRequestedAt,
            followupPreparationRequestedUrl:
                self.__talonYouTubeWatchFollowupPreparationRequestedUrl,
        });
        const shouldAttemptNeutralHop = SHOULD_USE_EDGE_NEUTRAL_HOP === true;
        const token = ++pendingFollowupCookieClearToken;
        const prefetchPromise = requestBackgroundFollowupPlayerResponseSections(
            normalizedTargetUrl
        ).catch(() => false).then(
            ok => ok === true
                ? true
                : prefetchFollowupPlayerResponseSections(normalizedTargetUrl).catch(() => false)
        );
        const promise = prefetchPromise.then(
            prefetchedPlayerResponseSections => {
                return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                    return requestFollowupCookieClear(
                        shouldAttemptNeutralHop ? normalizedTargetUrl : ''
                    ).catch(() => false);
                }).then(neutralHopArmed => ({
                    normalizedTargetUrl,
                    neutralHopArmed: shouldAttemptNeutralHop && neutralHopArmed === true,
                    prefetchedPlayerResponseSections: prefetchedPlayerResponseSections === true,
                    token,
                })).then(result => {
                    self.__talonYouTubeWatchFollowupPreparationResolvedAt = Date.now();
                    self.__talonYouTubeWatchFollowupPreparationPrefetchedSections =
                        result?.prefetchedPlayerResponseSections === true;
                    self.__talonYouTubeWatchFollowupPreparationNeutralHopArmed =
                        result?.neutralHopArmed === true;
                    persistFollowupNavigationDebug({
                        targetUrl: normalizedTargetUrl,
                        followupPreparationResolvedAt:
                            self.__talonYouTubeWatchFollowupPreparationResolvedAt,
                        followupPreparationPrefetchedSections:
                            self.__talonYouTubeWatchFollowupPreparationPrefetchedSections,
                        followupPreparationNeutralHopArmed:
                            self.__talonYouTubeWatchFollowupPreparationNeutralHopArmed,
                    });
                    return result;
                });
            }
        );
        pendingFollowupNavigationPreparation = {
            normalizedTargetUrl,
            token,
            promise,
        };
        return promise;
    };
    const releasePreparedFollowupNavigation = (nextUrl, neutralHopArmed) => {
        requestBackgroundFollowupNavigation(nextUrl).then(navigated => {
            if ( navigated === true ) { return; }
            if ( neutralHopArmed === true && navigateThroughNeutralHop() ) {
                return;
            }
            hardNavigateToWatch(nextUrl);
        });
    };
    const runTrackAControlledEntry = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        const clickInterceptAt = Date.now();
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A,
            architectureHandoffSurface: 'sessionStorage',
        });
        requestFollowupArchitectureProof(
            'acquire-and-wait',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A,
            normalizedTargetUrl
        ).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            const handoffReadyAt = Date.now();
            const envelopeReady = response?.ok === true && response?.entry && typeof response.entry === 'object';
            let storedEntry = null;
            if ( envelopeReady ) {
                storedEntry = sanitizeArchitectureProofEntry({
                    ...response.entry,
                    strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A,
                    handoffSurface: 'sessionStorage',
                    proof: {
                        donorStartedAt:
                            typeof response?.donorStartedAt === 'number'
                                ? response.donorStartedAt
                                : null,
                        donorReadyAt:
                            typeof response?.donorReadyAt === 'number'
                                ? response.donorReadyAt
                                : null,
                        handoffReadyAt,
                        targetNavigationAt: 0,
                        envelopeReadyBeforeNavigationRelease: true,
                        navigationHoldDurationMs: 0,
                        backgroundPrefetchError: '',
                        fallbackPathUsed: false,
                        timeoutOccurred: false,
                        invalidReason: typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                            ? self.__talonYouTubeWatchArchitectureInvalidReason
                            : '',
                    },
                });
            }
            return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                return requestFollowupCookieClear(
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                ).catch(() => false);
            }).then(neutralHopArmed => {
                const targetNavigationAt = Date.now();
                const navigationHoldDurationMs = Math.max(0, targetNavigationAt - clickInterceptAt);
                if ( storedEntry !== null ) {
                    storedEntry.proof = {
                        ...(storedEntry.proof && typeof storedEntry.proof === 'object'
                            ? storedEntry.proof
                            : {}),
                        handoffReadyAt,
                        targetNavigationAt,
                        navigationHoldDurationMs,
                    };
                    storeTrackAArchitectureEntry(storedEntry);
                }
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A,
                    architectureHandoffSurface: 'sessionStorage',
                    architectureDonorStartedAt:
                        typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                    architectureDonorReadyAt:
                        typeof response?.donorReadyAt === 'number' ? response.donorReadyAt : null,
                    architectureHandoffReadyAt: handoffReadyAt,
                    architectureTargetNavigationAt: targetNavigationAt,
                    architectureEnvelopeReadyBeforeNavigationRelease: envelopeReady,
                    architectureNavigationHoldDurationMs: navigationHoldDurationMs,
                    architectureFallbackPathUsed: envelopeReady !== true,
                    architectureTimeoutOccurred:
                        response?.error === 'timeout' || response?.timedOut === true,
                    architectureInvalidReason:
                        typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                            ? self.__talonYouTubeWatchArchitectureInvalidReason
                            : '',
                    architectureDocumentCommitEnvelopePresent: envelopeReady,
                    architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
                    backgroundPrefetchError:
                        envelopeReady === true
                            ? ''
                            : (typeof response?.error === 'string' ? response.error : 'timeout'),
                });
                releasePreparedFollowupNavigation(
                    normalizedTargetUrl,
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                );
            });
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            persistFollowupNavigationDebug({
                targetUrl: normalizedTargetUrl,
                architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A,
                architectureHandoffSurface: 'sessionStorage',
                architectureEnvelopeReadyBeforeNavigationRelease: false,
                architectureFallbackPathUsed: true,
                architectureTimeoutOccurred: true,
                architectureDocumentCommitEnvelopePresent: false,
                architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
                backgroundPrefetchError: 'bridge-error',
            });
            hardNavigateToWatch(normalizedTargetUrl);
        });
    };
    const runTrackASameOriginCommit = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        clearTrackACommitArchitectureEntry();
        const clickInterceptAt = Date.now();
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT,
            architectureHandoffSurface: 'localStorage',
        });
        requestFollowupArchitectureProof(
            'acquire-and-wait',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT,
            normalizedTargetUrl
        ).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            const handoffReadyAt = Date.now();
            const envelopeReady = response?.ok === true;
            const sameOriginCommit = response?.sameOriginCommit && typeof response.sameOriginCommit === 'object'
                ? response.sameOriginCommit
                : null;
            return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                return requestFollowupCookieClear(
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                ).catch(() => false);
            }).then(neutralHopArmed => {
                const targetNavigationAt = Date.now();
                const navigationHoldDurationMs = Math.max(0, targetNavigationAt - clickInterceptAt);
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT,
                    architectureHandoffSurface: 'localStorage',
                    architectureDonorStartedAt:
                        typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                    architectureDonorReadyAt:
                        typeof response?.donorReadyAt === 'number' ? response.donorReadyAt : null,
                    architectureHandoffReadyAt: handoffReadyAt,
                    architectureTargetNavigationAt: targetNavigationAt,
                    architectureTrackAStoredAt:
                        typeof sameOriginCommit?.storedAt === 'number' ? sameOriginCommit.storedAt : null,
                    architectureTrackAStoredWriteOk: sameOriginCommit?.writeOk === true,
                    architectureTrackAStoredBytes:
                        typeof sameOriginCommit?.storedBytes === 'number' ? sameOriginCommit.storedBytes : null,
                    architectureTrackAStoredReadbackOk: sameOriginCommit?.readbackOk === true,
                    architectureTrackAStoredTargetMatch: sameOriginCommit?.targetMatch === true,
                    architectureEnvelopeReadyBeforeNavigationRelease: envelopeReady,
                    architectureNavigationHoldDurationMs: navigationHoldDurationMs,
                    architectureFallbackPathUsed: envelopeReady !== true,
                    architectureTimeoutOccurred:
                        response?.error === 'timeout' || response?.timedOut === true,
                    architectureInvalidReason:
                        typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                            ? self.__talonYouTubeWatchArchitectureInvalidReason
                            : '',
                    architectureDocumentCommitEnvelopePresent: envelopeReady,
                    architectureDocumentCommitEnvelopeSource: 'track-a-same-origin-storage',
                    backgroundPrefetchError:
                        envelopeReady === true
                            ? ''
                            : (typeof response?.error === 'string' ? response.error : 'timeout'),
                });
                releasePreparedFollowupNavigation(
                    normalizedTargetUrl,
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                );
            });
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            persistFollowupNavigationDebug({
                targetUrl: normalizedTargetUrl,
                architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_COMMIT,
                architectureHandoffSurface: 'localStorage',
                architectureEnvelopeReadyBeforeNavigationRelease: false,
                architectureFallbackPathUsed: true,
                architectureTimeoutOccurred: true,
                architectureDocumentCommitEnvelopePresent: false,
                architectureDocumentCommitEnvelopeSource: 'track-a-same-origin-storage',
                backgroundPrefetchError: 'bridge-error',
            });
            hardNavigateToWatch(normalizedTargetUrl);
        });
    };
    const runTrackAPrewarmPool = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        const clickInterceptAt = Date.now();
        persistFollowupNavigationDebug({
            targetUrl: normalizedTargetUrl,
            architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
            architectureHandoffSurface: 'sessionStorage',
        });
        requestFollowupArchitectureProof(
            'consume-prewarmed-entry',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
            normalizedTargetUrl
        ).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            const handoffReadyAt = Date.now();
            const predictionHit = response?.predictionHit === true;
            const predictionMiss = response?.predictionMiss === true;
            const staleEntry = response?.staleEntry === true;
            const envelopeReady = response?.ok === true && response?.entry && typeof response.entry === 'object';
            let storedEntry = null;
            if ( envelopeReady ) {
                storedEntry = sanitizeArchitectureProofEntry({
                    ...response.entry,
                    strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
                    handoffSurface: 'sessionStorage',
                    proof: {
                        donorStartedAt:
                            typeof response?.donorStartedAt === 'number'
                                ? response.donorStartedAt
                                : null,
                        donorReadyAt:
                            typeof response?.donorReadyAt === 'number'
                                ? response.donorReadyAt
                                : null,
                        handoffReadyAt,
                        targetNavigationAt: 0,
                        envelopeReadyBeforeNavigationRelease: true,
                        navigationHoldDurationMs: 0,
                        backgroundPrefetchError: '',
                        fallbackPathUsed: false,
                        timeoutOccurred: false,
                        invalidReason:
                            typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                                ? self.__talonYouTubeWatchArchitectureInvalidReason
                                : '',
                        trackAPrewarmPredictionHit: predictionHit,
                        trackAPrewarmPredictionMiss: predictionMiss,
                        trackAPrewarmEntryStale: staleEntry,
                        trackAPrewarmRequested: response?.prewarmRequested === true,
                        trackAPrewarmEntryCreatedAt:
                            typeof response?.prewarmEntryCreatedAt === 'number'
                                ? response.prewarmEntryCreatedAt
                                : null,
                        trackAPrewarmEntryAgeMs:
                            typeof response?.prewarmEntryAgeMs === 'number'
                                ? response.prewarmEntryAgeMs
                                : null,
                    },
                });
            }
            if ( storedEntry === null ) {
                const targetNavigationAt = Date.now();
                const navigationHoldDurationMs = Math.max(0, targetNavigationAt - clickInterceptAt);
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
                    architectureHandoffSurface: 'sessionStorage',
                    architectureDonorStartedAt:
                        typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                    architectureDonorReadyAt:
                        typeof response?.donorReadyAt === 'number' ? response.donorReadyAt : null,
                    architectureHandoffReadyAt: handoffReadyAt,
                    architectureTargetNavigationAt: targetNavigationAt,
                    architectureTrackAPrewarmPredictionHit: predictionHit,
                    architectureTrackAPrewarmPredictionMiss: predictionMiss,
                    architectureTrackAPrewarmEntryStale: staleEntry,
                    architectureTrackAPrewarmRequested: response?.prewarmRequested === true,
                    architectureTrackAPrewarmEntryCreatedAt:
                        typeof response?.prewarmEntryCreatedAt === 'number'
                            ? response.prewarmEntryCreatedAt
                            : null,
                    architectureTrackAPrewarmEntryAgeMs:
                        typeof response?.prewarmEntryAgeMs === 'number'
                            ? response.prewarmEntryAgeMs
                            : null,
                    architectureEnvelopeReadyBeforeNavigationRelease: false,
                    architectureNavigationHoldDurationMs: navigationHoldDurationMs,
                    architectureFallbackPathUsed: true,
                    architectureTimeoutOccurred:
                        response?.error === 'timeout' || response?.timedOut === true,
                    architectureDocumentCommitEnvelopePresent: false,
                    architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
                    backgroundPrefetchError:
                        typeof response?.error === 'string'
                            ? response.error
                            : (staleEntry ? 'stale' : 'prewarm-miss'),
                });
                hardNavigateToWatch(normalizedTargetUrl);
                return;
            }
            return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                return requestFollowupCookieClear(
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                ).catch(() => false);
            }).then(neutralHopArmed => {
                const targetNavigationAt = Date.now();
                const navigationHoldDurationMs = Math.max(0, targetNavigationAt - clickInterceptAt);
                storedEntry.proof = {
                    ...(storedEntry.proof && typeof storedEntry.proof === 'object'
                        ? storedEntry.proof
                        : {}),
                    handoffReadyAt,
                    targetNavigationAt,
                    navigationHoldDurationMs,
                };
                storeTrackAArchitectureEntry(storedEntry);
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
                    architectureHandoffSurface: 'sessionStorage',
                    architectureDonorStartedAt:
                        typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                    architectureDonorReadyAt:
                        typeof response?.donorReadyAt === 'number' ? response.donorReadyAt : null,
                    architectureHandoffReadyAt: handoffReadyAt,
                    architectureTargetNavigationAt: targetNavigationAt,
                    architectureTrackAPrewarmPredictionHit: predictionHit,
                    architectureTrackAPrewarmPredictionMiss: predictionMiss,
                    architectureTrackAPrewarmEntryStale: staleEntry,
                    architectureTrackAPrewarmRequested: response?.prewarmRequested === true,
                    architectureTrackAPrewarmEntryCreatedAt:
                        typeof response?.prewarmEntryCreatedAt === 'number'
                            ? response.prewarmEntryCreatedAt
                            : null,
                    architectureTrackAPrewarmEntryAgeMs:
                        typeof response?.prewarmEntryAgeMs === 'number'
                            ? response.prewarmEntryAgeMs
                            : null,
                    architectureEnvelopeReadyBeforeNavigationRelease: true,
                    architectureNavigationHoldDurationMs: navigationHoldDurationMs,
                    architectureFallbackPathUsed: false,
                    architectureTimeoutOccurred: false,
                    architectureInvalidReason:
                        typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                            ? self.__talonYouTubeWatchArchitectureInvalidReason
                            : '',
                    architectureDocumentCommitEnvelopePresent: true,
                    architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
                    backgroundPrefetchError: '',
                });
                releasePreparedFollowupNavigation(
                    normalizedTargetUrl,
                    SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                );
            });
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            persistFollowupNavigationDebug({
                targetUrl: normalizedTargetUrl,
                architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_PREWARM,
                architectureHandoffSurface: 'sessionStorage',
                architectureTrackAPrewarmPredictionHit: false,
                architectureTrackAPrewarmPredictionMiss: true,
                architectureTrackAPrewarmEntryStale: false,
                architectureTrackAPrewarmRequested: false,
                architectureEnvelopeReadyBeforeNavigationRelease: false,
                architectureFallbackPathUsed: true,
                architectureTimeoutOccurred: true,
                architectureDocumentCommitEnvelopePresent: false,
                architectureDocumentCommitEnvelopeSource: 'track-a-session-storage',
                backgroundPrefetchError: 'bridge-error',
            });
            hardNavigateToWatch(normalizedTargetUrl);
        });
    };
    const runTrackAExactAnchorIntentLease = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        const clickInterceptAt = Date.now();
        const deadlineAt = clickInterceptAt + FOLLOWUP_PRECLICK_RELEASE_TIMEOUT_MS;
        const state = getActivePreclickTargetState(trackAIntentLeaseTargets, normalizedTargetUrl);
        const leaseHit = state instanceof Object && state.anchorSeenAt > 0;
        waitForTrackAIntentLeaseResult(state, deadlineAt).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            const handoffReadyAt = Date.now();
            const responseReady =
                response?.ok === true && response?.entry && typeof response.entry === 'object';
            let envelopeReady = false;
            if ( responseReady ) {
                const storedEntry = sanitizeArchitectureProofEntry({
                    ...response.entry,
                    strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE,
                    handoffSurface: 'sessionStorage',
                    proof: {
                        donorStartedAt:
                            typeof state?.donorStartedAt === 'number'
                                ? state.donorStartedAt
                                : (typeof response?.donorStartedAt === 'number'
                                    ? response.donorStartedAt
                                    : null),
                        donorReadyAt:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt
                                : (typeof response?.donorReadyAt === 'number'
                                    ? response.donorReadyAt
                                    : null),
                        handoffReadyAt,
                        anchorSeenAt:
                            typeof state?.anchorSeenAt === 'number' ? state.anchorSeenAt : null,
                        clickAt: clickInterceptAt,
                        readyAt:
                            typeof state?.readyAt === 'number'
                                ? state.readyAt
                                : (typeof response?.donorReadyAt === 'number'
                                    ? response.donorReadyAt
                                    : handoffReadyAt),
                        readyBeforeClick:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt <= clickInterceptAt
                                : false,
                        readyAfterClick:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt > clickInterceptAt
                                : false,
                        preclickSignalType:
                            typeof state?.firstSignalType === 'string'
                                ? state.firstSignalType
                                : '',
                        trackAIntentLeaseHit: leaseHit,
                        trackAIntentLeaseMiss: leaseHit !== true,
                        envelopeReadyBeforeNavigationRelease: true,
                        navigationHoldDurationMs: 0,
                        fallbackPathUsed: false,
                        timeoutOccurred: false,
                        invalidReason:
                            typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                                ? self.__talonYouTubeWatchArchitectureInvalidReason
                                : '',
                        backgroundPrefetchError: '',
                    },
                });
                if ( storedEntry !== null ) {
                    storeTrackAArchitectureEntry(storedEntry);
                    envelopeReady = didTrackAStoreVerificationPass();
                }
            }
            const failureCategory =
                envelopeReady === true
                    ? ''
                    : leaseHit !== true
                        ? 'trigger-timing'
                        : responseReady
                            ? 'readiness-validation'
                            : 'donor-latency';
            const finishRelease =
                envelopeReady === true
                    ? Promise.resolve()
                    : waitForPreclickReleaseTimeout(clickInterceptAt);
            return finishRelease.then(() => {
                return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                    return requestFollowupCookieClear(
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                    ).catch(() => false);
                }).then(neutralHopArmed => {
                    const targetNavigationAt = Date.now();
                    const navigationHoldDurationMs =
                        Math.max(0, targetNavigationAt - clickInterceptAt);
                    persistArchitectureOutcome(buildPreclickOutcomePatch({
                        strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE,
                        targetUrl: normalizedTargetUrl,
                        state,
                        clickAt: clickInterceptAt,
                        handoffReadyAt,
                        targetNavigationAt,
                        navigationHoldDurationMs,
                        envelopeReadyBeforeNavigationRelease: envelopeReady,
                        timeoutOccurred: envelopeReady !== true,
                        failureCategory,
                        backgroundPrefetchError:
                            envelopeReady === true
                                ? ''
                                : (typeof response?.error === 'string'
                                    ? response.error
                                    : (leaseHit ? 'timeout' : 'lease-miss')),
                        trackAIntentLeaseHit: leaseHit,
                        trackAIntentLeaseMiss: leaseHit !== true,
                    }));
                    releasePreparedFollowupNavigation(
                        normalizedTargetUrl,
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                    );
                });
            });
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            waitForPreclickReleaseTimeout(clickInterceptAt).then(() => {
                return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                    return requestFollowupCookieClear(
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                    ).catch(() => false);
                }).then(neutralHopArmed => {
                    const targetNavigationAt = Date.now();
                    const navigationHoldDurationMs =
                        Math.max(0, targetNavigationAt - clickInterceptAt);
                    persistArchitectureOutcome(buildPreclickOutcomePatch({
                        strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_INTENT_LEASE,
                        targetUrl: normalizedTargetUrl,
                        state,
                        clickAt: clickInterceptAt,
                        targetNavigationAt,
                        navigationHoldDurationMs,
                        envelopeReadyBeforeNavigationRelease: false,
                        timeoutOccurred: true,
                        failureCategory: leaseHit ? 'donor-latency' : 'trigger-timing',
                        backgroundPrefetchError: 'bridge-error',
                        trackAIntentLeaseHit: leaseHit,
                        trackAIntentLeaseMiss: leaseHit !== true,
                    }));
                    releasePreparedFollowupNavigation(
                        normalizedTargetUrl,
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                    );
                });
            });
        });
    };
    const runTrackAExactTargetDonorOwner = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        const clickInterceptAt = Date.now();
        const deadlineAt = clickInterceptAt + FOLLOWUP_PRECLICK_RELEASE_TIMEOUT_MS;
        const state = getActivePreclickTargetState(trackADonorOwnerTargets, normalizedTargetUrl);
        const ownerStarted = state instanceof Object && state.acquisitionStartedAt > 0;
        waitForTrackADonorOwnerResult(state, deadlineAt).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            const handoffReadyAt = Date.now();
            const transferOk =
                response?.ok === true && response?.entry && typeof response.entry === 'object';
            let envelopeReady = false;
            if ( transferOk ) {
                const storedEntry = sanitizeArchitectureProofEntry({
                    ...response.entry,
                    strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER,
                    handoffSurface: 'sessionStorage',
                    proof: {
                        donorStartedAt:
                            typeof state?.donorStartedAt === 'number'
                                ? state.donorStartedAt
                                : (typeof response?.donorStartedAt === 'number'
                                    ? response.donorStartedAt
                                    : null),
                        donorReadyAt:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt
                                : (typeof response?.donorReadyAt === 'number'
                                    ? response.donorReadyAt
                                    : null),
                        handoffReadyAt,
                        anchorSeenAt:
                            typeof state?.anchorSeenAt === 'number' ? state.anchorSeenAt : null,
                        clickAt: clickInterceptAt,
                        readyAt:
                            typeof state?.readyAt === 'number'
                                ? state.readyAt
                                : (typeof response?.donorReadyAt === 'number'
                                    ? response.donorReadyAt
                                    : handoffReadyAt),
                        readyBeforeClick:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt <= clickInterceptAt
                                : false,
                        readyAfterClick:
                            typeof state?.donorReadyAt === 'number'
                                ? state.donorReadyAt > clickInterceptAt
                                : false,
                        preclickSignalType:
                            typeof state?.firstSignalType === 'string'
                                ? state.firstSignalType
                                : '',
                        donorOwnerTransferOk: true,
                        donorOwnerReuseDetected:
                            response?.donorOwnerReuseDetected === true,
                        donorOwnerContaminationDetected:
                            response?.donorOwnerContaminationDetected === true,
                        donorOwnerStartLatencyMs:
                            typeof state?.anchorSeenAt === 'number' &&
                            typeof state?.donorStartedAt === 'number'
                                ? Math.max(0, state.donorStartedAt - state.anchorSeenAt)
                                : null,
                        envelopeReadyBeforeNavigationRelease: true,
                        navigationHoldDurationMs: 0,
                        fallbackPathUsed: false,
                        timeoutOccurred: false,
                        invalidReason:
                            typeof self.__talonYouTubeWatchArchitectureInvalidReason === 'string'
                                ? self.__talonYouTubeWatchArchitectureInvalidReason
                                : '',
                        backgroundPrefetchError: '',
                    },
                });
                if ( storedEntry !== null ) {
                    storeTrackAArchitectureEntry(storedEntry);
                    envelopeReady = didTrackAStoreVerificationPass();
                }
            }
            const failureCategory =
                envelopeReady === true
                    ? ''
                    : ownerStarted !== true
                        ? 'trigger-timing'
                        : transferOk
                            ? 'readiness-validation'
                            : 'donor-latency';
            const finishRelease =
                envelopeReady === true
                    ? Promise.resolve()
                    : waitForPreclickReleaseTimeout(clickInterceptAt);
            return finishRelease.then(() => {
                return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                    return requestFollowupCookieClear(
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                    ).catch(() => false);
                }).then(neutralHopArmed => {
                    const targetNavigationAt = Date.now();
                    const navigationHoldDurationMs =
                        Math.max(0, targetNavigationAt - clickInterceptAt);
                    persistArchitectureOutcome(buildPreclickOutcomePatch({
                        strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER,
                        targetUrl: normalizedTargetUrl,
                        state,
                        clickAt: clickInterceptAt,
                        handoffReadyAt,
                        targetNavigationAt,
                        navigationHoldDurationMs,
                        envelopeReadyBeforeNavigationRelease: envelopeReady,
                        timeoutOccurred: envelopeReady !== true,
                        failureCategory,
                        backgroundPrefetchError:
                            envelopeReady === true
                                ? ''
                                : (typeof response?.error === 'string'
                                    ? response.error
                                    : (ownerStarted ? 'timeout' : 'owner-miss')),
                        donorOwnerTransferOk: transferOk,
                        donorOwnerReuseDetected:
                            response?.donorOwnerReuseDetected === true,
                        donorOwnerContaminationDetected:
                            response?.donorOwnerContaminationDetected === true,
                    }));
                    releasePreparedFollowupNavigation(
                        normalizedTargetUrl,
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                    );
                });
            });
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            waitForPreclickReleaseTimeout(clickInterceptAt).then(() => {
                return unregisterFollowupServiceWorkers().catch(() => false).then(() => {
                    return requestFollowupCookieClear(
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true ? normalizedTargetUrl : ''
                    ).catch(() => false);
                }).then(neutralHopArmed => {
                    const targetNavigationAt = Date.now();
                    const navigationHoldDurationMs =
                        Math.max(0, targetNavigationAt - clickInterceptAt);
                    persistArchitectureOutcome(buildPreclickOutcomePatch({
                        strategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_A_DONOR_OWNER,
                        targetUrl: normalizedTargetUrl,
                        state,
                        clickAt: clickInterceptAt,
                        targetNavigationAt,
                        navigationHoldDurationMs,
                        envelopeReadyBeforeNavigationRelease: false,
                        timeoutOccurred: true,
                        failureCategory: ownerStarted ? 'donor-latency' : 'trigger-timing',
                        backgroundPrefetchError: 'bridge-error',
                        donorOwnerTransferOk: false,
                    }));
                    releasePreparedFollowupNavigation(
                        normalizedTargetUrl,
                        SHOULD_USE_EDGE_NEUTRAL_HOP === true && neutralHopArmed === true
                    );
                });
            });
        });
    };
    const runTrackBBackgroundRelay = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        if ( pendingFollowupArchitectureTargetUrl === normalizedTargetUrl ) { return; }
        pendingFollowupArchitectureTargetUrl = normalizedTargetUrl;
        const clickInterceptAt = Date.now();
        requestFollowupArchitectureProof(
            'start-relay',
            FOLLOWUP_ENTRY_STRATEGY_TRACK_B,
            normalizedTargetUrl
        ).then(response => {
            if ( pendingFollowupArchitectureTargetUrl !== normalizedTargetUrl ) { return; }
            pendingFollowupArchitectureTargetUrl = '';
            if ( response?.ok !== true || typeof response?.relayUrl !== 'string' || response.relayUrl === '' ) {
                persistFollowupNavigationDebug({
                    targetUrl: normalizedTargetUrl,
                    architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_B,
                    architectureHandoffSurface: 'windowName',
                    architectureDonorStartedAt:
                        typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                    architectureHandoffReadyAt: Date.now(),
                    architectureTargetNavigationAt: Date.now(),
                    architectureEnvelopeReadyBeforeNavigationRelease: false,
                    architectureNavigationHoldDurationMs: 0,
                    architectureFallbackPathUsed: true,
                    architectureTimeoutOccurred: true,
                    architectureDocumentCommitEnvelopePresent: false,
                    architectureDocumentCommitEnvelopeSource: 'track-b-window-name',
                    backgroundPrefetchError:
                        typeof response?.error === 'string' ? response.error : 'relay-start-failed',
                });
                hardNavigateToWatch(normalizedTargetUrl);
                return;
            }
            persistFollowupNavigationDebug({
                targetUrl: normalizedTargetUrl,
                architectureEntryStrategy: FOLLOWUP_ENTRY_STRATEGY_TRACK_B,
                architectureHandoffSurface: 'windowName',
                architectureDonorStartedAt:
                    typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
                architectureNavigationHoldDurationMs: Math.max(0, Date.now() - clickInterceptAt),
            });
            try {
                location.assign(response.relayUrl);
            } catch {
                hardNavigateToWatch(normalizedTargetUrl);
            }
        }).catch(() => {
            pendingFollowupArchitectureTargetUrl = '';
            hardNavigateToWatch(normalizedTargetUrl);
        });
    };
    const clearCookiesAndHardNavigateToWatch = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) {
            hardNavigateToWatch(nextUrl);
            return;
        }
        prepareFollowupNavigation(normalizedTargetUrl).then(result => {
            if ( result?.token !== pendingFollowupCookieClearToken ) { return; }
            pendingFollowupNavigationPreparation = null;
            requestBackgroundFollowupNavigation(normalizedTargetUrl).then(navigated => {
                if ( navigated === true ) { return; }
                if ( result?.neutralHopArmed === true && navigateThroughNeutralHop() ) {
                    return;
                }
                hardNavigateToWatch(nextUrl);
            });
        });
    };
    const scheduleSidebarSpaFallback = nextUrl => {
        const normalizedTargetUrl = normalizeWatchUrl(nextUrl);
        if ( normalizedTargetUrl === '' ) { return; }
        const token = ++pendingSidebarSpaFallbackToken;
        pendingSidebarSpaWatchUrl = normalizedTargetUrl;
        const lastDelay = SPA_AD_FALLBACK_DELAYS_MS[SPA_AD_FALLBACK_DELAYS_MS.length - 1];
        for ( const delay of SPA_AD_FALLBACK_DELAYS_MS ) {
            self.setTimeout(() => {
                if ( token !== pendingSidebarSpaFallbackToken ) { return; }
                if ( pendingSidebarSpaWatchUrl !== normalizedTargetUrl ) { return; }
                if ( normalizeWatchUrl(location.href) !== normalizedTargetUrl ) { return; }
                if ( isMainPlayerPlayable() ) {
                    pendingSidebarSpaWatchUrl = '';
                    return;
                }
                if ( shouldEscalateSidebarSpaFallback(delay) ) {
                    pendingSidebarSpaWatchUrl = '';
                    pendingSidebarSpaFallbackToken += 1;
                    hardNavigateToWatch(normalizedTargetUrl);
                    return;
                }
                if ( delay === lastDelay ) {
                    pendingSidebarSpaWatchUrl = '';
                }
            }, delay);
        }
    };

    if ( ENABLE_PAGEHIDE_TEARDOWN ) {
        self.addEventListener('pagehide', () => {
            teardownCurrentVideo();
        }, { capture: true });
    }

    if ( ENABLE_FORCED_WATCH_HARD_NAV ) {
        const primePreclickOwnershipFromEvent = (event, signalType) => {
            const anchor = capturePreclickAnchorFromEvent(event);
            if ( anchor === null ) { return; }
            notePreclickTargetSignal(anchor, signalType);
        };
        const primeFollowupNavigationFromEvent = event => {
            markForcedWatchNavigationListenerEvent(event);
            const nextUrl = getForcedWatchNavigationTargetFromEvent(event);
            if ( nextUrl === '' ) { return; }
            markForcedWatchNavigationEvent(event.type, nextUrl);
            if ( isFollowupArchitectureProofMode ) { return; }
            armFollowupNextSuppression(nextUrl);
            prepareFollowupNavigation(nextUrl);
        };
        document.addEventListener('pointerover', event => {
            primePreclickOwnershipFromEvent(event, 'hover');
        }, true);
        document.addEventListener('focusin', event => {
            primePreclickOwnershipFromEvent(event, 'focusin');
        }, true);
        document.addEventListener('touchstart', event => {
            primePreclickOwnershipFromEvent(event, 'touchstart');
        }, true);
        document.addEventListener('pointerdown', event => {
            markForcedWatchNavigationListenerEvent(event);
            const nextUrl = getForcedWatchNavigationTargetFromEvent(event);
            if ( nextUrl === '' ) { return; }
            markForcedWatchNavigationEvent(event.type, nextUrl);
            event.preventDefault();
            event.stopImmediatePropagation();
            armFollowupNextSuppression(nextUrl);
            if ( isFollowupArchitectureTrackA ) {
                runTrackAControlledEntry(nextUrl);
                return;
            }
            if ( isFollowupArchitectureTrackACommit ) {
                runTrackASameOriginCommit(nextUrl);
                return;
            }
            if ( isFollowupArchitectureTrackAPrewarm ) {
                runTrackAPrewarmPool(nextUrl);
                return;
            }
            if ( isFollowupArchitectureTrackAIntentLease ) {
                runTrackAExactAnchorIntentLease(nextUrl);
                return;
            }
            if ( isFollowupArchitectureTrackADonorOwner ) {
                runTrackAExactTargetDonorOwner(nextUrl);
                return;
            }
            if ( isFollowupArchitectureTrackB ) {
                runTrackBBackgroundRelay(nextUrl);
                return;
            }
            clearCookiesAndHardNavigateToWatch(nextUrl);
        }, true);
        document.addEventListener('mousedown', primeFollowupNavigationFromEvent, true);
        document.addEventListener('click', event => {
            markForcedWatchNavigationListenerEvent(event);
            const nextUrl = getForcedWatchNavigationTargetFromEvent(event);
            if ( nextUrl === '' ) { return; }
            markForcedWatchNavigationEvent(event.type, nextUrl);
            event.preventDefault();
            event.stopImmediatePropagation();
            if ( isFollowupArchitectureProofMode ) {
                if ( pendingFollowupArchitectureTargetUrl === nextUrl ) {
                    return;
                }
                if ( isFollowupArchitectureTrackA ) {
                    runTrackAControlledEntry(nextUrl);
                    return;
                }
                if ( isFollowupArchitectureTrackACommit ) {
                    runTrackASameOriginCommit(nextUrl);
                    return;
                }
                if ( isFollowupArchitectureTrackAPrewarm ) {
                    runTrackAPrewarmPool(nextUrl);
                    return;
                }
                if ( isFollowupArchitectureTrackAIntentLease ) {
                    runTrackAExactAnchorIntentLease(nextUrl);
                    return;
                }
                if ( isFollowupArchitectureTrackADonorOwner ) {
                    runTrackAExactTargetDonorOwner(nextUrl);
                    return;
                }
                if ( isFollowupArchitectureTrackB ) {
                    runTrackBBackgroundRelay(nextUrl);
                    return;
                }
            }
            clearCookiesAndHardNavigateToWatch(nextUrl);
        }, true);
        self.__talonYouTubeWatchFollowupListenersInstalledAt = Date.now();
        persistSanitizerHealth({
            stage: 'followup-listeners-installed',
            followupListenersInstalledAt: self.__talonYouTubeWatchFollowupListenersInstalledAt,
        });
    }

    if ( isFollowupArchitectureTrackAPrewarm && self.MutationObserver ) {
        const startTrackAPrewarmObserver = () => {
            if ( shouldPrewarmTrackATargetOnCurrentPage() === false ) { return; }
            const root = document.documentElement || document.body;
            if ( root === null ) { return; }
            maybePrewarmTrackATargets(document);
            const observer = new MutationObserver(records => {
                if ( shouldPrewarmTrackATargetOnCurrentPage() === false ) {
                    observer.disconnect();
                    return;
                }
                for ( const record of records ) {
                    for ( const addedNode of record.addedNodes ) {
                        maybePrewarmTrackATargets(addedNode);
                    }
                }
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
            });
        };
        if ( document.readyState === 'loading' ) {
            document.addEventListener('DOMContentLoaded', startTrackAPrewarmObserver, { once: true });
        } else {
            startTrackAPrewarmObserver();
        }
    }

    if (
        (isFollowupArchitectureTrackAIntentLease || isFollowupArchitectureTrackADonorOwner) &&
        self.MutationObserver
    ) {
        const scanPreclickOwnershipTargets = root => {
            if ( root === null || typeof root !== 'object' ) { return; }
            if ( self.HTMLAnchorElement !== undefined && root instanceof self.HTMLAnchorElement ) {
                schedulePreclickAnchorExposure(root);
            }
            const queryRoot =
                typeof root.querySelectorAll === 'function'
                    ? root
                    : document;
            if ( queryRoot && typeof queryRoot.querySelectorAll === 'function' ) {
                for ( const anchor of queryRoot.querySelectorAll('#secondary a[href]') ) {
                    schedulePreclickAnchorExposure(anchor);
                }
            }
        };
        const startPreclickOwnershipObserver = () => {
            const root = document.documentElement || document.body;
            if ( root === null ) { return; }
            scanPreclickOwnershipTargets(document);
            const observer = new MutationObserver(records => {
                for ( const record of records ) {
                    for ( const addedNode of record.addedNodes ) {
                        scanPreclickOwnershipTargets(addedNode);
                    }
                }
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
            });
        };
        if ( document.readyState === 'loading' ) {
            document.addEventListener('DOMContentLoaded', startPreclickOwnershipObserver, {
                once: true,
            });
        } else {
            startPreclickOwnershipObserver();
        }
    }

    document.addEventListener('click', event => {
        const nextUrl = getForcedWatchNavigationTargetFromEvent(event);
        if ( nextUrl === '' ) { return; }
        if ( nextUrl === normalizeWatchUrl(location.href) ) { return; }
        pendingSidebarSpaWatchUrl = nextUrl;
    }, true);

    document.addEventListener('yt-navigate-finish', () => {
        refreshFollowupWatchNavigationState();
        if ( isFollowupArchitectureTrackAPrewarm ) {
            maybePrewarmTrackATargets(document);
        }
        if ( pendingSidebarSpaWatchUrl === '' ) { return; }
        if ( normalizeWatchUrl(location.href) !== pendingSidebarSpaWatchUrl ) { return; }
        scheduleSidebarSpaFallback(pendingSidebarSpaWatchUrl);
    }, true);

    const isSidebarPreviewMedia = media => {
        if ( self.HTMLMediaElement === undefined || media instanceof self.HTMLMediaElement === false ) {
            return false;
        }
        return typeof media.closest === 'function' && media.closest('#secondary') !== null;
    };

    const suppressSidebarPreviewMedia = media => {
        if ( isSidebarPreviewMedia(media) === false ) { return; }
        const shouldResetMedia =
            (typeof media.currentSrc === 'string' && media.currentSrc !== '') ||
            (typeof media.networkState === 'number' && media.networkState !== 0) ||
            (typeof media.readyState === 'number' && media.readyState !== 0) ||
            media.hasAttribute?.('src') === true ||
            media.querySelector?.('source[src]') !== null;
        try { media.pause(); } catch {}
        for ( const source of media.querySelectorAll?.('source') || [] ) {
            try { source.removeAttribute('src'); } catch {}
        }
        try { media.removeAttribute('src'); } catch {}
        try { media.preload = 'none'; } catch {}
        try { media.autoplay = false; } catch {}
        if ( shouldResetMedia ) {
            try { media.load(); } catch {}
        }
    };

    const scanForSidebarPreviewMedia = root => {
        if ( root === null || root === undefined ) { return; }
        if ( isSidebarPreviewMedia(root) ) {
            suppressSidebarPreviewMedia(root);
        }
        if ( typeof root.querySelectorAll !== 'function' ) { return; }
        for ( const media of root.querySelectorAll('video, audio') ) {
            suppressSidebarPreviewMedia(media);
        }
    };

    const ENABLE_SIDEBAR_PREVIEW_PLAY_PROXY = ENABLE_SIDEBAR_PREVIEW_GUARDS;

    if ( ENABLE_SIDEBAR_PREVIEW_PLAY_PROXY ) {
        const nativeMediaPlay = self.HTMLMediaElement && self.HTMLMediaElement.prototype
            ? self.HTMLMediaElement.prototype.play
            : undefined;
        if ( typeof nativeMediaPlay === 'function' ) {
            self.HTMLMediaElement.prototype.play = new Proxy(nativeMediaPlay, {
                apply(target, thisArg, args) {
                    if ( isSidebarPreviewMedia(thisArg) ) {
                        suppressSidebarPreviewMedia(thisArg);
                        return Promise.resolve();
                    }
                    return Reflect.apply(target, thisArg, args);
                },
            });
        }
    }

    if ( ENABLE_SIDEBAR_PREVIEW_GUARDS && self.MutationObserver ) {
        const startSidebarPreviewObserver = () => {
            const root = document.documentElement || document.body;
            if ( root === null ) { return; }
            scanForSidebarPreviewMedia(root);
            const observer = new MutationObserver(records => {
                for ( const record of records ) {
                    for ( const addedNode of record.addedNodes ) {
                        scanForSidebarPreviewMedia(addedNode);
                    }
                }
            });
            observer.observe(root, {
                childList: true,
                subtree: true,
            });
        };
        if ( document.readyState === 'loading' ) {
            document.addEventListener('DOMContentLoaded', startSidebarPreviewObserver, { once: true });
        } else {
            startSidebarPreviewObserver();
        }
    }

    const NativeResponse = self.Response;
    const nativeResponseJson = NativeResponse && NativeResponse.prototype
        ? NativeResponse.prototype.json
        : undefined;
    const nativeResponseText = NativeResponse && NativeResponse.prototype
        ? NativeResponse.prototype.text
        : undefined;

    if ( typeof nativeResponseJson === 'function' ) {
        NativeResponse.prototype.json = new Proxy(nativeResponseJson, {
            apply(target, thisArg, args) {
                const jsonPromise = Reflect.apply(target, thisArg, args);
                const url = thisArg && typeof thisArg.url === 'string'
                    ? thisArg.url
                    : '';
                const sanitizeMode = getSanitizeMode(url);
                if ( sanitizeMode === '' ) { return jsonPromise; }
                return Promise.resolve(jsonPromise).then(payload => {
                    if ( payload === null || typeof payload !== 'object' ) {
                        return payload;
                    }
                    return sanitizePayloadForMode(sanitizeMode, clonePayload(payload), {
                        source: 'response.json',
                        url,
                    });
                });
            },
        });
    }

    if ( typeof nativeResponseText === 'function' ) {
        NativeResponse.prototype.text = new Proxy(nativeResponseText, {
            apply(target, thisArg, args) {
                const textPromise = Reflect.apply(target, thisArg, args);
                const url = thisArg && typeof thisArg.url === 'string'
                    ? thisArg.url
                    : '';
                const sanitizeMode = getSanitizeMode(url);
                if ( sanitizeMode === '' ) { return textPromise; }
                return Promise.resolve(textPromise).then(text => {
                    if ( typeof text !== 'string' || text === '' ) { return text; }
                    let payload;
                    try {
                        payload = JSON.parse(text);
                    } catch {
                        return text;
                    }
                    if ( payload === null || typeof payload !== 'object' ) {
                        return text;
                    }
                    return JSON.stringify(sanitizePayloadForMode(sanitizeMode, clonePayload(payload), {
                        source: 'response.text',
                        url,
                    }));
                });
            },
        });
    }

    if ( ENABLE_AD_ENDPOINT_DOM_STUBS ) {
        self.google_ad_status = 1;

        const noopScriptUrls = new WeakMap();
        const queueNoopScriptLoad = script => {
            setTimeout(() => {
                try { script.dispatchEvent(new Event('load')); } catch {}
            }, 0);
        };
        const markNoopScript = (script, url) => {
            if ( self.HTMLScriptElement === undefined || script instanceof self.HTMLScriptElement === false ) {
                return false;
            }
            if ( shouldStubAdStatusScript(url) === false ) { return false; }
            noopScriptUrls.set(script, url);
            self.google_ad_status = 1;
            return true;
        };
        const prepareNoopScriptForInsertion = child => {
            if ( self.HTMLScriptElement === undefined || child instanceof self.HTMLScriptElement === false ) {
                return false;
            }
            const scriptUrl = noopScriptUrls.get(child)
                || child.getAttribute('src')
                || child.src
                || '';
            if ( markNoopScript(child, scriptUrl) === false ) {
                return false;
            }
            try { child.type = 'application/x-talon-noop'; } catch {}
            try { child.removeAttribute('src'); } catch {}
            return true;
        };

        const imageSrcDescriptor = self.HTMLImageElement
            ? Object.getOwnPropertyDescriptor(self.HTMLImageElement.prototype, 'src')
            : undefined;
        if ( imageSrcDescriptor && typeof imageSrcDescriptor.set === 'function' ) {
            Object.defineProperty(self.HTMLImageElement.prototype, 'src', {
                configurable: true,
                enumerable: imageSrcDescriptor.enumerable,
                get() {
                    return imageSrcDescriptor.get.call(this);
                },
                set(value) {
                    const nextValue = shouldStubPixelImage(value) ? STUB_PIXEL_URL : value;
                    return imageSrcDescriptor.set.call(this, nextValue);
                },
            });
        }

        const scriptSrcDescriptor = self.HTMLScriptElement
            ? Object.getOwnPropertyDescriptor(self.HTMLScriptElement.prototype, 'src')
            : undefined;
        if ( scriptSrcDescriptor && typeof scriptSrcDescriptor.set === 'function' ) {
            Object.defineProperty(self.HTMLScriptElement.prototype, 'src', {
                configurable: true,
                enumerable: scriptSrcDescriptor.enumerable,
                get() {
                    return noopScriptUrls.get(this) || scriptSrcDescriptor.get.call(this);
                },
                set(value) {
                    if ( markNoopScript(this, value) ) { return value; }
                    return scriptSrcDescriptor.set.call(this, value);
                },
            });
        }

        const nativeSetAttribute = self.Element && self.Element.prototype
            ? self.Element.prototype.setAttribute
            : undefined;
        if ( typeof nativeSetAttribute === 'function' ) {
            self.Element.prototype.setAttribute = new Proxy(nativeSetAttribute, {
                apply(target, thisArg, args) {
                    if (
                        self.HTMLImageElement &&
                        thisArg instanceof self.HTMLImageElement &&
                        typeof args[0] === 'string' &&
                        args[0].toLowerCase() === 'src' &&
                        shouldStubPixelImage(args[1])
                    ) {
                        args = [ args[0], STUB_PIXEL_URL ];
                    }
                    if (
                        self.HTMLScriptElement &&
                        thisArg instanceof self.HTMLScriptElement &&
                        typeof args[0] === 'string' &&
                        args[0].toLowerCase() === 'src' &&
                        markNoopScript(thisArg, args[1])
                    ) {
                        return;
                    }
                    return Reflect.apply(target, thisArg, args);
                },
            });
        }

        const nativeAppendChild = self.Node && self.Node.prototype
            ? self.Node.prototype.appendChild
            : undefined;
        if ( typeof nativeAppendChild === 'function' ) {
            self.Node.prototype.appendChild = new Proxy(nativeAppendChild, {
                apply(target, thisArg, args) {
                    const child = args[0];
                    const shouldQueueLoad = prepareNoopScriptForInsertion(child);
                    const result = Reflect.apply(target, thisArg, args);
                    if ( shouldQueueLoad || noopScriptUrls.has(child) ) {
                        queueNoopScriptLoad(child);
                    }
                    return result;
                },
            });
        }

        const nativeInsertBefore = self.Node && self.Node.prototype
            ? self.Node.prototype.insertBefore
            : undefined;
        if ( typeof nativeInsertBefore === 'function' ) {
            self.Node.prototype.insertBefore = new Proxy(nativeInsertBefore, {
                apply(target, thisArg, args) {
                    const child = args[0];
                    const shouldQueueLoad = prepareNoopScriptForInsertion(child);
                    const result = Reflect.apply(target, thisArg, args);
                    if ( shouldQueueLoad || noopScriptUrls.has(child) ) {
                        queueNoopScriptLoad(child);
                    }
                    return result;
                },
            });
        }

        const nativeReplaceChild = self.Node && self.Node.prototype
            ? self.Node.prototype.replaceChild
            : undefined;
        if ( typeof nativeReplaceChild === 'function' ) {
            self.Node.prototype.replaceChild = new Proxy(nativeReplaceChild, {
                apply(target, thisArg, args) {
                    const child = args[0];
                    const shouldQueueLoad = prepareNoopScriptForInsertion(child);
                    const result = Reflect.apply(target, thisArg, args);
                    if ( shouldQueueLoad || noopScriptUrls.has(child) ) {
                        queueNoopScriptLoad(child);
                    }
                    return result;
                },
            });
        }
    }

    const xhrStates = new WeakMap();
    const NativeXHR = self.XMLHttpRequest;

    const dispatchXhrEvent = (xhr, type) => {
        let event;
        try {
            event = new ProgressEvent(type);
        } catch {
            event = new Event(type);
        }
        xhr.dispatchEvent(event);
    };

    const parseStubJsonBody = body => {
        const normalized = body.replace(/^\)\]\}'\s*/, '');
        try {
            return JSON.parse(normalized);
        } catch {
            return null;
        }
    };

    const buildXhrStubProfile = url => ENABLE_AD_ENDPOINT_XHR_STUBS
        ? buildStubProfile(url)
        : null;

    const completeStubbedXhr = (xhr, state) => {
        state.stubReadyState = 1;
        dispatchXhrEvent(xhr, 'loadstart');
        state.stubReadyState = 2;
        dispatchXhrEvent(xhr, 'readystatechange');
        state.stubReadyState = 3;
        dispatchXhrEvent(xhr, 'readystatechange');
        state.stubBody = state.stubProfile?.body || '';
        state.stubReadyState = 4;
        dispatchXhrEvent(xhr, 'readystatechange');
        dispatchXhrEvent(xhr, 'load');
        dispatchXhrEvent(xhr, 'loadend');
    };

    self.XMLHttpRequest = class extends NativeXHR {
        open(method, url, ...args) {
            const stubProfile = buildXhrStubProfile(url);
            const sanitizeMode = getSanitizeMode(url);
            const state = {
                sanitizeMode,
                patchPlayerRequest: shouldPatchPlayerRequest(url),
                stubProfile,
                stubReadyState: stubProfile ? 1 : 0,
                stubBody: '',
                response: undefined,
                responseLength: undefined,
                url,
            };
            if ( state.sanitizeMode !== '' || state.patchPlayerRequest || state.stubProfile ) {
                xhrStates.set(this, state);
            }
            return super.open(method, url, ...args);
        }

        send(body) {
            const state = xhrStates.get(this);
            if ( state === undefined ) {
                return super.send(body);
            }
            if ( state.patchPlayerRequest ) {
                body = patchPlayerRequestBody(body);
            }
            if ( state.stubProfile ) {
                noteStubbedEndpoint(state.url, 'xhr');
                setTimeout(() => completeStubbedXhr(this, state), 0);
                return;
            }
            return super.send(body);
        }

        abort() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                state.stubReadyState = 0;
                state.stubBody = '';
                dispatchXhrEvent(this, 'abort');
                dispatchXhrEvent(this, 'loadend');
                return;
            }
            return super.abort();
        }

        get readyState() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.stubReadyState;
            }
            return super.readyState;
        }

        get status() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.stubReadyState >= 2 ? state.stubProfile.status : 0;
            }
            return super.status;
        }

        get statusText() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.stubReadyState >= 2 ? state.stubProfile.statusText : '';
            }
            return super.statusText;
        }

        get responseURL() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.url;
            }
            return super.responseURL;
        }

        get response() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                if ( state.stubReadyState < 4 ) { return null; }
                const responseType = this.responseType || '';
                if ( responseType === '' || responseType === 'text' ) {
                    return state.stubBody;
                }
                if ( responseType === 'json' ) {
                    return parseStubJsonBody(state.stubBody);
                }
                if ( responseType === 'arraybuffer' ) {
                    return new TextEncoder().encode(state.stubBody).buffer;
                }
                if ( responseType === 'blob' ) {
                    return new Blob([ state.stubBody ], {
                        type: state.stubProfile.contentType || '',
                    });
                }
                return state.stubBody;
            }

            const innerResponse = super.response;
            if ( state === undefined || state.sanitizeMode === '' ) {
                return innerResponse;
            }

            const responseLength = typeof innerResponse === 'string'
                ? innerResponse.length
                : undefined;
            if ( state.responseLength !== responseLength ) {
                state.response = undefined;
                state.responseLength = responseLength;
            }
            if ( state.response !== undefined ) { return state.response; }

            let payload = null;
            if ( typeof innerResponse === 'string' ) {
                try {
                    payload = JSON.parse(innerResponse);
                } catch {
                }
            } else if ( innerResponse && typeof innerResponse === 'object' ) {
                payload = innerResponse;
            }
            if ( payload === null || typeof payload !== 'object' ) {
                state.response = innerResponse;
                return innerResponse;
            }

            const sanitized = sanitizePayloadForMode(state.sanitizeMode, clonePayload(payload), {
                source: 'xhr.response',
                url: state.url,
            });
            state.response = typeof innerResponse === 'string'
                ? JSON.stringify(sanitized)
                : sanitized;
            return state.response;
        }

        get responseText() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.stubReadyState >= 4 ? state.stubBody : '';
            }
            const response = this.response;
            return typeof response === 'string'
                ? response
                : super.responseText;
        }

        getAllResponseHeaders() {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                return state.stubReadyState >= 2 ? state.stubProfile.headersText : '';
            }
            return super.getAllResponseHeaders();
        }

        getResponseHeader(name) {
            const state = xhrStates.get(this);
            if ( state && state.stubProfile ) {
                if ( state.stubReadyState < 2 || typeof name !== 'string' ) {
                    return null;
                }
                const normalized = name.trim().toLowerCase();
                if ( normalized === 'content-type' ) {
                    return state.stubProfile.contentType || null;
                }
                if ( normalized === 'cache-control' ) {
                    return 'no-cache';
                }
                return null;
            }
            return super.getResponseHeader(name);
        }
    };
    } catch ( reason ) {
        markSanitizerFatal(reason);
        throw reason;
    }
})();
