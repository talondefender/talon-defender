import test from 'node:test';
import assert from 'node:assert/strict';

import { createSingleFlightRunner } from '../js/single-flight.js';

test('single-flight runner shares one in-flight promise for concurrent callers', async () => {
  let calls = 0;
  let resolveTask;
  const runner = createSingleFlightRunner(() => {
    calls += 1;
    return new Promise(resolve => {
      resolveTask = resolve;
    });
  });

  const first = runner();
  const second = runner();
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveTask('done');
  assert.equal(await first, 'done');
});

test('single-flight runner clears state after rejection so the next call can recover', async () => {
  let shouldReject = true;
  let calls = 0;
  const runner = createSingleFlightRunner(async () => {
    calls += 1;
    if (shouldReject) {
      shouldReject = false;
      throw new Error('boom');
    }
    return 'recovered';
  });

  await assert.rejects(() => runner(), /boom/);
  assert.equal(calls, 1);
  assert.equal(await runner(), 'recovered');
  assert.equal(calls, 2);
});
