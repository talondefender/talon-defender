/******************************************************************************/
// Presentation only. The background owns eligibility and all protection
// lifecycle changes; this observer never starts, stops, or changes playback.
(function talonYoutubeEntitlementObserver(global) {

if ( global.TalonYoutubeEntitlementObserverController ) {
    global.TalonYoutubeEntitlementObserverController.start?.();
    return;
}

const AD_STATE_SELECTOR = '.html5-video-player.ad-showing,#movie_player.ad-showing';
const CHECK_INTERVAL_MS = 500;
const HIDDEN_CHECK_INTERVAL_MS = 1500;
const POLICY_TIMEOUT_MS = 2000;
const POLICY_RETRY_MS = 1000;
const MAX_POLICY_RETRIES = 8;
const POLICY_STORAGE_KEYS = new Set([
    'talonEntitlement', 'filteringModeDetails', 'autoBackoffSubsystemsV1',
]);

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const chromeApi = env.chrome || win.chrome;
    let state = 'unknown';
    let active = false;
    let generation = 0;
    let intervalId;
    let retryTimerId;
    let requestTimerId;
    let boundaryTimerId;
    let cancelRequest;
    let retries = 0;

    const isSupportedDocument = () => {
        try {
            return (!win.top || win.top === win) &&
                /(^|\.)youtube(?:-nocookie)?\.com$/i.test(win.location?.hostname || '');
        } catch {
        }
        return false;
    };

    const setExpiredFeedback = value => {
        try {
            if ( value ) {
                return win.TalonYoutubeAdFeedbackController?.setActive?.(
                    true, { mode: 'expired' }
                ) === true;
            }
            win.TalonYoutubeAdFeedbackController?.stop?.({ mode: 'expired' });
        } catch {
        }
        return false;
    };

    const isAdShowing = () => {
        try {
            const player = doc.querySelector?.(AD_STATE_SELECTOR);
            if ( !player || player.hidden === true ) { return false; }
            const style = win.getComputedStyle?.(player);
            if ( style && (style.display === 'none' || style.visibility === 'hidden' ||
                Number(style.opacity) === 0) ) { return false; }
            const rects = player.getClientRects?.();
            return !rects || rects.length !== 0;
        } catch {
        }
        return false;
    };

    const tick = () => {
        const showing = active && state === 'expired' && isAdShowing();
        setExpiredFeedback(showing);
        return showing;
    };

    const clearTimers = () => {
        cancelRequest?.();
        cancelRequest = undefined;
        if ( intervalId !== undefined ) { win.clearInterval?.(intervalId); }
        if ( retryTimerId !== undefined ) { win.clearTimeout?.(retryTimerId); }
        if ( requestTimerId !== undefined ) { win.clearTimeout?.(requestTimerId); }
        if ( boundaryTimerId !== undefined ) { win.clearTimeout?.(boundaryTimerId); }
        intervalId = retryTimerId = requestTimerId = undefined;
        boundaryTimerId = undefined;
    };

    const refreshDetectionTimer = () => {
        if ( intervalId !== undefined ) { win.clearInterval?.(intervalId); }
        intervalId = undefined;
        if ( active === false || state !== 'expired' ) { return; }
        intervalId = win.setInterval?.(tick, doc.visibilityState === 'hidden'
            ? HIDDEN_CHECK_INTERVAL_MS : CHECK_INTERVAL_MS);
    };

    const refresh = async ({ resetRetries = true } = {}) => {
        if ( active === false ) { return false; }
        const epoch = ++generation;
        clearTimers();
        state = 'unknown';
        setExpiredFeedback(false);
        if ( resetRetries ) { retries = 0; }
        let policy;
        try {
            const request = chromeApi?.runtime?.sendMessage?.({ what: 'getYoutubeFeedbackPolicy' });
            policy = await Promise.race([
                Promise.resolve(request),
                new Promise(resolve => {
                    cancelRequest = () => resolve(undefined);
                    requestTimerId = win.setTimeout?.(() => resolve(undefined), POLICY_TIMEOUT_MS);
                }),
            ]);
        } catch {
        }
        if ( active === false || epoch !== generation ) { return false; }
        if ( requestTimerId !== undefined ) { win.clearTimeout?.(requestTimerId); }
        requestTimerId = undefined;
        cancelRequest = undefined;
        if ( policy?.ready !== true ) {
            if ( retries < MAX_POLICY_RETRIES ) {
                retries += 1;
                retryTimerId = win.setTimeout?.(() => {
                    retryTimerId = undefined;
                    if ( active && epoch === generation ) { refresh({ resetRetries: false }); }
                }, Math.min(retries, 4) * POLICY_RETRY_MS);
            }
            return false;
        }
        state = policy.enabled !== true ? 'disabled'
            : policy.expired === true ? 'expired' : 'entitled';
        if ( Number.isFinite(policy.refreshAfterMs) && policy.refreshAfterMs > 0 ) {
            boundaryTimerId = win.setTimeout?.(() => {
                boundaryTimerId = undefined;
                if ( active && epoch === generation ) { refresh(); }
            }, Math.min(2147483647, Math.max(50, policy.refreshAfterMs)));
        }
        refreshDetectionTimer();
        return tick();
    };

    const onStorageChanged = (changes, areaName) => {
        if ( areaName !== 'local' && areaName !== 'session' && areaName !== 'managed' ) { return; }
        if ( areaName === 'managed' || Object.keys(changes || []).some(key => POLICY_STORAGE_KEYS.has(key)) ) {
            refresh();
        }
    };
    const onRuntimeMessage = message => {
        if ( message?.youtubeFeedbackPolicyChanged === true ) {
            refresh();
        }
    };
    const onVisibilityChange = () => {
        if ( doc.visibilityState !== 'hidden' ) { refresh(); }
        else { refreshDetectionTimer(); }
    };
    const onNavigate = () => { refresh(); };

    const stop = () => {
        active = false;
        generation += 1;
        state = 'unknown';
        clearTimers();
        setExpiredFeedback(false);
        chromeApi?.storage?.onChanged?.removeListener?.(onStorageChanged);
        chromeApi?.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
        doc.removeEventListener?.('visibilitychange', onVisibilityChange);
        doc.removeEventListener?.('yt-navigate-finish', onNavigate);
        win.removeEventListener?.('pagehide', stop);
        // Keep one dormant BFCache wake listener. No timers or DOM survive stop.
    };

    const start = () => {
        if ( isSupportedDocument() === false ) { return Promise.resolve(false); }
        if ( active === false ) {
            active = true;
            chromeApi?.storage?.onChanged?.addListener?.(onStorageChanged);
            chromeApi?.runtime?.onMessage?.addListener?.(onRuntimeMessage);
            doc.addEventListener?.('visibilitychange', onVisibilityChange);
            doc.addEventListener?.('yt-navigate-finish', onNavigate);
            win.addEventListener?.('pagehide', stop);
            win.removeEventListener?.('pageshow', start);
            win.addEventListener?.('pageshow', start);
        }
        return refresh();
    };

    return {
        revision: 2,
        getState: () => state,
        isActive: () => active,
        init: start,
        start,
        refresh,
        stop,
        tick,
        isAdShowing,
    };
};

if ( global.__talonYoutubeEntitlementObserverTest === true ) {
    global.__talonYoutubeEntitlementObserverCreateController = createController;
    return;
}
const controller = createController(global);
global.TalonYoutubeEntitlementObserverController = controller;
controller.init();
})(globalThis);

void 0;
