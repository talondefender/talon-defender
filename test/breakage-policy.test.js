import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  AUDITABLE_SUBSYSTEMS,
  classifyProtectedSurface,
  getRemoteAutomationRegistrationMatches,
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

test('remote automation registration stays within directive and filtering scopes', () => {
  const directive = (hosts, requiresRulesets) => ({
    id: 'remote-test',
    action: 'hide',
    hosts,
    selectors: ['.remote-popup'],
    requiresRulesets,
  });

  assert.deepEqual(getRemoteAutomationRegistrationMatches(
    [directive(['=news.example.com', '*.offers.example', 'invalid.*'])],
    new Set(),
    {
      optimal: new Set(['all-urls']),
      complete: new Set(),
    }
  ), [
    '*://*.offers.example/*',
    '*://news.example.com/*',
  ]);

  assert.deepEqual(getRemoteAutomationRegistrationMatches(
    [directive(['example.com'])],
    new Set(),
    {
      optimal: new Set(['shop.example.com']),
      complete: new Set(),
    }
  ), [ '*://*.shop.example.com/*' ]);

  assert.deepEqual(getRemoteAutomationRegistrationMatches(
    [directive(['example.*'])],
    new Set(),
    {
      optimal: new Set(['example.co.jp']),
      complete: new Set(),
    }
  ), [ '*://example.co.jp/*' ]);

  assert.deepEqual(getRemoteAutomationRegistrationMatches(
    [directive(['=news.example.com'], ['annoyances-overlays'])],
    new Set(),
    {
      optimal: new Set(['all-urls']),
      complete: new Set(),
    }
  ), []);
});

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
    'adShellStyles',
    'nativeHeuristics',
    'automation',
    'remoteCosmetics',
    'postHideCleanup',
    'youtubeAdSkip',
  ]);
  assert.equal(resolveAuditOverride(overrides, 'shop.example.com', 'remoteCosmetics'), false);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'automation'), false);
  assert.equal(resolveAuditOverride(overrides, 'news.example.com', 'nativeHeuristics'), undefined);
});

test('manifest and public allowlist expose bounded static runtime bootstrap lanes', async () => {
  const watchPrefix = 'youtube' + '-watch';
  const relayHtmlPath = `web_accessible_resources/${watchPrefix}-relay.html`;
  const relayScriptPath = `web_accessible_resources/${watchPrefix}-relay.js`;
  const bootstrapPath = `js/scripting/${watchPrefix}-bootstrap.js`;
  const talonYouTubePath = 'js/scripting/youtube-ad-skip.js';
  const talonYouTubeGuardPath = 'js/scripting/youtube-player-guard.js';
  const talonYouTubeGuardLoaderPath = 'js/scripting/youtube-player-guard-loader.js';
  const frenchStreamMainSiteFixPath = 'rulesets/scripting/scriptlet/main/talon-site-fixes.js';
  const manifest = JSON.parse(await readSource('manifest.json'));
  const allowlist = await readSource('public-safe-allowlist.txt');
  const scriptingManager = await readSource('js/scripting-manager.js');
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const webAccessibleResources = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];

  assert.equal(
    contentScripts.some(entry =>
      Array.isArray(entry.js) &&
      entry.js.some(script => script.includes(watchPrefix))
    ),
    false
  );
  const youtubeGuardMainScripts = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(talonYouTubeGuardPath)
  );
  assert.equal(youtubeGuardMainScripts.length, 0);
  const youtubeGuardLoaders = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(talonYouTubeGuardLoaderPath)
  );
  assert.equal(youtubeGuardLoaders.length, 0);
  assert.equal(
    contentScripts.some(entry =>
      Array.isArray(entry.js) &&
      entry.js.includes(talonYouTubePath)
    ),
    false
  );
  const frenchStreamMainScripts = contentScripts.filter(entry =>
    Array.isArray(entry.js) &&
    entry.js.includes(frenchStreamMainSiteFixPath)
  );
  assert.equal(frenchStreamMainScripts.length, 0);
  assert.match(scriptingManager, /const TALON_SITE_FIXES_MAIN_ID = 'talon-site-fixes-main';/);
  assert.match(scriptingManager, /function registerTalonSiteFixesMain\(context\)/);
  assert.match(scriptingManager, /id: TALON_SITE_FIXES_MAIN_ID,[\s\S]*allFrames: true,[\s\S]*runAt: 'document_start',[\s\S]*world: 'MAIN'/);
  const youtubeGuardResources = webAccessibleResources.filter(entry =>
    Array.isArray(entry.resources) &&
    entry.resources.includes(talonYouTubeGuardPath)
  );
  assert.equal(youtubeGuardResources.length, 0);
  assert.equal(
    webAccessibleResources.some(entry =>
      Array.isArray(entry.resources) &&
      entry.resources.some(resource =>
        /youtube/i.test(resource) && resource !== talonYouTubeGuardPath
      )
    ),
    false
  );
  assert.equal(
    webAccessibleResources.some(entry =>
      Array.isArray(entry.resources) &&
      (
        entry.resources.includes(frenchStreamMainSiteFixPath)
      )
    ),
    false
  );

  assert.equal(allowlist.includes(talonYouTubePath), true);
  assert.equal(allowlist.includes(talonYouTubeGuardPath), true);
  assert.equal(allowlist.includes(talonYouTubeGuardLoaderPath), false);
  assert.equal(allowlist.includes(frenchStreamMainSiteFixPath), true);
  assert.equal(allowlist.includes(bootstrapPath), false);
  assert.equal(allowlist.includes(relayHtmlPath), false);
  assert.equal(allowlist.includes(relayScriptPath), false);
  assert.equal(allowlist.includes(`js/scripting/${watchPrefix}-sanitizer.js`), false);
  assert.equal(allowlist.includes(`js/scripting/${watchPrefix}-bridge.js`), false);
  assert.equal(allowlist.includes('options/youtube-followup-relay.html'), false);
  assert.equal(allowlist.includes('js/youtube-followup-relay.js'), false);
  assert.equal(allowlist.includes('js/scripting/nationalpost-anti-adblock.js'), false);
  assert.equal(allowlist.includes('js/scripting/financialpost-anti-adblock.js'), false);
  assert.equal(allowlist.includes('js/scripting/financialpost-compatibility.js'), false);
});

