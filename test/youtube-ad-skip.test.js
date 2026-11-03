import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createControl({ tagName = 'BUTTON', className = '', textContent = '', attributes = {}, disabled = false, hidden = false, onClick = () => {}, onEvent = () => {}, onFocus = () => {} } = {}) {
  const children = [];
  const element = {
    tagName,
    className,
    textContent,
    disabled,
    hidden,
    parentElement: null,
    isConnected: true,
    children,
    getAttribute: name => name === 'class' ? element.className : attributes[name] ?? null,
    getClientRects: () => element.hidden ? [] : [{ width: 20, height: 20 }],
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        const attrs = [...value.matchAll(/\[([\w-]+)(\*=|\^=|=)?["']?([^\]"']*)["']?\]/g)];
        const structural = value.replace(/\[[^\]]+\]/g, '');
        if (structural.includes(' ')) { return false; }
        const tag = structural.match(/^[a-z][\w-]*/i)?.[0];
        if (tag && tag.toUpperCase() !== element.tagName) { return false; }
        for (const [, name] of structural.matchAll(/\.([\w-]+)/g)) {
          if (!element.className.split(/\s+/).includes(name)) { return false; }
        }
        for (const [, id] of structural.matchAll(/#([\w-]+)/g)) {
          if (element.getAttribute('id') !== id) { return false; }
        }
        return attrs.every(([, name, operator, expected]) => {
          const actual = element.getAttribute(name);
          if (actual === null) { return false; }
          if (operator === '*=') { return actual.includes(expected); }
          if (operator === '^=') { return actual.startsWith(expected); }
          return !operator || actual === expected;
        });
      });
    },
    closest(selector) {
      for (let current = element; current; current = current.parentElement) {
        if (current.matches(selector)) { return current; }
      }
      return null;
    },
    querySelectorAll(selector) {
      return children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
    contains(target) {
      for (let current = target; current; current = current.parentElement) {
        if (current === element) { return true; }
      }
      return false;
    },
    appendChild(child) { children.push(child); child.parentElement = element; return child; },
    focus: onFocus,
    dispatchEvent(event) { onEvent(event); return true; },
    click() {
      if (element.disabled) { return; }
      onClick();
      element.dispatchEvent({ type: 'click' });
    },
  };
  element.classList = { contains: name => element.className.split(/\s+/).includes(name) };
  return element;
}

