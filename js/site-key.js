import '../shared/public-suffix-data.js';
import '../shared/site-key-resolver.js';

const resolver = () => globalThis.TalonSiteKeyResolver;

const fallbackNormalizeHostname = value => {
    if ( typeof value !== 'string' ) { return ''; }
    return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
};

export const normalizeSiteKeyHostname = value => {
    const normalized = resolver()?.normalizeHostname?.(value);
    if ( typeof normalized === 'string' ) { return normalized; }
    return fallbackNormalizeHostname(value);
};

export const registrableDomain = hostname => {
    const normalized = normalizeSiteKeyHostname(hostname);
    if ( normalized === '' ) { return ''; }
    const resolved = resolver()?.getRegistrableDomain?.(normalized);
    if ( typeof resolved === 'string' && resolved !== '' ) { return resolved; }
    return normalized;
};

export const isKnownPublicSuffix = hostname =>
    resolver()?.isPublicSuffix?.(hostname) === true;

export const normalizeAutoPromotedHostname = hostname => {
    const normalized = normalizeSiteKeyHostname(hostname);
    if ( normalized === '' ) { return ''; }
    if ( isKnownPublicSuffix(normalized) ) { return ''; }
    return registrableDomain(normalized);
};
