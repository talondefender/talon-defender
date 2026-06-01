import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { runInjectableRegistrationFlow } from '../js/injectable-registration.js';
import { shouldReloadForFrameUrls } from '../js/remote-scriptlet-hotfix.js';

test('injectable registration retries once after a failed register and reports recovery', async () => {
  let buildPlanCalls = 0;
  let registerCalls = 0;
  const operations = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => {
      buildPlanCalls += 1;
      return {
        toAdd: [
          {
            id: 'remote-cosmetics-global',
            js: [
              '/js/scripting/remote-cosmetics.js',
              '/js/scripting/remote-cosmetics-global.js',
            ],
          },
          {
            id: 'remote-cosmetics-host',
            js: [
              '/js/scripting/remote-cosmetics.js',
              '/js/scripting/remote-cosmetics-host.js',
            ],
          },
        ],
        toRemove: buildPlanCalls === 1 ? ['stale-plan-entry'] : [],
        remoteScriptletReloadHint: {
          before: [],
          after: [
            {
              id: 'remote-scriptlet.isolated.test-scriptlet',
              matches: ['*://*.example.com/*'],
              excludeMatches: [],
            },
          ],
        },
      };
    },
    listRegistered: async () => [
      { id: 'stale-registered-a' },
      { id: 'stale-registered-b' },
    ],
    unregisterContentScripts: async ids => {
      operations.push({ type: 'unregister', ids: ids.slice() });
    },
    registerContentScripts: async entries => {
      registerCalls += 1;
      operations.push({ type: 'register', ids: entries.map(entry => entry.id) });
      if (registerCalls === 1) {
        throw new Error('first register failed');
      }
    },
    now: () => 123456789,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptedRecovery, true);
  assert.equal(result.recovered, true);
  assert.equal(result.updatedAt, 123456789);
  assert.match(result.initialError, /initial\.registerContentScripts: first register failed/);
  assert.equal(result.lastError, '');
  assert.equal(result.recoveryResetCount, 2);
  assert.deepEqual(result.remoteScriptletReloadHint, {
    before: [],
    after: [
      {
        id: 'remote-scriptlet.isolated.test-scriptlet',
        matches: ['*://*.example.com/*'],
        excludeMatches: [],
      },
    ],
  });
  assert.equal(buildPlanCalls, 2);
  assert.deepEqual(operations, [
    { type: 'unregister', ids: ['stale-plan-entry'] },
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
    { type: 'unregister', ids: ['stale-registered-a', 'stale-registered-b'] },
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
  ]);
});

test('injectable registration surfaces failure after recovery retry is exhausted', async () => {
  let registerCalls = 0;
  const operations = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [
        {
          id: 'remote-cosmetics-global',
          js: [
            '/js/scripting/remote-cosmetics.js',
            '/js/scripting/remote-cosmetics-global.js',
          ],
        },
        {
          id: 'remote-cosmetics-host',
          js: [
            '/js/scripting/remote-cosmetics.js',
            '/js/scripting/remote-cosmetics-host.js',
          ],
        },
      ],
      toRemove: [],
    }),
    listRegistered: async () => [
      { id: 'stale-registered-a' },
    ],
    unregisterContentScripts: async ids => {
      operations.push({ type: 'unregister', ids: ids.slice() });
    },
    registerContentScripts: async entries => {
      registerCalls += 1;
      operations.push({ type: 'register', ids: entries.map(entry => entry.id) });
      throw new Error(`register failed ${registerCalls}`);
    },
    now: () => 987654321,
  });

  assert.equal(result.ok, false);
  assert.equal(result.attemptedRecovery, true);
  assert.equal(result.recovered, false);
  assert.equal(result.updatedAt, 987654321);
  assert.match(result.initialError, /initial\.registerContentScripts: register failed 1/);
  assert.match(result.lastError, /recovery\.registerContentScripts: register failed 2/);
  assert.equal(result.recoveryResetCount, 1);
  assert.deepEqual(operations, [
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
    { type: 'unregister', ids: ['stale-registered-a'] },
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
  ]);
});

test('injectable registration recovers after a timed-out register call', async () => {
  let registerCalls = 0;
  const operations = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [
        {
          id: 'remote-cosmetics-global',
          js: [
            '/js/scripting/remote-cosmetics.js',
            '/js/scripting/remote-cosmetics-global.js',
          ],
        },
      ],
      toRemove: [],
    }),
    listRegistered: async () => [],
    unregisterContentScripts: async ids => {
      operations.push({ type: 'unregister', ids: ids.slice() });
    },
    registerContentScripts: async entries => {
      registerCalls += 1;
      operations.push({ type: 'register', ids: entries.map(entry => entry.id) });
      if (registerCalls === 1) {
        return await new Promise(() => {});
      }
    },
    operationTimeoutMs: 10,
    now: () => 24681012,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptedRecovery, true);
  assert.equal(result.recovered, true);
  assert.equal(result.updatedAt, 24681012);
  assert.match(result.initialError, /initial\.registerContentScripts: initial\.registerContentScripts timed out after 10ms/);
  assert.equal(result.lastError, '');
  assert.equal(result.recoveryResetCount, 0);
  assert.deepEqual(operations, [
    { type: 'register', ids: ['remote-cosmetics-global'] },
    { type: 'register', ids: ['remote-cosmetics-global'] },
  ]);
});

