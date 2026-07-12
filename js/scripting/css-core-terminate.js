/*******************************************************************************

    Talon Defender - core cosmetic runtime cleanup

*/

(async function talonCssCoreTerminate() {

self.TalonCoreCssTerminationDepth =
    (Number(self.TalonCoreCssTerminationDepth) || 0) + 1;
self.TalonCoreCssRuntimeGeneration =
    (Number(self.TalonCoreCssRuntimeGeneration) || 0) + 1;
const readinessTimeoutMs = 5000;
const cleanupJobs = [];
const cleanupFailures = [];
const cleanupStartedControllers = new WeakSet();
const startCleanup = (globalName, method) => {
    const controller = self[globalName];
    if ( controller instanceof Object === false ) { return; }
    if ( cleanupStartedControllers.has(controller) ) { return; }
    cleanupStartedControllers.add(controller);
    try {
        const job = waitBounded(
            Promise.resolve(controller[method]?.()),
            `${globalName} cleanup timed out`
        ).then(() => {
            if ( self[globalName] === controller ) {
                self[globalName] = undefined;
            }
        });
        job.catch(() => {});
        cleanupJobs.push(job);
    } catch (reason) {
        cleanupFailures.push(reason);
    }
};
const waitBounded = (promise, message, timeoutMs = readinessTimeoutMs) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = self.setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
    ]).finally(() => {
        if ( timer !== undefined ) { self.clearTimeout(timer); }
    });
};
const drainReadySets = async globalNames => {
    const deadline = Date.now() + readinessTimeoutMs;
    let emptyPasses = 0;
    for ( let pass = 0; pass < 32; pass++ ) {
        const pending = Array.from(new Set(globalNames.flatMap(globalName =>
            Array.from(self[globalName] || []).filter(value =>
                value !== null && typeof value?.then === 'function'
            )
        )));
        if ( pending.length === 0 ) {
            emptyPasses += 1;
            if ( emptyPasses >= 2 ) { return; }
            await Promise.resolve();
            continue;
        }
        emptyPasses = 0;
        const remaining = deadline - Date.now();
        if ( remaining <= 0 ) {
            throw new Error('core CSS readiness timed out');
        }
        await waitBounded(
            Promise.allSettled(pending),
            'core CSS readiness timed out',
            remaining
        );
    }
    throw new Error('core CSS readiness did not quiesce');
};

try {

// Detach every observer synchronously before waiting for startup promises.
// A stalled storage/runtime dependency must not leave old page observers live.
startCleanup('TalonCssGenericController', 'stop');
startCleanup('listsProceduralFiltererAPI', 'reset');
startCleanup('listsSpecificProceduralFiltererAPI', 'reset');
startCleanup('listsCompiledProceduralFiltererAPI', 'reset');

await drainReadySets([
    'TalonCssSpecificReadySet',
    'TalonCssProceduralReadySet',
    'TalonCssGenericReadySet',
]).catch(reason => {
    cleanupFailures.push(reason);
});

// A startup which was already past its generation check can publish a
// controller while the readiness set drains. Detach that late controller too.
startCleanup('TalonCssGenericController', 'stop');
startCleanup('listsProceduralFiltererAPI', 'reset');
startCleanup('listsSpecificProceduralFiltererAPI', 'reset');
startCleanup('listsCompiledProceduralFiltererAPI', 'reset');
if ( self.cssAPI instanceof Object ) {
    for ( const scope of [
        'generic',
        'core',
        'core-specific',
        'core-procedural',
    ] ) {
        try {
            cleanupJobs.push(waitBounded(
                Promise.resolve(self.cssAPI.removeAll?.(scope)),
                `${scope} CSS cleanup timed out`
            ));
        } catch (reason) {
            cleanupFailures.push(reason);
        }
    }
}
const cleanupResults = await Promise.allSettled(cleanupJobs);
cleanupFailures.push(...cleanupResults
    .filter(result => result.status === 'rejected')
    .map(result => result.reason));
if ( cleanupFailures.length !== 0 ) {
    throw new AggregateError(
        cleanupFailures,
        'core CSS termination was incomplete'
    );
}

} finally {
    self.TalonCoreCssTerminationDepth = Math.max(
        0,
        (Number(self.TalonCoreCssTerminationDepth) || 1) - 1
    );
}

})();
