import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { runInjectableRegistrationFlow } from '../js/injectable-registration.js';

test('injectable registration retries once after a failed register and reports recovery', async () => {
  let buildPlanCalls = 0;
  let registerCalls = 0;
  const operations = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => {
      buildPlanCalls += 1;
      return {
        toAdd: [
          { id: 'remote-cosmetics', js: ['/js/scripting/remote-cosmetics.js'] },
        ],
        toRemove: buildPlanCalls === 1 ? ['stale-plan-entry'] : [],
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
  assert.equal(buildPlanCalls, 2);
  assert.deepEqual(operations, [
    { type: 'unregister', ids: ['stale-plan-entry'] },
    { type: 'register', ids: ['remote-cosmetics'] },
    { type: 'unregister', ids: ['stale-registered-a', 'stale-registered-b'] },
    { type: 'register', ids: ['remote-cosmetics'] },
  ]);
});

test('injectable registration surfaces failure after recovery retry is exhausted', async () => {
  let registerCalls = 0;
  const operations = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [
        { id: 'remote-cosmetics', js: ['/js/scripting/remote-cosmetics.js'] },
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
    { type: 'register', ids: ['remote-cosmetics'] },
    { type: 'unregister', ids: ['stale-registered-a'] },
    { type: 'register', ids: ['remote-cosmetics'] },
  ]);
});

test('remote scriptlet registration canonicalizes duplicate entries and scopes ids by world', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /canonicalizeCommunityScriptlets\(remoteScriptlets\)/);
  assert.match(source, /targetHostnames = applyCompatibilityHostExclusions\(/);
  assert.match(source, /remote-scriptlet\.\$\{world\.toLowerCase\(\)\}\.\$\{baseId\}/);
});

test('remote tactics registration uses paired bootstrap and MAIN-world lanes with subsystem suppression', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /const PUBLIC_REMOTE_TACTICS_KEY = 'communityBundlePublicTactics';/);
  assert.match(source, /registerRemoteTactics\(context\)/);
  assert.match(source, /id: 'remote-tactics-bootstrap'/);
  assert.match(source, /id: 'remote-tactics-main'/);
  assert.match(source, /world: 'MAIN'/);
  assert.match(source, /subsystemSuppressionHostnames\?\.remoteTactics/);
});
