/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    browser,
    localRemove, localWrite,
    runtime,
    sessionRemove, sessionWrite,
    webextFlavor,
} from './ext.js';

import {
    applyDefaultRulesetFlagsToDetails,
    getDefaultRulesetIdsFromRuleResources,
    planStaticRulesetQuotaChange,
    reconcileDefaultRulesetPatch,
} from './default-rulesets.js';

import {
    getEffectiveStrictBlockMode,
    isStrictBlockModeManaged,
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';
import { ubolErr, ubolLog } from './debug.js';

import { dnr } from './ext-compat.js';
import { fetchJSON } from './fetch.js';
import { getAdminRulesets } from './admin.js';
import { hasBroadHostPermissions } from './utils.js';
import { rulesFromText } from './dnr-parser.js';
import {
    classifyCommunityRuleQuotaClass,
    COMMUNITY_RULE_SCHEMA_VERSION_LEGACY,
    createEmptyCommunityRuleActionCounts,
    normalizeCommunityRuleSchemaVersion,
    sanitizeCommunityRules,
} from './community-rule-sanitizer.js';
import {
    INTERNAL_UNFILTERED_DOMAINS,
    isInternalUnfilteredHostname,
} from './breakage-policy.js';

/******************************************************************************/

const SPECIAL_RULES_REALM = 5000000;
const USER_RULES_BASE_RULE_ID = 9000000;
const USER_RULES_PRIORITY = 1000000;
const TRUSTED_DIRECTIVE_BASE_RULE_ID = 8000000;
const TRUSTED_DIRECTIVE_PRIORITY = USER_RULES_PRIORITY + 1000000;
const TALON_SITE_FIXES_RULESET_ID = 'talon-site-fixes';
export const DNR_RECONCILIATION_DIRTY_KEY = 'dnrReconciliationDirtyV1';
const TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID = 7000000;
const TALON_SITE_FIXES_RUNTIME_RULES_RANGE = 1000;
let enableRulesetsTail = Promise.resolve();
const TALON_SITE_FIXES_RUNTIME_PRIORITY = 500000;
const STRICTBLOCK_PRIORITY = 29;
const COMMUNITY_RULES_BASE_RULE_ID = 6000000;
const COMMUNITY_RULES_RANGE = 1000000; // 6,000,000–6,999,999
const COMMUNITY_RULES_MAX = 3500;
const COMMUNITY_RESERVED_HEADROOM = 250;

const readStorageValueStrict = async (area, key, areaName) => {
    if ( area instanceof Object === false || typeof area.get !== 'function' ) {
        throw new Error(`${areaName} storage API unavailable`);
    }
    const bin = await area.get(key);
    if (
        bin === null ||
        typeof bin !== 'object' ||
        Array.isArray(bin)
    ) {
        throw new Error(`invalid ${areaName} storage response for ${key}`);
    }
    return Object.hasOwn(bin, key) ? bin[key] : undefined;
};

const readLocalStrict = key =>
    readStorageValueStrict(browser.storage?.local, key, 'local');

const readSessionStrict = key =>
    readStorageValueStrict(browser.storage?.session, key, 'session');

const countRegexRules = rules => {
    if ( Array.isArray(rules) === false ) { return 0; }
    let count = 0;
    for ( const rule of rules ) {
        if ( rule?.condition?.regexFilter === undefined ) { continue; }
        count += 1;
    }
    return count;
};

const getDynamicRegexRuleCount = async ( ) =>
    countRegexRules(await dnr.getDynamicRules());

const logDynamicRegexUsage = regexCount => {
    if ( regexCount === 0 ) { return; }
    ubolLog(`Using ${regexCount}/${dnr.MAX_NUMBER_OF_REGEX_RULES} dynamic regex-based DNR rules`);
};

// https://github.com/uBlockOrigin/uBOL-home/issues/715
const toSafeDynamicRules = rules => {
    if ( Array.isArray(rules) === false ) { return []; }
    if ( dnr.RuleConditionKeys?.TOP_DOMAINS ) { return rules; }
    const safeRules = [];
    for ( const rule of rules ) {
        const { condition } = rule;
        if ( condition?.topDomains !== undefined ) { continue; }
        if ( condition?.excludedTopDomains === undefined ) {
            safeRules.push(rule);
            continue;
        }
        const safeRule = {
            ...rule,
            condition: { ...condition },
        };
        delete safeRule.condition.excludedTopDomains;
        safeRules.push(safeRule);
    }
    return safeRules;
};

const stableRuleValue = value => {
    if ( Array.isArray(value) ) {
        return value.map(stableRuleValue);
    }
    if ( value instanceof Object ) {
        const out = {};
        for ( const key of Object.keys(value).sort() ) {
            out[key] = stableRuleValue(value[key]);
        }
        return out;
    }
    return value;
};

const stableRulesKey = rules => JSON.stringify(
    rules.slice().sort((a, b) => a.id - b.id).map(stableRuleValue)
);

const areSameRules = (left, right) => {
    if ( left.length !== right.length ) { return false; }
    return stableRulesKey(left) === stableRulesKey(right);
};

const isTalonSiteFixRuntimeRuleId = id =>
    Number.isInteger(id) &&
    id >= TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID &&
    id < TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID + TALON_SITE_FIXES_RUNTIME_RULES_RANGE;

const COMMUNITY_RULE_QUOTA_CLASS_PRIORITY = Object.freeze({
    exactExceptions: 0,
    exactRedirects: 1,
    exactBlocks: 2,
    broadBlocks: 3,
    regexBlocks: 4,
});

/******************************************************************************/

const prioritizeCommunityRulesForQuota = rules => rules
    .slice()
    .sort((a, b) => {
        const left = COMMUNITY_RULE_QUOTA_CLASS_PRIORITY[
            classifyCommunityRuleQuotaClass(a)
        ] ?? COMMUNITY_RULE_QUOTA_CLASS_PRIORITY.broadBlocks;
        const right = COMMUNITY_RULE_QUOTA_CLASS_PRIORITY[
            classifyCommunityRuleQuotaClass(b)
        ] ?? COMMUNITY_RULE_QUOTA_CLASS_PRIORITY.broadBlocks;
        return left - right;
    });

const recordCommunityQuotaDrop = (dropped, rule) => {
    dropped.quota += 1;
    const quotaClass = classifyCommunityRuleQuotaClass(rule);
    if ( dropped?.quotaByClass?.[quotaClass] !== undefined ) {
        dropped.quotaByClass[quotaClass] += 1;
    }
};

/******************************************************************************/

const isStrictBlockRule = rule => {
    if ( rule.priority !== STRICTBLOCK_PRIORITY ) { return false; }
    if ( rule.condition?.resourceTypes === undefined ) { return false; }
    if ( rule.condition.resourceTypes.length !== 1 ) { return false; }
    if ( rule.condition.resourceTypes[0] !== 'main_frame' ) { return false; }
    if ( rule.action.type === 'redirect' ) {
        const substitution = rule.action.redirect.regexSubstitution;
        return substitution !== undefined &&
            substitution.includes('/strictblock.');
    }
    if ( rule.action.type === 'allow' ) {
        return Array.isArray(rule.condition?.requestDomains);
    }
    return false;
};

/******************************************************************************/

function getRulesetDetails() {
    if ( getRulesetDetails.rulesetDetailsPromise !== undefined ) {
        return getRulesetDetails.rulesetDetailsPromise;
    }
    getRulesetDetails.rulesetDetailsPromise =
        fetchJSON('/rulesets/ruleset-details').then(entries => {
            const defaultRulesetIds = getDefaultRulesetIdsFromRuleResources(
                runtime.getManifest()?.declarative_net_request?.rule_resources
            );
            const normalizedEntries = applyDefaultRulesetFlagsToDetails(
                entries,
                defaultRulesetIds
            );
            const rulesMap = new Map(normalizedEntries.map(entry => [ entry.id, entry ]));
            return rulesMap;
        });
    return getRulesetDetails.rulesetDetailsPromise;
}

/******************************************************************************/

async function pruneInvalidRegexRules(realm, rulesIn, rejected = []) {
    const validateRegex = regex => {
        return dnr.isRegexSupported({ regex, isCaseSensitive: false }).then(result => {
            pruneInvalidRegexRules.validated.set(regex, result?.reason || true);
            if ( result.isSupported ) { return true; }
            rejected.push({ regex, reason: result?.reason });
            return false;
        });
    };

    // Validate regex-based rules
    const toCheck = [];
    for ( const rule of rulesIn ) {
        if ( rule.condition?.regexFilter === undefined ) {
            toCheck.push(true);
            continue;
        }
        const { regexFilter } = rule.condition;
        const reason = pruneInvalidRegexRules.validated.get(regexFilter);
        if ( reason !== undefined ) {
            toCheck.push(reason === true);
            if ( reason === true  ) { continue; }
            rejected.push({ regex: regexFilter, reason });
            continue;
        }
        toCheck.push(validateRegex(regexFilter));
    }

    // Collate results
    const isValid = await Promise.all(toCheck);

    if ( rejected.length !== 0 ) {
        ubolLog(`${realm} realm: rejected regexes:\n`,
            rejected.map(e => `${e.regex} → ${e.reason}`).join('\n')
        );
    }

    return rulesIn.filter((v, i) => isValid[i]);
}
pruneInvalidRegexRules.validated = new Map();

/******************************************************************************/

async function updateRegexRules(currentRules, addRules, removeRuleIds) {
    // Remove existing regex-related block rules
    for ( const rule of currentRules ) {
        if ( rule.id === 0 ) { continue; }
        if ( rule.id >= SPECIAL_RULES_REALM ) { continue; }
        if ( rule.condition.regexFilter === undefined ) { continue; }
        removeRuleIds.push(rule.id);
    }

    const rulesetDetails = await getEnabledRulesetsDetails();

    // Fetch regexes for all enabled rulesets
    const toFetch = [];
    for ( const details of rulesetDetails ) {
        if ( details.rules.regex === 0 ) { continue; }
        toFetch.push(fetchJSON(`/rulesets/regex/${details.id}`));
    }
    const regexRulesets = await Promise.all(toFetch);

    // Collate all regexes rules
    const allRules = [];
    for ( const rules of regexRulesets ) {
        if ( Array.isArray(rules) === false ) { continue; }
        for ( const rule of rules ) {
            allRules.push(rule);
        }
    }
    if ( allRules.length === 0 ) { return; }

    const validRules = await pruneInvalidRegexRules('regexes', allRules);
    if ( validRules.length === 0 ) { return; }

    ubolLog(`Add ${validRules.length} DNR regex rules`);
    addRules.push(...validRules);
}

/******************************************************************************/

async function updateDynamicRules() {
    const currentRules = await dnr.getDynamicRules();
    const addRules = [];
    const removeRuleIds = [];

    // Remove potentially left-over rules from previous version
    for ( const rule of currentRules ) {
        if ( rule.id >= SPECIAL_RULES_REALM ) { continue; }
        removeRuleIds.push(rule.id);
        rule.id = 0;
    }

    await updateRegexRules(currentRules, addRules, removeRuleIds);
    if ( addRules.length === 0 && removeRuleIds.length === 0 ) { return; }

    let ruleId = 1;
    for ( const rule of addRules ) {
        rule.id = ruleId++;
    }

    const safeAddRules = toSafeDynamicRules(addRules);
    const response = {};

    try {
        await dnr.updateDynamicRules({
            addRules: safeAddRules,
            removeRuleIds,
        });
        logDynamicRegexUsage(await getDynamicRegexRuleCount());
        if ( removeRuleIds.length !== 0 ) {
            ubolLog(`Remove ${removeRuleIds.length} dynamic DNR rules`);
        }
        if ( safeAddRules.length !== 0 ) {
            ubolLog(`Add ${safeAddRules.length} dynamic DNR rules`);
        }
    } catch(reason) {
        ubolErr(`updateDynamicRules/${reason}`);
        response.error = `${reason}`;
    }

    const result = await updateSessionRules();
    if ( result?.error ) {
        response.error ||= result.error;
    }

    return response;
}

/******************************************************************************/

async function updateTalonSiteFixRuntimeRules() {
    const [ currentRules, enabledRulesets ] = await Promise.all([
        dnr.getDynamicRules(),
        dnr.getEnabledRulesets(),
    ]);
    const currentRuntimeRules = [];
    const removeRuleIds = [];
    for ( const rule of currentRules ) {
        if ( isTalonSiteFixRuntimeRuleId(rule.id) === false ) { continue; }
        currentRuntimeRules.push(rule);
        removeRuleIds.push(rule.id);
    }

    if ( enabledRulesets.includes(TALON_SITE_FIXES_RULESET_ID) === false ) {
        if ( removeRuleIds.length === 0 ) {
            return { added: 0, removed: 0 };
        }
        try {
            await dnr.updateDynamicRules({ removeRuleIds });
            ubolLog(`Remove ${removeRuleIds.length} Talon site-fix runtime DNR rules`);
            return { added: 0, removed: removeRuleIds.length };
        } catch(reason) {
            ubolErr(`updateTalonSiteFixRuntimeRules/remove/${reason}`);
            return { error: `${reason}` };
        }
    }

    const rules = await fetchJSON(`/rulesets/main/${TALON_SITE_FIXES_RULESET_ID}`)
        .catch(reason => {
            ubolErr(`updateTalonSiteFixRuntimeRules/fetch/${reason}`);
            return undefined;
        });
    if ( Array.isArray(rules) === false ) {
        return { error: 'invalid_talon_site_fixes_rules' };
    }

    const addRules = [];
    let nextRuleId = TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID;
    const maxRuleId =
        TALON_SITE_FIXES_RUNTIME_BASE_RULE_ID + TALON_SITE_FIXES_RUNTIME_RULES_RANGE;
    for ( const rule of rules ) {
        if ( nextRuleId >= maxRuleId ) { break; }
        if ( rule instanceof Object === false ) { continue; }
        if ( rule.action?.type !== 'block' ) { continue; }
        if ( rule.condition instanceof Object === false ) { continue; }
        const copy = JSON.parse(JSON.stringify(rule));
        copy.id = nextRuleId++;
        copy.priority = Math.max(Number(copy.priority) || 1, TALON_SITE_FIXES_RUNTIME_PRIORITY);
        addRules.push(copy);
    }

    if ( areSameRules(currentRuntimeRules, addRules) ) {
        return { added: 0, removed: 0 };
    }

    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        return { added: 0, removed: 0 };
    }

    try {
        await dnr.updateDynamicRules({ removeRuleIds, addRules });
        if ( removeRuleIds.length !== 0 ) {
            ubolLog(`Remove ${removeRuleIds.length} Talon site-fix runtime DNR rules`);
        }
        if ( addRules.length !== 0 ) {
            ubolLog(`Add ${addRules.length} Talon site-fix runtime DNR rules`);
        }
        return { added: addRules.length, removed: removeRuleIds.length };
    } catch(reason) {
        ubolErr(`updateTalonSiteFixRuntimeRules/${reason}`);
        return { error: `${reason}` };
    }
}

