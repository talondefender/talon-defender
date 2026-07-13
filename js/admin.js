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
    adminRead,
    browser,
} from './ext.js';

import {
    enableRulesets,
    getRulesetDetails,
    repairDnrReconciliation,
    updateSessionRules,
} from './ruleset-manager.js';

import {
    getDefaultFilteringMode,
    readFilteringModeDetails,
    reconcileFilteringModeDetails,
} from './mode-manager.js';

import {
    getEffectiveStrictBlockMode,
    rulesetConfig,
    setManagedStrictBlockMode,
} from './config.js';

import { broadcastMessage } from './utils.js';
import { dnr } from './ext-compat.js';
import { registerInjectables } from './scripting-manager.js';
import { ubolErr, ubolLog } from './debug.js';

/******************************************************************************/

export async function loadAdminConfig() {
    const [
        strictBlockMode,
        disabledFeatures,
    ] = await Promise.all([
        adminReadEx('strictBlockMode'),
        adminReadEx('disabledFeatures'),
    ]);
    await applyAdminConfig({ showBlockedCount: false, strictBlockMode });
    return {
        strictBlockMode,
        disabledFeatures: Array.isArray(disabledFeatures)
            ? disabledFeatures.slice()
            : [],
    };
}

/******************************************************************************/

const adminConfigOverrides = new Map();
let adminRuntimeReconciler = async () => registerInjectables();
let adminDeveloperModeDisabler = async () => {};

export const setAdminRuntimeReconciler = reconciler => {
    adminRuntimeReconciler = typeof reconciler === 'function'
        ? reconciler
        : async () => registerInjectables();
};

export const setAdminDeveloperModeDisabler = disabler => {
    adminDeveloperModeDisabler = typeof disabler === 'function'
        ? disabler
        : async () => {};
};

const reconcileAdminRuntime = async () => {
    const result = await adminRuntimeReconciler();
    const succeeded = result === true || result?.ok === true;
    if ( succeeded === false ) {
        throw new Error(
            `managed runtime update failed: ${result?.lastError || result?.sandboxLastError || 'unknown error'}`
        );
    }
    return result;
};

async function applyAdminConfig(config, apply = false) {
    if ( Object.hasOwn(config, 'strictBlockMode') ) {
        const before = getEffectiveStrictBlockMode();
        const after = setManagedStrictBlockMode(config.strictBlockMode);
        if ( apply === true && after !== before ) {
            await updateSessionRules();
            broadcastMessage({ strictBlockMode: after });
        }
    }
    const toApply = [];
    for ( const [ key, val ] of Object.entries(config) ) {
        if ( key === 'strictBlockMode' ) { continue; }
        let effectiveValue = val;
        if ( typeof val === typeof rulesetConfig[key] ) {
            if ( adminConfigOverrides.has(key) === false ) {
                adminConfigOverrides.set(key, rulesetConfig[key]);
            }
        } else if ( adminConfigOverrides.has(key) ) {
            effectiveValue = adminConfigOverrides.get(key);
            adminConfigOverrides.delete(key);
        } else {
            continue;
        }
        if ( effectiveValue === rulesetConfig[key] ) { continue; }
        rulesetConfig[key] = effectiveValue;
        toApply.push([ key, effectiveValue ]);
    }
    if ( toApply.length === 0 ) { return; }
    if ( apply !== true ) { return; }
    while ( toApply.length !== 0 ) {
        const [ key, effectiveValue ] = toApply.pop();
        switch ( key ) {
        case 'showBlockedCount': {
            if ( typeof dnr.setExtensionActionOptions !== 'function' ) { break; }
            rulesetConfig.showBlockedCount = false;
            await dnr.setExtensionActionOptions({
                displayActionCountAsBadgeText: false,
            });
            broadcastMessage({ showBlockedCount: false });
            break;
        }
        default:
            break;
        }
    }
}

/******************************************************************************/

