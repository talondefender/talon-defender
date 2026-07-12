/******************************************************************************/
// Trial + subscription entitlement state (paid-only with 7-day trial)

import { browser, localRemove, localWrite, runtime } from './ext.js';
import {
    buildActivationTokenSyncPatch,
    computeEntitlementState,
    isHardDenyErrorCode,
    normalizeErrorCode,
    sanitizeEntitlementSyncState,
} from './entitlement-logic.js';

/******************************************************************************/

export const ENTITLEMENT_STORAGE_KEY = 'talonEntitlement';
export const ENTITLEMENT_SYNC_STORAGE_KEY = 'talonEntitlementSync';

export const ENTITLEMENT_CHECK_ALARM = 'entitlement-check';
export const ENTITLEMENT_EXPIRE_ALARM = 'entitlement-expire';

export const TRIAL_PERIOD_DAYS = 7;
export const TRIAL_PERIOD_MS = TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;

export const LICENSE_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const LICENSE_GRACE_MS = 72 * 60 * 60 * 1000;
export const LICENSE_VERIFY_RETRY_BASE_MS = 5 * 60 * 1000;
export const LICENSE_VERIFY_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

let entitlementWriteTail = Promise.resolve();
let entitlementSyncWriteTail = Promise.resolve();
let verificationInFlight;

// "deviceGroupId" attempts to count multiple Chrome profiles on one computer as a single device.
// In practice, MV3 service workers have limited access to stable, unique machine identifiers,
// so collisions are possible (two different computers producing the same deviceGroupId).
//
// For strict "3 unique devices" enforcement, keep this disabled so the server counts by deviceId.
const USE_DEVICE_GROUP_ID = false;

export const DEFAULT_VERIFY_ENDPOINT = (() => {
    try {
        const homepageUrl = runtime.getManifest?.()?.homepage_url;
        if (typeof homepageUrl === 'string' && homepageUrl.trim() !== '') {
            const u = new URL(homepageUrl.trim());
            const host = u.hostname.replace(/^www\./i, '');
            if (host !== '') {
                return `${u.protocol}//api.${host}/v1/license/verify`;
            }
        }
    } catch {
    }
    return 'https://api.talondefender.com/v1/license/verify';
})();

const normalizeVerifyEndpoint = value => {
    if (typeof value !== 'string') { return ''; }
    const trimmed = value.trim();
    if (trimmed === '') { return ''; }
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:') { return ''; }
        parsed.hash = '';
        return parsed.toString();
    } catch {
    }
    return '';
};

const normalizeTimeoutMs = value => {
    const n = Number(value);
    if (Number.isFinite(n) === false) { return 8000; }
    return Math.min(20000, Math.max(2000, Math.round(n)));
};

/******************************************************************************/

// Offline license format:
//   AAB1.<base64url(payloadJsonUtf8)>.<base64url(ed25519Signature)>
// where the signature is computed over the decoded payload bytes.
//
// Payload schema (v1):
//   { v: 1, exp: <msSinceEpoch>, plan?: "premium", kid?: "default" }
//
// Set this to your Ed25519 public key (raw 32 bytes, base64-encoded).
const LICENSE_PUBLIC_KEYS_B64 = {
    default: 'BAN2H6/P6pSWNrf0ggTE198UZJzZBz53tpT8gqK5YHk=',
};

try {
    const manifest = runtime.getManifest?.();
    const map = manifest?.talonLicensePublicKeysB64;
    if (map instanceof Object) {
        for (const [kid, value] of Object.entries(map)) {
            if (typeof kid !== 'string' || kid.trim() === '') { continue; }
            if (typeof value !== 'string' || value.trim() === '') { continue; }
            LICENSE_PUBLIC_KEYS_B64[kid.trim()] = value.trim();
        }
    }
    const defaultKey = manifest?.talonLicensePublicKeyB64;
    if (typeof defaultKey === 'string' && defaultKey.trim() !== '') {
        LICENSE_PUBLIC_KEYS_B64.default = defaultKey.trim();
    }
} catch {
}

const toNum = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
};

const looksLikeEntitlementSync = v => {
    if (v instanceof Object === false) { return false; }
    const trialStartMs = toNum(v.trialStartMs) || 0;
    const licenseKey = typeof v.licenseKey === 'string' ? v.licenseKey.trim() : '';
    const activationToken = typeof v.activationToken === 'string'
        ? v.activationToken.trim()
        : '';
    return trialStartMs > 0 || licenseKey !== '' || activationToken !== '';
};

const looksLikeEntitlementLocal = v => {
    if (looksLikeEntitlementSync(v) === false) { return false; }
    const deviceId = typeof v.deviceId === 'string' ? v.deviceId.trim() : '';
    return deviceId.length >= 8;
};

const canUseSyncStorage = () =>
    browser?.storage instanceof Object &&
    browser.storage.sync instanceof Object &&
    typeof browser.storage.sync.get === 'function' &&
    typeof browser.storage.sync.set === 'function';

