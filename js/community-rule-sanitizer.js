import {
    isKnownPublicSuffix,
    normalizeSiteKeyHostname,
} from './site-key.js';
import {
    isInternalUnfilteredHostname,
    patternCouldMatchProtectedDomain,
} from './breakage-policy.js';

export const COMMUNITY_RULE_SCHEMA_VERSION_LEGACY = 1;
export const COMMUNITY_RULE_SCHEMA_VERSION_ACTIONS = 2;
export const COMMUNITY_RULE_SCHEMA_VERSION_FULL_EXTRAS = 3;
export const COMMUNITY_RULE_SCHEMA_VERSION_TACTICS = 4;
export const COMMUNITY_RULE_SCHEMA_VERSION_REQUEST_TACTICS = 5;
export const COMMUNITY_RULE_SCHEMA_VERSION_CURRENT =
    COMMUNITY_RULE_SCHEMA_VERSION_REQUEST_TACTICS;

// Keep community block rules below packaged redirect/allow compatibility rules.
// Broad remote blocks must not override uBO's anti-breakage shims.
export const COMMUNITY_RULE_PRIORITY_BLOCK = 10;
export const COMMUNITY_RULE_PRIORITY_REDIRECT = 1100;
export const COMMUNITY_RULE_PRIORITY_ALLOW = 1200;
export const COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS = 1300;

export const COMMUNITY_EXCEPTION_RULES_MAX = 250;
export const COMMUNITY_ALLOW_ALL_REQUESTS_MAX = 50;
const COMMUNITY_REDIRECT_URL_PATH_PREFIX_MAX_LENGTH = 128;

export const COMMUNITY_ALLOWED_REDIRECT_EXTENSION_PATHS = Object.freeze([
    '/web_accessible_resources/empty',
    '/web_accessible_resources/noop.css',
    '/web_accessible_resources/noop.html',
    '/web_accessible_resources/noop.js',
    '/web_accessible_resources/noop.json',
    '/web_accessible_resources/noop.txt',
    '/web_accessible_resources/1x1.gif',
    '/web_accessible_resources/2x2.png',
    '/web_accessible_resources/32x32.png',
    '/web_accessible_resources/noop-vast3.xml',
    '/web_accessible_resources/noop-vmap1.xml',
    '/web_accessible_resources/noop-0.1s.mp3',
    '/web_accessible_resources/noop-1s.mp4',
]);

const VALID_RESOURCE_TYPES = new Set([
    'main_frame',
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'webtransport',
    'webbundle',
    'other',
]);

const FIRST_PARTY_REDIRECT_EXTENSION_PATHS_BY_RESOURCE_TYPE = Object.freeze({
    script: Object.freeze([
        '/web_accessible_resources/noop.js',
    ]),
    stylesheet: Object.freeze([
        '/web_accessible_resources/noop.css',
    ]),
    image: Object.freeze([
        '/web_accessible_resources/1x1.gif',
        '/web_accessible_resources/2x2.png',
        '/web_accessible_resources/32x32.png',
    ]),
    media: Object.freeze([
        '/web_accessible_resources/noop-0.1s.mp3',
        '/web_accessible_resources/noop-1s.mp4',
    ]),
    xmlhttprequest: Object.freeze([
        '/web_accessible_resources/noop.json',
        '/web_accessible_resources/noop.txt',
        '/web_accessible_resources/noop-vast3.xml',
        '/web_accessible_resources/noop-vmap1.xml',
    ]),
});

const EXCEPTION_ACTIONS = new Set([
    'redirect',
    'allow',
    'allowAllRequests',
]);

const hasOwn = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);

export const createEmptyCommunityRuleActionCounts = () => ({
    block: 0,
    redirect: 0,
    allow: 0,
    allowAllRequests: 0,
});

export const createEmptyCommunityRuleQuotaClassCounts = () => ({
    exactExceptions: 0,
    exactRedirects: 0,
    exactBlocks: 0,
    broadBlocks: 0,
    regexBlocks: 0,
});

