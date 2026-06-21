/******************************************************************************/
// Important!
// Isolate from global scope
(function talonYoutubeAdSkip(global) {

if ( global.TalonYoutubeAdSkipController ) {
    global.TalonYoutubeAdSkipController.refresh?.();
    return;
}

const SUBSYSTEM_ID = 'youtubeAdSkip';
const FAST_PLAYBACK_RATE = 16;
const CHECK_INTERVAL_MS = 500;
const HIDDEN_CHECK_INTERVAL_MS = 1500;
const MUTATION_TICK_DELAY_MS = 750;
const NOTICE_CHECK_INTERVAL_MS = 1500;

const YOUTUBE_HOST_RE = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const INTERRUPTION_NOTICE_RE = /\bexperiencing\s+interruptions\b/i;

const AD_STATE_SELECTOR = [
    '.html5-video-player.ad-showing',
    '#movie_player.ad-showing',
].join(',');

const PLAYER_SELECTOR = '.html5-video-player,#movie_player';

const INTERRUPTION_NOTICE_SELECTOR = [
    'tp-yt-paper-toast',
    'yt-notification-action-renderer',
    'ytd-popup-container',
    '.ytp-popup',
    '.ytp-toast',
    '[role="alert"]',
    '[aria-live]',
].join(',');

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    const videoStates = new WeakMap();
    let playerObserver;
    let observedPlayer;
    let intervalId;
    let lastAdState = false;
    let tickScheduled = false;
    let lastNoticeCheckAt = 0;
    let noticeScanPending = false;

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

    const hideInterruptionNotice = element => {
        const text = String(element?.textContent || '');
        if ( INTERRUPTION_NOTICE_RE.test(text) === false ) { return false; }
        try {
            element.style?.setProperty?.('display', 'none', 'important');
            element.style?.setProperty?.('visibility', 'hidden', 'important');
            element.setAttribute?.('aria-hidden', 'true');
            element.hidden = true;
            return true;
        } catch {
        }
        return false;
    };

    const suppressInterruptionNotices = root => {
        let elements;
        if ( root?.nodeType === 1 || root?.nodeType === 11 ) {
            elements = [];
            try {
                if ( root.nodeType === 1 &&
                    root.matches?.(INTERRUPTION_NOTICE_SELECTOR) ) {
                    elements.push(root);
                }
                elements.push(...root.querySelectorAll?.(INTERRUPTION_NOTICE_SELECTOR) || []);
            } catch {
            }
        } else {
            elements = queryAll(INTERRUPTION_NOTICE_SELECTOR);
        }

        let suppressed = false;
        for ( const element of elements || [] ) {
            if ( hideInterruptionNotice(element) ) {
                suppressed = true;
            }
        }
        return suppressed;
    };

    const nodeMayContainInterruptionNotice = node => {
        if ( node?.nodeType === 3 ) {
            const text = String(node.textContent || '');
            if ( INTERRUPTION_NOTICE_RE.test(text) ) { return true; }
            node = node.parentElement;
        }
        if ( node?.nodeType !== 1 && node?.nodeType !== 11 ) { return false; }
        try {
            return (node.nodeType === 1 &&
                node.matches?.(INTERRUPTION_NOTICE_SELECTOR)) ||
                (typeof node.querySelector === 'function' &&
                    node.querySelector(INTERRUPTION_NOTICE_SELECTOR) !== null);
        } catch {
        }
        return false;
    };

    const suppressInterruptionNoticeNodes = records => {
        let suppressed = false;
        let noticeCandidate = false;
        for ( const record of records || [] ) {
            for ( let node of record.addedNodes || [] ) {
                if ( nodeMayContainInterruptionNotice(node) ) {
                    noticeCandidate = true;
                }
                if ( node?.nodeType === 3 ) {
                    node = node.parentElement;
                }
                if ( suppressInterruptionNotices(node) ) {
                    suppressed = true;
                }
            }
        }
        if ( suppressed ) {
            lastNoticeCheckAt = Date.now();
        }
        if ( noticeCandidate ) {
            noticeScanPending = true;
        }
        return suppressed;
    };

    const observePlayerState = () => {
        if ( typeof win.MutationObserver !== 'function' ) { return; }
        const player = queryOne(PLAYER_SELECTOR);
        if ( player === null || player === observedPlayer ) { return; }
        if ( playerObserver !== undefined ) {
            try {
                playerObserver.disconnect();
            } catch {
            }
            playerObserver = undefined;
        }
        observedPlayer = player;
        try {
            playerObserver = new win.MutationObserver(scheduleTick);
            playerObserver.observe(player, {
                attributes: true,
                attributeFilter: [ 'class' ],
            });
        } catch {
            playerObserver = undefined;
            observedPlayer = undefined;
        }
    };

    const saveVideoState = video => {
        if ( !video || videoStates.has(video) ) { return; }
        videoStates.set(video, {
            muted: video.muted === true,
            playbackRate: Number(video.playbackRate) || 1,
        });
    };

    const accelerateAdVideo = video => {
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
        observePlayerState();
        const now = Date.now();
        let suppressedNotice = false;
        if ( lastAdState || noticeScanPending ||
            now - lastNoticeCheckAt >= NOTICE_CHECK_INTERVAL_MS ) {
            lastNoticeCheckAt = now;
            noticeScanPending = false;
            suppressedNotice = suppressInterruptionNotices();
        }
        const adShowing = queryOne(AD_STATE_SELECTOR) !== null;
        if ( adShowing ) {
            for ( const video of videos() ) {
                accelerateAdVideo(video);
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

    const scheduleTick = () => {
        if ( tickScheduled ) { return; }
        tickScheduled = true;
        const run = () => {
            tickScheduled = false;
            tick();
        };
        try {
            if ( doc.visibilityState !== 'hidden' &&
                typeof win.requestAnimationFrame === 'function' ) {
                win.requestAnimationFrame(run);
                return;
            }
            if ( typeof win.setTimeout === 'function' ) {
                win.setTimeout(run, MUTATION_TICK_DELAY_MS);
                return;
            }
        } catch {
        }
        run();
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
        tick();
        if ( intervalId === undefined ) {
            refreshTimer();
        }
        return { started: true };
    };

    const stop = () => {
        if ( playerObserver !== undefined ) {
            try {
                playerObserver.disconnect();
            } catch {
            }
            playerObserver = undefined;
            observedPlayer = undefined;
        }
        if ( intervalId !== undefined ) {
            win.clearInterval(intervalId);
            intervalId = undefined;
        }
        restoreVideos();
        lastAdState = false;
    };

    const onVisibilityChange = () => refreshTimer();
    const onNavigateFinish = () => {
        noticeScanPending = true;
        scheduleTick();
    };

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
        init,
        refresh: start,
        restoreVideos,
        scheduleTick,
        start,
        stop,
        suppressInterruptionNoticeNodes,
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