const isStorageRecord = value =>
    value !== null &&
    value instanceof Object &&
    Array.isArray(value) === false;

const syncRead = async key => {
    if (canUseSyncStorage() === false) { return; }
    const bin = await browser.storage.sync.get(key);
    if (isStorageRecord(bin) === false) {
        throw new Error('entitlement sync storage returned invalid data');
    }
    return Object.hasOwn(bin, key) ? bin[key] : undefined;
};

const syncWrite = async (key, value) => {
    if (canUseSyncStorage() === false) { return; }
    try {
        await browser.storage.sync.set({ [key]: value });
        return true;
    } catch {
    }
    return false;
};

const syncStateChanged = (left, right) =>
    JSON.stringify(left || {}) !== JSON.stringify(right || {});

const nextActivationTokenMutationMs = (stored = {}, now = Date.now()) => {
    const previousMs = Math.max(
        0,
        toNum(stored.activationTokenUpdatedMs) || 0,
        toNum(stored.activationTokenClearedAtMs) || 0
    );
    const currentMs = Math.max(1, toNum(now) || Date.now());
    if ( previousMs >= Number.MAX_SAFE_INTEGER ) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Math.max(currentMs, previousMs + 1);
};

const readAndSanitizeEntitlementSyncValue = async value => {
    const sanitized = sanitizeEntitlementSyncState(value, { now: Date.now() });
    if (syncStateChanged(value, sanitized)) {
        await syncWrite(ENTITLEMENT_SYNC_STORAGE_KEY, sanitized);
    }
    return sanitized;
};

const readEntitlementSync = async () => {
    const stored = await syncRead(ENTITLEMENT_SYNC_STORAGE_KEY);
    if (isStorageRecord(stored)) {
        return readAndSanitizeEntitlementSyncValue(stored);
    }
    if (stored !== undefined) {
        throw new Error('entitlement sync storage contains an invalid record');
    }

    // Migration: if a previous version stored the entitlement blob under a different key,
    // detect and move it without hard-coding the legacy key name.
    if (canUseSyncStorage() === false) { return {}; }
    const bin = await browser.storage.sync.get(null);
    if (isStorageRecord(bin) === false) {
        throw new Error('entitlement sync storage returned invalid migration data');
    }
    for (const [key, value] of Object.entries(bin)) {
        if (key === ENTITLEMENT_SYNC_STORAGE_KEY) { continue; }
        if (/entitlement/i.test(key) === false) { continue; }
        if (looksLikeEntitlementSync(value) === false) { continue; }
        const sanitized = sanitizeEntitlementSyncState(value, { now: Date.now() });
        const written = await syncWrite(ENTITLEMENT_SYNC_STORAGE_KEY, sanitized);
        if (written === false) {
            throw new Error('entitlement sync migration write failed');
        }
        try { await browser.storage.sync.remove(key); } catch { }
        return sanitized;
    }
    return {};
};

const mutateEntitlementSync = mutation => {
    const operation = entitlementSyncWriteTail
        .catch(() => {})
        .then(async () => {
            const stored = await readEntitlementSync();
            const candidate = await mutation(Object.assign({}, stored));
            const next = sanitizeEntitlementSyncState(candidate, {
                now: Date.now(),
            });
            const written = await syncWrite(ENTITLEMENT_SYNC_STORAGE_KEY, next);
            if ( written === false ) {
                throw new Error('entitlement sync write failed');
            }
            return next;
        });
    entitlementSyncWriteTail = operation.catch(() => {});
    return operation;
};

const writeEntitlementSync = patch =>
    mutateEntitlementSync(stored => Object.assign(stored, patch));

const clearActivationTokenSync = minimumClearedAtMs =>
    mutateEntitlementSync(stored => {
        const clearedAtMs = nextActivationTokenMutationMs(
            stored,
            minimumClearedAtMs
        );
        return Object.assign(stored, {
            activationToken: '',
            activationTokenExpiresAtMs: 0,
            activationTokenUpdatedMs: clearedAtMs,
            activationTokenClearedAtMs: clearedAtMs,
        });
    });

const normalizeKey = v => {
    if (typeof v !== 'string') { return ''; }
    const s = v.trim().replace(/\s+/g, '');
    return s.length <= 512 ? s : '';
};

