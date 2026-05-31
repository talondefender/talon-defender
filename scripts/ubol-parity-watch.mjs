import { execFileSync } from 'node:child_process';

export const DEFAULT_UBOL_HOME_REPO = 'https://github.com/uBlockOrigin/uBOL-home.git';

const STABLE_TAG_RE = /^(?:uBOLite_)?(\d{4})\.(\d{3,4})\.(\d{3,4})$/;

export function parseStableChromiumTag(tagName) {
  const tag = String(tagName || '').replace(/^refs\/tags\//, '').trim();
  if (tag === '' || /(?:beta|safari)/i.test(tag)) { return null; }
  const match = tag.match(STABLE_TAG_RE);
  if (match === null) { return null; }
  return {
    tag,
    year: Number(match[1]),
    dateCode: Number(match[2]),
    timeCode: Number(match[3]),
  };
}

export function compareStableTags(left, right) {
  for (const key of ['year', 'dateCode', 'timeCode']) {
    const delta = left[key] - right[key];
    if (delta !== 0) { return delta; }
  }
  return left.tag.localeCompare(right.tag);
}

export function latestStableChromiumTagFromLsRemote(raw) {
  const candidates = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') { continue; }
    const [commit, ref] = trimmed.split(/\s+/);
    const parsed = parseStableChromiumTag(ref);
    if (parsed === null) { continue; }
    candidates.push({ ...parsed, commit });
  }
  candidates.sort(compareStableTags);
  return candidates.at(-1) || null;
}

const gitLsRemoteTags = repo => execFileSync(
  'git',
  ['ls-remote', '--tags', repo],
  {
    encoding: 'utf8',
    windowsHide: true,
  }
);

const parseArgs = argv => {
  const out = {
    repo: DEFAULT_UBOL_HOME_REPO,
    baselineTag: '',
    json: false,
    failOnNew: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      out.repo = argv[++i];
      continue;
    }
    if (arg === '--baseline-tag') {
      out.baselineTag = argv[++i];
      continue;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--fail-on-new') {
      out.failOnNew = true;
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
    'Usage: node scripts/ubol-parity-watch.mjs [options]',
    '',
    'Options:',
    `  --repo <url>            uBOL-home Git repository. Default: ${DEFAULT_UBOL_HOME_REPO}`,
    '  --baseline-tag <tag>    Current Talon upstream baseline tag.',
    '  --json                  Print JSON.',
    '  --fail-on-new           Exit 2 when latest tag differs from baseline.',
  ].join('\n'));
};

const isMain = () => {
  if (process.argv[1] === undefined) { return false; }
  return process.argv[1].replace(/\\/g, '/').endsWith('/ubol-parity-watch.mjs');
};

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  const latest = latestStableChromiumTagFromLsRemote(gitLsRemoteTags(args.repo));
  if (latest === null) {
    console.error('No stable uBO Lite Chromium tag found.');
    process.exit(1);
  }
  const baseline = parseStableChromiumTag(args.baselineTag);
  const updateAvailable = baseline === null
    ? true
    : compareStableTags(latest, baseline) > 0;
  const report = {
    generatedAtUtc: new Date().toISOString(),
    repo: args.repo,
    baselineTag: baseline?.tag || args.baselineTag || '',
    latestTag: latest.tag,
    latestCommit: latest.commit,
    updateAvailable,
  };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Latest stable uBO Lite Chromium tag: ${latest.tag}`);
    console.log(`Commit: ${latest.commit}`);
    console.log(`Baseline: ${report.baselineTag || '(none)'}`);
    console.log(`Update available: ${updateAvailable ? 'yes' : 'no'}`);
  }
  if (args.failOnNew && updateAvailable) {
    process.exit(2);
  }
}
