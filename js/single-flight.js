export const createSingleFlightRunner = task => {
    if ( typeof task !== 'function' ) {
        throw new TypeError('task must be a function');
    }

    let inFlight;

    return () => {
        if ( inFlight !== undefined ) { return inFlight; }
        try {
            inFlight = Promise.resolve(task());
        } catch (error) {
            inFlight = Promise.reject(error);
        }
        inFlight = inFlight.finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    };
};
