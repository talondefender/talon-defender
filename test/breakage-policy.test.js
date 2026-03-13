import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDITABLE_SUBSYSTEMS,
  classifyProtectedSurface,
  isKnownConsentSelector,
  isRemoteScriptletAllowed,
  isSafeMutationSelector,
  patternCouldMatchProtectedDomain,
  patternMatchesHostname,
  resolveAuditOverride,
  sanitizeBreakageAuditOverrides,
} from '../js/breakage-policy.js';

test('protected surface classifier locks down sensitive hosts and paths', () => {
  const login = classifyProtectedSurface('accounts.google.com', '/');
  assert.equal(login.category, 'auth/account');
  assert.equal(login.allowedRiskTier, 1);

  const checkout = classifyProtectedSurface('shop.example.com', '/checkout');
  assert.equal(checkout.category, 'checkout/payment');
  assert.equal(checkout.allowedRiskTier, 1);

  const article = classifyProtectedSurface('example.com', '/news/post');
  assert.equal(article.allowedRiskTier, 3);
});

test('hostname matcher covers wildcard and exact matches', () => {
  assert.equal(patternMatchesHostname('*.stripe.com', 'api.stripe.com'), true);
  assert.equal(patternMatchesHostname('docs.google.com', 'docs.google.com'), true);
  assert.equal(patternMatchesHostname('docs.google.com', 'drive.google.com'), false);
});

test('selector safety rejects page shells and accepts nuisance-specific selectors', () => {
  assert.equal(isSafeMutationSelector('main'), false);
  assert.equal(isSafeMutationSelector('body'), false);
  assert.equal(isSafeMutationSelector('.cookie-banner'), true);
  assert.equal(isSafeMutationSelector('.page-wrapper'), false);
  assert.equal(isKnownConsentSelector('#onetrust-banner-sdk'), true);
});

test('protected host exposure detection treats wildcards and sensitive domains as risky', () => {
  assert.equal(patternCouldMatchProtectedDomain('*'), true);
  assert.equal(patternCouldMatchProtectedDomain('*.paypal.com'), true);
  assert.equal(patternCouldMatchProtectedDomain('news.example.com'), false);
});

test('remote scriptlet denylist blocks risky tokens', () => {
  assert.equal(isRemoteScriptletAllowed('trusted-click-element'), false);
  assert.equal(isRemoteScriptletAllowed('set-attr'), false);
  assert.equal(isRemoteScriptletAllowed('safe-token'), true);
});

test('audit overrides keep only known subsystems and resolve by host', () => {
  const overrides = sanitizeBreakageAuditOverrides({
    global: {
      nativeHeuristics: false,
      unknown: true,
    },
    hosts: {
      'news.example.com': {
        remoteCosmetics: false,
        garbage: true,
      },
    },
  });

  assert.deepEqual(Object.keys(overrides.global), ['nativeHeuristics']);
  assert.equal(AUDITABLE_SUBSYSTEMS.includes('remoteCosmetics'), true);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'remoteCosmetics'), false);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'nativeHeuristics'), false);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'automation'), undefined);
});
