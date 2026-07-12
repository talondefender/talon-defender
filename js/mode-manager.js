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
    broadcastMessage,
    hasBroadHostPermissions,
    hostnamesFromMatches,
    isDescendantHostnameOfIter,
    toBroaderHostname,
} from './utils.js';

import {
    browser,
    localRemove, localWrite,
    sessionWrite,
} from './ext.js';

import {
    rulesetConfig,
    saveRulesetConfig,
} from './config.js';

import { adminReadEx } from './admin.js';
import { filteringModesToDNR } from './ruleset-manager.js';

const FILTERING_MODE_DETAILS_KEY = 'filteringModeDetails';
export const FILTERING_MODE_DNR_DIRTY_KEY = 'filteringModeDnrDirtyV1';

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

const writeLocalModeIntent = async data => {
    const area = browser.storage?.local;
    if ( typeof area?.set !== 'function' ) {
        throw new Error('local storage API unavailable');
    }
    await area.set({
        [FILTERING_MODE_DETAILS_KEY]: data,
        [FILTERING_MODE_DNR_DIRTY_KEY]: true,
    });
};

const markFilteringModeDnrDirty = async () => {
    const area = browser.storage?.local;
    if ( typeof area?.set !== 'function' ) {
        throw new Error('local storage API unavailable');
    }
    await area.set({ [FILTERING_MODE_DNR_DIRTY_KEY]: true });
};

const clearFilteringModeDnrDirty = async () => {
    const area = browser.storage?.local;
    if ( typeof area?.remove !== 'function' ) {
        throw new Error('local storage API unavailable');
    }
    await area.remove(FILTERING_MODE_DNR_DIRTY_KEY);
};

/******************************************************************************/

// 0:       no filtering
// 1:    basic filtering
// 2:  optimal filtering
// 3: complete filtering

export const     MODE_NONE = 0;
export const    MODE_BASIC = 1;
export const  MODE_OPTIMAL = 2;
export const MODE_COMPLETE = 3;

export const defaultFilteringModes = {
    none: [],
    basic: [],
    optimal: [ 'all-urls' ],
    complete: [],
};

let filteringModeRevision = 0;
let pendingFilteringModeOperation = Promise.resolve();

const enqueueFilteringModeOperation = operation => {
    const result = pendingFilteringModeOperation.then(operation, operation);
    pendingFilteringModeOperation = result.catch(() => {});
    return result;
};

/******************************************************************************/

const pruneDescendantHostnamesFromSet = (hostname, hnSet) => {
    for ( const hn of hnSet ) {
        if ( hn.endsWith(hostname) === false ) { continue; }
        if ( hn === hostname ) { continue; }
        if ( hn.at(-hostname.length-1) !== '.' ) { continue; }
        hnSet.delete(hn);
    }
};

const pruneHostnameFromSet = (hostname, hnSet) => {
    let hn = hostname;
    for (;;) {
        hnSet.delete(hn);
        hn = toBroaderHostname(hn);
        if ( hn === '*' ) { break; }
    }
};

/******************************************************************************/

const serializeModeDetails = (details, revision = filteringModeRevision) => {
    return {
        configRevision: revision,
        none: Array.from(details.none),
        basic: Array.from(details.basic),
        optimal: Array.from(details.optimal),
        complete: Array.from(details.complete),
    };
};

const unserializeModeDetails = details => {
    const fallback = defaultFilteringModes;
    return {
        none: new Set(details?.none ?? fallback.none),
        basic: new Set(details?.basic ?? details?.network ?? fallback.basic),
        optimal: new Set(
            details?.optimal ?? details?.extendedSpecific ?? fallback.optimal
        ),
        complete: new Set(
            details?.complete ?? details?.extendedGeneric ?? fallback.complete
        ),
    };
};

