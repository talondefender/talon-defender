const normalizedPaths = paths => Array.isArray(paths)
    ? paths.map(path => {
        if ( typeof path !== 'string' || path === '' ) { return path; }
        return path.startsWith('/') ? path : `/${path}`;
    })
    : [];

const normalizedStringSet = values => Array.isArray(values)
    ? Array.from(new Set(values.filter(value => typeof value === 'string'))).sort()
    : [];

export const normalizeContentScriptRegistration = entry => ({
    id: typeof entry?.id === 'string' ? entry.id : '',
    js: normalizedPaths(entry?.js),
    css: normalizedPaths(entry?.css),
    matches: normalizedStringSet(entry?.matches),
    excludeMatches: normalizedStringSet(entry?.excludeMatches),
    includeGlobs: normalizedStringSet(entry?.includeGlobs),
    excludeGlobs: normalizedStringSet(entry?.excludeGlobs),
    allFrames: entry?.allFrames === true,
    matchOriginAsFallback: entry?.matchOriginAsFallback === true,
    persistAcrossSessions: entry?.persistAcrossSessions !== false,
    runAt: typeof entry?.runAt === 'string' ? entry.runAt : 'document_idle',
    world: typeof entry?.world === 'string' ? entry.world : 'ISOLATED',
});

export const contentScriptRegistrationsEqual = (before, after) => {
    if ( before instanceof Object === false || after instanceof Object === false ) {
        return false;
    }
    return JSON.stringify(normalizeContentScriptRegistration(before)) ===
        JSON.stringify(normalizeContentScriptRegistration(after));
};

const PACKAGED_STATIC_SCRIPTLET_PATH_RE =
    /^\/?rulesets\/scripting\/scriptlet\/(?:main|isolated)\/[^/]+\.js$/;

export const isPackagedStaticScriptletRegistration = entry =>
    entry instanceof Object &&
    Array.isArray(entry.js) &&
    entry.js.length === 1 &&
    typeof entry.js[0] === 'string' &&
    PACKAGED_STATIC_SCRIPTLET_PATH_RE.test(entry.js[0]);

const REMOTE_SCRIPTLET_ID_PREFIX = 'remote-scriptlet.';
export const RELOAD_SENSITIVE_REGISTRATION_STATE_SCHEMA = 1;
const MAX_RELOAD_SENSITIVE_REGISTRATIONS = 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const isReloadSensitiveScriptletRegistration = entry =>
    isPackagedStaticScriptletRegistration(entry) || (
        entry instanceof Object &&
        typeof entry.id === 'string' &&
        entry.id.startsWith(REMOTE_SCRIPTLET_ID_PREFIX)
    );

export const getReloadSensitiveResourcePaths = registrations => {
    if ( Array.isArray(registrations) === false ) { return []; }
    const paths = new Set();
    for ( const entry of registrations ) {
        if ( isReloadSensitiveScriptletRegistration(entry) === false ) {
            continue;
        }
        const normalized = normalizeContentScriptRegistration(entry);
        for ( const path of normalized.js ) {
            if ( typeof path === 'string' && path !== '' ) {
                paths.add(path);
            }
        }
    }
    return Array.from(paths).sort();
};

export const getReloadSensitiveRegistrationDirectives = registrations =>
    Array.isArray(registrations)
        ? registrations
            .filter(isReloadSensitiveScriptletRegistration)
            .map(normalizeContentScriptRegistration)
            .sort((a, b) => a.id.localeCompare(b.id))
        : [];

const normalizeResourceDigestMap = input => {
    const source = input instanceof Map
        ? input
        : input instanceof Object && Array.isArray(input) === false
            ? new Map(Object.entries(input))
            : null;
    if ( source === null ) { return null; }
    const out = new Map();
    for ( const [ path, digest ] of source ) {
        const normalizedPath = typeof path === 'string' && path !== ''
            ? path.startsWith('/') ? path : `/${path}`
            : '';
        if (
            normalizedPath === '' ||
            typeof digest !== 'string' ||
            SHA256_HEX_RE.test(digest) === false
        ) {
            return null;
        }
        out.set(normalizedPath, digest);
    }
    return out;
};

