/*******************************************************************************

    Talon Defender - verified cosmetic runtime cleanup

*/

(async function talonCssRuntimeTerminate() {

self.TalonCustomCssTerminationDepth =
    (Number(self.TalonCustomCssTerminationDepth) || 0) + 1;
self.TalonCoreCssTerminationDepth =
    (Number(self.TalonCoreCssTerminationDepth) || 0) + 1;
self.TalonCustomCssRuntimeGeneration =
    (Number(self.TalonCustomCssRuntimeGeneration) || 0) + 1;
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
            throw new Error('CSS runtime readiness timed out');
        }
        await waitBounded(
            Promise.allSettled(pending),
            'CSS runtime readiness timed out',
            remaining
        );
    }
    throw new Error('CSS runtime readiness did not quiesce');
};

try {

// Stop live observers before awaiting any possibly stalled readiness promise.
startCleanup('TalonCssGenericController', 'stop');
startCleanup('listsProceduralFiltererAPI', 'reset');
startCleanup('listsSpecificProceduralFiltererAPI', 'reset');
startCleanup('listsCompiledProceduralFiltererAPI', 'reset');
startCleanup('customProceduralFiltererAPI', 'reset');

await drainReadySets([
    'TalonCssUserReadySet',
    'TalonCssSpecificReadySet',
    'TalonCssProceduralReadySet',
    'TalonCssGenericReadySet',
]).catch(reason => {
    cleanupFailures.push(reason);
});

// Catch controllers published by a startup already past its generation guard.
startCleanup('TalonCssGenericController', 'stop');
startCleanup('listsProceduralFiltererAPI', 'reset');
startCleanup('listsSpecificProceduralFiltererAPI', 'reset');
startCleanup('listsCompiledProceduralFiltererAPI', 'reset');
startCleanup('customProceduralFiltererAPI', 'reset');

if ( self.cssAPI instanceof Object && typeof self.cssAPI.removeAll === 'function' ) {
    try {
        cleanupJobs.push(waitBounded(
            Promise.resolve(self.cssAPI.removeAll()),
            'CSS sheet cleanup timed out'
        ));
    } catch (reason) {
        cleanupFailures.push(reason);
    }
}

const plainSelectors = self.customFilters?.plainSelectors ||
    self.TalonPendingCustomFilterDetails?.plainSelectors;
if (
    self.cssAPI?.supportsScopedOwnership !== true &&
    Array.isArray(plainSelectors) &&
    plainSelectors.length !== 0
) {
    cleanupJobs.push((async () => {
        const declaration = '{display:none!important;}';
        const budget = 100000 - declaration.length;
        const chunks = [];
        let chunk = '';
        for ( const selector of plainSelectors ) {
            if ( typeof selector !== 'string' || selector === '' ) { continue; }
            if ( selector.length > budget ) {
                throw new Error('custom selector exceeds CSS message limit');
            }
            const candidate = chunk === '' ? selector : `${chunk},\n${selector}`;
            if ( candidate.length <= budget ) {
                chunk = candidate;
                continue;
            }
            chunks.push(`${chunk}${declaration}`);
            chunk = selector;
        }
        if ( chunk !== '' ) { chunks.push(`${chunk}${declaration}`); }
        for ( const css of chunks ) {
            let raw;
            try {
                raw = Promise.resolve(chrome.runtime.sendMessage({
                    what: 'removeCSS',
                    css,
                }));
            } catch (reason) {
                throw reason;
            }
            raw.catch(() => {});
            const response = await waitBounded(
                raw,
                'legacy custom CSS cleanup timed out'
            );
            if ( response?.ok !== true ) {
                throw new Error(response?.error || 'remove custom CSS failed');
            }
        }
    })());
}

const cleanupResults = await Promise.allSettled(cleanupJobs);
cleanupFailures.push(...cleanupResults
    .filter(result => result.status === 'rejected')
    .map(result => result.reason));
if ( cleanupFailures.length !== 0 ) {
    throw new AggregateError(
        cleanupFailures,
        'CSS runtime termination was incomplete'
    );
}
self.customFilters = undefined;
self.TalonPendingCustomFilterDetails = undefined;
self.TalonStagedCustomFilterDetails = undefined;

} finally {
    self.TalonCustomCssTerminationDepth = Math.max(
        0,
        (Number(self.TalonCustomCssTerminationDepth) || 1) - 1
    );
    self.TalonCoreCssTerminationDepth = Math.max(
        0,
        (Number(self.TalonCoreCssTerminationDepth) || 1) - 1
    );
}

})();