async function repairDnrReconciliationNow({ force = false } = {}) {
    const dirty = await readLocalStrict(DNR_RECONCILIATION_DIRTY_KEY);
    const isDirty = dirty !== undefined && dirty !== false;
    if ( force !== true && isDirty === false ) {
        return { skipped: 'clean' };
    }
    const staticResult = await reconcileStaticRulesetsToDurableIntent();
    if ( staticResult?.error ) { return staticResult; }
    const [ dynamicResult, siteFixResult ] = await Promise.all([
        updateDynamicRules(),
        updateTalonSiteFixRuntimeRules(),
    ]);
    const error = dynamicResult?.error || siteFixResult?.error;
    if ( error ) { return { error }; }
    await localRemove(DNR_RECONCILIATION_DIRTY_KEY);
    return { repaired: true };
}

async function reconcileStaticRulesetsToDurableIntent() {
    try {
        const [ beforeIds, adminIds, rulesetDetails ] = await Promise.all([
            dnr.getEnabledRulesets().then(ids => new Set(ids)),
            getAdminRulesets(),
            getRulesetDetails(),
        ]);
        const desiredIds = new Set(
            Array.isArray(rulesetConfig.enabledRulesets)
                ? rulesetConfig.enabledRulesets
                : []
        );
        for ( const token of adminIds ) {
            const op = token.charAt(0);
            const id = token.slice(1);
            if ( op === '+' ) { desiredIds.add(id); }
            if ( op === '-' ) { desiredIds.delete(id); }
        }
        for ( const id of Array.from(desiredIds) ) {
            if ( rulesetDetails.has(id) === false ) { desiredIds.delete(id); }
        }
        const enableRulesetIds = Array.from(desiredIds).filter(
            id => beforeIds.has(id) === false
        );
        const disableRulesetIds = Array.from(beforeIds).filter(
            id => desiredIds.has(id) === false && rulesetDetails.has(id)
        );
        if ( enableRulesetIds.length === 0 && disableRulesetIds.length === 0 ) {
            return { changed: false };
        }
        await dnr.updateEnabledRulesets({
            enableRulesetIds,
            disableRulesetIds,
        });
        return { changed: true };
    } catch (reason) {
        ubolErr(`reconcileStaticRulesetsToDurableIntent/${reason}`);
        return { error: `${reason}` };
    }
}

