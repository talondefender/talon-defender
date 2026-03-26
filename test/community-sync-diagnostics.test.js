import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommunitySyncDiagnosticsSummary } from '../js/community-sync-diagnostics.js';

test('community sync diagnostics summary reports schema version, action counts, and active exceptions', () => {
  const lastAttempt = Date.UTC(2026, 2, 25, 18, 15, 0, 0);
  const lastSuccess = Date.UTC(2026, 2, 25, 18, 0, 0, 0);
  const lastPartialDnrRepair = Date.UTC(2026, 2, 25, 17, 55, 0, 0);
  const lastAllowAllRollback = Date.UTC(2026, 2, 25, 17, 57, 0, 0);
  const lastEmergencySyncAt = Date.UTC(2026, 2, 25, 17, 50, 0, 0);
  const summary = buildCommunitySyncDiagnosticsSummary({
    meta: {
      version: '2026.03.25.1',
      schemaVersion: 2,
      ttlHours: 24,
      retryMinutes: 15,
      hotfixLane: 'public',
      activationStatus: 'rolled_back',
      activationRollbackAt: lastAttempt,
      activationRollbackReason: 'injectable registration failed',
      activationRollbackAttemptedVersion: '2026.03.25.2',
      activationRollbackRestoredVersion: '2026.03.25.1',
      cosmeticsCount: 6,
      hostCosmeticsCount: 5,
      protectedCosmeticsCount: 2,
      heuristicRegexCount: 2,
      directivesCount: 4,
      protectedDirectivesCount: 1,
      scriptletsCount: 3,
      tacticsCount: 2,
      publicDirectivesCount: 3,
      publicScriptletsCount: 2,
      publicTacticsCount: 2,
      proofDirectivesCount: 1,
      proofScriptletsCount: 1,
      protectedTacticsCount: 0,
      tacticsDroppedAtCompile: 1,
      partialDnrRepairCount: 1,
      lastPartialDnrRepair,
      allowAllRollbackCount: 2,
      lastAllowAllRollback,
      emergencySyncRollingCount: 3,
      lastEmergencySyncAt,
      lastEmergencySyncDomain: 'checkout.example.com',
      lastEmergencySyncReason: 'blocked-navigation-threshold',
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
  assert.equal(summary.protectedCosmeticsCount, 2);
  assert.equal(summary.heuristicRegexCount, 2);
  assert.equal(summary.directivesCount, 4);
  assert.equal(summary.protectedDirectivesCount, 1);
  assert.equal(summary.scriptletsCount, 3);
  assert.equal(summary.tacticsCount, 2);
  assert.equal(summary.publicDirectivesCount, 3);
  assert.equal(summary.publicScriptletsCount, 2);
  assert.equal(summary.publicTacticsCount, 2);
  assert.equal(summary.proofDirectivesCount, 1);
  assert.equal(summary.proofScriptletsCount, 1);
  assert.equal(summary.protectedTacticsCount, 0);
  assert.equal(summary.tacticsDroppedAtCompile, 1);
  assert.equal(summary.ttlHours, 24);
  assert.equal(summary.retryMinutes, 15);
  assert.equal(summary.hotfixLane, 'public');
  assert.equal(summary.activationStatus, 'rolled_back');
  assert.equal(summary.activationRollbackAt, new Date(lastAttempt).toISOString());
  assert.equal(summary.activationRollbackReason, 'injectable registration failed');
  assert.equal(summary.activationRollbackAttemptedVersion, '2026.03.25.2');
  assert.equal(summary.activationRollbackRestoredVersion, '2026.03.25.1');
  assert.equal(summary.partialDnrRepairSeen, true);
  assert.equal(summary.partialDnrRepairCount, 1);
  assert.equal(summary.lastPartialDnrRepair, new Date(lastPartialDnrRepair).toISOString());
  assert.equal(summary.allowAllRollbackSeen, true);
  assert.equal(summary.allowAllRollbackCount, 2);
  assert.equal(summary.lastAllowAllRollback, new Date(lastAllowAllRollback).toISOString());
  assert.equal(summary.emergencySyncRollingCount, 3);
  assert.equal(summary.lastEmergencySync, new Date(lastEmergencySyncAt).toISOString());
  assert.equal(summary.lastEmergencySyncDomain, 'checkout.example.com');
  assert.equal(summary.lastEmergencySyncReason, 'blocked-navigation-threshold');
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

test('community sync diagnostics summary reports partial repair-only state', () => {
  const lastPartialDnrRepair = Date.UTC(2026, 2, 25, 17, 30, 0, 0);
  const summary = buildCommunitySyncDiagnosticsSummary({
    meta: {
      partialDnrRepairCount: 2,
      lastPartialDnrRepair,
      ttlHours: 6,
      retryMinutes: 15,
    },
  });

  assert.equal(summary.status, 'idle');
  assert.equal(summary.partialDnrRepairSeen, true);
  assert.equal(summary.partialDnrRepairCount, 2);
  assert.equal(summary.lastPartialDnrRepair, new Date(lastPartialDnrRepair).toISOString());
  assert.equal(summary.allowAllRollbackSeen, false);
  assert.equal(summary.allowAllRollbackCount, 0);
  assert.equal(summary.lastAllowAllRollback, 'never');
  assert.equal(summary.ttlHours, 6);
  assert.equal(summary.retryMinutes, 15);
});