const uuidv4 = () => {
    try {
        if (typeof crypto?.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // RFC 4122 v4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
    ].join('-');
};

/******************************************************************************/

const readPlatformInfo = async () => {
    if (typeof runtime?.getPlatformInfo !== 'function') { return null; }
    return new Promise(resolve => {
        let settled = false;
        const done = value => {
            if (settled) { return; }
            settled = true;
            resolve(value || null);
        };
        try {
            const maybe = runtime.getPlatformInfo(info => done(info));
            if (maybe && typeof maybe.then === 'function') {
                maybe.then(done).catch(() => done(null));
            }
        } catch {
            done(null);
        }
    });
};

const hashStringToHex = async value => {
    if (typeof value !== 'string' || value === '') { return ''; }
    try {
        if (self.crypto?.subtle && typeof TextEncoder !== 'undefined') {
            const bytes = new TextEncoder().encode(value);
            const digest = await self.crypto.subtle.digest('SHA-256', bytes);
            const out = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            return out;
        }
    } catch {
    }
    return '';
};

const buildDeviceGroupSeed = async () => {
    const parts = [];
    const info = await readPlatformInfo();
    if (info instanceof Object) {
        if (typeof info.os === 'string' && info.os) { parts.push(`os:${info.os}`); }
        if (typeof info.arch === 'string' && info.arch) { parts.push(`arch:${info.arch}`); }
        if (typeof info.nacl_arch === 'string' && info.nacl_arch) { parts.push(`nacl:${info.nacl_arch}`); }
    }
    const hc = toNum(self?.navigator?.hardwareConcurrency) || 0;
    const dm = toNum(self?.navigator?.deviceMemory) || 0;
    if (hc) { parts.push(`hc:${hc}`); }
    if (dm) { parts.push(`dm:${dm}`); }
    const platform = typeof self?.navigator?.platform === 'string' ? self.navigator.platform : '';
    if (platform) { parts.push(`platform:${platform}`); }
    let tz = '';
    try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
    }
    if (tz) { parts.push(`tz:${tz}`); }
    return parts.join('|');
};

const computeDeviceGroupId = async (deviceId = '') => {
    const seed = await buildDeviceGroupSeed();
    if (seed) {
        const digest = await hashStringToHex(seed);
        if (digest) { return `dg_${digest}`; }
    }
    return deviceId || uuidv4();
};

/******************************************************************************/

const base64ToBytes = b64 => {
    try {
        const bin = self.atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
        }
        return out;
    } catch {
    }
    return new Uint8Array(0);
};

const base64UrlToBytes = b64url => {
    if (typeof b64url !== 'string' || b64url === '') { return new Uint8Array(0); }
    let s = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad === 2) { s += '=='; }
    else if (pad === 3) { s += '='; }
    else if (pad !== 0) { return new Uint8Array(0); }
    return base64ToBytes(s);
};

const verifyEd25519 = async (publicKeyBytes, messageBytes, signatureBytes) => {
    if (self.crypto?.subtle === undefined) { return false; }
    try {
        const key = await self.crypto.subtle.importKey(
            'raw',
            publicKeyBytes,
            { name: 'Ed25519' },
            false,
            ['verify']
        );
        return self.crypto.subtle.verify(
            { name: 'Ed25519' },
            key,
            signatureBytes,
            messageBytes
        );
    } catch {
    }
    return false;
};

const normalizeLicenseKeyForParsing = v => {
    if (typeof v !== 'string') { return ''; }
    return v.trim().replace(/\s+/g, '');
};

const verifyOfflineLicenseKey = async (licenseKey, now) => {
    const key = normalizeLicenseKeyForParsing(licenseKey);
    if (key.startsWith('AAB1.') === false) { return null; }
    const parts = key.split('.');
    if (parts.length !== 3) { return null; }

    const payloadBytes = base64UrlToBytes(parts[1]);
    const signatureBytes = base64UrlToBytes(parts[2]);
    if (payloadBytes.length === 0 || signatureBytes.length !== 64) { return null; }

    let payloadText = '';
    try {
        payloadText = new TextDecoder().decode(payloadBytes);
    } catch {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(payloadText);
    } catch {
        return null;
    }
    if (payload instanceof Object === false) { return null; }
    if (Number(payload.v) !== 1) { return null; }

    const kid = typeof payload.kid === 'string' && payload.kid.trim() !== ''
        ? payload.kid.trim()
        : 'default';
    const pubB64 = LICENSE_PUBLIC_KEYS_B64[kid];
    if (typeof pubB64 !== 'string' || pubB64.trim() === '') { return null; }
    const publicKeyBytes = base64ToBytes(pubB64.trim());
    if (publicKeyBytes.length !== 32) { return null; }

    const ok = await verifyEd25519(publicKeyBytes, payloadBytes, signatureBytes);
    if (ok !== true) { return null; }

    const exp = toNum(payload.exp) || 0;
    if (exp <= 0) { return null; }

    return {
        active: exp > now,
        entitledUntilMs: exp,
        plan: typeof payload.plan === 'string' ? payload.plan : undefined,
        kid,
    };
};

/******************************************************************************/

export function computeEntitlement(stored = {}, now = Date.now()) {
    return computeEntitlementState(stored, {
        now,
        trialPeriodMs: TRIAL_PERIOD_MS,
    });
}

/******************************************************************************/