function createHarness() {
  const state = {
    adShowing: true,
    playerClassShowing: true,
    skipShowing: true,
    hiddenInterruptions: 0,
    interruptionShowing: false,
    observerCallback: null,
    observerOptions: null,
    playerObserverCallback: null,
    playerObserverOptions: null,
    fallbackSkipShowing: false,
    shortPlayerSkipShowing: false,
    navigationSkipShowing: false,
    skipEvents: [],
    skipFocuses: 0,
    skipClicks: 0,
    skipCandidates: null,
    fallbackCandidates: null,
    styles: [],
    listeners: [],
    timeoutCallbacks: [],
  };
  const video = {
    muted: false,
    playbackRate: 1,
    duration: 30,
    currentTime: 2,
    paused: false,
    playCalls: 0,
    play() {
      this.paused = false;
      this.playCalls += 1;
      return Promise.resolve();
    },
  };
  const controlOptions = {
    onFocus: () => { state.skipFocuses += 1; },
    onEvent: event => { state.skipEvents.push(event.type); },
    onClick: () => { state.skipClicks += 1; },
  };
  const skipButton = createControl({ ...controlOptions, className: 'ytp-ad-skip-button-modern' });
  const fallbackSkipButton = createControl({ ...controlOptions, textContent: 'Skip ads' });
  const shortPlayerSkipButton = createControl({ ...controlOptions, textContent: 'Skip' });
  const navigationSkipButton = createControl({ ...controlOptions, textContent: 'Skip navigation', attributes: { 'aria-label': 'Skip navigation' } });
  const styleParent = {
    append: element => {
      state.styles.push(element);
    },
  };
  const playerElement = createControl({ tagName: 'DIV', attributes: { id: 'movie_player' } });
  Object.defineProperty(playerElement, 'className', {
    get: () => `html5-video-player${state.adShowing && state.playerClassShowing ? ' ad-showing' : ''}`,
  });
  playerElement.nodeType = 1;
  playerElement.appendChild(shortPlayerSkipButton);
  const interruptionToast = {
    nodeType: 1,
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
    matches: selector => selector.includes('tp-yt-paper-toast') || selector.includes('[role="alert"]'),
    querySelectorAll: () => [],
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
        if (state.skipCandidates !== null) { return state.skipCandidates; }
        return state.skipShowing ? [skipButton] : [];
      }
      if (selector === 'button,[role="button"]') {
        if (state.fallbackCandidates !== null) { return state.fallbackCandidates; }
        return [
          state.fallbackSkipShowing ? fallbackSkipButton : null,
          state.shortPlayerSkipShowing ? shortPlayerSkipButton : null,
          state.navigationSkipShowing ? navigationSkipButton : null,
        ].filter(Boolean);
      }
      if (selector.includes('.ad-showing')) {
        return state.adShowing && state.playerClassShowing ? [{ className: 'ad-showing' }] : [];
      }
      if (selector === '.html5-video-player,#movie_player') {
        return [playerElement];
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
    setTimeout: handler => {
      state.timeoutCallbacks.push(handler);
      return state.timeoutCallbacks.length;
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    MouseEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: class {
      constructor(handler) {
        this.handler = handler;
      }
      observe(target, options) {
        if (options?.attributes) {
          state.playerObserverCallback = this.handler;
          state.playerObserverOptions = options;
          return;
        }
        state.observerCallback = this.handler;
        state.observerOptions = options;
      }
      disconnect() {
        state.observerCallback = null;
        state.playerObserverCallback = null;
      }
    },
  };
  context.globalThis = context;
  return { context, interruptionToast, state, video, playerElement, shortPlayerSkipButton };
}

test('YouTube ad skip speeds ads then restores playback before native Skip without seeking', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.skipShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  state.skipShowing = true;
  controller.tick();
  assert.equal(state.skipClicks, 1);
  assert.equal(state.skipEvents.includes('click'), true);
  assert.equal(state.skipFocuses, 1);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.currentTime, 2);
  assert.equal(state.styles.length, 1);
  assert.equal(state.styles[0].id, 'talon-youtube-ad-skip-style');

  state.adShowing = false;
  state.skipShowing = false;
  assert.equal(controller.tick(), false);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip recognizes visible ad indicators when ad-showing class is absent', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.playerClassShowing = false;
  state.skipShowing = false;
  state.fallbackSkipShowing = true;
  video.paused = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.paused, true);
  assert.equal(video.playCalls, 0);
});

test('Skip that immediately resumes content does not accelerate content or show stale feedback', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  for (const wasAccelerating of [false, true]) {
    const { context, state, video } = createHarness();
    const feedback = [];
    context.TalonYoutubeAdFeedbackController = {
      setActive(value, options) { feedback.push({ active: value === true, mode: options?.mode }); },
      stop(options) { feedback.push({ active: false, mode: options?.mode }); },
    };
    video.playbackRate = 1.5;
    state.skipShowing = false;
    vm.runInNewContext(source, context);
    const controller = context.__talonYoutubeAdSkipCreateController(context);
    if (wasAccelerating) {
      controller.tick();
      assert.equal(video.playbackRate, 16);
      feedback.length = 0;
    }
    const skip = createControl({
      className: 'ytp-ad-skip-button',
      onClick() {
        state.adShowing = false;
        state.skipShowing = false;
        state.skipCandidates = [];
        skip.hidden = true;
      },
    });
    state.skipCandidates = [skip];
    controller.tick();
    assert.equal(video.playbackRate, 1.5, `previous acceleration: ${wasAccelerating}`);
    assert.equal(video.muted, false);
    assert.equal(video.currentTime, 2);
    assert.equal(feedback.some(call => call.active), false);
  }
});