function repairDnrReconciliation(options) {
    const run = enableRulesetsTail
        .catch(reason => {
            ubolErr(`repairDnrReconciliation/previous/${reason}`);
        })
        .then(() => repairDnrReconciliationNow(options));
    enableRulesetsTail = run.catch(() => {});
    return run;
}

/******************************************************************************/

async function getEffectiveDynamicRules() {
    const allRules = await dnr.getDynamicRules();
    const dynamicRules = [];
    for ( const rule of allRules ) {
        if ( rule.id >= USER_RULES_BASE_RULE_ID ) { continue; }
        dynamicRules.push(rule);
    }
    return dynamicRules;
}

/******************************************************************************/

async function getActiveCommunityRules() {
    const allRules = await dnr.getDynamicRules();
    return allRules.filter(rule => (
        rule.id >= COMMUNITY_RULES_BASE_RULE_ID &&
        rule.id < COMMUNITY_RULES_BASE_RULE_ID + COMMUNITY_RULES_RANGE
    ));
}

/******************************************************************************/

async function updateStrictBlockRules(currentRules, addRules, removeRuleIds) {
    // Remove existing strictblock-related rules
    for ( const rule of currentRules ) {
        if ( isStrictBlockRule(rule) === false ) { continue; }
        removeRuleIds.push(rule.id);
    }

    if ( getEffectiveStrictBlockMode() === false ) { return; }

    // Safari does not currently support this strict-block DNR path reliably.
    // https://bugs.webkit.org/show_bug.cgi?id=298199
    // https://developer.apple.com/forums/thread/756214
    if ( webextFlavor === 'safari' ) { return; }

    const [
        hasOmnipotence,
        rulesetDetails,
        permanentlyExcluded = [],
        temporarilyExcluded = [],
    ] = await Promise.all([
        hasBroadHostPermissions(),
        getEnabledRulesetsDetails(),
        readLocalStrict('excludedStrictBlockHostnames'),
        readSessionStrict('excludedStrictBlockHostnames'),
    ]);

    // Strict-block rules can only be enforced with omnipotence
    if ( hasOmnipotence === false ) {
        // These exclusions must not reappear if broad permission is restored.
        // Keep the session-rule transaction open until both durable stores
        // confirm cleanup so a worker eviction or write failure is retryable.
        await Promise.all([
            localRemove('excludedStrictBlockHostnames'),
            sessionRemove('excludedStrictBlockHostnames'),
        ]);
        return;
    }

    // Fetch strick-block rules
    const toFetch = [];
    for ( const details of rulesetDetails ) {
        if ( details.rules.strictblock === 0 ) { continue; }
        toFetch.push(fetchJSON(`/rulesets/strictblock/${details.id}`));
    }
    const rulesets = await Promise.all(toFetch);

    const substitution = `${runtime.getURL('/strictblock.html')}#\\0`;
    const allRules = [];
    for ( const rules of rulesets ) {
        if ( Array.isArray(rules) === false ) { continue; }
        for ( const rule of rules ) {
            rule.action.redirect.regexSubstitution = substitution;
            allRules.push(rule);
        }
    }

    const validRules = await pruneInvalidRegexRules('strictblock', allRules);
    if ( validRules.length === 0 ) { return; }
    ubolLog(`Add ${validRules.length} DNR strictblock rules`);
    for ( const rule of validRules ) {
        rule.priority = STRICTBLOCK_PRIORITY;
        addRules.push(rule);
    }

    const allExcluded = permanentlyExcluded.concat(temporarilyExcluded);
    if ( allExcluded.length === 0 ) { return; }
    addRules.unshift({
        action: { type: 'allow' },
        condition: {
            requestDomains: allExcluded,
            resourceTypes: [ 'main_frame' ],
        },
        priority: STRICTBLOCK_PRIORITY,
    });
    ubolLog(`Add 1 DNR session rule with ${allExcluded.length} for excluded strict-block domains`);
}

