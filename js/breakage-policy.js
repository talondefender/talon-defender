export const RISK_TIERS = Object.freeze({
    low: 1,
    medium: 2,
    high: 3,
});

export const BREAKAGE_AUDIT_OVERRIDES_KEY = 'breakageAuditOverridesV1';

export const AUDITABLE_SUBSYSTEMS = Object.freeze([
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'postHideCleanup',
]);

// Keep explicit protected-host rules aligned with automation/protected-domains.json.
export const PROTECTED_DOMAIN_RULES = Object.freeze([
    { pattern: 'accounts.google.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'myaccount.google.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'account.microsoft.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'login.microsoftonline.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'appleid.apple.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'signin.ebay.com', category: 'auth/account', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'checkout.shopify.com', category: 'checkout/payment', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.stripe.com', category: 'checkout/payment', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.paypal.com', category: 'checkout/payment', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'docs.google.com', category: 'docs/productivity', allowedRiskTier: RISK_TIERS.low },
    { pattern: 'drive.google.com', category: 'docs/productivity', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.office.com', category: 'docs/productivity', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.notion.so', category: 'docs/productivity', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.gov', category: 'government/education/health', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.edu', category: 'government/education/health', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.ac.uk', category: 'government/education/health', allowedRiskTier: RISK_TIERS.low },
    { pattern: '*.nhs.uk', category: 'government/education/health', allowedRiskTier: RISK_TIERS.low },
]);

export const RISK_MANIFEST = Object.freeze([
    {
        id: 'dnr-annoyances-static',
        tier: RISK_TIERS.low,
        hostScope: 'ruleset host scoping',
        runTiming: 'network',
        frameScope: 'all frames',
        mutationType: 'block or hide known nuisance resources',
        protectedExposure: 'low',
    },
    {
        id: 'css-specific-procedural',
        tier: RISK_TIERS.medium,
        hostScope: 'enabled rulesets',
        runTiming: 'document_start',
        frameScope: 'all frames',
        mutationType: 'hide DOM nodes via packaged selectors',
        protectedExposure: 'medium',
    },
    {
        id: 'post-hide-cleanup',
        tier: RISK_TIERS.medium,
        hostScope: 'optimal and complete modes',
        runTiming: 'document_idle',
        frameScope: 'all frames',
        mutationType: 'collapse containers after hides',
        protectedExposure: 'medium-high',
    },
    {
        id: 'native-heuristics',
        tier: RISK_TIERS.high,
        hostScope: 'optimal and complete modes',
        runTiming: 'document_idle',
        frameScope: 'all frames',
        mutationType: 'infer, hide, and collapse containers from page signals',
        protectedExposure: 'high',
    },
    {
        id: 'automation',
        tier: RISK_TIERS.high,
        hostScope: 'optimal and complete modes plus remote directives',
        runTiming: 'document_idle',
        frameScope: 'all frames',
        mutationType: 'click, hide, or remove matched DOM nodes',
        protectedExposure: 'high',
    },
    {
        id: 'remote-cosmetics',
        tier: RISK_TIERS.high,
        hostScope: 'community bundle host patterns',
        runTiming: 'document_start',
        frameScope: 'all frames',
        mutationType: 'inject remote hide selectors',
        protectedExposure: 'high',
    },
    {
        id: 'remote-scriptlets',
        tier: RISK_TIERS.high,
        hostScope: 'community bundle host patterns',
        runTiming: 'document_start',
        frameScope: 'frame-dependent',
        mutationType: 'execute bundled scriptlets on remote instructions',
        protectedExposure: 'high',
    },
    {
        id: 'community-dnr',
        tier: RISK_TIERS.medium,
        hostScope: 'community bundle DNR hosts',
        runTiming: 'network',
        frameScope: 'all frames',
        mutationType: 'block or redirect remote rules',
        protectedExposure: 'medium',
    },
]);

const CONSENT_SELECTOR_RE = /\b(cookie|consent|gdpr|cmp|onetrust|didomi|quantcast|trustarc|truste|sourcepoint|cookiebot|iubenda|sp_message|cky)\b/i;
const NUISANCE_SELECTOR_RE = /\b(ad|ads|advert|sponsor|promo|overlay|popup|modal|interstitial|banner|newsletter|subscribe|teaser|cookie|consent|gdpr|cmp|paywall)\b/i;
const DANGEROUS_SELECTOR_RE = /\b(html|body|main|article|form)\b|#(?:root|app|__next|__nuxt)\b|\[role\s*=\s*["']?main["']?\]/i;
const GENERIC_CONTAINER_RE = /\b(container|content|wrapper|layout|page|shell|grid|column|col-|main|article|story|post)\b/i;
const GENERIC_TAG_ONLY_RE = /^\s*(?:div|section|aside|main|article|form|span|p|ul|ol|li)(?:\s*[>+~:]|\s*$)/i;
const CHECKOUT_HINT_SELECTOR = [
    'form[action*="checkout" i]',
    'input[autocomplete="cc-number"]',
    'input[name*="cardnumber" i]',
    'input[name*="card-number" i]',
    'input[name*="cc-number" i]',
    'input[name*="cvc" i]',
    'input[name*="cvv" i]',
    'input[name*="expiry" i]',
    'input[name*="exp-month" i]',
    'input[name*="exp-year" i]',
    '[data-stripe]',
    '[data-braintree]',
    '[data-paypal-checkout]',
].join(',');
const REMOTE_SCRIPTLET_DENY_RE = /(?:trusted-click-element|trusted-set-constant|trusted-replace-|trusted-prevent-dom-bypass|abort-current-inline-script|set-attr|remove-class|remove-node-text|remove-node|trusted-dispatch-event)/i;

export const REMOTE_SCRIPTLET_DENYLIST_RE = REMOTE_SCRIPTLET_DENY_RE;

export function patternMatchesHostname(pattern, hostname) {
    if ( typeof pattern !== 'string' || typeof hostname !== 'string' ) { return false; }
    const p = pattern.trim().toLowerCase();
    const hn = hostname.trim().toLowerCase();
    if ( p === '' || hn === '' ) { return false; }
    if ( p === '*' || p === 'all-urls' ) { return true; }
    if ( p.startsWith('*.') ) {
        const bare = p.slice(2);
        return hn === bare || hn.endsWith(`.${bare}`);
    }
    if ( p.endsWith('.*') ) {
        const bare = p.slice(0, -2);
        return hn === bare || hn.startsWith(`${bare}.`);
    }
    return hn === p || hn.endsWith(`.${p}`);
}

export function registrableDomain(hostname) {
    if ( typeof hostname !== 'string' ) { return ''; }
    const parts = hostname.toLowerCase().split('.').filter(Boolean);
    if ( parts.length <= 2 ) { return parts.join('.'); }
    return parts.slice(-2).join('.');
}

const hasSensitivePathHint = pathname => {
    if ( typeof pathname !== 'string' ) { return ''; }
    const path = pathname.toLowerCase();
    if ( /\/(checkout|cart|billing|payment|pay|wallet)(?:\/|$)/.test(path) ) {
        return 'checkout/payment';
    }
    if ( /\/(login|signin|sign-in|account|auth|password|verify)(?:\/|$)/.test(path) ) {
        return 'auth/account';
    }
    if ( /\/search(?:\/|$|\?)/.test(path) ) {
        return 'site-search';
    }
    return '';
};

export function classifyProtectedSurface(hostname, pathname = '') {
    const normalizedHost = typeof hostname === 'string'
        ? hostname.trim().toLowerCase()
        : '';
    const normalizedPath = typeof pathname === 'string'
        ? pathname.trim().toLowerCase()
        : '';
    if ( normalizedHost === '' ) {
        return { category: '', allowedRiskTier: RISK_TIERS.high, matchedBy: '' };
    }

    for ( const rule of PROTECTED_DOMAIN_RULES ) {
        if ( patternMatchesHostname(rule.pattern, normalizedHost) ) {
            return {
                category: rule.category,
                allowedRiskTier: rule.allowedRiskTier,
                matchedBy: rule.pattern,
            };
        }
    }

    const byPath = hasSensitivePathHint(normalizedPath);
    if ( byPath !== '' ) {
        return {
            category: byPath,
            allowedRiskTier: RISK_TIERS.low,
            matchedBy: 'path-hint',
        };
    }

    if ( normalizedHost.endsWith('.gov') ||
        normalizedHost.endsWith('.edu') ||
        normalizedHost.endsWith('.ac.uk') ||
        normalizedHost.endsWith('.nhs.uk') ) {
        return {
            category: 'government/education/health',
            allowedRiskTier: RISK_TIERS.low,
            matchedBy: 'tld',
        };
    }

    const labels = normalizedHost.split('.');
    if ( labels.some(label => [ 'login', 'signin', 'secure', 'auth', 'account' ].includes(label)) ) {
        return {
            category: 'auth/account',
            allowedRiskTier: RISK_TIERS.low,
            matchedBy: 'hostname-label',
        };
    }
    if ( labels.some(label => [ 'checkout', 'billing', 'payments', 'payment', 'wallet', 'cart' ].includes(label)) ) {
        return {
            category: 'checkout/payment',
            allowedRiskTier: RISK_TIERS.low,
            matchedBy: 'hostname-label',
        };
    }
    if ( labels.some(label => [ 'search' ].includes(label)) ) {
        return {
            category: 'site-search',
            allowedRiskTier: RISK_TIERS.medium,
            matchedBy: 'hostname-label',
        };
    }

    return { category: '', allowedRiskTier: RISK_TIERS.high, matchedBy: '' };
}

export function patternCouldMatchProtectedDomain(pattern) {
    if ( typeof pattern !== 'string' ) { return false; }
    const p = pattern.trim().toLowerCase();
    if ( p === '' ) { return false; }
    if ( p === '*' || p === 'all-urls' ) { return true; }
    if ( p.endsWith('.gov') || p.endsWith('.edu') || p.endsWith('.ac.uk') || p.endsWith('.nhs.uk') ) {
        return true;
    }
    for ( const rule of PROTECTED_DOMAIN_RULES ) {
        if ( patternMatchesHostname(p, rule.pattern) || patternMatchesHostname(rule.pattern, p) ) {
            return true;
        }
    }
    return /(login|signin|account|auth|checkout|billing|payment|wallet|docs|drive|search)/i.test(p);
}

export function selectorHasNuisanceHint(selector) {
    if ( typeof selector !== 'string' ) { return false; }
    return NUISANCE_SELECTOR_RE.test(selector);
}

export function isKnownConsentSelector(selector) {
    if ( typeof selector !== 'string' ) { return false; }
    return CONSENT_SELECTOR_RE.test(selector);
}

export function isKnownConsentRootSelector(selector) {
    if ( typeof selector !== 'string' ) { return false; }
    if ( isKnownConsentSelector(selector) === false ) { return false; }
    return /(#|\.)|(\[id)|(\[class)|(?:dialog|div|section)/i.test(selector);
}

export function selectorLooksLikeShell(selector) {
    if ( typeof selector !== 'string' ) { return false; }
    const s = selector.trim();
    if ( s === '' ) { return true; }
    if ( DANGEROUS_SELECTOR_RE.test(s) ) { return true; }
    if ( GENERIC_TAG_ONLY_RE.test(s) ) { return true; }
    if ( /(^|[\s>+~,(])\*/.test(s) ) { return true; }
    if ( GENERIC_CONTAINER_RE.test(s) && selectorHasNuisanceHint(s) === false ) {
        return true;
    }
    return false;
}

export function isSafeMutationSelector(selector, options = {}) {
    if ( typeof selector !== 'string' ) { return false; }
    const {
        allowGlobal = false,
        requireKnownConsent = false,
    } = options;
    const s = selector.trim();
    if ( s === '' || s.length > 256 ) { return false; }
    if ( allowGlobal === false && (s === '*' || s === 'html' || s === 'body') ) {
        return false;
    }
    if ( selectorLooksLikeShell(s) ) { return false; }
    if ( requireKnownConsent && isKnownConsentRootSelector(s) === false ) {
        return false;
    }
    return true;
}

export function isRemoteScriptletAllowed(token) {
    if ( typeof token !== 'string' ) { return false; }
    return REMOTE_SCRIPTLET_DENY_RE.test(token.trim()) === false;
}

export function sanitizeBreakageAuditOverrides(input) {
    const out = { global: {}, hosts: {} };
    if ( input instanceof Object === false ) { return out; }

    const sanitizeSubsystemMap = candidate => {
        const sanitized = {};
        if ( candidate instanceof Object === false ) { return sanitized; }
        for ( const id of AUDITABLE_SUBSYSTEMS ) {
            if ( typeof candidate[id] !== 'boolean' ) { continue; }
            sanitized[id] = candidate[id];
        }
        return sanitized;
    };

    out.global = sanitizeSubsystemMap(input.global);

    if ( input.hosts instanceof Object ) {
        let hostCount = 0;
        for ( const [host, overrides] of Object.entries(input.hosts) ) {
            if ( typeof host !== 'string' || host.trim() === '' ) { continue; }
            const sanitized = sanitizeSubsystemMap(overrides);
            if ( Object.keys(sanitized).length === 0 ) { continue; }
            out.hosts[host.trim().toLowerCase()] = sanitized;
            hostCount += 1;
            if ( hostCount >= 50 ) { break; }
        }
    }

    return out;
}

export function resolveAuditOverride(overrides, hostname, subsystemId) {
    if ( typeof subsystemId !== 'string' || subsystemId === '' ) { return undefined; }
    if ( overrides instanceof Object === false ) { return undefined; }
    const normalizedHost = typeof hostname === 'string'
        ? hostname.trim().toLowerCase()
        : '';
    const hostEntries = overrides.hosts instanceof Object
        ? Object.entries(overrides.hosts)
        : [];
    for ( const [pattern, config] of hostEntries ) {
        if ( patternMatchesHostname(pattern, normalizedHost) === false ) { continue; }
        if ( typeof config?.[subsystemId] === 'boolean' ) {
            return config[subsystemId];
        }
    }
    if ( typeof overrides.global?.[subsystemId] === 'boolean' ) {
        return overrides.global[subsystemId];
    }
    return undefined;
}
