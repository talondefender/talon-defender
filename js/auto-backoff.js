export const AUTO_BACKOFF_SIGNAL_WINDOW_MS = 5 * 60 * 1000;
export const AUTO_BACKOFF_SIGNAL_MIN_COUNT = 2;

const SEVERE_BREAKAGE_SIGNALS = new Set([
    'page-shell-hidden',
    'primary-content-hidden',
    'primary-content-collapsed',
    'required-form-hidden',
]);

export function normalizeHttpHostname(url) {
    if ( typeof url !== 'string' || url === '' ) { return ''; }
    try {
        const parsed = new URL(url);
        if ( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) { return ''; }
        return parsed.hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function getDowngradedFilteringMode(level, MODE_COMPLETE, MODE_OPTIMAL, MODE_BASIC) {
    if (level === MODE_COMPLETE) { return MODE_OPTIMAL; }
    if (level === MODE_OPTIMAL) { return MODE_BASIC; }
    return level;
}

export function isSevereBreakageSignal(signal) {
    return SEVERE_BREAKAGE_SIGNALS.has(typeof signal === 'string' ? signal : '');
}

export function sanitizeBreakageDetails(input) {
    if ( input instanceof Object === false ) { return {}; }
    const out = {};
    const copyString = (key, maxLen = 256) => {
        if ( typeof input[key] !== 'string' ) { return; }
        const value = input[key].trim();
        if ( value === '' ) { return; }
        out[key] = value.slice(0, maxLen);
    };
    const copyNumber = key => {
        const value = Number(input[key]);
        if ( Number.isFinite(value) === false ) { return; }
        out[key] = value;
    };

    copyString('category', 64);
    copyString('reason', 128);
    copyString('selector', 256);
    copyString('source', 64);
    copyNumber('beforeHeight');
    copyNumber('afterHeight');
    copyNumber('beforeText');
    copyNumber('afterText');

    return out;
}

export function mergeBreakageEvidenceEntry(current, signalPayload, now = Date.now()) {
    const signal = typeof signalPayload?.signal === 'string'
        ? signalPayload.signal.trim()
        : '';
    if ( signal === '' ) {
        return current instanceof Object ? current : { counts: {}, recent: [] };
    }

    const next = current instanceof Object
        ? {
            counts: { ...(current.counts || {}) },
            recent: Array.isArray(current.recent) ? current.recent.slice(0, 9) : [],
            lastSignalAt: Number(current.lastSignalAt) || 0,
        }
        : { counts: {}, recent: [], lastSignalAt: 0 };

    next.counts[signal] = (Number(next.counts[signal]) || 0) + 1;
    next.lastSignalAt = now;
    next.recent.unshift({
        signal,
        ts: now,
        details: sanitizeBreakageDetails(signalPayload.details),
    });
    next.recent = next.recent.slice(0, 10);
    return next;
}

export function updateSignalCounter(counterMap, hostname, signal, now = Date.now()) {
    const key = `${hostname}::${signal}`;
    const current = counterMap.get(key);
    if ( current && (now - current.firstTs) <= AUTO_BACKOFF_SIGNAL_WINDOW_MS ) {
        current.count += 1;
        counterMap.set(key, current);
        return current;
    }
    const next = { count: 1, firstTs: now };
    counterMap.set(key, next);
    return next;
}

export function shouldTriggerSignalBackoff(signal, counter) {
    if ( isSevereBreakageSignal(signal) ) { return true; }
    return (Number(counter?.count) || 0) >= AUTO_BACKOFF_SIGNAL_MIN_COUNT;
}
