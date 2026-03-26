import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMUNITY_ALLOW_ALL_REQUESTS_MAX,
  COMMUNITY_EXCEPTION_RULES_MAX,
  COMMUNITY_RULE_PRIORITY_ALLOW,
  COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS,
  COMMUNITY_RULE_PRIORITY_BLOCK,
  COMMUNITY_RULE_PRIORITY_REDIRECT,
  normalizeCommunityRuleSchemaVersion,
  sanitizeCommunityRules,
} from '../js/community-rule-sanitizer.js';

test('community rule schema version normalizes legacy, current, and unsupported values', () => {
  assert.equal(normalizeCommunityRuleSchemaVersion(undefined), 1);
  assert.equal(normalizeCommunityRuleSchemaVersion(2), 2);
  assert.equal(normalizeCommunityRuleSchemaVersion(3), 3);
  assert.equal(normalizeCommunityRuleSchemaVersion(4), 4);
  assert.equal(normalizeCommunityRuleSchemaVersion('2'), 2);
  assert.equal(normalizeCommunityRuleSchemaVersion(99), 0);
});

test('legacy community bundles stay block-only and keep non-main-frame third-party normalization', () => {
  const result = sanitizeCommunityRules([
    {
      action: { type: 'block' },
      condition: {
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script', 'main_frame'],
      },
    },
    {
      action: { type: 'allow' },
      condition: {
        initiatorDomains: ['news.example.com'],
        resourceTypes: ['script'],
      },
    },
  ], {
    schemaVersion: 1,
  });

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].action.type, 'block');
  assert.equal(result.rules[0].priority, COMMUNITY_RULE_PRIORITY_BLOCK);
  assert.deepEqual(result.rules[0].condition.resourceTypes, ['script']);
  assert.equal(result.rules[0].condition.domainType, 'thirdParty');
  assert.equal(result.byAction.block, 1);
  assert.equal(result.dropped.unsupportedAction, 1);
});