test('YouTube ad skip accepts labeled fallback skip controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.fallbackSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(state.skipClicks, 1);
  assert.equal(state.skipEvents.includes('click'), true);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('Skip hands normal media state to the native handler and tolerates delayed ad UI teardown', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  let now = 10000;
  context.Date = { now: () => now };
  state.skipShowing = false;
  video.playbackRate = 1.5;
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  controller.tick();
  assert.equal(video.playbackRate, 16);
  let clicks = 0;
  const skip = createControl({ className: 'ytp-ad-skip-button', onClick() {
    clicks++;
    assert.equal(video.playbackRate, 1.5, 'native Skip must see the user rate');
    assert.equal(video.muted, false, 'native Skip must see the user mute state');
    skip.hidden = true;
    video.paused = true; // Native player is switching from ad to content.
  } });
  state.skipCandidates = [skip];
  controller.tick();
  now += 500;
  controller.tick();
  assert.equal(clicks, 1);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.muted, false);
  assert.equal(video.playCalls, 0, 'do not issue play while the native transition is pending');
  state.adShowing = false;
  state.skipCandidates = [];
  now += 300;
  controller.tick();
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.currentTime, 2);
  // The next genuine ad is handled immediately after content has returned.
  state.adShowing = true;
  controller.tick();
  assert.equal(video.playbackRate, 16);
  controller.stop();
  assert.equal(video.playbackRate, 1.5);
});

test('An ineffective Skip gets bounded retries and cannot permanently suspend ad handling', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  let now = 10000;
  context.Date = { now: () => now };
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  controller.tick();
  now += 999;
  controller.tick();
  assert.equal(state.skipClicks, 1);
  now += 1;
  controller.tick();
  assert.equal(state.skipClicks, 1);
  assert.equal(video.playbackRate, 16, 'a visible no-op button must not starve acceleration');
  now += 500;
  controller.tick();
  assert.equal(state.skipClicks, 2);
  state.skipShowing = false;
  now += 1000;
  controller.tick();
  assert.equal(video.playbackRate, 16);
  assert.equal(video.muted, true);
  controller.stop();
  assert.equal(video.playbackRate, 1);
});

test('Feedback stays active through acceleration, Skip handoffs and the next ad until content returns', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  let now = 10000;
  const feedback = [];
  context.Date = { now: () => now };
  context.TalonYoutubeAdFeedbackController = {
    setActive(value) { feedback.push(value); },
    stop() { feedback.push(false); },
  };
  state.skipShowing = false;
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  controller.tick();
  assert.equal(video.playbackRate, 16);
  for (let ad = 0; ad < 2; ad++) {
    let clicks = 0;
    const button = createControl({ className: 'ytp-ad-skip-button', onClick() {
      clicks++;
      button.hidden = true;
    } });
    state.skipCandidates = [button];
    controller.tick();
    assert.equal(clicks, 1);
    assert.equal(video.playbackRate, 1, 'native Skip still receives restored media');
    now += 500;
    controller.tick();
    assert.equal(video.playbackRate, 1, 'native handoff remains protected');
    now += 500;
    controller.tick();
    assert.equal(video.playbackRate, 16, 'next ad or no-op recovery resumes acceleration');
  }
  assert.ok(feedback.length > 4);
  assert.equal(feedback.every(Boolean), true, 'no false/true cycles while ads remain');
  state.adShowing = false;
  state.skipCandidates = [];
  controller.tick();
  assert.equal(feedback.at(-1), false, 'remove feedback when content returns');
  assert.equal(video.playbackRate, 1);
  controller.stop();
  assert.equal(feedback.at(-1), false);
});

test('Skip requests the native page callback once and does not also send a rejected DOM click', async () => {
  const source=await readSource('js/scripting/youtube-ad-skip.js');
  const {context,state,video}=createHarness();
  state.skipShowing=false;
  context.CustomEvent=class { constructor(type) { this.type=type; } };
  vm.runInNewContext(source,context);
  const controller=context.__talonYoutubeAdSkipCreateController(context);
  controller.tick();
  assert.equal(video.playbackRate,16);
  let requests=0;
  const button=createControl({className:'ytp-skip-ad-button'});
  button.dispatchEvent=event=> {
    assert.equal(event.type,'talon-youtube-native-skip');
    assert.equal(video.playbackRate,1);
    requests++;
    state.adShowing=false;
    state.skipCandidates=[];
    return false;
  };
  state.skipCandidates=[button];
  controller.tick();
  assert.equal(requests,1);
  assert.equal(state.skipClicks,0);
  assert.equal(state.skipEvents.length,0);
  assert.equal(video.playbackRate,1);
});

test('YouTube ad skip ignores plain Skip controls without an ad-specific label or class', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.shortPlayerSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), false);
  assert.equal(state.skipClicks, 0);
  assert.equal(state.skipEvents.length, 0);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip accepts exact Skip only inside the player showing an ad', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state } = createHarness();
  state.skipShowing = false;
  state.shortPlayerSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  controller.tick();
  assert.equal(state.skipClicks, 1);
  assert.equal(state.skipEvents.filter(type => type === 'click').length, 1);
});