const modeRevisionFrom = details => {
    const revision = Number(details?.configRevision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

const isStoredModeDetails = details =>
    details instanceof Object && Array.isArray(details) === false;

const validateStoredModeDetailsRecord = (details, areaName) => {
    if ( details === undefined ) { return false; }
    if ( isStoredModeDetails(details) === false ) {
        throw new Error(`invalid ${areaName} filteringModeDetails record`);
    }
    if ( Object.hasOwn(details, 'none') === false ) {
        throw new Error(`invalid ${areaName} filteringModeDetails record`);
    }
    for ( const aliases of [
        [ 'basic', 'network' ],
        [ 'optimal', 'extendedSpecific' ],
        [ 'complete', 'extendedGeneric' ],
    ] ) {
        if ( aliases.some(key => Object.hasOwn(details, key)) ) { continue; }
        throw new Error(`invalid ${areaName} filteringModeDetails record`);
    }
    if (
        Object.hasOwn(details, 'configRevision') &&
        (
            Number.isSafeInteger(details.configRevision) === false ||
            details.configRevision < 0
        )
    ) {
        throw new Error(
            `invalid ${areaName} filteringModeDetails configRevision`
        );
    }
    for ( const key of [
        'none',
        'basic',
        'optimal',
        'complete',
        'network',
        'extendedSpecific',
        'extendedGeneric',
    ] ) {
        if ( Object.hasOwn(details, key) === false ) { continue; }
        const values = details[key];
        if (
            Array.isArray(values) &&
            values.every(hostname => typeof hostname === 'string')
        ) {
            continue;
        }
        throw new Error(`invalid ${areaName} filteringModeDetails ${key}`);
    }
    return true;
};

const sameStoredModeDetails = (before, after) => {
    if ( isStoredModeDetails(before) === false ) { return false; }
    try {
        return JSON.stringify(before) === JSON.stringify(after);
    } catch {
    }
    return false;
};

const cloneModeDetails = details => unserializeModeDetails(
    serializeModeDetails(details)
);

const invalidateFilteringModeCache = () => {
    readFilteringModeDetails.userCache = undefined;
    readFilteringModeDetails.cache = undefined;
};

const modeDetailsKey = details => JSON.stringify({
    none: Array.from(details.none).sort(),
    basic: Array.from(details.basic).sort(),
    optimal: Array.from(details.optimal).sort(),
    complete: Array.from(details.complete).sort(),
});

const modeDetailsEqual = (before, after) =>
    modeDetailsKey(before) === modeDetailsKey(after);

export const applyManagedFilteringModes = (
    userModes,
    adminDefaultFiltering,
    adminNoFiltering,
) => {
    const effectiveModes = cloneModeDetails(userModes);
    if ( adminDefaultFiltering !== undefined ) {
        const modefromName = {
            none: MODE_NONE,
            basic: MODE_BASIC,
            optimal: MODE_OPTIMAL,
            complete: MODE_COMPLETE,
        };
        const adminDefaultFilteringMode = modefromName[adminDefaultFiltering];
        if ( adminDefaultFilteringMode !== undefined ) {
            applyFilteringMode(
                effectiveModes,
                'all-urls',
                adminDefaultFilteringMode
            );
        }
    }
    if ( Array.isArray(adminNoFiltering) && adminNoFiltering.length !== 0 ) {
        if ( adminNoFiltering.includes('-*') ) {
            effectiveModes.none.clear();
        }
        for ( const hn of adminNoFiltering ) {
            if ( typeof hn !== 'string' ) { continue; }
            if ( hn.charAt(0) === '-' ) {
                effectiveModes.none.delete(hn.slice(1));
            } else {
                applyFilteringMode(effectiveModes, hn, MODE_NONE);
            }
        }
    }
    return effectiveModes;
};

/******************************************************************************/

function lookupFilteringMode(filteringModes, hostname) {
    const { none, basic, optimal, complete } = filteringModes;
    if ( hostname === 'all-urls' ) {
        if ( filteringModes.none.has('all-urls') ) { return MODE_NONE; }
        if ( filteringModes.basic.has('all-urls') ) { return MODE_BASIC; }
        if ( filteringModes.optimal.has('all-urls') ) { return MODE_OPTIMAL; }
        if ( filteringModes.complete.has('all-urls') ) { return MODE_COMPLETE; }
        return MODE_BASIC;
    }
    if ( none.has(hostname) ) { return MODE_NONE; }
    if ( none.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, none) ) { return MODE_NONE; }
    }
    if ( basic.has(hostname) ) { return MODE_BASIC; }
    if ( basic.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, basic) ) { return MODE_BASIC; }
    }
    if ( optimal.has(hostname) ) { return MODE_OPTIMAL; }
    if ( optimal.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, optimal) ) { return MODE_OPTIMAL; }
    }
    if ( complete.has(hostname) ) { return MODE_COMPLETE; }
    if ( complete.has('all-urls') === false ) {
        if ( isDescendantHostnameOfIter(hostname, complete) ) { return MODE_COMPLETE; }
    }
    return lookupFilteringMode(filteringModes, 'all-urls');
}

