/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_breakageGuard() {

if ( self.TalonBreakageGuard ) { return; }

const runtime = self.browser?.runtime || self.chrome?.runtime;
const storage = self.browser?.storage?.local || self.chrome?.storage?.local;

const RISK_TIERS = Object.freeze({
    low: 1,
    medium: 2,
    high: 3,
});

const BREAKAGE_AUDIT_OVERRIDES_KEY = 'breakageAuditOverridesV1';
const AUDITABLE_SUBSYSTEMS = new Set([
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'postHideCleanup',
]);

// Keep explicit protected-host rules aligned with automation/protected-domains.json.
const PROTECTED_HOST_RULES = [
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
];

const CONSENT_SELECTOR_RE = /\b(cookie|consent|gdpr|cmp|onetrust|didomi|quantcast|trustarc|truste|sourcepoint|cookiebot|iubenda|sp_message|cky)\b/i;
const NUISANCE_SELECTOR_RE = /\b(ad|ads|advert|sponsor|promo|overlay|popup|modal|interstitial|banner|newsletter|subscribe|teaser|cookie|consent|gdpr|cmp|paywall)\b/i;
const DANGEROUS_SELECTOR_RE = /\b(html|body|main|article|form)\b|#(?:root|app|__next|__nuxt)\b|\[role\s*=\s*["']?main["']?\]/i;
const GENERIC_CONTAINER_RE = /\b(container|content|wrapper|layout|page|shell|grid|column|col-|main|article|story|post)\b/i;
const GENERIC_TAG_ONLY_RE = /^\s*(?:div|section|aside|main|article|form|span|p|ul|ol|li)(?:\s*[>+~:]|\s*$)/i;
const SHELL_SELECTOR = 'html,body,main,article,form,[role="main"],#root,#app,#__next,#__nuxt,[data-reactroot]';
const PRIMARY_CANDIDATE_SELECTOR = 'main,[role="main"],article,form,#main,#content,.article-body,.entry-content,.post-content';
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
const MAX_MUTATION_AUDIT_PER_PAGE = 6;

const patternMatchesHostname = (pattern, hostname) => {
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
};

const hostname = (self.location?.hostname || '').toLowerCase();
const pathname = (self.location?.pathname || '').toLowerCase();

const classifyProtection = () => {
    for ( const rule of PROTECTED_HOST_RULES ) {
        if ( patternMatchesHostname(rule.pattern, hostname) ) {
            return {
                category: rule.category,
                allowedRiskTier: rule.allowedRiskTier,
                matchedBy: rule.pattern,
            };
        }
    }

    if ( /\/(checkout|cart|billing|payment|pay|wallet)(?:\/|$)/.test(pathname) ) {
        return { category: 'checkout/payment', allowedRiskTier: RISK_TIERS.low, matchedBy: 'path-hint' };
    }
    if ( /\/(login|signin|sign-in|account|auth|password|verify)(?:\/|$)/.test(pathname) ) {
        return { category: 'auth/account', allowedRiskTier: RISK_TIERS.low, matchedBy: 'path-hint' };
    }
    if ( /\/search(?:\/|$|\?)/.test(pathname) ) {
        return { category: 'site-search', allowedRiskTier: RISK_TIERS.medium, matchedBy: 'path-hint' };
    }
    if ( hostname.endsWith('.gov') ||
        hostname.endsWith('.edu') ||
        hostname.endsWith('.ac.uk') ||
        hostname.endsWith('.nhs.uk') ) {
        return { category: 'government/education/health', allowedRiskTier: RISK_TIERS.low, matchedBy: 'tld' };
    }

    if ( document.querySelector('article,[property="article:published_time"],meta[property="og:type"][content="article"]') ) {
        return { category: 'news/article', allowedRiskTier: RISK_TIERS.medium, matchedBy: 'dom-article' };
    }
    if ( document.querySelector('input[type="password"], form[action*="login" i], form[action*="signin" i]') ) {
        return { category: 'auth/account', allowedRiskTier: RISK_TIERS.low, matchedBy: 'dom-auth' };
    }
    if ( document.querySelector(CHECKOUT_HINT_SELECTOR) ) {
        return { category: 'checkout/payment', allowedRiskTier: RISK_TIERS.low, matchedBy: 'dom-checkout' };
    }
    if ( document.querySelector('input[type="search"], form[role="search"]') && pathname.includes('/search') ) {
        return { category: 'site-search', allowedRiskTier: RISK_TIERS.medium, matchedBy: 'dom-search' };
    }

    return { category: '', allowedRiskTier: RISK_TIERS.high, matchedBy: '' };
};

let protection = classifyProtection();
let auditOverrides = { global: {}, hosts: {} };
let readyPromise;

const readLocalValue = key => {
    if ( storage?.get === undefined ) { return Promise.resolve(undefined); }
    try {
        const maybePromise = storage.get(key);
        if ( maybePromise?.then ) {
            return maybePromise.then(bin => bin?.[key]);
        }
    } catch {
    }
    return new Promise(resolve => {
        try {
            storage.get(key, bin => resolve(bin?.[key]));
        } catch {
            resolve(undefined);
        }
    });
};

const loadOverrides = async () => {
    const stored = await readLocalValue(BREAKAGE_AUDIT_OVERRIDES_KEY);
    auditOverrides = stored instanceof Object ? stored : { global: {}, hosts: {} };
};

const whenReady = () => {
    if ( readyPromise !== undefined ) { return readyPromise; }
    readyPromise = loadOverrides().catch(() => { });
    return readyPromise;
};

const resolveAuditOverride = subsystemId => {
    if ( AUDITABLE_SUBSYSTEMS.has(subsystemId) === false ) { return undefined; }
    if ( auditOverrides?.hosts instanceof Object ) {
        for ( const [pattern, config] of Object.entries(auditOverrides.hosts) ) {
            if ( patternMatchesHostname(pattern, hostname) === false ) { continue; }
            if ( typeof config?.[subsystemId] === 'boolean' ) {
                return config[subsystemId];
            }
        }
    }
    if ( typeof auditOverrides?.global?.[subsystemId] === 'boolean' ) {
        return auditOverrides.global[subsystemId];
    }
    return undefined;
};

const isVisible = el => {
    if ( el instanceof Element === false ) { return false; }
    try {
        const style = self.getComputedStyle(el);
        if ( style.display === 'none' ) { return false; }
        if ( style.visibility === 'hidden' ) { return false; }
        if ( Number(style.opacity) === 0 ) { return false; }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    } catch {
    }
    return false;
};

const selectorLooksLikeShell = selector => {
    if ( typeof selector !== 'string' ) { return true; }
    const s = selector.trim();
    if ( s === '' ) { return true; }
    if ( DANGEROUS_SELECTOR_RE.test(s) ) { return true; }
    if ( GENERIC_TAG_ONLY_RE.test(s) ) { return true; }
    if ( /(^|[\s>+~,(])\*/.test(s) ) { return true; }
    if ( GENERIC_CONTAINER_RE.test(s) && NUISANCE_SELECTOR_RE.test(s) === false ) {
        return true;
    }
    return false;
};

const isKnownConsentRootSelector = selector => {
    if ( typeof selector !== 'string' ) { return false; }
    if ( CONSENT_SELECTOR_RE.test(selector) === false ) { return false; }
    return /(#|\.)|(\[id)|(\[class)|(?:dialog|div|section)/i.test(selector);
};

const isSafeMutationSelector = (selector, options = {}) => {
    if ( typeof selector !== 'string' ) { return false; }
    const { allowGlobal = false, requireKnownConsent = false } = options;
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
};

const textWeight = el => {
    if ( el instanceof Element === false ) { return 0; }
    const text = el.textContent || '';
    return text.trim().replace(/\s+/g, ' ').length;
};

const isShellElement = el => {
    if ( el instanceof Element === false ) { return false; }
    try {
        if ( el.matches(SHELL_SELECTOR) ) { return true; }
    } catch {
    }

    const idAndClass = `${el.id || ''} ${el.className || ''}`;
    if ( /\b(root|app|page|layout|shell|content|article|story|main)\b/i.test(idAndClass) ) {
        const rect = el.getBoundingClientRect();
        if ( rect.width >= self.innerWidth * 0.6 && rect.height >= self.innerHeight * 0.4 ) {
            return true;
        }
    }
    return false;
};

const isLikelyPrimaryContent = el => {
    if ( el instanceof Element === false ) { return false; }
    if ( isShellElement(el) ) { return true; }
    try {
        if ( el.matches('main,article,[role="main"],form') ) { return true; }
    } catch {
    }

    const rect = el.getBoundingClientRect();
    if ( rect.width <= 0 || rect.height <= 0 ) { return false; }
    if ( rect.width < self.innerWidth * 0.45 || rect.height < self.innerHeight * 0.25 ) {
        return false;
    }

    const paragraphs = el.querySelectorAll('p').length;
    const headings = el.querySelectorAll('h1,h2,h3').length;
    const forms = el.querySelectorAll('form,input,textarea,select,button').length;
    const textLen = textWeight(el);
    if ( forms >= 4 ) { return true; }
    if ( paragraphs >= 3 && textLen >= 400 ) { return true; }
    if ( headings >= 2 && textLen >= 350 ) { return true; }
    return false;
};

const reportBreakageSignal = (signal, details = {}) => {
    if ( runtime?.sendMessage === undefined ) { return; }
    const signalKey = `${signal}:${details.reason || ''}:${details.selector || ''}`;
    if ( reportBreakageSignal.seen.has(signalKey) ) { return; }
    reportBreakageSignal.seen.add(signalKey);
    try {
        runtime.sendMessage({
            what: 'reportBreakageSignal',
            hostname,
            signal,
            details,
        }).catch(() => {});
    } catch {
    }
};
reportBreakageSignal.seen = new Set();

const canMutateElement = (el, options = {}) => {
    if ( el instanceof Element === false ) {
        return { allowed: false, reason: 'not-element' };
    }
    const riskTier = Number(options.riskTier) || RISK_TIERS.medium;
    if ( riskTier > protection.allowedRiskTier ) {
        return {
            allowed: false,
            reason: 'protected-surface',
            category: protection.category,
        };
    }
    if ( el === document.documentElement || el === document.body ) {
        reportBreakageSignal('page-shell-hidden', {
            category: protection.category,
            reason: 'body-or-html-target',
            source: options.source || '',
        });
        return { allowed: false, reason: 'root-target' };
    }
    if ( isShellElement(el) || isLikelyPrimaryContent(el) ) {
        reportBreakageSignal('page-shell-hidden', {
            category: protection.category,
            reason: 'shell-target',
            source: options.source || '',
        });
        return { allowed: false, reason: 'shell-target' };
    }
    const rect = el.getBoundingClientRect();
    if ( rect.width >= self.innerWidth * 0.8 && rect.height >= self.innerHeight * 0.6 ) {
        reportBreakageSignal('page-shell-hidden', {
            category: protection.category,
            reason: 'large-target',
            source: options.source || '',
        });
        return { allowed: false, reason: 'large-target' };
    }
    return { allowed: true, reason: '' };
};

const filterSelectors = (selectors, options = {}) => {
    if ( Array.isArray(selectors) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const selector of selectors ) {
        if ( typeof selector !== 'string' ) { continue; }
        const normalized = selector.trim();
        if ( normalized === '' || seen.has(normalized) ) { continue; }
        if ( isSafeMutationSelector(normalized, options) === false ) { continue; }
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
};

const shouldAllowDirective = directive => {
    if ( directive instanceof Object === false ) { return false; }
    const action = typeof directive.action === 'string' ? directive.action.trim() : '';
    const category = typeof directive.category === 'string' ? directive.category.trim() : '';
    const selectors = filterSelectors(directive.selectors, {
        requireKnownConsent: protection.allowedRiskTier < RISK_TIERS.high && category === 'consent',
    });
    if ( selectors.length === 0 ) { return false; }

    const hosts = Array.isArray(directive.hosts) ? directive.hosts : [];
    const hasWildcardHost = hosts.some(h => typeof h === 'string' && (h === '*' || h === 'all-urls'));
    if ( protection.allowedRiskTier < RISK_TIERS.high ) {
        if ( action === 'remove' ) { return false; }
        if ( category !== 'consent' ) { return false; }
        if ( hasWildcardHost && action !== 'click' && action !== 'hide' ) { return false; }
        if ( directive.fallbackAction && directive.fallbackAction !== 'hide' ) { return false; }
        if ( directive.fallbackAction === 'hide' ) {
            const fallback = filterSelectors(directive.fallbackSelectors, { requireKnownConsent: true });
            if ( fallback.length === 0 ) { return false; }
        }
    } else if ( action === 'remove' && hasWildcardHost ) {
        return false;
    }

    directive.selectors = selectors;
    if ( Array.isArray(directive.fallbackSelectors) ) {
        directive.fallbackSelectors = filterSelectors(directive.fallbackSelectors, {
            requireKnownConsent: protection.allowedRiskTier < RISK_TIERS.high,
        });
    }
    return true;
};

const shouldAllowRemoteCosmeticSelector = (selector, options = {}) => {
    if ( isSafeMutationSelector(selector) === false ) { return false; }
    if ( protection.allowedRiskTier < RISK_TIERS.high && options.hostSpecific !== true ) {
        return false;
    }
    return true;
};

const primarySnapshotFor = el => {
    if ( el instanceof Element === false ) { return null; }
    const rect = el.getBoundingClientRect();
    return {
        visible: isVisible(el),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        textLength: textWeight(el),
        tag: el.tagName.toLowerCase(),
    };
};

const pickPrimaryElement = () => {
    let candidates = [];
    try {
        candidates = Array.from(document.querySelectorAll(PRIMARY_CANDIDATE_SELECTOR));
    } catch {
        candidates = [];
    }
    for ( const candidate of candidates ) {
        if ( isVisible(candidate) === false ) { continue; }
        if ( isLikelyPrimaryContent(candidate) ) { return candidate; }
    }
    return null;
};

let baselinePrimary = null;
let mutationAuditCount = 0;
let mutationAuditTimer;

const ensureBaseline = () => {
    if ( baselinePrimary !== null ) { return; }
    const el = pickPrimaryElement();
    if ( el === null ) { return; }
    baselinePrimary = {
        element: el,
        snapshot: primarySnapshotFor(el),
    };
};

const auditAfterMutation = reason => {
    if ( mutationAuditCount >= MAX_MUTATION_AUDIT_PER_PAGE ) { return; }
    if ( mutationAuditTimer !== undefined ) { return; }
    mutationAuditTimer = self.setTimeout(() => {
        mutationAuditTimer = undefined;
        ensureBaseline();

        const html = document.documentElement;
        const body = document.body;
        try {
            if ( html && self.getComputedStyle(html).overflow === 'hidden' ) {
                reportBreakageSignal('scroll-lock-persisted', {
                    category: protection.category,
                    reason,
                    source: 'post-mutation-audit',
                });
            }
        } catch {
        }
        try {
            if ( body ) {
                const style = self.getComputedStyle(body);
                if ( style.overflow === 'hidden' || style.position === 'fixed' ) {
                    reportBreakageSignal('scroll-lock-persisted', {
                        category: protection.category,
                        reason,
                        source: 'post-mutation-audit',
                    });
                }
            }
        } catch {
        }

        const form = document.querySelector('form');
        if ( protection.category === 'auth/account' || protection.category === 'checkout/payment' ) {
            if ( form instanceof Element && isVisible(form) === false ) {
                reportBreakageSignal('required-form-hidden', {
                    category: protection.category,
                    reason,
                    source: 'post-mutation-audit',
                });
            }
        }

        if ( baselinePrimary?.element instanceof Element ) {
            const current = primarySnapshotFor(baselinePrimary.element);
            const before = baselinePrimary.snapshot;
            if ( current && before ) {
                if ( current.visible === false ) {
                    reportBreakageSignal('primary-content-hidden', {
                        category: protection.category,
                        reason,
                        source: 'post-mutation-audit',
                    });
                } else if (
                    before.height > 0 &&
                    before.textLength > 0 &&
                    current.height < before.height * 0.6 &&
                    current.textLength < before.textLength * 0.6
                ) {
                    reportBreakageSignal('primary-content-collapsed', {
                        category: protection.category,
                        reason,
                        source: 'post-mutation-audit',
                        beforeHeight: before.height,
                        afterHeight: current.height,
                        beforeText: before.textLength,
                        afterText: current.textLength,
                    });
                }
            }
        }

        mutationAuditCount += 1;
    }, 180);
};

if ( document.readyState === 'loading' ) {
    document.addEventListener('DOMContentLoaded', () => {
        protection = classifyProtection();
        ensureBaseline();
    }, { once: true });
} else {
    ensureBaseline();
}

self.TalonBreakageGuard = {
    RISK_TIERS,
    protection,
    whenReady,
    shouldRunSubsystem(subsystemId) {
        const override = resolveAuditOverride(subsystemId);
        return override !== false;
    },
    isProtectedSurface() {
        return protection.allowedRiskTier < RISK_TIERS.high;
    },
    getProtection() {
        return protection;
    },
    isKnownConsentRootSelector,
    isSafeMutationSelector,
    isLikelyPrimaryContent,
    selectorLooksLikeShell,
    canMutateElement,
    filterSelectors,
    shouldAllowDirective,
    shouldAllowRemoteCosmeticSelector,
    auditAfterMutation,
    reportBreakageSignal,
};

})();

void 0;