async function excludeFromStrictBlock(hostname, permanent) {
    if ( typeof hostname !== 'string' || hostname === '' ) { return; }
    const readFn = permanent ? readLocalStrict : readSessionStrict;
    const hostnames = new Set(await readFn('excludedStrictBlockHostnames'));
    hostnames.add(hostname);
    const writeFn = permanent ? localWrite : sessionWrite;
    await writeFn('excludedStrictBlockHostnames', Array.from(hostnames));
    return updateSessionRules();
}

async function setStrictBlockMode(state, force = false) {
    if ( isStrictBlockModeManaged() ) {
        return getEffectiveStrictBlockMode();
    }
    const newState = Boolean(state);
    if ( force === false ) {
        if ( newState === rulesetConfig.strictBlockMode ) {
            return getEffectiveStrictBlockMode();
        }
    }
    rulesetConfig.strictBlockMode = newState;
    const promises = [ saveRulesetConfig() ];
    if ( newState === false ) {
        promises.push(
            localRemove('excludedStrictBlockHostnames'),
            sessionRemove('excludedStrictBlockHostnames')
        );
    }
    await Promise.all(promises);
    await updateSessionRules();
    return getEffectiveStrictBlockMode();
}

/******************************************************************************/

async function updateSessionRules() {
    const addRulesUnfiltered = [];
    const removeRuleIds = [];
    const [
        currentRules,
        currentDynamicRules,
    ] = await Promise.all([
        dnr.getSessionRules(),
        dnr.getDynamicRules(),
    ]);
    await updateStrictBlockRules(currentRules, addRulesUnfiltered, removeRuleIds);
    if ( addRulesUnfiltered.length === 0 && removeRuleIds.length === 0 ) { return; }
    const maxRegexRules = Number(dnr.MAX_NUMBER_OF_REGEX_RULES);
    const maxRegexCount = Number.isFinite(maxRegexRules) && maxRegexRules > 0
        ? maxRegexRules * 0.80
        : Number.POSITIVE_INFINITY;
    const dynamicRegexCount = countRegexRules(currentDynamicRules);
    let regexCount = dynamicRegexCount;
    const removeRuleIdSet = new Set(removeRuleIds);
    const reservedRuleIds = new Set();
    for ( const rule of currentRules ) {
        if ( removeRuleIdSet.has(rule.id) ) { continue; }
        reservedRuleIds.add(rule.id);
    }
    let ruleId = 1;
    const addRules = [];
    let rejectedRuleCount = 0;
    for ( const rule of addRulesUnfiltered ) {
        const isRegex = rule?.condition?.regexFilter !== undefined;
        if ( isRegex && regexCount + 1 >= maxRegexCount ) {
            rejectedRuleCount += 1;
            continue;
        }
        if ( isRegex ) { regexCount += 1; }
        while ( reservedRuleIds.has(ruleId) ) {
            ruleId += 1;
        }
        rule.id = ruleId++;
        addRules.push(rule);
    }
    const sessionRegexCount = regexCount - dynamicRegexCount;
    if ( rejectedRuleCount !== 0 ) {
        ubolLog(`Too many regex-based filters, ${rejectedRuleCount} session rules dropped`);
    }
    if ( sessionRegexCount !== 0 ) {
        ubolLog(`Using ${sessionRegexCount}/${dnr.MAX_NUMBER_OF_REGEX_RULES} session regex-based DNR rules`);
    }
    const response = {};
    try {
        await dnr.updateSessionRules({ addRules, removeRuleIds });
        if ( removeRuleIds.length !== 0 ) {
            ubolLog(`Remove ${removeRuleIds.length} session DNR rules`);
        }
        if ( addRules.length !== 0 ) {
            ubolLog(`Add ${addRules.length} session DNR rules`);
        }
    } catch(reason) {
        ubolErr(`updateSessionRules/${reason}`);
        response.error = `${reason}`;
    }
    return response;
}

