/******************************************************************************/
// Important!
// Isolate from global scope
(function talonCooperativeScheduler() {

if ( self.TalonCooperativeScheduler instanceof Object ) { return; }

const FRAME_BUDGET_MS = 4;
const monotonicNow = typeof self.performance?.now === 'function'
    ? self.performance.now.bind(self.performance)
    : Date.now;
const requestFrame = typeof self.requestAnimationFrame === 'function'
    ? self.requestAnimationFrame.bind(self)
    : callback => self.setTimeout(callback, 16);
const cancelFrame = typeof self.cancelAnimationFrame === 'function'
    ? self.cancelAnimationFrame.bind(self)
    : timer => self.clearTimeout(timer);

let queuedJobs = [];
let frameTimer;
let nextJobId = 1;

const scheduleFrame = () => {
    if ( frameTimer !== undefined || queuedJobs.length === 0 ) { return; }
    frameTimer = requestFrame(runFrame);
};

const runFrame = () => {
    frameTimer = undefined;
    const deadline = monotonicNow() + FRAME_BUDGET_MS;
    const frameJobs = queuedJobs;
    queuedJobs = [];
    let index = 0;
    for ( ; index < frameJobs.length; index++ ) {
        const job = frameJobs[index];
        if ( job.cancelled ) { continue; }
        if ( monotonicNow() >= deadline ) { break; }
        job.running = true;
        try {
            job.callback(deadline);
        } catch {
        } finally {
            job.running = false;
            job.completed = true;
        }
    }
    if ( index < frameJobs.length ) {
        queuedJobs = frameJobs.slice(index).concat(queuedJobs);
    }
    scheduleFrame();
};

const schedule = callback => {
    if ( typeof callback !== 'function' ) { return undefined; }
    const job = {
        id: nextJobId++,
        callback,
        cancelled: false,
        completed: false,
        running: false,
    };
    queuedJobs.push(job);
    scheduleFrame();
    return job;
};

const cancel = job => {
    if ( job instanceof Object === false || job.cancelled ) { return false; }
    job.cancelled = true;
    if ( frameTimer !== undefined && queuedJobs.every(entry => entry.cancelled) ) {
        try { cancelFrame(frameTimer); } catch {
        }
        frameTimer = undefined;
        queuedJobs = [];
    }
    return true;
};

self.TalonCooperativeScheduler = Object.freeze({
    FRAME_BUDGET_MS,
    cancel,
    schedule,
});

})();

void 0;
