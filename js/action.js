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

import { browser } from './ext.js';

/******************************************************************************/

let reverseMode = false;

/******************************************************************************/

const swallowPromise = p => {
    if ( p && typeof p.catch === 'function' ) {
        p.catch(( ) => { });
    }
};

/******************************************************************************/

function disableToolbarIcon(tabId) {
    const details = {
        path: {
            '16': '/icons/shield_warning16.png',
            '32': '/icons/shield_warning32.png',
            '128': '/icons/shield_warning128.png'
        }
    };
    if (tabId !== undefined) {
        details.tabId = tabId;
    }
    swallowPromise(browser.action.setIcon(details));
}

function enableToolbarIcon(tabId) {
    const details = {
        path: {
            '16': '/icons/icon16.png',
            '32': '/icons/icon32.png',
            '128': '/icons/icon128.png'
        }
    };
    if (tabId !== undefined) {
        details.tabId = tabId;
    }
    swallowPromise(browser.action.setIcon(details));
}

/******************************************************************************/

export function toggleToolbarIcon(tabId) {
    if (reverseMode) {
        enableToolbarIcon(tabId);
    } else {
        disableToolbarIcon(tabId);
    }
}

export function setToolbarIcon(tabId, enabled) {
    if (enabled) {
        enableToolbarIcon(tabId);
    } else {
        disableToolbarIcon(tabId);
    }
}

/******************************************************************************/

// https://github.com/uBlockOrigin/uBOL-home/issues/198
//  Ensure the toolbar icon reflects the no-filtering mode of "trusted sites"

export async function registerToolbarIconToggler(context) {
    const { none } = context.filteringModeDetails;
    const reverseModeAfter = none.has('all-urls');
    if (reverseModeAfter) {
        disableToolbarIcon();
    } else {
        enableToolbarIcon();
    }
    reverseMode = reverseModeAfter;

    // Talon popup exposes a global protection switch, so keep toolbar icon
    // semantics global as well and remove legacy per-tab icon script.
    const registered = context.before.get('toolbar-icon');
    if (registered !== undefined) {
        context.before.delete('toolbar-icon');
        context.toRemove.push('toolbar-icon');
    }
}
