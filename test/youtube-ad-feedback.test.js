import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

const ENGLISH_FEEDBACK_MESSAGES = {
  youtubeAdFeedbackActiveTitle: 'Talon Defender is shortening this ad',
  youtubeAdFeedbackActiveDetail: 'Getting you back to your video faster.',
  youtubeAdFeedbackActiveAria: 'Talon Defender is shortening this YouTube ad and getting you back to your video faster.',
  youtubeAdFeedbackExpiredTitle: 'Talon Defender could skip ads like this',
  youtubeAdFeedbackExpiredDetail: 'Your protection is paused. Reactivate to skip annoying YouTube ads',
  youtubeAdFeedbackExpiredAria: 'Talon Defender could skip ads like this. Your protection is paused. Reactivate to skip annoying YouTube ads.',
  youtubeAdFeedbackRestoreButton: 'Restore Talon Defender',
  youtubeAdFeedbackRestoreAria: 'Restore Talon Defender on the pricing page',
};

function readFeedbackCopy({ document, state }, mode) {
  const field = suffix => state.elements.find(element =>
    element.parentElement !== null && element.className === `talon-youtube-ad-feedback-${suffix}`
  );
  const prefix = mode === 'expired' ? 'Expired' : 'Active';
  return {
    [`youtubeAdFeedback${prefix}Title`]: field('title').textContent,
    [`youtubeAdFeedback${prefix}Detail`]: field('detail').textContent,
    [`youtubeAdFeedback${prefix}Aria`]: document.getElementById('talon-youtube-ad-feedback').getAttribute('aria-label'),
    youtubeAdFeedbackRestoreButton: field('cta').textContent,
    youtubeAdFeedbackRestoreAria: field('cta').getAttribute('aria-label'),
  };
}

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
  assert.equal(state.elements.some(element => element.tagName === 'BUTTON'), false,
    'the transient ad status must not ask for a rating');
  assert.equal(state.timeoutEntries.length, 0);

  assert.equal(controller.setActive(false), true);
  assert.equal(document.getElementById('talon-youtube-ad-feedback'), null);
  assert.ok(document.getElementById('talon-youtube-ad-feedback-style'));
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
  assert.equal(title.textContent, 'Talon Defender could skip ads like this');
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

