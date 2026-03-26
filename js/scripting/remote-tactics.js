// MAIN-world packaged interpreter for bounded remote JSON response tactics.
(function talonRemoteTactics() {
    const REQUEST_EVENT = 'td-remote-tactics-request';
    const CONFIG_EVENT = 'td-remote-tactics-config';
    const CONFIG_WAIT_TIMEOUT_MS = 250;
    const hostname = (self.location?.hostname || '').trim().toLowerCase();

    const VALID_KIND_SET = 'jsonSet';
    const VALID_KIND_PRUNE = 'jsonPrune';
    const VALID_TRANSPORT_BOTH = 'both';

    const state = {
        tactics: [],
        configResolved: true,
        expectConfig: false,
        activeRequestId: 0,
        nextRequestId: 0,
        configReady: Promise.resolve([]),
        resolveConfig: undefined,
        configTimeout: 0,
    };

    const clearConfigTimeout = () => {
        if ( state.configTimeout === 0 ) { return; }
        self.clearTimeout(state.configTimeout);
        state.configTimeout = 0;
    };

    const finalizeConfig = (requestId, nextTactics = state.tactics) => {
        if ( requestId !== state.activeRequestId ) { return; }
        if ( state.configResolved ) { return; }
        state.configResolved = true;
        state.expectConfig = false;
        clearConfigTimeout();
        state.resolveConfig?.(nextTactics);
        state.resolveConfig = undefined;
    };

    const cloneJsonValue = value => (
        value === null || value === false || value === 0 || value === ''
            ? value
            : structuredClone(value)
    );

    const normalizeIncomingTactics = input => {
        if ( Array.isArray(input) === false ) { return []; }
        const out = [];
        for ( const entry of input ) {
            if ( entry instanceof Object === false ) { continue; }
            const id = typeof entry.id === 'string' ? entry.id.trim() : '';
            const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
            const transport = typeof entry.transport === 'string'
                ? entry.transport.trim()
                : '';
            const urlPathPrefixes = Array.isArray(entry.urlPathPrefixes)
                ? entry.urlPathPrefixes.filter(v => typeof v === 'string' && v !== '')
                : [];
            const jsonPaths = Array.isArray(entry.jsonPaths)
                ? entry.jsonPaths.filter(v => typeof v === 'string' && v !== '')
                : [];
            if (
                id === '' ||
                (kind !== VALID_KIND_PRUNE && kind !== VALID_KIND_SET) ||
                (transport !== 'fetch' && transport !== 'xhr' && transport !== VALID_TRANSPORT_BOTH) ||
                urlPathPrefixes.length === 0 ||
                jsonPaths.length === 0
            ) {
                continue;
            }
            const tactic = {
                id,
                kind,
                transport,
                urlPathPrefixes,
                jsonPaths,
            };
            if ( kind === VALID_KIND_SET ) {
                tactic.value = cloneJsonValue(entry.value);
            }
            out.push(tactic);
        }
        return out;
    };

    const beginConfigRefresh = () => {
        clearConfigTimeout();
        state.activeRequestId = ++state.nextRequestId;
        state.configResolved = false;
        state.expectConfig = true;
        state.configReady = new Promise(resolve => {
            state.resolveConfig = resolve;
        });
        const requestId = state.activeRequestId;
        state.configTimeout = self.setTimeout(() => {
            finalizeConfig(requestId, state.tactics);
        }, CONFIG_WAIT_TIMEOUT_MS);
        return requestId;
    };

    const requestConfig = requestId => {
        try {
            document.dispatchEvent(new CustomEvent(REQUEST_EVENT, {
                detail: { hostname, requestId },
            }));
        } catch {
            finalizeConfig(requestId, state.tactics);
        }
        return state.configReady;
    };

    const refreshConfig = () => requestConfig(beginConfigRefresh());

    const stopController = () => {
        clearConfigTimeout();
        state.tactics = [];
        state.expectConfig = false;
        if ( state.configResolved === false ) {
            finalizeConfig(state.activeRequestId, []);
        }
        state.configReady = Promise.resolve([]);
        return Promise.resolve(true);
    };

    if ( self.TalonRemoteTacticsController ) {
        self.TalonRemoteTacticsController.refresh().catch(() => {});
        return;
    }

    document.addEventListener(CONFIG_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        if ( detail?.hostname && `${detail.hostname}`.trim().toLowerCase() !== hostname ) {
            return;
        }
        const requestId = Number(detail?.requestId) || 0;
        if (
            requestId !== state.activeRequestId &&
            (requestId !== 0 || state.expectConfig !== true)
        ) {
            return;
        }
        state.tactics = normalizeIncomingTactics(detail?.tactics);
        finalizeConfig(state.activeRequestId, state.tactics);
    }, true);

    const parseUrl = value => {
        if ( typeof value !== 'string' || value === '' ) { return null; }
        try {
            return new URL(value, self.location?.href || 'https://example.invalid/');
        } catch {
        }
        return null;
    };

    const isInspectableUrl = url => (
        url instanceof URL &&
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.hostname.toLowerCase() === hostname
    );

    const applicableTactics = (transport, pathname) => state.tactics.filter(entry => (
        entry.transport === transport ||
        entry.transport === VALID_TRANSPORT_BOTH
    )).filter(entry => (
        entry.urlPathPrefixes.some(prefix => pathname.startsWith(prefix))
    ));

    const collectConcretePaths = (root, segments, index = 0, prefix = [], out = []) => {
        if ( index >= segments.length ) {
            out.push(prefix.slice());
            return out;
        }
        const segment = segments[index];
        if ( segment === '[]' ) {
            if ( Array.isArray(root) === false ) { return out; }
            for ( let i = 0; i < root.length; i++ ) {
                collectConcretePaths(root[i], segments, index + 1, [ ...prefix, i ], out);
            }
            return out;
        }
        if ( segment === '*' ) {
            if ( Array.isArray(root) ) {
                for ( let i = 0; i < root.length; i++ ) {
                    collectConcretePaths(root[i], segments, index + 1, [ ...prefix, i ], out);
                }
                return out;
            }
            if ( root instanceof Object ) {
                for ( const key of Object.keys(root) ) {
                    collectConcretePaths(root[key], segments, index + 1, [ ...prefix, key ], out);
                }
            }
            return out;
        }
        if ( root instanceof Object === false || Object.hasOwn(root, segment) === false ) {
            return out;
        }
        collectConcretePaths(root[segment], segments, index + 1, [ ...prefix, segment ], out);
        return out;
    };

    const resolvePathOwner = (root, path) => {
        if ( Array.isArray(path) === false || path.length === 0 ) { return null; }
        let owner = root;
        for ( let i = 0; i < path.length - 1; i++ ) {
            const key = path[i];
            if ( owner instanceof Object === false || Object.hasOwn(owner, key) === false ) {
                return null;
            }
            owner = owner[key];
        }
        return {
            owner,
            key: path[path.length - 1],
        };
    };

    const compareConcretePathsForDeletion = (left, right) => {
        if ( left.length !== right.length ) {
            return right.length - left.length;
        }
        const leftParent = JSON.stringify(left.slice(0, -1));
        const rightParent = JSON.stringify(right.slice(0, -1));
        if ( leftParent === rightParent ) {
            const leftKey = left[left.length - 1];
            const rightKey = right[right.length - 1];
            if ( typeof leftKey === 'number' && typeof rightKey === 'number' ) {
                return rightKey - leftKey;
            }
        }
        return JSON.stringify(right).localeCompare(JSON.stringify(left));
    };

    const applyPathMutation = (root, pathQuery, tactic) => {
        if ( typeof pathQuery !== 'string' || pathQuery === '' ) { return false; }
        const segments = pathQuery.split('.');
        const targets = collectConcretePaths(root, segments);
        if ( targets.length === 0 ) { return false; }
        let mutated = false;
        if ( tactic.kind === VALID_KIND_SET ) {
            for ( const path of targets ) {
                const ref = resolvePathOwner(root, path);
                if ( ref === null || ref.owner instanceof Object === false ) { continue; }
                ref.owner[ref.key] = cloneJsonValue(tactic.value);
                mutated = true;
            }
            return mutated;
        }
        for ( const path of targets.sort(compareConcretePathsForDeletion) ) {
            const ref = resolvePathOwner(root, path);
            if ( ref === null || ref.owner instanceof Object === false ) { continue; }
            if ( Array.isArray(ref.owner) && typeof ref.key === 'number' ) {
                if ( ref.key < 0 || ref.key >= ref.owner.length ) { continue; }
                ref.owner.splice(ref.key, 1);
            } else if ( Object.hasOwn(ref.owner, ref.key) ) {
                delete ref.owner[ref.key];
            } else {
                continue;
            }
            mutated = true;
        }
        return mutated;
    };

    const applyTacticsToJson = (input, matchingTactics) => {
        if ( input instanceof Object === false || matchingTactics.length === 0 ) {
            return { applied: false, value: input };
        }
        const clone = structuredClone(input);
        let applied = false;
        for ( const tactic of matchingTactics ) {
            for ( const pathQuery of tactic.jsonPaths ) {
                applied = applyPathMutation(clone, pathQuery, tactic) || applied;
            }
        }
        return {
            applied,
            value: applied ? clone : input,
        };
    };

    const preserveFetchResponseMetadata = (source, target) => {
        try {
            Object.defineProperties(target, {
                ok: { value: source.ok },
                redirected: { value: source.redirected },
                type: { value: source.type },
                url: { value: source.url },
            });
        } catch {
        }
    };

    const rewriteFetchResponse = async (response, args) => {
        if ( response instanceof Response === false ) { return response; }
        await state.configReady.catch(() => {});
        if ( state.tactics.length === 0 ) { return response; }
        const candidateUrl = parseUrl(response.url) || parseUrl(
            args?.[0] instanceof Request
                ? args[0].url
                : String(args?.[0] || '')
        );
        if ( isInspectableUrl(candidateUrl) === false ) { return response; }
        const matchingTactics = applicableTactics('fetch', candidateUrl.pathname);
        if ( matchingTactics.length === 0 ) { return response; }
        const contentType = `${response.headers?.get?.('content-type') || ''}`;
        if ( /json/i.test(contentType) === false ) { return response; }
        try {
            const payload = await response.clone().json();
            if ( payload instanceof Object === false ) { return response; }
            const result = applyTacticsToJson(payload, matchingTactics);
            if ( result.applied === false ) { return response; }
            const rewritten = Response.json(result.value, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
            preserveFetchResponseMetadata(response, rewritten);
            return rewritten;
        } catch {
        }
        return response;
    };

    if ( typeof self.fetch === 'function' ) {
        self.fetch = new Proxy(self.fetch, {
            apply(target, thisArg, args) {
                const fetchPromise = Reflect.apply(target, thisArg, args);
                return Promise.resolve(fetchPromise).then(
                    response => rewriteFetchResponse(response, args),
                    () => fetchPromise
                );
            },
        });
    }

    const safeGetResponseText = getter => {
        try {
            return getter();
        } catch {
        }
        return '';
    };

    const safeGetHeader = (getHeader, name) => {
        try {
            return `${getHeader?.(name) || ''}`;
        } catch {
        }
        return '';
    };

    const buildRawJsonSignature = value => {
        if ( typeof value === 'string' ) { return value; }
        try {
            return JSON.stringify(value);
        } catch {
        }
        return '';
    };

    const resolveXhrJsonCarrier = ({
        innerResponse,
        responseType,
        rawText,
        contentType,
    }) => {
        if ( responseType === 'json' ) {
            if ( innerResponse instanceof Object === false ) {
                return { ok: false };
            }
            return {
                ok: true,
                value: innerResponse,
                outputKind: 'json',
                rawSignature: buildRawJsonSignature(innerResponse),
            };
        }
        if ( responseType !== '' && responseType !== 'text' ) {
            return { ok: false };
        }
        if ( /json/i.test(contentType) === false || typeof rawText !== 'string' || rawText === '' ) {
            return { ok: false };
        }
        try {
            const value = JSON.parse(rawText);
            if ( value instanceof Object === false ) {
                return { ok: false };
            }
            return {
                ok: true,
                value,
                outputKind: 'text',
                rawSignature: rawText,
            };
        } catch {
        }
        return { ok: false };
    };

    if ( typeof self.XMLHttpRequest === 'function' ) {
        const NativeXMLHttpRequest = self.XMLHttpRequest;
        const xhrState = new WeakMap();

        self.XMLHttpRequest = class extends NativeXMLHttpRequest {
            open(method, url, ...args) {
                xhrState.set(this, {
                    url: parseUrl(String(url || ''))?.toString() || '',
                    response: undefined,
                    responseText: undefined,
                    signature: '',
                });
                return super.open(method, url, ...args);
            }
            get response() {
                const xhr = xhrState.get(this);
                const innerResponse = super.response;
                if ( xhr === undefined || state.tactics.length === 0 ) {
                    return innerResponse;
                }
                const requestUrl = parseUrl(xhr.url);
                if ( isInspectableUrl(requestUrl) === false ) {
                    return innerResponse;
                }
                const matchingTactics = applicableTactics('xhr', requestUrl.pathname);
                if ( matchingTactics.length === 0 ) {
                    return innerResponse;
                }
                const responseType = typeof super.responseType === 'string'
                    ? super.responseType
                    : '';
                const rawText = (
                    typeof innerResponse === 'string'
                        ? innerResponse
                        : safeGetResponseText(() => super.responseText)
                );
                const carrier = resolveXhrJsonCarrier({
                    innerResponse,
                    responseType,
                    rawText,
                    contentType: safeGetHeader(
                        name => super.getResponseHeader(name),
                        'content-type'
                    ),
                });
                if ( carrier.ok !== true ) {
                    return innerResponse;
                }
                const signature = `${carrier.outputKind}\n${carrier.rawSignature}`;
                if ( xhr.signature === signature && xhr.response !== undefined ) {
                    return xhr.response;
                }
                try {
                    const result = applyTacticsToJson(carrier.value, matchingTactics);
                    if ( result.applied === false ) {
                        xhr.signature = signature;
                        xhr.response = innerResponse;
                        xhr.responseText = carrier.outputKind === 'text' ? rawText : undefined;
                        return innerResponse;
                    }
                    xhr.signature = signature;
                    xhr.response = carrier.outputKind === 'text'
                        ? JSON.stringify(result.value)
                        : result.value;
                    xhr.responseText = JSON.stringify(result.value);
                    return xhr.response;
                } catch {
                }
                return innerResponse;
            }
            get responseText() {
                const xhr = xhrState.get(this);
                if ( typeof xhr?.responseText === 'string' ) {
                    return xhr.responseText;
                }
                return super.responseText;
            }
        };
    }

    self.TalonRemoteTacticsController = {
        refresh() {
            return refreshConfig();
        },
        stop() {
            return stopController();
        },
    };

    self.TalonRemoteTacticsController.refresh().catch(() => {});
})();
