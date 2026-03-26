// Bridge compiled remote JSON tactics from extension storage into the page.
(function talonRemoteTacticsBootstrap() {
    const STORAGE_KEY = 'communityBundlePublicTactics';
    const REQUEST_EVENT = 'td-remote-tactics-request';
    const CONFIG_EVENT = 'td-remote-tactics-config';
    const hostname = (self.location?.hostname || '').trim().toLowerCase();
    const exactHost = hostname === '' ? '' : `=${hostname}`;
    const storage = self.browser?.storage?.local || self.chrome?.storage?.local;

    const cloneValue = value => {
        try {
            return structuredClone(value);
        } catch {
        }
        return value;
    };

    const dispatchConfig = (tactics, requestId = 0) => {
        try {
            document.dispatchEvent(new CustomEvent(CONFIG_EVENT, {
                detail: {
                    hostname,
                    requestId,
                    tactics: cloneValue(tactics),
                },
            }));
        } catch {
        }
    };

    const selectHostTactics = input => {
        if ( Array.isArray(input) === false || exactHost === '' ) { return []; }
        return input.filter(entry => (
            entry instanceof Object &&
            Array.isArray(entry.hosts) &&
            entry.hosts.includes(exactHost)
        )).map(entry => cloneValue(entry));
    };

    const readStoredTactics = () => {
        if ( storage?.get === undefined ) {
            return Promise.resolve([]);
        }
        try {
            const maybePromise = storage.get(STORAGE_KEY);
            if ( maybePromise?.then ) {
                return maybePromise.then(bin => selectHostTactics(bin?.[STORAGE_KEY]));
            }
        } catch {
        }
        return new Promise(resolve => {
            try {
                storage.get(STORAGE_KEY, bin => resolve(selectHostTactics(bin?.[STORAGE_KEY])));
            } catch {
                resolve([]);
            }
        });
    };

    const readAndDispatch = async ({ requestId = 0 } = {}) => {
        const tactics = await readStoredTactics().catch(() => []);
        dispatchConfig(tactics, requestId);
        return tactics;
    };

    if ( self.TalonRemoteTacticsBootstrapController ) {
        self.TalonRemoteTacticsBootstrapController.refresh().catch(() => {});
        return;
    }

    document.addEventListener(REQUEST_EVENT, event => {
        const detail = event instanceof CustomEvent ? event.detail : null;
        if ( detail?.hostname && `${detail.hostname}`.trim().toLowerCase() !== hostname ) {
            return;
        }
        void readAndDispatch({
            requestId: Number(detail?.requestId) || 0,
        });
    }, true);

    self.TalonRemoteTacticsBootstrapController = {
        refresh(options = {}) {
            return readAndDispatch({
                requestId: Number(options?.requestId) || 0,
            });
        },
        stop() {
            return Promise.resolve(true);
        },
    };

    self.TalonRemoteTacticsBootstrapController.refresh().catch(() => {});
})();
