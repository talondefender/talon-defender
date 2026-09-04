/******************************************************************************/
// Important!
// Isolate from global scope
(function talonYoutubeAdSkip(global) {

if ( global.TalonYoutubeAdSkipController ) {
    if ( global.TalonYoutubeAdSkipController.revision === 2 ) {
        global.TalonYoutubeAdSkipController.refresh?.();
    }
    return;
}

const SUBSYSTEM_ID = 'youtubeAdSkip';
const AD_PLAYBACK_RATE = 16;
const CHECK_INTERVAL_MS = 500;
const HIDDEN_CHECK_INTERVAL_MS = 1500;
const MUTATION_TICK_DELAY_MS = 750;
const NOTICE_CHECK_INTERVAL_MS = 1500;
const SKIP_CLICK_COOLDOWN_MS = 1000;
const GUARD_READY_TIMEOUT_MS = 250;
const AD_SURFACE_STYLE_ID = 'talon-youtube-ad-skip-style';

const YOUTUBE_HOST_RE = /(^|\.)youtube(?:-nocookie)?\.com$/i;
const INTERRUPTION_NOTICE_RE = /\bexperiencing\s+interruptions\b/i;

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

const PLAYER_SELECTOR = '.html5-video-player,#movie_player';

const SKIP_BUTTON_SELECTOR = [
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button',
    '.ytp-skip-ad-button',
    '[class*="ytp-ad-skip"]',
    '[class*="ytp-skip-ad"]',
    '[class*="skip-ad"]',
    'button.ytp-ad-skip-button',
    'button.ytp-skip-ad-button',
    'button[class*="ytp-ad-skip"]',
    'button[class*="ytp-skip-ad"]',
    'button[class*="skip-ad"]',
    '[id^="skip-button"]',
    '[id*="skip-button"] button',
    'button[aria-label*="Skip ad"]',
    'button[aria-label*="Skip Ad"]',
    'button[aria-label*="Skip ads"]',
    'button[aria-label*="Skip Ads"]',
    'button[aria-label*="skip ad"]',
    'button[aria-label*="skip ads"]',
    'button[title*="Skip ad"]',
    'button[title*="Skip Ad"]',
    'button[title*="Skip ads"]',
    'button[title*="Skip Ads"]',
    'button[title*="skip ad"]',
    'button[title*="skip ads"]',
].join(',');

const SKIP_BUTTON_FALLBACK_SELECTOR = 'button,[role="button"]';
const SKIP_BUTTON_FALLBACK_TEXT_RE =
    /\bskip\s+(?:ad|ads)\b|\bskip\b.{0,24}\b(?:ad|ads)\b|\b(?:ad|ads)\b.{0,24}\bskip\b/i;

const AD_SURFACE_CSS = [
    '.ytp-ad-overlay-container,',
    '.ytp-ad-image-overlay,',
    '.ytp-ad-text-overlay,',
    '.ytp-ad-survey,',
    '.ytp-ad-companion-slot,',
    'ytd-ad-slot-renderer {',
    '  display: none !important;',
    '  visibility: hidden !important;',
    '}',
].join('\n');

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
    const videoStates = new Map();
    const hiddenNotices = new Map();
    let active = true;
    let generation = 0;
    let queuedFrame;
    let queuedTimer;
    let ownedStyle;
    const ownedListeners = [];
    const listen = (target, type, handler) => {
        target?.addEventListener?.(type, handler);
        ownedListeners.push({ target, type, handler });
    };
    let playerObserver;
    let observedPlayer;
    let intervalId;
    let lastAdState = false;
    let tickScheduled = false;
    let lastNoticeCheckAt = 0;
    let noticeScanPending = false;
    let lastSkipClickAt = 0;
    let skipActivationCount = 0;

    const markState = value => {
        try {
            doc.documentElement?.setAttribute('data-talon-youtube-ad-skip', value);
        } catch {
        }
    };

    const markSkipActivation = element => {
        skipActivationCount += 1;
        try {
            doc.documentElement?.setAttribute(
                'data-talon-youtube-skip-activations',
                String(skipActivationCount)
            );
            const label = [
                element?.getAttribute?.('aria-label'),
                element?.getAttribute?.('title'),
                element?.textContent,
            ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
            if ( label ) {
                doc.documentElement?.setAttribute('data-talon-youtube-last-skip-label', label);
            }
        } catch {
        }
    };

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

    const installAdSurfaceStyle = () => {
        try {
            if ( doc.getElementById?.(AD_SURFACE_STYLE_ID) !== null ) { return true; }
            const style = doc.createElement?.('style');
            if ( !style ) { return false; }
            ownedStyle = style;
            style.id = AD_SURFACE_STYLE_ID;
            style.textContent = AD_SURFACE_CSS;
            const parent = doc.head || doc.documentElement;
            if ( typeof parent?.appendChild === 'function' ) {
                parent.appendChild(style);
                return true;
            }
            if ( typeof parent?.append === 'function' ) {
                parent.append(style);
                return true;
            }
        } catch {
        }
        return false;
    };

    const elementIsActionable = element => {
        if ( !element ) { return false; }
        try {
            if ( element.disabled === true || element.hidden === true ) { return false; }
            if ( element.getAttribute?.('aria-disabled') === 'true' ) { return false; }
            const style = win.getComputedStyle?.(element);
            if ( style && (style.display === 'none' ||
                style.visibility === 'hidden' ||
                Number(style.opacity) === 0) ) {
                return false;
            }
            const rects = element.getClientRects?.();
            if ( rects && rects.length === 0 ) { return false; }
        } catch {
        }
        return true;
    };

    const skipControlLooksLikeAdSkip = element => {
        try {
            if ( element.matches?.(SKIP_BUTTON_SELECTOR) ) { return true; }
        } catch {
        }
        const text = [
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('title'),
            element.textContent,
        ].filter(Boolean).join(' ');
        return SKIP_BUTTON_FALLBACK_TEXT_RE.test(text);
    };

    const skipButtonCandidates = () => {
        const candidates = [];
        const seen = new Set();
        const addCandidate = element => {
            if ( !element || seen.has(element) ) { return; }
            seen.add(element);
            candidates.push(element);
        };
        for ( const button of queryAll(SKIP_BUTTON_SELECTOR) ) {
            addCandidate(button);
        }
        for ( const button of queryAll(SKIP_BUTTON_FALLBACK_SELECTOR) ) {
            if ( skipControlLooksLikeAdSkip(button) ) {
                addCandidate(button);
            }
        }
        return candidates;
    };

    const activationTargetsFor = element => {
        const targets = [];
        const seen = new Set();
        const addTarget = target => {
            if ( !target || seen.has(target) ) { return; }
            seen.add(target);
            targets.push(target);
        };
        addTarget(element);
        try {
            addTarget(element.closest?.('button,[role="button"],a'));
        } catch {
        }
        try {
            addTarget(element.querySelector?.('button,[role="button"],a'));
        } catch {
        }
        return targets;
    };

    const dispatchSkipActivationEvents = button => {
        let dispatched = false;
        const targets = activationTargetsFor(button);
        const eventTypes = [
            'pointerover',
            'mouseover',
            'pointerdown',
            'mousedown',
            'pointerup',
            'mouseup',
            'click',
        ];
        for ( const target of targets ) {
            try {
                target.focus?.({ preventScroll: true });
            } catch {
            }
            for ( const type of eventTypes ) {
                try {
                    const Ctor = type.startsWith('pointer') && typeof win.PointerEvent === 'function'
                        ? win.PointerEvent
                        : win.MouseEvent;
                    if ( typeof Ctor !== 'function' ) { continue; }
                    const buttons = type.endsWith('down') ? 1 : 0;
                    const event = new Ctor(type, {
                        bubbles: true,
                        button: 0,
                        buttons,
                        cancelable: true,
                        composed: true,
                        view: win,
                    });
                    dispatched = target.dispatchEvent?.(event) !== false || dispatched;
                } catch {
                }
            }
            try {
                target.click();
                dispatched = true;
            } catch {
            }
        }
        if ( dispatched ) { markSkipActivation(button); }
        return dispatched;
    };

    const clickSkipButtons = () => {
        const now = Date.now();
        if ( now - lastSkipClickAt < SKIP_CLICK_COOLDOWN_MS ) { return false; }
        for ( const button of skipButtonCandidates() ) {
            if ( elementIsActionable(button) === false ) { continue; }
            if ( dispatchSkipActivationEvents(button) ) {
                lastSkipClickAt = now;
                return true;
            }
        }
        return false;
    };

    const isAdShowing = () => {
        if ( queryOne(AD_STATE_SELECTOR) !== null ) { return true; }
        if ( queryAll(AD_INDICATOR_SELECTOR).some(elementIsActionable) ) { return true; }
        return skipButtonCandidates().some(elementIsActionable);
    };

    const restoreNotice = (element, saved) => {
            for ( const [property, owned] of [ ['display', 'none'], ['visibility', 'hidden'] ] ) {
                if ( element.style?.getPropertyValue?.(property) !== owned || element.style?.getPropertyPriority?.(property) !== 'important' ) { continue; }
                element.style.setProperty(property, saved[property], saved[`${property}Priority`]);
            }
            if ( element.hidden === true ) { element.hidden = saved.hidden; }
            if ( element.getAttribute?.('aria-hidden') === 'true' ) {
                if ( saved.aria === null || saved.aria === undefined ) { element.removeAttribute?.('aria-hidden'); }
                else { element.setAttribute?.('aria-hidden', saved.aria); }
            }
    };

    const hideInterruptionNotice = element => {
        const text = String(element?.textContent || '');
        if ( INTERRUPTION_NOTICE_RE.test(text) === false ) { return false; }
        if ( hiddenNotices.has(element) === false ) {
            if ( hiddenNotices.size >= 256 ) { return false; }
            hiddenNotices.set(element, {
                hidden: element.hidden,
                aria: element.getAttribute?.('aria-hidden'),
                display: element.style?.getPropertyValue?.('display') || '',
                displayPriority: element.style?.getPropertyPriority?.('display') || '',
                visibility: element.style?.getPropertyValue?.('visibility') || '',
                visibilityPriority: element.style?.getPropertyPriority?.('visibility') || '',
            });
        }
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
        if ( !video ) { return; }
        const saved = videoStates.get(video);
        if ( saved ) {
            if ( video.muted !== true ) { saved.muted = video.muted === true; }
            if ( video.playbackRate !== AD_PLAYBACK_RATE ) {
                saved.playbackRate = Number(video.playbackRate) || 1;
            }
            return;
        }
        videoStates.set(video, {
            muted: video.muted === true,
            playbackRate: Number(video.playbackRate) || 1,
        });
    };

    const handleAdVideo = video => {
        if ( !video ) { return; }
        saveVideoState(video);
        try {
            video.muted = true;
        } catch {
        }
        try {
            if ( Number(video.playbackRate) < AD_PLAYBACK_RATE ) {
                video.playbackRate = AD_PLAYBACK_RATE;
            }
        } catch {
        }
        try {
            if ( video.paused === true && typeof video.play === 'function' ) {
                video.play().catch?.(() => {});
            }
        } catch {
        }
    };

    const restoreVideo = video => {
        const saved = videoStates.get(video);
        if ( !saved ) { return; }
        try {
            if ( video.muted === true ) { video.muted = saved.muted; }
        } catch {
        }
        try {
            if ( video.playbackRate === AD_PLAYBACK_RATE ) { video.playbackRate = saved.playbackRate; }
        } catch {
        }
        videoStates.delete(video);
    };

    const videos = () => queryAll('video');

    const restoreVideos = () => {
        for ( const video of videoStates.keys() ) {
            restoreVideo(video);
        }
    };

    const tick = () => {
        if ( active === false ) { return false; }
        for ( const element of hiddenNotices.keys() ) {
            if ( element.isConnected === false ) {
                restoreNotice(element, hiddenNotices.get(element));
                hiddenNotices.delete(element);
            }
        }
        if ( isYouTubeHost() === false ) { return false; }
        installAdSurfaceStyle();
        observePlayerState();
        const now = Date.now();
        let suppressedNotice = false;
        if ( lastAdState || noticeScanPending ||
            now - lastNoticeCheckAt >= NOTICE_CHECK_INTERVAL_MS ) {
            lastNoticeCheckAt = now;
            noticeScanPending = false;
            suppressedNotice = suppressInterruptionNotices();
        }
        const adShowing = isAdShowing();
        const skipClicked = adShowing ? clickSkipButtons() : false;
        if ( adShowing ) {
            for ( const video of videos() ) {
                handleAdVideo(video);
            }
            lastAdState = true;
            return true;
        }
        if ( lastAdState ) {
            restoreVideos();
            lastAdState = false;
        }
        return suppressedNotice || skipClicked;
    };

    const scheduleTick = () => {
        if ( active === false || tickScheduled ) { return; }
        tickScheduled = true;
        const epoch = generation;
        const run = () => {
            if ( active === false || epoch !== generation ) { return; }
            tickScheduled = false;
            queuedFrame = queuedTimer = undefined;
            tick();
        };
        try {
            if ( doc.visibilityState !== 'hidden' &&
                typeof win.requestAnimationFrame === 'function' ) {
                queuedFrame = win.requestAnimationFrame(run);
                return;
            }
            if ( typeof win.setTimeout === 'function' ) {
                queuedTimer = win.setTimeout(run, MUTATION_TICK_DELAY_MS);
                return;
            }
        } catch {
        }
        run();
    };

    const shouldRun = async () => {
        const guard = win.TalonBreakageGuard;
        try {
            const ready = guard?.whenReady?.();
            if ( ready?.then ) {
                await Promise.race([
                    ready,
                    new Promise(resolve => win.setTimeout?.(resolve, GUARD_READY_TIMEOUT_MS)),
                ]);
            }
            return guard?.shouldRunSubsystem?.(SUBSYSTEM_ID) !== false;
        } catch {
        }
        return true;
    };

    const refreshTimer = () => {
        if ( active === false ) { return; }
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
        if ( queuedFrame !== undefined ) { win.cancelAnimationFrame?.(queuedFrame); }
        if ( queuedTimer !== undefined ) { win.clearTimeout?.(queuedTimer); }
        queuedFrame = queuedTimer = undefined;
        tickScheduled = false;
        const epoch = ++generation;
        markState('entered');
        const allowed = await shouldRun();
        if ( epoch !== generation ) { return { started: false }; }
        if ( allowed === false ) {
            stop();
            markState('suppressed');
            return { started: false };
        }
        active = true;
        if ( ownedListeners.length === 0 ) {
            listen(doc, 'visibilitychange', onVisibilityChange);
            listen(doc, 'yt-navigate-finish', onNavigateFinish);
            listen(win, 'pagehide', stop);
        }
        markState('running');
        tick();
        if ( intervalId === undefined ) {
            refreshTimer();
        }
        return { started: true };
    };

    const stop = () => {
        active = false;
        generation += 1;
        if ( queuedFrame !== undefined ) { win.cancelAnimationFrame?.(queuedFrame); }
        if ( queuedTimer !== undefined ) { win.clearTimeout?.(queuedTimer); }
        queuedFrame = queuedTimer = undefined;
        tickScheduled = false;
        for ( const { target, type, handler } of ownedListeners.splice(0) ) {
            target?.removeEventListener?.(type, handler);
        }
        ownedStyle?.remove?.();
        ownedStyle = undefined;
        for ( const [element, saved] of hiddenNotices ) { restoreNotice(element, saved); }
        hiddenNotices.clear();
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
        markState('stopped');
    };

    const onVisibilityChange = () => refreshTimer();
    const onNavigateFinish = () => {
        noticeScanPending = true;
        scheduleTick();
    };

    const init = () => { start().catch(() => {}); };

    return {
        revision: 2,
        isActive: () => active,
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
