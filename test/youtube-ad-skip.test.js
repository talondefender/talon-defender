import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createHarness() {
  const state = {
    adShowing: true,
    hiddenInterruptions: 0,
    interruptionShowing: false,
    skipClicks: 0,
    styles: [],
    listeners: [],
  };
  const video = {
    muted: false,
    playbackRate: 1,
    duration: 30,
    currentTime: 2,
  };
  const skipButton = {
    disabled: false,
    hidden: false,
    getAttribute: name => (name === 'aria-disabled' ? 'false' : null),
    getClientRects: () => [{ width: 20, height: 20 }],
    click: () => {
      state.skipClicks += 1;
    },
  };
  const styleParent = {
    append: element => {
      state.styles.push(element);
    },
  };
  const interruptionToast = {
    hidden: false,
    textContent: 'Experiencing interruptions? Find out why',
    style: {
      setProperty: () => {
        state.hiddenInterruptions += 1;
      },
    },
    setAttribute(name, value) {
      if (name === 'aria-hidden' && value === 'true') {
        state.hiddenInterruptions += 1;
      }
    },
  };
  const document = {
    visibilityState: 'visible',
    head: styleParent,
    documentElement: styleParent,
    addEventListener: (name, handler) => {
      state.listeners.push({ name, handler });
    },
    createElement: tagName => ({
      tagName,
      id: '',
      textContent: '',
      remove() {
        state.styles = state.styles.filter(style => style !== this);
      },
    }),
    getElementById: id => state.styles.find(style => style.id === id) || null,
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      if (selector === 'video') {
        return [video];
      }
      if (selector.includes('ytp-ad-skip') || selector.includes('skip-ad')) {
        return state.adShowing ? [skipButton] : [];
      }
      if (selector.includes('.ad-showing')) {
        return state.adShowing ? [{ className: 'ad-showing' }] : [];
      }
      if (selector.includes('ytp-ad-player-overlay') || selector.includes('ytd-ad-slot-renderer')) {
        return state.adShowing ? [{ className: 'ytp-ad-player-overlay' }] : [];
      }
      if (selector.includes('tp-yt-paper-toast') || selector.includes('[role="alert"]')) {
        return state.interruptionShowing ? [interruptionToast] : [];
      }
      return [];
    },
  };

  const context = {
    __talonYoutubeAdSkipTest: true,
    document,
    location: { hostname: 'www.youtube.com' },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  };
  context.globalThis = context;
  return { context, state, video };
}

test('YouTube ad skip clicks visible skip controls, accelerates ads, and restores video state', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  assert.equal(video.currentTime, 2);
  assert.equal(state.styles.length, 1);

  state.adShowing = false;
  assert.equal(controller.tick(), false);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip does not seek the player and trigger short-video restart loops', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  video.duration = 45;
  video.currentTime = 0;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);

  video.currentTime = 0;
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);
  assert.equal(state.skipClicks, 2);
  assert.equal(video.playbackRate, 16);
});

test('YouTube ad skip suppresses only the matching interruptions notice', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.interruptionShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.hiddenInterruptions > 0, true);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip is Talon-owned runtime without remote code or page-script injection', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');

  assert.match(source, /talonYoutubeAdSkip/);
  assert.match(source, /youtubeAdSkip/);
  assert.match(source, /TalonBreakageGuard/);
  assert.match(source, /nocookie/);
  assert.doesNotMatch(source, /chrome\.runtime|browser\.runtime/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /createElement\(['"]script['"]\)/);
  assert.doesNotMatch(source, /runtime\.getURL/);
  assert.doesNotMatch(source, /currentTime\s*=/);
  assert.doesNotMatch(source, /analytics|posthog/i);
});

test('uBO parity registration excludes YouTube scriptlets and keeps Talon lane separate', async () => {
  const managerSource = await readSource('js/scripting-manager.js');
  const ownershipSource = await readSource('scripts/ubol-source-ownership.json');

  assert.match(managerSource, /const TALON_YOUTUBE_AD_SKIP_ID = 'talon-youtube-ad-skip';/);
  assert.match(managerSource, /const TALON_YOUTUBE_AD_SKIP_PATH = '\/js\/scripting\/youtube-ad-skip\.js';/);
  assert.match(managerSource, /const TALON_YOUTUBE_PLAYER_GUARD_ID = 'talon-youtube-player-guard';/);
  assert.match(managerSource, /const TALON_YOUTUBE_PLAYER_GUARD_PATH = '\/js\/scripting\/youtube-player-guard\.js';/);
  assert.match(managerSource, /function registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /registerYouTubePlayerGuard\(context\)/);
  assert.match(managerSource, /world: 'MAIN'/);
  assert.match(managerSource, /const getScriptletExcludedHostnames = \( \) => YOUTUBE_AD_SKIP_HOSTNAMES;/);
  assert.match(managerSource, /function registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /excludeMatches\.push\(\.\.\.ut\.matchesFromHostnames\(scriptletExcludedHostnames\)\)/);
  assert.match(managerSource, /targetHostnames = ut\.subtractHostnameIters\(\s*targetHostnames,\s*scriptletExcludedHostnames\s*\);/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-ad-skip\.js"/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-player-guard\.js"/);
});
