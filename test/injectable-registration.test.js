import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
    contentScriptRegistrationsEqual,
    isPackagedStaticScriptletRegistration,
    recordPackagedStaticScriptletReloadTransition,
    runInjectableRegistrationFlow,
    unregisterAndVerifyManagedRegistrations,
} from '../js/injectable-registration.js';
import {
  mergeRemoteScriptletReloadHints,
  normalizeRemoteScriptletReloadHint,
  shouldReloadForFrameUrls,
} from '../js/remote-scriptlet-hotfix.js';

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
        toRemove: ['stale-plan-entry'],
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
    updateContentScripts: async entries => {
      operations.push({ type: 'update', ids: entries.map(entry => entry.id) });
    },
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
  assert.equal(result.recoveryResetCount, 0);
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
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
    { type: 'unregister', ids: ['stale-plan-entry'] },
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
    updateContentScripts: async entries => {
      operations.push({ type: 'update', ids: entries.map(entry => entry.id) });
    },
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
  assert.equal(result.recoveryResetCount, 0);
  assert.deepEqual(operations, [
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
    { type: 'register', ids: ['remote-cosmetics-global', 'remote-cosmetics-host'] },
  ]);
});

test('managed registration cleanup unregisters and verifies the final API state', async () => {
  let registrations = [
    { id: 'managed-b' },
    { id: 'unmanaged', owner: 'other' },
    { id: 'managed-a' },
  ];
  const calls = [];

  const result = await unregisterAndVerifyManagedRegistrations({
    listRegistrations: async () => registrations.slice(),
    unregisterRegistrations: async ids => {
      calls.push(ids.slice());
      registrations = registrations.filter(entry => ids.includes(entry.id) === false);
    },
    isManaged: entry => entry.owner !== 'other',
    label: 'content scripts',
  });

  assert.deepEqual(result, {
    ok: true,
    attempts: 1,
    removedIds: ['managed-a', 'managed-b'],
  });
  assert.deepEqual(calls, [['managed-a', 'managed-b']]);
  assert.deepEqual(registrations, [{ id: 'unmanaged', owner: 'other' }]);
});

test('managed registration cleanup propagates unregister API failures', async () => {
  await assert.rejects(
    unregisterAndVerifyManagedRegistrations({
      listRegistrations: async () => [{ id: 'managed-a' }],
      unregisterRegistrations: async () => {
        throw new Error('Chrome unregister failed');
      },
      label: 'content scripts',
    }),
    /Chrome unregister failed/
  );
});

test('managed registration cleanup retries a stale read then rejects unremoved state', async () => {
  let unregisterCalls = 0;
  await assert.rejects(
    unregisterAndVerifyManagedRegistrations({
      listRegistrations: async () => [{ id: 'still-managed' }],
      unregisterRegistrations: async () => { unregisterCalls += 1; },
      label: 'user scripts',
      maxAttempts: 2,
    }),
    /user scripts cleanup verification failed: still-managed/
  );
  assert.equal(unregisterCalls, 2);
});

test('managed registration cleanup rejects unverifiable API responses', async () => {
  await assert.rejects(
    unregisterAndVerifyManagedRegistrations({
      listRegistrations: async () => undefined,
      unregisterRegistrations: async () => {},
      label: 'content scripts',
    }),
    /content scripts preflight returned invalid state/
  );
});

test('injectable registration does not race recovery after a timed-out register call', async () => {
  let registerCalls = 0;
  let listCalls = 0;
  let resolveTimedOutCall;
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
    listRegistered: async () => {
      listCalls += 1;
      return [];
    },
    updateContentScripts: async entries => {
      operations.push({ type: 'update', ids: entries.map(entry => entry.id) });
    },
    unregisterContentScripts: async ids => {
      operations.push({ type: 'unregister', ids: ids.slice() });
    },
    registerContentScripts: async entries => {
      registerCalls += 1;
      operations.push({ type: 'register', ids: entries.map(entry => entry.id) });
      return await new Promise(resolve => {
        resolveTimedOutCall = resolve;
      });
    },
    operationTimeoutMs: 10,
    now: () => 24681012,
  });

  assert.equal(result.ok, false);
  assert.equal(result.attemptedRecovery, false);
  assert.equal(result.recovered, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.updatedAt, 24681012);
  assert.equal(result.initialError, '');
  assert.match(result.lastError, /timed out after 10ms/);
  assert.equal(result.recoveryResetCount, 0);
  assert.equal(listCalls, 0);
  assert.deepEqual(operations, [
    { type: 'register', ids: ['remote-cosmetics-global'] },
  ]);
  resolveTimedOutCall();
  await new Promise(resolve => setImmediate(resolve));
});

