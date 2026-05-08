const normalizeRulesetId = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    return normalized === '' ? '' : normalized;
};

export const RULESET_SELECTION_STATE_VERSION = 1;

const uniqueRulesetIds = values => {
    const out = [];
    const seen = new Set();
    for ( const value of values || [] ) {
        const id = normalizeRulesetId(value);
        if ( id === '' || seen.has(id) ) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
};

export function getDefaultRulesetIdsFromRuleResources(ruleResources) {
    if ( Array.isArray(ruleResources) === false ) { return []; }
    const out = [];
    const seen = new Set();
    for ( const entry of ruleResources ) {
        const id = normalizeRulesetId(entry?.id);
        if ( id === '' || seen.has(id) ) { continue; }
        if ( entry?.enabled !== true ) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function applyDefaultRulesetFlagsToDetails(details, defaultRulesetIds) {
    const defaultSet = new Set(uniqueRulesetIds(defaultRulesetIds));
    if ( Array.isArray(details) === false ) { return []; }
    return details.map(entry => {
        if ( entry instanceof Object === false ) { return entry; }
        const id = normalizeRulesetId(entry.id);
        if ( id === '' ) { return entry; }
        const enabled = defaultSet.has(id);
        if ( entry.enabled === enabled ) { return entry; }
        return { ...entry, enabled };
    });
}

export function reconcileDefaultRulesetPatch({
    currentEnabledRulesets = [],
    storedDefaultRulesetIds = [],
    nextDefaultRulesetIds = [],
    rulesetSelectionVersion = RULESET_SELECTION_STATE_VERSION,
} = {}) {
    const current = uniqueRulesetIds(currentEnabledRulesets);
    const stored = uniqueRulesetIds(storedDefaultRulesetIds);
    const next = uniqueRulesetIds(nextDefaultRulesetIds);
    const currentSet = new Set(current);

    if ( rulesetSelectionVersion !== RULESET_SELECTION_STATE_VERSION ) {
        const nextSet = new Set(next);
        const changed =
            current.length !== next.length ||
            next.some(id => currentSet.has(id) === false);
        return {
            storedDefaultRulesetIds: stored,
            nextDefaultRulesetIds: next,
            addedDefaultRulesets: next.filter(id => currentSet.has(id) === false),
            removedDefaultRulesets: current.filter(id => nextSet.has(id) === false),
            patchedEnabledRulesets: next,
            changed,
            resetToDefaults: true,
            storageChanged: true,
            rulesetSelectionVersion: RULESET_SELECTION_STATE_VERSION,
        };
    }

    const storedSet = new Set(stored);
    const nextSet = new Set(next);
    const isStillDefaultSelection =
        stored.length !== 0 &&
        current.length === stored.length &&
        stored.every(id => currentSet.has(id));

    const toAdd = isStillDefaultSelection
        ? next.filter(id => storedSet.has(id) === false)
        : [];
    const toRemove = stored.filter(id => nextSet.has(id) === false);

    const patched = new Set(current);
    toAdd.forEach(id => patched.add(id));
    toRemove.forEach(id => patched.delete(id));

    const patchedEnabledRulesets = Array.from(patched);
    const changed =
        current.length !== patchedEnabledRulesets.length ||
        patchedEnabledRulesets.some(id => currentSet.has(id) === false);

    return {
        storedDefaultRulesetIds: stored,
        nextDefaultRulesetIds: next,
        addedDefaultRulesets: toAdd,
        removedDefaultRulesets: toRemove,
        patchedEnabledRulesets,
        changed,
        resetToDefaults: false,
        storageChanged: false,
        rulesetSelectionVersion: RULESET_SELECTION_STATE_VERSION,
    };
}

export const getRulesetStaticRuleCount = details => {
    if ( details instanceof Object === false ) { return 0; }
    const plain = Number(details?.rules?.plain);
    if ( Number.isFinite(plain) && plain > 0 ) { return Math.ceil(plain); }
    const total = Number(details?.rules?.total);
    if ( Number.isFinite(total) && total > 0 ) { return Math.ceil(total); }
    return 0;
};

export const planStaticRulesetQuotaChange = ({
    beforeIds = new Set(),
    enableRulesetIds = [],
    disableRulesetIds = [],
    rulesetDetails = new Map(),
    availableStaticRuleCount,
    maxEnabledStaticRulesets,
} = {}) => {
    const beforeSet = beforeIds instanceof Set
        ? beforeIds
        : new Set(Array.isArray(beforeIds) ? beforeIds : []);
    const enableIds = Array.isArray(enableRulesetIds) ? enableRulesetIds : [];
    const disableIds = Array.isArray(disableRulesetIds) ? disableRulesetIds : [];
    const enabledAfterCount = beforeSet.size - disableIds.length + enableIds.length;
    const enabledLimit = Number(maxEnabledStaticRulesets);
    if (
        Number.isFinite(enabledLimit) &&
        enabledLimit > 0 &&
        enabledAfterCount > enabledLimit
    ) {
        return {
            ok: false,
            error: 'static_ruleset_count_limit',
            enabledAfterCount,
            maxEnabledStaticRulesets: enabledLimit,
        };
    }

    const freedStaticRuleCount = disableIds.reduce((total, id) => (
        total + getRulesetStaticRuleCount(rulesetDetails.get(id))
    ), 0);
    const requiredStaticRuleCount = enableIds.reduce((total, id) => (
        total + getRulesetStaticRuleCount(rulesetDetails.get(id))
    ), 0);
    const available = Number(availableStaticRuleCount);
    const projectedAvailableStaticRuleCount = Number.isFinite(available)
        ? available + freedStaticRuleCount
        : Infinity;
    if ( requiredStaticRuleCount > projectedAvailableStaticRuleCount ) {
        return {
            ok: false,
            error: 'static_ruleset_quota_exceeded',
            requiredStaticRuleCount,
            availableStaticRuleCount: Math.max(0, Number(availableStaticRuleCount) || 0),
            freedStaticRuleCount,
            projectedAvailableStaticRuleCount,
        };
    }

    return {
        ok: true,
        requiredStaticRuleCount,
        availableStaticRuleCount: Number.isFinite(available) ? available : null,
        freedStaticRuleCount,
        projectedAvailableStaticRuleCount,
        enabledAfterCount,
        maxEnabledStaticRulesets: Number.isFinite(enabledLimit) ? enabledLimit : null,
    };
};
