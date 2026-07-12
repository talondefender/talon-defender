/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_nativeHeuristics() {

    if ( self.TalonNativeHeuristicsController ) {
        const readiness = self.TalonNativeHeuristicsController.refresh();
        self.TalonNativeHeuristicsReady = readiness;
        readiness.catch(() => {});
        return;
    }

    const CONFIG_PATH = 'automation/native-heuristics.json';
    const REMOTE_CONFIG_KEY = 'communityBundleHeuristics';
    const BOOST_STORAGE_PREFIX = 'nativeHeuristicsBoost';
    const BOOST_TTL_MS = 7 * 24 * 3600 * 1000;
    const BOOST_THRESHOLD = 12;
    const BOOST_MAX = 50;

    const runtime = self.browser?.runtime || self.chrome?.runtime;
    const getURL = runtime?.getURL?.bind(runtime) || (p => p);
    const storage = self.browser?.storage?.local || self.chrome?.storage?.local;
    const guard = self.TalonBreakageGuard;
    const shadowController = self.TalonShadowRootController;
    const blockHints = self.TalonBlockHintsController;
    const cooperativeScheduler = self.TalonCooperativeScheduler;
    const COOPERATIVE_FALLBACK_BUDGET_MS = 4;
    const scheduleCooperativeTask = callback => {
        if ( typeof cooperativeScheduler?.schedule === 'function' ) {
            return cooperativeScheduler.schedule(callback);
        }
        return self.requestAnimationFrame(() => callback(
            self.performance.now() + COOPERATIVE_FALLBACK_BUDGET_MS
        ));
    };
    const cancelCooperativeTask = task => {
        if ( task === undefined ) { return; }
        if ( typeof cooperativeScheduler?.cancel === 'function' ) {
            cooperativeScheduler.cancel(task);
            return;
        }
        self.cancelAnimationFrame(task);
    };
    const cooperativeDeadline = deadline => Number.isFinite(deadline)
        ? deadline
        : self.performance.now() + COOPERATIVE_FALLBACK_BUDGET_MS;
    const shadowRootsChangedEvent =
        shadowController?.ROOTS_CHANGED_EVENT || 'talon-shadow-roots-changed';
    const shadowContentChangedEvent =
        shadowController?.CONTENT_CHANGED_EVENT || 'talon-shadow-content-changed';
    const protectionChangedEvent =
        guard?.PROTECTION_CHANGED_EVENT || 'talon-protection-changed';
    const registrableDomain = hostname => {
        const resolved = guard?.registrableDomain?.(hostname);
        if ( typeof resolved === 'string' && resolved !== '' ) { return resolved; }
        if ( typeof hostname !== 'string' ) { return ''; }
        return hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    };

    const defaultConfig = {
        disableHosts: [],
        labelRegexes: [
            '\\b(sponsored|promoted|advertisement|advertising|ad\\s?supported|paid partnership|partner content|paid post|paid promotion|sponsored content)\\b',
            '\\b(paid\\s*content|partner\\s*story|partner\\s*post|sponsored\\s*links)\\b',
            '(?:реклама|спонсор|спонсируемый|партнерский материал|платное партнерство)',
            '(?:広告|スポンサー|スポンサード|プロモーション|広告記事)',
            '(?:广告|廣告|赞助|贊助|推广|推廣|赞助内容|推广内容)',
            '(?:광고|스폰서|후원|프로모션|유료\\s*광고)',
            '\\b(patrocinado|promocionado|publicidad|anuncio|contenido patrocinado)\\b',
            '\\b(sponsorisé|publicité|annonce|contenu sponsorisé)\\b',
            '\\b(gesponsert|anzeige|werbung|werbeanzeige|bezahlte partnerschaft)\\b',
            '\\b(sponsorizzato|pubblicità|annuncio|contenuto sponsorizzato)\\b',
            '\\b(patrocinado|publicidade|anúncio|conteúdo patrocinado)\\b',
            '\\b(gesponsord|advertentie|betaalde samenwerking)\\b',
            '\\b(sponsorowane|reklama|ogłoszenie|treść sponsorowana)\\b',
            '(спонсор|реклама|промо|партн[её]рск(ий|ое) материал)',
            '(广告|赞助|推广|赞助内容)',
            '(広告|スポンサー|プロモーション|提供)',
            '(광고|스폰서|프로모션)',
            '(إعلان|برعاية|ممول)',
        ],
        labelSelectors: [],
        widgetSelectors: [],
        containerStopSelectors: [
            'article',
            'li',
            'section',
            'aside',
            '.ad-slot',
            '.ad-slot-rail__container',
        ],
        maxLabelTextLength: 40,
        minContainerHeight: 60,
        minContainerWidth: 120,
        minScore: 4,
        minScoreLowConfidence: 5,
    };

    let configPromise;
    const loadConfig = () => {
        if (configPromise !== undefined) { return configPromise; }
        const pending = fetch(getURL(CONFIG_PATH)).then(r => {
            if (r.ok === false) { throw new Error(r.statusText); }
            return r.json();
        });
        configPromise = pending;
        pending.catch(() => {
            if (configPromise === pending) { configPromise = undefined; }
        });
        return configPromise;
    };

    let remoteConfigPromise;
    const loadRemoteConfig = () => {
        if (remoteConfigPromise !== undefined) { return remoteConfigPromise; }
        if (storage?.get === undefined) {
            remoteConfigPromise = Promise.resolve(null);
            return remoteConfigPromise;
        }
        try {
            const maybePromise = storage.get(REMOTE_CONFIG_KEY);
            if (maybePromise?.then) {
                const pending = maybePromise.then(
                    bin => bin?.[REMOTE_CONFIG_KEY] || null
                );
                remoteConfigPromise = pending;
                pending.catch(() => {
                    if (remoteConfigPromise === pending) {
                        remoteConfigPromise = undefined;
                    }
                });
                return remoteConfigPromise;
            }
        } catch (reason) {
            return Promise.reject(reason);
        }
        const pending = new Promise((resolve, reject) => {
            try {
                storage.get(REMOTE_CONFIG_KEY, bin => {
                    const lastError = runtime?.lastError;
                    if (lastError) {
                        reject(new Error(lastError.message || 'storage.get failed'));
                        return;
                    }
                    resolve(bin?.[REMOTE_CONFIG_KEY] || null);
                });
            } catch (reason) {
                reject(reason);
            }
        });
        remoteConfigPromise = pending;
        pending.catch(() => {
            if (remoteConfigPromise === pending) {
                remoteConfigPromise = undefined;
            }
        });
        return remoteConfigPromise;
    };

    const getLocalValue = key => {
        if (storage?.get === undefined) { return Promise.resolve(undefined); }
        try {
            const maybePromise = storage.get(key);
            if (maybePromise?.then) {
                return maybePromise.then(bin => bin?.[key]);
            }
        } catch {
        }
        return new Promise(resolve => {
            try {
                storage.get(key, bin => resolve(bin?.[key]));
            } catch {
                resolve(undefined);
            }
        });
    };

    const setLocalValue = (key, value) => {
        if (storage?.set === undefined) { return Promise.resolve(false); }
        try {
            const maybePromise = storage.set({ [key]: value });
            if (maybePromise?.then) {
                return maybePromise.then(() => true).catch(() => false);
            }
        } catch {
        }
        return new Promise(resolve => {
            try {
                storage.set({ [key]: value }, () => resolve(true));
            } catch {
                resolve(false);
            }
        });
    };

    const hostname = (self.location?.hostname || '').toLowerCase();
    if (hostname === '') {
        self.TalonNativeHeuristicsReady = Promise.resolve({ applied: false });
        return;
    }
    const pageDomain = registrableDomain(hostname);
    let hostProtection = guard?.getProtection?.() || {
        category: '',
        allowedRiskTier: 3,
        matchedBy: '',
    };
    const boostDomain = pageDomain || hostname;
    const BOOST_STORAGE_KEY = boostDomain
        ? `${BOOST_STORAGE_PREFIX}.${boostDomain}`
        : null;

    // Dynamic boosts: after repeated heuristic hides, promote stronger cosmetics.
    let strongHideCount = 0;
    let aggressionBoost = 0; // session-only, max 1
    let persistedBoostState = null;
    let strongHidesSincePersist = 0;
    let persistTimer;

    const schedulePersistStrongHide = () => {
        if (BOOST_STORAGE_KEY === null) { return; }
        if (storage?.set === undefined) { return; }
        strongHidesSincePersist += 1;
        if (persistTimer !== undefined) { return; }
        persistTimer = self.setTimeout(async () => {
            persistTimer = undefined;
            if (strongHidesSincePersist === 0) { return; }
            const now = Date.now();
            let state = persistedBoostState;
            if (state === null) {
                const stored = await getLocalValue(BOOST_STORAGE_KEY);
                state = stored instanceof Object ? stored : { count: 0, lastTs: 0 };
            }
            let count = Number(state.count) || 0;
            let lastTs = Number(state.lastTs) || 0;
            if (lastTs === 0 || (now - lastTs) > BOOST_TTL_MS) {
                count = 0;
            }
            count = Math.min(BOOST_MAX, count + strongHidesSincePersist);
            strongHidesSincePersist = 0;
            persistedBoostState = { count, lastTs: now };
            await setLocalValue(BOOST_STORAGE_KEY, persistedBoostState);
        }, 2500);
    };

    const recordHeuristicHide = (isStrong = false) => {
        if (isStrong) {
            strongHideCount += 1;
            if (guard?.isProtectedSurface?.() !== true &&
                aggressionBoost === 0 &&
                strongHideCount >= 4) {
                aggressionBoost = 1;
            }
            schedulePersistStrongHide();
        }
    };

    const normalizeHostnameCandidate = value => {
        if ( typeof value !== 'string' ) { return ''; }
        return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    };

    const normalizeScopedHostPattern = value => {
        if ( typeof value !== 'string' ) { return ''; }
        const trimmed = value.trim().toLowerCase();
        if ( trimmed === '' ) { return ''; }
        if ( trimmed.includes('://') || trimmed.includes('/') ) { return ''; }
        if ( trimmed === '*' || trimmed === 'all-urls' ) { return trimmed; }

        const normalizeBareHostname = candidate => {
            const normalized = normalizeHostnameCandidate(candidate);
            if ( normalized === '' ) { return ''; }
            if ( normalized.includes('*') || normalized === 'all-urls' ) { return ''; }
            return normalized;
        };

        if ( trimmed.startsWith('=') ) {
            const bare = normalizeBareHostname(trimmed.slice(1));
            return bare === '' ? '' : `=${bare}`;
        }
        if ( trimmed.startsWith('*.') ) {
            const bare = normalizeBareHostname(trimmed.slice(2));
            return bare === '' ? '' : `*.${bare}`;
        }
        if ( trimmed.endsWith('.*') ) {
            const bare = normalizeBareHostname(trimmed.slice(0, -2));
            return bare === '' ? '' : `${bare}.*`;
        }
        return normalizeBareHostname(trimmed);
    };

    const patternMatchesHostname = (pattern, hn) => {
        const delegated = guard?.hostPatternMatches;
        if ( typeof delegated === 'function' ) {
            return delegated(pattern, hn) === true;
        }
        const p = normalizeScopedHostPattern(pattern);
        const normalizedHostname = normalizeHostnameCandidate(hn);
        if ( p === '' || normalizedHostname === '' ) { return false; }
        if (p === '*' || p === 'all-urls') { return true; }
        if (p.startsWith('=')) {
            return normalizedHostname === p.slice(1);
        }
        if (p.startsWith('*.')) {
            const bare = p.slice(2);
            return normalizedHostname === bare || normalizedHostname.endsWith(`.${bare}`);
        }
        if (p.endsWith('.*')) {
            const bare = p.slice(0, -2);
            return normalizedHostname === bare || normalizedHostname.startsWith(`${bare}.`);
        }
        return normalizedHostname === p || normalizedHostname.endsWith(`.${p}`);
    };

    const isVisible = el => {
        if (el instanceof Element === false) { return false; }
        const style = self.getComputedStyle(el);
        if (style.display === 'none') { return false; }
        if (style.visibility === 'hidden') { return false; }
        if (Number(style.opacity) === 0) { return false; }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const ownedStyles = new Map();

    const setOwnedStyle = (element, property, value, priority = 'important') => {
        if ( element instanceof Element === false ) { return false; }
        let properties = ownedStyles.get(element);
        if ( properties instanceof Map === false ) {
            properties = new Map();
            ownedStyles.set(element, properties);
        }
        let record = properties.get(property);
        if ( record === undefined ) {
            record = {
                originalValue: element.style.getPropertyValue?.(property) || '',
                originalPriority: element.style.getPropertyPriority?.(property) || '',
                appliedValue: '',
                appliedPriority: '',
            };
            properties.set(property, record);
        }
        element.style.setProperty(property, value, priority);
        record.appliedValue = element.style.getPropertyValue?.(property) || String(value);
        record.appliedPriority = element.style.getPropertyPriority?.(property) || priority;
        return true;
    };

    const restoreOwnedStylesFor = element => {
        const properties = ownedStyles.get(element);
        if ( properties instanceof Map === false ) { return false; }
        for ( const [ property, record ] of properties ) {
            const currentValue = element.style.getPropertyValue?.(property) || '';
            const currentPriority = element.style.getPropertyPriority?.(property) || '';
            if ( currentValue !== record.appliedValue ) { continue; }
            if ( currentPriority !== record.appliedPriority ) { continue; }
            if ( record.originalValue === '' ) {
                if ( typeof element.style.removeProperty === 'function' ) {
                    element.style.removeProperty(property);
                } else {
                    element.style.setProperty(property, '');
                }
            } else {
                element.style.setProperty(
                    property,
                    record.originalValue,
                    record.originalPriority
                );
            }
        }
        ownedStyles.delete(element);
        return true;
    };

    const pruneDisconnectedOwnedStyles = () => {
        for ( const element of Array.from(ownedStyles.keys()) ) {
            if ( element.isConnected !== false ) { continue; }
            restoreOwnedStylesFor(element);
        }
    };

    const restoreOwnedStyles = () => {
        for ( const element of Array.from(ownedStyles.keys()) ) {
            restoreOwnedStylesFor(element);
        }
    };

    const TEXT_LABEL_SELECTOR = 'span,small,a,div,p,strong,em,label';

    const readBoundedText = (element, maxLength = 80) => {
        const childNodes = element?.childNodes;
        if ( childNodes === undefined ) {
            const fallback = element?.textContent || '';
            return fallback.length <= maxLength ? fallback.trim() : '';
        }
        if ( childNodes.length > 24 ) { return ''; }
        const queue = [];
        for ( let i = 0; i < childNodes.length && i < 24; i++ ) {
            queue.push({ node: childNodes[i], depth: 0 });
        }
        let text = '';
        let visited = 0;
        while ( queue.length !== 0 && visited++ < 24 ) {
            const { node, depth } = queue.shift();
            if ( node?.nodeType === 3 ) {
                text += node.nodeValue || '';
                if ( text.length > maxLength ) { return ''; }
                continue;
            }
            if ( depth >= 1 || node?.childNodes === undefined ) { continue; }
            if ( node.childNodes.length > 24 ) { return ''; }
            for (
                let i = 0;
                i < node.childNodes.length && queue.length < 24;
                i++
            ) {
                queue.push({ node: node.childNodes[i], depth: depth + 1 });
            }
        }
        return text.trim();
    };

    const compileSafeLabelRegex = source => {
        if ( typeof source !== 'string' || source.length === 0 || source.length > 256 ) {
            return null;
        }
        if ( /\\[1-9]/.test(source) || /\(\?<([=!])/.test(source) ) { return null; }
        if ( /\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d)/.test(source) ) { return null; }
        if ( /\([^)]*\|[^)]*\)\s*(?:[+*]|\{\d)/.test(source) ) { return null; }
        try { return new RegExp(source, 'i'); } catch { return null; }
    };

    const normalizeSafeSelectors = selectors => {
        if ( Array.isArray(selectors) === false ) { return []; }
        const out = [];
        const seen = new Set();
        let probe;
        try { probe = document.createElement('div'); } catch {
        }
        for ( const value of selectors ) {
            if ( typeof value !== 'string' ) { continue; }
            const selector = value.trim();
            if (
                selector === '' ||
                selector.length > 256 ||
                /[\u0000-\u001F\u007F{};]/.test(selector) ||
                seen.has(selector)
            ) {
                continue;
            }
            try {
                probe?.matches?.(selector);
            } catch {
                continue;
            }
            seen.add(selector);
            out.push(selector);
        }
        return out;
    };

    let pendingLabels = [];
    let pendingIndex = 0;
    let seenLabels = new WeakSet();
    let hiddenContainers = new WeakSet();
    let iframeCandidates = new WeakSet();
    const MAX_PENDING_LABELS = 512;
    const PENDING_LABEL_RECOVERY_DELAY_MS = 100;
    let pendingLabelOverflowed = false;
    let pendingLabelRecoveryTimer;

    const compactPendingLabels = () => {
        if ( pendingIndex === 0 ) { return; }
        if ( pendingIndex < 256 && pendingIndex * 2 < pendingLabels.length ) {
            return;
        }
        pendingLabels.splice(0, pendingIndex);
        pendingIndex = 0;
    };

    let labelRegexes = [];
    let labelSelectors = [];
    let widgetSelectors = [];
    let stopSelectorText = '';
    let attrHintRe = /\b(sponsor|sponsored|promoted|advert|advertisement|adchoices|outbrain|taboola|ad-slot|adslot|adsbygoogle|adunit|adserver|doubleclick|googlesyndication|prebid|criteo|native-ad|banner-ad|paid\s*post|paid\s*partner|partner\s*content|promo|dfp|gpt|admanager|adsense|revcontent|mgid|teads|adthrive|mediavine|adzerk|rubicon|openx|pubmatic|appnexus|adnxs|spotx|yieldlove|ezoic)\b/i;
    const STRONG_LABEL_RE = /\b(sponsored|advertisement|advertorial|ad\s?supported|paid partnership|partner content|paid promotion|paid post|paid content|promoted)\b/i;

    const COMMON_AD_SIZES = [
        [300, 250],
        [300, 600],
        [160, 600],
        [120, 600],
        [728, 90],
        [970, 250],
        [970, 90],
        [320, 50],
        [320, 100],
        [336, 280],
        [468, 60],
        [234, 60],
        [250, 250],
        [200, 200],
        [300, 50],
        [300, 100],
        [320, 480],
        [480, 320],
    ];
    const AD_SIZE_TOLERANCE_PX = 10;

    const isStandardAdSize = rect => {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        for (const [aw, ah] of COMMON_AD_SIZES) {
            if (
                Math.abs(w - aw) <= AD_SIZE_TOLERANCE_PX &&
                Math.abs(h - ah) <= AD_SIZE_TOLERANCE_PX
            ) {
                return true;
            }
        }
        return false;
    };

    const isThirdPartyFrame = frame => {
        const src = frame.getAttribute('src');
        if (typeof src !== 'string' || src === '') { return false; }
        let u;
        try {
            u = new URL(src, self.location.href);
        } catch {
            return false;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }
        const domain = registrableDomain(u.hostname.toLowerCase());
        return domain !== '' && domain !== pageDomain;
    };

    const SENSITIVE_FRAME_HINT_RE = /\b(?:auth|account|login|sign[-_ ]?in|oauth|sso|captcha|payment|checkout|billing|wallet|stripe|paypal|klarna|braintree|support|chat|video|player|stream|game|map|calendar|document|editor|survey)\b/i;

    const hasSensitiveFramePurpose = (frame, hintParts) => {
        if ( SENSITIVE_FRAME_HINT_RE.test(hintParts) ) { return true; }
        const sandbox = frame.getAttribute('sandbox') || '';
        const allow = frame.getAttribute('allow') || '';
        if ( /payment|publickey-credentials|get-user-media|camera|microphone/i.test(`${sandbox} ${allow}`) ) {
            return true;
        }
        return false;
    };

    const isAdIframeCandidate = frame => {
        if (frame instanceof HTMLIFrameElement === false) { return false; }
        if (isVisible(frame) === false) { return false; }
        const rect = frame.getBoundingClientRect();
        const standardSized = isStandardAdSize(rect);
        if (standardSized === false) {
            if (rect.width < 200 || rect.height < 100) { return false; }
        }

        const hintParts = [
            frame.id,
            frame.className,
            frame.getAttribute('title') || '',
            frame.getAttribute('aria-label') || '',
            frame.getAttribute('data-ad') || '',
            frame.getAttribute('data-ad-unit') || '',
            frame.getAttribute('data-ad-slot') || '',
            frame.getAttribute('src') || '',
            frame.name || '',
        ].join(' ');

        if (hasSensitiveFramePurpose(frame, hintParts)) { return false; }

        const thirdParty = isThirdPartyFrame(frame);
        const namedAdHint = attrHintRe.test(hintParts);
        const explicitAdHint = [
            'data-ad',
            'data-ad-unit',
            'data-ad-slot',
            'data-ad-client',
            'data-advertisement',
            'data-sponsored',
        ].some(name => frame.hasAttribute?.(name) === true);
        const recentBlockHint = blockHints?.hasRecentHint?.(frame, {
            includeSubtree: true,
        }) === true;

        // Dimensions and third-party origin are common for legitimate widgets.
        // Require an independent ad-specific signal before treating a frame as an ad.
        if ( recentBlockHint ) {
            return namedAdHint || explicitAdHint || standardSized;
        }
        if ( explicitAdHint ) {
            return namedAdHint || thirdParty || standardSized;
        }
        return namedAdHint && thirdParty && standardSized;
    };

    let minContainerHeight = defaultConfig.minContainerHeight;
    let minContainerWidth = defaultConfig.minContainerWidth;
    let minScore = defaultConfig.minScore;
    let minScoreLowConfidence = defaultConfig.minScoreLowConfidence;

    const enqueueLabel = el => {
        if (el instanceof Element === false) { return; }
        if (seenLabels.has(el)) { return; }
        compactPendingLabels();
        if ( (pendingLabels.length - pendingIndex) >= MAX_PENDING_LABELS ) {
            pendingLabelOverflowed = true;
            return;
        }
        seenLabels.add(el);
        pendingLabels.push(el);
    };

    // Candidate discovery is resumable so large DOM insertions always yield.
    let configuredCandidateSelector = '';
    let candidateScanJobs = [];
    let candidateScanIndex = 0;
    let candidateScanTimer;
    let queuedScanRoots = new WeakSet();
    const MAX_CANDIDATE_SCAN_NODES_PER_SLICE = 128;
    const MAX_CANDIDATE_SCAN_JOBS = 256;
    let candidateScanOverflowed = false;

    const schedulePendingLabelRecovery = () => {
        if ( pendingLabelOverflowed === false ) { return; }
        if ( pendingLabelRecoveryTimer !== undefined ) { return; }
        pendingLabelRecoveryTimer = self.setTimeout(() => {
            pendingLabelRecoveryTimer = undefined;
            if ( (pendingLabels.length - pendingIndex) !== 0 ) {
                schedulePendingLabelRecovery();
                return;
            }
            pendingLabelOverflowed = false;
            if (
                candidateScanTimer !== undefined ||
                candidateScanIndex < candidateScanJobs.length
            ) {
                candidateScanOverflowed = true;
                return;
            }
            collectCandidates(document);
        }, PENDING_LABEL_RECOVERY_DELAY_MS);
    };

    const compactCandidateScanJobs = () => {
        if ( candidateScanIndex === 0 ) { return; }
        if (
            candidateScanIndex < 64 &&
            candidateScanIndex * 2 < candidateScanJobs.length
        ) {
            return;
        }
        candidateScanJobs.splice(0, candidateScanIndex);
        candidateScanIndex = 0;
    };

    const scanRootIsDisconnected = root => {
        if ( root instanceof Element ) { return root.isConnected === false; }
        const host = root?.host;
        return host instanceof Element && host.isConnected === false;
    };

    const collectCandidateNode = node => {
        if ( node instanceof Element === false ) { return; }
        if ( configuredCandidateSelector !== '' ) {
            try {
                if ( node.matches(configuredCandidateSelector) && isVisible(node) ) {
                    enqueueLabel(node);
                }
            } catch {
            }
        }
        if ( node instanceof HTMLIFrameElement && isAdIframeCandidate(node) ) {
            iframeCandidates.add(node);
            enqueueLabel(node);
            return;
        }
        try {
            if ( node.matches(TEXT_LABEL_SELECTOR) === false ) { return; }
        } catch {
            return;
        }
        if ( isVisible(node) === false ) { return; }
        const text = readBoundedText(node, config.maxLabelTextLength || 40);
        if ( text === '' ) { return; }
        if ( labelRegexes.some(re => re.test(text)) === false ) { return; }
        enqueueLabel(node);
    };

    const createCandidateScanJob = root => {
        const scanRoot = root === document
            ? (document.body || document.documentElement)
            : root;
        if (
            scanRoot instanceof Element === false &&
            scanRoot instanceof DocumentFragment === false
        ) {
            return null;
        }
        let walker;
        try {
            walker = document.createTreeWalker(
                scanRoot,
                self.NodeFilter?.SHOW_ELEMENT || 1
            );
        } catch {
            return null;
        }
        return {
            root: scanRoot,
            walker,
            includeRoot: scanRoot instanceof Element,
            directOnly: false,
        };
    };

    const createDirectCandidateScanJob = node => {
        if ( node instanceof Element === false ) { return null; }
        return {
            root: node,
            walker: null,
            includeRoot: true,
            directOnly: true,
        };
    };

    const processCandidateScans = sharedDeadline => {
        candidateScanTimer = undefined;
        const deadline = cooperativeDeadline(sharedDeadline);
        let scanned = 0;
        const pendingBefore = pendingLabels.length;
        while (
            candidateScanIndex < candidateScanJobs.length &&
            scanned < MAX_CANDIDATE_SCAN_NODES_PER_SLICE &&
            self.performance.now() < deadline
        ) {
            const job = candidateScanJobs[candidateScanIndex];
            if ( scanRootIsDisconnected(job.root) ) {
                queuedScanRoots.delete(job.root);
                candidateScanIndex += 1;
                continue;
            }
            let node;
            if ( job.includeRoot ) {
                job.includeRoot = false;
                node = job.root;
                if ( job.directOnly ) {
                    queuedScanRoots.delete(job.root);
                    candidateScanIndex += 1;
                }
            } else if ( job.directOnly ) {
                queuedScanRoots.delete(job.root);
                candidateScanIndex += 1;
                continue;
            } else if ( job.walker.nextNode() ) {
                node = job.walker.currentNode;
            } else {
                queuedScanRoots.delete(job.root);
                candidateScanIndex += 1;
                continue;
            }
            scanned += 1;
            collectCandidateNode(node);
        }
        if ( pendingLabels.length !== pendingBefore ) { scheduleProcess(); }
        if ( candidateScanIndex >= candidateScanJobs.length ) {
            const needsFullScan = candidateScanOverflowed;
            candidateScanJobs = [];
            candidateScanIndex = 0;
            queuedScanRoots = new WeakSet();
            candidateScanOverflowed = false;
            if ( needsFullScan ) { collectCandidates(document); }
            return;
        }
        compactCandidateScanJobs();
        candidateScanTimer = scheduleCooperativeTask(processCandidateScans);
    };

    const collectCandidates = (root, priority = false) => {
        const job = createCandidateScanJob(root);
        if ( job === null || queuedScanRoots.has(job.root) ) { return true; }
        compactCandidateScanJobs();
        if (
            (candidateScanJobs.length - candidateScanIndex) >=
            MAX_CANDIDATE_SCAN_JOBS
        ) {
            candidateScanOverflowed = true;
            return false;
        }
        queuedScanRoots.add(job.root);
        if ( priority ) {
            candidateScanJobs.splice(candidateScanIndex, 0, job);
        } else {
            candidateScanJobs.push(job);
        }
        if ( candidateScanTimer !== undefined ) { return true; }
        candidateScanTimer = scheduleCooperativeTask(processCandidateScans);
        return true;
    };

    const collectDirectCandidate = (node, priority = false) => {
        const job = createDirectCandidateScanJob(node);
        if ( job === null || queuedScanRoots.has(job.root) ) { return true; }
        compactCandidateScanJobs();
        if (
            (candidateScanJobs.length - candidateScanIndex) >=
            MAX_CANDIDATE_SCAN_JOBS
        ) {
            return false;
        }
        queuedScanRoots.add(job.root);
        if ( priority ) {
            candidateScanJobs.splice(candidateScanIndex, 0, job);
        } else {
            candidateScanJobs.push(job);
        }
        if ( candidateScanTimer === undefined ) {
            candidateScanTimer = scheduleCooperativeTask(processCandidateScans);
        }
        return true;
    };

    const hasOutboundLink = container => {
        let walker;
        try {
            walker = document.createTreeWalker(
                container,
                self.NodeFilter?.SHOW_ELEMENT || 1
            );
        } catch {
            return false;
        }
        let scanned = 0;
        while ( walker.nextNode() && scanned++ < 128 ) {
            const a = walker.currentNode;
            if ( a?.tagName !== 'A' || a.hasAttribute?.('href') !== true ) { continue; }
            const href = a.getAttribute('href');
            if (typeof href !== 'string') { continue; }
            let u;
            try {
                u = new URL(href, self.location.href);
            } catch {
                continue;
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') { continue; }
            const domain = registrableDomain(u.hostname.toLowerCase());
            if (domain !== '' && domain !== pageDomain) {
                return true;
            }
        }
        return false;
    };

    const hasAdChoicesHint = container => {
        return container.querySelector(
            'a[href*="adchoices" i], [alt*="adchoices" i], [aria-label*="adchoices" i]'
        ) !== null;
    };

    const hasAttrHint = (container, labelEl) => {
        const parts = [
            container.id,
            container.className,
            container.getAttribute('aria-label') || '',
            container.getAttribute('role') || '',
            container.getAttribute('data-ad') || '',
            container.getAttribute('data-ad-unit') || '',
            container.getAttribute('data-ad-slot') || '',
            container.getAttribute('data-ad-client') || '',
            container.getAttribute('data-advertisement') || '',
            container.getAttribute('data-sponsored') || '',
            labelEl.id,
            labelEl.className,
            labelEl.getAttribute('aria-label') || '',
        ].join(' ');
        return attrHintRe.test(parts);
    };

    const isWidgetCandidate = el => {
        if (iframeCandidates.has(el)) { return true; }
        for (const sel of widgetSelectors) {
            try {
                if (el.matches(sel)) { return true; }
                if (el.closest(sel)) { return true; }
            } catch {
                continue;
            }
        }
        return false;
    };

    const isSelectorCandidate = el => {
        for (const sel of labelSelectors) {
            try {
                if (el.matches(sel)) { return true; }
                if (el.closest(sel)) { return true; }
            } catch {
                continue;
            }
        }
        return false;
    };

    const isTextLabelCandidate = el => {
        const text = readBoundedText(el, config.maxLabelTextLength || 40);
        if (text === '') { return false; }
        return labelRegexes.some(re => re.test(text));
    };

    const canUseSelfAsContainer = el => {
        if (el instanceof Element === false) { return false; }
        if (el === document.body || el === document.documentElement) { return false; }
        if (el.closest('nav,header,footer')) { return false; }

        const rect = el.getBoundingClientRect();
        if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
            return false;
        }

        if (iframeCandidates.has(el)) { return true; }
        if (isWidgetCandidate(el) || isSelectorCandidate(el)) { return true; }

        const parts = [
            el.id,
            el.className,
            el.getAttribute('aria-label') || '',
            el.getAttribute('role') || '',
            el.getAttribute('data-ad') || '',
            el.getAttribute('data-ad-unit') || '',
            el.getAttribute('data-ad-slot') || '',
            el.getAttribute('data-ad-client') || '',
            el.getAttribute('data-advertisement') || '',
            el.getAttribute('data-sponsored') || '',
        ].join(' ');
        if (attrHintRe.test(parts)) { return true; }

        // Large label-bearing containers should hide themselves rather than
        // their parent wrapper, otherwise a single ad rail can blank content.
        if (isTextLabelCandidate(el) && el.childElementCount !== 0) { return true; }

        return false;
    };

    const findContainer = el => {
        if (canUseSelfAsContainer(el)) { return el; }

        let container;
        try {
            container = stopSelectorText ? el.closest(stopSelectorText) : null;
        } catch {
            container = null;
        }
        if (container === null) {
            container = el.parentElement;
        }
        if (container === null) { return null; }
        if (container === document.body || container === document.documentElement) { return null; }
        if (container.closest('nav,header,footer')) { return null; }
        if (guard?.canMutateElement?.(container, {
            riskTier: guard?.RISK_TIERS?.high || 3,
            source: 'native-heuristics-find-container',
        })?.allowed === false) {
            return null;
        }
        return container;
    };

    const shouldHideContainer = (container, labelEl) => {
        const rect = container.getBoundingClientRect();
        if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
            return false;
        }
        if (guard?.isLikelyPrimaryContent?.(container)) {
            return { shouldHide: false, isStrong: false, score: 0, needed: 0 };
        }

        const widgetHint = isWidgetCandidate(labelEl);
        const selectorHint = isSelectorCandidate(labelEl);
        const labelHint = isTextLabelCandidate(labelEl);
        if (widgetHint === false && selectorHint === false && labelHint === false) {
            return { shouldHide: false, isStrong: false, score: 0, needed: 0 };
        }

        const attrHint = hasAttrHint(container, labelEl);
        const adChoicesHint = hasAdChoicesHint(container);
        const outboundHint = hasOutboundLink(container);
        const sizeHint = isStandardAdSize(rect);
        const recentBlockHint = blockHints?.hasRecentHint?.(container, {
            includeSubtree: true,
        }) === true || blockHints?.hasRecentHint?.(labelEl) === true;
        const recentNetworkHit = blockHints?.hasRecentNetworkHit?.() === true;

        let score = 0;
        if (widgetHint) { score += 4; }
        if (selectorHint) { score += 3; }
        let strongLabel = false;
        if (labelHint) {
            score += 3;
            const text = readBoundedText(labelEl, config.maxLabelTextLength || 40);
            if (text !== '' && STRONG_LABEL_RE.test(text)) {
                strongLabel = true;
                score += 1;
            }
        }
        if (attrHint) { score += 1; }
        if (adChoicesHint) { score += 1; }
        if (outboundHint) { score += 1; }
        if (sizeHint) { score += 1; }
        if (recentBlockHint) { score += 1; }
        if (recentNetworkHit) { score += 1; }

        let overlayHint = 0;
        try {
            const style = self.getComputedStyle(container);
            const pos = style.position;
            if (pos === 'fixed' || pos === 'sticky') {
                overlayHint = 1;
                const z = parseInt(style.zIndex, 10);
                if (Number.isFinite(z) && z >= 1000) {
                    overlayHint = 2;
                }
            }
        } catch {
        }
        if (overlayHint) { score += overlayHint; }

        const lowConfidenceOnly = labelHint &&
            widgetHint === false &&
            selectorHint === false &&
            strongLabel === false;
        const needed = lowConfidenceOnly
            ? minScoreLowConfidence
            : Math.max(1, minScore - aggressionBoost);
        let shouldHide = score >= needed;
        if (hostProtection.allowedRiskTier < (guard?.RISK_TIERS?.high || 3)) {
            if (lowConfidenceOnly) {
                shouldHide = false;
            }
            if (rect.height >= self.innerHeight * 0.45 || rect.width >= self.innerWidth * 0.7) {
                shouldHide = false;
            }
            if (widgetHint === false && selectorHint === false && attrHint === false && sizeHint === false) {
                shouldHide = false;
            }
        }
        const isStrong = Boolean(
            widgetHint ||
            selectorHint ||
            strongLabel ||
            adChoicesHint ||
            attrHint ||
            recentBlockHint || recentNetworkHit
        );
        return { shouldHide, isStrong, score, needed, overlayHint };
    };

    const unlockScrollIfNeeded = () => {
        let htmlOverflowHidden = false;
        let bodyOverflowHidden = false;
        let bodyFixed = false;

        const html = document.documentElement;
        const body = document.body;

        try {
            if (html && self.getComputedStyle(html).overflow === 'hidden') {
                htmlOverflowHidden = true;
            }
        } catch {
        }

        try {
            if (body) {
                const style = self.getComputedStyle(body);
                bodyOverflowHidden = style.overflow === 'hidden';
                bodyFixed = style.position === 'fixed';
            }
        } catch {
        }

        if (htmlOverflowHidden === false && bodyOverflowHidden === false && bodyFixed === false) {
            return false;
        }

        try {
            if (htmlOverflowHidden) {
                setOwnedStyle(html, 'overflow', 'auto');
            }
        } catch {
        }

        let restoreY;
        if (bodyFixed && body) {
            try {
                const topValue = self.getComputedStyle(body).top;
                const topPx = parseInt(topValue, 10);
                if (Number.isFinite(topPx)) {
                    restoreY = Math.abs(topPx);
                }
            } catch {
            }
        }

        try {
            if (body && bodyOverflowHidden) {
                setOwnedStyle(body, 'overflow', 'auto');
            }
            if (body && bodyFixed) {
                setOwnedStyle(body, 'position', 'static');
                setOwnedStyle(body, 'top', 'auto');
            }
        } catch {
        }

        if (restoreY !== undefined) {
            try { self.scrollTo(0, restoreY); } catch { }
        }

        return true;
    };

    const hideContainer = (container, isStrong = false, overlayHint) => {
        const decision = guard?.canMutateElement?.(container, {
            riskTier: guard?.RISK_TIERS?.high || 3,
            source: 'native-heuristics-hide',
        });
        if (decision?.allowed === false) {
            return;
        }
        try {
            if (ownedStyles.has(container)) {
                if (isVisible(container)) {
                    setOwnedStyle(container, 'display', 'none');
                    setOwnedStyle(container, 'visibility', 'hidden');
                }
                return;
            }
            setOwnedStyle(container, 'display', 'none');
            setOwnedStyle(container, 'visibility', 'hidden');
            blockHints?.noteElement?.(container, { ancestors: 1 });
            recordHeuristicHide(isStrong);

            let hint = Number.isFinite(overlayHint) ? overlayHint : 0;
            if (hint === 0) {
                try {
                    const style = self.getComputedStyle(container);
                    const pos = style.position;
                    if (pos === 'fixed' || pos === 'sticky') {
                        hint = 1;
                        const z = parseInt(style.zIndex, 10);
                        if (Number.isFinite(z) && z >= 1000) {
                            hint = 2;
                        }
                    }
                } catch {
                }
            }
            if (hint) {
                unlockScrollIfNeeded();
            }
            guard?.auditAfterMutation?.('native-heuristics-hide');
        } catch {
        }
    };

    const hideWrapperIfPresent = container => {
        if (container instanceof Element === false) { return; }
        let wrapper;
        try {
            wrapper = container.closest('.ad-slot-rail__container');
        } catch {
            wrapper = null;
        }
        if (wrapper === null || wrapper === container) { return; }
        hideContainer(wrapper, true);
        ensureStaysHidden(wrapper);
    };

    let rehideObserved = new WeakSet();
    const rehideObservers = new Map();
    const pruneDisconnectedRehideObservers = () => {
        for ( const [ container, obs ] of rehideObservers ) {
            if ( container.isConnected !== false ) { continue; }
            try { obs.disconnect(); } catch {
            }
            rehideObservers.delete(container);
            rehideObserved.delete(container);
            hiddenContainers.delete(container);
        }
        pruneDisconnectedOwnedStyles();
    };
    const ensureStaysHidden = container => {
        if (container instanceof Element === false) { return; }
        if (rehideObserved.has(container)) { return; }
        rehideObserved.add(container);
        try {
            const obs = new MutationObserver(() => {
                if (container.isConnected === false) {
                    obs.disconnect();
                    rehideObservers.delete(container);
                    rehideObserved.delete(container);
                    hiddenContainers.delete(container);
                    restoreOwnedStylesFor(container);
                    return;
                }
                if (isVisible(container)) {
                    hideContainer(container);
                    collapseEmptyParent(container);
                }
            });
            obs.observe(container, {
                attributes: true,
                attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
            });
            rehideObservers.set(container, obs);
        } catch {
        }
    };

    const collapseEmptyParent = container => {
        const parent = container.parentElement;
        if (parent === null) { return; }
        if (parent === document.body || parent === document.documentElement) { return; }
        if (ownedStyles.has(parent)) { return; }
        if (parent.closest('nav,header,footer')) { return; }
        if (guard?.canMutateElement?.(parent, {
            riskTier: guard?.RISK_TIERS?.medium || 2,
            source: 'native-heuristics-collapse-parent',
        })?.allowed === false) {
            return;
        }
        if (guard?.isLikelyPrimaryContent?.(parent)) { return; }

        const kids = parent.children;
        if (kids.length > 12) { return; }
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (child === container) { continue; }
            if (isVisible(child)) { return; }
        }

        const rect = parent.getBoundingClientRect();
        const adSized = isStandardAdSize(rect);
        if (adSized === false) {
            if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
                return;
            }
        }

        const hintParts = [
            parent.id,
            parent.className,
            parent.getAttribute('aria-label') || '',
            parent.getAttribute('data-ad') || '',
            parent.getAttribute('data-ad-unit') || '',
        ].join(' ');
        const directAdHint = attrHintRe.test(hintParts);
        const recentBlockHint = blockHints?.hasRecentHint?.(parent, {
            includeSubtree: true,
        }) === true;
        const hiddenChildEvidence = ownedStyles.has(container);
        if ( directAdHint === false && recentBlockHint === false && hiddenChildEvidence === false ) {
            return;
        }

        try {
            setOwnedStyle(parent, 'display', 'none');
            setOwnedStyle(parent, 'visibility', 'hidden');
            blockHints?.noteElement?.(parent, { ancestors: 1 });
            ensureStaysHidden(parent);
            unlockScrollIfNeeded();
            guard?.auditAfterMutation?.('native-heuristics-collapse');
        } catch {
        }
    };

    let processTimer;

    const processPending = sharedDeadline => {
        processTimer = undefined;
        const deadline = cooperativeDeadline(sharedDeadline);
        for (; pendingIndex < pendingLabels.length; pendingIndex++) {
            if (self.performance.now() >= deadline) { break; }
            const labelEl = pendingLabels[pendingIndex];
            if (isVisible(labelEl) === false) { continue; }
            const container = findContainer(labelEl);
            if (container === null) { continue; }
            if (hiddenContainers.has(container)) { continue; }
            const decision = shouldHideContainer(container, labelEl);
            if (decision?.shouldHide !== true) { continue; }
            hideContainer(container, decision.isStrong, decision.overlayHint);
            collapseEmptyParent(container);
            hideWrapperIfPresent(container);
            ensureStaysHidden(container);
            hiddenContainers.add(container);
        }

        if (pendingIndex >= pendingLabels.length) {
            pendingLabels.length = 0;
            pendingIndex = 0;
            schedulePendingLabelRecovery();
            return;
        }
        compactPendingLabels();
        scheduleProcess();
    };

    const scheduleProcess = () => {
        if (processTimer !== undefined) { return; }
        processTimer = scheduleCooperativeTask(processPending);
    };

    const collectKnownShadowRootCandidates = (roots, priority = false) => {
        const knownRoots = Array.isArray(roots)
            ? roots
            : (shadowController?.enumerateRoots?.() || []);
        for ( const root of knownRoots ) {
            if ( collectCandidates(root, priority) === false ) { break; }
        }
    };

    const MAX_DIRECT_MUTATION_CANDIDATES = 128;
    const observer = new MutationObserver(mutations => {
        let sawRemoval = false;
        let overloaded = false;
        const directCandidates = new Set();
        const addDirectCandidate = node => {
            if ( node instanceof Element === false ) { return; }
            if ( directCandidates.size >= MAX_DIRECT_MUTATION_CANDIDATES ) {
                overloaded = true;
                return;
            }
            directCandidates.add(node);
        };
        for (const m of mutations) {
            if ( m.removedNodes?.length ) { sawRemoval = true; }
            if ( m.type === 'attributes' && m.target instanceof Element ) {
                seenLabels.delete(m.target);
                addDirectCandidate(m.target);
            } else if ( m.type === 'characterData' ) {
                const parent = m.target?.parentElement;
                const text = `${m.target?.textContent || ''}`.trim();
                if (
                    parent instanceof Element &&
                    text !== '' && text.length <= 200
                ) {
                    seenLabels.delete(parent);
                    addDirectCandidate(parent);
                }
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) { continue; }
                if ( collectCandidates(n, true) === false ) {
                    overloaded = true;
                    break;
                }
            }
            if ( overloaded ) { break; }
        }
        for ( const node of directCandidates ) {
            if ( collectDirectCandidate(node) === false ) { overloaded = true; }
            if ( collectDirectCandidate(node.parentElement) === false ) {
                overloaded = true;
            }
        }
        if ( sawRemoval || overloaded ) { pruneDisconnectedRehideObservers(); }
        if ( sawRemoval ) { seenLabels = new WeakSet(); }
        if ( overloaded ) { schedulePendingLabelRecovery(); }
    });

    const onShadowRootsChanged = event => {
        const roots = Array.isArray(event?.detail?.addedRoots)
            ? event.detail.addedRoots
            : (Array.isArray(event?.detail?.roots) ? event.detail.roots : undefined);
        collectKnownShadowRootCandidates(roots, true);
        if ( event?.detail?.removedRoots?.length ) {
            pruneDisconnectedRehideObservers();
        }
    };

    const onShadowContentChanged = event => {
        if ( event?.detail?.overflowed === true ) {
            collectKnownShadowRootCandidates(undefined, true);
            pruneDisconnectedRehideObservers();
            return;
        }
        const addedNodes = Array.isArray(event?.detail?.addedNodes)
            ? event.detail.addedNodes
            : [];
        for ( const node of addedNodes ) {
            if ( collectCandidates(node, true) === false ) { break; }
        }
        if ( event?.detail?.removedNodes?.length ) {
            pruneDisconnectedRehideObservers();
        }
    };

    const onProtectionChanged = () => {
        self.TalonNativeHeuristicsController?.refresh?.().catch(() => {});
    };

    let observerConnected = false;
    let shadowListenersConnected = false;
    let protectionListenerConnected = false;
    let lifecycleGeneration = 0;

    const resetState = () => {
        remoteConfigPromise = undefined;
        pendingLabels = [];
        pendingIndex = 0;
        seenLabels = new WeakSet();
        hiddenContainers = new WeakSet();
        iframeCandidates = new WeakSet();
        candidateScanJobs = [];
        candidateScanIndex = 0;
        candidateScanOverflowed = false;
        pendingLabelOverflowed = false;
        queuedScanRoots = new WeakSet();
        rehideObserved = new WeakSet();
        strongHideCount = 0;
        aggressionBoost = 0;
        persistedBoostState = null;
        strongHidesSincePersist = 0;
        hostProtection = guard?.getProtection?.() || {
            category: '',
            allowedRiskTier: 3,
            matchedBy: '',
        };
    };

    const cleanup = () => {
        if (observerConnected) {
            observer.disconnect();
            observerConnected = false;
        }
        if ( shadowListenersConnected ) {
            self.removeEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
            self.removeEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
            shadowListenersConnected = false;
        }
        if ( protectionListenerConnected ) {
            self.removeEventListener?.(protectionChangedEvent, onProtectionChanged);
            protectionListenerConnected = false;
        }
        for (const obs of rehideObservers.values()) {
            try { obs.disconnect(); } catch { }
        }
        rehideObservers.clear();
        if (processTimer !== undefined) {
            try { cancelCooperativeTask(processTimer); } catch { }
            processTimer = undefined;
        }
        if (candidateScanTimer !== undefined) {
            try { cancelCooperativeTask(candidateScanTimer); } catch { }
            candidateScanTimer = undefined;
        }
        if (persistTimer !== undefined) {
            try { clearTimeout(persistTimer); } catch { }
            persistTimer = undefined;
        }
        if ( pendingLabelRecoveryTimer !== undefined ) {
            try { self.clearTimeout(pendingLabelRecoveryTimer); } catch { }
            pendingLabelRecoveryTimer = undefined;
        }
        restoreOwnedStyles();
        resetState();
    };

    const stop = async () => {
        lifecycleGeneration += 1;
        cleanup();
    };

    const init = async () => {
        const generation = ++lifecycleGeneration;
        await guard?.whenReady?.();
        if ( generation !== lifecycleGeneration ) { return { applied: false }; }
        if (guard?.shouldRunSubsystem?.('nativeHeuristics') === false) {
            cleanup();
            self.addEventListener?.(protectionChangedEvent, onProtectionChanged);
            protectionListenerConnected = true;
            return { applied: false };
        }
        let nextConfig = await loadConfig();
        if ( generation !== lifecycleGeneration ) { return { applied: false }; }
        const remoteConfig = await loadRemoteConfig();
        if ( generation !== lifecycleGeneration ) { return { applied: false }; }
        cleanup();
        self.addEventListener?.(protectionChangedEvent, onProtectionChanged);
        protectionListenerConnected = true;
        hostProtection = guard?.getProtection?.() || hostProtection;
        config = nextConfig;
        if (remoteConfig instanceof Object) {
            const mergeStringArray = (base, extra) => {
                const out = [];
                const seen = new Set();
                const pushAll = arr => {
                    if (Array.isArray(arr) === false) { return; }
                    for (const item of arr) {
                        if (typeof item !== 'string') { continue; }
                        const s = item.trim();
                        if (s === '' || seen.has(s)) { continue; }
                        seen.add(s);
                        out.push(s);
                    }
                };
                pushAll(base);
                pushAll(extra);
                return out;
            };

            config = Object.assign({}, config);
            config.disableHosts = mergeStringArray(config.disableHosts, remoteConfig.disableHosts);
            config.labelRegexes = mergeStringArray(config.labelRegexes, remoteConfig.labelRegexes);
            config.labelSelectors = mergeStringArray(config.labelSelectors, remoteConfig.labelSelectors);
            config.widgetSelectors = mergeStringArray(config.widgetSelectors, remoteConfig.widgetSelectors);
            config.containerStopSelectors = mergeStringArray(
                config.containerStopSelectors,
                remoteConfig.containerStopSelectors
            );

            const mergeNumber = (key, min, max) => {
                const v = Number(remoteConfig[key]);
                if (Number.isFinite(v) === false) { return; }
                config[key] = Math.min(max, Math.max(min, v));
            };
            mergeNumber('maxLabelTextLength', 10, 80);
            mergeNumber('minContainerHeight', 30, 300);
            mergeNumber('minContainerWidth', 60, 600);
            mergeNumber('minScore', 1, 10);
            mergeNumber('minScoreLowConfidence', 1, 12);
        }
        if (Array.isArray(config.disableHosts)) {
            for (const p of config.disableHosts) {
                if (patternMatchesHostname(p, hostname)) {
                    return { applied: false };
                }
            }
        }

        if (BOOST_STORAGE_KEY) {
            const storedBoost = await getLocalValue(BOOST_STORAGE_KEY);
            if ( generation !== lifecycleGeneration ) { return { applied: false }; }
            if (storedBoost instanceof Object) {
                const now = Date.now();
                let count = Number(storedBoost.count) || 0;
                let lastTs = Number(storedBoost.lastTs) || 0;
                if (lastTs === 0 || (now - lastTs) > BOOST_TTL_MS) {
                    count = 0;
                    lastTs = 0;
                }
                persistedBoostState = { count, lastTs };
                if (guard?.isProtectedSurface?.() !== true && count >= BOOST_THRESHOLD) {
                    aggressionBoost = 1;
                }
            } else {
                persistedBoostState = { count: 0, lastTs: 0 };
            }
        }

        labelRegexes = (Array.isArray(config.labelRegexes) ? config.labelRegexes : [])
            .map(compileSafeLabelRegex)
            .filter(Boolean);
        if (labelRegexes.length === 0) {
            labelRegexes = defaultConfig.labelRegexes.map(compileSafeLabelRegex).filter(Boolean);
        }

        labelSelectors = normalizeSafeSelectors(config.labelSelectors);
        widgetSelectors = normalizeSafeSelectors(config.widgetSelectors);
        configuredCandidateSelector = [ ...labelSelectors, ...widgetSelectors ].join(',');
        stopSelectorText = normalizeSafeSelectors(Array.isArray(config.containerStopSelectors)
            ? config.containerStopSelectors
            : defaultConfig.containerStopSelectors
        ).join(',');

        const toNum = (value, fallback) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : fallback;
        };
        minContainerHeight = toNum(config.minContainerHeight, defaultConfig.minContainerHeight);
        minContainerWidth = toNum(config.minContainerWidth, defaultConfig.minContainerWidth);
        minScore = Math.max(1, toNum(config.minScore, defaultConfig.minScore));
        minScoreLowConfidence = Math.max(
            minScore,
            toNum(config.minScoreLowConfidence, minScore + 1)
        );

        collectCandidates(document);
        collectKnownShadowRootCandidates();

        observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                'class',
                'id',
                'style',
                'hidden',
                'aria-hidden',
                'aria-label',
                'aria-labelledby',
                'title',
                'src',
                'name',
                'href',
                'data-ad',
                'data-ad-label-text',
                'data-sponsored',
                'data-ad-unit',
                'data-ad-slot',
                'data-ad-client',
                'data-advertisement',
                'data-testid',
                'role',
            ],
            characterData: true,
        });
        observerConnected = true;
        self.addEventListener?.(shadowRootsChangedEvent, onShadowRootsChanged);
        self.addEventListener?.(shadowContentChangedEvent, onShadowContentChanged);
        shadowListenersConnected = true;
        return { applied: true };
    };

    let config = defaultConfig;
    self.TalonNativeHeuristicsController = {
        refresh: init,
        stop,
    };

    const readiness = self.TalonNativeHeuristicsController.refresh();
    self.TalonNativeHeuristicsReady = readiness;
    readiness.catch(() => {});

})();

self.TalonNativeHeuristicsReady;
