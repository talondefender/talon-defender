import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createHarness() {
  const state = {
    elements: [],
    listeners: [],
    playerShowing: true,
    timeoutEntries: [],
  };

  const createElement = tagName => {
    const attributes = new Map();
    const element = {
      tagName: String(tagName || '').toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      src: '',
      alt: '',
      children: [],
      parentElement: null,
      appendChild(child) {
        child.remove?.();
        this.children.push(child);
        child.parentElement = this;
        return child;
      },
      append(child) {
        return this.appendChild(child);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      remove() {
        const parent = this.parentElement;
        if ( parent ) {
          parent.children = parent.children.filter(child => child !== this);
        }
        this.parentElement = null;
      },
    };
    state.elements.push(element);
    return element;
  };

  const head = createElement('head');
  const documentElement = createElement('html');
  const player = createElement('div');
  player.className = 'html5-video-player';

  const document = {
    head,
    documentElement,
    createElement,
    getElementById(id) {
      return state.elements.find(element =>
        element.id === id && element.parentElement !== null
      ) || null;
    },
    querySelector(selector) {
      if ( selector === '.html5-video-player,#movie_player' ) {
        return state.playerShowing ? player : null;
      }
      return null;
    },
  };

  const context = {
    __talonYoutubeAdFeedbackTest: true,
    document,
    URL,
    chrome: {
      i18n: {
        getUILanguage: () => 'en-US',
      },
      runtime: {
        getURL: path => `chrome-extension://talon-test/${path}`,
        getManifest: () => ({ homepage_url: 'https://talondefender.com' }),
      },
    },
    addEventListener(name, handler, options) {
      state.listeners.push({ name, handler, options });
    },
    removeEventListener(name, handler) {
      state.listeners = state.listeners.filter(entry => entry.name !== name || entry.handler !== handler);
    },
    setTimeout(handler, delay) {
      const entry = {
        id: state.timeoutEntries.length + 1,
        handler,
        delay,
        cleared: false,
      };
      state.timeoutEntries.push(entry);
      return entry.id;
    },
    clearTimeout(id) {
      const entry = state.timeoutEntries.find(item => item.id === id);
      if ( entry ) { entry.cleared = true; }
    },
  };
  context.globalThis = context;
  return { context, document, player, state };
}

test('YouTube feedback shows a branded non-interactive message only while acceleration is active', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, player, state } = createHarness();
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdFeedbackCreateController(context);
  assert.equal(controller.setActive(true), true);

  const overlay = document.getElementById('talon-youtube-ad-feedback');
  const style = document.getElementById('talon-youtube-ad-feedback-style');
  assert.ok(overlay);
  assert.ok(style);
  assert.equal(overlay.parentElement, player);
  assert.equal(overlay.getAttribute('data-state'), 'expanded');
  assert.equal(overlay.getAttribute('role'), 'status');
  assert.match(overlay.getAttribute('aria-label'), /Talon Defender is shortening/);
  assert.match(style.textContent, /pointer-events:\s*none/);
  assert.match(style.textContent, /top:\s*50%/);
  assert.match(style.textContent, /left:\s*50%/);
  assert.match(style.textContent, /translate\(-50%,\s*-50%\)/);
  assert.match(style.textContent, /max-width:\s*min\(520px/);
  assert.match(style.textContent, /width:\s*76px/);
  assert.match(style.textContent, /font-size:\s*22px/);
  assert.match(style.textContent, /prefers-reduced-motion/);

  const logo = state.elements.find(element =>
    element.className === 'talon-youtube-ad-feedback-logo'
  );
  const title = state.elements.find(element =>
    element.className === 'talon-youtube-ad-feedback-title'
  );
  assert.equal(
    logo.src,
    'chrome-extension://talon-test/icons/icon128.png'
  );
  assert.equal(title.textContent, 'Talon Defender is shortening this ad');
  assert.equal(state.timeoutEntries.length, 1);
  assert.equal(state.timeoutEntries[0].delay, 4000);

  assert.equal(controller.setActive(false), true);
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);
  assert.ok(document.getElementById('talon-youtube-ad-feedback-style'));
  assert.equal(state.timeoutEntries[0].cleared, true);
});

