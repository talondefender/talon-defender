import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  AUDITABLE_SUBSYSTEMS,
  classifyProtectedSurface,
  isInternalUnfilteredHostname,
  isKnownConsentSelector,
  isRemoteScriptletAllowed,
  isSafeMutationSelector,
  patternCouldMatchInternalUnfilteredDomain,
  patternCouldMatchProtectedDomain,
  patternMatchesHostname,
  resolveAuditOverride,
  sanitizeBreakageAuditOverrides,
} from '../js/breakage-policy.js';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const pathExists = async relativePath => {
  try {
    await fs.access(new URL(`../${relativePath}`, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

test('protected surface classifier and hostname matching stay conservative on sensitive hosts', () => {
  const login = classifyProtectedSurface('accounts.google.com', '/');
  const checkout = classifyProtectedSurface('shop.example.com', '/checkout');
  const article = classifyProtectedSurface('example.com', '/news/post');

  assert.equal(login.category, 'auth/account');
  assert.equal(login.allowedRiskTier, 1);
  assert.equal(checkout.category, 'checkout/payment');
  assert.equal(checkout.allowedRiskTier, 1);
  assert.equal(article.allowedRiskTier, 3);

  assert.equal(patternMatchesHostname('*.stripe.com', 'api.stripe.com'), true);
  assert.equal(patternMatchesHostname('=docs.google.com', 'docs.google.com'), true);
  assert.equal(patternMatchesHostname('=docs.google.com', 'sub.docs.google.com'), false);
  assert.equal(patternCouldMatchProtectedDomain('*.paypal.com'), true);
  assert.equal(patternCouldMatchProtectedDomain('news.example.com'), false);
});

test('internal unfiltered domains and selector safety helpers remain intact', () => {
  assert.equal(isInternalUnfilteredHostname('app.talondefender.com'), true);
  assert.equal(patternCouldMatchInternalUnfilteredDomain('*.talondefender.com'), true);
  assert.equal(isKnownConsentSelector('#onetrust-banner-sdk'), true);
  assert.equal(isSafeMutationSelector('.cookie-banner'), true);
  assert.equal(isSafeMutationSelector('main'), false);
  assert.equal(isSafeMutationSelector('.page-wrapper'), false);
});

test('remote scriptlet denylist and audit override sanitization remain bounded', () => {
  assert.equal(isRemoteScriptletAllowed('trusted-click-element'), false);
  assert.equal(isRemoteScriptletAllowed('set-attr'), false);
  assert.equal(isRemoteScriptletAllowed('safe-token'), true);

  const overrides = sanitizeBreakageAuditOverrides({
    global: {
      automation: false,
    },
    hosts: {
      'shop.example.com': {
        remoteCosmetics: false,
      },
    },
  });

  assert.deepEqual(AUDITABLE_SUBSYSTEMS, [
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'remoteTactics',
    'postHideCleanup',
  ]);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'remoteCosmetics'), false);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'automation'), false);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'nativeHeuristics'), undefined);
});

test('manifest and public allowlist no longer reference YouTube or Postmedia runtime assets', async () => {
  const manifest = JSON.parse(await readSource('manifest.json'));
  const allowlist = await readSource('public-safe-allowlist.txt');
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const webAccessibleResources = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];

  assert.equal(
    contentScripts.some(entry =>
      Array.isArray(entry.js) &&
      entry.js.some(script => script.includes('youtube-watch'))
    ),
    false
  );
  assert.equal(
    webAccessibleResources.some(entry =>
      Array.isArray(entry.resources) &&
      entry.resources.some(resource => resource.includes('youtube-followup-relay'))
    ),
    false
  );

  assert.equal(allowlist.includes('js/scripting/youtube-watch-sanitizer.js'), false);
  assert.equal(allowlist.includes('js/scripting/youtube-watch-bridge.js'), false);
  assert.equal(allowlist.includes('options/youtube-followup-relay.html'), false);
  assert.equal(allowlist.includes('js/youtube-followup-relay.js'), false);
  assert.equal(allowlist.includes('js/scripting/nationalpost-anti-adblock.js'), false);
  assert.equal(allowlist.includes('js/scripting/financialpost-anti-adblock.js'), false);
  assert.equal(allowlist.includes('js/scripting/financialpost-compatibility.js'), false);
});

test('deleted YouTube and Postmedia runtime files are gone from the workspace', async () => {
  assert.equal(await pathExists('js/scripting/youtube-watch-sanitizer.js'), false);
  assert.equal(await pathExists('js/scripting/youtube-watch-bridge.js'), false);
  assert.equal(await pathExists('js/youtube-followup-relay.js'), false);
  assert.equal(await pathExists('options/youtube-followup-relay.html'), false);
  assert.equal(await pathExists('js/scripting/nationalpost-anti-adblock.js'), false);
  assert.equal(await pathExists('js/scripting/financialpost-anti-adblock.js'), false);
  assert.equal(await pathExists('js/scripting/financialpost-compatibility.js'), false);
});

test('background and policy sources no longer expose YouTube or Postmedia compatibility controls', async () => {
  const backgroundSource = await readSource('js/background.js');
  const policySource = await readSource('js/breakage-policy.js');

  assert.doesNotMatch(backgroundSource, /youtube-watch/i);
  assert.doesNotMatch(backgroundSource, /youtube-followup/i);
  assert.doesNotMatch(backgroundSource, /requestCompatibilityBackoff/);
  assert.doesNotMatch(backgroundSource, /postmedia/i);
  assert.doesNotMatch(policySource, /YOUTUBE_WATCH_/);
  assert.doesNotMatch(policySource, /normalizeYouTubeWatchOwnerProfile/);
  assert.doesNotMatch(policySource, /getScriptletHostExclusions/);
});
