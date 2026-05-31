import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildParityStatus,
  formatParityStatusMarkdown,
} from '../scripts/ubol-parity-status.mjs';

test('parity status allows clean rules-data-only candidates', () => {
  const status = buildParityStatus({
    generatedAtUtc: '2026-05-31T18:00:00.000Z',
    driftClasses: ['rules-data-only'],
    automationBlocked: false,
    manualReviewRequired: false,
    manifestDiffs: {
      permissions: { added: [], removed: [] },
      minimumChromeVersion: { local: '137.0', upstream: '137.0' },
    },
  });

  assert.equal(status.releaseStatus, 'ruleset-candidate-allowed');
  assert.equal(status.manualReviewRequired, false);
  assert.deepEqual(status.blockers, []);
  assert.match(formatParityStatusMarkdown(status), /Open a ruleset-only candidate PR/);
});

test('parity status blocks mixed runtime, permission, and license drift', () => {
  const status = buildParityStatus({
    generatedAtUtc: '2026-05-31T18:00:00.000Z',
    driftClasses: [
      'rules-data-only',
      'runtime-code',
      'manifest-permission',
      'license-blocked',
    ],
    automationBlocked: true,
    manualReviewRequired: true,
    manifestDiffs: {
      permissions: {
        added: ['offscreen', 'userScripts'],
        removed: [],
      },
      minimumChromeVersion: {
        local: '137.0',
        upstream: '122.0',
      },
    },
    runtimeSchemaDiffs: [
      { key: 'hasOffscreen', local: false, upstream: true },
    ],
    licenseBlockedRuleIds: ['adguard-mobile'],
  });

  assert.equal(status.releaseStatus, 'manual-review-required');
  assert.equal(status.automationBlocked, true);
  assert.equal(status.manualReviewRequired, true);
  assert.ok(status.blockers.some(blocker => /license review/.test(blocker)));
  assert.ok(status.blockers.some(blocker => /Store-facing/.test(blocker)));
  assert.ok(status.blockers.some(blocker => /Runtime/.test(blocker)));
  assert.match(formatParityStatusMarkdown(status), /Do not import uBO Lite runtime or rulesets automatically/);
});

test('parity status reports complete parity when no drift exists', () => {
  const status = buildParityStatus({
    driftClasses: [],
    automationBlocked: false,
    manualReviewRequired: false,
  });

  assert.equal(status.releaseStatus, 'in-parity');
  assert.equal(status.manualReviewRequired, false);
  assert.deepEqual(status.blockers, []);
});