/******************************************************************************/

function applyFilteringMode(filteringModes, hostname, afterLevel) {
    const defaultLevel = lookupFilteringMode(filteringModes, 'all-urls');
    if ( hostname === 'all-urls' ) {
        if ( afterLevel === defaultLevel ) { return afterLevel; }
        switch ( afterLevel ) {
        case MODE_NONE:
            filteringModes.none.clear();
            filteringModes.none.add('all-urls');
            break;
        case MODE_BASIC:
            filteringModes.basic.clear();
            filteringModes.basic.add('all-urls');
            break;
        case MODE_OPTIMAL:
            filteringModes.optimal.clear();
            filteringModes.optimal.add('all-urls');
            break;
        case MODE_COMPLETE:
            filteringModes.complete.clear();
            filteringModes.complete.add('all-urls');
            break;
        }
        switch ( defaultLevel ) {
        case MODE_NONE:
            filteringModes.none.delete('all-urls');
            break;
        case MODE_BASIC:
            filteringModes.basic.delete('all-urls');
            break;
        case MODE_OPTIMAL:
            filteringModes.optimal.delete('all-urls');
            break;
        case MODE_COMPLETE:
            filteringModes.complete.delete('all-urls');
            break;
        }
        return lookupFilteringMode(filteringModes, 'all-urls');
    }
    const beforeLevel = lookupFilteringMode(filteringModes, hostname);
    if ( afterLevel === beforeLevel ) { return afterLevel; }
    const { none, basic, optimal, complete } = filteringModes;
    switch ( beforeLevel ) {
    case MODE_NONE:
        pruneHostnameFromSet(hostname, none);
        break;
    case MODE_BASIC:
        pruneHostnameFromSet(hostname, basic);
        break;
    case MODE_OPTIMAL:
        pruneHostnameFromSet(hostname, optimal);
        break;
    case MODE_COMPLETE:
        pruneHostnameFromSet(hostname, complete);
        break;
    }
    if ( afterLevel !== defaultLevel ) {
        switch ( afterLevel ) {
        case MODE_NONE:
            if ( isDescendantHostnameOfIter(hostname, none) === false ) {
                filteringModes.none.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, none);
            }
            break;
        case MODE_BASIC:
            if ( isDescendantHostnameOfIter(hostname, basic) === false ) {
                filteringModes.basic.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, basic);
            }
            break;
        case MODE_OPTIMAL:
            if ( isDescendantHostnameOfIter(hostname, optimal) === false ) {
                filteringModes.optimal.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, optimal);
            }
            break;
        case MODE_COMPLETE:
            if ( isDescendantHostnameOfIter(hostname, complete) === false ) {
                filteringModes.complete.add(hostname);
                pruneDescendantHostnamesFromSet(hostname, complete);
            }
            break;
        }
    }
    return lookupFilteringMode(filteringModes, hostname);
}

/******************************************************************************/

export function reconcileGranularPermissionModes({
    filteringModes,
    beforeAllowedHostnames,
    afterAllowedHostnames,
    fallbackMode,
}) {
    if ( afterAllowedHostnames.has('all-urls') ) { return false; }
    const { none, basic, optimal, complete } = filteringModes;
    let modified = false;
    for ( const hn of new Set([ ...optimal, ...complete ]) ) {
        if ( afterAllowedHostnames.has(hn) ) { continue; }
        if ( isDescendantHostnameOfIter(hn, afterAllowedHostnames) ) { continue; }
        applyFilteringMode(filteringModes, hn, fallbackMode);
        modified = true;
    }
    for ( const hn of afterAllowedHostnames ) {
        if ( beforeAllowedHostnames.has(hn) ) { continue; }
        if ( optimal.has(hn) || complete.has(hn) ) { continue; }
        if ( basic.has(hn) || none.has(hn) ) { continue; }
        applyFilteringMode(filteringModes, hn, MODE_OPTIMAL);
        modified = true;
    }
    return modified;
}