test('registration mutation journal is durable before update and clears only after verification', async () => {
  const events = [];
  let journalPending = false;
  let registered = {
    id: 'existing-protection',
    js: ['/old.js'],
    matches: ['<all_urls>'],
  };

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [{
        id: 'existing-protection',
        js: ['/new.js'],
        matches: ['<all_urls>'],
      }],
      toRemove: ['existing-protection'],
    }),
    listRegistered: async () => [registered],
    updateContentScripts: async entries => {
      events.push('update');
      assert.equal(journalPending, true);
      registered = entries[0];
    },
    unregisterContentScripts: async () => {
      assert.fail('an in-place update must not unregister the registration');
    },
    registerContentScripts: async () => {
      assert.fail('an in-place update must not register a duplicate id');
    },
    registrationMutationJournal: {
      async recover() {
        events.push('recover');
        return false;
      },
      async mark(details) {
        events.push(
          `mark:${details.toAddCount}/${details.toUpdateCount}/${details.toRemoveCount}`
        );
        journalPending = true;
      },
      async verify() {
        events.push('verify');
        assert.equal(journalPending, true);
        return registered.js[0] === '/new.js';
      },
      async clear() {
        events.push('clear');
        assert.equal(registered.js[0], '/new.js');
        journalPending = false;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(journalPending, false);
  assert.deepEqual(events, [
    'recover',
    'mark:0/1/0',
    'update',
    'verify',
    'clear',
  ]);
});

test('registration mutation journal remains pending when desired state cannot be verified', async () => {
  let journalPending = false;
  let clearCalls = 0;

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [{
        id: 'new-protection',
        js: ['/new.js'],
        matches: ['<all_urls>'],
      }],
      toRemove: [],
    }),
    listRegistered: async () => [],
    updateContentScripts: async () => {},
    unregisterContentScripts: async () => {},
    registerContentScripts: async () => {
      assert.equal(journalPending, true);
    },
    registrationMutationJournal: {
      async recover() { return false; },
      async mark() { journalPending = true; },
      async verify() { return false; },
      async clear() {
        clearCalls += 1;
        journalPending = false;
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.lastError, /desired state mismatch/);
  assert.equal(journalPending, true);
  assert.equal(clearCalls, 0);
});

test('crash journal cancels a hidden pending registration before rebuilding desired state', async () => {
  const desired = [{
    id: 'next-protection',
    js: ['/next.js'],
    matches: ['<all_urls>'],
  }];
  const events = [];
  let journalPending = true;
  let oldPendingRegistration = true;
  let registered = [];

  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => {
      events.push('rebuild-desired');
      return {
        toAdd: desired.filter(entry =>
          registered.some(current => current.id === entry.id) === false
        ),
        toRemove: registered
          .filter(entry => desired.some(wanted => wanted.id === entry.id) === false)
          .map(entry => entry.id),
      };
    },
    listRegistered: async () => registered.slice(),
    updateContentScripts: async entries => {
      for (const entry of entries) {
        registered = registered.filter(current => current.id !== entry.id);
        registered.push(entry);
      }
    },
    unregisterContentScripts: async ids => {
      registered = registered.filter(entry => ids.includes(entry.id) === false);
    },
    registerContentScripts: async entries => {
      events.push('register-desired');
      assert.equal(journalPending, true);
      registered.push(...entries);
    },
    registrationMutationJournal: {
      async recover() {
        events.push('unregister-all-loaded-and-pending');
        assert.equal(journalPending, true);
        registered = [];
        oldPendingRegistration = false;
        return true;
      },
      async mark() {
        events.push('mark');
        journalPending = true;
      },
      async verify() {
        events.push('verify');
        return registered.length === 1 &&
          registered[0].id === 'next-protection';
      },
      async clear() {
        events.push('clear');
        journalPending = false;
      },
    },
  });

  // Simulate the old worker's delayed completion. The unfiltered recovery
  // removed its pending ID, so Chrome must not commit it after reconciliation.
  if (oldPendingRegistration) {
    registered.push({ id: 'stale-after-crash' });
  }

  assert.equal(result.ok, true);
  assert.equal(result.attemptedRecovery, true);
  assert.equal(result.recovered, true);
  assert.equal(result.recoveryResetCount, 1);
  assert.equal(journalPending, false);
  assert.deepEqual(registered.map(entry => entry.id), ['next-protection']);
  assert.deepEqual(events, [
    'unregister-all-loaded-and-pending',
    'rebuild-desired',
    'mark',
    'register-desired',
    'verify',
    'clear',
  ]);
});