test('YouTube ad skip ignores exact Skip outside the ad player or inside a different player', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  for (const outsidePlayer of [true, false]) {
    const { context, state, shortPlayerSkipButton } = createHarness();
    state.skipShowing = false;
    state.shortPlayerSkipShowing = true;
    shortPlayerSkipButton.parentElement = outsidePlayer
      ? null
      : createControl({ tagName: 'DIV', className: 'html5-video-player' });
    vm.runInNewContext(source, context);
    context.__talonYoutubeAdSkipCreateController(context).tick();
    assert.equal(state.skipClicks, 0, outsidePlayer ? 'outside player' : 'different player');
    assert.equal(state.skipEvents.length, 0);
  }
});

test('YouTube ad skip ignores Skip navigation and countdown text inside an ad player', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  for (const textContent of ['Skip navigation', 'Skip in 5', 'Skip intro']) {
    const { context, state, shortPlayerSkipButton } = createHarness();
    state.skipShowing = false;
    state.shortPlayerSkipShowing = true;
    shortPlayerSkipButton.textContent = textContent;
    vm.runInNewContext(source, context);
    context.__talonYoutubeAdSkipCreateController(context).tick();
    assert.equal(state.skipClicks, 0, textContent);
    assert.equal(state.skipEvents.length, 0);
  }
});

test('YouTube ad skip does not let matching noninteractive slots starve the real button', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  for (const textContent of ['', 'Skip in 5']) {
    const { context, state } = createHarness();
    let realClicks = 0;
    let slotEvents = 0;
    const slot = createControl({ tagName: 'DIV', className: 'ytp-ad-skip-button-slot', textContent, onEvent: () => { slotEvents += 1; } });
    const button = createControl({ className: 'ytp-ad-skip-button-modern', textContent: 'Skip', onEvent: event => { if (event.type === 'click') realClicks += 1; } });
    state.skipCandidates = [slot, button];
    vm.runInNewContext(source, context);
    context.__talonYoutubeAdSkipCreateController(context).tick();
    assert.equal(realClicks, 1, textContent || 'empty slot');
    assert.equal(slotEvents, 0);
  }
});

test('YouTube ad skip chooses the actionable child when a wrapper starts with hidden or disabled controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  for (const unavailable of ['hidden', 'disabled']) {
    const { context, state } = createHarness();
    let unavailableEvents = 0;
    let visibleClicks = 0;
    let wrapperEvents = 0;
    const wrapper = createControl({ tagName: 'DIV', className: 'ytp-ad-skip-button-container', onEvent: () => { wrapperEvents += 1; } });
    wrapper.appendChild(createControl({ [unavailable]: true, textContent: 'Skip in 5', onEvent: () => { unavailableEvents += 1; } }));
    wrapper.appendChild(createControl({ textContent: 'Skip', onEvent: event => { if (event.type === 'click') visibleClicks += 1; } }));
    state.skipCandidates = [wrapper];
    vm.runInNewContext(source, context);
    context.__talonYoutubeAdSkipCreateController(context).tick();
    assert.equal(visibleClicks, 1, unavailable);
    assert.equal(unavailableEvents, 0, unavailable);
    assert.equal(wrapperEvents, 0);
  }
});

test('YouTube ad skip dispatches one click for a wrapper and child matched together', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state } = createHarness();
  let clicks = 0;
  const wrapper = createControl({ tagName: 'DIV', className: 'ytp-ad-skip-button-container' });
  const button = wrapper.appendChild(createControl({ className: 'ytp-ad-skip-button-modern', textContent: 'Skip', onEvent: event => { if (event.type === 'click') clicks += 1; } }));
  state.skipCandidates = [wrapper, button];
  vm.runInNewContext(source, context);
  context.__talonYoutubeAdSkipCreateController(context).tick();
  assert.equal(clicks, 1);
});

test('YouTube ad skip preserves legacy roleless native skip controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state } = createHarness();
  let clicks = 0;
  state.skipCandidates = [createControl({ tagName: 'DIV', className: 'ytp-ad-skip-button', textContent: 'Skip', onEvent: event => { if (event.type === 'click') clicks += 1; } })];
  vm.runInNewContext(source, context);
  context.__talonYoutubeAdSkipCreateController(context).tick();
  assert.equal(clicks, 1);
});

