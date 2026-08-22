/******************************************************************************/
// Always-present, read-only YouTube entitlement observer. This controller may
// detect YouTube ad state and render presentation, but it must never click ad
// controls or mutate video playback, audio, timelines, or network behavior.
(function talonYoutubeEntitlementObserver(global) {

if ( global.TalonYoutubeEntitlementObserverController ) {
    global.TalonYoutubeEntitlementObserverController.refresh?.();
    return;
}

const ENTITLEMENT_STORAGE_KEY = 'talonEntitlement';
const TRIAL_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 500;
const HIDDEN_CHECK_INTERVAL_MS = 1500;
const EXPIRED_MODE = 'expired';
const HARD_DENY_CODES = new Set([
    'EXPIRED', 'REVOKED', 'MAX_DEVICES', 'TRIAL_ENDED',
]);
const AD_STATE_SELECTOR = [
    '.html5-video-player.ad-showing',
    '#movie_player.ad-showing',
].join(',');
const AD_INDICATOR_SELECTOR = [
    '.ytp-ad-badge',
    '.ytp-ad-module',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container',
].join(',');

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const chromeApi = env.chrome || win.chrome;
    let entitlementState = 'unknown';
    let intervalId;
    let boundaryTimerId;
    let stopped = false;

    const isTopFrame = () => {
        try {
            return !win.top || win.top === win;
        } catch {
        }
        return false;
    };

    const toNumber = value => {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    };

    const computeState = (stored, now = Date.now()) => {
        if ( !stored || typeof stored !== 'object' || Array.isArray(stored) ) {
            return { status: 'unknown', nextBoundaryMs: 0 };
        }
        const trialStartMs = toNumber(stored.trialStartMs);
        const trialEndMs = toNumber(stored.trialEndMs) ||
            (trialStartMs > 0 ? trialStartMs + TRIAL_PERIOD_MS : 0);
        const entitledUntilMs = toNumber(stored.entitledUntilMs);
        const graceUntilMs = toNumber(stored.graceUntilMs);
        const hardDeny = HARD_DENY_CODES.has(
            String(stored.lastErrorCode || '').trim().toUpperCase()
        );
        const paidActive = hardDeny === false && (
            entitledUntilMs > now ||
            (entitledUntilMs > 0 && graceUntilMs > now)
        );
        const trialActive = trialEndMs > now;
        const known = trialStartMs > 0 ||
            entitledUntilMs > 0 ||
            graceUntilMs > 0 ||
            typeof stored.licenseKey === 'string';
        const boundaries = [ trialEndMs, entitledUntilMs, graceUntilMs ]
            .filter(value => value > now)
            .sort((a, b) => a - b);
        return {
            status: known === false
                ? 'unknown'
                : (paidActive || trialActive ? 'entitled' : 'expired'),
            nextBoundaryMs: boundaries[0] || 0,
        };
    };

    const elementIsVisible = element => {
        if ( !element || element.hidden === true ) { return false; }
        try {
            const style = win.getComputedStyle?.(element);
            if ( style && (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                Number(style.opacity) === 0
            ) ) {
                return false;
            }
            const rects = element.getClientRects?.();
            if ( rects && rects.length === 0 ) { return false; }
        } catch {
        }
        return true;
    };

    const isAdShowing = () => {
        try {
            if ( doc.querySelector?.(AD_STATE_SELECTOR) ) { return true; }
            return Array.from(doc.querySelectorAll?.(AD_INDICATOR_SELECTOR) || [])
                .some(elementIsVisible);
        } catch {
        }
        return false;
    };

    const setExpiredFeedback = active => {
        try {
            return win.TalonYoutubeAdFeedbackController?.setActive?.(
                active,
                { mode: EXPIRED_MODE }
            ) === true;
        } catch {
        }
        return false;
    };

    const stopAcceleration = () => {
        try {
            win.TalonYoutubeAdSkipController?.stop?.();
        } catch {
        }
    };

    const tick = () => {
        if ( stopped || entitlementState !== 'expired' ) {
            setExpiredFeedback(false);
            return false;
        }
        const adShowing = isAdShowing();
        setExpiredFeedback(adShowing);
        return adShowing;
    };

    const clearDetectionTimer = () => {
        if ( intervalId === undefined ) { return; }
        try { win.clearInterval?.(intervalId); } catch {
        }
        intervalId = undefined;
    };

    const refreshDetectionTimer = () => {
        clearDetectionTimer();
        if ( stopped || entitlementState !== 'expired' ) { return; }
        const delay = doc.visibilityState === 'hidden'
            ? HIDDEN_CHECK_INTERVAL_MS
            : CHECK_INTERVAL_MS;
        intervalId = win.setInterval?.(tick, delay);
    };

    const clearBoundaryTimer = () => {
        if ( boundaryTimerId === undefined ) { return; }
        try { win.clearTimeout?.(boundaryTimerId); } catch {
        }
        boundaryTimerId = undefined;
    };

    const applyState = result => {
        const nextState = result?.status || 'unknown';
        const changed = nextState !== entitlementState;
        entitlementState = nextState;
        clearBoundaryTimer();
        const nextBoundaryMs = toNumber(result?.nextBoundaryMs);
        if ( nextBoundaryMs > Date.now() && typeof win.setTimeout === 'function' ) {
            const delay = Math.min(2147483647, Math.max(50, nextBoundaryMs - Date.now() + 25));
            boundaryTimerId = win.setTimeout(() => {
                boundaryTimerId = undefined;
                refresh();
            }, delay);
        }
        if ( nextState === 'expired' ) {
            stopAcceleration();
            if ( changed ) { refreshDetectionTimer(); }
            tick();
            return;
        }
        clearDetectionTimer();
        setExpiredFeedback(false);
    };

    const readStoredEntitlement = async () => {
        const storage = chromeApi?.storage?.local;
        if ( typeof storage?.get !== 'function' ) {
            return { status: 'unknown', nextBoundaryMs: 0 };
        }
        try {
            const bin = await storage.get(ENTITLEMENT_STORAGE_KEY);
            return computeState(bin?.[ENTITLEMENT_STORAGE_KEY], Date.now());
        } catch {
        }
        return { status: 'unknown', nextBoundaryMs: 0 };
    };

    const refresh = async () => {
        if ( stopped || isTopFrame() === false ) { return false; }
        const result = await readStoredEntitlement();
        if ( stopped ) { return false; }
        applyState(result);
        return entitlementState === 'expired';
    };

    const onStorageChanged = (changes, areaName) => {
        if ( areaName !== 'local' || !changes?.[ENTITLEMENT_STORAGE_KEY] ) { return; }
        const stored = changes[ENTITLEMENT_STORAGE_KEY].newValue;
        applyState(computeState(stored, Date.now()));
    };

    const onVisibilityChange = () => {
        refreshDetectionTimer();
        tick();
    };

    const stop = () => {
        stopped = true;
        clearDetectionTimer();
        clearBoundaryTimer();
        setExpiredFeedback(false);
        try {
            chromeApi?.storage?.onChanged?.removeListener?.(onStorageChanged);
            doc.removeEventListener?.('visibilitychange', onVisibilityChange);
        } catch {
        }
    };

    const init = () => {
        if ( isTopFrame() === false ) { return; }
        try {
            chromeApi?.storage?.onChanged?.addListener?.(onStorageChanged);
            doc.addEventListener?.('visibilitychange', onVisibilityChange);
            win.addEventListener?.('pagehide', stop, { once: true });
        } catch {
        }
        refresh();
    };

    return {
        computeState,
        getState: () => entitlementState,
        init,
        isAdShowing,
        refresh,
        stop,
        tick,
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