/******************************************************************************/

export const applyEffectiveModeDeltaToUser = (
    userModes,
    beforeEffectiveModes,
    afterEffectiveModes,
) => {
    const hostnames = new Set([ 'all-urls' ]);
    for ( const details of [ beforeEffectiveModes, afterEffectiveModes ] ) {
        for ( const modeSet of [
            details.none,
            details.basic,
            details.optimal,
            details.complete,
        ] ) {
            for ( const hostname of modeSet ) { hostnames.add(hostname); }
        }
    }
    const orderedHostnames = Array.from(hostnames).sort((a, b) => {
        if ( a === 'all-urls' ) { return -1; }
        if ( b === 'all-urls' ) { return 1; }
        return a.split('.').length - b.split('.').length || a.localeCompare(b);
    });
    for ( const hostname of orderedHostnames ) {
        const beforeLevel = lookupFilteringMode(beforeEffectiveModes, hostname);
        const afterLevel = lookupFilteringMode(afterEffectiveModes, hostname);
        if ( beforeLevel === afterLevel ) { continue; }
        applyFilteringMode(userModes, hostname, afterLevel);
    }
};

/******************************************************************************/

export async function readFilteringModeDetails(bypassCache = false) {
    if ( bypassCache === false && readFilteringModeDetails.cache ) {
        return readFilteringModeDetails.cache;
    }
    let [
        localModes,
        sessionModes,
        dnrDirtyValue,
        adminDefaultFiltering,
        adminNoFiltering,
    ] = await Promise.all([
        strictStorageRead('local', FILTERING_MODE_DETAILS_KEY),
        strictStorageRead('session', FILTERING_MODE_DETAILS_KEY, { optional: true }),
        strictStorageRead('local', FILTERING_MODE_DNR_DIRTY_KEY),
        adminReadEx('defaultFiltering'),
        adminReadEx('noFiltering'),
    ]);
    const hasLocal = validateStoredModeDetailsRecord(localModes, 'local');
    const hasSession = validateStoredModeDetailsRecord(sessionModes, 'session');
    const dnrDirty = dnrDirtyValue !== undefined && dnrDirtyValue !== false;
    if ( dnrDirty && hasLocal === false && hasSession === false ) {
        throw new Error('filtering mode DNR intent has no desired mode record');
    }
    let storedUserModes;
    if ( hasLocal && hasSession ) {
        storedUserModes = modeRevisionFrom(sessionModes) > modeRevisionFrom(localModes)
            ? sessionModes
            : localModes;
    } else if ( hasLocal ) {
        storedUserModes = localModes;
    } else if ( hasSession ) {
        storedUserModes = sessionModes;
    } else {
        storedUserModes = structuredClone(defaultFilteringModes);
    }
    filteringModeRevision = modeRevisionFrom(storedUserModes);
    const userModes = unserializeModeDetails(storedUserModes);
    const durableUserData = serializeModeDetails(userModes);
    if ( sameStoredModeDetails(localModes, durableUserData) === false ) {
        await localWrite(FILTERING_MODE_DETAILS_KEY, durableUserData);
    }
    if ( sameStoredModeDetails(sessionModes, durableUserData) === false ) {
        await sessionWrite(FILTERING_MODE_DETAILS_KEY, durableUserData);
    }
    const effectiveModes = applyManagedFilteringModes(
        userModes,
        adminDefaultFiltering,
        adminNoFiltering
    );
    if ( dnrDirty ) {
        invalidateFilteringModeCache();
        await filteringModesToDNR(effectiveModes);
        await clearFilteringModeDnrDirty();
    }
    readFilteringModeDetails.userCache = userModes;
    readFilteringModeDetails.cache = effectiveModes;
    return effectiveModes;
}