/******************************************************************************/

async function getEffectiveSessionRules() {
    const allRules = await dnr.getSessionRules();
    const sessionRules = [];
    for ( const rule of allRules ) {
        if ( rule.id >= USER_RULES_BASE_RULE_ID ) { continue; }
        sessionRules.push(rule);
    }
    return sessionRules;
}

/******************************************************************************/

async function filteringModesToDNR(modes) {
    const noneHostnames = new Set([ ...modes.none ]);
    const notNoneHostnames = new Set([ ...modes.basic, ...modes.optimal, ...modes.complete ]);
    for ( const domain of INTERNAL_UNFILTERED_DOMAINS ) {
        noneHostnames.add(domain);
    }
    for ( const hostname of Array.from(notNoneHostnames) ) {
        if ( isInternalUnfilteredHostname(hostname) === false ) { continue; }
        notNoneHostnames.delete(hostname);
    }
    const requestDomains = [];
    const excludedRequestDomains = [];
    const allowEverywhere = noneHostnames.has('all-urls');
    if ( allowEverywhere ) {
        excludedRequestDomains.push(...notNoneHostnames);
    } else {
        requestDomains.push(...noneHostnames);
    }
    const noneCount = allowEverywhere
        ? notNoneHostnames.size
        : noneHostnames.size;
    return dnr.setAllowAllRules(
        TRUSTED_DIRECTIVE_BASE_RULE_ID,
        requestDomains.sort(),
        excludedRequestDomains.sort(),
        allowEverywhere,
        TRUSTED_DIRECTIVE_PRIORITY
    ).then(modified => {
        if ( modified === false ) { return; }
        ubolLog(`${allowEverywhere ? 'Enabled' : 'Disabled'} DNR filtering for ${noneCount} sites`);
    });
}

/******************************************************************************/

export async function getDefaultRulesetsFromEnv() {
    const rulesets = await getStaticRulesets();
    return getDefaultRulesetIdsFromRuleResources(rulesets);
}

/******************************************************************************/

async function patchDefaultRulesets() {
    const [
        oldDefaultIds = [],
        newDefaultIds,
    ] = await Promise.all([
        readLocalStrict('defaultRulesetIds'),
        getDefaultRulesetsFromEnv(),
    ]);
    const patched = reconcileDefaultRulesetPatch({
        currentEnabledRulesets: rulesetConfig.enabledRulesets,
        storedDefaultRulesetIds: oldDefaultIds,
        nextDefaultRulesetIds: newDefaultIds,
        rulesetSelectionVersion: rulesetConfig.rulesetSelectionVersion,
    });
    await localWrite('defaultRulesetIds', newDefaultIds);
    rulesetConfig.rulesetSelectionVersion = patched.rulesetSelectionVersion;
    if ( patched.changed ) {
        const logLabel = patched.resetToDefaults
            ? 'Reset rulesets to install defaults'
            : 'Patched rulesets';
        ubolLog(`${logLabel}: ${rulesetConfig.enabledRulesets} => ${patched.patchedEnabledRulesets}`);
        rulesetConfig.enabledRulesets = patched.patchedEnabledRulesets;
    }
    return patched.changed || patched.storageChanged;
}

/******************************************************************************/

