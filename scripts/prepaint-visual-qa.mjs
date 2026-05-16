import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

const rootDir = process.cwd();
const outputDir = path.join(rootDir, 'dist', 'prepaint-visual-qa');
const host = 'prepaint-qa.talon.test';

const readRuntimeScript = relativePath =>
  fs.readFile(path.join(rootDir, relativePath), 'utf8');

const assert = (condition, message) => {
  if (condition) { return; }
  throw new Error(message);
};

const escapeHtml = value =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const buildInitScript = async () => {
  const runtimeScripts = await Promise.all([
    readRuntimeScript('js/scripting/block-hints.js'),
    readRuntimeScript('js/scripting/ad-shell-styles.js'),
    readRuntimeScript('js/scripting/post-hide-cleanup.js'),
  ]);

  return `
(() => {
  const runtime = {
    getURL: input => input,
    sendMessage: async () => ({}),
  };
  const storage = {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  };
  self.browser = { runtime, storage };
  self.chrome = { runtime, storage };
  self.TalonBreakageGuard = {
    RISK_TIERS: { medium: 2, high: 3 },
    whenReady: async () => {},
    shouldRunSubsystem: () => true,
    canMutateElement: element => {
      if (!(element instanceof Element)) { return { allowed: false }; }
      if (element.closest('header,nav,footer')) { return { allowed: false }; }
      if (element.closest('.auth-panel,.checkout-panel')) { return { allowed: false }; }
      return { allowed: true };
    },
    isLikelyPrimaryContent: element =>
      element instanceof Element &&
      element.matches('main,article,[role="main"],.content-card,.story-card'),
    auditAfterMutation: () => {},
  };
  self.TalonShadowRootController = {
    ROOTS_CHANGED_EVENT: 'talon-shadow-roots-changed',
    enumerateRoots: () => [],
    rescanNow: () => {},
    scheduleRescan: () => {},
  };
})();
${runtimeScripts.join('\n')}
`;
};

const baseCss = `
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; font-family: Arial, sans-serif; color: #10213d; }
  body { background: #f2f5f8; }
  header { height: 64px; display: flex; align-items: center; justify-content: center; background: #10213d; color: white; font-weight: 700; }
  main { max-width: 900px; margin: 24px auto; padding: 24px; background: white; border-radius: 6px; box-shadow: 0 1px 8px rgba(16, 33, 61, 0.12); }
  h1, h2, p { margin: 0 0 16px; }
  .top-leaderboard { width: 970px; height: 250px; margin: 18px auto; background: rgba(220, 230, 240, 0.9); }
  .top-leaderboard > .freestar-ads { width: 970px; height: 250px; }
  .rail-layout { width: 1120px; margin: 24px auto; display: grid; grid-template-columns: 300px 1fr; gap: 24px; align-items: start; }
  .rail-shell { width: 300px; height: 250px; background: rgba(220, 230, 240, 0.9); }
  .rail-shell > ins.adsbygoogle { display: block; width: 300px; height: 250px; }
  .sticky-shell { position: fixed; left: 0; right: 0; bottom: 0; height: 90px; z-index: 2000; background: rgba(40, 40, 40, 0.92); }
  .sticky-shell > #div-gpt-ad-bottom { width: 728px; height: 90px; margin: 0 auto; }
  .content-card { width: 640px; min-height: 180px; margin: 24px auto; padding: 24px; background: white; border: 1px solid #ccd5df; border-radius: 6px; }
`;

