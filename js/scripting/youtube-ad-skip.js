/******************************************************************************/
// Important!
// Isolate from global scope
(function talonYoutubeAdSkip(global) {

if ( global.TalonYoutubeAdSkipController ) {
    global.TalonYoutubeAdSkipController.refresh?.();
    return;
}

const SUBSYSTEM_ID = 'youtubeAdSkip';
const STYLE_ID = 'talon-youtube-ad-skip-style';
const FAST_PLAYBACK_RATE = 16;
const CHECK_INTERVAL_MS = 250;
const HIDDEN_CHECK_INTERVAL_MS = 1500;

const YOUTUBE_HOST_RE = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const INTERRUPTION_NOTICE_RE = /\bexperiencing\s+interruptions\b/i;

const AD_STATE_SELECTOR = [
    '.html5-video-player.ad-showing',
    '#movie_player.ad-showing',
].join(',');

const SKIP_BUTTON_SELECTOR = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button',
    '.ytp-ad-overlay-close-button',
    'button[class*="ytp-ad-skip" i]',
    'button[class*="skip-ad" i]',
].join(',');

const AD_SURFACE_SELECTOR = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-preview-container',
    '.ytp-ad-module',
    '.ytp-ad-text',
    '.ytp-ad-badge',
    '.ytp-ad-badge--clean-player',
    'ytd-ad-slot-renderer',
    'ytd-companion-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    '#player-ads',
    '#masthead-ad',
].join(',');

const INTERRUPTION_NOTICE_SELECTOR = [
    'tp-yt-paper-toast',
    'yt-notification-action-renderer',
    'ytd-popup-container',
    '.ytp-popup',
    '.ytp-toast',
    '[role="alert"]',
    '[aria-live]',
].join(',');