async function enableRulesetsNow(ids) {
    const afterIds = new Set(ids);
    const [
        beforeIds,
        adminIds,
        rulesetDetails,
    ] = await Promise.all([
        dnr.getEnabledRulesets().then(ids => new Set(ids)),
        getAdminRulesets(),
        getRulesetDetails(),
    ]);

    for ( const token of adminIds ) {
        const c0 = token.charAt(0);
        const id = token.slice(1);
        if ( c0 === '+' ) {
            afterIds.add(id);
        } else if ( c0 === '-' ) {
            afterIds.delete(id);
        }
    }

    const enableRulesetSet = new Set();
    const disableRulesetSet = new Set();
    for ( const id of afterIds ) {
        if ( beforeIds.has(id) ) { continue; }
        enableRulesetSet.add(id);
    }
    for ( const id of beforeIds ) {
        if ( afterIds.has(id) ) { continue; }
        disableRulesetSet.add(id);
    }

    // Be sure the rulesets to enable/disable do exist in the current version,
    // otherwise the API throws.
    for ( const id of enableRulesetSet ) {
        if ( rulesetDetails.has(id) ) { continue; }
        enableRulesetSet.delete(id);
    }
    for ( const id of disableRulesetSet ) {
        if ( rulesetDetails.has(id) ) { continue; }
        disableRulesetSet.delete(id);
    }

    if ( enableRulesetSet.size === 0 && disableRulesetSet.size === 0 ) {
        const repairResult = await repairDnrReconciliationNow();
        if ( repairResult?.error ) {
            return {
                error: repairResult.error,
                enabledRulesets: Array.from(beforeIds),
                staticUpdateSucceeded: true,
                dynamicUpdateSucceeded: false,
            };
        }
        return;
    }

    const enableRulesetIds = Array.from(enableRulesetSet);
    const disableRulesetIds = Array.from(disableRulesetSet);

    if ( enableRulesetIds.length !== 0 ) {
        ubolLog(`Enable rulesets: ${enableRulesetIds}`);
    }
    if ( disableRulesetIds.length !== 0 ) {
        ubolLog(`Disable ruleset: ${disableRulesetIds}`);
    }

    const response = {};

    const availableStaticRuleCount =
        typeof dnr.getAvailableStaticRuleCount === 'function'
            ? await dnr.getAvailableStaticRuleCount().catch(reason => {
                ubolErr(`getAvailableStaticRuleCount/${reason}`);
                return null;
            })
            : null;
    if ( availableStaticRuleCount !== null ) {
        const quotaPlan = planStaticRulesetQuotaChange({
            beforeIds,
            enableRulesetIds,
            disableRulesetIds,
            rulesetDetails,
            availableStaticRuleCount,
            maxEnabledStaticRulesets: dnr.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
        });
        response.staticRuleCount = availableStaticRuleCount;
        response.staticRuleQuota = quotaPlan;
        if ( quotaPlan.ok === false ) {
            response.error = quotaPlan.error;
            response.enabledRulesets = Array.from(beforeIds);
            ubolErr(`updateEnabledRulesets/preflight/${quotaPlan.error}`);
            return response;
        }
    }

    await localWrite(DNR_RECONCILIATION_DIRTY_KEY, true);
    try {
        await dnr.updateEnabledRulesets({
            enableRulesetIds,
            disableRulesetIds,
        });
        response.staticUpdateSucceeded = true;
    } catch (reason) {
        ubolErr(`updateEnabledRulesets/${reason}`);
        response.error = `${reason}`;
        response.staticUpdateSucceeded = false;
    }

    if ( response.staticUpdateSucceeded ) {
        const [ dynamicResult, siteFixResult ] = await Promise.all([
            updateDynamicRules(),
            updateTalonSiteFixRuntimeRules(),
        ]);
        if ( dynamicResult?.error ) {
            response.error ||= dynamicResult.error;
        }
        if ( siteFixResult?.error ) {
            response.error ||= siteFixResult.error;
        }
        response.dynamicUpdateSucceeded = dynamicResult?.error === undefined &&
            siteFixResult?.error === undefined;
        // The caller persists user intent after this API succeeds. Keep the
        // transaction dirty until a subsequent repair verifies static,
        // dynamic, and site-fix state against that durable config.
    }

    await dnr.getEnabledRulesets().then(enabledRulesets => {
        ubolLog(`Enabled rulesets: ${enabledRulesets}`);
        response.enabledRulesets = enabledRulesets;
        return dnr.getAvailableStaticRuleCount();
    }).then(count => {
        ubolLog(`Available static rule count: ${count}`);
        response.staticRuleCount = count;
    }).catch(reason => {
        ubolErr(`getEnabledRulesets/${reason}`);
    });

    return response;
}

function enableRulesets(ids) {
    const requestedIds = Array.isArray(ids) ? ids.slice() : [];
    const run = enableRulesetsTail
        .catch(reason => {
            ubolErr(`enableRulesets/previous/${reason}`);
        })
        .then(() => enableRulesetsNow(requestedIds));
    enableRulesetsTail = run.catch(() => {});
    return run;
}

/******************************************************************************/

async function getStaticRulesets() {
    const manifest = runtime.getManifest();
    return manifest.declarative_net_request.rule_resources;
}

/******************************************************************************/

async function getEnabledRulesetsDetails() {
    const [
        ids,
        rulesetDetails,
    ] = await Promise.all([
        dnr.getEnabledRulesets(),
        getRulesetDetails(),
    ]);
    const out = [];
    for ( const id of ids ) {
        const ruleset = rulesetDetails.get(id);
        if ( ruleset === undefined ) { continue; }
        out.push(ruleset);
    }
    return out;
}

/******************************************************************************/

async function getEffectiveUserRules() {
    const allRules = await dnr.getDynamicRules();
    const userRules = [];
    for ( const rule of allRules ) {
        if ( rule.id < USER_RULES_BASE_RULE_ID ) { continue; }
        userRules.push(rule);
    }
    return userRules;
}