const scenarios = [
  {
    slug: 'top-leaderboard',
    label: 'top leaderboard gap',
    selector: '.top-leaderboard',
    expect: 'collapsed',
    body: `
      <div class="top-leaderboard"><div class="freestar-ads"></div></div>
      <main><h1>Weather Briefing</h1><p>Lead content should move up after the empty leaderboard is removed.</p></main>
    `,
  },
  {
    slug: 'left-rail',
    label: 'left rail 300x250 gap',
    selector: '.rail-shell',
    expect: 'collapsed',
    body: `
      <div class="rail-layout">
        <aside class="rail-shell"><ins class="adsbygoogle"></ins></aside>
        <main><h1>Regional Alerts</h1><p>The left rail should not reserve an empty ad rectangle.</p></main>
      </div>
    `,
  },
  {
    slug: 'sticky-bottom',
    label: 'sticky bottom ad shell',
    selector: '.sticky-shell',
    expect: 'collapsed',
    body: `
      <main><h1>Forecast Center</h1><p>Content should stay usable without a sticky empty ad shell.</p></main>
      <div class="sticky-shell"><div id="div-gpt-ad-bottom"></div></div>
    `,
  },
  {
    slug: 'false-positive',
    label: 'weak ad-like naming with real content',
    selector: '.content-card',
    expect: 'visible',
    body: `
      <main>
        <section class="content-card ad-slot">
          <h2>Advertising Policy Workshop</h2>
          <p>This real page content intentionally uses weak ad-like class naming.</p>
        </section>
      </main>
    `,
  },
];

const renderPage = scenario => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(scenario.label)}</title>
    <style>${baseCss}</style>
  </head>
  <body>
    <header>Talon Defender Prepaint QA</header>
    ${scenario.body}
  </body>
</html>`;

const readMetrics = (page, selector) =>
  page.evaluate(target => {
    const element = document.querySelector(target);
    if (!element) { return null; }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      display: style.display,
      visibility: style.visibility,
      width: rect.width,
      height: rect.height,
      text: element.textContent.trim().replace(/\s+/g, ' '),
    };
  }, selector);

const waitForCollapsed = (page, selector) =>
  page.waitForFunction(target => {
    const element = document.querySelector(target);
    if (!element) { return false; }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display === 'none' ||
      style.visibility === 'hidden' ||
      rect.height <= 1 ||
      rect.width <= 1;
  }, selector, { timeout: 3000 });

const waitForVisible = (page, selector) =>
  page.waitForFunction(target => {
    const element = document.querySelector(target);
    if (!element) { return false; }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 100 &&
      rect.height > 50 &&
      element.textContent.trim() !== '';
  }, selector, { timeout: 3000 });

const runScenario = async (browser, initScript, scenario) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript({ content: initScript });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const slug = url.pathname.replace(/^\/+|\.html$/g, '');
    const match = scenarios.find(entry => entry.slug === slug);
    if (!match) {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: renderPage(match),
    });
  });

  try {
    await page.goto(`https://${host}/${scenario.slug}.html`, {
      waitUntil: 'domcontentloaded',
    });
    if (scenario.expect === 'collapsed') {
      await waitForCollapsed(page, scenario.selector);
    } else {
      await waitForVisible(page, scenario.selector);
      await page.waitForTimeout(150);
    }
    const metrics = await readMetrics(page, scenario.selector);
    assert(metrics, `${scenario.label}: missing target ${scenario.selector}`);
    if (scenario.expect === 'collapsed') {
      assert(
        metrics.display === 'none' ||
          metrics.visibility === 'hidden' ||
          metrics.height <= 1 ||
          metrics.width <= 1,
        `${scenario.label}: expected collapsed target, got ${JSON.stringify(metrics)}`
      );
    } else {
      assert(
        metrics.display !== 'none' &&
          metrics.visibility !== 'hidden' &&
          metrics.width > 100 &&
          metrics.height > 50 &&
          metrics.text.length > 0,
        `${scenario.label}: expected visible content, got ${JSON.stringify(metrics)}`
      );
    }
    await page.screenshot({
      path: path.join(outputDir, `${scenario.slug}.png`),
      fullPage: true,
    });
    console.log(`ok - ${scenario.label}`);
  } finally {
    await context.close();
  }
};

await fs.mkdir(outputDir, { recursive: true });
const initScript = await buildInitScript();
const browser = await chromium.launch({ headless: true });

try {
  for (const scenario of scenarios) {
    await runScenario(browser, initScript, scenario);
  }
} finally {
  await browser.close();
}

console.log(`prepaint visual QA screenshots: ${path.relative(rootDir, outputDir)}`);