export const createReloadSensitiveRegistrationState = (
    registrations,
    resourceDigests
) => {
    if ( Array.isArray(registrations) === false ) { return null; }
    const normalizedDigests = normalizeResourceDigestMap(resourceDigests);
    if ( normalizedDigests === null ) { return null; }
    const entries = [];
    for ( const entry of registrations ) {
        if ( isReloadSensitiveScriptletRegistration(entry) === false ) {
            continue;
        }
        const directive = normalizeContentScriptRegistration(entry);
        const resources = [];
        for ( const path of directive.js ) {
            const sha256 = normalizedDigests.get(path);
            if ( sha256 === undefined ) { return null; }
            resources.push({ path, sha256 });
        }
        entries.push({ directive, resources });
    }
    if ( entries.length > MAX_RELOAD_SENSITIVE_REGISTRATIONS ) { return null; }
    entries.sort((a, b) => a.directive.id.localeCompare(b.directive.id));
    const ids = new Set();
    for ( const entry of entries ) {
        if ( entry.directive.id === '' || ids.has(entry.directive.id) ) {
            return null;
        }
        ids.add(entry.directive.id);
    }
    return {
        version: RELOAD_SENSITIVE_REGISTRATION_STATE_SCHEMA,
        registrations: entries,
    };
};

export const normalizeReloadSensitiveRegistrationState = input => {
    if (
        input instanceof Object === false ||
        input.version !== RELOAD_SENSITIVE_REGISTRATION_STATE_SCHEMA ||
        Array.isArray(input.registrations) === false ||
        input.registrations.length > MAX_RELOAD_SENSITIVE_REGISTRATIONS
    ) {
        return null;
    }
    const registrations = [];
    const resourceDigests = new Map();
    for ( const entry of input.registrations ) {
        if (
            entry instanceof Object === false ||
            entry.directive instanceof Object === false ||
            Array.isArray(entry.resources) === false
        ) {
            return null;
        }
        registrations.push(entry.directive);
        for ( const resource of entry.resources ) {
            if (
                resource instanceof Object === false ||
                typeof resource.path !== 'string' ||
                typeof resource.sha256 !== 'string' ||
                SHA256_HEX_RE.test(resource.sha256) === false
            ) {
                return null;
            }
            const normalizedPath = resource.path.startsWith('/')
                ? resource.path
                : `/${resource.path}`;
            const before = resourceDigests.get(normalizedPath);
            if ( before !== undefined && before !== resource.sha256 ) {
                return null;
            }
            resourceDigests.set(normalizedPath, resource.sha256);
        }
    }
    return createReloadSensitiveRegistrationState(
        registrations,
        resourceDigests
    );
};

export const diffReloadSensitiveRegistrationStates = (before, after) => {
    const normalizedBefore = normalizeReloadSensitiveRegistrationState(before);
    const normalizedAfter = normalizeReloadSensitiveRegistrationState(after);
    if ( normalizedBefore === null || normalizedAfter === null ) { return null; }
    const beforeById = new Map(normalizedBefore.registrations.map(
        entry => [ entry.directive.id, entry ]
    ));
    const afterById = new Map(normalizedAfter.registrations.map(
        entry => [ entry.directive.id, entry ]
    ));
    const hint = { before: [], after: [] };
    const ids = Array.from(new Set([
        ...beforeById.keys(),
        ...afterById.keys(),
    ])).sort();
    for ( const id of ids ) {
        const previous = beforeById.get(id);
        const current = afterById.get(id);
        if ( JSON.stringify(previous) === JSON.stringify(current) ) { continue; }
        if ( previous ) { hint.before.push(previous.directive); }
        if ( current ) { hint.after.push(current.directive); }
    }
    return hint.before.length === 0 && hint.after.length === 0
        ? null
        : hint;
};

