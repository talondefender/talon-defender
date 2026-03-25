export const buildCommunitySyncDiagnosticsSummary = (input = {}) => {
    const meta = input?.meta instanceof Object ? input.meta : {};
    const applied = meta?.applied instanceof Object ? meta.applied : {};
    const byAction = applied?.byAction instanceof Object
        ? applied.byAction
        : {};
    const dropped = applied?.dropped instanceof Object
        ? applied.dropped
        : {};

    const toIsoTimestamp = value => {
        const time = Number(value);
        if ( Number.isFinite(time) === false || time <= 0 ) { return 'never'; }
        try {
            return new Date(time).toISOString();
        } catch {
        }
        return 'never';
    };

    const toNonNegativeInteger = value => {
        const num = Number(value);
        if ( Number.isFinite(num) === false || num < 0 ) { return 0; }
        return Math.floor(num);
    };

    const actionCounts = {
        block: toNonNegativeInteger(byAction.block),
        redirect: toNonNegativeInteger(byAction.redirect),
        allow: toNonNegativeInteger(byAction.allow),
        allowAllRequests: toNonNegativeInteger(byAction.allowAllRequests),
    };

    const droppedCounts = {
        unsupportedAction: toNonNegativeInteger(dropped.unsupportedAction),
        unsafeScope: toNonNegativeInteger(dropped.unsafeScope),
        unsupportedRedirectPath: toNonNegativeInteger(dropped.unsupportedRedirectPath),
        quota: toNonNegativeInteger(dropped.quota),
        regexUnsupported: toNonNegativeInteger(dropped.regexUnsupported),
    };

    const lastError = typeof input?.lastError === 'string'
        ? input.lastError.trim()
        : '';
    const cleanupReason = typeof input?.cleanupReason === 'string'
        ? input.cleanupReason.trim()
        : '';
    const activeRules = toNonNegativeInteger(applied.added);
    const activeExceptions = actionCounts.redirect +
        actionCounts.allow +
        actionCounts.allowAllRequests;
    const cosmeticsCount = toNonNegativeInteger(meta?.cosmeticsCount);
    const hostCosmeticsCount = toNonNegativeInteger(meta?.hostCosmeticsCount);
    const heuristicRegexCount = toNonNegativeInteger(meta?.heuristicRegexCount);
    const directivesCount = toNonNegativeInteger(meta?.directivesCount);
    const scriptletsCount = toNonNegativeInteger(meta?.scriptletsCount);

    const hasAnyData = meta instanceof Object && (
        Object.keys(meta).length !== 0 ||
        Number(input?.lastAttempt) > 0 ||
        Number(input?.lastSuccess) > 0 ||
        lastError !== '' ||
        cleanupReason !== ''
    );
    if ( hasAnyData === false ) { return null; }

    let status = 'idle';
    if ( lastError !== '' ) {
        status = 'degraded';
    } else if ( Number(input?.lastSuccess) > 0 ) {
        status = 'ok';
    } else if ( Number(input?.lastAttempt) > 0 ) {
        status = 'pending';
    }

    return {
        status,
        version: typeof meta?.version === 'string' && meta.version !== ''
            ? meta.version
            : 'unknown',
        schemaVersion: toNonNegativeInteger(meta?.schemaVersion) || 1,
        lastAttempt: toIsoTimestamp(input?.lastAttempt),
        lastSuccess: toIsoTimestamp(input?.lastSuccess),
        lastError: lastError || 'none',
        cleanupReason: cleanupReason || 'none',
        activeRules,
        activeExceptions,
        cosmeticsCount,
        hostCosmeticsCount,
        heuristicRegexCount,
        directivesCount,
        scriptletsCount,
        actions: actionCounts,
        dropped: droppedCounts,
    };
};