test('YouTube ad skip ignores non-ad skip navigation controls', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
  state.navigationSkipShowing = true;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), false);
  assert.equal(state.skipClicks, 0);
  assert.equal(state.skipEvents.length, 0);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
});

test('YouTube ad skip does not seek the player and trigger short-video restart loops', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  video.duration = 45;
  video.currentTime = 0;
  state.skipShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);

  video.currentTime = 0;
  assert.equal(controller.tick(), true);
  assert.equal(video.currentTime, 0);
  assert.equal(state.skipClicks, 0);
  assert.equal(video.playbackRate, 16);
});

test('YouTube ad skip avoids broad document mutation work and coalesces player churn', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state } = createHarness();
  state.skipShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  assert.equal(state.observerOptions, null);
  assert.equal(state.observerCallback, null);
  assert.equal(state.playerObserverOptions.attributes, true);
  assert.equal(Array.from(state.playerObserverOptions.attributeFilter).join(','), 'class');

  state.skipClicks = 0;
  state.playerObserverCallback();
  state.playerObserverCallback();

  assert.equal(state.timeoutCallbacks.length, 1);
  assert.equal(state.skipClicks, 0);

  state.timeoutCallbacks.shift()();
  assert.equal(state.skipClicks, 0);
});

test('YouTube ad skip hides interruption notices added by YouTube before the next full scan', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, interruptionToast, state } = createHarness();
  state.adShowing = false;
  vm.runInNewContext(source, context);

  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  state.hiddenInterruptions = 0;
  state.skipShowing = false;

  assert.equal(controller.suppressInterruptionNoticeNodes([{
    addedNodes: [interruptionToast],
  }]), true);
  assert.equal(interruptionToast.hidden, true);
  assert.equal(state.hiddenInterruptions > 0, true);
});

test('YouTube ad skip suppresses only the matching interruptions notice', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  state.adShowing = false;
  state.skipShowing = false;
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
  assert.match(source, /dispatchSkipActivationEvents/);
  assert.match(source, /MouseEvent/);
  assert.match(source, /\.click\(\)/);
  assert.match(source, /ytd-ad-slot-renderer/);
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
  assert.match(managerSource, /getYouTubeRegistrationScopes/);
  assert.match(managerSource, /const getScriptletExcludedHostnames = \( \) => YOUTUBE_AD_SKIP_HOSTNAMES;/);
  assert.match(managerSource, /function registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /registerYouTubeAdSkip\(context\)/);
  assert.match(managerSource, /excludeMatches\.push\(\.\.\.ut\.matchesFromHostnames\(scriptletExcludedHostnames\)\)/);
  assert.match(managerSource, /targetHostnames = ut\.subtractHostnameIters\(\s*targetHostnames,\s*scriptletExcludedHostnames\s*\);/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-ad-skip\.js"/);
  assert.match(ownershipSource, /"js\/scripting\/youtube-player-guard\.js"/);
});


test('YouTube ad skip remains stopped after queued callbacks, navigation, and visibility changes', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, state, video } = createHarness();
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  await controller.start();
  controller.scheduleTick();
  const queued = state.timeoutCallbacks.slice();
  const listeners = state.listeners.slice();
  controller.stop();
  const clicks = state.skipClicks;
  for (const run of queued) run();
  for (const entry of listeners) (entry.handler || entry.callback)?.();
  assert.equal(controller.tick(), false);
  assert.equal(controller.isActive(), false);
  assert.equal(state.skipClicks, clicks);
  assert.equal(video.currentTime, 2);
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1);
  await controller.start();
  assert.equal(controller.isActive(), true);
});

test('YouTube ad skip stop invalidates a pending start and preserves newer user media choices', async () => {
  const source = await readSource('js/scripting/youtube-ad-skip.js');
  const { context, video } = createHarness();
  let ready;
  context.TalonBreakageGuard = { whenReady: () => new Promise(resolve => { ready = resolve; }), shouldRunSubsystem: () => true };
  vm.runInNewContext(source, context);
  const controller = context.__talonYoutubeAdSkipCreateController(context);
  const pending = controller.start();
  controller.stop(); ready();
  assert.equal((await pending).started, false);
  delete context.TalonBreakageGuard;
  await controller.start();
  video.muted = false; video.playbackRate = 1.5;
  controller.stop();
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1.5);
});

