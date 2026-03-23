(function talonYouTubeFollowupRelay() {
    const PORT_NAME = 'td-yw-followup-architecture-proof';
    const PAYLOAD_KIND = 'td-yw-track-b-bootstrap-envelope';
    const WINDOW_NAME_TOO_LARGE_BYTES = 256000;
    const runtime = self.browser?.runtime || self.chrome?.runtime;
    const statusNode = document.getElementById('status');
    const startedAt = Date.now();

    const setStatus = message => {
        if ( statusNode ) {
            statusNode.textContent = message;
        }
    };

    const readToken = () => {
        try {
            const params = new URLSearchParams(location.hash.replace(/^#/, ''));
            const token = params.get('token');
            return typeof token === 'string' ? token.trim() : '';
        } catch {
        }
        return '';
    };

    const navigateWithPayload = response => {
        const targetUrl =
            typeof response?.targetUrl === 'string' ? response.targetUrl : '';
        if ( targetUrl === '' ) {
            setStatus('Missing target URL.');
            return;
        }
        const proof = {
            donorStartedAt:
                typeof response?.donorStartedAt === 'number' ? response.donorStartedAt : null,
            donorReadyAt:
                typeof response?.donorReadyAt === 'number' ? response.donorReadyAt : null,
            handoffReadyAt: Date.now(),
            targetNavigationAt: 0,
            envelopeReadyBeforeNavigationRelease: response?.ok === true,
            navigationHoldDurationMs: Math.max(0, Date.now() - startedAt),
            backgroundPrefetchError:
                response?.ok === true
                    ? ''
                    : (typeof response?.error === 'string' ? response.error : 'relay-timeout'),
            fallbackPathUsed: response?.ok !== true,
            timeoutOccurred: response?.timedOut === true || response?.error === 'timeout',
            invalidReason: '',
        };
        const entry = response?.ok === true && response?.entry && typeof response.entry === 'object'
            ? {
                ...response.entry,
                strategy: 'track-b-background-relay',
                handoffSurface: 'windowName',
                proof,
            }
            : null;
        const payload = {
            kind: PAYLOAD_KIND,
            entry,
            proof,
        };
        let serialized = '';
        try {
            serialized = JSON.stringify(payload);
        } catch {
            serialized = '';
        }
        proof.windowNamePayloadBytes = serialized.length;
        proof.windowNamePayloadTooLarge = serialized.length > WINDOW_NAME_TOO_LARGE_BYTES;
        proof.targetNavigationAt = Date.now();
        payload.proof = proof;
        if ( entry ) {
            entry.proof = proof;
        }
        serialized = JSON.stringify(payload);
        try {
            self.name = serialized;
        } catch {
        }
        location.replace(targetUrl);
    };

    const token = readToken();
    if ( token === '' || runtime?.connect === undefined ) {
        setStatus('Unable to start relay.');
        return;
    }

    setStatus('Waiting for clean bootstrap envelope...');
    let port = null;
    try {
        port = runtime.connect({ name: PORT_NAME });
    } catch (reason) {
        setStatus(`Relay connect failed: ${reason}`);
        return;
    }
    port.onMessage.addListener(message => {
        if ( message?.done !== true ) { return; }
        try {
            port.disconnect();
        } catch {}
        navigateWithPayload(message);
    });
    port.onDisconnect.addListener(() => {
        const lastError = self.chrome?.runtime?.lastError;
        if ( lastError ) {
            setStatus(`Relay disconnected: ${lastError.message || lastError}`);
        }
    });
    try {
        port.postMessage({
            what: 'subscribeYouTubeFollowupArchitectureJob',
            token,
        });
    } catch (reason) {
        setStatus(`Relay subscribe failed: ${reason}`);
    }
})();
