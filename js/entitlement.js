/******************************************************************************/
// Trial + subscription entitlement state (paid-only with 7-day trial)

import { browser, localKeys, localRead, localRemove, localWrite, runtime } from './ext.js';
import {
    computeEntitlementState,
    isHardDenyErrorCode,
    normalizeErrorCode,
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
    return trialStartMs > 0 || licenseKey !== '';
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

const syncRead = async key => {
    if (canUseSyncStorage() === false) { return; }
    try {
        const bin = await browser.storage.sync.get(key);
        if (bin instanceof Object === false) { return; }
        return bin[key] ?? undefined;
    } catch {
    }
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

const readEntitlementSync = async () => {
    const stored = await syncRead(ENTITLEMENT_SYNC_STORAGE_KEY);
    if (stored instanceof Object) { return stored; }

    // Migration: if a previous version stored the entitlement blob under a different key,
    // detect and move it without hard-coding the legacy key name.
    if (canUseSyncStorage() === false) { return {}; }
    try {
        const bin = await browser.storage.sync.get(null);
        if (bin instanceof Object) {
            for (const [key, value] of Object.entries(bin)) {
                if (key === ENTITLEMENT_SYNC_STORAGE_KEY) { continue; }
                if (/entitlement/i.test(key) === false) { continue; }
                if (looksLikeEntitlementSync(value) === false) { continue; }
                await syncWrite(ENTITLEMENT_SYNC_STORAGE_KEY, value);
                try { await browser.storage.sync.remove(key); } catch { }
                return value;
            }
        }
    } catch {
    }
    return {};
};

const writeEntitlementSync = async patch => {
    const stored = await readEntitlementSync();
    const next = Object.assign({}, stored, patch);
    await syncWrite(ENTITLEMENT_SYNC_STORAGE_KEY, next);
    return next;
};

const normalizeKey = v => {
    if (typeof v !== 'string') { return ''; }
    const s = v.trim().replace(/\s+/g, '');
    return s.length <= 256 ? s : s.slice(0, 256);
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
    const stored = await localRead(ENTITLEMENT_STORAGE_KEY);
    if (stored instanceof Object) { return stored; }

    // Migration: if a previous version stored the entitlement blob under a different key,
    // detect and move it without hard-coding the legacy key name.
    try {
        const keys = await localKeys();
        if (Array.isArray(keys)) {
            for (const key of keys) {
                if (key === ENTITLEMENT_STORAGE_KEY) { continue; }
                if (/entitlement/i.test(key) === false) { continue; }
                const value = await localRead(key);
                if (looksLikeEntitlementLocal(value) === false) { continue; }
                await localWrite(ENTITLEMENT_STORAGE_KEY, value);
                try { await localRemove(key); } catch { }
                return value;
            }
        }
    } catch {
    }

    return {};
}

export async function writeEntitlement(patch) {
    const stored = await readEntitlement();
    const next = Object.assign({}, stored, patch);
    await localWrite(ENTITLEMENT_STORAGE_KEY, next);
    return next;
}

export async function initEntitlement({ now = Date.now() } = {}) {
    const stored = await readEntitlement();
    const synced = await readEntitlementSync();
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
    const syncedLicenseKey = normalizeKey(synced.licenseKey);
    let localLicenseKeyUpdatedMs = toNum(next.licenseKeyUpdatedMs) || 0;
    let syncedLicenseKeyUpdatedMs = toNum(synced.licenseKeyUpdatedMs) || 0;

    if (localLicenseKey !== '' && localLicenseKeyUpdatedMs === 0) {
        localLicenseKeyUpdatedMs = now;
        next.licenseKeyUpdatedMs = now;
        changed = true;
    }

    if (localLicenseKey === '' && syncedLicenseKey !== '') {
        // Respect an explicit local clear if it is newer than sync state.
        if (localLicenseKeyUpdatedMs > 0 && localLicenseKeyUpdatedMs >= syncedLicenseKeyUpdatedMs) {
            syncPatch = Object.assign(syncPatch || {}, {
                licenseKey: '',
                licenseKeyUpdatedMs: localLicenseKeyUpdatedMs,
            });
        } else {
            next.licenseKey = syncedLicenseKey;
            next.licenseKeyUpdatedMs = syncedLicenseKeyUpdatedMs || now;
            changed = true;
            if (syncedLicenseKeyUpdatedMs === 0) {
                syncPatch = Object.assign(syncPatch || {}, { licenseKeyUpdatedMs: next.licenseKeyUpdatedMs });
            }
        }
    } else if (localLicenseKey !== '' && syncedLicenseKey === '') {
        // Respect an explicit sync clear if it is newer than local state.
        if (syncedLicenseKeyUpdatedMs > 0 && syncedLicenseKeyUpdatedMs > localLicenseKeyUpdatedMs) {
            next.licenseKey = '';
            next.licenseKeyUpdatedMs = syncedLicenseKeyUpdatedMs;
            changed = true;
        } else {
            syncPatch = Object.assign(syncPatch || {}, {
                licenseKey: localLicenseKey,
                licenseKeyUpdatedMs: localLicenseKeyUpdatedMs || now,
            });
        }
    } else if (localLicenseKey !== '' && syncedLicenseKey !== '' && localLicenseKey !== syncedLicenseKey) {
        const chooseSynced = syncedLicenseKeyUpdatedMs >= localLicenseKeyUpdatedMs;
        const chosenKey = chooseSynced ? syncedLicenseKey : localLicenseKey;
        const chosenUpdatedMs = (chooseSynced ? syncedLicenseKeyUpdatedMs : localLicenseKeyUpdatedMs) || now;

        if (chooseSynced) {
            next.licenseKey = chosenKey;
            next.licenseKeyUpdatedMs = chosenUpdatedMs;
            changed = true;
        }

        if (syncedLicenseKey !== chosenKey || syncedLicenseKeyUpdatedMs !== chosenUpdatedMs) {
            syncPatch = Object.assign(syncPatch || {}, {
                licenseKey: chosenKey,
                licenseKeyUpdatedMs: chosenUpdatedMs,
            });
        }
    } else if (localLicenseKey !== '' && syncedLicenseKey === localLicenseKey) {
        if (syncedLicenseKeyUpdatedMs === 0 && localLicenseKeyUpdatedMs) {
            syncPatch = Object.assign(syncPatch || {}, { licenseKeyUpdatedMs: localLicenseKeyUpdatedMs });
        }
        if (localLicenseKeyUpdatedMs === 0 && syncedLicenseKeyUpdatedMs) {
            next.licenseKeyUpdatedMs = syncedLicenseKeyUpdatedMs;
            changed = true;
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
        writeEntitlementSync(syncPatch).catch(() => { });
    }

    return computeEntitlement(next, now);
}

export async function getEntitlementStatus({ now = Date.now() } = {}) {
    const stored = await readEntitlement();
    return computeEntitlement(stored, now);
}

/******************************************************************************/

export async function setLicenseKey(licenseKey) {
    const key = normalizeKey(licenseKey);
    const now = Date.now();
    const next = await writeEntitlement({
        licenseKey: key,
        licenseKeyUpdatedMs: now,
    });
    writeEntitlementSync({ licenseKey: key, licenseKeyUpdatedMs: now }).catch(() => { });
    return next;
}

/******************************************************************************/

export async function clearLicenseKey() {
    const now = Date.now();
    const next = await writeEntitlement({
        licenseKey: '',
        licenseKeyUpdatedMs: now,
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
    });
    writeEntitlementSync({ licenseKey: '', licenseKeyUpdatedMs: now }).catch(() => { });
    return next;
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

export async function verifyLicense({
    endpoint = DEFAULT_VERIFY_ENDPOINT,
    timeoutMs = 8000,
    now = Date.now(),
    force = false,
    replaceDevice = false,
} = {}) {
    const stored = await readEntitlement();
    const licenseKey = normalizeKey(stored.licenseKey);
    if (licenseKey === '') {
        return { ok: false, error: 'no-license' };
    }

    const verifyEndpoint =
        normalizeVerifyEndpoint(endpoint) ||
        normalizeVerifyEndpoint(DEFAULT_VERIFY_ENDPOINT);
    if (verifyEndpoint === '') {
        await writeEntitlement({
            lastVerifiedMs: now,
            lastError: 'bad-endpoint',
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
        });
        return { ok: false, error: 'bad-endpoint' };
    }

    const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);

    const offline = await verifyOfflineLicenseKey(licenseKey, now);
    if (offline?.entitledUntilMs) {
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
        };
        await writeEntitlement(patch);
        return {
            ok: true,
            active: offline.active,
            entitledUntilMs: offline.entitledUntilMs,
            source: 'offline',
        };
    }

    const lastVerifiedMs = toNum(stored.lastVerifiedMs) || 0;
    const lastError = typeof stored.lastError === 'string' ? stored.lastError : '';
    if (force !== true && lastError === '' && (now - lastVerifiedMs) < LICENSE_VERIFY_TTL_MS) {
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
            };
            if (hardDeny) {
                patch.entitledUntilMs = 0;
                patch.graceUntilMs = 0;
                patch.licenseKind = '';
                patch.licenseKid = '';
                patch.licensePlan = '';
            }
            await writeEntitlement(patch);
            return { ok: false, error: code || `http ${res.status}` };
        }
        const json = await res.json().catch(() => null);
        const active = Boolean(json?.active);
        const entitledUntilMs = active ? parseEntitledUntil(json?.entitledUntil) : 0;
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
        };
        await writeEntitlement(patch);
        return { ok: true, active, entitledUntilMs };
    } catch (e) {
        await writeEntitlement({
            lastVerifiedMs: now,
            lastError: `${e?.name || 'error'}`,
            lastErrorCode: '',
            lastErrorMessage: '',
            lastErrorAction: '',
        });
        return { ok: false, error: `${e?.name || e || 'error'}` };
    } finally {
        if (timer !== undefined) {
            try { clearTimeout(timer); } catch { }
        }
    }
}