test('deleted YouTube relay and Postmedia runtime files are gone from the workspace', async () => {
  const watchPrefix = 'youtube' + '-watch';

  assert.equal(await pathExists('js/scripting/youtube-ad-skip.js'), true);
  assert.equal(await pathExists('js/scripting/youtube-player-guard.js'), true);
  assert.equal(await pathExists(`js/scripting/${watchPrefix}-bootstrap.js`), false);
  assert.equal(await pathExists(`web_accessible_resources/${watchPrefix}-relay.html`), false);
  assert.equal(await pathExists(`web_accessible_resources/${watchPrefix}-relay.js`), false);
  assert.equal(await pathExists(`js/scripting/${watchPrefix}-sanitizer.js`), false);
  assert.equal(await pathExists(`js/scripting/${watchPrefix}-bridge.js`), false);
  assert.equal(await pathExists('js/youtube-followup-relay.js'), false);
  assert.equal(await pathExists('options/youtube-followup-relay.html'), false);
  assert.equal(await pathExists('js/scripting/nationalpost-anti-adblock.js'), false);
  assert.equal(await pathExists('js/scripting/financialpost-anti-adblock.js'), false);
  assert.equal(await pathExists('js/scripting/financialpost-compatibility.js'), false);
});

test('background and policy sources no longer expose old YouTube or Postmedia compatibility controls', async () => {
  const backgroundSource = await readSource('js/background.js');
  const policySource = await readSource('js/breakage-policy.js');

  assert.doesNotMatch(backgroundSource, new RegExp(`setYouTubeWatch|YouTubeWatch|${'youtube' + '-watch'}`, 'i'));
  assert.doesNotMatch(backgroundSource, /youtube-followup/i);
  assert.doesNotMatch(backgroundSource, /requestCompatibilityBackoff/);
  assert.doesNotMatch(backgroundSource, /postmedia/i);
  assert.doesNotMatch(policySource, new RegExp(`${'YOUTUBE_' + 'WATCH'}_`));
  assert.doesNotMatch(policySource, /normalizeYouTubeWatchOwnerProfile/);
  assert.doesNotMatch(policySource, /getScriptletHostExclusions/);
});
