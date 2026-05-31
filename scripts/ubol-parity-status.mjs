import fs from 'node:fs/promises';
import path from 'node:path';

const normalizeList = values =>
  Array.isArray(values)
    ? values.map(value => String(value || '').trim()).filter(Boolean)
    : [];

const hasAny = values => normalizeList(values).length !== 0;

const formatList = values => {
  const list = normalizeList(values);
  return list.length === 0 ? 'none' : list.join(', ');
};

export function buildParityStatus(report = {}) {
  const driftClasses = normalizeList(report.driftClasses);
  const driftSet = new Set(driftClasses);
  const licenseBlockedRuleIds = normalizeList(report.licenseBlockedRuleIds);
  const ownershipViolations = normalizeList(report.ownershipViolations);
  const permissionAdded = normalizeList(report.manifestDiffs?.permissions?.added);
  const permissionRemoved = normalizeList(report.manifestDiffs?.permissions?.removed);
  const resourceAdded = normalizeList(report.manifestDiffs?.resources?.added);
  const resourceRemoved = normalizeList(report.manifestDiffs?.resources?.removed);
  const runtimeDiffs = Array.isArray(report.runtimeSchemaDiffs)
    ? report.runtimeSchemaDiffs
      .filter(diff => diff instanceof Object && typeof diff.key === 'string')
      .map(diff => `${diff.key}: ${diff.local} -> ${diff.upstream}`)
    : [];
  const layoutAdded = normalizeList(report.scriptingLayoutDiff?.added);
  const layoutRemoved = normalizeList(report.scriptingLayoutDiff?.removed);
  const minimumChromeVersion = report.manifestDiffs?.minimumChromeVersion instanceof Object
    ? report.manifestDiffs.minimumChromeVersion
    : {};

  const blockers = [];
  if (report.automationBlocked === true) {
    blockers.push('Parity automation is blocked by the audit.');
  }
  if (licenseBlockedRuleIds.length !== 0) {
    blockers.push(`${licenseBlockedRuleIds.length} upstream rulesets need license review.`);
  }
  if (ownershipViolations.length !== 0) {
    blockers.push(`${ownershipViolations.length} upstream changes would touch Talon-owned paths.`);
  }
  if (
    driftSet.has('manifest-permission') ||
    driftSet.has('browser-support') ||
    driftSet.has('store-packaging') ||
    permissionAdded.length !== 0 ||
    permissionRemoved.length !== 0 ||
    minimumChromeVersion.local !== minimumChromeVersion.upstream
  ) {
    blockers.push('Store-facing manifest, permission, package, or browser-support drift needs review.');
  }
  if (
    driftSet.has('runtime-code') ||
    driftSet.has('compiled-layout') ||
    runtimeDiffs.length !== 0 ||
    layoutAdded.length !== 0 ||
    layoutRemoved.length !== 0
  ) {
    blockers.push('Runtime and compiled scripting layout drift needs a separate runtime migration.');
  }
  if (driftSet.has('unknown')) {
    blockers.push('Unknown drift must be classified before automation can continue.');
  }

  const noDrift = driftClasses.length === 0;
  const rulesDataOnly = driftClasses.length === 1 && driftSet.has('rules-data-only');
  let releaseStatus = 'manual-review-required';
  if (noDrift) {
    releaseStatus = 'in-parity';
  } else if (rulesDataOnly && blockers.length === 0) {
    releaseStatus = 'ruleset-candidate-allowed';
  }

  const decisions = [];
  if (releaseStatus === 'in-parity') {
    decisions.push('No parity release is needed.');
  } else if (releaseStatus === 'ruleset-candidate-allowed') {
    decisions.push('Open a ruleset-only candidate PR from the pinned upstream release.');
    decisions.push('Do not include runtime, manifest, entitlement, backend, or user-state changes in that PR.');
  } else {
    decisions.push('Do not import uBO Lite runtime or rulesets automatically.');
    decisions.push('Use signed backend data hotfixes for urgent site fixes while parity work is reviewed.');
    decisions.push('Split future work into license review, runtime migration, store review, then ruleset import.');
  }

  return {
    generatedAtUtc: new Date().toISOString(),
    reportGeneratedAtUtc: report.generatedAtUtc || '',
    releaseStatus,
    automationBlocked: report.automationBlocked === true,
    manualReviewRequired: report.manualReviewRequired === true || blockers.length !== 0,
    driftClasses,
    blockers,
    decisions,
    details: {
      licenseBlockedRuleIds,
      ownershipViolations,
      permissions: {
        added: permissionAdded,
        removed: permissionRemoved,
      },
      resources: {
        added: resourceAdded,
        removed: resourceRemoved,
      },
      minimumChromeVersion: {
        local: minimumChromeVersion.local || '',
        upstream: minimumChromeVersion.upstream || '',
      },
      runtimeDiffs,
      scriptingLayout: {
        added: layoutAdded,
        removed: layoutRemoved,
      },
      impact: report.impact instanceof Object ? report.impact : {},
    },
  };
}