const LEGACY_ALL_SCRIPTLET_MIGRATION_VERSIONS = new Set([
    '0.1.0',
    '0.1.1',
    '0.1.2',
    '0.1.3',
    '0.1.4',
    '0.1.5',
]);
const LEGACY_STATIC_SCRIPTLET_MIGRATION_VERSIONS = new Set([
    '0.1.6',
    '0.1.7',
]);
const LEGACY_FRENCH_STREAM_MIGRATION_VERSIONS = new Set([
    '0.1.8',
    '0.1.9',
    '0.1.10',
]);

export const legacyReloadSensitiveMigrationHint = (
    previousVersion,
    currentState
) => {
    const normalized = normalizeReloadSensitiveRegistrationState(currentState);
    if ( normalized === null || typeof previousVersion !== 'string' ) {
        return null;
    }
    let entries = [];
    if ( LEGACY_ALL_SCRIPTLET_MIGRATION_VERSIONS.has(previousVersion) ) {
        entries = normalized.registrations;
    } else if (
        LEGACY_STATIC_SCRIPTLET_MIGRATION_VERSIONS.has(previousVersion)
    ) {
        entries = normalized.registrations.filter(entry =>
            entry.resources.some(resource =>
                resource.path.startsWith('/rulesets/scripting/scriptlet/')
            )
        );
    } else if (
        LEGACY_FRENCH_STREAM_MIGRATION_VERSIONS.has(previousVersion)
    ) {
        entries = normalized.registrations.filter(entry =>
            entry.directive.id === 'talon-site-fixes-main'
        );
    }
    return entries.length === 0
        ? null
        : {
            before: [],
            after: entries.map(entry => entry.directive),
        };
};

export const recordPackagedStaticScriptletReloadTransition = (
    hint,
    before,
    after
) => {
    if ( hint instanceof Object === false ) { return false; }
    let changed = false;
    if ( isPackagedStaticScriptletRegistration(before) ) {
        hint.before ||= [];
        hint.before.push(before);
        changed = true;
    }
    if ( isPackagedStaticScriptletRegistration(after) ) {
        hint.after ||= [];
        hint.after.push(after);
        changed = true;
    }
    return changed;
};

const normalizeRegistrationEntries = (entries, label) => {
    if ( Array.isArray(entries) === false ) { return []; }
    const out = [];
    const ids = new Set();
    for ( const entry of entries ) {
        if ( entry instanceof Object === false ) { continue; }
        if ( typeof entry.id !== 'string' || entry.id === '' ) { continue; }
        if ( ids.has(entry.id) ) {
            throw new Error(`${label} contains duplicate id ${entry.id}`);
        }
        ids.add(entry.id);
        out.push(entry);
    }
    return out;
};

const normalizePlan = plan => {
    const addEntries = normalizeRegistrationEntries(plan?.toAdd, 'toAdd');
    const updateEntries = normalizeRegistrationEntries(plan?.toUpdate, 'toUpdate');
    const removeIds = new Set(
        Array.isArray(plan?.toRemove)
            ? plan.toRemove.filter(id => typeof id === 'string' && id !== '')
            : []
    );
    const updateById = new Map(updateEntries.map(entry => [ entry.id, entry ]));
    const toAdd = [];
    for ( const entry of addEntries ) {
        if ( updateById.has(entry.id) ) {
            throw new Error(`registration id ${entry.id} is both added and updated`);
        }
        if ( removeIds.delete(entry.id) ) {
            updateById.set(entry.id, entry);
        } else {
            toAdd.push(entry);
        }
    }
    for ( const id of updateById.keys() ) {
        removeIds.delete(id);
    }
    return {
        toAdd,
        toUpdate: Array.from(updateById.values()),
        toRemove: Array.from(removeIds),
        registeredTacticsHostCount: Math.max(
            0,
            Number(plan?.registeredTacticsHostCount) || 0
        ),
        remoteScriptletReloadHint: plan?.remoteScriptletReloadHint ?? null,
        specificCosmeticKeepKeys: Array.isArray(plan?.specificCosmeticKeepKeys)
            ? plan.specificCosmeticKeepKeys.filter(key => typeof key === 'string')
            : [],
        cosmeticDataChanged: plan?.cosmeticDataChanged === true,
    };
};