const STYLE_TEXT = [
    'ytd-ad-slot-renderer',
    'ytd-companion-slot-renderer',
    'ytd-display-ad-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    '#player-ads',
    '#masthead-ad',
    '.html5-video-player.ad-showing .ytp-ad-image-overlay',
    '.html5-video-player.ad-showing .ytp-ad-player-overlay',
].join(',') +
    '{display:none!important;visibility:hidden!important;}' +
    '.html5-video-player.ad-showing video{visibility:hidden!important;}' +
    '.html5-video-player.ad-showing{background:#000!important;}';

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const videoStates = new WeakMap();
    let observer;
    let intervalId;
    let lastAdState = false;

    const isYouTubeHost = () =>
        YOUTUBE_HOST_RE.test(String(win.location?.hostname || ''));

    const queryAll = selector => {
        try {
            return Array.from(doc.querySelectorAll(selector));
        } catch {
        }
        return [];
    };

    const queryOne = selector => {
        try {
            return doc.querySelector(selector);
        } catch {
        }
        return null;
    };

    const injectStyle = () => {
        if ( doc.getElementById?.(STYLE_ID) ) { return; }
        try {
            const style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = STYLE_TEXT;
            const parent = doc.head || doc.documentElement || doc;
            if ( typeof parent.append === 'function' ) {
                parent.append(style);
            } else if ( typeof parent.appendChild === 'function' ) {
                parent.appendChild(style);
            }
        } catch {
        }
    };

    const removeStyle = () => {
        try {
            doc.getElementById?.(STYLE_ID)?.remove?.();
        } catch {
        }
    };

    const isElementActionable = element => {
        if ( !element || element.disabled === true ) { return false; }
        try {
            if ( element.getAttribute?.('aria-disabled') === 'true' ) {
                return false;
            }
            if ( element.hidden === true ) { return false; }
            const rects = element.getClientRects?.();
            if ( rects && rects.length === 0 ) { return false; }
        } catch {
        }
        return true;
    };

    const findSkipButton = () =>
        queryAll(SKIP_BUTTON_SELECTOR).find(isElementActionable) || null;

    const clickSkipButton = () => {
        const button = findSkipButton();
        if ( button === null ) { return false; }
        try {
            button.click();
            return true;
        } catch {
        }
        return false;
    };

    const hasAdSurface = () =>
        queryOne(AD_STATE_SELECTOR) !== null ||
        (findSkipButton() !== null && queryOne(AD_SURFACE_SELECTOR) !== null);

    const suppressInterruptionNotices = () => {
        let suppressed = false;
        for ( const element of queryAll(INTERRUPTION_NOTICE_SELECTOR) ) {
            const text = String(element?.textContent || '');
            if ( INTERRUPTION_NOTICE_RE.test(text) === false ) { continue; }
            try {
                element.style?.setProperty?.('display', 'none', 'important');
                element.style?.setProperty?.('visibility', 'hidden', 'important');
                element.setAttribute?.('aria-hidden', 'true');
                element.hidden = true;
                suppressed = true;
            } catch {
            }
        }
        return suppressed;
    };

    const saveVideoState = video => {
        if ( !video || videoStates.has(video) ) { return; }
        videoStates.set(video, {
            muted: video.muted === true,
            playbackRate: Number(video.playbackRate) || 1,
        });
    };

    const accelerateVideo = video => {
        if ( !video ) { return; }
        saveVideoState(video);
        try {
            video.muted = true;
        } catch {
        }
        try {
            if ( Number(video.playbackRate) < FAST_PLAYBACK_RATE ) {
                video.playbackRate = FAST_PLAYBACK_RATE;
            }
        } catch {
        }
    };

    const restoreVideo = video => {
        const saved = videoStates.get(video);
        if ( !saved ) { return; }
        try {
            video.muted = saved.muted;
        } catch {
        }
        try {
            video.playbackRate = saved.playbackRate;
        } catch {
        }
        videoStates.delete(video);
    };

    const videos = () => queryAll('video');

    const restoreVideos = () => {
        for ( const video of videos() ) {
            restoreVideo(video);
        }
    };

    const tick = () => {
        if ( isYouTubeHost() === false ) { return false; }
        injectStyle();
        const suppressedNotice = suppressInterruptionNotices();
        const adShowing = hasAdSurface();
        if ( adShowing ) {
            clickSkipButton();
            for ( const video of videos() ) {
                accelerateVideo(video);
            }
            lastAdState = true;
            return true;
        }
        if ( lastAdState ) {
            restoreVideos();
            lastAdState = false;
        }
        return suppressedNotice;
    };

    const shouldRun = async () => {
        const guard = win.TalonBreakageGuard;
        try {
            await guard?.whenReady?.();
            return guard?.shouldRunSubsystem?.(SUBSYSTEM_ID) !== false;
        } catch {
        }
        return true;
    };

    const refreshTimer = () => {
        if ( intervalId !== undefined ) {
            win.clearInterval(intervalId);
        }
        const delay = doc.visibilityState === 'hidden'
            ? HIDDEN_CHECK_INTERVAL_MS
            : CHECK_INTERVAL_MS;
        intervalId = win.setInterval(tick, delay);
    };

    const start = async () => {
        if ( isYouTubeHost() === false ) { return { started: false }; }
        if ( await shouldRun() === false ) {
            stop();
            return { started: false };
        }
        injectStyle();
        tick();
        if ( observer === undefined && typeof win.MutationObserver === 'function' ) {
            observer = new win.MutationObserver(() => tick());
            try {
                observer.observe(doc.documentElement || doc, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: [ 'class', 'hidden', 'aria-hidden' ],
                });
            } catch {
            }
        }
        if ( intervalId === undefined ) {
            refreshTimer();
        }
        return { started: true };
    };

    const stop = () => {
        if ( observer !== undefined ) {
            try {
                observer.disconnect();
            } catch {
            }
            observer = undefined;
        }
        if ( intervalId !== undefined ) {
            win.clearInterval(intervalId);
            intervalId = undefined;
        }
        restoreVideos();
        removeStyle();
        lastAdState = false;
    };

    const onVisibilityChange = () => refreshTimer();
    const onNavigateFinish = () => tick();

    const init = () => {
        start().catch(() => {});
        try {
            doc.addEventListener('visibilitychange', onVisibilityChange);
            doc.addEventListener('yt-navigate-finish', onNavigateFinish);
            win.addEventListener?.('pagehide', stop, { once: true });
        } catch {
        }
    };

    return {
        clickSkipButton,
        findSkipButton,
        hasAdSurface,
        init,
        injectStyle,
        refresh: start,
        restoreVideos,
        start,
        stop,
        suppressInterruptionNotices,
        tick,
    };
};

if ( global.__talonYoutubeAdSkipTest === true ) {
    global.__talonYoutubeAdSkipCreateController = createController;
    return;
}

const controller = createController(global);
global.TalonYoutubeAdSkipController = controller;
controller.init();

})(globalThis);

void 0;
