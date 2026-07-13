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

export const webext = self.browser || self.chrome;
export const dnr = webext.declarativeNetRequest || {};
export const ALLOW_ALL_RULES_DIAGNOSTICS_KEY = 'allowAllRulesDiagnosticsV1';

const DYNAMIC_RULESET_UPDATE_RETRY_DELAYS_MS = Object.freeze([ 100, 300 ]);

const isTransientDynamicRulesetUpdateError = reason => {
    const message = reason instanceof Error
        ? reason.message
        : `${reason ?? ''}`;
    return message.trim() === 'Internal error while updating dynamic rules.';
};

/**
 * Chrome can reject updateDynamicRules() with this exact generic internal
 * error. A rejected update is atomic and leaves the ruleset unchanged, so a
 * tightly bounded retry of the identical delta is safe. Actionable quota,
 * validation, permission, and rule-ID errors must surface immediately.
 */
export async function retryTransientDynamicRulesUpdate(update, {
    retryDelaysMs = DYNAMIC_RULESET_UPDATE_RETRY_DELAYS_MS,
    wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
} = {}) {
    if ( typeof update !== 'function' ) {
        throw new TypeError('dynamic ruleset update callback is required');
    }
    if ( typeof wait !== 'function' ) {
        throw new TypeError('dynamic ruleset retry wait callback is required');
    }
    const delays = Array.isArray(retryDelaysMs)
        ? retryDelaysMs.filter(value => Number.isFinite(value) && value >= 0)
        : [];
    let attempts = 0;
    for (;;) {
        attempts += 1;
        try {
            await update();
            return { attempts, recovered: attempts > 1 };
        } catch (reason) {
            const retryIndex = attempts - 1;
            if (
                isTransientDynamicRulesetUpdateError(reason) === false ||
                retryIndex >= delays.length
            ) {
                throw reason;
            }
            await wait(delays[retryIndex]);
        }
    }
}

const updateDynamicRulesWithTransientRetry = details => {
    return retryTransientDynamicRulesUpdate(
        () => dnr.updateDynamicRules(details)
    );
};

/******************************************************************************/

const ruleCompare = (a, b) => a.id - b.id;

const cloneRules = rules => Array.isArray(rules)
    ? rules.map(rule => structuredClone(rule))
    : [];

const stableValue = value => {
    if ( Array.isArray(value) ) {
        return value.map(stableValue);
    }
    if ( value instanceof Object ) {
        const out = {};
        for ( const key of Object.keys(value).sort() ) {
            out[key] = stableValue(value[key]);
        }
        return out;
    }
    return value;
};

const stableRulesKey = rules => JSON.stringify(
    cloneRules(rules).sort(ruleCompare).map(stableValue)
);

const isSameRules = (a, b) => {
    return stableRulesKey(a) === stableRulesKey(b);
};

const readLocalDiagnostics = async key => {
    if ( webext.storage?.local?.get === undefined ) { return null; }
    try {
        const bin = await webext.storage.local.get(key);
        return bin?.[key] instanceof Object
            ? bin[key]
            : null;
    } catch {
    }
    return null;
};

const writeLocalDiagnostics = async (key, value) => {
    if ( webext.storage?.local?.set === undefined ) { return; }
    try {
        await webext.storage.local.set({ [key]: value });
    } catch {
    }
};

const writeAllowAllRulesDiagnosticsPatch = async patch => {
    const current = await readLocalDiagnostics(ALLOW_ALL_RULES_DIAGNOSTICS_KEY);
    await writeLocalDiagnostics(ALLOW_ALL_RULES_DIAGNOSTICS_KEY, {
        partialRepairCount: Math.max(
            0,
            Number(current?.partialRepairCount) || 0
        ),
        rollbackCount: Math.max(
            0,
            Number(current?.rollbackCount) || 0
        ),
        lastRepairAt: Number(current?.lastRepairAt) || 0,
        lastRollbackAt: Number(current?.lastRollbackAt) || 0,
        ...patch,
    });
};