const errorMessageFrom = (stage, reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    return `${stage}: ${message}`;
};

class OperationTimeoutError extends Error {
    constructor(stage, timeoutMs) {
        super(`timed out after ${timeoutMs}ms`);
        this.name = 'OperationTimeoutError';
        this.stage = stage;
        this.uncertain = true;
    }
}

const unsettledTimedOutOperations = new Set();

export const waitForTimedOutRegistrationOperations = () => Promise.allSettled(
    Array.from(unsettledTimedOutOperations)
);

export const hasTimedOutRegistrationOperations = () =>
    unsettledTimedOutOperations.size !== 0;

export async function unregisterAndVerifyManagedRegistrations({
    listRegistrations,
    unregisterRegistrations,
    isManaged = () => true,
    label = 'registration',
    maxAttempts = 2,
} = {}) {
    if ( typeof listRegistrations !== 'function' ) {
        throw new TypeError('listRegistrations must be a function');
    }
    if ( typeof unregisterRegistrations !== 'function' ) {
        throw new TypeError('unregisterRegistrations must be a function');
    }
    if ( typeof isManaged !== 'function' ) {
        throw new TypeError('isManaged must be a function');
    }
    const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 1));
    const listManaged = async stage => {
        const entries = await listRegistrations();
        if ( Array.isArray(entries) === false ) {
            throw new Error(`${label} ${stage} returned invalid state`);
        }
        const managed = entries.filter(entry => isManaged(entry) === true);
        for ( const entry of managed ) {
            if ( typeof entry?.id !== 'string' || entry.id === '' ) {
                throw new Error(`${label} ${stage} contains an invalid managed id`);
            }
        }
        return managed;
    };

    const removedIds = new Set();
    for ( let attempt = 1; attempt <= attempts; attempt++ ) {
        const before = await listManaged('preflight');
        if ( before.length === 0 ) {
            return {
                ok: true,
                attempts: attempt - 1,
                removedIds: Array.from(removedIds).sort(),
            };
        }
        const ids = Array.from(new Set(before.map(entry => entry.id))).sort();
        await unregisterRegistrations(ids);
        for ( const id of ids ) { removedIds.add(id); }
        const remaining = await listManaged('verification');
        if ( remaining.length === 0 ) {
            return {
                ok: true,
                attempts: attempt,
                removedIds: Array.from(removedIds).sort(),
            };
        }
        if ( attempt === attempts ) {
            throw new Error(
                `${label} cleanup verification failed: ` +
                remaining.map(entry => entry.id).sort().join(', ')
            );
        }
    }
}

const invokeWithTimeout = async ({
    operation,
    timeoutMs = 0,
    stage = 'operation',
}) => {
    if ( typeof operation !== 'function' ) {
        throw new TypeError('operation must be a function');
    }
    const effectiveTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    if ( effectiveTimeoutMs === 0 ) {
        return operation();
    }
    let timer;
    const operationPromise = Promise.resolve().then(() => operation());
    try {
        return await Promise.race([
            operationPromise,
            new Promise((_, reject) => {
                timer = globalThis.setTimeout(() => {
                    reject(new OperationTimeoutError(stage, effectiveTimeoutMs));
                }, effectiveTimeoutMs);
            }),
        ]);
    } catch (reason) {
        if ( reason instanceof OperationTimeoutError ) {
            unsettledTimedOutOperations.add(operationPromise);
            operationPromise.then(
                () => unsettledTimedOutOperations.delete(operationPromise),
                () => unsettledTimedOutOperations.delete(operationPromise)
            );
        }
        throw reason;
    } finally {
        if ( timer !== undefined ) {
            globalThis.clearTimeout(timer);
        }
    }
};

