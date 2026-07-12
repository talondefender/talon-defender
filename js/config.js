/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    browser,
    localWrite,
    runtime,
    sessionWrite,
    webextFlavor,
} from './ext.js';

/******************************************************************************/

export const rulesetConfig = {
    configRevision: 0,
    version: '',
    rulesetSelectionVersion: 0,
    enabledRulesets: [],
    autoReload: true,
    showBlockedCount: false,
    strictBlockMode: webextFlavor !== 'safari',
    popupBlockMode: true,
    developerMode: false,
    hasBroadHostPermissions: true,
    communityRulesEnabled: true,
    communityRulesURL: '',
};

export const defaultConfig = Object.assign({}, rulesetConfig);

let managedStrictBlockMode;

export const setManagedStrictBlockMode = value => {
    managedStrictBlockMode = typeof value === 'boolean' ? value : undefined;
    return getEffectiveStrictBlockMode();
};

export const getEffectiveStrictBlockMode = () =>
    managedStrictBlockMode ?? rulesetConfig.strictBlockMode;

export const isStrictBlockModeManaged = () =>
    managedStrictBlockMode !== undefined;

export const isDeveloperModeAllowed = (( ) => {
    try {
        const permissions = runtime.getManifest?.()?.permissions;
        return Array.isArray(permissions) &&
            permissions.includes('declarativeNetRequestFeedback');
    } catch {
    }
    return false;
})();

export const process = {
    firstRun: false,
    wakeupRun: false,
};

export const INITIAL_SETUP_PENDING_KEY = 'initialSetupPendingV1';

let pendingOpPromise = Promise.resolve();

const isStoredConfig = value => value instanceof Object && Array.isArray(value) === false;

const rulesetConfigKeys = Object.freeze(Object.keys(defaultConfig));
const rulesetConfigKeySet = new Set(rulesetConfigKeys);

const validateStoredConfigRecord = (value, areaName) => {
    if ( value === undefined ) { return false; }
    if ( isStoredConfig(value) === false ) {
        throw new Error(`invalid ${areaName} rulesetConfig record`);
    }
    if ( Object.hasOwn(value, 'enabledRulesets') === false ) {
        throw new Error(`invalid ${areaName} rulesetConfig record`);
    }
    if (
        Object.hasOwn(value, 'configRevision') &&
        (
            Number.isSafeInteger(value.configRevision) === false ||
            value.configRevision < 0
        )
    ) {
        throw new Error(`invalid ${areaName} rulesetConfig configRevision`);
    }
    if (
        Object.hasOwn(value, 'rulesetSelectionVersion') &&
        (
            Number.isSafeInteger(value.rulesetSelectionVersion) === false ||
            value.rulesetSelectionVersion < 0
        )
    ) {
        throw new Error(`invalid ${areaName} rulesetConfig rulesetSelectionVersion`);
    }
    if (
        Object.hasOwn(value, 'enabledRulesets') &&
        (
            Array.isArray(value.enabledRulesets) === false ||
            value.enabledRulesets.some(id => typeof id !== 'string')
        )
    ) {
        throw new Error(`invalid ${areaName} rulesetConfig enabledRulesets`);
    }
    for ( const key of [ 'version', 'communityRulesURL' ] ) {
        if ( Object.hasOwn(value, key) === false ) { continue; }
        if ( typeof value[key] === 'string' ) { continue; }
        throw new Error(`invalid ${areaName} rulesetConfig ${key}`);
    }
    for ( const key of [
        'autoReload',
        'showBlockedCount',
        'strictBlockMode',
        'popupBlockMode',
        'developerMode',
        'hasBroadHostPermissions',
        'communityRulesEnabled',
    ] ) {
        if ( Object.hasOwn(value, key) === false ) { continue; }
        if ( typeof value[key] === 'boolean' ) { continue; }
        throw new Error(`invalid ${areaName} rulesetConfig ${key}`);
    }
    return true;
};

const inspectStoredConfigRecord = (value, areaName) => {
    if ( value === undefined ) {
        return { present: false, valid: false, value: undefined };
    }
    try {
        validateStoredConfigRecord(value, areaName);
    } catch (error) {
        return { present: true, valid: false, value: undefined, error };
    }
    const canonical = {};
    for ( const key of rulesetConfigKeys ) {
        canonical[key] = Object.hasOwn(value, key)
            ? structuredClone(value[key])
            : structuredClone(defaultConfig[key]);
    }
    return { present: true, valid: true, value: canonical };
};

