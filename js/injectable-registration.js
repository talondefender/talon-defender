const normalizeIds = registered => {
    if ( Array.isArray(registered) === false ) { return []; }
    return registered
        .map(entry => entry?.id)
        .filter(id => typeof id === 'string' && id !== '');
};

const normalizePlan = plan => ({
    toAdd: Array.isArray(plan?.toAdd)
        ? plan.toAdd.filter(entry => entry instanceof Object && typeof entry.id === 'string' && entry.id !== '')
        : [],
    toRemove: Array.isArray(plan?.toRemove)
        ? plan.toRemove.filter(id => typeof id === 'string' && id !== '')
        : [],
});

const errorMessageFrom = (stage, reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    return `${stage}: ${message}`;
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
    toRemoveCount = 0,
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
    toRemoveCount,
});

const buildSuccessResult = ({
    now = Date.now,
    attemptedRecovery = false,
    initialError = '',
    recoveryResetCount = 0,
    toAddCount = 0,
    toRemoveCount = 0,
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
    toRemoveCount,
});

const applyPlan = async ({
    phase,
    plan,
    unregisterContentScripts,
    registerContentScripts,
    now,
}) => {
    const { toAdd, toRemove } = normalizePlan(plan);
    if ( toRemove.length !== 0 ) {
        try {
            await unregisterContentScripts(toRemove);
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.unregisterContentScripts`,
                    reason
                ),
                toAddCount: toAdd.length,
                toRemoveCount: toRemove.length,
            });
        }
    }
    if ( toAdd.length !== 0 ) {
        try {
            await registerContentScripts(toAdd);
        } catch (reason) {
            return buildFailureResult({
                now,
                lastError: errorMessageFrom(
                    `${phase}.registerContentScripts`,
                    reason
                ),
                toAddCount: toAdd.length,
                toRemoveCount: toRemove.length,
            });
        }
    }
    return buildSuccessResult({
        now,
        toAddCount: toAdd.length,
        toRemoveCount: toRemove.length,
    });
};

const buildPlanSafe = async ({ buildPlan, phase, now }) => {
    try {
        return normalizePlan(await buildPlan());
    } catch (reason) {
        return buildFailureResult({
            now,
            lastError: errorMessageFrom(`${phase}.buildPlan`, reason),
        });
    }
};

export async function runInjectableRegistrationFlow({
    buildPlan,
    listRegistered,
    unregisterContentScripts,
    registerContentScripts,
    now = Date.now,
} = {}) {
    if ( typeof buildPlan !== 'function' ) {
        throw new TypeError('buildPlan must be a function');
    }
    if ( typeof listRegistered !== 'function' ) {
        throw new TypeError('listRegistered must be a function');
    }
    if ( typeof unregisterContentScripts !== 'function' ) {
        throw new TypeError('unregisterContentScripts must be a function');
    }
    if ( typeof registerContentScripts !== 'function' ) {
        throw new TypeError('registerContentScripts must be a function');
    }

    const initialPlan = await buildPlanSafe({ buildPlan, phase: 'initial', now });
    if ( initialPlan.ok === false ) { return initialPlan; }

    const initialResult = await applyPlan({
        phase: 'initial',
        plan: initialPlan,
        unregisterContentScripts,
        registerContentScripts,
        now,
    });
    if ( initialResult.ok ) { return initialResult; }

    let registered;
    try {
        registered = await listRegistered();
    } catch (reason) {
        return buildFailureResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            lastError: initialResult.lastError,
            recoveryResetError: errorMessageFrom(
                'recovery.listRegisteredContentScripts',
                reason
            ),
            toAddCount: initialResult.toAddCount,
            toRemoveCount: initialResult.toRemoveCount,
        });
    }

    const recoveryIds = normalizeIds(registered);
    if ( recoveryIds.length !== 0 ) {
        try {
            await unregisterContentScripts(recoveryIds);
        } catch (reason) {
            return buildFailureResult({
                now,
                attemptedRecovery: true,
                initialError: initialResult.lastError,
                lastError: initialResult.lastError,
                recoveryResetError: errorMessageFrom(
                    'recovery.unregisterAllContentScripts',
                    reason
                ),
                recoveryResetCount: recoveryIds.length,
                toAddCount: initialResult.toAddCount,
                toRemoveCount: initialResult.toRemoveCount,
            });
        }
    }

    const recoveryPlan = await buildPlanSafe({ buildPlan, phase: 'recovery', now });
    if ( recoveryPlan.ok === false ) {
        return buildFailureResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            lastError: recoveryPlan.lastError,
            recoveryResetCount: recoveryIds.length,
        });
    }

    const recoveryResult = await applyPlan({
        phase: 'recovery',
        plan: recoveryPlan,
        unregisterContentScripts,
        registerContentScripts,
        now,
    });
    if ( recoveryResult.ok ) {
        return buildSuccessResult({
            now,
            attemptedRecovery: true,
            initialError: initialResult.lastError,
            recoveryResetCount: recoveryIds.length,
            toAddCount: recoveryResult.toAddCount,
            toRemoveCount: recoveryResult.toRemoveCount,
        });
    }

    return buildFailureResult({
        now,
        attemptedRecovery: true,
        initialError: initialResult.lastError,
        lastError: recoveryResult.lastError,
        recoveryResetCount: recoveryIds.length,
        toAddCount: recoveryResult.toAddCount,
        toRemoveCount: recoveryResult.toRemoveCount,
    });
}