const buildFailureResult = ({
    now = Date.now,
    attemptedRecovery = false,
    recovered = false,
    initialError = '',
    lastError = '',
    recoveryResetError = '',
    recoveryResetCount = 0,
    toAddCount = 0,
    toUpdateCount = 0,
    toRemoveCount = 0,
    registeredTacticsHostCount = 0,
    remoteScriptletReloadHint = null,
    specificCosmeticKeepKeys = [],
    cosmeticDataChanged = false,
    uncertain = false,
} = {}) => ({
    ok: false,
    updatedAt: now(),
    attemptedRecovery,
    recovered,
    initialError,
    lastError,
    recoveryResetError,
    recoveryResetCount,
    toAddCount,
    toUpdateCount,
    toRemoveCount,
    registeredTacticsHostCount,
    remoteScriptletReloadHint,
    specificCosmeticKeepKeys,
    cosmeticDataChanged,
    uncertain,
});

const buildSuccessResult = ({
    now = Date.now,
    attemptedRecovery = false,
    initialError = '',
    recoveryResetCount = 0,
    toAddCount = 0,
    toUpdateCount = 0,
    toRemoveCount = 0,
    registeredTacticsHostCount = 0,
    remoteScriptletReloadHint = null,
    specificCosmeticKeepKeys = [],
    cosmeticDataChanged = false,
} = {}) => ({
    ok: true,
    updatedAt: now(),
    attemptedRecovery,
    recovered: attemptedRecovery,
    initialError,
    lastError: '',
    recoveryResetError: '',
    recoveryResetCount,
    toAddCount,
    toUpdateCount,
    toRemoveCount,
    registeredTacticsHostCount,
    remoteScriptletReloadHint,
    specificCosmeticKeepKeys,
    cosmeticDataChanged,
    uncertain: false,
});

const registrationForUpdate = entry => ({
    id: typeof entry.id === 'string' ? entry.id : '',
    js: Array.isArray(entry.js) ? entry.js : [],
    css: Array.isArray(entry.css) ? entry.css : [],
    matches: Array.isArray(entry.matches) ? entry.matches : [],
    excludeMatches: Array.isArray(entry.excludeMatches) ? entry.excludeMatches : [],
    allFrames: entry.allFrames === true,
    matchOriginAsFallback: entry.matchOriginAsFallback === true,
    persistAcrossSessions: entry.persistAcrossSessions !== false,
    runAt: typeof entry.runAt === 'string' ? entry.runAt : 'document_idle',
    world: typeof entry.world === 'string' ? entry.world : 'ISOLATED',
});