const applyStoredConfig = value => {
    for ( const key of Object.keys(rulesetConfig) ) {
        if ( rulesetConfigKeySet.has(key) ) { continue; }
        delete rulesetConfig[key];
    }
    for ( const key of rulesetConfigKeys ) {
        rulesetConfig[key] = Object.hasOwn(value, key)
            ? structuredClone(value[key])
            : structuredClone(defaultConfig[key]);
    }
};

const revisionFrom = value => {
    const revision = Number(value?.configRevision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

const sameStoredConfig = (before, after) => {
    if ( isStoredConfig(before) === false ) { return false; }
    try {
        return JSON.stringify(before) === JSON.stringify(after);
    } catch {
    }
    return false;
};

const snapshotRulesetConfig = () => structuredClone(rulesetConfig);

const writeConfigSnapshot = async snapshot => {
    await Promise.all([
        localWrite('rulesetConfig', snapshot),
        sessionWrite('rulesetConfig', snapshot),
    ]);
};

const enqueueConfigOperation = operation => {
    const result = pendingOpPromise.then(operation, operation);
    pendingOpPromise = result.catch(() => {});
    return result;
};

const applyRuntimeConfigPolicy = () => {
    if ( isDeveloperModeAllowed ) { return false; }
    const changed = rulesetConfig.developerMode !== false ||
        rulesetConfig.communityRulesURL !== '';
    rulesetConfig.developerMode = false;
    rulesetConfig.communityRulesURL = '';
    return changed;
};

const strictStorageRead = async (areaName, key, { optional = false } = {}) => {
    const area = browser.storage?.[areaName];
    if ( typeof area?.get !== 'function' ) {
        if ( optional ) { return; }
        throw new Error(`${areaName} storage API unavailable`);
    }
    const bin = await area.get(key);
    if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
        throw new Error(`invalid ${areaName} storage response for ${key}`);
    }
    return bin[key];
};

/******************************************************************************/

async function loadRulesetConfigNow() {
    const [ localData, sessionData ] = await Promise.all([
        strictStorageRead('local', 'rulesetConfig'),
        strictStorageRead('session', 'rulesetConfig', { optional: true }),
    ]);
    // A malformed snapshot must never brick every future service-worker start.
    // Read failures still reject, while corrupt values are independently
    // discarded and healed from the other store (or from safe defaults).
    const localRecord = inspectStoredConfigRecord(localData, 'local');
    const sessionRecord = inspectStoredConfigRecord(sessionData, 'session');
    const hasLocal = localRecord.valid;
    const hasSession = sessionRecord.valid;
    process.firstRun = localRecord.present === false &&
        sessionRecord.present === false;
    process.wakeupRun = hasSession;
    if ( process.firstRun ) {
        // This durable intent must precede the config snapshots below. If the
        // worker dies between those writes and startSession(), the repaired
        // session snapshot alone must not make the next attempt look warm.
        await localWrite(INITIAL_SETUP_PENDING_KEY, {
            version: 1,
            createdAt: Date.now(),
        });
    }

    let selected;
    if ( hasLocal && hasSession ) {
        // Durable local state wins ties. Older builds did not await the session
        // write, so an unversioned session snapshot may be stale.
        selected = revisionFrom(sessionRecord.value) >
            revisionFrom(localRecord.value)
            ? sessionRecord.value
            : localRecord.value;
    } else if ( hasLocal ) {
        selected = localRecord.value;
    } else if ( hasSession ) {
        selected = sessionRecord.value;
    } else {
        selected = defaultConfig;
    }

    applyStoredConfig(selected);
    const policyChanged = applyRuntimeConfigPolicy();
    let revision = revisionFrom(selected);
    if ( process.firstRun || policyChanged ) { revision += 1; }
    rulesetConfig.configRevision = revision;
    const snapshot = snapshotRulesetConfig();
    const writes = [];
    if ( sameStoredConfig(localData, snapshot) === false ) {
        writes.push(localWrite('rulesetConfig', snapshot));
    }
    if ( sameStoredConfig(sessionData, snapshot) === false ) {
        writes.push(sessionWrite('rulesetConfig', snapshot));
    }
    await Promise.all(writes);
}

export function loadRulesetConfig() {
    return enqueueConfigOperation(loadRulesetConfigNow);
}

export function saveRulesetConfig() {
    rulesetConfig.configRevision = revisionFrom(rulesetConfig) + 1;
    const snapshot = snapshotRulesetConfig();
    return enqueueConfigOperation(() => writeConfigSnapshot(snapshot));
}