export const createEmptyCommunityRuleDroppedCounts = () => ({
    unsupportedAction: 0,
    unsafeScope: 0,
    unsupportedRedirectPath: 0,
    quota: 0,
    regexUnsupported: 0,
    quotaByClass: createEmptyCommunityRuleQuotaClassCounts(),
});

export const normalizeCommunityRuleSchemaVersion = value => {
    if ( value === undefined || value === null || value === '' ) {
        return COMMUNITY_RULE_SCHEMA_VERSION_LEGACY;
    }
    const schemaVersion = Number(value);
    if ( Number.isInteger(schemaVersion) === false ) { return 0; }
    if (
        schemaVersion !== COMMUNITY_RULE_SCHEMA_VERSION_LEGACY &&
        schemaVersion !== COMMUNITY_RULE_SCHEMA_VERSION_ACTIONS &&
        schemaVersion !== COMMUNITY_RULE_SCHEMA_VERSION_FULL_EXTRAS &&
        schemaVersion !== COMMUNITY_RULE_SCHEMA_VERSION_TACTICS &&
        schemaVersion !== COMMUNITY_RULE_SCHEMA_VERSION_REQUEST_TACTICS
    ) {
        return 0;
    }
    return schemaVersion;
};

const normalizeDomainType = (
    domainType,
    { allowFirstParty = false } = {}
) => {
    const allowedTypes = allowFirstParty
        ? [ 'firstParty', 'thirdParty' ]
        : [ 'thirdParty' ];
    if ( allowedTypes.includes(domainType) ) { return domainType; }
    if ( Array.isArray(domainType) ) {
        const normalized = allowedTypes.filter(type => domainType.includes(type));
        return normalized.length === 1 ? normalized[0] : '';
    }
    return '';
};

const normalizeResourceTypes = value => {
    if ( Array.isArray(value) === false || value.length === 0 ) { return null; }
    const out = [];
    const seen = new Set();
    for ( const entry of value ) {
        if ( typeof entry !== 'string' ) { return null; }
        if ( VALID_RESOURCE_TYPES.has(entry) === false ) { return null; }
        if ( seen.has(entry) ) { continue; }
        seen.add(entry);
        out.push(entry);
    }
    return out.length === 0 ? null : out;
};

const sanitizeExactHostnameList = (value, { required = false } = {}) => {
    if ( value === undefined ) {
        return required ? null : undefined;
    }
    if ( Array.isArray(value) === false || value.length === 0 ) { return null; }
    const out = [];
    const seen = new Set();
    for ( const entry of value ) {
        if ( typeof entry !== 'string' ) { return null; }
        const normalized = normalizeSiteKeyHostname(entry);
        if ( normalized === '' ) { return null; }
        if ( normalized.includes('*') || normalized === 'all-urls' ) { return null; }
        if ( isKnownPublicSuffix(normalized) ) { return null; }
        if ( isInternalUnfilteredHostname(normalized) ) { return null; }
        if ( seen.has(normalized) ) { continue; }
        seen.add(normalized);
        out.push(normalized);
    }
    return out.length === 0 ? null : out;
};

const exactHostListTargetsInternalDomain = value => {
    if ( Array.isArray(value) === false ) { return false; }
    return value.some(entry => (
        typeof entry === 'string' &&
        isInternalUnfilteredHostname(entry)
    ));
};

const exactHostListTargetsProtectedDomain = value => {
    if ( Array.isArray(value) === false ) { return false; }
    return value.some(entry => (
        typeof entry === 'string' &&
        patternCouldMatchProtectedDomain(`=${entry}`)
    ));
};

const hasOnlyAllowedConditionKeys = (condition, allowedKeys) => {
    for ( const key of Object.keys(condition) ) {
        if ( allowedKeys.has(key) ) { continue; }
        return false;
    }
    return true;
};