const applyPlan = async ({
    phase,
    plan,
    beforeRegistrationMutation,
    updateContentScripts,
    unregisterContentScripts,
    registerContentScripts,
    now,
    operationTimeoutMs,
}) => {
    const {
        toAdd,
        toUpdate,
        toRemove,
        registeredTacticsHostCount,
        remoteScriptletReloadHint,
        specificCosmeticKeepKeys,
        cosmeticDataChanged,
    } = normalizePlan(plan);
    const common = {
        toAddCount: toAdd.length,
        toUpdateCount: toUpdate.length,
        toRemoveCount: toRemove.length,
        registeredTacticsHostCount,
        remoteScriptletReloadHint,
        specificCosmeticKeepKeys,
        cosmeticDataChanged,
    };
    if (
        toUpdate.length !== 0 ||
        toAdd.length !== 0 ||
        toRemove.length !== 0
    ) {
        try {
            await invokeWithTimeout({
                operation: () => beforeRegistrationMutation?.({
                    phase,
                    toAddCount: toAdd.length,
                    toUpdateCount: toUpdate.length,
                    toRemoveCount: toRemove.length,
                }),
                timeoutMs: operationTimeoutMs,
                stage: `${phase}.registrationMutationJournal.mark`,
            });
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.registrationMutationJournal.mark`,
                    reason
                ),
                uncertain: reason?.uncertain === true,
                ...common,
            });
        }
    }
    if ( toUpdate.length !== 0 ) {
        try {
            await invokeWithTimeout({
                operation: () => updateContentScripts(
                    toUpdate.map(registrationForUpdate)
                ),
                timeoutMs: operationTimeoutMs,
                stage: `${phase}.updateContentScripts`,
            });
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.updateContentScripts`,
                    reason
                ),
                uncertain: reason?.uncertain === true,
                ...common,
            });
        }
    }
    if ( toAdd.length !== 0 ) {
        try {
            await invokeWithTimeout({
                operation: () => registerContentScripts(toAdd),
                timeoutMs: operationTimeoutMs,
                stage: `${phase}.registerContentScripts`,
            });
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.registerContentScripts`,
                    reason
                ),
                uncertain: reason?.uncertain === true,
                ...common,
            });
        }
    }
    if ( toRemove.length !== 0 ) {
        try {
            await invokeWithTimeout({
                operation: () => unregisterContentScripts(toRemove),
                timeoutMs: operationTimeoutMs,
                stage: `${phase}.unregisterContentScripts`,
            });
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.unregisterContentScripts`,
                    reason
                ),
                uncertain: reason?.uncertain === true,
                ...common,
            });
        }
    }
    return buildSuccessResult({
        now,
        ...common,
    });
};

const buildPlanSafe = async ({
    buildPlan,
    phase,
    now,
    operationTimeoutMs,
}) => {
    try {
        return normalizePlan(
            await invokeWithTimeout({
                operation: () => buildPlan(),
                timeoutMs: operationTimeoutMs,
                stage: `${phase}.buildPlan`,
            })
        );
    } catch (reason) {
        return buildFailureResult({
            now,
            lastError: errorMessageFrom(`${phase}.buildPlan`, reason),
            uncertain: reason?.uncertain === true,
        });
    }
};

