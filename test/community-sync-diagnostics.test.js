import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommunitySyncDiagnosticsSummary } from '../js/community-sync-diagnostics.js';

test('community sync diagnostics summary reports schema version, action counts, and active exceptions', () => {
  const lastAttempt = Date.UTC(2026, 2, 25, 18, 15, 0, 0);
  const lastSuccess = Date.UTC(2026, 2, 25, 18, 0, 0, 0);
  const summary = buildCommunitySyncDiagnosticsSummary({
    meta: {
      version: '2026.03.25.1',
      schemaVersion: 2,
      cosmeticsCount: 6,
      hostCosmeticsCount: 5,
      heuristicRegexCount: 2,
      directivesCount: 4,
      scriptletsCount: 3,
      liveRemoteCosmeticChunkCount: 5,
      liveRemoteCosmeticDroppedAtApply: 2,
      liveRemoteCosmeticHostCount: 2,
      applied: {
        added: 7,
        byAction: {
          block: 4,
          redirect: 1,
          allow: 1,
          allowAllRequests: 1,
        },
        dropped: {
          unsupportedAction: 2,
          unsafeScope: 3,
          unsupportedRedirectPath: 1,
          quota: 4,
          regexUnsupported: 2,
          quotaByClass: {
            exactExceptions: 1,
            exactRedirects: 1,
            exactBlocks: 1,
            broadBlocks: 1,
            regexBlocks: 0,
          },
        },
      },
    },
    lastAttempt,
    lastSuccess,
    lastError: 'signature invalid',
    cleanupReason: 'fallback-private-state',
  });

  assert.equal(summary.status, 'degraded');
  assert.equal(summary.version, '2026.03.25.1');
  assert.equal(summary.schemaVersion, 2);
  assert.equal(summary.lastAttempt, new Date(lastAttempt).toISOString());
  assert.equal(summary.lastSuccess, new Date(lastSuccess).toISOString());
  assert.equal(summary.lastError, 'signature invalid');
  assert.equal(summary.cleanupReason, 'fallback-private-state');
  assert.equal(summary.activeRules, 7);
  assert.equal(summary.activeExceptions, 3);
  assert.equal(summary.cosmeticsCount, 6);
  assert.equal(summary.hostCosmeticsCount, 5);
  assert.equal(summary.heuristicRegexCount, 2);
  assert.equal(summary.directivesCount, 4);
  assert.equal(summary.scriptletsCount, 3);
  assert.equal(summary.liveRemoteCosmeticChunkCount, 5);
  assert.equal(summary.liveRemoteCosmeticDroppedAtApply, 2);
  assert.equal(summary.liveRemoteCosmeticHostCount, 2);
  assert.deepEqual(summary.actions, {
    block: 4,
    redirect: 1,
    allow: 1,
    allowAllRequests: 1,
  });
  assert.deepEqual(summary.dropped, {
    unsupportedAction: 2,
    unsafeScope: 3,
    unsupportedRedirectPath: 1,
    quota: 4,
    regexUnsupported: 2,
    quotaByClass: {
      exactExceptions: 1,
      exactRedirects: 1,
      exactBlocks: 1,
      broadBlocks: 1,
      regexBlocks: 0,
    },
  });
});

test('community sync diagnostics summary returns null when no diagnostics exist', () => {
  assert.equal(buildCommunitySyncDiagnosticsSummary({}), null);
});

test('community sync diagnostics summary returns idle cleanup details without active sync state', () => {
  const summary = buildCommunitySyncDiagnosticsSummary({
    cleanupReason: 'disabled',
  });

  assert.equal(summary.status, 'idle');
  assert.equal(summary.cleanupReason, 'disabled');
  assert.equal(summary.lastError, 'none');
});
