/******************************************************************************/
// Experimental, Talon-owned YouTube feedback surface. This controller is
// presentation-only: youtube-ad-skip.js remains the sole owner of ad detection,
// skip activation, muting, and playback-rate restoration.
(function talonYoutubeAdFeedback(global) {

if ( global.TalonYoutubeAdFeedbackController ) {
    global.TalonYoutubeAdFeedbackController.refresh?.();
    return;
}

const OVERLAY_ID = 'talon-youtube-ad-feedback';
const STYLE_ID = 'talon-youtube-ad-feedback-style';
const PLAYER_SELECTOR = '.html5-video-player,#movie_player';
const COLLAPSE_DELAY_MS = 4000;
const LOGO_PATH = 'icons/icon128.png';

const OVERLAY_CSS = `
#${OVERLAY_ID} {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    gap: 18px;
    width: max-content;
    max-width: min(520px, calc(100% - 40px));
    min-height: 104px;
    padding: 16px 24px 16px 16px;
    border: 1px solid rgba(72, 210, 226, 0.8);
    border-radius: 22px;
    background: linear-gradient(135deg, rgba(8, 18, 35, 0.97), rgba(13, 35, 58, 0.95));
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
    color: #f8fafc;
    font-family: "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 18px;
    line-height: 1.35;
    text-align: left;
    pointer-events: none;
    user-select: none;
    direction: ltr;
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
    transition: padding 180ms ease, min-height 180ms ease, opacity 180ms ease, transform 180ms ease;
    contain: layout style paint;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-logo-wrap {
    position: relative;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 76px;
    height: 76px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 0 0 2px rgba(72, 210, 226, 0.45);
    transition: width 180ms ease, height 180ms ease;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-logo-wrap::after {
    content: "";
    position: absolute;
    inset: -5px;
    border: 2px solid rgba(72, 210, 226, 0.55);
    border-radius: inherit;
    animation: talon-youtube-ad-feedback-pulse 1.8s ease-out infinite;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-logo {
    display: block;
    width: 70px;
    height: 70px;
    border-radius: 50%;
    object-fit: contain;
    transition: width 180ms ease, height 180ms ease;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-copy {
    min-width: 0;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-title {
    color: #ffffff;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: normal;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-detail {
    margin-top: 4px;
    color: #c8f5fa;
    font-size: 16px;
    font-weight: 500;
    white-space: normal;
}

#${OVERLAY_ID}[data-state="compact"] {
    gap: 12px;
    min-height: 60px;
    padding: 8px 18px 8px 9px;
    border-radius: 999px;
}

#${OVERLAY_ID}[data-state="compact"] .talon-youtube-ad-feedback-logo-wrap {
    width: 46px;
    height: 46px;
}

#${OVERLAY_ID}[data-state="compact"] .talon-youtube-ad-feedback-logo {
    width: 42px;
    height: 42px;
}

#${OVERLAY_ID}[data-state="compact"] .talon-youtube-ad-feedback-title {
    font-size: 17px;
}

#${OVERLAY_ID}[data-state="compact"] .talon-youtube-ad-feedback-detail {
    display: none;
}

@keyframes talon-youtube-ad-feedback-pulse {
    0% { opacity: 0.7; transform: scale(0.92); }
    70%, 100% { opacity: 0; transform: scale(1.16); }
}

@media (max-width: 520px) {
    #${OVERLAY_ID} {
        max-width: calc(100% - 24px);
        min-height: 82px;
        padding: 12px 16px 12px 12px;
    }

    #${OVERLAY_ID} .talon-youtube-ad-feedback-logo-wrap {
        width: 60px;
        height: 60px;
    }

    #${OVERLAY_ID} .talon-youtube-ad-feedback-logo {
        width: 55px;
        height: 55px;
    }

    #${OVERLAY_ID} .talon-youtube-ad-feedback-title {
        font-size: 18px;
    }

    #${OVERLAY_ID} .talon-youtube-ad-feedback-detail {
        font-size: 14px;
    }
}

@media (prefers-reduced-motion: reduce) {
    #${OVERLAY_ID},
    #${OVERLAY_ID} * {
        animation: none !important;
        transition: none !important;
    }
}
`;

const createController = env => {
    const win = env.window || env;
    const doc = env.document;
    let active = false;
    let compact = false;
    let collapseTimer;
    let overlayElement;
    let styleElement;

    const removeElement = element => {
        if ( !element ) { return; }
        try {
            element.remove?.();
        } catch {
        }
    };

    const findPlayer = () => {
        try {
            return doc.querySelector?.(PLAYER_SELECTOR) || null;
        } catch {
        }
        return null;
    };

    const extensionUrl = path => {
        try {
            const getURL = env.chrome?.runtime?.getURL ||
                win.chrome?.runtime?.getURL;
            if ( typeof getURL === 'function' ) {
                return getURL(path);
            }
        } catch {
        }
        return path;
    };

    const ensureStyle = () => {
        try {
            const existing = doc.getElementById?.(STYLE_ID);
            if ( existing ) {
                styleElement = existing;
                return existing;
            }
            const style = doc.createElement?.('style');
            if ( !style ) { return null; }
            style.id = STYLE_ID;
            style.textContent = OVERLAY_CSS;
            const parent = doc.head || doc.documentElement;
            parent?.appendChild?.(style);
            styleElement = style;
            return style;
        } catch {
        }
        return null;
    };

    const append = (parent, child) => {
        if ( typeof parent?.appendChild === 'function' ) {
            parent.appendChild(child);
            return true;
        }
        if ( typeof parent?.append === 'function' ) {
            parent.append(child);
            return true;
        }
        return false;
    };

    const createOverlay = () => {
        const root = doc.createElement?.('div');
        const logoWrap = doc.createElement?.('div');
        const logo = doc.createElement?.('img');
        const copy = doc.createElement?.('div');
        const title = doc.createElement?.('div');
        const detail = doc.createElement?.('div');
        if ( !root || !logoWrap || !logo || !copy || !title || !detail ) {
            return null;
        }

        root.id = OVERLAY_ID;
        root.setAttribute?.('data-state', compact ? 'compact' : 'expanded');
        root.setAttribute?.(
            'aria-label',
            'Talon Defender is shortening this YouTube ad and getting you back to your video faster.'
        );
        root.setAttribute?.('role', 'status');

        logoWrap.className = 'talon-youtube-ad-feedback-logo-wrap';
        logo.className = 'talon-youtube-ad-feedback-logo';
        logo.src = extensionUrl(LOGO_PATH);
        logo.alt = '';
        logo.setAttribute?.('aria-hidden', 'true');

        copy.className = 'talon-youtube-ad-feedback-copy';
        title.className = 'talon-youtube-ad-feedback-title';
        title.textContent = 'Talon Defender is shortening this ad';
        detail.className = 'talon-youtube-ad-feedback-detail';
        detail.textContent = 'Getting you back to your video faster.';

        append(logoWrap, logo);
        append(copy, title);
        append(copy, detail);
        append(root, logoWrap);
        append(root, copy);
        return root;
    };

    const ensureOverlay = () => {
        const player = findPlayer();
        if ( player === null ) { return { root: null, created: false }; }
        ensureStyle();
        let created = false;
        if ( !overlayElement ) {
            try {
                overlayElement = doc.getElementById?.(OVERLAY_ID) || null;
            } catch {
                overlayElement = null;
            }
        }
        if ( !overlayElement ) {
            overlayElement = createOverlay();
            created = overlayElement !== null;
        }
        if ( overlayElement && overlayElement.parentElement !== player ) {
            append(player, overlayElement);
        }
        overlayElement?.setAttribute?.(
            'data-state',
            compact ? 'compact' : 'expanded'
        );
        return { root: overlayElement, created };
    };

    const clearCollapseTimer = () => {
        if ( collapseTimer === undefined ) { return; }
        try {
            win.clearTimeout?.(collapseTimer);
        } catch {
        }
        collapseTimer = undefined;
    };

    const scheduleCollapse = () => {
        clearCollapseTimer();
        if ( typeof win.setTimeout !== 'function' ) { return; }
        collapseTimer = win.setTimeout(() => {
            collapseTimer = undefined;
            if ( active === false ) { return; }
            compact = true;
            overlayElement?.setAttribute?.('data-state', 'compact');
        }, COLLAPSE_DELAY_MS);
    };

    const setActive = value => {
        const nextActive = value === true;
        if ( nextActive === false ) {
            const changed = active || overlayElement !== undefined;
            active = false;
            compact = false;
            clearCollapseTimer();
            removeElement(overlayElement);
            overlayElement = undefined;
            return changed;
        }

        const entering = active === false;
        active = true;
        if ( entering ) { compact = false; }
        const { root, created } = ensureOverlay();
        if ( root === null ) { return false; }
        if ( entering || (created && compact === false) ) {
            root.setAttribute?.('data-state', 'expanded');
            scheduleCollapse();
        }
        return true;
    };

    const refresh = () => {
        if ( active ) { setActive(true); }
    };

    const stop = () => {
        setActive(false);
        removeElement(styleElement);
        styleElement = undefined;
    };

    try {
        win.addEventListener?.('pagehide', stop, { once: true });
    } catch {
    }

    return {
        isActive: () => active,
        refresh,
        setActive,
        stop,
    };
};

if ( global.__talonYoutubeAdFeedbackTest === true ) {
    global.__talonYoutubeAdFeedbackCreateController = createController;
    return;
}

const controller = createController(global);
global.TalonYoutubeAdFeedbackController = controller;

})(globalThis);

void 0;