async function updateUserRules() {
    const [
        allDynamicRules,
        userRulesText = '',
        sandboxRules,
    ] = await Promise.all([
        dnr.getDynamicRules(),
        readLocalStrict('userDnrRules'),
        readLocalStrict('sandboxFilters.dnrRules'),
    ]);
    const userRules = [];
    const nonUserRules = [];
    for ( const rule of allDynamicRules ) {
        if ( rule.id >= USER_RULES_BASE_RULE_ID ) {
            userRules.push(rule);
            continue;
        }
        nonUserRules.push(rule);
    }

    const effectiveRulesText = rulesetConfig.developerMode
        ? userRulesText
        : '';

    const parsed = rulesFromText(effectiveRulesText);
    const { rules } = parsed;
    if ( Array.isArray(sandboxRules) ) {
        sandboxRules.forEach(rule => rules.push(rule));
    }
    const rejectedRegexes = [];
    let addRules = await pruneInvalidRegexRules('user', rules, rejectedRegexes);
    const out = { added: 0, removed: 0, errors: [], applyFailed: false };
    const beforeUserRegexCount = countRegexRules(userRules);

    if ( rejectedRegexes.length !== 0 ) {
        rejectedRegexes.forEach(e =>
            out.errors.push(`regexFilter: ${e.regex} → ${e.reason}`)
        );
    }

    const maxDynamic = dnr.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
    const availableDynamic = Math.max(0, maxDynamic - nonUserRules.length);
    if ( addRules.length > availableDynamic ) {
        const dropped = addRules.length - availableDynamic;
        addRules = addRules.slice(0, availableDynamic);
        out.errors.push(
            `Chrome dynamic-rule limit reached: dropped ${dropped} user rule(s). ` +
            'Move critical rules earlier to prioritize them.'
        );
    }

    const maxRegexRules = dnr.MAX_NUMBER_OF_REGEX_RULES || 0;
    if ( maxRegexRules > 0 ) {
        const maxRegexDynamic = Math.floor(maxRegexRules * 0.80) || maxRegexRules;
        const nonUserRegexCount = nonUserRules.filter(
            rule => rule?.condition?.regexFilter !== undefined
        ).length;
        let availableRegex = maxRegexDynamic - nonUserRegexCount;
        if ( availableRegex < 0 ) { availableRegex = 0; }
        const filtered = [];
        let droppedRegexQuota = 0;
        for ( const rule of addRules ) {
            if ( rule?.condition?.regexFilter === undefined ) {
                filtered.push(rule);
                continue;
            }
            if ( availableRegex === 0 ) {
                droppedRegexQuota += 1;
                continue;
            }
            availableRegex -= 1;
            filtered.push(rule);
        }
        addRules = filtered;
        if ( droppedRegexQuota !== 0 ) {
            out.errors.push(
                `Chrome regex-rule limit reached: dropped ${droppedRegexQuota} user regex rule(s). ` +
                'Move critical regex rules earlier to prioritize them.'
            );
        }
    }

    const removeRuleIds = [ ...userRules.map(a => a.id) ];
    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        await localRemove('userDnrRuleCount');
        return out;
    }

    let ruleId = 0;
    for ( const rule of addRules ) {
        rule.id = USER_RULES_BASE_RULE_ID + ruleId++;
        rule.priority = (rule.priority || 1) + USER_RULES_PRIORITY;
    }

    try {
        // Chrome applies a single updateDynamicRules request atomically. Keep
        // the last-known-good user rules installed when any replacement rule
        // is rejected instead of removing them in a successful first call and
        // failing during a separate add call.
        await dnr.updateDynamicRules({ removeRuleIds, addRules });
        if ( removeRuleIds.length !== 0 ) {
            ubolLog(`updateUserRules() / Removed ${removeRuleIds.length} dynamic DNR rules`);
        }
        if ( addRules.length !== 0 ) {
            ubolLog(`updateUserRules() / Added ${addRules.length} DNR rules`);
        }
        out.added = addRules.length;
        out.removed = removeRuleIds.length;
    } catch(reason) {
        ubolErr(`updateUserRules/${reason}`);
        out.applyFailed = true;
        out.errors.push(`${reason}`);
    } finally {
        const effectiveUserRules = await getEffectiveUserRules();
        if ( effectiveUserRules.length === 0 ) {
            await localRemove('userDnrRuleCount');
        } else {
            await localWrite('userDnrRuleCount', effectiveUserRules.length);
        }
        if ( beforeUserRegexCount !== countRegexRules(effectiveUserRules) ) {
            const sessionResult = await updateSessionRules();
            if ( sessionResult?.error ) {
                out.applyFailed = true;
                out.errors.push(`session rules: ${sessionResult.error}`);
            }
        }
    }
    return out;
}

/******************************************************************************/

