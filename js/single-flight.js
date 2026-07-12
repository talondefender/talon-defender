export const createSingleFlightRunner = (task, options = {}) => {
    if ( typeof task !== 'function' ) {
        throw new TypeError('task must be a function');
    }

    const rerunOnConcurrent = options?.trailing === true;
    let inFlight;
    let rerunRequested = false;

    const finishFlight = async (flight, outcome) => {
        if ( inFlight === flight ) {
            inFlight = undefined;
            // A caller can arrive after the drain loop's final condition but
            // before its promise reaction runs. Hand that request to a new
            // flight and make every observer of the old flight await it too.
            if ( rerunOnConcurrent && rerunRequested ) {
                return run();
            }
        }
        if ( outcome.ok === false ) { throw outcome.error; }
        return outcome.value;
    };

    const run = () => {
        if ( inFlight !== undefined ) {
            if ( rerunOnConcurrent ) { rerunRequested = true; }
            return inFlight;
        }
        const taskFlight = (async () => {
            let result;
            let lastError;
            do {
                rerunRequested = false;
                try {
                    result = await task();
                    lastError = undefined;
                } catch (error) {
                    lastError = error;
                }
            } while ( rerunOnConcurrent && rerunRequested );
            if ( lastError !== undefined ) { throw lastError; }
            return result;
        })();
        let flight;
        flight = taskFlight.then(
            value => finishFlight(flight, { ok: true, value }),
            error => finishFlight(flight, { ok: false, error })
        );
        inFlight = flight;
        return inFlight;
    };
    run.waitForIdle = async () => {
        while ( inFlight !== undefined ) {
            const observed = inFlight;
            await observed.then(() => undefined, () => undefined);
            if ( inFlight === observed ) {
                // Defensive: finishFlight normally clears or hands off before
                // settlement, but never let a stale rejected flight pin idle.
                inFlight = undefined;
            }
        }
    };
    run.isRunning = () => inFlight !== undefined;
    return run;
};