/******************************************************************************/

export function reconcileFilteringModeDetails() {
    return enqueueFilteringModeOperation(async () => {
        const details = await readFilteringModeDetails(true);
        const userDetails = cloneModeDetails(
            readFilteringModeDetails.userCache ||
            unserializeModeDetails(defaultFilteringModes)
        );
        await markFilteringModeDnrDirty();
        try {
            await filteringModesToDNR(details);
            await clearFilteringModeDnrDirty();
        } catch (reason) {
            invalidateFilteringModeCache();
            throw reason;
        }
        readFilteringModeDetails.userCache = userDetails;
        readFilteringModeDetails.cache = details;
        const [ defaultFilteringMode, hasOmnipotence ] = await Promise.all([
            getDefaultFilteringMode(),
            hasBroadHostPermissions(),
        ]);
        broadcastMessage({
            defaultFilteringMode,
            hasOmnipotence,
            filteringModeDetails: details,
        });
        return details;
    });
}

/**/

async function writeFilteringModeDetailsNow(userDetails) {
    const [ adminDefaultFiltering, adminNoFiltering ] = await Promise.all([
        adminReadEx('defaultFiltering'),
        adminReadEx('noFiltering'),
    ]);
    const effectiveDetails = applyManagedFilteringModes(
        userDetails,
        adminDefaultFiltering,
        adminNoFiltering
    );
    const nextRevision = filteringModeRevision < Number.MAX_SAFE_INTEGER
        ? filteringModeRevision + 1
        : 1;
    const data = serializeModeDetails(userDetails, nextRevision);
    await writeLocalModeIntent(data);
    filteringModeRevision = nextRevision;
    invalidateFilteringModeCache();
    await sessionWrite(FILTERING_MODE_DETAILS_KEY, data);
    try {
        await filteringModesToDNR(effectiveDetails);
        await clearFilteringModeDnrDirty();
    } catch (reason) {
        invalidateFilteringModeCache();
        throw reason;
    }
    readFilteringModeDetails.userCache = cloneModeDetails(userDetails);
    readFilteringModeDetails.cache = effectiveDetails;
    const results = await Promise.all([
        getDefaultFilteringMode(),
        hasBroadHostPermissions(),
    ]);
    broadcastMessage({
        defaultFilteringMode: results[0],
        hasOmnipotence: results[1],
        filteringModeDetails: effectiveDetails,
    });
    return effectiveDetails;
}

function writeFilteringModeDetails(afterDetails) {
    return setFilteringModeDetails(afterDetails);
}

/******************************************************************************/

export async function getFilteringModeDetails(serializable = false) {
    const actualDetails = await readFilteringModeDetails();
    const out = {
        none: new Set(actualDetails.none),
        basic: new Set(actualDetails.basic),
        optimal: new Set(actualDetails.optimal),
        complete: new Set(actualDetails.complete),
    };
    return serializable ? serializeModeDetails(out) : out;
}

export function setFilteringModeDetails(details, expectedRevision) {
    const desiredEffectiveModes = cloneModeDetails(details);
    if (
        expectedRevision !== undefined &&
        (Number.isSafeInteger(expectedRevision) === false || expectedRevision < 0)
    ) {
        const error = new TypeError('expectedRevision must be a non-negative safe integer');
        error.code = 'invalid_filtering_mode_revision';
        return Promise.reject(error);
    }
    return enqueueFilteringModeOperation(async () => {
        const beforeEffectiveModes = await readFilteringModeDetails();
        if (
            expectedRevision !== undefined &&
            expectedRevision !== filteringModeRevision
        ) {
            const error = new Error('filtering mode details changed before mutation');
            error.code = 'stale_filtering_mode_revision';
            error.currentDetails = serializeModeDetails(beforeEffectiveModes);
            throw error;
        }
        if ( modeDetailsEqual(beforeEffectiveModes, desiredEffectiveModes) ) {
            return beforeEffectiveModes;
        }
        const beforeUserModes = readFilteringModeDetails.userCache ||
            unserializeModeDetails(defaultFilteringModes);
        const afterUserModes = cloneModeDetails(beforeUserModes);
        applyEffectiveModeDeltaToUser(
            afterUserModes,
            beforeEffectiveModes,
            desiredEffectiveModes
        );
        if ( modeDetailsEqual(beforeUserModes, afterUserModes) ) {
            return beforeEffectiveModes;
        }
        return writeFilteringModeDetailsNow(afterUserModes);
    });
}