const withNonMainFrameCondition = condition => {
    const out = {};
    if ( Array.isArray(condition.resourceTypes) ) {
        const resourceTypes = normalizeResourceTypes(condition.resourceTypes);
        if ( resourceTypes === null ) { return null; }
        const filtered = resourceTypes.filter(type => type !== 'main_frame');
        if ( filtered.length === 0 ) { return null; }
        out.resourceTypes = filtered;
    } else {
        const excludedResourceTypes = Array.isArray(condition.excludedResourceTypes)
            ? normalizeResourceTypes(condition.excludedResourceTypes)
            : [];
        if ( excludedResourceTypes === null ) { return null; }
        const excluded = excludedResourceTypes.slice();
        if ( excluded.includes('main_frame') === false ) {
            excluded.push('main_frame');
        }
        out.excludedResourceTypes = excluded;
    }
    return out;
};

const copyTrimmedString = (target, source, key, { required = false } = {}) => {
    if ( source[key] === undefined ) {
        return required ? false : true;
    }
    if ( typeof source[key] !== 'string' ) { return false; }
    const value = source[key].trim();
    if ( value === '' ) { return false; }
    target[key] = value;
    return true;
};

const copyExactHostnameList = (target, source, key, { required = false } = {}) => {
    const value = sanitizeExactHostnameList(source[key], { required });
    if ( value === null ) { return false; }
    if ( value !== undefined ) {
        target[key] = value;
    }
    return true;
};

const normalizeRedirectExtensionPath = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const trimmed = value.trim();
    if ( trimmed === '' ) { return ''; }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const normalizeRedirectUrlPathPrefix = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    if (
        normalized === '' ||
        normalized.length > COMMUNITY_REDIRECT_URL_PATH_PREFIX_MAX_LENGTH
    ) {
        return '';
    }
    if ( normalized.startsWith('/') === false ) { return ''; }
    if ( normalized.includes('?') || normalized.includes('#') ) { return ''; }
    return normalized;
};

const normalizeFirstPartyRedirectPathPrefix = (condition, exactHost) => {
    const urlPathPrefix = normalizeRedirectUrlPathPrefix(condition?.urlPathPrefix);
    const urlFilter = typeof condition?.urlFilter === 'string'
        ? condition.urlFilter.trim()
        : '';
    if ( urlFilter === '' ) { return urlPathPrefix; }
    const expectedPrefix = `||${exactHost}`;
    if ( urlFilter.startsWith(expectedPrefix) === false ) { return ''; }
    const normalizedFromFilter = normalizeRedirectUrlPathPrefix(
        urlFilter.slice(expectedPrefix.length)
    );
    if ( normalizedFromFilter === '' ) { return ''; }
    if ( urlPathPrefix !== '' && urlPathPrefix !== normalizedFromFilter ) {
        return '';
    }
    return normalizedFromFilter;
};

export const classifyCommunityRuleQuotaClass = rule => {
    if ( rule instanceof Object === false ) { return 'broadBlocks'; }
    if ( rule.condition?.regexFilter !== undefined ) { return 'regexBlocks'; }
    const actionType = typeof rule.action?.type === 'string'
        ? rule.action.type
        : '';
    if ( actionType === 'allow' || actionType === 'allowAllRequests' ) {
        return 'exactExceptions';
    }
    if ( actionType === 'redirect' ) {
        return 'exactRedirects';
    }
    const requestDomains = Array.isArray(rule.condition?.requestDomains)
        ? rule.condition.requestDomains
        : [];
    const initiatorDomains = Array.isArray(rule.condition?.initiatorDomains)
        ? rule.condition.initiatorDomains
        : [];
    if ( requestDomains.length !== 0 || initiatorDomains.length !== 0 ) {
        return 'exactBlocks';
    }
    return 'broadBlocks';
};

