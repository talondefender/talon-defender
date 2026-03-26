// Shared site-key resolver for modules and classic content scripts.
(function talonSiteKeyResolverScope() {
    if ( globalThis.TalonSiteKeyResolver ) { return; }

    const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
    const HOSTNAME_LABEL_RE = /^[a-z0-9-]+$/;

    let publicSuffixRuleSets;

    const normalizeHostname = value => {
        if ( typeof value !== 'string' ) { return ''; }
        const lowerCased = value.trim().toLowerCase();
        if ( lowerCased === '' ) { return ''; }
        const ipCandidate = lowerCased.replace(/^\[|\]$/g, '');
        if ( lowerCased.includes(':') && /^[0-9a-f:.]+$/.test(ipCandidate) ) {
            return ipCandidate;
        }
        const trimmed = lowerCased.replace(/^\.+|\.+$/g, '');
        if ( trimmed === '' ) { return ''; }
        if ( /[\s/\\:@?#[\]]/.test(trimmed) ) { return ''; }
        return trimmed;
    };

    const isIpAddress = hostname => {
        if ( typeof hostname !== 'string' || hostname === '' ) { return false; }
        return IPV4_RE.test(hostname) || hostname.includes(':');
    };

    const hasInvalidHostnameLabel = labels => {
        for ( const label of labels ) {
            if ( label === '' || label.length > 63 ) { return true; }
            if ( label.startsWith('-') || label.endsWith('-') ) { return true; }
            if ( HOSTNAME_LABEL_RE.test(label) === false ) { return true; }
        }
        return false;
    };

    const splitRules = value => (
        typeof value === 'string' && value !== ''
            ? value.split('\n').filter(rule => typeof rule === 'string' && rule !== '')
            : []
    );

    const getPublicSuffixRuleSets = () => {
        if ( publicSuffixRuleSets !== undefined ) { return publicSuffixRuleSets; }
        const data = globalThis.TalonPublicSuffixData;
        if ( data instanceof Object === false ) {
            publicSuffixRuleSets = null;
            return publicSuffixRuleSets;
        }
        publicSuffixRuleSets = {
            exact: new Set(splitRules(data.exactRulesText)),
            wildcard: new Set(splitRules(data.wildcardRulesText)),
            exception: new Set(splitRules(data.exceptionRulesText)),
        };
        return publicSuffixRuleSets;
    };

    const getPublicSuffixLabelCount = labels => {
        const ruleSets = getPublicSuffixRuleSets();
        if ( ruleSets === null ) { return 0; }
        let matchingLength = 1;
        let exceptionLength = 0;
        for ( let count = 1; count <= labels.length; count++ ) {
            const suffix = labels.slice(-count).join('.');
            if ( ruleSets.exact.has(suffix) ) {
                matchingLength = Math.max(matchingLength, count);
            }
            if ( count < labels.length && ruleSets.wildcard.has(suffix) ) {
                matchingLength = Math.max(matchingLength, count + 1);
            }
            if ( ruleSets.exception.has(suffix) ) {
                exceptionLength = Math.max(exceptionLength, count);
            }
        }
        if ( exceptionLength > 0 ) {
            return Math.max(1, exceptionLength - 1);
        }
        return matchingLength;
    };

    const isPublicSuffix = hostname => {
        const normalized = normalizeHostname(hostname);
        if ( normalized === '' ) { return false; }
        if ( normalized === 'localhost' || isIpAddress(normalized) ) { return false; }
        const labels = normalized.split('.');
        if ( labels.length === 0 || hasInvalidHostnameLabel(labels) ) { return false; }
        if ( labels.length === 1 ) { return true; }
        const publicSuffixLabelCount = getPublicSuffixLabelCount(labels);
        return publicSuffixLabelCount !== 0 && publicSuffixLabelCount === labels.length;
    };

    const getRegistrableDomain = hostname => {
        const normalized = normalizeHostname(hostname);
        if ( normalized === '' ) { return ''; }
        if ( normalized === 'localhost' || isIpAddress(normalized) ) { return normalized; }

        const labels = normalized.split('.');
        if ( labels.length <= 1 ) { return normalized; }
        if ( hasInvalidHostnameLabel(labels) ) { return normalized; }

        const publicSuffixLabelCount = getPublicSuffixLabelCount(labels);
        if ( publicSuffixLabelCount === 0 ) { return normalized; }
        if ( labels.length <= publicSuffixLabelCount ) { return normalized; }

        return labels.slice(-(publicSuffixLabelCount + 1)).join('.');
    };

    globalThis.TalonSiteKeyResolver = Object.freeze({
        normalizeHostname,
        isIpAddress,
        isPublicSuffix,
        getRegistrableDomain,
        getSiteKey: getRegistrableDomain,
    });
})();

void 0;
