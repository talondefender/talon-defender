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

import { i18n } from './ext.js';

/******************************************************************************/

export const AUTO_REGIONAL_RULESET_IDS_STORAGE_KEY = 'autoRegionalRulesetIdsV1';
export const REGIONAL_RULESET_OPT_OUT_STORAGE_KEY = 'regionalRulesetOptOutIdsV1';

const normalizeRulesetId = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim();
    return normalized === '' ? '' : normalized;
};

const uniqueRulesetIds = values => {
    const out = [];
    const seen = new Set();
    for ( const value of values || [] ) {
        const id = normalizeRulesetId(value);
        if ( id === '' || seen.has(id) ) { continue; }
        seen.add(id);
        out.push(id);
    }
    return out;
};

const rulesetIdArraysDiffer = (left, right) => {
    if ( left.length !== right.length ) { return true; }
    const rightSet = new Set(right);
    for ( const id of left ) {
        if ( rightSet.has(id) ) { continue; }
        return true;
    }
    return false;
};

const normalizePrimaryLanguage = value => {
    if ( typeof value !== 'string' ) { return ''; }
    const normalized = value.trim().toLowerCase();
    if ( normalized === '' ) { return ''; }
    const [ primary ] = normalized.split(/[-_]/);
    return /^[a-z]{2,3}$/.test(primary) ? primary : '';
};

export const REGIONAL_RULESET_LOCALE_MAP = Object.freeze({
    ar: [ 'ara-0' ],
    as: [ 'ind-0' ],
    bn: [ 'ind-0' ],
    bs: [ 'hrv-0' ],
    da: [ 'nor-0' ],
    de: [ 'deu-0' ],
    et: [ 'est-0' ],
    fr: [ 'fra-0' ],
    gu: [ 'ind-0' ],
    es: [ 'spa-0', 'spa-1' ],
    hi: [ 'ind-0' ],
    it: [ 'ita-0' ],
    kn: [ 'ind-0' ],
    ml: [ 'ind-0' ],
    mr: [ 'ind-0' ],
    nb: [ 'nor-0' ],
    ne: [ 'ind-0' ],
    nl: [ 'nld-0' ],
    nn: [ 'nor-0' ],
    pl: [ 'pol-0' ],
    pa: [ 'ind-0' ],
    ja: [ 'jpn-1' ],
    ko: [ 'kor-1' ],
    si: [ 'ind-0' ],
    sq: [ 'alb-0' ],
    sr: [ 'hrv-0' ],
    sv: [ 'swe-1' ],
    no: [ 'nor-0' ],
    fi: [ 'fin-0' ],
    ta: [ 'ind-0' ],
    te: [ 'ind-0' ],
    tr: [ 'tur-0' ],
    vi: [ 'vie-1' ],
    uk: [ 'ukr-0' ],
    ru: [ 'rus-0', 'rus-1' ],
    ro: [ 'rou-1' ],
    bg: [ 'bgr-0' ],
    cs: [ 'cze-0' ],
    el: [ 'grc-0' ],
    hr: [ 'hrv-0' ],
    hu: [ 'hun-0' ],
    id: [ 'idn-0' ],
    mk: [ 'mkd-0' ],
    lv: [ 'lva-0' ],
    lt: [ 'ltu-0' ],
    sl: [ 'svn-0' ],
    th: [ 'tha-0' ],
    zh: [ 'chn-0' ],
    fa: [ 'irn-0' ],
    he: [ 'isr-0' ],
    is: [ 'isl-0' ],
});

export const BLOCKED_PUBLIC_REGIONAL_RULESET_IDS = Object.freeze([
    'bgr-0',
    'pol-0',
]);

export const PUBLIC_SAFE_REGIONAL_RULESET_IDS = Object.freeze(uniqueRulesetIds([
    'alb-0',
    'ara-0',
    'chn-0',
    'cze-0',
    'deu-0',
    'est-0',
    'fin-0',
    'fra-0',
    'grc-0',
    'hrv-0',
    'hun-0',
    'idn-0',
    'ind-0',
    'irn-0',
    'isl-0',
    'isr-0',
    'ita-0',
    'jpn-1',
    'kor-1',
    'ltu-0',
    'lva-0',
    'mkd-0',
    'nld-0',
    'nor-0',
    'rou-1',
    'rus-0',
    'rus-1',
    'spa-0',
    'spa-1',
    'svn-0',
    'swe-1',
    'tha-0',
    'tur-0',
    'ukr-0',
    'vie-1',
]));

export const getPublicSafeRegionalRulesetIds = ( ) =>
    PUBLIC_SAFE_REGIONAL_RULESET_IDS.slice();

export const getBlockedPublicRegionalRulesetIds = ( ) =>
    BLOCKED_PUBLIC_REGIONAL_RULESET_IDS.slice();

export const resolvePreferredLanguageTags = ({ acceptLanguages = [], uiLocale = '' } = {}) => {
    const out = [];
    const seen = new Set();
    for ( const value of acceptLanguages || [] ) {
        const primary = normalizePrimaryLanguage(value);
        if ( primary === '' || seen.has(primary) ) { continue; }
        seen.add(primary);
        out.push(primary);
    }
    if ( out.length === 0 ) {
        const fallback = normalizePrimaryLanguage(uiLocale);
        if ( fallback !== '' ) {
            out.push(fallback);
        }
    }
    return out;
};

