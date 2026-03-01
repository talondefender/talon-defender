const FALLBACK_BASE_SITE_URL = 'https://talondefender.com';
const SUPPORTED_LANGS = new Set([ 'en', 'de', 'fr', 'it', 'es', 'no', 'sv', 'da', 'fi', 'nl', 'ja', 'ko' ]);
const LANGUAGE_ALIASES = { nb: 'no', nn: 'no' };

const normalizeBaseUrl = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const trimmed = value.trim();
    if ( trimmed === '' ) { return ''; }
    try {
        const url = new URL(trimmed);
        if ( url.protocol !== 'https:' ) { return ''; }
        url.hash = '';
        url.search = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
};

const normalizeLanguage = value => {
    if ( typeof value !== 'string' ) { return 'en'; }
    const trimmed = value.trim().toLowerCase();
    if ( trimmed === '' ) { return 'en'; }
    const base = trimmed.split(/[-_]/)[0];
    const resolved = LANGUAGE_ALIASES[base] || base;
    return SUPPORTED_LANGS.has(resolved) ? resolved : 'en';
};

const getUiLanguage = ( ) => {
    try {
        return chrome?.i18n?.getUILanguage?.();
    } catch {
    }
    return undefined;
};

const getSiteLanguage = ( ) => {
    const candidate = getUiLanguage() || ( typeof navigator !== 'undefined' ? navigator.language : '' );
    return normalizeLanguage(candidate);
};

const addLanguageToBaseUrl = ( baseUrl, language ) => {
    try {
        const url = new URL(baseUrl);
        const segments = url.pathname.split('/').filter(Boolean);
        if ( segments.length > 0 && SUPPORTED_LANGS.has(segments[0]) ) {
            segments[0] = language;
        } else {
            segments.unshift(language);
        }
        url.pathname = `/${segments.join('/')}`;
        return url.toString().replace(/\/+$/, '');
    } catch {
        return `${baseUrl}/${language}`;
    }
};

const getManifestHomepageUrl = ( ) => {
    try {
        return chrome?.runtime?.getManifest?.()?.homepage_url;
    } catch {
    }
    return undefined;
};

export const BASE_SITE_URL = normalizeBaseUrl(getManifestHomepageUrl()) || FALLBACK_BASE_SITE_URL;
export const SITE_LANGUAGE = getSiteLanguage();
export const LOCALIZED_BASE_URL = addLanguageToBaseUrl(BASE_SITE_URL, SITE_LANGUAGE);

export const SUBSCRIBE_URL = `${LOCALIZED_BASE_URL}/pricing/`;
export const TRIAL_EXPIRED_URL = `${BASE_SITE_URL}/en/trial-expired/`;
export const SUPPORT_URL = `${LOCALIZED_BASE_URL}/support`;
export const RECOVER_LICENSE_URL = `${LOCALIZED_BASE_URL}/license-recovery`;
export const PRIVACY_URL = `${LOCALIZED_BASE_URL}/privacy`;
export const MANAGE_SUBSCRIPTION_URL = `${LOCALIZED_BASE_URL}/account`;
export const WHATS_NEW_URL = `${LOCALIZED_BASE_URL}/whats-new`;
export const TERMS_URL = `${LOCALIZED_BASE_URL}/terms`;