test('remote scriptlet reload hints match open-tab frame URLs safely', () => {
  const hint = {
    before: [
      {
        id: 'remote-scriptlet.isolated.before-scriptlet',
        matches: ['*://*.example.com/*'],
        excludeMatches: ['*://www.example.com/*'],
      },
    ],
    after: [
      {
        id: 'remote-scriptlet.main.after-scriptlet',
        matches: ['https://www.example.org/*'],
        excludeMatches: [],
      },
    ],
  };

  assert.equal(shouldReloadForFrameUrls(['https://example.com/frame.html'], hint), true);
  assert.equal(shouldReloadForFrameUrls(['https://www.example.com/dashboard'], hint), false);
  assert.equal(shouldReloadForFrameUrls(['https://www.example.org/embed'], hint), true);
  assert.equal(shouldReloadForFrameUrls(['chrome-extension://abcdef/popup.html'], hint), false);
});

test('remote scriptlet registration canonicalizes duplicate entries and scopes ids by world', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /canonicalizeCommunityScriptlets\(remoteScriptlets\)/);
  assert.match(source, /remote-scriptlet\.\$\{world\.toLowerCase\(\)\}\.\$\{baseId\}/);
});

test('public injectable registration does not include remote tactics lanes', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /PUBLIC_REMOTE_TACTICS_KEY/);
  assert.doesNotMatch(source, /registerRemoteTactics\(context\)/);
  assert.doesNotMatch(source, /remote-tactics-bootstrap/);
  assert.doesNotMatch(source, /remote-tactics-main/);
  assert.doesNotMatch(source, /communityBundlePublicTactics/);
});

test('remote cosmetics registration splits broad and host-gated lanes', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );
  const remoteCosmeticsStart = source.indexOf('function registerRemoteCosmetics(context) {');
  const remoteCosmeticsEnd = source.indexOf('/******************************************************************************/', remoteCosmeticsStart);
  const remoteCosmeticsSource = source.slice(remoteCosmeticsStart, remoteCosmeticsEnd);

  assert.match(source, /const PUBLIC_REMOTE_COSMETICS_KEY = 'communityBundleCosmetics';/);
  assert.match(source, /const TALON_BLOCK_HINTS_PATH = '\/js\/scripting\/block-hints\.js';/);
  assert.match(source, /id: 'remote-cosmetics-global'/);
  assert.match(source, /id: 'remote-cosmetics-host'/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-global\.js/);
  assert.match(source, /\/js\/scripting\/remote-cosmetics-host\.js/);
  assert.match(remoteCosmeticsSource, /collectRegisteredRemoteCosmeticHostnames\(/);
  assert.match(remoteCosmeticsSource, /const hostMatches = exactMatchesFromHostnames\(targetHostnames\);/);
  assert.equal(remoteCosmeticsSource.includes("id: 'remote-cosmetics'"), false);
});

test('scripting manager registers only the Talon-owned YouTube lanes, not old compatibility lanes', async () => {
  const watchPrefix = 'youtube' + '-watch';
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip'/);
  assert.match(source, /TALON_YOUTUBE_AD_SKIP_PATH = '\/js\/scripting\/youtube-ad-skip\.js'/);
  assert.match(source, /TALON_YOUTUBE_PLAYER_GUARD_ID = 'talon-youtube-player-guard'/);
  assert.match(source, /TALON_YOUTUBE_PLAYER_GUARD_PATH = '\/js\/scripting\/youtube-player-guard\.js'/);
  assert.match(source, /function registerYouTubePlayerGuard\(context\)/);
  assert.match(source, /registerYouTubePlayerGuard\(context\)/);
  assert.match(source, /world: 'MAIN'/);
  assert.match(source, /function registerYouTubeAdSkip\(context\)/);
  assert.match(source, /registerYouTubeAdSkip\(context\)/);
  assert.match(source, /getScriptletExcludedHostnames/);
  assert.doesNotMatch(source, /applyCompatibilityHostExclusions/);
  assert.doesNotMatch(source, /youtubeWatchOwnerProfile/);
  assert.doesNotMatch(source, new RegExp(`${watchPrefix}-bootstrap|registerYouTubeWatchBootstrap`));
  assert.doesNotMatch(source, /TALON_NATIONALPOST_ANTI_ADBLOCK_PATH/);
  assert.doesNotMatch(source, /TALON_FINANCIALPOST_COMPATIBILITY_PATH/);
  assert.doesNotMatch(source, /TALON_FINANCIALPOST_ANTI_ADBLOCK_PATH/);
  assert.doesNotMatch(source, /registerNationalPostAntiAdblock/);
  assert.doesNotMatch(source, /registerFinancialPostCompatibility/);
  assert.doesNotMatch(source, /registerFinancialPostAntiAdblock/);
});
