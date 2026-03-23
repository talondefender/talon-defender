// Bridge MAIN-world watch-page requests to extension APIs.
(function talonYouTubeWatchBridge() {
    const BRIDGE_HEALTH_SESSION_KEY = '__td_yw_bridge_health';
    const persistBridgeHealth = patch => {
        if ( patch === null || typeof patch !== 'object' ) { return; }
        try {
            const previousRaw = self.sessionStorage?.getItem(BRIDGE_HEALTH_SESSION_KEY) || '';
            const previous = previousRaw === '' ? {} : JSON.parse(previousRaw);
            const next = {
                ...(previous && typeof previous === 'object' ? previous : {}),
                ...patch,
                updatedAt: Date.now(),
            };
            self.sessionStorage?.setItem(BRIDGE_HEALTH_SESSION_KEY, JSON.stringify(next));
        } catch {}
    };
    const markBridgeFatal = reason => {
        persistBridgeHealth({
            stage: 'fatal',
            fatalError: `${reason}`,
            fatalAt: Date.now(),
        });
    };
    persistBridgeHealth({
        stage: 'started',
        startedAt: Date.now(),
    });
    try {
    if ( self.__talonYouTubeWatchBridge === true ) { return; }
    self.__talonYouTubeWatchBridge = true;

    const runtime = self.browser?.runtime || self.chrome?.runtime;
    if ( runtime?.sendMessage === undefined ) {
        persistBridgeHealth({
            stage: 'runtime-missing',
        });
        return;
    }
    persistBridgeHealth({
        stage: 'runtime-ready',
        runtimeReadyAt: Date.now(),
    });

    const REQUEST_EVENT = 'td-yw-followup-cookie-clear';
    const RESPONSE_EVENT = 'td-yw-followup-cookie-clear-result';
    const PREFETCH_REQUEST_EVENT = 'td-yw-followup-prefetch-sections';
    const PREFETCH_RESPONSE_EVENT = 'td-yw-followup-prefetch-sections-result';
    const PREFETCH_DONOR_CAPTURE_EVENT = 'td-yw-followup-prefetch-donor-capture';
    const NAVIGATE_REQUEST_EVENT = 'td-yw-followup-tab-navigate';
    const NAVIGATE_RESPONSE_EVENT = 'td-yw-followup-tab-navigate-result';
    const NEXT_RELEASE_EVENT = 'td-yw-followup-next-release';
    const ARCHITECTURE_REQUEST_EVENT = 'td-yw-followup-architecture-proof';
    const ARCHITECTURE_RESPONSE_EVENT = 'td-yw-followup-architecture-proof-result';
    const ARCHITECTURE_PORT_NAME = 'td-yw-followup-architecture-proof';

    document.addEventListener(REQUEST_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const requestId = typeof detail?.requestId === 'string' ? detail.requestId : '';
        const targetUrl = typeof detail?.targetUrl === 'string' ? detail.targetUrl : '';
        if ( requestId === '' ) { return; }

        let responded = false;
        const respond = payload => {
            if ( responded ) { return; }
            responded = true;
            try {
                document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
                    detail: {
                        requestId,
                        ...(payload instanceof Object ? payload : {}),
                    },
                }));
            } catch {}
        };

        try {
            runtime.sendMessage({ what: 'clearYouTubeFollowupCookies', targetUrl }, response => {
                const lastError = self.chrome?.runtime?.lastError;
                if ( lastError ) {
                    respond({ ok: false, error: `${lastError.message || lastError}` });
                    return;
                }
                respond(response instanceof Object ? response : { ok: false });
            });
        } catch(reason) {
            respond({ ok: false, error: `${reason}` });
        }
    }, true);

    document.addEventListener(PREFETCH_REQUEST_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const requestId = typeof detail?.requestId === 'string' ? detail.requestId : '';
        const targetUrl = typeof detail?.targetUrl === 'string' ? detail.targetUrl : '';
        if ( requestId === '' || targetUrl === '' ) { return; }

        let responded = false;
        const respond = payload => {
            if ( responded ) { return; }
            responded = true;
            try {
                document.dispatchEvent(new CustomEvent(PREFETCH_RESPONSE_EVENT, {
                    detail: {
                        requestId,
                        ...(payload instanceof Object ? payload : {}),
                    },
                }));
            } catch {}
        };

        try {
            runtime.sendMessage(
                { what: 'prefetchYouTubeFollowupPlayerResponseSections', targetUrl },
                response => {
                    const lastError = self.chrome?.runtime?.lastError;
                    if ( lastError ) {
                        respond({ ok: false, error: `${lastError.message || lastError}` });
                        return;
                    }
                    respond(response instanceof Object ? response : { ok: false });
                }
            );
        } catch(reason) {
            respond({ ok: false, error: `${reason}` });
        }
    }, true);

    document.addEventListener(PREFETCH_DONOR_CAPTURE_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const donorToken = typeof detail?.donorToken === 'string' ? detail.donorToken : '';
        const sections = detail?.sections && typeof detail.sections === 'object'
            ? detail.sections
            : null;
        const bootstrapEnvelope =
            detail?.bootstrapEnvelope && typeof detail.bootstrapEnvelope === 'object'
                ? detail.bootstrapEnvelope
                : null;
        const health = detail?.health && typeof detail.health === 'object'
            ? detail.health
            : null;
        const sameOriginCommit =
            detail?.sameOriginCommit && typeof detail.sameOriginCommit === 'object'
                ? detail.sameOriginCommit
                : null;
        if ( donorToken === '' || sections === null ) { return; }
        try {
            runtime.sendMessage({
                what: 'completeYouTubeFollowupPrefetchDonor',
                donorToken,
                targetUrl: typeof detail?.targetUrl === 'string' ? detail.targetUrl : '',
                targetVideoId: typeof detail?.targetVideoId === 'string' ? detail.targetVideoId : '',
                sections,
                bootstrapEnvelope,
                health,
                sameOriginCommit,
            }, () => {
                void self.chrome?.runtime?.lastError;
            });
        } catch {}
    }, true);

    document.addEventListener(NAVIGATE_REQUEST_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const requestId = typeof detail?.requestId === 'string' ? detail.requestId : '';
        const targetUrl = typeof detail?.targetUrl === 'string' ? detail.targetUrl : '';
        if ( requestId === '' || targetUrl === '' ) { return; }

        let responded = false;
        const respond = payload => {
            if ( responded ) { return; }
            responded = true;
            try {
                document.dispatchEvent(new CustomEvent(NAVIGATE_RESPONSE_EVENT, {
                    detail: {
                        requestId,
                        ...(payload instanceof Object ? payload : {}),
                    },
                }));
            } catch {}
        };

        try {
            runtime.sendMessage({ what: 'navigateYouTubeFollowupWatch', targetUrl }, response => {
                const lastError = self.chrome?.runtime?.lastError;
                if ( lastError ) {
                    respond({ ok: false, error: `${lastError.message || lastError}` });
                    return;
                }
                respond(response instanceof Object ? response : { ok: false });
            });
        } catch(reason) {
            respond({ ok: false, error: `${reason}` });
        }
    }, true);

    document.addEventListener(ARCHITECTURE_REQUEST_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        const requestId = typeof detail?.requestId === 'string' ? detail.requestId : '';
        const targetUrl = typeof detail?.targetUrl === 'string' ? detail.targetUrl : '';
        const action = typeof detail?.action === 'string' ? detail.action : '';
        const strategy = typeof detail?.strategy === 'string' ? detail.strategy : '';
        if ( requestId === '' || targetUrl === '' || action === '' || strategy === '' ) { return; }

        let responded = false;
        let port = null;
        const respond = payload => {
            if ( responded ) { return; }
            responded = true;
            try {
                document.dispatchEvent(new CustomEvent(ARCHITECTURE_RESPONSE_EVENT, {
                    detail: {
                        requestId,
                        ...(payload instanceof Object ? payload : {}),
                    },
                }));
            } catch {}
            try {
                port?.disconnect?.();
            } catch {}
        };
        try {
            port = runtime.connect({ name: ARCHITECTURE_PORT_NAME });
        } catch(reason) {
            respond({ ok: false, error: `${reason}` });
            return;
        }
        const onDisconnect = () => {
            const lastError = self.chrome?.runtime?.lastError;
            if ( responded ) { return; }
            respond({
                ok: false,
                error: typeof lastError?.message === 'string' && lastError.message !== ''
                    ? lastError.message
                    : 'port-disconnected',
            });
        };
        port.onDisconnect.addListener(onDisconnect);
        port.onMessage.addListener(message => {
            if ( responded || message?.requestId !== requestId ) { return; }
            if ( action === 'start-relay' || action === 'start-donor-owner' ) {
                if ( message?.started === true || typeof message?.relayUrl === 'string' ) {
                    respond(message instanceof Object ? message : { ok: false });
                }
                return;
            }
            if ( message?.done === true || message?.ok === true || typeof message?.error === 'string' ) {
                respond(message instanceof Object ? message : { ok: false });
            }
        });
        try {
            port.postMessage({
                what: 'startYouTubeFollowupArchitectureJob',
                requestId,
                action,
                strategy,
                targetUrl,
            });
        } catch(reason) {
            respond({ ok: false, error: `${reason}` });
        }
    }, true);

    document.addEventListener(NEXT_RELEASE_EVENT, () => {
        try {
            runtime.sendMessage({ what: 'releaseYouTubeFollowupNextBlock' }, () => {
                void self.chrome?.runtime?.lastError;
            });
        } catch {}
    }, true);
    persistBridgeHealth({
        stage: 'listeners-installed',
        listenersInstalledAt: Date.now(),
    });
    } catch ( reason ) {
        markBridgeFatal(reason);
        throw reason;
    }
})();