const recordAllowAllRulesPartialRepair = async () => {
    const current = await readLocalDiagnostics(ALLOW_ALL_RULES_DIAGNOSTICS_KEY);
    await writeAllowAllRulesDiagnosticsPatch({
        partialRepairCount: Math.max(
            0,
            Number(current?.partialRepairCount) || 0
        ) + 1,
        lastRepairAt: Date.now(),
    });
};

const recordAllowAllRulesRollback = async () => {
    const current = await readLocalDiagnostics(ALLOW_ALL_RULES_DIAGNOSTICS_KEY);
    await writeAllowAllRulesDiagnosticsPatch({
        rollbackCount: Math.max(
            0,
            Number(current?.rollbackCount) || 0
        ) + 1,
        lastRollbackAt: Date.now(),
    });
};

/******************************************************************************/

export function normalizeDNRRules(rules, ruleIds) {
    if ( Array.isArray(rules) === false ) { return rules; }
    return Array.isArray(ruleIds)
        ? rules.filter(rule => ruleIds.includes(rule.id))
        : rules;
}

/******************************************************************************/

dnr.setAllowAllRules = async function(id, allowed, notAllowed, reverse, priority) {
    let beforeDynamicRules;
    let beforeSessionRules;
    try {
        [
            beforeDynamicRules,
            beforeSessionRules,
        ] = await Promise.all([
            dnr.getDynamicRules({ ruleIds: [ id+0 ] }),
            dnr.getSessionRules({ ruleIds: [ id+1 ] }),
        ]);
    } catch (reason) {
        const message = reason instanceof Error
            ? reason.message
            : String(reason);
        throw new Error(
            `setAllowAllRules(${id}) state snapshot failed: ${message}`,
            { cause: reason }
        );
    }
    const addDynamicRules = [];
    const addSessionRules = [];
    if ( reverse || allowed.length || notAllowed.length ) {
        const rule0 = {
            id: id+0,
            action: { type: 'allowAllRequests' },
            condition: {
                resourceTypes: [ 'main_frame' ],
            },
            priority,
        };
        if ( allowed.length ) {
            rule0.condition.requestDomains = allowed.slice();
        } else if ( notAllowed.length ) {
            rule0.condition.excludedRequestDomains = notAllowed.slice();
        }
        addDynamicRules.push(rule0);
        // Keep a paired session rule so allow-all state can be verified and
        // repaired consistently across browser DNR implementations.
        const rule1 = {
            id: id+1,
            action: { type: 'allow' },
            condition: {
                tabIds: [ webext.tabs.TAB_ID_NONE ],
            },
            priority,
        };
        if ( allowed.length ) {
            rule1.condition.initiatorDomains = allowed.slice();
        } else if ( notAllowed.length ) {
            rule1.condition.excludedInitiatorDomains = notAllowed.slice();
        }
        addSessionRules.push(rule1);
    }
    const dynamicMatches = isSameRules(addDynamicRules, beforeDynamicRules);
    const sessionMatches = isSameRules(addSessionRules, beforeSessionRules);
    if ( dynamicMatches && sessionMatches ) { return false; }

    // A rejected DNR update is atomic. Track only calls which actually
    // fulfilled so a later failure never "rolls back" an untouched lane and
    // adds avoidable pressure while Chrome's DNR store is still starting.
    const mutated = {
        dynamic: false,
        session: false,
    };
    let desiredPhase = 'prepare';

    const verifyState = async (expectedDynamicRules, expectedSessionRules) => {
        const [
            actualDynamicRules,
            actualSessionRules,
        ] = await Promise.all([
            dnr.getDynamicRules({ ruleIds: [ id+0 ] }),
            dnr.getSessionRules({ ruleIds: [ id+1 ] }),
        ]);
        return isSameRules(actualDynamicRules, expectedDynamicRules) &&
            isSameRules(actualSessionRules, expectedSessionRules);
    };

    const restorePreviousState = async () => {
        const rollbackOperations = [];
        if ( mutated.dynamic ) {
            const dynamicDelta = {
                addRules: cloneRules(beforeDynamicRules),
                removeRuleIds: [ id+0 ],
            };
            rollbackOperations.push({
                lane: 'dynamic',
                run: () => updateDynamicRulesWithTransientRetry(dynamicDelta),
            });
        }
        if ( mutated.session ) {
            const sessionDelta = {
                addRules: cloneRules(beforeSessionRules),
                removeRuleIds: [ id+1 ],
            };
            rollbackOperations.push({
                lane: 'session',
                run: () => dnr.updateSessionRules(sessionDelta),
            });
        }
        if ( rollbackOperations.length === 0 ) { return false; }
        const settlements = await Promise.allSettled(
            rollbackOperations.map(operation =>
                Promise.resolve().then(operation.run)
            )
        );
        const failures = settlements.flatMap((settlement, index) => {
            if ( settlement.status === 'fulfilled' ) { return []; }
            const message = settlement.reason instanceof Error
                ? settlement.reason.message
                : String(settlement.reason);
            return [ `${rollbackOperations[index].lane}: ${message}` ];
        });
        if ( failures.length !== 0 ) {
            throw new Error(
                `setAllowAllRules(${id}) rollback mutation failed (${rollbackOperations.map(operation => operation.lane).join(',')} mutated): ${failures.join('; ')}`
            );
        }
        let restored;
        try {
            restored = await verifyState(beforeDynamicRules, beforeSessionRules);
        } catch (reason) {
            const message = reason instanceof Error
                ? reason.message
                : String(reason);
            throw new Error(
                `setAllowAllRules(${id}) rollback verification read failed: ${message}`,
                { cause: reason }
            );
        }
        if ( restored !== true ) {
            throw new Error(`setAllowAllRules(${id}) rollback verification failed`);
        }
        await recordAllowAllRulesRollback();
        return true;
    };

    try {
        if ( dynamicMatches === false ) {
            desiredPhase = 'desired dynamic mutation';
            const dynamicDelta = {
                addRules: cloneRules(addDynamicRules),
                removeRuleIds: beforeDynamicRules.map(r => r.id),
            };
            await updateDynamicRulesWithTransientRetry(dynamicDelta);
            mutated.dynamic = true;
        }
        if ( sessionMatches === false ) {
            desiredPhase = 'desired session mutation';
            await dnr.updateSessionRules({
                addRules: cloneRules(addSessionRules),
                removeRuleIds: beforeSessionRules.map(r => r.id),
            });
            mutated.session = true;
        }
        desiredPhase = 'desired-state verification';
        const verified = await verifyState(addDynamicRules, addSessionRules);
        if ( verified !== true ) {
            throw new Error('state mismatch');
        }
        if ( dynamicMatches !== sessionMatches ) {
            await recordAllowAllRulesPartialRepair();
        }
        return true;
    } catch (reason) {
        const originalMessage = reason instanceof Error
            ? reason.message
            : String(reason);
        const contextualMessage =
            `setAllowAllRules(${id}) ${desiredPhase} failed: ${originalMessage}`;
        if ( mutated.dynamic === false && mutated.session === false ) {
            throw new Error(contextualMessage, { cause: reason });
        }
        try {
            await restorePreviousState();
        } catch (rollbackReason) {
            const rollbackMessage = rollbackReason instanceof Error
                ? rollbackReason.message
                : String(rollbackReason);
            throw new Error(
                `setAllowAllRules(${id}) rollback failed: ${rollbackMessage}; original error: ${contextualMessage}`,
                { cause: reason }
            );
        }
        throw new Error(
            `setAllowAllRules(${id}) desired state failed and was rolled back: ${contextualMessage}`,
            { cause: reason }
        );
    }
};
