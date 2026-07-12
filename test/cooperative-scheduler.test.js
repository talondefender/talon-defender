import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('large DOM subsystems load and use one shared cooperative scheduler', async () => {
  const [manager, background, shadow, postHide, native] = await Promise.all([
    readSource('js/scripting-manager.js'),
    readSource('js/background.js'),
    readSource('js/scripting/shadow-dom-helper.js'),
    readSource('js/scripting/post-hide-cleanup.js'),
    readSource('js/scripting/native-heuristics.js'),
  ]);

  assert.match(
    manager,
    /const TALON_COOPERATIVE_SCHEDULER_PATH =\s*'\/js\/scripting\/cooperative-scheduler\.js'/
  );
  assert.equal(
    (manager.match(/TALON_COOPERATIVE_SCHEDULER_PATH,\s*TALON_SHADOW_DOM_HELPER_PATH/g) || []).length,
    4
  );
  assert.equal(
    (background.match(/cooperative-scheduler\.js',\s*'\/js\/scripting\/shadow-dom-helper\.js/g) || []).length,
    3
  );

  for (const [name, source] of [
    ['shadow', shadow],
    ['post-hide', postHide],
    ['native', native],
  ]) {
    assert.match(source, /const cooperativeScheduler = self\.TalonCooperativeScheduler;/, name);
    assert.match(source, /scheduleCooperativeTask/, name);
    assert.match(source, /cooperativeDeadline\((?:sharedDeadline|deadline)\)/, name);
  }
});

test('shared scheduler caps aggregate large-DOM work in each animation frame', async () => {
  const source = await readSource('js/scripting/cooperative-scheduler.js');
  let now = 0;
  let nextFrameId = 1;
  const frames = new Map();
  const context = {
    performance: { now: () => now },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout,
    clearTimeout,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const scheduler = context.TalonCooperativeScheduler;
  const remaining = [1024, 1024, 1024];
  const runs = [0, 0, 0];
  const scheduleScan = index => {
    scheduler.schedule(deadline => {
      runs[index] += 1;
      while (remaining[index] !== 0 && now < deadline) {
        remaining[index] -= 1;
        now += 0.25;
      }
      if (remaining[index] !== 0) { scheduleScan(index); }
    });
  };
  scheduleScan(0);
  scheduleScan(1);
  scheduleScan(2);

  const frameDurations = [];
  let frameCount = 0;
  while (frames.size !== 0 && frameCount < 1000) {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    const startedAt = now;
    callback(now);
    frameDurations.push(now - startedAt);
    frameCount += 1;
  }

  assert.deepEqual(remaining, [0, 0, 0]);
  assert.equal(frameCount < 1000, true);
  assert.equal(runs.every(count => count > 1), true);
  assert.equal(
    frameDurations.every(duration => duration <= scheduler.FRAME_BUDGET_MS),
    true
  );
  assert.equal(frameDurations[0], scheduler.FRAME_BUDGET_MS);
  assert.deepEqual(runs, [64, 64, 64]);
});

test('mutation delivery defers layout-sensitive candidate evaluation', async () => {
  const [native, postHide] = await Promise.all([
    readSource('js/scripting/native-heuristics.js'),
    readSource('js/scripting/post-hide-cleanup.js'),
  ]);

  const nativeObserver = native.slice(
    native.indexOf('const observer = new MutationObserver'),
    native.indexOf('const onShadowRootsChanged')
  );
  const postHideObserver = postHide.slice(
    postHide.indexOf('const observer = new MutationObserver'),
    postHide.indexOf('const onBlockHintsChanged')
  );

  for (const [name, observerSource] of [
    ['native', nativeObserver],
    ['post-hide', postHideObserver],
  ]) {
    assert.doesNotMatch(observerSource, /getComputedStyle|getBoundingClientRect/, name);
    assert.doesNotMatch(observerSource, /collectCandidateNode\(|enqueueCandidate\(/, name);
    assert.match(observerSource, /collectDirectCandidate\(/, name);
  }

  for (const [name, source, processName] of [
    ['native', native, 'processCandidateScans'],
    ['post-hide', postHide, 'processCollectionJobs'],
  ]) {
    const directJob = source.slice(
      source.indexOf(name === 'native'
        ? 'const createDirectCandidateScanJob'
        : 'const createDirectCollectionJob'),
      source.indexOf(name === 'native'
        ? 'const hasOutboundLink'
        : 'const schedulePendingRecovery')
    );
    assert.match(directJob, /directOnly: true/, name);
    assert.match(directJob, new RegExp(`scheduleCooperativeTask\\(${processName}\\)`), name);
    assert.match(directJob, /MAX_(?:CANDIDATE|COLLECTION)_SCAN_JOBS/, name);
  }
});
