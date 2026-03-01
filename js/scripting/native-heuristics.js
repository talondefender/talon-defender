/******************************************************************************/
// Important!
// Isolate from global scope
(function uBOL_nativeHeuristics() {

    const CONFIG_PATH = 'automation/native-heuristics.json';
    const REMOTE_CONFIG_KEY = 'communityBundleHeuristics';
    const BOOST_STORAGE_PREFIX = 'nativeHeuristicsBoost';
    const BOOST_TTL_MS = 7 * 24 * 3600 * 1000;
    const BOOST_THRESHOLD = 12;
    const BOOST_MAX = 50;

    const runtime = self.browser?.runtime || self.chrome?.runtime;
    const getURL = runtime?.getURL?.bind(runtime) || (p => p);
    const storage = self.browser?.storage?.local || self.chrome?.storage?.local;

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
        configPromise = fetch(getURL(CONFIG_PATH)).then(r => {
            if (r.ok === false) { throw new Error(r.statusText); }
            return r.json();
        }).catch(() => defaultConfig);
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
                remoteConfigPromise = maybePromise.then(bin => bin?.[REMOTE_CONFIG_KEY] || null)
                    .catch(() => null);
                return remoteConfigPromise;
            }
        } catch {
        }
        remoteConfigPromise = new Promise(resolve => {
            try {
                storage.get(REMOTE_CONFIG_KEY, bin => resolve(bin?.[REMOTE_CONFIG_KEY] || null));
            } catch {
                resolve(null);
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
    if (hostname === '') { return; }

    const registrableDomain = hn => {
        const parts = hn.split('.').filter(Boolean);
        if (parts.length <= 2) { return hn; }
        return parts.slice(-2).join('.');
    };
    const pageDomain = registrableDomain(hostname);
    const boostDomain = pageDomain || hostname;
    const BOOST_STORAGE_KEY = boostDomain
        ? `${BOOST_STORAGE_PREFIX}.${boostDomain}`
        : null;

    // Dynamic boosts: after repeated heuristic hides, promote stronger cosmetics.
    let hideCount = 0;
    let strongHideCount = 0;
    let aggressionBoost = 0; // session-only, max 1
    let persistedBoostState = null;
    let strongHidesSincePersist = 0;
    let persistTimer;
    let genericHighSent = false;
    let completeSent = false;
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
        hideCount += 1;

        if (isStrong) {
            strongHideCount += 1;
            if (aggressionBoost === 0 && strongHideCount >= 4) {
                aggressionBoost = 1;
            }
            schedulePersistStrongHide();
        }
        if (genericHighSent === false && hideCount >= 3) {
            genericHighSent = true;
            try {
                runtime?.sendMessage?.({
                    what: 'promoteGenericHigh',
                    hostname: pageDomain || hostname,
                }).catch(() => { });
            } catch {
            }
        }
        if (completeSent === false && hideCount >= 6) {
            completeSent = true;
            try {
                runtime?.sendMessage?.({
                    what: 'promoteComplete',
                    hostname: pageDomain || hostname,
                }).catch(() => { });
            } catch {
            }
        }
    };

    const patternMatchesHostname = (pattern, hn) => {
        if (typeof pattern !== 'string') { return false; }
        const p = pattern.toLowerCase();
        if (p === '*' || p === 'all-urls') { return true; }
        if (p.startsWith('*.')) {
            const bare = p.slice(2);
            return hn === bare || hn.endsWith(`.${bare}`);
        }
        if (p.endsWith('.*')) {
            const bare = p.slice(0, -2);
            return hn === bare || hn.startsWith(`${bare}.`);
        }
        return hn === p || hn.endsWith(`.${p}`);
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

    const TEXT_LABEL_SELECTOR = 'span,small,a,div,p,strong,em,label';

    const pendingLabels = [];
    let pendingIndex = 0;
    const seenLabels = new WeakSet();
    const hiddenContainers = new WeakSet();
    const iframeCandidates = new WeakSet();

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

        if (standardSized) {
            return attrHintRe.test(hintParts) || isThirdPartyFrame(frame);
        }
        // Non-standard sizes require stronger hints to avoid false positives.
        return attrHintRe.test(hintParts) && isThirdPartyFrame(frame);
    };

    let minContainerHeight = defaultConfig.minContainerHeight;
    let minContainerWidth = defaultConfig.minContainerWidth;
    let minScore = defaultConfig.minScore;
    let minScoreLowConfidence = defaultConfig.minScoreLowConfidence;

    const enqueueLabel = el => {
        if (el instanceof Element === false) { return; }
        if (seenLabels.has(el)) { return; }
        seenLabels.add(el);
        pendingLabels.push(el);
    };

    const collectCandidates = root => {
        if (
            root !== document &&
            root instanceof Element === false &&
            root instanceof DocumentFragment === false
        ) {
            return;
        }
        const selectorList = [...labelSelectors, ...widgetSelectors]
            .filter(s => typeof s === 'string' && s !== '');
        if (selectorList.length !== 0) {
            let nodes;
            try {
                nodes = (root === document ? document : root).querySelectorAll(
                    selectorList.join(',')
                );
            } catch {
                nodes = [];
            }
            for (const node of nodes) {
                if (isVisible(node) === false) { continue; }
                enqueueLabel(node);
            }
        }

        // Text label scan – capped for safety.
        // Standard ad-size iframes (unlabeled) scan.
        let frames;
        try {
            frames = (root === document ? document : root).querySelectorAll('iframe');
        } catch {
            frames = [];
        }
        let scannedFrames = 0;
        const maxFrames = root === document ? 80 : 20;
        for (const frame of frames) {
            if (scannedFrames++ >= maxFrames) { break; }
            if (isAdIframeCandidate(frame) === false) { continue; }
            iframeCandidates.add(frame);
            enqueueLabel(frame);
        }

        let textNodes;
        try {
            textNodes = (root === document ? document.body : root).querySelectorAll(TEXT_LABEL_SELECTOR);
        } catch {
            return;
        }
        let scanned = 0;
        const maxScan = root === document ? 800 : 200;
        for (const node of textNodes) {
            if (scanned++ >= maxScan) { break; }
            if (isVisible(node) === false) { continue; }
            const text = node.textContent?.trim() || '';
            if (text === '') { continue; }
            if (text.length > (config.maxLabelTextLength || 40)) { continue; }
            if (labelRegexes.some(re => re.test(text)) === false) { continue; }
            enqueueLabel(node);
        }
    };

    const hasOutboundLink = container => {
        const links = container.querySelectorAll('a[href]');
        for (const a of links) {
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
        const text = el.textContent?.trim() || '';
        if (text === '') { return false; }
        return labelRegexes.some(re => re.test(text));
    };

    const findContainer = el => {
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
        return container;
    };

    const shouldHideContainer = (container, labelEl) => {
        const rect = container.getBoundingClientRect();
        if (rect.height < minContainerHeight || rect.width < minContainerWidth) {
            return false;
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

        let score = 0;
        if (widgetHint) { score += 4; }
        if (selectorHint) { score += 3; }
        let strongLabel = false;
        if (labelHint) {
            score += 3;
            const text = labelEl.textContent?.trim() || '';
            if (text !== '' && STRONG_LABEL_RE.test(text)) {
                strongLabel = true;
                score += 1;
            }
        }
        if (attrHint) { score += 1; }
        if (adChoicesHint) { score += 1; }
        if (outboundHint) { score += 1; }
        if (sizeHint) { score += 1; }

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
        const shouldHide = score >= needed;
        const isStrong = Boolean(
            widgetHint ||
            selectorHint ||
            strongLabel ||
            adChoicesHint ||
            attrHint ||
            sizeHint
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
                html.style.setProperty('overflow', 'auto', 'important');
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
                body.style.setProperty('overflow', 'auto', 'important');
            }
            if (body && bodyFixed) {
                body.style.setProperty('position', 'static', 'important');
                body.style.setProperty('top', 'auto', 'important');
            }
        } catch {
        }

        if (restoreY !== undefined) {
            try { self.scrollTo(0, restoreY); } catch { }
        }

        return true;
    };

    const hideContainer = (container, isStrong = false, overlayHint) => {
        try {
            if (container.dataset?.uBolNativeHidden) {
                if (isVisible(container)) {
                    container.style.setProperty('display', 'none', 'important');
                    container.style.setProperty('visibility', 'hidden', 'important');
                }
                return;
            }
            container.style.setProperty('display', 'none', 'important');
            container.style.setProperty('visibility', 'hidden', 'important');
            container.dataset.uBolNativeHidden = '1';
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

    const rehideObserved = new WeakSet();
    const ensureStaysHidden = container => {
        if (container instanceof Element === false) { return; }
        if (rehideObserved.has(container)) { return; }
        rehideObserved.add(container);
        try {
            const obs = new MutationObserver(() => {
                if (container.isConnected === false) {
                    obs.disconnect();
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
        } catch {
        }
    };

    const collapseEmptyParent = container => {
        const parent = container.parentElement;
        if (parent === null) { return; }
        if (parent === document.body || parent === document.documentElement) { return; }
        if (parent.dataset?.uBolNativeCollapsed) { return; }
        if (parent.closest('nav,header,footer')) { return; }

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
        if (attrHintRe.test(hintParts) === false && adSized === false) { return; }

        try {
            parent.style.setProperty('display', 'none', 'important');
            parent.style.setProperty('visibility', 'hidden', 'important');
            parent.dataset.uBolNativeCollapsed = '1';
            ensureStaysHidden(parent);
            unlockScrollIfNeeded();
        } catch {
        }
    };

    let processTimer;
    const MAX_TIME_SLICE_MS = 4;

    const processPending = () => {
        processTimer = undefined;
        const deadline = self.performance.now() + MAX_TIME_SLICE_MS;
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
            return;
        }
        scheduleProcess();
    };

    const scheduleProcess = () => {
        if (processTimer !== undefined) { return; }
        processTimer = self.requestAnimationFrame(processPending);
    };

    // Shadow DOM support (open roots only). We scan conservatively to avoid overhead.
    let shadowScanTimer;
    const MAX_SHADOW_SCAN_NODES = 1500;

    const collectShadowRootsFrom = node => {
        if (node instanceof Element === false) { return; }
        const roots = [];
        if (node.shadowRoot instanceof DocumentFragment) {
            roots.push(node.shadowRoot);
        }
        try {
            const walker = document.createTreeWalker(
                node,
                self.NodeFilter?.SHOW_ELEMENT || 1
            );
            let scanned = 0;
            while (walker.nextNode()) {
                const el = walker.currentNode;
                if (el.shadowRoot instanceof DocumentFragment) {
                    roots.push(el.shadowRoot);
                }
                if (++scanned >= 200) { break; }
            }
        } catch {
        }
        for (const sr of roots) {
            collectCandidates(sr);
        }
    };

    const scanOpenShadowRoots = root => {
        if (root instanceof Element === false) { return; }
        try {
            const walker = document.createTreeWalker(
                root,
                self.NodeFilter?.SHOW_ELEMENT || 1
            );
            let scanned = 0;
            while (walker.nextNode()) {
                const el = walker.currentNode;
                if (el.shadowRoot instanceof DocumentFragment) {
                    collectCandidates(el.shadowRoot);
                }
                if (++scanned >= MAX_SHADOW_SCAN_NODES) { break; }
            }
        } catch {
        }
    };

    const scheduleShadowScan = (delay = 1200) => {
        if (shadowScanTimer !== undefined) { return; }
        shadowScanTimer = self.setTimeout(() => {
            shadowScanTimer = undefined;
            scanOpenShadowRoots(document.body);
            scheduleProcess();
        }, delay);
    };

    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) { continue; }
                collectCandidates(n);
                collectShadowRootsFrom(n);
            }
        }
        scheduleShadowScan();
        scheduleProcess();
    });

    const init = async () => {
        config = await loadConfig();
        const remoteConfig = await loadRemoteConfig();
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
                if (patternMatchesHostname(p, hostname)) { return; }
            }
        }

        if (BOOST_STORAGE_KEY) {
            const storedBoost = await getLocalValue(BOOST_STORAGE_KEY);
            if (storedBoost instanceof Object) {
                const now = Date.now();
                let count = Number(storedBoost.count) || 0;
                let lastTs = Number(storedBoost.lastTs) || 0;
                if (lastTs === 0 || (now - lastTs) > BOOST_TTL_MS) {
                    count = 0;
                    lastTs = 0;
                }
                persistedBoostState = { count, lastTs };
                if (count >= BOOST_THRESHOLD) {
                    aggressionBoost = 1;
                }
            } else {
                persistedBoostState = { count: 0, lastTs: 0 };
            }
        }

        labelRegexes = (Array.isArray(config.labelRegexes) ? config.labelRegexes : [])
            .map(s => {
                try { return new RegExp(s, 'i'); } catch { return null; }
            })
            .filter(Boolean);
        if (labelRegexes.length === 0) {
            labelRegexes = defaultConfig.labelRegexes.map(s => new RegExp(s, 'i'));
        }

        labelSelectors = Array.isArray(config.labelSelectors) ? config.labelSelectors : [];
        widgetSelectors = Array.isArray(config.widgetSelectors) ? config.widgetSelectors : [];
        stopSelectorText = (Array.isArray(config.containerStopSelectors)
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
        scheduleShadowScan(0);
        scheduleProcess();

        observer.observe(document, { childList: true, subtree: true });
    };

    let config = defaultConfig;
    init();

})();

void 0;