export async function readEntitlement() {
    const localStorage = browser?.storage?.local;
    if (
        localStorage instanceof Object === false ||
        typeof localStorage.get !== 'function'
    ) {
        throw new Error('entitlement local storage API unavailable');
    }

    // Do not turn a transient storage read failure into a new trial or an
    // empty license record. Callers must be able to distinguish "missing"
    // from "Chrome could not read storage".
    const primaryBin = await localStorage.get(ENTITLEMENT_STORAGE_KEY);
    if (isStorageRecord(primaryBin) === false) {
        throw new Error('entitlement local storage returned invalid data');
    }
    const stored = primaryBin[ENTITLEMENT_STORAGE_KEY];
    if (isStorageRecord(stored)) { return stored; }
    if (stored !== undefined) {
        throw new Error('entitlement local storage contains an invalid record');
    }

    // Migration: if a previous version stored the entitlement blob under a different key,
    // detect and move it without hard-coding the legacy key name.
    const allStored = await localStorage.get(null);
    if (isStorageRecord(allStored) === false) {
        throw new Error('entitlement local storage returned invalid migration data');
    }
    for (const [ key, value ] of Object.entries(allStored)) {
        if (key === ENTITLEMENT_STORAGE_KEY) { continue; }
        if (/entitlement/i.test(key) === false) { continue; }
        if (looksLikeEntitlementLocal(value) === false) { continue; }
        await localWrite(ENTITLEMENT_STORAGE_KEY, value);
        try { await localRemove(key); } catch { }
        return value;
    }

    return {};
}

const mutateEntitlement = (mutation, { afterWrite } = {}) => {
    const operation = entitlementWriteTail
        .catch(() => {})
        .then(async () => {
            const stored = await readEntitlement();
            const next = await mutation(Object.assign({}, stored));
            if ( next === undefined ) {
                return { applied: false, value: stored };
            }
            await localWrite(ENTITLEMENT_STORAGE_KEY, next);
            if ( typeof afterWrite === 'function' ) {
                await afterWrite(next);
            }
            return { applied: true, value: next };
        });
    entitlementWriteTail = operation.catch(() => {});
    return operation;
};

const clearActivationTokenWhileLocked = async (stored, minimumClearedAtMs) => {
    let synced;
    try {
        synced = await clearActivationTokenSync(minimumClearedAtMs);
    } catch {
        // The local tombstone is authoritative for this profile. Sync is a
        // best-effort convenience and must never make a local clear fail.
        return minimumClearedAtMs;
    }
    const syncedClearedAtMs = toNum(synced?.activationTokenClearedAtMs) || 0;
    if ( syncedClearedAtMs <= minimumClearedAtMs ) {
        return minimumClearedAtMs;
    }
    Object.assign(stored, {
        activationToken: '',
        activationTokenExpiresAtMs: 0,
        activationTokenUpdatedMs: syncedClearedAtMs,
        activationTokenClearedAtMs: syncedClearedAtMs,
    });
    try {
        await localWrite(ENTITLEMENT_STORAGE_KEY, stored);
    } catch {
        // The first local tombstone remains safe; startup will merge the
        // newer sync tombstone when local storage is writable again.
    }
    return syncedClearedAtMs;
};

export async function writeEntitlement(patch) {
    const result = await mutateEntitlement(stored => Object.assign(stored, patch));
    return result.value;
}

const writeVerificationResult = async ({
    licenseKey,
    licenseKeyUpdatedMs,
    licenseRevision,
    patch,
    activationTokenSyncPatch,
    activationTokenClearAtMs,
}) => {
    const result = await mutateEntitlement(stored => {
        if ( normalizeKey(stored.licenseKey) !== licenseKey ) { return; }
        if ( (toNum(stored.licenseKeyUpdatedMs) || 0) !== licenseKeyUpdatedMs ) { return; }
        if ( (toNum(stored.licenseRevision) || 0) !== licenseRevision ) { return; }
        return Object.assign(stored, patch);
    }, {
        afterWrite: async stored => {
            if ( activationTokenSyncPatch instanceof Object ) {
                await writeEntitlementSync(activationTokenSyncPatch).catch(() => { });
                return;
            }
            if ( (toNum(activationTokenClearAtMs) || 0) > 0 ) {
                await clearActivationTokenWhileLocked(
                    stored,
                    activationTokenClearAtMs
                );
            }
        },
    });
    return result.applied;
};

