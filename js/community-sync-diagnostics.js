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
        quotaByClass: {
            exactExceptions: toNonNegativeInteger(dropped?.quotaByClass?.exactExceptions),
            exactRedirects: toNonNegativeInteger(dropped?.quotaByClass?.exactRedirects),
            exactBlocks: toNonNegativeInteger(dropped?.quotaByClass?.exactBlocks),
            broadBlocks: toNonNegativeInteger(dropped?.quotaByClass?.broadBlocks),
            regexBlocks: toNonNegativeInteger(dropped?.quotaByClass?.regexBlocks),
        },
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
    const publicDirectivesCount = toNonNegativeInteger(meta?.publicDirectivesCount);
    const publicScriptletsCount = toNonNegativeInteger(meta?.publicScriptletsCount);
    const proofDirectivesCount = toNonNegativeInteger(meta?.proofDirectivesCount);
    const proofScriptletsCount = toNonNegativeInteger(meta?.proofScriptletsCount);
    const liveRemoteCosmeticChunkCount = toNonNegativeInteger(meta?.liveRemoteCosmeticChunkCount);
    const liveRemoteCosmeticDroppedAtApply =
        toNonNegativeInteger(meta?.liveRemoteCosmeticDroppedAtApply);
    const liveRemoteCosmeticHostCount = toNonNegativeInteger(meta?.liveRemoteCosmeticHostCount);
    const ttlHours = Number.isFinite(Number(meta?.ttlHours))
        ? Number(meta.ttlHours)
        : 0;
    const retryMinutes = Number.isFinite(Number(meta?.retryMinutes))
        ? Number(meta.retryMinutes)
        : 0;
    const hotfixLane = typeof meta?.hotfixLane === 'string'
        ? meta.hotfixLane.trim()
        : '';
    const partialDnrRepairCount = toNonNegativeInteger(meta?.partialDnrRepairCount);
    const lastPartialDnrRepair = toIsoTimestamp(meta?.lastPartialDnrRepair);
    const hasDroppedCounts = (
        droppedCounts.unsupportedAction !== 0 ||
        droppedCounts.unsafeScope !== 0 ||
        droppedCounts.unsupportedRedirectPath !== 0 ||
        droppedCounts.quota !== 0 ||
        droppedCounts.regexUnsupported !== 0 ||
        Object.values(droppedCounts.quotaByClass).some(value => value !== 0)
    );
    const hasActionCounts = Object.values(actionCounts).some(value => value !== 0);
    const hasMeaningfulMeta = (
        (typeof meta?.version === 'string' && meta.version.trim() !== '') ||
        (typeof meta?.integrity === 'string' && meta.integrity.trim() !== '') ||
        Number(meta?.generatedAt) > 0 ||
        activeRules !== 0 ||
        activeExceptions !== 0 ||
        cosmeticsCount !== 0 ||
        hostCosmeticsCount !== 0 ||
        heuristicRegexCount !== 0 ||
        directivesCount !== 0 ||
        scriptletsCount !== 0 ||
        publicDirectivesCount !== 0 ||
        publicScriptletsCount !== 0 ||
        proofDirectivesCount !== 0 ||
        proofScriptletsCount !== 0 ||
        liveRemoteCosmeticChunkCount !== 0 ||
        liveRemoteCosmeticDroppedAtApply !== 0 ||
        liveRemoteCosmeticHostCount !== 0 ||
        partialDnrRepairCount !== 0 ||
        hasActionCounts ||
        hasDroppedCounts
    );

    const hasAnyData = (
        hasMeaningfulMeta ||
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
        publicDirectivesCount,
        publicScriptletsCount,
        proofDirectivesCount,
        proofScriptletsCount,
        ttlHours,
        retryMinutes,
        hotfixLane: hotfixLane || 'unknown',
        partialDnrRepairSeen: partialDnrRepairCount !== 0,
        partialDnrRepairCount,
        lastPartialDnrRepair,
        liveRemoteCosmeticChunkCount,
        liveRemoteCosmeticDroppedAtApply,
        liveRemoteCosmeticHostCount,
        actions: actionCounts,
        dropped: droppedCounts,
    };
};