export async function runInjectableRegistrationFlow({
    buildPlan,
    listRegistered,
    updateContentScripts,
    unregisterContentScripts,
    registerContentScripts,
    registrationMutationJournal,
    now = Date.now,
    operationTimeoutMs = 0,
} = {}) {
    if ( typeof buildPlan !== 'function' ) {
        throw new TypeError('buildPlan must be a function');
    }
    if ( typeof listRegistered !== 'function' ) {
        throw new TypeError('listRegistered must be a function');
    }
    if ( typeof updateContentScripts !== 'function' ) {
        throw new TypeError('updateContentScripts must be a function');
    }
    if ( typeof unregisterContentScripts !== 'function' ) {
        throw new TypeError('unregisterContentScripts must be a function');
    }
    if ( typeof registerContentScripts !== 'function' ) {
        throw new TypeError('registerContentScripts must be a function');
    }
    if ( registrationMutationJournal !== undefined ) {
        if (
            registrationMutationJournal instanceof Object === false ||
            typeof registrationMutationJournal.recover !== 'function' ||
            typeof registrationMutationJournal.mark !== 'function' ||
            typeof registrationMutationJournal.verify !== 'function' ||
            typeof registrationMutationJournal.clear !== 'function'
        ) {
            throw new TypeError(
                'registrationMutationJournal must provide recover, mark, verify, and clear'
            );
        }
    }
    if ( unsettledTimedOutOperations.size !== 0 ) {
        return buildFailureResult({
            now,
            lastError: 'a timed-out registration operation is still unsettled',
            uncertain: true,
        });
    }

    let journalActive = false;
    let journalRecovered = false;
    const withJournalRecovery = result => {
        if ( journalRecovered === false ) { return result; }
        return {
            ...result,
            attemptedRecovery: true,
            recovered: result.ok === true,
            recoveryResetCount:
                Math.max(0, Number(result.recoveryResetCount) || 0) + 1,
        };
    };
    const beforeRegistrationMutation = registrationMutationJournal === undefined
        ? undefined
        : async details => {
            await registrationMutationJournal.mark(details);
            journalActive = true;
        };
    const finalizeSuccessfulResult = async result => {
        const recoveredResult = withJournalRecovery(result);
        if ( journalActive === false ) { return recoveredResult; }
        let verified;
        try {
            verified = await invokeWithTimeout({
                operation: () => registrationMutationJournal.verify(),
                timeoutMs: operationTimeoutMs,
                stage: 'registrationMutationJournal.verify',
            });
        } catch (reason) {
            return buildFailureResult({
                now,
                attemptedRecovery: recoveredResult.attemptedRecovery,
                initialError: recoveredResult.initialError,
                lastError: errorMessageFrom(
                    'registrationMutationJournal.verify',
                    reason
                ),
                recoveryResetCount: recoveredResult.recoveryResetCount,
                toAddCount: recoveredResult.toAddCount,
                toUpdateCount: recoveredResult.toUpdateCount,
                toRemoveCount: recoveredResult.toRemoveCount,
                registeredTacticsHostCount:
                    recoveredResult.registeredTacticsHostCount,
                remoteScriptletReloadHint:
                    recoveredResult.remoteScriptletReloadHint,
                specificCosmeticKeepKeys:
                    recoveredResult.specificCosmeticKeepKeys,
                cosmeticDataChanged: recoveredResult.cosmeticDataChanged,
                uncertain: reason?.uncertain === true,
            });
        }
        if ( verified !== true ) {
            return buildFailureResult({
                now,
                attemptedRecovery: recoveredResult.attemptedRecovery,
                initialError: recoveredResult.initialError,
                lastError:
                    'registrationMutationJournal.verify: desired state mismatch',
                recoveryResetCount: recoveredResult.recoveryResetCount,
                toAddCount: recoveredResult.toAddCount,
                toUpdateCount: recoveredResult.toUpdateCount,
                toRemoveCount: recoveredResult.toRemoveCount,
                registeredTacticsHostCount:
                    recoveredResult.registeredTacticsHostCount,
                remoteScriptletReloadHint:
                    recoveredResult.remoteScriptletReloadHint,
                specificCosmeticKeepKeys:
                    recoveredResult.specificCosmeticKeepKeys,
                cosmeticDataChanged: recoveredResult.cosmeticDataChanged,
            });
        }
        try {
            await invokeWithTimeout({
                operation: () => registrationMutationJournal.clear(),
                timeoutMs: operationTimeoutMs,
                stage: 'registrationMutationJournal.clear',
            });
            journalActive = false;
        } catch (reason) {
            return buildFailureResult({
                now,
                attemptedRecovery: recoveredResult.attemptedRecovery,
                initialError: recoveredResult.initialError,
                lastError: errorMessageFrom(
                    'registrationMutationJournal.clear',
                    reason
                ),
                recoveryResetCount: recoveredResult.recoveryResetCount,
                toAddCount: recoveredResult.toAddCount,
                toUpdateCount: recoveredResult.toUpdateCount,
                toRemoveCount: recoveredResult.toRemoveCount,
                registeredTacticsHostCount:
                    recoveredResult.registeredTacticsHostCount,
                remoteScriptletReloadHint:
                    recoveredResult.remoteScriptletReloadHint,
                specificCosmeticKeepKeys:
                    recoveredResult.specificCosmeticKeepKeys,
                cosmeticDataChanged: recoveredResult.cosmeticDataChanged,
                uncertain: reason?.uncertain === true,
            });
        }
        return recoveredResult;
    };

    if ( registrationMutationJournal !== undefined ) {
        try {
            journalRecovered = await invokeWithTimeout({
                operation: () => registrationMutationJournal.recover(),
                timeoutMs: operationTimeoutMs,
                stage: 'registrationMutationJournal.recover',
            }) === true;
            journalActive = journalRecovered;
        } catch (reason) {
            return buildFailureResult({
                now,
                attemptedRecovery: true,
                lastError: errorMessageFrom(
                    'registrationMutationJournal.recover',
                    reason
                ),
                uncertain: reason?.uncertain === true,
            });
        }
    }

    const initialPlan = await buildPlanSafe({
        buildPlan,
        phase: 'initial',
        now,
        operationTimeoutMs,
    });
    if ( initialPlan.ok === false ) {
        return withJournalRecovery(initialPlan);
    }

    const initialResult = await applyPlan({
        phase: 'initial',
        plan: initialPlan,
        beforeRegistrationMutation,
        updateContentScripts,
        unregisterContentScripts,
        registerContentScripts,
        now,
        operationTimeoutMs,
    });
    if ( initialResult.ok ) {
        return finalizeSuccessfulResult(initialResult);
    }

    // A timed-out Chrome API call is still running and cannot be cancelled.
    // Starting a recovery mutation here would race the unknown operation.
    if ( initialResult.uncertain ) {
        return withJournalRecovery(initialResult);
    }

    try {
        await invokeWithTimeout({
            operation: () => listRegistered(),
            timeoutMs: operationTimeoutMs,
            stage: 'recovery.listRegisteredContentScripts',
        });
    } catch (reason) {
        return withJournalRecovery(buildFailureResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            lastError: initialResult.lastError,
            recoveryResetError: errorMessageFrom(
                'recovery.listRegisteredContentScripts',
                reason
            ),
            toAddCount: initialResult.toAddCount,
            toUpdateCount: initialResult.toUpdateCount,
            toRemoveCount: initialResult.toRemoveCount,
            registeredTacticsHostCount: initialResult.registeredTacticsHostCount,
            remoteScriptletReloadHint: initialResult.remoteScriptletReloadHint,
            specificCosmeticKeepKeys: initialResult.specificCosmeticKeepKeys,
            cosmeticDataChanged: initialResult.cosmeticDataChanged,
            uncertain: reason?.uncertain === true,
        }));
    }

    const recoveryPlan = await buildPlanSafe({
        buildPlan,
        phase: 'recovery',
        now,
        operationTimeoutMs,
    });
    if ( recoveryPlan.ok === false ) {
        return withJournalRecovery(buildFailureResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            lastError: recoveryPlan.lastError,
            uncertain: recoveryPlan.uncertain === true,
        }));
    }

    const recoveryResult = await applyPlan({
        phase: 'recovery',
        plan: recoveryPlan,
        beforeRegistrationMutation,
        updateContentScripts,
        unregisterContentScripts,
        registerContentScripts,
        now,
        operationTimeoutMs,
    });
    if ( recoveryResult.ok ) {
        return finalizeSuccessfulResult(buildSuccessResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            toAddCount: recoveryResult.toAddCount,
            toUpdateCount: recoveryResult.toUpdateCount,
            toRemoveCount: recoveryResult.toRemoveCount,
            registeredTacticsHostCount: recoveryResult.registeredTacticsHostCount,
            remoteScriptletReloadHint: recoveryResult.remoteScriptletReloadHint,
            specificCosmeticKeepKeys: recoveryResult.specificCosmeticKeepKeys,
            cosmeticDataChanged: recoveryResult.cosmeticDataChanged,
        }));
    }

    return withJournalRecovery(buildFailureResult({
        now,
        attemptedRecovery: true,
        initialError: initialResult.lastError,
        lastError: recoveryResult.lastError,
        toAddCount: recoveryResult.toAddCount,
        toUpdateCount: recoveryResult.toUpdateCount,
        toRemoveCount: recoveryResult.toRemoveCount,
        registeredTacticsHostCount: recoveryResult.registeredTacticsHostCount,
        remoteScriptletReloadHint: recoveryResult.remoteScriptletReloadHint,
        specificCosmeticKeepKeys: recoveryResult.specificCosmeticKeepKeys,
        cosmeticDataChanged: recoveryResult.cosmeticDataChanged,
        uncertain: recoveryResult.uncertain === true,
    }));
}
