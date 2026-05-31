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

/******************************************************************************/

const IGNORABLE_RUNTIME_ERRORS = [
    'No tab with id',
    'No window with id',
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
];

const errorMessageFrom = error => {
    if ( error && typeof error.message === 'string' ) { return error.message; }
    if ( typeof error === 'string' ) { return error; }
    return '';
};

const isIgnorableRuntimeError = error => {
    const message = errorMessageFrom(error);
    if ( message === '' ) { return false; }
    return IGNORABLE_RUNTIME_ERRORS.some(snippet => message.includes(snippet));
};

const ignoreRuntimeError = error => {
    // Some browser APIs may reject with an empty reason; do not turn that into "Uncaught undefined".
    if ( error === undefined || error === null ) { return; }
    if ( isIgnorableRuntimeError(error) ) { return; }
    throw error;
};

const runtimeFromGlobal = () =>
    globalThis.chrome?.runtime || globalThis.browser?.runtime;

const runtimeLastErrorFrom = (runtime = runtimeFromGlobal()) => {
    try {
        return runtime?.lastError;
    } catch {
    }
    return undefined;
};

const ignoreRuntimeLastError = runtime => {
    const error = runtimeLastErrorFrom(runtime);
    if ( error === undefined || error === null ) { return false; }
    ignoreRuntimeError(error);
    return true;
};

/******************************************************************************/

export {
    errorMessageFrom,
    isIgnorableRuntimeError,
    ignoreRuntimeError,
    runtimeLastErrorFrom,
    ignoreRuntimeLastError,
};
