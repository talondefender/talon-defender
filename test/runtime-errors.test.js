import test from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMessageFrom,
  ignoreRuntimeError,
  isIgnorableRuntimeError,
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