const adminSettings = {
    keys: new Map(),
    timer: undefined,
    processing: false,
    retryDelayMs: 127,
    schedule(delay = 127) {
        if ( this.timer !== undefined || this.processing ) { return; }
        this.timer = self.setTimeout(( ) => {
            this.timer = undefined;
            this.process().catch(reason => {
                ubolErr(`adminSettings.process/${reason}`);
            });
        }, delay);
    },
    change(key, value) {
        this.keys.set(key, value);
        if ( this.timer !== undefined ) {
            self.clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.retryDelayMs = 127;
        this.schedule(127);
    },
    async process() {
        if ( this.processing ) { return; }
        this.processing = true;
        try {
            while ( this.keys.size !== 0 ) {
                const pending = new Map(this.keys);
                this.keys.clear();
                try {
                    await this.processBatch(pending);
                } catch (reason) {
                    for ( const [ key, value ] of pending ) {
                        if ( this.keys.has(key) ) { continue; }
                        this.keys.set(key, value);
                    }
                    throw reason;
                }
            }
        } finally {
            this.processing = false;
            if ( this.keys.size !== 0 ) {
                const delay = this.retryDelayMs;
                this.retryDelayMs = Math.min(this.retryDelayMs * 2, 60_000);
                this.schedule(delay);
            } else {
                this.retryDelayMs = 127;
            }
        }
    },
    async processBatch(pending) {
        if ( pending.has('rulesets') ) {
            ubolLog('admin setting "rulesets" changed');
            broadcastMessage({ runtimeVerified: false });
            const rulesetResult = await enableRulesets(rulesetConfig.enabledRulesets);
            if ( rulesetResult?.error ) {
                throw new Error(`managed ruleset update failed: ${rulesetResult.error}`);
            }
            const repairResult = await repairDnrReconciliation({ force: true });
            if ( repairResult?.error ) {
                throw new Error(`managed ruleset reconciliation failed: ${repairResult.error}`);
            }
            const runtimeResult = await reconcileAdminRuntime();
            if ( runtimeResult?.runtimeVerified !== true ) {
                throw new Error('managed ruleset runtime verification failed');
            }
            const results = await Promise.all([
                getAdminRulesets(),
                dnr.getEnabledRulesets(),
            ]);
            const [ adminRulesets, enabledRulesets ] = results;
            broadcastMessage({
                adminRulesets,
                enabledRulesets,
                configRevision: rulesetConfig.configRevision,
                runtimeVerified: true,
            });
        }
        if ( pending.has('defaultFiltering') ) {
            ubolLog('admin setting "defaultFiltering" changed');
            broadcastMessage({ runtimeVerified: false });
            await reconcileFilteringModeDetails();
            const runtimeResult = await reconcileAdminRuntime();
            if ( runtimeResult?.runtimeVerified !== true ) {
                throw new Error('managed filtering runtime verification failed');
            }
            const defaultFilteringMode = await getDefaultFilteringMode();
            broadcastMessage({
                defaultFilteringMode,
                runtimeVerified: true,
            });
        }
        if ( pending.has('noFiltering') ) {
            ubolLog('admin setting "noFiltering" changed');
            broadcastMessage({ runtimeVerified: false });
            const filteringModeDetails = await reconcileFilteringModeDetails();
            const runtimeResult = await reconcileAdminRuntime();
            if ( runtimeResult?.runtimeVerified !== true ) {
                throw new Error('managed filtering runtime verification failed');
            }
            broadcastMessage({
                filteringModeDetails,
                runtimeVerified: true,
            });
        }
        if ( pending.has('showBlockedCount') ) {
            ubolLog('admin setting "showBlockedCount" changed');
            await applyAdminConfig({ showBlockedCount: false }, true);
        }
        if ( pending.has('strictBlockMode') ) {
            ubolLog('admin setting "strictBlockMode" changed');
            const strictBlockMode = pending.get('strictBlockMode');
            await applyAdminConfig({ strictBlockMode }, true);
        }
        if ( pending.has('disabledFeatures') ) {
            ubolLog('admin setting "disabledFeatures" changed');
            const disabledFeatures = pending.get('disabledFeatures');
            if (
                Array.isArray(disabledFeatures) &&
                disabledFeatures.includes('develop') &&
                (rulesetConfig.developerMode || rulesetConfig.communityRulesURL !== '')
            ) {
                await adminDeveloperModeDisabler();
            }
        }
    }
};

/******************************************************************************/

export async function getAdminRulesets() {
    const [
        adminList,
        rulesetDetails,
    ] = await Promise.all([
        adminReadEx('rulesets'),
        getRulesetDetails(),
    ]);
    const adminRulesets = new Set(Array.isArray(adminList) && adminList || []);
    if ( adminRulesets.has('-default') ) {
        adminRulesets.delete('-default');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled !== true ) { continue; }
            if ( adminRulesets.has(`+${ruleset.id}`) ) { continue; }
            adminRulesets.add(`-${ruleset.id}`);
        }
    }
    if ( adminRulesets.has('+default') ) {
        adminRulesets.delete('+default');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled !== true ) { continue; }
            if ( adminRulesets.has(`-${ruleset.id}`) ) { continue; }
            adminRulesets.add(`+${ruleset.id}`);
        }
    }
    if ( adminRulesets.has('-*') ) {
        adminRulesets.delete('-*');
        for ( const ruleset of rulesetDetails.values() ) {
            if ( ruleset.enabled ) { continue; }
            if ( adminRulesets.has(`+${ruleset.id}`) ) { continue; }
            adminRulesets.add(`-${ruleset.id}`);
        }
    }
    return Array.from(adminRulesets);
}