async function initEntitlementNow({ now = Date.now() } = {}) {
    const stored = await readEntitlement();
    // Sync is a convenience layer. A transient sync read must not block use of
    // the last known-good local entitlement, and any later sync mutation will
    // perform its own strict read before writing.
    const synced = await readEntitlementSync().catch(() => ({}));
    let changed = false;
    const next = Object.assign({}, stored);
    let syncPatch = null;

    const localTrialStartMs = toNum(next.trialStartMs) || 0;
    const syncedTrialStartMs = toNum(synced.trialStartMs) || 0;
    const chosenTrialStartMs = localTrialStartMs && syncedTrialStartMs
        ? Math.min(localTrialStartMs, syncedTrialStartMs)
        : (localTrialStartMs || syncedTrialStartMs || now);

    if (chosenTrialStartMs !== localTrialStartMs) {
        next.trialStartMs = chosenTrialStartMs;
        changed = true;
    }
    if (chosenTrialStartMs !== syncedTrialStartMs) {
        syncPatch = Object.assign(syncPatch || {}, { trialStartMs: chosenTrialStartMs });
    }

    const localTrialEndMs = toNum(next.trialEndMs) || 0;
    const syncedTrialEndMs = toNum(synced.trialEndMs) || 0;
    const chosenTrialEndMs = localTrialEndMs && syncedTrialEndMs
        ? Math.min(localTrialEndMs, syncedTrialEndMs)
        : (localTrialEndMs || syncedTrialEndMs);

    if (chosenTrialEndMs && chosenTrialEndMs !== localTrialEndMs) {
        next.trialEndMs = chosenTrialEndMs;
        changed = true;
    }
    if (chosenTrialEndMs && chosenTrialEndMs !== syncedTrialEndMs) {
        syncPatch = Object.assign(syncPatch || {}, { trialEndMs: chosenTrialEndMs });
    }

    const localLicenseKey = normalizeKey(next.licenseKey);
    let localLicenseKeyUpdatedMs = toNum(next.licenseKeyUpdatedMs) || 0;

    if (localLicenseKey !== '' && localLicenseKeyUpdatedMs === 0) {
        localLicenseKeyUpdatedMs = now;
        next.licenseKeyUpdatedMs = now;
        changed = true;
    }

    const localActivation = sanitizeEntitlementSyncState(next, { now });
    const syncedActivation = sanitizeEntitlementSyncState(synced, { now });
    const localActivationUpdatedMs = toNum(localActivation.activationTokenUpdatedMs) || 0;
    const syncedActivationUpdatedMs = toNum(syncedActivation.activationTokenUpdatedMs) || 0;
    const activationTokenClearedAtMs = Math.max(
        toNum(localActivation.activationTokenClearedAtMs) || 0,
        toNum(syncedActivation.activationTokenClearedAtMs) || 0
    );
    if (
        activationTokenClearedAtMs > 0 &&
        (toNum(next.activationTokenClearedAtMs) || 0) !== activationTokenClearedAtMs
    ) {
        next.activationTokenClearedAtMs = activationTokenClearedAtMs;
        changed = true;
    }
    const localActivationIsCurrent =
        Boolean(localActivation.activationToken) &&
        localActivationUpdatedMs > activationTokenClearedAtMs;
    const syncedActivationIsCurrent =
        Boolean(syncedActivation.activationToken) &&
        syncedActivationUpdatedMs > activationTokenClearedAtMs;
    const chooseSyncedActivation = (
        syncedActivationIsCurrent &&
        (
            localActivationIsCurrent === false ||
            syncedActivationUpdatedMs >= localActivationUpdatedMs
        )
    );
    const chosenActivation = chooseSyncedActivation
        ? syncedActivation
        : (localActivationIsCurrent ? localActivation : {});
    if (chosenActivation.activationToken) {
        for (const key of [
            'activationToken',
            'activationTokenExpiresAtMs',
            'activationTokenUpdatedMs',
        ]) {
            if (chosenActivation[key] === undefined) { continue; }
            if (next[key] === chosenActivation[key]) { continue; }
            next[key] = chosenActivation[key];
            changed = true;
        }
        const expiresAt = toNum(chosenActivation.activationTokenExpiresAtMs) || 0;
        if (expiresAt > now) {
            if ((toNum(next.entitledUntilMs) || 0) < expiresAt) {
                next.entitledUntilMs = expiresAt;
                changed = true;
            }
            if ((toNum(next.graceUntilMs) || 0) < expiresAt) {
                next.graceUntilMs = expiresAt;
                changed = true;
            }
            if (next.licenseKind !== 'activation-token' && localLicenseKey === '') {
                next.licenseKind = 'activation-token';
                changed = true;
            }
        }
        if (syncStateChanged(syncedActivation, chosenActivation)) {
            syncPatch = Object.assign(syncPatch || {}, chosenActivation);
        }
    } else {
        for ( const key of [
            'activationToken',
            'activationTokenExpiresAtMs',
            'activationTokenUpdatedMs',
        ] ) {
            if ( next[key] === undefined || next[key] === '' || next[key] === 0 ) { continue; }
            next[key] = key === 'activationToken' ? '' : 0;
            changed = true;
        }
        if ( activationTokenClearedAtMs > 0 ) {
            syncPatch = Object.assign(syncPatch || {}, {
                activationToken: '',
                activationTokenExpiresAtMs: 0,
                activationTokenUpdatedMs: activationTokenClearedAtMs,
                activationTokenClearedAtMs,
            });
        }
        if ( localLicenseKey === '' && next.licenseKind === 'activation-token' ) {
            for ( const [ key, value ] of [
                [ 'entitledUntilMs', 0 ],
                [ 'graceUntilMs', 0 ],
                [ 'licenseKind', '' ],
                [ 'licenseKid', '' ],
                [ 'licensePlan', '' ],
            ] ) {
                if ( next[key] === value ) { continue; }
                next[key] = value;
                changed = true;
            }
        }
    }

    if (typeof next.deviceId !== 'string' || next.deviceId.trim().length < 8) {
        next.deviceId = uuidv4();
        changed = true;
    }

    if (USE_DEVICE_GROUP_ID) {
        if (typeof next.deviceGroupId !== 'string' || next.deviceGroupId.trim().length < 8) {
            next.deviceGroupId = await computeDeviceGroupId(next.deviceId);
            changed = true;
        }
    }

    if (changed) {
        await localWrite(ENTITLEMENT_STORAGE_KEY, next);
    }

    if (syncPatch) {
        await writeEntitlementSync(syncPatch).catch(() => { });
    }

    return computeEntitlement(next, now);
}