test('injectable registration updates matching ids in place', async () => {
  const operations = [];
  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [{
        id: 'prevent-popup',
        js: ['/js/scripting/prevent-popup.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
      }],
      toRemove: ['prevent-popup'],
    }),
    listRegistered: async () => [],
    updateContentScripts: async entries => {
      operations.push({ type: 'update', entries });
    },
    registerContentScripts: async entries => {
      operations.push({ type: 'register', entries });
    },
    unregisterContentScripts: async ids => {
      operations.push({ type: 'unregister', ids });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.toAddCount, 0);
  assert.equal(result.toUpdateCount, 1);
  assert.equal(result.toRemoveCount, 0);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].type, 'update');
  assert.deepEqual(operations[0].entries[0].excludeMatches, []);
  assert.deepEqual(operations[0].entries[0].css, []);
  assert.equal(operations[0].entries[0].allFrames, false);
  assert.equal(operations[0].entries[0].persistAcrossSessions, true);
  assert.equal(operations[0].entries[0].world, 'ISOLATED');
});

test('injectable registration adds protection before removing obsolete scripts', async () => {
  const operations = [];
  const result = await runInjectableRegistrationFlow({
    buildPlan: async () => ({
      toAdd: [{ id: 'new-protection', js: ['/new.js'], matches: ['<all_urls>'] }],
      toRemove: ['obsolete-protection'],
    }),
    listRegistered: async () => [],
    updateContentScripts: async () => {},
    registerContentScripts: async entries => {
      operations.push(`register:${entries[0].id}`);
    },
    unregisterContentScripts: async ids => {
      operations.push(`unregister:${ids[0]}`);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(operations, [
    'register:new-protection',
    'unregister:obsolete-protection',
  ]);
});

test('content script equality covers defaults, path normalization, and behavioral fields', () => {
  const registered = {
    id: 'example',
    js: ['js/example.js'],
    matches: ['https://www.example.com/*', 'https://example.com/*'],
    excludeMatches: [],
    allFrames: false,
    matchOriginAsFallback: false,
    persistAcrossSessions: true,
    runAt: 'document_start',
    world: 'ISOLATED',
  };
  const desired = {
    id: 'example',
    js: ['/js/example.js'],
    matches: ['https://example.com/*', 'https://www.example.com/*'],
    runAt: 'document_start',
  };

  assert.equal(contentScriptRegistrationsEqual(registered, desired), true);
  assert.equal(contentScriptRegistrationsEqual(registered, {
    ...desired,
    runAt: 'document_idle',
  }), false);
  assert.equal(contentScriptRegistrationsEqual(registered, {
    ...desired,
    matchOriginAsFallback: true,
  }), false);
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

test('enabling a packaged static scriptlet records matching live documents for reload', () => {
  const directive = {
    id: 'annoyances-overlays.main',
    js: ['/rulesets/scripting/scriptlet/main/annoyances-overlays.js'],
    matches: ['*://*.example.com/*'],
    excludeMatches: ['*://account.example.com/*'],
  };
  const hint = { before: [], after: [] };

  assert.equal(isPackagedStaticScriptletRegistration(directive), true);
  assert.equal(
    recordPackagedStaticScriptletReloadTransition(
      hint,
      undefined,
      directive
    ),
    true
  );
  const normalized = normalizeRemoteScriptletReloadHint(hint);
  assert.deepEqual(normalized, {
    before: [],
    after: [{
      id: 'annoyances-overlays.main',
      matches: ['*://*.example.com/*'],
      excludeMatches: ['*://account.example.com/*'],
    }],
  });
  assert.equal(
    shouldReloadForFrameUrls(['https://www.example.com/article'], normalized),
    true
  );
  assert.equal(
    shouldReloadForFrameUrls([['https', '://', 'account.example.com', '/'].join('')], normalized),
    false
  );
});

test('disabling a packaged static scriptlet records old matches and excludes Talon YouTube lanes', () => {
  const directive = {
    id: 'annoyances-overlays.isolated',
    js: ['/rulesets/scripting/scriptlet/isolated/annoyances-overlays.js'],
    matches: ['*://*.example.com/*'],
    excludeMatches: [],
  };
  const talonYouTubeLane = {
    id: 'talon-youtube-ad-skip',
    js: ['/js/scripting/youtube-ad-skip.js'],
    matches: ['*://*.youtube.com/*'],
    excludeMatches: [],
  };
  const hint = { before: [], after: [] };

  assert.equal(
    recordPackagedStaticScriptletReloadTransition(
      hint,
      directive,
      undefined
    ),
    true
  );
  assert.equal(
    recordPackagedStaticScriptletReloadTransition(
      hint,
      talonYouTubeLane,
      undefined
    ),
    false
  );
  const normalized = normalizeRemoteScriptletReloadHint(hint);
  assert.deepEqual(normalized, {
    before: [{
      id: 'annoyances-overlays.isolated',
      matches: ['*://*.example.com/*'],
      excludeMatches: [],
    }],
    after: [],
  });
  assert.equal(
    shouldReloadForFrameUrls(['https://www.example.com/'], normalized),
    true
  );
});

test('Talon site-fixes MAIN registration participates in the static scriptlet reload ledger', () => {
  const directive = {
    id: 'talon-site-fixes-main',
    js: ['/rulesets/scripting/scriptlet/main/talon-site-fixes.js'],
    matches: ['*://french-stream.one/*'],
    excludeMatches: [],
  };
  const hint = { before: [], after: [] };

  assert.equal(
    recordPackagedStaticScriptletReloadTransition(hint, undefined, directive),
    true
  );
  assert.deepEqual(normalizeRemoteScriptletReloadHint(hint), {
    before: [],
    after: [{
      id: 'talon-site-fixes-main',
      matches: ['*://french-stream.one/*'],
      excludeMatches: [],
    }],
  });
  assert.equal(
    shouldReloadForFrameUrls([['https', '://', 'french-stream.one', '/watch'].join('')], hint),
    true
  );
});

test('remote scriptlet registration canonicalizes duplicate entries and scopes ids by world', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /canonicalizeCommunityScriptlets\(remoteScriptlets\)/);
  assert.match(source, /remote-scriptlet\.\$\{world\.toLowerCase\(\)\}\.\$\{baseId\}/);
});

test('packaged static scriptlet registration wires add, update, and removal reload hints', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );
  const registerStart = source.indexOf('function registerScriptlet(context');
  const registerEnd = source.indexOf(
    '/******************************************************************************/',
    registerStart
  );
  const registerSource = source.slice(registerStart, registerEnd);
  const removalStart = source.indexOf('for ( const [id, entry] of before )');
  const removalSource = source.slice(
    removalStart,
    source.indexOf('toRemove.push(...Array.from(before.keys()))', removalStart)
  );

  assert.match(
    registerSource,
    /recordPackagedStaticScriptletReloadTransition\([\s\S]*undefined,[\s\S]*directive/
  );
  assert.match(
    registerSource,
    /recordPackagedStaticScriptletReloadTransition\([\s\S]*registered,[\s\S]*directive/
  );
  assert.match(
    removalSource,
    /recordPackagedStaticScriptletReloadTransition\([\s\S]*entry,[\s\S]*undefined/
  );
  const reconcileStart = source.indexOf('const reconcileContentScript');
  const reconcileSource = source.slice(
    reconcileStart,
    source.indexOf('/******************************************************************************/', reconcileStart)
  );
  assert.match(
    reconcileSource,
    /recordPackagedStaticScriptletReloadTransition\([\s\S]*directive/
  );
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

test('scripting manager wires the durable journal to unfiltered pending-id recovery', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /contentScriptRegistrationMutationJournalV1/
  );
  assert.match(
    source,
    /await browser\.scripting\.unregisterContentScripts\(\);/
  );
  assert.match(
    source,
    /registrationMutationJournal,\s*operationTimeoutMs:/
  );
  assert.match(
    source,
    /const plan = await buildInjectablesRegistrationPlan\(\);\s*return registrationPlanHasMutations\(plan\) === false;/
  );
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

test('successive remote scriptlet reload hints retain every unprocessed generation', () => {
  const hint = mergeRemoteScriptletReloadHints(
    {
      before: [{
        id: 'remote-scriptlet.old',
        matches: ['*://old.example.test/*'],
        excludeMatches: [],
      }],
      after: [{
        id: 'remote-scriptlet.middle',
        matches: ['*://middle.example/*'],
        excludeMatches: [],
      }],
    },
    {
      before: [{
        id: 'remote-scriptlet.middle',
        matches: ['*://middle.example/*'],
        excludeMatches: [],
      }],
      after: [{
        id: 'remote-scriptlet.new',
        matches: ['*://new.example/*'],
        excludeMatches: [],
      }],
    }
  );

  assert.deepEqual(
    hint.before.map(entry => entry.id),
    ['remote-scriptlet.old', 'remote-scriptlet.middle']
  );
  assert.deepEqual(
    hint.after.map(entry => entry.id),
    ['remote-scriptlet.middle', 'remote-scriptlet.new']
  );
  assert.equal(shouldReloadForFrameUrls(
    [['https', '://', 'old.example.test', '/'].join('')],
    hint
  ), true);
});

test('popup prevention reconciles an identical existing registration without churn', async () => {
  const source = await fs.readFile(
    new URL('../js/prevent-popup.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /contentScriptRegistrationsEqual/);
  assert.match(source, /context\.before\.get\(directive\.id\)/);
  assert.match(source, /context\.before\.delete\(directive\.id\)/);
  assert.match(source, /contentScriptRegistrationsEqual\(registered, directive\) === false/);
});

test('injectable manager omits the unshipped generic-high lane', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /function registerHighGeneric/);
  assert.doesNotMatch(source, /readActiveAutoGenericHighHosts/);
  assert.doesNotMatch(source, /registerHighGeneric\(context/);
  assert.doesNotMatch(source, /rulesets\/scripting\/generichigh/);
});

test('packaged cosmetic data failures preserve last-good state and remain retryable', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );
  const prepareStart = source.indexOf('const prepareSpecificCosmeticData');
  const prepareEnd = source.indexOf('/******************************************************************************/', prepareStart);
  const prepareSource = source.slice(prepareStart, prepareEnd);

  assert.match(prepareSource, /isValidSpecificCosmeticData\(data\) === false/);
  assert.match(prepareSource, /throw new TypeError\(`Invalid specific cosmetic data:/);
  assert.match(source, /resourceDetailPromises\.delete\(key\)/);
});

test('French Stream MAIN fix is dynamic, ruleset-gated, and allowlist-aware', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('function registerTalonSiteFixesMain');
  const end = source.indexOf('/******************************************************************************/', start);
  const block = source.slice(start, end);

  assert.notEqual(start, -1);
  assert.match(block, /details\.id === 'talon-site-fixes'/);
  assert.match(source, /if \( rulesetId === 'talon-site-fixes' \) \{ continue; \}/);
  assert.match(block, /modeSetCoversHostname\(none, 'french-stream\.one'\)/);
  assert.match(block, /id: TALON_SITE_FIXES_MAIN_ID/);
  assert.match(block, /js: \[ TALON_SITE_FIXES_MAIN_PATH \]/);
  assert.match(block, /allFrames: true/);
  assert.match(block, /runAt: 'document_start'/);
  assert.match(block, /world: 'MAIN'/);
  for (const hostname of [
    'french-stream.one',
    'fsvid.lol',
    'kakaflix.lol',
    'uqload.is',
    'vidzy.cc',
  ]) {
    assert.match(source, new RegExp(hostname.replace('.', '\\.')));
  }
});

test('heavy Talon controllers avoid inherited-frame fallback registrations', async () => {
  const source = await fs.readFile(
    new URL('../js/scripting-manager.js', import.meta.url),
    'utf8'
  );
  const registrationSource = id => {
    const marker = `id: '${id}'`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing ${id} registration`);
    return source.slice(start, source.indexOf('};', start) + 2);
  };

  for (const id of [
    'native-heuristics',
    'automation',
    'ad-shell-styles',
    'post-hide-cleanup',
  ]) {
    const block = registrationSource(id);
    assert.match(block, /allFrames: false/);
    assert.doesNotMatch(block, /matchOriginAsFallback/);
  }
  for (const id of ['remote-cosmetics-global', 'remote-cosmetics-host']) {
    const block = registrationSource(id);
    assert.match(block, /allFrames: true/);
    assert.match(block, /matchOriginAsFallback: true/);
  }
});

test('filtering-mode setters short-circuit exact no-ops before durable writes', async () => {
  const source = await fs.readFile(
    new URL('../js/mode-manager.js', import.meta.url),
    'utf8'
  );
  const detailsStart = source.indexOf('export function setFilteringModeDetails');
  const modeStart = source.indexOf('export function setFilteringMode(hostname');
  const detailsBlock = source.slice(detailsStart, modeStart);
  const modeBlock = source.slice(
    modeStart,
    source.indexOf('/******************************************************************************/', modeStart)
  );

  assert.match(detailsBlock, /modeDetailsEqual\(beforeEffectiveModes, desiredEffectiveModes\)/);
  assert.ok(
    detailsBlock.indexOf('modeDetailsEqual(beforeEffectiveModes') <
      detailsBlock.indexOf('writeFilteringModeDetailsNow(afterUserModes)')
  );
  assert.match(modeBlock, /if \( beforeLevel === afterLevel \) \{ return beforeLevel; \}/);
  assert.ok(
    modeBlock.indexOf('beforeLevel === afterLevel') <
      modeBlock.indexOf('writeFilteringModeDetailsNow')
  );
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