const readAcceptLanguages = ( ) => {
    const fn = i18n?.getAcceptLanguages;
    if ( typeof fn !== 'function' ) { return Promise.resolve([]); }
    try {
        const maybePromise = fn.call(i18n);
        if ( maybePromise?.then ) {
            return maybePromise.catch(( ) => []);
        }
    } catch {
    }
    return new Promise(resolve => {
        try {
            fn.call(i18n, langs => resolve(Array.isArray(langs) ? langs : []));
        } catch {
            resolve([]);
        }
    });
};

export const getPreferredLanguageTags = async ( ) => {
    const [ acceptLanguages, uiLocale ] = await Promise.all([
        readAcceptLanguages(),
        Promise.resolve(i18n?.getMessage?.('@@ui_locale') || ''),
    ]);
    return resolvePreferredLanguageTags({ acceptLanguages, uiLocale });
};

export const getAutoRegionalRulesetIds = ({
    acceptLanguages = [],
    uiLocale = '',
    availableRulesetIds = [],
} = {}) => {
    const available = new Set(uniqueRulesetIds(availableRulesetIds));
    const preferredLanguages = resolvePreferredLanguageTags({ acceptLanguages, uiLocale });
    const out = [];
    const seen = new Set();
    for ( const language of preferredLanguages ) {
        const mapped = REGIONAL_RULESET_LOCALE_MAP[language];
        if ( Array.isArray(mapped) === false ) { continue; }
        for ( const id of mapped ) {
            if ( available.has(id) === false ) { continue; }
            if ( seen.has(id) ) { continue; }
            seen.add(id);
            out.push(id);
        }
    }
    return out;
};

export const reconcileAutoRegionalRulesetPatch = ({
    currentEnabledRulesets = [],
    storedAutoRegionalRulesetIds = [],
    storedRegionalOptOutIds = [],
    nextAutoRegionalRulesetIds = [],
    regionalRulesetFamilyIds = [],
} = {}) => {
    const current = uniqueRulesetIds(currentEnabledRulesets);
    const storedAuto = uniqueRulesetIds(storedAutoRegionalRulesetIds);
    const familyIds = uniqueRulesetIds(regionalRulesetFamilyIds);
    const familySet = new Set(familyIds);
    const currentSet = new Set(current);
    const currentRegional = current.filter(id => familySet.has(id));

    const optOutSet = new Set(
        uniqueRulesetIds(storedRegionalOptOutIds).filter(id => familySet.has(id))
    );
    for ( const id of storedAuto ) {
        if ( familySet.has(id) === false ) { continue; }
        if ( currentSet.has(id) ) { continue; }
        optOutSet.add(id);
    }

    const nextAutoIds = uniqueRulesetIds(nextAutoRegionalRulesetIds).filter(id => (
        familySet.has(id) && optOutSet.has(id) === false
    ));

    const patched = new Set(current);
    const trackedAuto = new Set(storedAuto.filter(id => familySet.has(id)));
    const addedAutoRulesetIds = [];
    let changed = false;
    let customized = false;

    if ( trackedAuto.size === 0 && currentRegional.length !== 0 ) {
        customized = true;
    } else {
        for ( const id of nextAutoIds ) {
            trackedAuto.add(id);
            if ( patched.has(id) ) { continue; }
            patched.add(id);
            addedAutoRulesetIds.push(id);
            changed = true;
        }
    }

    const patchedEnabledRulesets = Array.from(patched);
    const nextTrackedAutoIds = Array.from(trackedAuto);
    const nextOptOutIds = Array.from(optOutSet);
    const previousOptOutIds = uniqueRulesetIds(storedRegionalOptOutIds);

    const autoIdsChanged = rulesetIdArraysDiffer(nextTrackedAutoIds, storedAuto);
    const optOutChanged = rulesetIdArraysDiffer(nextOptOutIds, previousOptOutIds);

    return {
        addedAutoRulesetIds,
        autoRegionalRulesetIds: nextTrackedAutoIds,
        changed,
        customized,
        patchedEnabledRulesets,
        regionalRulesetOptOutIds: nextOptOutIds,
        storageChanged: autoIdsChanged || optOutChanged,
    };
};

export const reconcileRegionalRulesetOptOutPatch = ({
    enabledRulesets = [],
    storedAutoRegionalRulesetIds = [],
    storedRegionalOptOutIds = [],
} = {}) => {
    const enabledSet = new Set(uniqueRulesetIds(enabledRulesets));
    const autoIds = uniqueRulesetIds(storedAutoRegionalRulesetIds);
    const nextOptOutSet = new Set(uniqueRulesetIds(storedRegionalOptOutIds));

    for ( const id of autoIds ) {
        if ( enabledSet.has(id) ) {
            nextOptOutSet.delete(id);
            continue;
        }
        nextOptOutSet.add(id);
    }

    const nextOptOutIds = Array.from(nextOptOutSet);
    const previousOptOutIds = uniqueRulesetIds(storedRegionalOptOutIds);
    const changed = rulesetIdArraysDiffer(nextOptOutIds, previousOptOutIds);

    return {
        changed,
        regionalRulesetOptOutIds: nextOptOutIds,
    };
};