test('YouTube feedback renders an expired CTA with campaign tracking and mode-safe cleanup', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, state } = createHarness();
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdFeedbackCreateController(context);
  assert.equal(controller.setActive(true, { mode: 'expired' }), true);
  assert.equal(controller.getMode(), 'expired');

  const overlay = document.getElementById('talon-youtube-ad-feedback');
  assert.equal(overlay.getAttribute('data-mode'), 'expired');
  assert.equal(overlay.getAttribute('role'), 'region');
  assert.match(overlay.getAttribute('aria-label'), /protection is paused/i);

  const title = state.elements.find(element =>
    element.className === 'talon-youtube-ad-feedback-title'
  );
  const detail = state.elements.find(element =>
    element.className === 'talon-youtube-ad-feedback-detail'
  );
  const cta = state.elements.find(element =>
    element.className === 'talon-youtube-ad-feedback-cta'
  );
  assert.equal(title.textContent, 'Talon Defender could shorten ads like this');
  assert.match(detail.textContent, /protection is paused/i);
  assert.equal(cta.textContent, 'Restore Talon Defender');
  assert.equal(cta.target, '_blank');
  assert.equal(cta.rel, 'noopener noreferrer');
  assert.equal(
    cta.href,
    'https://talondefender.com/en/pricing/?source=youtube_expired_overlay'
  );
  assert.match(
    document.getElementById('talon-youtube-ad-feedback-style').textContent,
    /talon-youtube-ad-feedback-cta[\s\S]*pointer-events:\s*auto/
  );
  assert.equal(overlay.getAttribute('data-state'), 'expanded');
  assert.equal(state.timeoutEntries.length, 0);

  controller.setActive(true, { mode: 'expired' });
  assert.equal(overlay.getAttribute('data-state'), 'expanded');
  assert.equal(state.timeoutEntries.length, 0);

  assert.equal(controller.setActive(false, { mode: 'protected' }), false);
  assert.ok(document.getElementById('talon-youtube-ad-feedback'));
  controller.stop({ mode: 'protected' });
  assert.ok(document.getElementById('talon-youtube-ad-feedback'));
  assert.ok(document.getElementById('talon-youtube-ad-feedback-style'));
  assert.equal(controller.setActive(false, { mode: 'expired' }), true);
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);
});

test('YouTube feedback collapses once without duplicate overlays or timers', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, player, state } = createHarness();
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdFeedbackCreateController(context);
  controller.setActive(true);
  controller.setActive(true);
  controller.setActive(true);
  assert.equal(
    player.children.filter(child => child.id === 'talon-youtube-ad-feedback').length,
    1
  );
  assert.equal(state.timeoutEntries.length, 1);

  state.timeoutEntries[0].handler();
  assert.equal(
    document.getElementById('talon-youtube-ad-feedback').getAttribute('data-state'),
    'compact'
  );
  controller.setActive(true);
  assert.equal(state.timeoutEntries.length, 1);
});

test('YouTube feedback waits for a player and cleans every owned node on stop', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, state } = createHarness();
  state.playerShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdFeedbackCreateController(context);
  assert.equal(controller.setActive(true), false);
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);

  state.playerShowing = true;
  assert.equal(controller.setActive(true), true);
  assert.ok(document.getElementById('talon-youtube-ad-feedback'));
  assert.ok(document.getElementById('talon-youtube-ad-feedback-style'));

  controller.stop();
  assert.equal(controller.isActive(), false);
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);
  assert.equal(document.getElementById('talon-youtube-ad-feedback-style'), null);
  assert.equal(state.listeners.some(entry => entry.name === 'pagehide'), false);
});

test('YouTube feedback ignores a previous ad collapse after stop or mode change', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, state } = createHarness();
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdFeedbackCreateController(context);

  controller.setActive(true);
  const previousAd = state.timeoutEntries.at(-1);
  controller.stop();
  controller.setActive(true);
  const currentAd = state.timeoutEntries.at(-1);
  previousAd.handler();
  assert.equal(document.getElementById('talon-youtube-ad-feedback').getAttribute('data-state'), 'expanded');
  currentAd.handler();
  assert.equal(document.getElementById('talon-youtube-ad-feedback').getAttribute('data-state'), 'compact');

  controller.setActive(false);
  controller.setActive(true);
  const protectedAd = state.timeoutEntries.at(-1);
  controller.setActive(true, { mode: 'expired' });
  protectedAd.handler();
  const expired = document.getElementById('talon-youtube-ad-feedback');
  assert.equal(expired.getAttribute('data-state'), 'expanded');
  assert.equal(expired.getAttribute('data-mode'), 'expired');
});

test('YouTube feedback can resume after teardown without duplicate listeners or stale modes', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, state } = createHarness();
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdFeedbackCreateController(context);
  controller.setActive(true, { mode: 'expired' });
  controller.stop();
  controller.setActive(true, { mode: 'protected' });
  controller.refresh();

  const overlay = document.getElementById('talon-youtube-ad-feedback');
  assert.equal(overlay.getAttribute('data-mode'), 'protected');
  assert.equal(overlay.getAttribute('role'), 'status');
  assert.equal(state.listeners.filter(entry => entry.name === 'pagehide').length, 1);
  assert.equal(state.timeoutEntries.filter(entry => !entry.cleared).length, 1);
  controller.stop({ mode: 'expired' });
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), overlay);
  assert.ok(document.getElementById('talon-youtube-ad-feedback-style'));
  const hide = state.listeners.find(entry => entry.name === 'pagehide');
  hide.handler();
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);
  assert.equal(document.getElementById('talon-youtube-ad-feedback-style'), null);
});

test('YouTube feedback remains local presentation without network or analytics behavior', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');

  assert.match(source, /TalonYoutubeAdFeedbackController/);
  assert.match(source, /icons\/icon128\.png/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /analytics|posthog|telemetry/i);
  assert.doesNotMatch(source, /\.playbackRate\s*=|\.currentTime\s*=|\.muted\s*=/);
});
