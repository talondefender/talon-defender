// Talon-owned serialization; data verification and activation stay with callers.
export function createCommunitySyncCoordinator({
    syncBaseline,
    syncOverlay,
    handleResult,
    normalizeSiteKey,
    logError = () => {},
}) {
    let applyQueue = Promise.resolve();
    let baselineInFlight;
    let forceQueued = false;
    const overlaysInFlight = new Map();
    const enqueue = job => {
        const run = applyQueue.catch(() => {}).then(job);
        applyQueue = run.catch(() => {});
        return run;
    };
    const baseline = options => {
        const normalized = options instanceof Object ? { ...options } : {};
        if ( baselineInFlight !== undefined ) {
            if ( normalized.force === true ) { forceQueued = true; }
            return baselineInFlight;
        }
        baselineInFlight = enqueue(async () => {
            try {
                return await handleResult(await syncBaseline(normalized));
            } catch (reason) {
                logError(`community-sync/baseline/${reason}`);
            } finally {
                baselineInFlight = undefined;
                if ( forceQueued ) {
                    forceQueued = false;
                    baseline({ force: true });
                }
            }
        });
        return baselineInFlight;
    };
    const overlay = options => {
        const normalized = options instanceof Object ? { ...options } : {};
        const siteKey = normalizeSiteKey(normalized.siteKey);
        if ( siteKey === '' ) { return Promise.resolve({ skipped: 'invalid-site-key' }); }
        if ( overlaysInFlight.has(siteKey) ) { return overlaysInFlight.get(siteKey); }
        const pending = enqueue(async () => {
            try {
                let result = await syncOverlay({
                    siteKey, force: normalized.force === true, reason: normalized.reason,
                });
                if ( result?.retryWithForcedBaseline === true ) {
                    await handleResult(await syncBaseline({ force: true }));
                    result = await syncOverlay({
                        siteKey, force: true, reason: normalized.reason,
                    });
                }
                return await handleResult(result);
            } catch (reason) {
                logError(`community-sync/overlay/${reason}`);
            } finally {
                overlaysInFlight.delete(siteKey);
            }
        });
        overlaysInFlight.set(siteKey, pending);
        return pending;
    };
    return { baseline, overlay };
}