export function initEntitlement(options = {}) {
    const operation = entitlementWriteTail
        .catch(() => {})
        .then(() => initEntitlementNow(options));
    entitlementWriteTail = operation.catch(() => {});
    return operation;
}

export async function getEntitlementStatus({ now = Date.now() } = {}) {
    const stored = await readEntitlement();
    return computeEntitlement(stored, now);
}

/******************************************************************************/

export async function setLicenseKey(licenseKey) {
    const key = normalizeKey(licenseKey);
    const now = Date.now();
    let activationTokenClearAtMs = 0;
    const result = await mutateEntitlement(stored => {
        const keyChanged = normalizeKey(stored.licenseKey) !== key;
        const licenseRevision = (toNum(stored.licenseRevision) || 0) + 1;
        const patch = {
            licenseKey: key,
            licenseKeyUpdatedMs: now,
            licenseRevision,
            lastVerifiedMs: 0,
            verifyFailureCount: 0,
            nextVerifyAttemptMs: 0,
            lastError: '',
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
        };
        if ( keyChanged ) {
            const clearedAtMs = nextActivationTokenMutationMs(stored, now);
            Object.assign(patch, {
                entitledUntilMs: 0,
                graceUntilMs: 0,
                licenseKind: '',
                licenseKid: '',
                licensePlan: '',
                activationToken: '',
                activationTokenExpiresAtMs: 0,
                activationTokenUpdatedMs: clearedAtMs,
                activationTokenClearedAtMs: clearedAtMs,
            });
            activationTokenClearAtMs = clearedAtMs;
        }
        return Object.assign(stored, patch);
    }, {
        afterWrite: async stored => {
            if ( activationTokenClearAtMs <= 0 ) { return; }
            await clearActivationTokenWhileLocked(
                stored,
                activationTokenClearAtMs
            );
        },
    });
    return result.value;
}

/******************************************************************************/

export async function clearLicenseKey() {
    const now = Date.now();
    let activationTokenClearAtMs = 0;
    const result = await mutateEntitlement(stored => {
        const licenseRevision = (toNum(stored.licenseRevision) || 0) + 1;
        const clearedAtMs = nextActivationTokenMutationMs(stored, now);
        activationTokenClearAtMs = clearedAtMs;
        return Object.assign(stored, {
            licenseKey: '',
            licenseKeyUpdatedMs: now,
            licenseRevision,
            lastVerifiedMs: 0,
            entitledUntilMs: 0,
            graceUntilMs: 0,
            lastError: '',
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
            licenseKind: '',
            licenseKid: '',
            licensePlan: '',
            activationToken: '',
            activationTokenExpiresAtMs: 0,
            activationTokenUpdatedMs: clearedAtMs,
            activationTokenClearedAtMs: clearedAtMs,
            verifyFailureCount: 0,
            nextVerifyAttemptMs: 0,
        });
    }, {
        afterWrite: stored => clearActivationTokenWhileLocked(
            stored,
            activationTokenClearAtMs
        ),
    });
    return result.value;
}

/******************************************************************************/

const parseEntitledUntil = value => {
    const asNum = toNum(value);
    if (asNum !== undefined) { return asNum; }
    if (typeof value === 'string') {
        const ts = Date.parse(value);
        if (Number.isFinite(ts)) { return ts; }
    }
    return 0;
};

const ensureDeviceGroupId = async (stored, deviceId) => {
    const existing = typeof stored.deviceGroupId === 'string' ? stored.deviceGroupId.trim() : '';
    if (existing.length >= 8) { return existing; }
    const computed = await computeDeviceGroupId(deviceId);
    await writeEntitlement({ deviceGroupId: computed });
    return computed;
};

const getVerificationFailurePatch = (stored, now) => {
    const previousFailureCount = Math.max(
        0,
        Math.floor(toNum(stored.verifyFailureCount) || 0)
    );
    const failureCount = Math.min(16, previousFailureCount + 1);
    const exponentialDelay = Math.min(
        LICENSE_VERIFY_RETRY_MAX_MS,
        LICENSE_VERIFY_RETRY_BASE_MS * (2 ** Math.max(0, failureCount - 1))
    );
    const jitter = 0.85 + (Math.random() * 0.30);
    const retryDelay = Math.min(
        LICENSE_VERIFY_RETRY_MAX_MS,
        Math.max(1, Math.round(exponentialDelay * jitter))
    );
    return {
        verifyFailureCount: failureCount,
        nextVerifyAttemptMs: now + retryDelay,
    };
};

