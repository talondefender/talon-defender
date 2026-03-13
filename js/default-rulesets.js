const normalizeRulesetId = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    return normalized === '' ? '' : normalized;
};

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
} = {}) {
    const current = uniqueRulesetIds(currentEnabledRulesets);
    const stored = uniqueRulesetIds(storedDefaultRulesetIds);
    const next = uniqueRulesetIds(nextDefaultRulesetIds);

    const storedSet = new Set(stored);
    const nextSet = new Set(next);

    const toAdd = next.filter(id => storedSet.has(id) === false);
    const toRemove = stored.filter(id => nextSet.has(id) === false);

    const patched = new Set(current);
    toAdd.forEach(id => patched.add(id));
    toRemove.forEach(id => patched.delete(id));

    const patchedEnabledRulesets = Array.from(patched);
    const currentSet = new Set(current);
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
    };
}