/******************************************************************************/

const decodeAdminCacheEntry = entry => {
    if ( entry?.absent === true ) { return undefined; }
    return entry?.data;
};

const encodeAdminCacheEntry = value => value === undefined
    ? { absent: true }
    : { data: value };

export async function adminReadEx(key) {
    const adminKey = `admin.${key}`;
    const readCacheEntry = async (area, areaName) => {
        if ( area === undefined ) { return { found: false, value: undefined }; }
        if ( typeof area.get !== 'function' ) {
            throw new Error(`${areaName} storage API unavailable`);
        }
        const bin = await area.get(adminKey);
        if ( bin === null || typeof bin !== 'object' || Array.isArray(bin) ) {
            throw new Error(`invalid ${areaName} storage response for ${adminKey}`);
        }
        if ( Object.hasOwn(bin, adminKey) === false ) {
            return { found: false, value: undefined };
        }
        return {
            found: true,
            value: decodeAdminCacheEntry(bin[adminKey]),
        };
    };

    let cached = await readCacheEntry(browser.storage?.session, 'session');
    if ( cached.found === false ) {
        cached = await readCacheEntry(browser.storage?.local, 'local');
    }

    // Managed policy is authoritative. Await it and its cache write so a
    // transient I/O failure aborts startup/reconciliation instead of being
    // mistaken for an administrator removing the policy.
    const value = await adminRead(key);
    const cacheEntry = encodeAdminCacheEntry(value);
    const writes = [];
    for ( const [ area, areaName ] of [
        [ browser.storage?.session, 'session' ],
        [ browser.storage?.local, 'local' ],
    ] ) {
        if ( area === undefined ) { continue; }
        if ( typeof area.set !== 'function' ) {
            throw new Error(`${areaName} storage API unavailable`);
        }
        writes.push(area.set({ [adminKey]: cacheEntry }));
    }
    await Promise.all(writes);
    if ( typeof browser.storage?.local?.remove === 'function' ) {
        await browser.storage.local.remove(`admin_${key}`);
    }
    if ( JSON.stringify(value) !== JSON.stringify(cached.value) ) {
        adminSettings.change(key, value);
    }
    return value;
}

const refreshManagedSettingWithRetry = (key, attempt = 0) => {
    adminReadEx(key).catch(reason => {
        ubolErr(`managed storage change/${key}/${reason}`);
        if ( attempt >= 6 ) { return; }
        self.setTimeout(() => {
            refreshManagedSettingWithRetry(key, attempt + 1);
        }, Math.min(250 * (2 ** attempt), 10_000));
    });
};

browser.storage?.onChanged?.addListener((changes, areaName) => {
    if ( areaName !== 'managed' || changes instanceof Object === false ) { return; }
    for ( const key of Object.keys(changes) ) {
        refreshManagedSettingWithRetry(key);
    }
});

/******************************************************************************/
