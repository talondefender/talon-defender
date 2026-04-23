/******************************************************************************/
// Pure helpers for entitlement and reminder state transitions.
// Keep this file side-effect free so Node tests can import it directly.

export const DEFAULT_TRIAL_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
export const TRIAL_REMINDER_INITIAL_DELAY_MS = 2 * 60 * 1000;
export const TRIAL_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVATION_TOKEN_MAX_LENGTH = 2048;
export const ACTIVATION_TOKEN_DEVICE_LABEL_MAX_LENGTH = 128;

const HARD_DENY_ERROR_CODES = Object.freeze([
    'INVALID_KEY',
    'EXPIRED',
    'REVOKED',
    'MAX_DEVICES',
    'TRIAL_ENDED',
]);

const toNum = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

const normalizePositiveMs = value => {
    const asNum = toNum(value);
    if (asNum !== undefined) { return Math.max(0, asNum); }
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) { return Math.max(0, parsed); }
    }
    return 0;
};

export const normalizeActivationToken = value => {
    if (typeof value !== 'string') { return ''; }
    const token = value.trim();
    if (token === '' || token.length > ACTIVATION_TOKEN_MAX_LENGTH) { return ''; }
    return token;
};

const normalizeActivationTokenDeviceLabel = value => {
    if (typeof value !== 'string') { return ''; }
    return value.trim().slice(0, ACTIVATION_TOKEN_DEVICE_LABEL_MAX_LENGTH);
};

export const sanitizeEntitlementSyncState = (
    input = {},
    { now = Date.now() } = {}
) => {
    const source = input instanceof Object ? input : {};
    const out = {};

    const trialStartMs = normalizePositiveMs(source.trialStartMs);
    if (trialStartMs > 0) {
        out.trialStartMs = trialStartMs;
    }
    const trialEndMs = normalizePositiveMs(source.trialEndMs);
    if (trialEndMs > 0) {
        out.trialEndMs = trialEndMs;
    }

    const activationToken = normalizeActivationToken(source.activationToken);
    const activationTokenExpiresAtMs = normalizePositiveMs(
        source.activationTokenExpiresAtMs ?? source.activationTokenExpiresAt
    );
    if (activationToken !== '' && activationTokenExpiresAtMs > now) {
        out.activationToken = activationToken;
        out.activationTokenExpiresAtMs = activationTokenExpiresAtMs;
        const updatedMs = normalizePositiveMs(source.activationTokenUpdatedMs);
        if (updatedMs > 0) {
            out.activationTokenUpdatedMs = updatedMs;
        }
        const deviceId = typeof source.deviceId === 'string'
            ? source.deviceId.trim().slice(0, 128)
            : '';
        if (deviceId !== '') {
            out.deviceId = deviceId;
        }
        const deviceLabel = normalizeActivationTokenDeviceLabel(source.deviceLabel);
        if (deviceLabel !== '') {
            out.deviceLabel = deviceLabel;
        }
    }

    return out;
};

export const buildActivationTokenSyncPatch = (input = {}, { now = Date.now() } = {}) =>
    sanitizeEntitlementSyncState({
        activationToken: input.activationToken,
        activationTokenExpiresAtMs:
            input.activationTokenExpiresAtMs ??
            input.activationTokenExpiresAt ??
            input.expiresAtMs ??
            input.expiresAt,
        activationTokenUpdatedMs: now,
        deviceId: input.deviceId,
        deviceLabel: input.deviceLabel,
    }, { now });

export const normalizeErrorCode = value => {
    if ( typeof value !== 'string' ) { return ''; }
    return value.trim().toUpperCase();
};

export const isHardDenyErrorCode = value => {
    const code = normalizeErrorCode(value);
    return HARD_DENY_ERROR_CODES.includes(code);
};

export const shouldEnablePaywallForStatus = status => {
    return status?.status === 'expired';
};

export const shouldForceCommunitySyncAfterEntitlementRefresh = ({
    status,
    wasPaywalled = false,
    wasStatusExpired = false,
} = {}) => {
    if ( shouldEnablePaywallForStatus(status) ) { return false; }
    return wasPaywalled === true || wasStatusExpired === true;
};

export const isTrialReminderOnCooldown = ({
    now = Date.now(),
    lastShownMs = 0,
    intervalMs = TRIAL_REMINDER_INTERVAL_MS,
} = {}) => {
    const shown = Number(lastShownMs) || 0;
    if ( shown <= 0 ) { return false; }
    return (now - shown) < intervalMs;
};

export const getTrialReminderWhen = ({
    status,
    now = Date.now(),
    lastShownMs = 0,
    initialDelayMs = TRIAL_REMINDER_INITIAL_DELAY_MS,
    intervalMs = TRIAL_REMINDER_INTERVAL_MS,
} = {}) => {
    if ( status?.status !== 'expired' ) { return null; }

    const shown = Number(lastShownMs) || 0;
    let when = now + initialDelayMs;
    if ( shown > 0 ) {
        when = shown + intervalMs;
    }
    if ( Number.isFinite(when) === false || when <= now ) {
        when = now + initialDelayMs;
    }
    return when;
};

export const shouldRecordTrialReminderShown = openSucceeded => openSucceeded === true;

export const normalizeAndValidateLicenseKey = (
    value,
    { maxLength = 512 } = {}
) => {
    const key = typeof value === 'string' ? value.trim() : '';
    if ( key === '' || key.length > maxLength ) {
        return { ok: false, key: '', error: 'invalid_license_key' };
    }
    return { ok: true, key, error: '' };
};

export const computeEntitlementState = (
    stored = {},
    {
        now = Date.now(),
        trialPeriodMs = DEFAULT_TRIAL_PERIOD_MS,
    } = {}
) => {
    const trialStartMs = toNum(stored.trialStartMs) || 0;
    const trialEndOverrideMs = toNum(stored.trialEndMs) || 0;
    const trialEndMs = trialEndOverrideMs > 0
        ? trialEndOverrideMs
        : (trialStartMs ? (trialStartMs + trialPeriodMs) : 0);

    const entitledUntilMs = toNum(stored.entitledUntilMs) || 0;
    const lastVerifiedMs = toNum(stored.lastVerifiedMs) || 0;
    const graceUntilMs = toNum(stored.graceUntilMs) || 0;

    const deviceId = typeof stored.deviceId === 'string' ? stored.deviceId : '';
    const deviceGroupId = typeof stored.deviceGroupId === 'string' ? stored.deviceGroupId : '';
    const licenseKey = typeof stored.licenseKey === 'string' ? stored.licenseKey.trim() : '';
    const lastErrorCode = normalizeErrorCode(stored.lastErrorCode);
    const lastErrorMessage = typeof stored.lastErrorMessage === 'string' ? stored.lastErrorMessage : '';
    const lastErrorAction = typeof stored.lastErrorAction === 'string' ? stored.lastErrorAction : '';

    const hardDeny = isHardDenyErrorCode(lastErrorCode);
    const paidActive = hardDeny === false && (
        entitledUntilMs > now ||
        (entitledUntilMs > 0 && graceUntilMs > now)
    );
    const trialActive = trialEndMs > now;

    let status = 'expired';
    if ( paidActive ) {
        status = 'paid';
    } else if ( trialActive ) {
        status = 'trial';
    }

    return {
        status,
        now,
        trialStartMs,
        trialEndMs,
        entitledUntilMs,
        lastVerifiedMs,
        graceUntilMs,
        deviceId,
        deviceGroupId,
        licenseKeyPresent: licenseKey !== '',
        lastErrorCode,
        lastErrorMessage,
        lastErrorAction,
    };
};
