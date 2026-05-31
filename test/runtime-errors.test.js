import test from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessageFrom,
  ignoreRuntimeLastError,
  ignoreRuntimeError,
  isIgnorableRuntimeError,
  runtimeLastErrorFrom,
} from '../js/runtime-errors.js';

test('errorMessageFrom normalizes Error instances and raw strings', () => {
  assert.equal(errorMessageFrom(new Error('No tab with id: 1.')), 'No tab with id: 1.');
  assert.equal(errorMessageFrom('plain message'), 'plain message');
  assert.equal(errorMessageFrom({}), '');
});

test('isIgnorableRuntimeError recognizes the approved benign runtime errors', () => {
  assert.equal(isIgnorableRuntimeError(new Error('No tab with id: 42.')), true);
  assert.equal(isIgnorableRuntimeError(new Error('No window with id: 7.')), true);
  assert.equal(
    isIgnorableRuntimeError(new Error('Could not establish connection. Receiving end does not exist.')),
    true
  );
  assert.equal(
    isIgnorableRuntimeError(new Error('The message port closed before a response was received.')),
    true
  );
});

test('isIgnorableRuntimeError does not classify unrelated failures as benign', () => {
  assert.equal(isIgnorableRuntimeError(new Error('Permission denied')), false);
});

test('ignoreRuntimeError swallows benign failures and rethrows unexpected ones', () => {
  assert.doesNotThrow(() => ignoreRuntimeError(new Error('No tab with id: 9.')));
  assert.doesNotThrow(() => ignoreRuntimeError(new Error('No window with id: 2.')));
  assert.doesNotThrow(() => ignoreRuntimeError(new Error('Could not establish connection. Receiving end does not exist.')));
  assert.doesNotThrow(() => ignoreRuntimeError(new Error('The message port closed before a response was received.')));
  assert.doesNotThrow(() => ignoreRuntimeError(undefined));
  assert.throws(() => ignoreRuntimeError(new Error('Permission denied')), /Permission denied/);
});

test('runtimeLastErrorFrom reads callback lastError without requiring globals', () => {
  let reads = 0;
  const runtime = {
    get lastError() {
      reads += 1;
      return new Error('No tab with id: 123.');
    },
  };

  assert.equal(errorMessageFrom(runtimeLastErrorFrom(runtime)), 'No tab with id: 123.');
  assert.equal(reads, 1);
});

test('ignoreRuntimeLastError consumes benign callback lastError and rejects unexpected errors', () => {
  assert.equal(ignoreRuntimeLastError({ lastError: undefined }), false);
  assert.equal(ignoreRuntimeLastError({ lastError: new Error('No tab with id: 10.') }), true);
  assert.throws(
    () => ignoreRuntimeLastError({ lastError: new Error('Permission denied') }),
    /Permission denied/
  );
});