test('schema v2 accepts safe allow, allowAllRequests, and packaged redirect exception rules', () => {
  const result = sanitizeCommunityRules([
    {
      action: { type: 'allow' },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: ['news.example.com'],
        resourceTypes: ['main_frame'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script'],
        domainType: 'thirdParty',
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 3);
  assert.equal(result.byAction.allow, 1);
  assert.equal(result.byAction.allowAllRequests, 1);
  assert.equal(result.byAction.redirect, 1);
  assert.equal(result.exceptionCount, 3);

  const allowRule = result.rules[0];
  assert.equal(allowRule.priority, COMMUNITY_RULE_PRIORITY_ALLOW);
  assert.deepEqual(allowRule.condition.initiatorDomains, ['news.example.com']);
  assert.deepEqual(allowRule.condition.requestDomains, ['cdn.example.net']);

  const allowAllRule = result.rules[1];
  assert.equal(allowAllRule.priority, COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS);
  assert.deepEqual(allowAllRule.condition.resourceTypes, ['main_frame']);

  const redirectRule = result.rules[2];
  assert.equal(redirectRule.priority, COMMUNITY_RULE_PRIORITY_REDIRECT);
  assert.equal(
    redirectRule.action.redirect.extensionPath,
    '/web_accessible_resources/noop.js'
  );
  assert.deepEqual(redirectRule.condition.resourceTypes, ['script']);
  assert.equal(redirectRule.condition.domainType, 'thirdParty');
});

test('schema v2 accepts bounded first-party exact-host redirects with path prefixes', () => {
  const result = sanitizeCommunityRules([
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlPathPrefix: '/api/player',
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 1);
  assert.equal(result.byAction.redirect, 1);
  assert.equal(result.exceptionCount, 1);
  assert.deepEqual(result.rules[0], {
    action: {
      type: 'redirect',
      redirect: {
        extensionPath: '/web_accessible_resources/noop.js',
      },
    },
    condition: {
      initiatorDomains: ['video.example.com'],
      requestDomains: ['video.example.com'],
      resourceTypes: ['script'],
      domainType: 'firstParty',
      urlFilter: '||video.example.com/api/player',
    },
    priority: COMMUNITY_RULE_PRIORITY_REDIRECT,
  });

  const storedShape = sanitizeCommunityRules(result.rules, {
    schemaVersion: 2,
  });
  assert.deepEqual(storedShape.rules, result.rules);
});

test('schema v2 accepts passive packaged XML and media redirect stubs', () => {
  const result = sanitizeCommunityRules([
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop-vast3.xml',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['ads.example.net'],
        resourceTypes: ['xmlhttprequest'],
        domainType: 'thirdParty',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop-vmap1.xml',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['ads.example.net'],
        resourceTypes: ['xmlhttprequest'],
        domainType: 'thirdParty',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop-0.1s.mp3',
        },
      },
      condition: {
        initiatorDomains: ['audio.example.com'],
        requestDomains: ['ads.example.net'],
        resourceTypes: ['media'],
        domainType: 'thirdParty',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop-1s.mp4',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['ads.example.net'],
        resourceTypes: ['media'],
        domainType: 'thirdParty',
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 4);
  assert.equal(result.byAction.redirect, 4);
  assert.equal(result.dropped.unsupportedRedirectPath, 0);
  assert.deepEqual(
    result.rules.map(rule => rule.action.redirect.extensionPath),
    [
      '/web_accessible_resources/noop-vast3.xml',
      '/web_accessible_resources/noop-vmap1.xml',
      '/web_accessible_resources/noop-0.1s.mp3',
      '/web_accessible_resources/noop-1s.mp4',
    ]
  );
  assert.ok(
    result.rules.every(rule => rule.priority === COMMUNITY_RULE_PRIORITY_REDIRECT)
  );
});

test('schema v2 rejects unsafe first-party redirect scope and bad redirect/resource pairings', () => {
  const result = sanitizeCommunityRules([
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlPathPrefix: '/api/player',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['checkout.shopify.com'],
        requestDomains: ['checkout.shopify.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlPathPrefix: '/assets/',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.css',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['main_frame'],
        domainType: 'firstParty',
        urlPathPrefix: '/assets/',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['image'],
        domainType: 'firstParty',
        urlPathPrefix: '/images/',
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['video.example.com'],
        requestDomains: ['video.example.com'],
        resourceTypes: ['script'],
        domainType: 'firstParty',
        urlPathPrefix: 'api/player',
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 0);
  assert.equal(result.dropped.unsupportedRedirectPath, 1);
  assert.equal(result.dropped.unsafeScope, 5);
});

test('schema v2 rejects unsafe exception scope, unsupported redirect targets, and unsupported actions', () => {
  const result = sanitizeCommunityRules([
    {
      action: { type: 'allow' },
      condition: {
        initiatorDomains: ['*.paypal.com'],
        resourceTypes: ['script'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          url: 'https://example.com/nope.js',
        },
      },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: '/web_accessible_resources/noop.js',
          transform: {},
        },
      },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['cdn.example.net'],
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'modifyHeaders' },
      condition: {
        requestDomains: ['news.example.com'],
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'allowAllRequests' },
      condition: {
        requestDomains: ['news.example.com'],
        resourceTypes: ['sub_frame'],
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 0);
  assert.equal(result.dropped.unsafeScope, 3);
  assert.equal(result.dropped.unsupportedRedirectPath, 1);
  assert.equal(result.dropped.unsupportedAction, 1);
});

test('schema v2 rejects internal Talon first-party exact host scopes', () => {
  const result = sanitizeCommunityRules([
    {
      action: { type: 'block' },
      condition: {
        requestDomains: ['talondefender.com'],
        resourceTypes: ['script'],
      },
    },
    {
      action: { type: 'allow' },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['talondefender.com'],
        resourceTypes: ['script'],
      },
    },
    {
      action: {
        type: 'redirect',
        redirect: {
          extensionPath: 'web_accessible_resources/noop.js',
        },
      },
      condition: {
        initiatorDomains: ['news.example.com'],
        requestDomains: ['talondefender.com'],
        resourceTypes: ['script'],
      },
    },
  ], {
    schemaVersion: 2,
  });

  assert.equal(result.rules.length, 0);
  assert.equal(result.dropped.unsafeScope, 3);
});

test('community exception quotas cap total exceptions and allowAllRequests relief separately', () => {
  const allowRules = Array.from({ length: COMMUNITY_EXCEPTION_RULES_MAX + 1 }, (_, index) => ({
    action: { type: 'allow' },
    condition: {
      initiatorDomains: [`site-${index}.example.com`],
      resourceTypes: ['script'],
    },
  }));
  const allowResult = sanitizeCommunityRules(allowRules, { schemaVersion: 2 });
  assert.equal(allowResult.rules.length, COMMUNITY_EXCEPTION_RULES_MAX);
  assert.equal(allowResult.byAction.allow, COMMUNITY_EXCEPTION_RULES_MAX);
  assert.equal(allowResult.dropped.quota, 1);
  assert.deepEqual(allowResult.dropped.quotaByClass, {
    exactExceptions: 1,
    exactRedirects: 0,
    exactBlocks: 0,
    broadBlocks: 0,
    regexBlocks: 0,
  });

  const allowAllRules = Array.from({ length: COMMUNITY_ALLOW_ALL_REQUESTS_MAX + 1 }, (_, index) => ({
    action: { type: 'allowAllRequests' },
    condition: {
      requestDomains: [`site-${index}.example.com`],
      resourceTypes: ['main_frame'],
    },
  }));
  const allowAllResult = sanitizeCommunityRules(allowAllRules, { schemaVersion: 2 });
  assert.equal(allowAllResult.rules.length, COMMUNITY_ALLOW_ALL_REQUESTS_MAX);
  assert.equal(allowAllResult.byAction.allowAllRequests, COMMUNITY_ALLOW_ALL_REQUESTS_MAX);
  assert.equal(allowAllResult.dropped.quota, 1);
  assert.deepEqual(allowAllResult.dropped.quotaByClass, {
    exactExceptions: 1,
    exactRedirects: 0,
    exactBlocks: 0,
    broadBlocks: 0,
    regexBlocks: 0,
  });
});

test('community exception priorities stay ordered and below user/admin dynamic priorities', () => {
  assert.equal(COMMUNITY_RULE_PRIORITY_BLOCK < COMMUNITY_RULE_PRIORITY_REDIRECT, true);
  assert.equal(COMMUNITY_RULE_PRIORITY_REDIRECT < COMMUNITY_RULE_PRIORITY_ALLOW, true);
  assert.equal(COMMUNITY_RULE_PRIORITY_ALLOW < COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS, true);
  assert.equal(COMMUNITY_RULE_PRIORITY_ALLOW_ALL_REQUESTS < 1000000, true);
});