export function formatParityStatusMarkdown(status) {
  const lines = [
    '# uBO Lite Parity Status',
    '',
    `Generated: ${status.generatedAtUtc}`,
    `Report generated: ${status.reportGeneratedAtUtc || 'unknown'}`,
    `Status: ${status.releaseStatus}`,
    `Automation blocked: ${status.automationBlocked ? 'yes' : 'no'}`,
    `Manual review required: ${status.manualReviewRequired ? 'yes' : 'no'}`,
    '',
    '## Decision',
    ...status.decisions.map(decision => `- ${decision}`),
    '',
    '## Blockers',
    ...(status.blockers.length === 0
      ? ['- none']
      : status.blockers.map(blocker => `- ${blocker}`)),
    '',
    '## Drift',
    `- Classes: ${formatList(status.driftClasses)}`,
    `- License review: ${formatList(status.details.licenseBlockedRuleIds)}`,
    `- Added permissions: ${formatList(status.details.permissions.added)}`,
    `- Removed permissions: ${formatList(status.details.permissions.removed)}`,
    `- Minimum Chrome: local ${status.details.minimumChromeVersion.local || 'unknown'} / upstream ${status.details.minimumChromeVersion.upstream || 'unknown'}`,
    `- Runtime diffs: ${formatList(status.details.runtimeDiffs)}`,
    `- Scripting layout added: ${formatList(status.details.scriptingLayout.added)}`,
    `- Scripting layout removed: ${formatList(status.details.scriptingLayout.removed)}`,
  ];

  if (status.details.impact instanceof Object && Object.keys(status.details.impact).length !== 0) {
    lines.push(
      '',
      '## Package Impact',
      `- Local ruleset bytes: ${status.details.impact.localRulesetBytes ?? 'unknown'}`,
      `- Upstream ruleset bytes: ${status.details.impact.upstreamRulesetBytes ?? 'unknown'}`,
      `- Ruleset byte delta: ${status.details.impact.rulesetByteDelta ?? 'unknown'}`,
      `- Local ruleset count: ${status.details.impact.localRulesetCount ?? 'unknown'}`,
      `- Upstream ruleset count: ${status.details.impact.upstreamRulesetCount ?? 'unknown'}`,
      `- Ruleset count delta: ${status.details.impact.rulesetCountDelta ?? 'unknown'}`
    );
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

const parseArgs = argv => {
  const out = {
    report: '',
    out: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') {
      out.report = argv[++i] || '';
      continue;
    }
    if (arg === '--out') {
      out.out = argv[++i] || '';
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    }
  }
  return out;
};

const printUsage = () => {
  console.log([
    'Usage: node scripts/ubol-parity-status.mjs --report <audit-report.json> [options]',
    '',
    'Options:',
    '  --report <path>  JSON output from scripts/ubol-parity-audit.mjs.',
    '  --out <path>     Write the formatted status to a file.',
    '  --json           Print JSON instead of Markdown.',
  ].join('\n'));
};

const isMain = () => {
  if (process.argv[1] === undefined) { return false; }
  return process.argv[1].replace(/\\/g, '/').endsWith('/ubol-parity-status.mjs');
};

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.report === '') {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  const reportPath = path.resolve(process.cwd(), args.report);
  const raw = await fs.readFile(reportPath, 'utf8');
  const report = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const status = buildParityStatus(report);
  const output = args.json
    ? `${JSON.stringify(status, null, 2)}\n`
    : formatParityStatusMarkdown(status);

  if (args.out !== '') {
    await fs.mkdir(path.dirname(path.resolve(process.cwd(), args.out)), { recursive: true });
    await fs.writeFile(path.resolve(process.cwd(), args.out), output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}
