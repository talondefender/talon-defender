/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2025-present Raymond Hill

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

(api => {
    if ( typeof api === 'object' ) { return; }
    // A byte-identical sheet can legitimately be owned by more than one
    // cosmetic subsystem. Keep every owner so removing one scope cannot tear
    // down CSS which is still required by another.
    const sheets = new Map();
    const maxCssPayloadLength = 100000;
    const messageTimeoutMs = 15000;
    let operationTail = Promise.resolve();
    const enqueue = operation => {
        const run = operationTail.then(operation);
        operationTail = run.catch(() => {});
        return run;
    };
    const sendMessageBounded = payload => {
        let raw;
        try {
            raw = Promise.resolve(chrome.runtime.sendMessage(payload));
        } catch (reason) {
            return Promise.reject(reason);
        }
        raw.catch(() => {});
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = self.setTimeout(() => {
                if ( settled ) { return; }
                settled = true;
                reject(new Error('CSS runtime message timed out'));
            }, messageTimeoutMs);
            raw.then(value => {
                if ( settled ) { return; }
                settled = true;
                self.clearTimeout(timer);
                resolve(value);
            }, reason => {
                if ( settled ) { return; }
                settled = true;
                self.clearTimeout(timer);
                reject(reason);
            });
        });
    };
    const removePhysicalSheet = async css => {
        const response = await sendMessageBounded({
            what: 'removeCSS',
            css,
        });
        if ( response?.ok !== true ) {
            throw new Error(response?.error || 'remove CSS failed');
        }
    };
    const selectorListCssChunks = (
        selectors,
        declaration = '{display:none!important;}'
    ) => {
        if ( Array.isArray(selectors) === false || selectors.length === 0 ) {
            return [];
        }
        if ( typeof declaration !== 'string' ) {
            throw new TypeError('invalid CSS declaration');
        }
        const budget = maxCssPayloadLength - declaration.length;
        const chunks = [];
        let chunk = '';
        for ( const selector of selectors ) {
            if ( typeof selector !== 'string' || selector === '' ) { continue; }
            if ( selector.length > budget ) {
                throw new Error('selector exceeds CSS message limit');
            }
            const candidate = chunk === '' ? selector : `${chunk},\n${selector}`;
            if ( candidate.length <= budget ) {
                chunk = candidate;
                continue;
            }
            chunks.push(`${chunk}${declaration}`);
            chunk = selector;
        }
        if ( chunk !== '' ) { chunks.push(`${chunk}${declaration}`); }
        return chunks;
    };
    self.cssAPI = {
        supportsScopedOwnership: true,
        selectorListCssChunks,
        insert(css, scope = 'core') {
            if ( typeof css !== 'string' || css === '' ) { return; }
            const owner = typeof scope === 'string' && scope !== ''
                ? scope
                : 'core';
            // Ownership changes are part of the same ordered operation as the
            // physical CSS mutation. This prevents a reinsert from attaching
            // itself to a record whose removal is still in flight.
            return enqueue(async () => {
                const existing = sheets.get(css);
                if ( existing ) {
                    existing.owners.add(owner);
                    return;
                }
                const record = { owners: new Set([ owner ]) };
                sheets.set(css, record);
                try {
                    const response = await sendMessageBounded({
                        what: 'insertCSS',
                        css,
                    });
                    if ( response?.ok !== true ) {
                        throw new Error(response?.error || 'insert CSS failed');
                    }
                } catch (reason) {
                    if ( sheets.get(css) === record ) { sheets.delete(css); }
                    throw reason;
                }
            });
        },
        remove(css, scope) {
            if ( typeof css !== 'string' || css === '' ) {
                return Promise.resolve();
            }
            return enqueue(async () => {
                const record = sheets.get(css);
                if ( record === undefined ) { return; }
                const previousOwners = new Set(record.owners);
                if ( typeof scope === 'string' && scope !== '' ) {
                    record.owners.delete(scope);
                } else {
                    record.owners.clear();
                }
                if ( record.owners.size !== 0 ) { return; }
                try {
                    await removePhysicalSheet(css);
                    if ( sheets.get(css) === record ) { sheets.delete(css); }
                } catch (reason) {
                    record.owners = previousOwners;
                    throw reason;
                }
            });
        },
        removeAll(scope) {
            return enqueue(async () => {
                for ( const [ css, record ] of Array.from(sheets) ) {
                    const previousOwners = new Set(record.owners);
                    if ( scope === undefined ) {
                        record.owners.clear();
                    } else {
                        record.owners.delete(scope);
                    }
                    if ( record.owners.size !== 0 ) { continue; }
                    try {
                        await removePhysicalSheet(css);
                        if ( sheets.get(css) === record ) { sheets.delete(css); }
                    } catch (reason) {
                        record.owners = previousOwners;
                        throw reason;
                    }
                }
            });
        },
    };
})(self.cssAPI);
