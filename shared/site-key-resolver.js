// Shared site-key resolver for modules and classic content scripts.
(function talonSiteKeyResolverScope() {
    if ( globalThis.TalonSiteKeyResolver ) { return; }

    const MULTI_LABEL_PUBLIC_SUFFIXES = Object.freeze([
        'ac.il',
        'ac.in',
        'ac.jp',
        'ac.kr',
        'ac.nz',
        'ac.th',
        'ac.uk',
        'ac.vn',
        'asn.au',
        'co.id',
        'co.il',
        'co.in',
        'co.jp',
        'co.kr',
        'co.nz',
        'co.th',
        'co.uk',
        'com.ar',
        'com.au',
        'com.br',
        'com.cn',
        'com.co',
        'com.do',
        'com.ec',
        'com.eg',
        'com.gt',
        'com.hk',
        'com.mx',
        'com.my',
        'com.ng',
        'com.pa',
        'com.pe',
        'com.ph',
        'com.pk',
        'com.pl',
        'com.sg',
        'com.tr',
        'com.tw',
        'com.ua',
        'com.uy',
        'com.ve',
        'com.vn',
        'csiro.au',
        'edu.au',
        'edu.br',
        'edu.cn',
        'edu.do',
        'edu.ec',
        'edu.eg',
        'edu.gt',
        'edu.mx',
        'edu.my',
        'edu.ng',
        'edu.pa',
        'edu.pe',
        'edu.ph',
        'edu.pk',
        'edu.pl',
        'edu.sg',
        'edu.tr',
        'edu.tw',
        'edu.ua',
        'edu.uy',
        'edu.ve',
        'edu.vn',
        'firm.in',
        'gen.in',
        'gen.tr',
        'gob.do',
        'gob.mx',
        'gob.pa',
        'gob.pe',
        'gob.ve',
        'go.id',
        'go.jp',
        'go.kr',
        'gov.au',
        'gov.br',
        'gov.cn',
        'gov.hk',
        'gov.il',
        'gov.in',
        'gov.my',
        'gov.ng',
        'gov.sg',
        'gov.tr',
        'gov.tw',
        'gov.uk',
        'gov.ua',
        'gov.ve',
        'gov.vn',
        'govt.nz',
        'gub.uy',
        'id.au',
        'idv.hk',
        'idv.tw',
        'iwi.nz',
        'kiwi.nz',
        'lg.jp',
        'ltd.uk',
        'me.uk',
        'mil.br',
        'mil.cn',
        'mil.co',
        'mil.do',
        'mil.ec',
        'mil.eg',
        'mil.gt',
        'mil.id',
        'mil.in',
        'mil.kr',
        'mil.my',
        'mil.ng',
        'mil.pa',
        'mil.pe',
        'mil.ph',
        'mil.pk',
        'mil.tr',
        'mil.tw',
        'mil.uy',
        'mil.ve',
        'name.tr',
        'ne.jp',
        'ne.kr',
        'net.au',
        'net.br',
        'net.cn',
        'net.do',
        'net.ec',
        'net.eg',
        'net.gt',
        'net.hk',
        'net.id',
        'net.il',
        'net.in',
        'net.kr',
        'net.mx',
        'net.my',
        'net.ng',
        'net.nz',
        'net.pa',
        'net.pe',
        'net.ph',
        'net.pk',
        'net.pl',
        'net.sg',
        'net.th',
        'net.tr',
        'net.tw',
        'net.ua',
        'net.uy',
        'net.ve',
        'net.vn',
        'nhs.uk',
        'nic.in',
        'nom.co',
        'nom.pe',
        'or.id',
        'or.jp',
        'or.kr',
        'org.au',
        'org.br',
        'org.cn',
        'org.co',
        'org.do',
        'org.ec',
        'org.eg',
        'org.gt',
        'org.hk',
        'org.il',
        'org.in',
        'org.kr',
        'org.mx',
        'org.my',
        'org.ng',
        'org.nz',
        'org.pa',
        'org.pe',
        'org.ph',
        'org.pk',
        'org.pl',
        'org.sg',
        'org.th',
        'org.tr',
        'org.tw',
        'org.ua',
        'org.uy',
        'org.ve',
        'org.vn',
        'plc.uk',
        'pol.tr',
        'res.in',
        'sch.id',
        'sch.uk',
        'school.nz',
        'web.id',
        'web.tr',
    ]);

    const multiLabelPublicSuffixSet = new Set(MULTI_LABEL_PUBLIC_SUFFIXES);
    const reservedSecondLevelLabels = new Set(
        MULTI_LABEL_PUBLIC_SUFFIXES
            .map(entry => entry.split('.')[0])
            .filter(label => typeof label === 'string' && label !== '')
    );

    const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
    const HOSTNAME_LABEL_RE = /^[a-z0-9-]+$/;

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

    const isPublicSuffix = hostname => {
        const normalized = normalizeHostname(hostname);
        if ( normalized === '' ) { return false; }
        if ( normalized === 'localhost' || isIpAddress(normalized) ) { return false; }
        const labels = normalized.split('.');
        if ( labels.length === 0 || hasInvalidHostnameLabel(labels) ) { return false; }
        if ( labels.length === 1 ) { return true; }
        return multiLabelPublicSuffixSet.has(normalized);
    };

    const getRegistrableDomain = hostname => {
        const normalized = normalizeHostname(hostname);
        if ( normalized === '' ) { return ''; }
        if ( normalized === 'localhost' || isIpAddress(normalized) ) { return normalized; }

        const labels = normalized.split('.');
        if ( labels.length <= 1 ) { return normalized; }
        if ( hasInvalidHostnameLabel(labels) ) { return normalized; }
        if ( labels.length === 2 ) { return normalized; }

        const suffix2 = labels.slice(-2).join('.');
        if ( multiLabelPublicSuffixSet.has(suffix2) ) {
            return labels.slice(-3).join('.');
        }

        const tld = labels.at(-1) || '';
        const secondLevel = labels.at(-2) || '';
        if ( tld.length === 2 && reservedSecondLevelLabels.has(secondLevel) ) {
            return normalized;
        }

        return labels.slice(-2).join('.');
    };

    globalThis.TalonSiteKeyResolver = Object.freeze({
        MULTI_LABEL_PUBLIC_SUFFIXES,
        normalizeHostname,
        isIpAddress,
        isPublicSuffix,
        getRegistrableDomain,
        getSiteKey: getRegistrableDomain,
    });
})();

void 0;