async function updateCommunityRules(rulesIn = [], bundleMeta = {}) {
    const currentRules = await dnr.getDynamicRules();
    const removeRuleIds = [];
    let removedCommunityRegexCount = 0;
    for ( const rule of currentRules ) {
        if ( rule.id < COMMUNITY_RULES_BASE_RULE_ID ) { continue; }
        if ( rule.id >= COMMUNITY_RULES_BASE_RULE_ID + COMMUNITY_RULES_RANGE ) { continue; }
        removeRuleIds.push(rule.id);
        if ( rule.condition?.regexFilter !== undefined ) {
            removedCommunityRegexCount += 1;
        }
    }

    const schemaVersion = normalizeCommunityRuleSchemaVersion(bundleMeta?.schemaVersion) ||
        COMMUNITY_RULE_SCHEMA_VERSION_LEGACY;
    const sanitized = sanitizeCommunityRules(rulesIn, { schemaVersion });
    const safeRules = prioritizeCommunityRulesForQuota(sanitized.rules);
    const dropped = Object.assign(
        sanitized.dropped,
        { regexUnsupported: sanitized.dropped.regexUnsupported || 0 }
    );

    const regexRules = [];
    for ( const rule of safeRules ) {
        if ( rule instanceof Object === false ) { continue; }
        if ( rule.condition?.regexFilter !== undefined ) {
            regexRules.push(rule);
            continue;
        }
    }

    const rejectedRegexes = [];
    let validRegexRules = [];
    if ( regexRules.length !== 0 ) {
        validRegexRules = await pruneInvalidRegexRules(
            'community-regex',
            regexRules,
            rejectedRegexes
        );
    }

    const maxRegexDynamic = Math.floor((dnr.MAX_NUMBER_OF_REGEX_RULES || 0) * 0.80) ||
        (dnr.MAX_NUMBER_OF_REGEX_RULES || 0);
    const baseDynamicRules = currentRules.filter(rule => (
        rule.id < COMMUNITY_RULES_BASE_RULE_ID ||
        rule.id >= COMMUNITY_RULES_BASE_RULE_ID + COMMUNITY_RULES_RANGE
    ));
    const baseDynamicRegexCount = countRegexRules(baseDynamicRules);
    let availableRegex = maxRegexDynamic - baseDynamicRegexCount;
    if ( availableRegex < 0 ) { availableRegex = 0; }
    if ( validRegexRules.length > availableRegex ) {
        for ( const droppedRule of validRegexRules.slice(availableRegex) ) {
            recordCommunityQuotaDrop(dropped, droppedRule);
        }
        validRegexRules.length = availableRegex;
    }

    const validRegexSet = new Set(validRegexRules);
    const rejectedRegexCounts = new Map();
    for ( const entry of rejectedRegexes ) {
        const regex = typeof entry?.regex === 'string' ? entry.regex : '';
        if ( regex === '' ) { continue; }
        rejectedRegexCounts.set(regex, (rejectedRegexCounts.get(regex) || 0) + 1);
    }
    let filtered = [];
    for ( const rule of safeRules ) {
        if ( rule instanceof Object === false ) { continue; }
        if ( rule.condition?.regexFilter !== undefined ) {
            if ( validRegexSet.has(rule) ) {
                filtered.push(rule);
            } else {
                const regexFilter = typeof rule.condition.regexFilter === 'string'
                    ? rule.condition.regexFilter
                    : '';
                const rejectedCount = rejectedRegexCounts.get(regexFilter) || 0;
                if ( rejectedCount !== 0 ) {
                    dropped.regexUnsupported += 1;
                    rejectedRegexCounts.set(regexFilter, rejectedCount - 1);
                }
            }
            continue;
        }
        filtered.push(rule);
    }

    const maxDynamic = dnr.MAX_NUMBER_OF_DYNAMIC_RULES || 5000;
    const nonRemoteCount = currentRules.length - removeRuleIds.length;
    let available = maxDynamic - nonRemoteCount - COMMUNITY_RESERVED_HEADROOM;
    if ( available < 0 ) { available = 0; }

    const maxToAdd = Math.min(available, COMMUNITY_RULES_MAX);
    if ( filtered.length > maxToAdd ) {
        for ( const droppedRule of filtered.slice(maxToAdd) ) {
            recordCommunityQuotaDrop(dropped, droppedRule);
        }
        filtered.length = maxToAdd;
    }

    const addRules = [];
    let nextId = COMMUNITY_RULES_BASE_RULE_ID;
    let addedRegexCount = 0;
    const appliedByAction = createEmptyCommunityRuleActionCounts();
    for ( const rule of filtered ) {
        const copy = Object.assign({}, rule);
        copy.id = nextId++;
        if ( typeof copy.action?.type === 'string' && copy.action.type in appliedByAction ) {
            appliedByAction[copy.action.type] += 1;
        }
        if ( copy.condition?.regexFilter !== undefined ) {
            addedRegexCount += 1;
        }
        addRules.push(copy);
    }

    const droppedRegexUnsupported = rejectedRegexes.length;
    const droppedRegex = Math.max(0, regexRules.length - addedRegexCount);
    const droppedRegexQuota = Math.max(0, droppedRegex - droppedRegexUnsupported);
    const droppedUnsafe = (
        dropped.unsafeScope +
        dropped.unsupportedRedirectPath +
        dropped.unsupportedAction
    );
    const droppedQuota = dropped.quota;

    const response = {
        added: addRules.length,
        removed: removeRuleIds.length,
        droppedRegex,
        droppedRegexUnsupported,
        droppedRegexQuota,
        droppedQuota,
        droppedUnsafe,
        version: bundleMeta.version,
        source: bundleMeta.source,
        schemaVersion,
        byAction: appliedByAction,
        dropped,
    };

    if ( removeRuleIds.length === 0 && addRules.length === 0 ) {
        return response;
    }

    try {
        await dnr.updateDynamicRules({ removeRuleIds, addRules });

        const regexChanged = removedCommunityRegexCount !== 0 || addedRegexCount !== 0;
        if ( regexChanged ) {
            await updateSessionRules();
        }

        if ( removeRuleIds.length !== 0 ) {
            ubolLog(`community rules: removed ${removeRuleIds.length}`);
        }
        if ( addRules.length !== 0 ) {
            ubolLog(`community rules: added ${addRules.length}`);
        }
        if ( droppedRegexUnsupported !== 0 ) {
            ubolLog(`community rules: dropped ${droppedRegexUnsupported} unsupported regex rules`);
        }
        if ( droppedRegexQuota !== 0 ) {
            ubolLog(`community rules: dropped ${droppedRegexQuota} regex rules for quota`);
        }
        if ( droppedQuota !== 0 ) {
            ubolLog(`community rules: dropped ${droppedQuota} rules for quota`);
        }
        if ( dropped.unsupportedAction !== 0 ) {
            ubolLog(`community rules: dropped ${dropped.unsupportedAction} unsupported action rules`);
        }
        if ( dropped.unsafeScope !== 0 ) {
            ubolLog(`community rules: dropped ${dropped.unsafeScope} unsafe scope rules`);
        }
        if ( dropped.unsupportedRedirectPath !== 0 ) {
            ubolLog(`community rules: dropped ${dropped.unsupportedRedirectPath} unsupported redirect path rules`);
        }
    } catch(reason) {
        ubolErr(`updateCommunityRules/${reason}`);
        response.error = `${reason}`;
    }

    return response;
}

/******************************************************************************/

export {
    enableRulesets,
    excludeFromStrictBlock,
    filteringModesToDNR,
    getActiveCommunityRules,
    getEffectiveDynamicRules,
    getEffectiveSessionRules,
    getEffectiveUserRules,
    getEnabledRulesetsDetails,
    getRulesetDetails,
    patchDefaultRulesets,
    repairDnrReconciliation,
    setStrictBlockMode,
    updateDynamicRules,
    updateCommunityRules,
    updateTalonSiteFixRuntimeRules,
    updateSessionRules,
    updateUserRules,
};