/******************************************************************************/

export async function getFilteringMode(hostname) {
    const filteringModes = await getFilteringModeDetails();
    return lookupFilteringMode(filteringModes, hostname);
}

export function setFilteringMode(hostname, afterLevel) {
    return enqueueFilteringModeOperation(async () => {
        const beforeEffectiveModes = await readFilteringModeDetails();
        const beforeLevel = lookupFilteringMode(beforeEffectiveModes, hostname);
        if ( beforeLevel === afterLevel ) { return beforeLevel; }
        const beforeUserModes = readFilteringModeDetails.userCache ||
            unserializeModeDetails(defaultFilteringModes);
        const afterUserModes = cloneModeDetails(beforeUserModes);
        applyFilteringMode(afterUserModes, hostname, afterLevel);
        if ( modeDetailsEqual(beforeUserModes, afterUserModes) ) {
            return beforeLevel;
        }
        const afterEffectiveModes = await writeFilteringModeDetailsNow(
            afterUserModes
        );
        return lookupFilteringMode(afterEffectiveModes, hostname);
    });
}

/******************************************************************************/

export function getDefaultFilteringMode() {
    return getFilteringMode('all-urls');
}

export function setDefaultFilteringMode(afterLevel) {
    return setFilteringMode('all-urls', afterLevel);
}

/******************************************************************************/

export async function persistHostPermissions(iter) {
    if ( iter === undefined ) {
        const permissions = await browser.permissions.getAll();
        iter = hostnamesFromMatches(permissions.origins || []);
    }
    const hostnames = Array.from(iter || []);
    return hostnames.length !== 0
        ? localWrite('permissions.hostnames', hostnames)
        : localRemove('permissions.hostnames');
}

/******************************************************************************/

export async function syncWithBrowserPermissions() {
    const [
        beforePermissions,
        afterPermissions,
        beforeMode,
    ] = await Promise.all([
        strictStorageRead('local', 'permissions.hostnames'),
        browser.permissions.getAll(),
        getDefaultFilteringMode(),
    ]);
    const beforeAllowedHostnames = new Set(
        Array.isArray(beforePermissions) ? beforePermissions : []
    );
    const afterAllowedHostnames = new Set(
        hostnamesFromMatches(afterPermissions.origins || [])
    );
    const hasBroadHostPermissions = afterAllowedHostnames.has('all-urls');
    const broadHostPermissionsToggled =
        hasBroadHostPermissions !== rulesetConfig.hasBroadHostPermissions;
    let modified = false;
    if ( beforeMode > MODE_BASIC && hasBroadHostPermissions === false ) {
        await setDefaultFilteringMode(MODE_BASIC);
        modified = true;
    } else if ( beforeMode === MODE_BASIC && hasBroadHostPermissions && broadHostPermissionsToggled ) {
        await setDefaultFilteringMode(MODE_OPTIMAL);
        modified = true;
    }
    if ( broadHostPermissionsToggled ) {
        rulesetConfig.hasBroadHostPermissions = hasBroadHostPermissions;
        await saveRulesetConfig();
    }
    const afterMode = await getDefaultFilteringMode();
    let granularModified = false;
    if ( afterMode <= MODE_BASIC ) {
        const filteringModes = await getFilteringModeDetails();
        granularModified = reconcileGranularPermissionModes({
            filteringModes,
            beforeAllowedHostnames,
            afterAllowedHostnames,
            fallbackMode: afterMode,
        });
        if ( granularModified ) {
            await writeFilteringModeDetails(filteringModes);
        }
    }
    await persistHostPermissions(afterAllowedHostnames);
    return modified || granularModified;
}

/******************************************************************************/