const sanitizeBlockRule = rule => {
    if ( rule.condition instanceof Object === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const input = rule.condition;
    const allowedKeys = new Set([
        'urlFilter',
        'regexFilter',
        'requestDomains',
        'excludedRequestDomains',
        'initiatorDomains',
        'excludedInitiatorDomains',
        'resourceTypes',
        'excludedResourceTypes',
        'domainType',
        'isUrlFilterCaseSensitive',
    ]);
    if ( hasOnlyAllowedConditionKeys(input, allowedKeys) === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if (
        exactHostListTargetsInternalDomain(input.requestDomains) ||
        exactHostListTargetsInternalDomain(input.initiatorDomains) ||
        exactHostListTargetsProtectedDomain(input.requestDomains) ||
        exactHostListTargetsProtectedDomain(input.initiatorDomains)
    ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( Array.isArray(input.resourceTypes) && Array.isArray(input.excludedResourceTypes) ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( Array.isArray(input.domainType) && input.domainType.includes('firstParty') ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const condition = {};
    if (
        copyTrimmedString(condition, input, 'urlFilter') === false ||
        copyTrimmedString(condition, input, 'regexFilter') === false ||
        copyExactHostnameList(condition, input, 'requestDomains') === false ||
        copyExactHostnameList(condition, input, 'excludedRequestDomains') === false ||
        copyExactHostnameList(condition, input, 'initiatorDomains') === false ||
        copyExactHostnameList(condition, input, 'excludedInitiatorDomains') === false
    ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if (
        condition.urlFilter === undefined &&
        condition.regexFilter === undefined &&
        condition.requestDomains === undefined
    ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( input.isUrlFilterCaseSensitive !== undefined ) {
        if ( typeof input.isUrlFilterCaseSensitive !== 'boolean' ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        condition.isUrlFilterCaseSensitive = input.isUrlFilterCaseSensitive;
    }
    const nonMainFrameCondition = withNonMainFrameCondition(input);
    if ( nonMainFrameCondition === null ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const normalizedDomainType = normalizeDomainType(input.domainType);
    if ( input.domainType !== undefined && normalizedDomainType === '' ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    Object.assign(condition, nonMainFrameCondition);
    condition.domainType = normalizedDomainType || 'thirdParty';
    return {
        ok: true,
        actionType: 'block',
        isException: false,
        rule: {
            action: { type: 'block' },
            condition,
            priority: COMMUNITY_RULE_PRIORITY_BLOCK,
        },
    };
};

const sanitizeAllowRule = rule => {
    if ( rule.condition instanceof Object === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const condition = rule.condition;
    const allowedKeys = new Set([
        'initiatorDomains',
        'requestDomains',
        'resourceTypes',
    ]);
    if ( hasOnlyAllowedConditionKeys(condition, allowedKeys) === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const initiatorDomains = sanitizeExactHostnameList(condition.initiatorDomains, {
        required: true,
    });
    const requestDomains = sanitizeExactHostnameList(condition.requestDomains);
    const resourceTypes = normalizeResourceTypes(condition.resourceTypes);
    if (
        initiatorDomains === null ||
        requestDomains === null ||
        resourceTypes === null
    ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const outCondition = {
        initiatorDomains,
        resourceTypes,
    };
    if ( requestDomains !== undefined ) {
        outCondition.requestDomains = requestDomains;
    }
    return {
        ok: true,
        actionType: 'allow',
        isException: true,
        rule: {
            action: { type: 'allow' },
            condition: outCondition,
            priority: COMMUNITY_RULE_PRIORITY_ALLOW,
        },
    };
};

const sanitizeAllowAllRequestsRule = rule => {
    if ( rule.condition instanceof Object === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const condition = rule.condition;
    const allowedKeys = new Set([
        'requestDomains',
        'resourceTypes',
    ]);
    if ( hasOnlyAllowedConditionKeys(condition, allowedKeys) === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const requestDomains = sanitizeExactHostnameList(condition.requestDomains, {
        required: true,
    });
    const resourceTypes = normalizeResourceTypes(condition.resourceTypes);
    if ( requestDomains === null || resourceTypes === null ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( resourceTypes.length !== 1 || resourceTypes[0] !== 'main_frame' ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    return {
        ok: true,
        actionType: 'allowAllRequests',
        isException: true,
        rule: {
            action: { type: 'allowAllRequests' },
            condition: {
                requestDomains,
                resourceTypes,
            },
            priority: COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS,
        },
    };
};

const sanitizeRedirectRule = rule => {
    if ( rule.condition instanceof Object === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( rule.action?.redirect instanceof Object === false ) {
        return { ok: false, reason: 'unsupportedRedirectPath' };
    }
    if (
        hasOwn(rule.action.redirect, 'url') ||
        hasOwn(rule.action.redirect, 'regexSubstitution')
    ) {
        return { ok: false, reason: 'unsupportedRedirectPath' };
    }
    if ( hasOwn(rule.action.redirect, 'transform') ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const extensionPath = normalizeRedirectExtensionPath(
        rule.action.redirect.extensionPath
    );
    if ( COMMUNITY_ALLOWED_REDIRECT_EXTENSION_PATHS.includes(extensionPath) === false ) {
        return { ok: false, reason: 'unsupportedRedirectPath' };
    }
    const condition = rule.condition;
    const normalizedDomainType = normalizeDomainType(condition.domainType, {
        allowFirstParty: true,
    });
    if ( condition.domainType !== undefined && normalizedDomainType === '' ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    if ( normalizedDomainType === 'firstParty' ) {
        const allowedKeys = new Set([
            'initiatorDomains',
            'requestDomains',
            'resourceTypes',
            'domainType',
            'urlPathPrefix',
            'urlFilter',
        ]);
        if ( hasOnlyAllowedConditionKeys(condition, allowedKeys) === false ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        const initiatorDomains = sanitizeExactHostnameList(condition.initiatorDomains, {
            required: true,
        });
        const requestDomains = sanitizeExactHostnameList(condition.requestDomains, {
            required: true,
        });
        const resourceTypes = normalizeResourceTypes(condition.resourceTypes);
        if (
            initiatorDomains === null ||
            requestDomains === null ||
            resourceTypes === null
        ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        if (
            initiatorDomains.length !== 1 ||
            requestDomains.length !== 1 ||
            initiatorDomains[0] !== requestDomains[0]
        ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        const exactHost = initiatorDomains[0];
        const urlPathPrefix = normalizeFirstPartyRedirectPathPrefix(condition, exactHost);
        if ( urlPathPrefix === '' ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        if (
            exactHostListTargetsInternalDomain(initiatorDomains) ||
            exactHostListTargetsProtectedDomain(initiatorDomains)
        ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        if ( resourceTypes.length !== 1 ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        const resourceType = resourceTypes[0];
        const allowedExtensionPaths = FIRST_PARTY_REDIRECT_EXTENSION_PATHS_BY_RESOURCE_TYPE[
            resourceType
        ];
        if ( Array.isArray(allowedExtensionPaths) === false ) {
            return { ok: false, reason: 'unsafeScope' };
        }
        if ( allowedExtensionPaths.includes(extensionPath) === false ) {
            return { ok: false, reason: 'unsupportedRedirectPath' };
        }
        return {
            ok: true,
            actionType: 'redirect',
            isException: true,
            rule: {
                action: {
                    type: 'redirect',
                    redirect: { extensionPath },
                },
                condition: {
                    initiatorDomains,
                    requestDomains,
                    resourceTypes,
                    domainType: 'firstParty',
                    urlFilter: `||${exactHost}${urlPathPrefix}`,
                },
                priority: COMMUNITY_RULE_PRIORITY_REDIRECT,
            },
        };
    }
    const allowedKeys = new Set([
        'initiatorDomains',
        'requestDomains',
        'resourceTypes',
        'domainType',
    ]);
    if ( hasOnlyAllowedConditionKeys(condition, allowedKeys) === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const initiatorDomains = sanitizeExactHostnameList(condition.initiatorDomains, {
        required: true,
    });
    const requestDomains = sanitizeExactHostnameList(condition.requestDomains, {
        required: true,
    });
    if ( initiatorDomains === null || requestDomains === null ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const outCondition = {
        initiatorDomains,
        requestDomains,
        domainType: normalizedDomainType || 'thirdParty',
    };
    const nonMainFrameCondition = withNonMainFrameCondition(condition);
    if ( nonMainFrameCondition === null ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    Object.assign(outCondition, nonMainFrameCondition);
    return {
        ok: true,
        actionType: 'redirect',
        isException: true,
        rule: {
            action: {
                type: 'redirect',
                redirect: { extensionPath },
            },
            condition: outCondition,
            priority: COMMUNITY_RULE_PRIORITY_REDIRECT,
        },
    };
};

export const sanitizeCommunityRule = (
    rule,
    { schemaVersion = COMMUNITY_RULE_SCHEMA_VERSION_LEGACY } = {}
) => {
    if ( rule instanceof Object === false ) {
        return { ok: false, reason: 'unsafeScope' };
    }
    const actionType = typeof rule.action?.type === 'string'
        ? rule.action.type
        : '';
    if ( actionType === 'block' ) {
        return sanitizeBlockRule(rule);
    }
    if ( schemaVersion < COMMUNITY_RULE_SCHEMA_VERSION_ACTIONS ) {
        return { ok: false, reason: 'unsupportedAction' };
    }
    if ( actionType === 'allow' ) {
        return sanitizeAllowRule(rule);
    }
    if ( actionType === 'allowAllRequests' ) {
        return sanitizeAllowAllRequestsRule(rule);
    }
    if ( actionType === 'redirect' ) {
        return sanitizeRedirectRule(rule);
    }
    return { ok: false, reason: 'unsupportedAction' };
};

export const sanitizeCommunityRules = (
    rulesIn = [],
    { schemaVersion = COMMUNITY_RULE_SCHEMA_VERSION_LEGACY } = {}
) => {
    const rules = [];
    const byAction = createEmptyCommunityRuleActionCounts();
    const dropped = createEmptyCommunityRuleDroppedCounts();
    let exceptionCount = 0;
    let allowAllRequestsCount = 0;

    if ( Array.isArray(rulesIn) === false ) {
        return {
            rules,
            byAction,
            dropped,
            exceptionCount,
            allowAllRequestsCount,
        };
    }

    for ( const rule of rulesIn ) {
        const result = sanitizeCommunityRule(rule, { schemaVersion });
        if ( result.ok !== true ) {
            dropped[result.reason] = (dropped[result.reason] || 0) + 1;
            continue;
        }
        const { actionType } = result;
        if ( EXCEPTION_ACTIONS.has(actionType) ) {
            const quotaClass = classifyCommunityRuleQuotaClass(result.rule);
            if ( exceptionCount >= COMMUNITY_EXCEPTION_RULES_MAX ) {
                dropped.quota += 1;
                dropped.quotaByClass[quotaClass] += 1;
                continue;
            }
            if (
                actionType === 'allowAllRequests' &&
                allowAllRequestsCount >= COMMUNITY_ALLOW_ALL_REQUESTS_MAX
            ) {
                dropped.quota += 1;
                dropped.quotaByClass[quotaClass] += 1;
                continue;
            }
            exceptionCount += 1;
        }
        if ( actionType === 'allowAllRequests' ) {
            allowAllRequestsCount += 1;
        }
        byAction[actionType] += 1;
        rules.push(result.rule);
    }

    return {
        rules,
        byAction,
        dropped,
        exceptionCount,
        allowAllRequestsCount,
    };
};
