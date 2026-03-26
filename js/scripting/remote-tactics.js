// MAIN-world packaged interpreter for bounded remote JSON response tactics.
(function talonRemoteTactics() {
    const REQUEST_EVENT = 'td-remote-tactics-request';
    const CONFIG_EVENT = 'td-remote-tactics-config';
    const HIT_EVENT = 'td-remote-tactics-hit';
    const CONFIG_WAIT_TIMEOUT_MS = 250;
    const hostname = (self.location?.hostname || '').trim().toLowerCase();
    const nativeFetch = typeof self.fetch === 'function' ? self.fetch : undefined;
    const NativeXMLHttpRequest = typeof self.XMLHttpRequest === 'function'
        ? self.XMLHttpRequest
        : undefined;
    const nativeXhrSend = typeof NativeXMLHttpRequest?.prototype?.send === 'function'
        ? NativeXMLHttpRequest.prototype.send
        : undefined;

    const VALID_KIND_SET = 'jsonSet';
    const VALID_KIND_PRUNE = 'jsonPrune';
    const VALID_TRANSPORT_BOTH = 'both';
    const VALID_PHASE_RESPONSE = 'response';
    const VALID_PHASE_REQUEST = 'request';

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

    const isObjectLike = value => value !== null && typeof value === 'object';

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
            if ( isObjectLike(entry) === false ) { continue; }
            const id = typeof entry.id === 'string' ? entry.id.trim() : '';
            const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
            const transport = typeof entry.transport === 'string'
                ? entry.transport.trim()
                : '';
            const phase = typeof entry.phase === 'string'
                ? entry.phase.trim()
                : VALID_PHASE_RESPONSE;
            const urlPathPrefixes = Array.isArray(entry.urlPathPrefixes)
                ? entry.urlPathPrefixes.filter(v => typeof v === 'string' && v !== '')
                : [];
            const jsonPaths = Array.isArray(entry.jsonPaths)
                ? entry.jsonPaths.filter(v => typeof v === 'string' && v !== '')
                : [];
            if (
                id === '' ||
                (kind !== VALID_KIND_PRUNE && kind !== VALID_KIND_SET) ||
                (phase !== VALID_PHASE_RESPONSE && phase !== VALID_PHASE_REQUEST) ||
                (transport !== 'fetch' && transport !== 'xhr' && transport !== VALID_TRANSPORT_BOTH) ||
                urlPathPrefixes.length === 0 ||
                jsonPaths.length === 0
            ) {
                continue;
            }
            const tactic = {
                id,
                kind,
                phase,
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

    const applicableTactics = (transport, pathname, phase = VALID_PHASE_RESPONSE) => state.tactics.filter(entry => (
        (entry.phase || VALID_PHASE_RESPONSE) === phase
    )).filter(entry => (
        entry.transport === transport ||
        entry.transport === VALID_TRANSPORT_BOTH
    )).filter(entry => (
        entry.urlPathPrefixes.some(prefix => pathname.startsWith(prefix))
    ));

    const emitHitEvent = detail => {
        try {
            document.dispatchEvent(new CustomEvent(HIT_EVENT, {
                detail: isObjectLike(detail) ? { ...detail } : {},
            }));
        } catch {
        }
    };

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
            if ( isObjectLike(root) ) {
                for ( const key of Object.keys(root) ) {
                    collectConcretePaths(root[key], segments, index + 1, [ ...prefix, key ], out);
                }
            }
            return out;
        }
        if ( isObjectLike(root) === false || Object.hasOwn(root, segment) === false ) {
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
            if ( isObjectLike(owner) === false || Object.hasOwn(owner, key) === false ) {
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
                if ( ref === null || isObjectLike(ref.owner) === false ) { continue; }
                ref.owner[ref.key] = cloneJsonValue(tactic.value);
                mutated = true;
            }
            return mutated;
        }
        for ( const path of targets.sort(compareConcretePathsForDeletion) ) {
            const ref = resolvePathOwner(root, path);
            if ( ref === null || isObjectLike(ref.owner) === false ) { continue; }
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
        if ( isObjectLike(input) === false || matchingTactics.length === 0 ) {
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

    const isBodyEligibleMethod = method => {
        const normalized = typeof method === 'string'
            ? method.trim().toUpperCase()
            : 'GET';
        return normalized !== 'GET' && normalized !== 'HEAD';
    };

    const applyTacticsToJsonText = (bodyText, matchingTactics, hitDetail) => {
        if ( typeof bodyText !== 'string' || bodyText === '' || matchingTactics.length === 0 ) {
            return { applied: false, bodyText };
        }
        try {
            const payload = JSON.parse(bodyText);
            if ( isObjectLike(payload) === false ) {
                return { applied: false, bodyText };
            }
            const result = applyTacticsToJson(payload, matchingTactics);
            if ( result.applied !== true ) {
                return { applied: false, bodyText };
            }
            emitHitEvent(hitDetail);
            return {
                applied: true,
                bodyText: JSON.stringify(result.value),
            };
        } catch {
        }
        return { applied: false, bodyText };
    };

    const getFetchCandidateUrl = args => parseUrl(
        args?.[0] instanceof Request
            ? args[0].url
            : String(args?.[0] || '')
    );

    const resolveFetchMethod = args => {
        const init = args?.[1];
        if ( typeof init?.method === 'string' && init.method.trim() !== '' ) {
            return init.method;
        }
        if ( args?.[0] instanceof Request ) {
            return args[0].method;
        }
        return 'GET';
    };

    const maybeRewriteFetchRequestArgs = args => {
        const init = args?.[1];
        if ( isObjectLike(init) === false || typeof init.body !== 'string' ) {
            return args;
        }
        const candidateUrl = getFetchCandidateUrl(args);
        if ( isInspectableUrl(candidateUrl) === false ) { return args; }
        if ( isBodyEligibleMethod(resolveFetchMethod(args)) === false ) { return args; }
        const matchingTactics = applicableTactics(
            'fetch',
            candidateUrl.pathname,
            VALID_PHASE_REQUEST
        );
        if ( matchingTactics.length === 0 ) { return args; }
        const result = applyTacticsToJsonText(init.body, matchingTactics, {
            hostname,
            pathname: candidateUrl.pathname,
            phase: VALID_PHASE_REQUEST,
            transport: 'fetch',
        });
        if ( result.applied !== true ) { return args; }
        const nextArgs = Array.isArray(args) ? args.slice() : [];
        nextArgs[1] = {
            ...init,
            body: result.bodyText,
        };
        return nextArgs;
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
        const candidateUrl = parseUrl(response.url) || getFetchCandidateUrl(args);
        if ( isInspectableUrl(candidateUrl) === false ) { return response; }
        const matchingTactics = applicableTactics(
            'fetch',
            candidateUrl.pathname,
            VALID_PHASE_RESPONSE
        );
        if ( matchingTactics.length === 0 ) { return response; }
        const contentType = `${response.headers?.get?.('content-type') || ''}`;
        if ( /json/i.test(contentType) === false ) { return response; }
        try {
            const payload = await response.clone().json();
            if ( isObjectLike(payload) === false ) { return response; }
            const result = applyTacticsToJson(payload, matchingTactics);
            if ( result.applied === false ) { return response; }
            emitHitEvent({
                hostname,
                pathname: candidateUrl.pathname,
                phase: VALID_PHASE_RESPONSE,
                transport: 'fetch',
            });
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
            if ( isObjectLike(innerResponse) === false ) {
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
            if ( isObjectLike(value) === false ) {
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

    if ( typeof self.fetch === 'function' ) {
        self.fetch = new Proxy(self.fetch, {
            async apply(target, thisArg, args) {
                let nextArgs = args;
                const candidateUrl = getFetchCandidateUrl(args);
                const shouldAwaitConfig =
                    isInspectableUrl(candidateUrl) &&
                    isObjectLike(args?.[1]) &&
                    typeof args[1]?.body === 'string' &&
                    isBodyEligibleMethod(resolveFetchMethod(args));
                if ( shouldAwaitConfig && state.configResolved === false ) {
                    await state.configReady.catch(() => {});
                }
                if ( shouldAwaitConfig ) {
                    nextArgs = maybeRewriteFetchRequestArgs(args);
                }
                const response = await Reflect.apply(target, thisArg, nextArgs);
                return rewriteFetchResponse(response, nextArgs);
            },
        });
    }

    const pendingXhrSends = new Set();

    const resetCachedXhrResponse = xhr => {
        xhr.signature = '';
        xhr.hasCachedResponse = false;
        xhr.response = undefined;
        xhr.responseText = undefined;
    };

    const clearPendingXhrSend = xhr => {
        if ( xhr?.pendingSend !== true ) { return false; }
        xhr.pendingSend = false;
        xhr.pendingArgs = undefined;
        pendingXhrSends.delete(xhr);
        return true;
    };

    const flushPendingXhrSend = xhr => {
        if ( xhr?.pendingSend !== true ) { return false; }
        const sendArgs = Array.isArray(xhr.pendingArgs) ? xhr.pendingArgs : [];
        clearPendingXhrSend(xhr);
        if ( typeof nativeXhrSend !== 'function' ) { return false; }
        try {
            Reflect.apply(nativeXhrSend, xhr.instance, rewriteXhrSendArgs(xhr, sendArgs));
            return true;
        } catch {
        }
        return false;
    };

    const rewriteXhrSendArgs = (xhr, args) => {
        if (
            isObjectLike(xhr) === false ||
            Array.isArray(args) === false ||
            typeof args[0] !== 'string'
        ) {
            return args;
        }
        const requestUrl = parseUrl(xhr.url);
        if ( isInspectableUrl(requestUrl) === false ) { return args; }
        if ( isBodyEligibleMethod(xhr.method) === false ) { return args; }
        const matchingTactics = applicableTactics(
            'xhr',
            requestUrl.pathname,
            VALID_PHASE_REQUEST
        );
        if ( matchingTactics.length === 0 ) { return args; }
        const result = applyTacticsToJsonText(args[0], matchingTactics, {
            hostname,
            pathname: requestUrl.pathname,
            phase: VALID_PHASE_REQUEST,
            transport: 'xhr',
        });
        if ( result.applied !== true ) { return args; }
        const nextArgs = args.slice();
        nextArgs[0] = result.bodyText;
        return nextArgs;
    };

    const resolvePatchedXhrResponse = (
        xhr,
        innerResponse,
        readRawText,
        getHeader,
        responseType
    ) => {
        if ( xhr === undefined || state.tactics.length === 0 ) {
            return innerResponse;
        }
        const requestUrl = parseUrl(xhr.url);
        if ( isInspectableUrl(requestUrl) === false ) {
            return innerResponse;
        }
        const matchingTactics = applicableTactics(
            'xhr',
            requestUrl.pathname,
            VALID_PHASE_RESPONSE
        );
        if ( matchingTactics.length === 0 ) {
            return innerResponse;
        }
        const resolvedResponseType = typeof responseType === 'string'
            ? responseType
            : '';
        const rawText = (
            typeof innerResponse === 'string'
                ? innerResponse
                : safeGetResponseText(readRawText)
        );
        const carrier = resolveXhrJsonCarrier({
            innerResponse,
            responseType: resolvedResponseType,
            rawText,
            contentType: safeGetHeader(getHeader, 'content-type'),
        });
        if ( carrier.ok !== true ) {
            return innerResponse;
        }
        const signature = `${carrier.outputKind}\n${carrier.rawSignature}`;
        if ( xhr.signature === signature && xhr.hasCachedResponse === true ) {
            return xhr.response;
        }
        try {
            const result = applyTacticsToJson(carrier.value, matchingTactics);
            xhr.signature = signature;
            xhr.hasCachedResponse = true;
            if ( result.applied === false ) {
                xhr.response = innerResponse;
                xhr.responseText = carrier.outputKind === 'text' ? rawText : undefined;
                return innerResponse;
            }
            emitHitEvent({
                hostname,
                pathname: requestUrl.pathname,
                phase: VALID_PHASE_RESPONSE,
                transport: 'xhr',
            });
            xhr.response = carrier.outputKind === 'text'
                ? JSON.stringify(result.value)
                : result.value;
            xhr.responseText = carrier.outputKind === 'text' ? xhr.response : undefined;
            return xhr.response;
        } catch {
        }
        resetCachedXhrResponse(xhr);
        return innerResponse;
    };

    const configEventListener = event => {
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
    };

    const stopController = () => {
        clearConfigTimeout();
        state.tactics = [];
        state.expectConfig = false;
        if ( state.configResolved === false ) {
            finalizeConfig(state.activeRequestId, []);
        }
        state.configReady = Promise.resolve([]);
        for ( const xhr of Array.from(pendingXhrSends) ) {
            flushPendingXhrSend(xhr);
        }
        try {
            document.removeEventListener(CONFIG_EVENT, configEventListener, true);
        } catch {
        }
        if ( typeof nativeFetch === 'function' ) {
            self.fetch = nativeFetch;
        }
        if ( typeof NativeXMLHttpRequest === 'function' ) {
            self.XMLHttpRequest = NativeXMLHttpRequest;
        }
        try {
            delete self.TalonRemoteTacticsController;
        } catch {
            self.TalonRemoteTacticsController = undefined;
        }
        return Promise.resolve(true);
    };

    if ( self.TalonRemoteTacticsController ) {
        self.TalonRemoteTacticsController.refresh().catch(() => {});
        return;
    }

    document.addEventListener(CONFIG_EVENT, configEventListener, true);

    if ( typeof self.XMLHttpRequest === 'function' ) {
        const xhrState = new WeakMap();

        self.XMLHttpRequest = class extends NativeXMLHttpRequest {
            open(method, url, ...args) {
                xhrState.set(this, {
                    instance: this,
                    method: typeof method === 'string' ? method : 'GET',
                    url: parseUrl(String(url || ''))?.toString() || '',
                    async: args.length === 0 || args[0] !== false,
                    signature: '',
                    hasCachedResponse: false,
                    response: undefined,
                    responseText: undefined,
                    pendingSend: false,
                    pendingArgs: undefined,
                });
                return super.open(method, url, ...args);
            }
            send(...args) {
                const xhr = xhrState.get(this);
                const inspectable = isInspectableUrl(parseUrl(xhr?.url));
                if (
                    xhr === undefined ||
                    inspectable === false ||
                    typeof nativeXhrSend !== 'function'
                ) {
                    return super.send(...args);
                }
                if ( xhr.async !== true || state.configResolved === true ) {
                    return super.send(...rewriteXhrSendArgs(xhr, args));
                }
                if ( xhr.pendingSend === true ) { return; }
                xhr.pendingSend = true;
                xhr.pendingArgs = args;
                pendingXhrSends.add(xhr);
                Promise.resolve(state.configReady)
                    .catch(() => {})
                    .then(() => {
                        const currentXhr = xhrState.get(this);
                        if ( currentXhr !== xhr ) { return; }
                        flushPendingXhrSend(xhr);
                    });
            }
            abort(...args) {
                const xhr = xhrState.get(this);
                if ( xhr !== undefined ) {
                    clearPendingXhrSend(xhr);
                }
                return super.abort(...args);
            }
            get response() {
                const xhr = xhrState.get(this);
                return resolvePatchedXhrResponse(
                    xhr,
                    super.response,
                    () => super.responseText,
                    name => super.getResponseHeader(name),
                    super.responseType
                );
            }
            get responseText() {
                const response = resolvePatchedXhrResponse(
                    xhrState.get(this),
                    super.response,
                    () => super.responseText,
                    name => super.getResponseHeader(name),
                    super.responseType
                );
                return typeof response === 'string'
                    ? response
                    : super.responseText;
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
