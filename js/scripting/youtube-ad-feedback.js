/******************************************************************************/
// Talon-owned YouTube feedback surface. This controller is
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
const LOGO_PATH = 'icons/icon128.png';
const PROTECTED_MODE = 'protected';
const EXPIRED_MODE = 'expired';
const PRICING_SOURCE = 'youtube_expired_overlay';
const SUPPORTED_SITE_LANGS = new Set([
    'en', 'de', 'fr', 'it', 'es', 'no', 'sv', 'da', 'fi', 'nl', 'ja', 'ko',
]);
const LANGUAGE_ALIASES = { nb: 'no', nn: 'no' };

const OVERLAY_CSS = `
#${OVERLAY_ID} {
    box-sizing: border-box;
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

#${OVERLAY_ID} .talon-youtube-ad-feedback-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 12px;
    padding: 9px 16px;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 999px;
    background: #45cfe0;
    box-shadow: 0 5px 14px rgba(0, 0, 0, 0.28);
    color: #071522;
    font-size: 15px;
    font-weight: 800;
    line-height: 1.2;
    text-decoration: none;
    pointer-events: auto;
    cursor: pointer;
}

#${OVERLAY_ID} .talon-youtube-ad-feedback-cta:hover,
#${OVERLAY_ID} .talon-youtube-ad-feedback-cta:focus-visible {
    background: #7be7f1;
    outline: 3px solid rgba(255, 255, 255, 0.82);
    outline-offset: 3px;
}

#${OVERLAY_ID}[data-mode="protected"] .talon-youtube-ad-feedback-cta {
    display: none;
}

#${OVERLAY_ID}[data-mode="expired"] {
    max-width: min(590px, calc(100% - 40px));
    border-color: rgba(250, 187, 76, 0.92);
    background: linear-gradient(135deg, rgba(8, 18, 35, 0.98), rgba(44, 31, 20, 0.97));
}

#${OVERLAY_ID}[data-mode="expired"] .talon-youtube-ad-feedback-detail {
    color: #ffe2aa;
}

@keyframes talon-youtube-ad-feedback-pulse {
    0% { opacity: 0.7; transform: scale(0.92); }
    70%, 100% { opacity: 0; transform: scale(1.16); }
}

#${OVERLAY_ID}:where([data-size="narrow"]) {
    max-width: calc(100% - 24px);
    min-height: 82px;
    padding: 12px 16px 12px 12px;
}

#${OVERLAY_ID}:where([data-size="narrow"]) .talon-youtube-ad-feedback-logo-wrap {
    width: 60px;
    height: 60px;
}

#${OVERLAY_ID}:where([data-size="narrow"]) .talon-youtube-ad-feedback-logo {
    width: 55px;
    height: 55px;
}

#${OVERLAY_ID}:where([data-size="narrow"]) .talon-youtube-ad-feedback-title {
    font-size: 18px;
}

#${OVERLAY_ID}:where([data-size="narrow"]) .talon-youtube-ad-feedback-detail {
    font-size: 14px;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) {
    gap: 12px;
    min-height: 0;
    padding: 12px;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) .talon-youtube-ad-feedback-logo-wrap {
    width: 40px;
    height: 40px;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) .talon-youtube-ad-feedback-logo {
    width: 36px;
    height: 36px;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) .talon-youtube-ad-feedback-title {
    font-size: 16px;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) .talon-youtube-ad-feedback-detail {
    display: none;
}

#${OVERLAY_ID}[data-mode="expired"]:where([data-size="narrow"]) .talon-youtube-ad-feedback-cta {
    margin-top: 8px;
    padding: 7px 12px;
    font-size: 14px;
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
    const messages = new Map();
    let active = false;
    let mode = PROTECTED_MODE;
    let overlayElement;
    let styleElement;
    let titleElement;
    let detailElement;
    let ctaElement;
    let listening = false;

    // Resolve packaged translations only when the overlay needs them. Keeping
    // this synchronous avoids delaying the ad feedback or fetching page data.
    const text = (key, fallback) => {
        if ( messages.has(key) ) { return messages.get(key); }
        let value = fallback;
        try {
            const i18n = env.chrome?.i18n || win.chrome?.i18n;
            const translated = i18n?.getMessage?.(key);
            if (
                typeof translated === 'string' &&
                translated.trim() !== '' &&
                translated !== key
            ) {
                value = translated;
            }
        } catch {
        }
        messages.set(key, value);
        return value;
    };

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

    const pricingUrl = () => {
        let baseUrl = 'https://talondefender.com';
        try {
            const getManifest = env.chrome?.runtime?.getManifest ||
                win.chrome?.runtime?.getManifest;
            const homepage = getManifest?.()?.homepage_url;
            if ( typeof homepage === 'string' && homepage.trim() !== '' ) {
                const parsed = new URL(homepage.trim());
                if ( parsed.protocol === 'https:' ) {
                    parsed.hash = '';
                    parsed.search = '';
                    baseUrl = parsed.toString().replace(/\/+$/, '');
                }
            }
        } catch {
        }
        let language = 'en';
        try {
            const i18n = env.chrome?.i18n || win.chrome?.i18n;
            const rawLanguage = String(i18n?.getUILanguage?.() || '').toLowerCase();
            const baseLanguage = rawLanguage.split(/[-_]/)[0];
            const resolved = LANGUAGE_ALIASES[baseLanguage] || baseLanguage;
            if ( SUPPORTED_SITE_LANGS.has(resolved) ) {
                language = resolved;
            }
        } catch {
        }
        const url = new URL(`${baseUrl}/${language}/pricing/`);
        url.searchParams.set('source', PRICING_SOURCE);
        return url.toString();
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
        const cta = doc.createElement?.('a');
        if ( !root || !logoWrap || !logo || !copy || !title || !detail || !cta ) {
            return null;
        }

        root.id = OVERLAY_ID;
        root.setAttribute?.('data-state', 'expanded');
        root.setAttribute?.('data-mode', mode);
        root.setAttribute?.('role', 'status');

        logoWrap.className = 'talon-youtube-ad-feedback-logo-wrap';
        logo.className = 'talon-youtube-ad-feedback-logo';
        logo.src = extensionUrl(LOGO_PATH);
        logo.alt = '';
        logo.setAttribute?.('aria-hidden', 'true');

        copy.className = 'talon-youtube-ad-feedback-copy';
        title.className = 'talon-youtube-ad-feedback-title';
        detail.className = 'talon-youtube-ad-feedback-detail';
        cta.className = 'talon-youtube-ad-feedback-cta';
        cta.href = pricingUrl();
        cta.target = '_blank';
        cta.rel = 'noopener noreferrer';
        cta.textContent = text('youtubeAdFeedbackRestoreButton', 'Restore Talon Defender');
        cta.setAttribute?.('aria-label', text(
            'youtubeAdFeedbackRestoreAria',
            'Restore Talon Defender on the pricing page'
        ));

        append(logoWrap, logo);
        append(copy, title);
        append(copy, detail);
        append(copy, cta);
        append(root, logoWrap);
        append(root, copy);
        titleElement = title;
        detailElement = detail;
        ctaElement = cta;
        return root;
    };

    const updateOverlayContent = () => {
        if ( !overlayElement ) { return; }
        overlayElement.setAttribute?.('data-mode', mode);
        if ( mode === EXPIRED_MODE ) {
            overlayElement.setAttribute?.('role', 'region');
            overlayElement.setAttribute?.(
                'aria-label',
                text('youtubeAdFeedbackExpiredAria',
                    'Talon Defender could skip ads like this. Your protection is paused. Reactivate to skip annoying YouTube ads.')
            );
            if ( titleElement ) {
                titleElement.textContent = text('youtubeAdFeedbackExpiredTitle',
                    'Talon Defender could skip ads like this');
            }
            if ( detailElement ) {
                detailElement.textContent = text('youtubeAdFeedbackExpiredDetail',
                    'Your protection is paused. Reactivate to skip annoying YouTube ads');
            }
            if ( ctaElement ) { ctaElement.href = pricingUrl(); }
            return;
        }
        overlayElement.setAttribute?.('role', 'status');
        overlayElement.setAttribute?.(
            'aria-label',
            text('youtubeAdFeedbackActiveAria',
                'Talon Defender is shortening this YouTube ad and getting you back to your video faster.')
        );
        if ( titleElement ) {
            titleElement.textContent = text('youtubeAdFeedbackActiveTitle',
                'Talon Defender is shortening this ad');
        }
        if ( detailElement ) {
            detailElement.textContent = text('youtubeAdFeedbackActiveDetail',
                'Getting you back to your video faster.');
        }
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
        // YouTube can use a small player inside a wide browser window. Size the
        // copy to that player during existing ad updates, without a new watcher.
        const playerWidth = Number(player.clientWidth) || 0;
        const size = playerWidth > 0 && playerWidth <= 520 ? 'narrow' : 'regular';
        if ( overlayElement?.getAttribute?.('data-size') !== size ) {
            overlayElement?.setAttribute?.('data-size', size);
        }
        overlayElement?.setAttribute?.(
            'data-state',
            'expanded'
        );
        updateOverlayContent();
        return { root: overlayElement, created };
    };

    const setActive = (value, options = {}) => {
        const requestedMode = options?.mode === EXPIRED_MODE
            ? EXPIRED_MODE
            : PROTECTED_MODE;
        const nextActive = value === true;
        if ( nextActive === false ) {
            if (
                options?.mode !== undefined &&
                active &&
                mode !== requestedMode
            ) {
                return false;
            }
            const changed = active || overlayElement !== undefined;
            active = false;
            removeElement(overlayElement);
            overlayElement = undefined;
            titleElement = undefined;
            detailElement = undefined;
            ctaElement = undefined;
            return changed;
        }

        if ( listening === false ) {
            win.addEventListener?.('pagehide', stop);
            listening = true;
        }
        active = true;
        mode = requestedMode;
        const { root } = ensureOverlay();
        if ( root === null ) { return false; }
        return true;
    };

    const refresh = () => {
        if ( active ) { setActive(true, { mode }); }
    };

    const stop = (options = {}) => {
        if ( options?.mode && active && mode !== options.mode ) { return; }
        setActive(false);
        removeElement(styleElement);
        styleElement = undefined;
        win.removeEventListener?.('pagehide', stop);
        listening = false;
    };

    return {
        revision: 4,
        isActive: () => active,
        getMode: () => mode,
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