const VERIFICATION_SUCCESS_PATCH = Object.freeze({
    verifyFailureCount: 0,
    nextVerifyAttemptMs: 0,
});

async function verifyLicenseNow({
    endpoint = DEFAULT_VERIFY_ENDPOINT,
    timeoutMs = 8000,
    now = Date.now(),
    force = false,
    replaceDevice = false,
} = {}) {
    const stored = await readEntitlement();
    const licenseKey = normalizeKey(stored.licenseKey);
    const licenseKeyUpdatedMs = toNum(stored.licenseKeyUpdatedMs) || 0;
    const licenseRevision = toNum(stored.licenseRevision) || 0;
    if (licenseKey === '') {
        return { ok: false, error: 'no-license' };
    }

    const verifyEndpoint =
        normalizeVerifyEndpoint(endpoint) ||
        normalizeVerifyEndpoint(DEFAULT_VERIFY_ENDPOINT);
    if (verifyEndpoint === '') {
        await writeVerificationResult({
            licenseKey,
            licenseKeyUpdatedMs,
            licenseRevision,
            patch: {
                lastVerifiedMs: now,
                lastError: 'bad-endpoint',
                lastErrorCode: '',
                lastErrorMessage: '',
                lastErrorAction: '',
                ...getVerificationFailurePatch(stored, now),
            },
        });
        return { ok: false, error: 'bad-endpoint' };
    }

    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);

    const offline = await verifyOfflineLicenseKey(licenseKey, now);
    if (offline?.entitledUntilMs) {
        const activationTokenClearedAtMs = nextActivationTokenMutationMs(stored, now);
        const patch = {
            lastVerifiedMs: now,
            entitledUntilMs: offline.active ? offline.entitledUntilMs : 0,
            graceUntilMs: offline.active ? offline.entitledUntilMs : 0,
            lastError: '',
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
            licenseKind: 'offline',
            licenseKid: offline.kid,
            licensePlan: offline.plan,
            activationToken: '',
            activationTokenExpiresAtMs: 0,
            activationTokenUpdatedMs: activationTokenClearedAtMs,
            activationTokenClearedAtMs,
        };
        Object.assign(patch, VERIFICATION_SUCCESS_PATCH);
        const applied = await writeVerificationResult({
            licenseKey,
            licenseKeyUpdatedMs,
            licenseRevision,
            patch,
            activationTokenClearAtMs: activationTokenClearedAtMs,
        });
        if ( applied === false ) { return { ok: false, skipped: 'stale' }; }
        return {
            ok: true,
            active: offline.active,
            entitledUntilMs: offline.entitledUntilMs,
            source: 'offline',
        };
    }

    const lastVerifiedMs = toNum(stored.lastVerifiedMs) || 0;
    const lastError = typeof stored.lastError === 'string' ? stored.lastError : '';
    const nextVerifyAttemptMs = toNum(stored.nextVerifyAttemptMs) || 0;
    const retryDelayRemaining = nextVerifyAttemptMs - now;
    if (
        force !== true &&
        retryDelayRemaining > 0 &&
        retryDelayRemaining <= LICENSE_VERIFY_RETRY_MAX_MS
    ) {
        return { ok: false, skipped: 'backoff', retryAt: nextVerifyAttemptMs };
    }
    if (
        force !== true &&
        lastError === '' &&
        lastVerifiedMs > 0 &&
        lastVerifiedMs <= now &&
        (now - lastVerifiedMs) < LICENSE_VERIFY_TTL_MS
    ) {
        return { ok: true, skipped: 'fresh' };
    }

    const deviceId = typeof stored.deviceId === 'string' ? stored.deviceId : '';
    const deviceGroupId = USE_DEVICE_GROUP_ID ? await ensureDeviceGroupId(stored, deviceId) : '';
    const version = runtime.getManifest()?.version || '';

    let controller;
    let timer;
    try {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    } catch {
        controller = undefined;
        timer = undefined;
    }

    try {
        const res = await fetch(verifyEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                licenseKey,
                deviceId,
                ...(deviceGroupId ? { deviceGroupId } : {}),
                version,
                ...(replaceDevice ? { replaceDevice: true } : {}),
            }),
            signal: controller?.signal,
            cache: 'no-store',
            redirect: 'error',
        });
        if (res.ok === false) {
            const json = await res.json().catch(() => null);
            const code = normalizeErrorCode(json?.error);
            const message = typeof json?.message === 'string' ? json.message : '';
            const action = typeof json?.action === 'string' ? json.action : '';
            const hardDeny = isHardDenyErrorCode(code);
            const patch = {
                lastVerifiedMs: now,
                lastError: code || `http ${res.status}`,
                lastErrorCode: code,
                lastErrorMessage: message,
                lastErrorAction: action,
                ...getVerificationFailurePatch(stored, now),
            };
            if (hardDeny) {
                const activationTokenClearedAtMs = nextActivationTokenMutationMs(
                    stored,
                    now
                );
                patch.entitledUntilMs = 0;
                patch.graceUntilMs = 0;
                patch.licenseKind = '';
                patch.licenseKid = '';
                patch.licensePlan = '';
                patch.activationToken = '';
                patch.activationTokenExpiresAtMs = 0;
                patch.activationTokenUpdatedMs = activationTokenClearedAtMs;
                patch.activationTokenClearedAtMs = activationTokenClearedAtMs;
            }
            const applied = await writeVerificationResult({
                licenseKey,
                licenseKeyUpdatedMs,
                licenseRevision,
                patch,
                activationTokenClearAtMs: hardDeny
                    ? patch.activationTokenClearedAtMs
                    : 0,
            });
            if ( applied === false ) { return { ok: false, skipped: 'stale' }; }
            return { ok: false, error: code || `http ${res.status}` };
        }
        const json = await res.json().catch(() => null);
        if ( json instanceof Object === false || typeof json.active !== 'boolean' ) {
            const error = new Error('invalid-response');
            error.code = 'invalid-response';
            throw error;
        }
        const active = json.active === true;
        const activationTokenUpdatedMs = nextActivationTokenMutationMs(stored, now);
        const activationTokenPatch = active
            ? buildActivationTokenSyncPatch(json, {
                now,
                updatedMs: activationTokenUpdatedMs,
            })
            : {};
        const responseEntitledUntilMs = active
            ? parseEntitledUntil(json.entitledUntil)
            : 0;
        const activationTokenExpiresAtMs = toNum(
            activationTokenPatch.activationTokenExpiresAtMs
        ) || 0;
        const entitledUntilMs = active
            ? Math.max(responseEntitledUntilMs, activationTokenExpiresAtMs)
            : 0;
        if ( active && entitledUntilMs <= now ) {
            const error = new Error('invalid-response');
            error.code = 'invalid-response';
            throw error;
        }
        const activationTokenLocalPatch = activationTokenPatch.activationToken
            ? {
                activationToken: activationTokenPatch.activationToken,
                activationTokenExpiresAtMs: activationTokenPatch.activationTokenExpiresAtMs,
                activationTokenUpdatedMs: activationTokenPatch.activationTokenUpdatedMs,
                activationTokenClearedAtMs:
                    toNum(stored.activationTokenClearedAtMs) || 0,
            }
            : {};
        const patch = {
            lastVerifiedMs: now,
            entitledUntilMs,
            graceUntilMs: active && entitledUntilMs
                ? Math.max(entitledUntilMs, now + LICENSE_GRACE_MS)
                : 0,
            lastError: '',
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
            licenseKind: 'remote',
            licenseKid: '',
            licensePlan: typeof json?.plan === 'string' ? json.plan : '',
            ...VERIFICATION_SUCCESS_PATCH,
            ...activationTokenLocalPatch,
        };
        if (activationTokenPatch.activationToken === undefined) {
            patch.activationToken = '';
            patch.activationTokenExpiresAtMs = 0;
            patch.activationTokenUpdatedMs = activationTokenUpdatedMs;
            patch.activationTokenClearedAtMs = activationTokenUpdatedMs;
        }
        const applied = await writeVerificationResult({
            licenseKey,
            licenseKeyUpdatedMs,
            licenseRevision,
            patch,
            activationTokenSyncPatch: active && activationTokenPatch.activationToken
                ? activationTokenPatch
                : undefined,
            activationTokenClearAtMs: activationTokenPatch.activationToken
                ? 0
                : patch.activationTokenClearedAtMs,
        });
        if ( applied === false ) { return { ok: false, skipped: 'stale' }; }
        return { ok: true, active, entitledUntilMs };
    } catch (e) {
        const error = `${e?.code || e?.name || e || 'error'}`;
        const failurePatch = {
            lastVerifiedMs: now,
            lastError: error,
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
            ...getVerificationFailurePatch(stored, now),
        };
        const applied = await writeVerificationResult({
            licenseKey,
            licenseKeyUpdatedMs,
            licenseRevision,
            patch: failurePatch,
        });
        if ( applied === false ) { return { ok: false, skipped: 'stale' }; }
        return { ok: false, error };
    } finally {
        if (timer !== undefined) {
            try { clearTimeout(timer); } catch { }
        }
    }
}

export function verifyLicense(options = {}) {
    const normalizedOptions = options instanceof Object ? options : {};
    if ( verificationInFlight instanceof Promise ) {
        if (
            normalizedOptions.force !== true &&
            normalizedOptions.replaceDevice !== true
        ) {
            return verificationInFlight;
        }
        return verificationInFlight
            .catch(() => {})
            .then(() => verifyLicense(normalizedOptions));
    }
    const operation = verifyLicenseNow(normalizedOptions);
    verificationInFlight = operation.finally(() => {
        if ( verificationInFlight === trackedOperation ) {
            verificationInFlight = undefined;
        }
    });
    const trackedOperation = verificationInFlight;
    return trackedOperation;
}