test('YouTube feedback keeps one expanded overlay without resize timers', async () => {
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
  assert.equal(state.timeoutEntries.length, 0);
  assert.equal(
    document.getElementById('talon-youtube-ad-feedback').getAttribute('data-state'),
    'expanded'
  );
  controller.setActive(true);
  assert.equal(state.timeoutEntries.length, 0);
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

test('YouTube feedback keeps its expanded state after stop, restart and mode changes', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const { context, document, state } = createHarness();
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdFeedbackCreateController(context);

  controller.setActive(true);
  controller.stop();
  controller.setActive(true);
  assert.equal(document.getElementById('talon-youtube-ad-feedback').getAttribute('data-state'), 'expanded');

  controller.setActive(false);
  controller.setActive(true);
  controller.setActive(true, { mode: 'expired' });
  const expired = document.getElementById('talon-youtube-ad-feedback');
  assert.equal(expired.getAttribute('data-state'), 'expanded');
  assert.equal(expired.getAttribute('data-mode'), 'expired');
  assert.equal(state.timeoutEntries.length, 0);
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
  assert.equal(state.timeoutEntries.filter(entry => !entry.cleared).length, 0);
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

test('YouTube feedback localizes visible copy and accessibility labels synchronously in both modes', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const harness = createHarness();
  const translations = Object.fromEntries(Object.keys(ENGLISH_FEEDBACK_MESSAGES).map((key, index) =>
    [key, `Texte traduit numéro ${index + 1}`]
  ));
  const messageReads = [];
  harness.context.chrome.i18n.getMessage = key => {
    messageReads.push(key);
    return translations[key];
  };
  vm.runInNewContext(source, harness.context);
  const controller = harness.context.__talonYoutubeAdFeedbackCreateController(harness.context);
  assert.equal(messageReads.length, 0, 'inactive feedback must not do localization work');

  assert.equal(controller.setActive(true), true);
  const activeCopy = readFeedbackCopy(harness, 'protected');
  assert.equal(controller.setActive(true, { mode: 'expired' }), true);
  const expiredCopy = readFeedbackCopy(harness, 'expired');
  assert.deepEqual({ ...activeCopy, ...expiredCopy }, translations);
  assert.equal(controller.setActive(true, { mode: 'protected' }), true);
  assert.deepEqual(readFeedbackCopy(harness, 'protected'), activeCopy);
});

test('YouTube feedback honors the supplied i18n API and preserves its receiver', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const harness = createHarness();
  harness.context.chrome.i18n.getMessage = () => 'Wrong window API';
  vm.runInNewContext(source, harness.context);
  const i18n = {
    getMessage(key) {
      assert.equal(this, i18n, 'Chrome methods must keep the owning API as receiver');
      return `Übersetzt: ${ENGLISH_FEEDBACK_MESSAGES[key]}`;
    },
    getUILanguage: () => 'de-DE',
  };
  const controller = harness.context.__talonYoutubeAdFeedbackCreateController({
    ...harness.context,
    window: harness.context,
    chrome: { ...harness.context.chrome, i18n },
  });
  controller.setActive(true);
  const activeCopy = readFeedbackCopy(harness, 'protected');
  controller.setActive(true, { mode: 'expired' });
  const copy = { ...activeCopy, ...readFeedbackCopy(harness, 'expired') };
  for (const [key, english] of Object.entries(ENGLISH_FEEDBACK_MESSAGES)) {
    assert.equal(copy[key], `Übersetzt: ${english}`, key);
  }
});

test('YouTube feedback uses readable English when localization is missing or unusable', async () => {
  const source = await readSource('js/scripting/youtube-ad-feedback.js');
  const missingMessages = [
    undefined,
    () => undefined,
    () => null,
    () => '',
    () => '  \t\n ',
    () => 42,
    key => key,
    () => { throw new Error('localization unavailable'); },
  ];
  for (const getMessage of missingMessages) {
    const harness = createHarness();
    harness.context.chrome.i18n.getMessage = getMessage;
    vm.runInNewContext(source, harness.context);
    const controller = harness.context.__talonYoutubeAdFeedbackCreateController(harness.context);
    controller.setActive(true);
    const activeCopy = readFeedbackCopy(harness, 'protected');
    controller.setActive(true, { mode: 'expired' });
    assert.deepEqual({ ...activeCopy, ...readFeedbackCopy(harness, 'expired') }, ENGLISH_FEEDBACK_MESSAGES);
  }
});

test('every packaged locale supplies complete YouTube feedback copy and Norwegian aliases agree', async () => {
  const localeEntries = await fs.readdir(new URL('../_locales/', import.meta.url), { withFileTypes: true });
  const localeNames = localeEntries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(localeNames, ['da', 'de', 'en', 'es', 'fi', 'fr', 'it', 'ja', 'ko', 'nb', 'nl', 'no', 'sv']);
  const catalogs = new Map();
  for (const locale of localeNames) {
    const messages = JSON.parse(await readSource(`_locales/${locale}/messages.json`));
    const feedback = {};
    for (const key of Object.keys(ENGLISH_FEEDBACK_MESSAGES)) {
      const message = messages[key]?.message;
      assert.equal(typeof message, 'string', `${locale}: missing ${key}`);
      assert.ok(message.trim().length > 0, `${locale}: blank ${key}`);
      assert.notEqual(message, key, `${locale}: untranslated message key`);
      assert.doesNotMatch(message, /\uFFFD|__MSG_/, `${locale}: malformed ${key}`);
      feedback[key] = message;
    }
    for (const key of ['ReviewPrompt', 'ReviewStarAria', 'ReviewThanks']) {
      const message = messages[`popup${key}`]?.message;
      assert.ok(typeof message === 'string' && message.trim(), `${locale}: missing review ${key}`);
      if (key === 'ReviewStarAria') {
        assert.equal(message.split('{rating}').length, 2, `${locale}: rating placeholder`);
      }
    }
    catalogs.set(locale, feedback);
  }
  assert.deepEqual(catalogs.get('en'), ENGLISH_FEEDBACK_MESSAGES);
  assert.deepEqual(catalogs.get('nb'), catalogs.get('no'));
});