const matchesYouTubeScope = (scopes, host) => scopes.some(scope => {
  const accepts = pattern => {
    const root = pattern.slice(4, -2);
    return root.startsWith('*.')
      ? host === root.slice(2) || host.endsWith(root.slice(1))
      : host === root;
  };
  return scope.matches.some(accepts) && !scope.excludeMatches.some(accepts);
});

test('YouTube registration keeps parent opt-outs authoritative over enabled descendants', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = { optimal: new Set(['all-urls']), none: new Set(['www.youtube.com']) };
  let scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'youtube-nocookie.com'), true);
  modes.optimal.add('embedded.www.youtube.com');
  scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'embedded.www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'deep.embedded.www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'other.www.youtube.com'), false);
  scopes = getYouTubeRegistrationScopes({ none: new Set(['all-urls']), basic: new Set(['m.youtube.com']) });
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'child.m.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(getYouTubeRegistrationScopes(modes, ['youtube.com']), 'embedded.www.youtube.com'), false);
});

test('YouTube registration follows BASIC fallback and only the authoritative all-urls sentinel', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  for (const modes of [{}, { basic: ['all-urls'] }, { complete: ['all-urls'] }]) {
    const scopes = getYouTubeRegistrationScopes(modes);
    for (const host of ['youtube.com', 'www.youtube.com', 'deep.m.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']) {
      assert.equal(matchesYouTubeScope(scopes, host), true, host);
    }
    for (const host of ['example.com', 'notyoutube.com', 'youtube.com.example.com', 'notyoutube-nocookie.com']) {
      assert.equal(matchesYouTubeScope(scopes, host), false, host);
    }
  }
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['all-urls'], optimal: ['all-urls'] }), []);
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['*'] }), []);
  assert.equal(matchesYouTubeScope(getYouTubeRegistrationScopes({ none: ['all-urls', '*'], basic: ['m.youtube.com'] }), 'm.youtube.com'), true);
  assert.deepEqual(getYouTubeRegistrationScopes({ none: ['com'], complete: ['youtube.com'] }), []);
});

test('YouTube registration preserves exact entries when global sentinels skip ancestor walks', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = {
    none: ['all-urls', 'www.youtube.com'],
    basic: ['youtube.com'],
  };
  let scopes = getYouTubeRegistrationScopes(modes);
  assert.equal(matchesYouTubeScope(scopes, 'youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'child.www.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'youtube-nocookie.com'), false);
  scopes = getYouTubeRegistrationScopes({ none: ['all-urls'], basic: ['all-urls', 'm.youtube.com'] });
  assert.equal(matchesYouTubeScope(scopes, 'm.youtube.com'), true);
  assert.equal(matchesYouTubeScope(scopes, 'child.m.youtube.com'), false);
  assert.equal(matchesYouTubeScope(scopes, 'www.youtube.com'), false);
});

test('YouTube subsystem suppression dominates exact and descendant enabled scopes', async () => {
  const { getYouTubeRegistrationScopes } = await import('../js/youtube-registration.js');
  const modes = { none: ['all-urls', 'www.youtube.com'], basic: ['youtube.com', 'youtube-nocookie.com'] };
  const scopes = getYouTubeRegistrationScopes(modes, ['www.youtube.com', 'embedded.youtube-nocookie.com']);
  for (const host of ['www.youtube.com', 'child.www.youtube.com', 'embedded.youtube-nocookie.com', 'deep.embedded.youtube-nocookie.com']) {
    assert.equal(matchesYouTubeScope(scopes, host), false, host);
  }
  for (const host of ['m.youtube.com', 'youtube-nocookie.com', 'other.youtube-nocookie.com']) {
    assert.equal(matchesYouTubeScope(scopes, host), true, host);
  }
});


test('YouTube ad skip does not restart a legacy controller during update', async () => {
  const source = await fs.readFile(new URL('../js/scripting/youtube-ad-skip.js', import.meta.url), 'utf8');
  let refreshed = false;
  const context = vm.createContext({ TalonYoutubeAdSkipController: { refresh() { refreshed = true; } } });
  vm.runInContext(source, context);
  assert.equal(refreshed, false);
  assert.equal(context.TalonYoutubeAdSkipController.revision, undefined);
});
