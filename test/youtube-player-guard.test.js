import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const youtubeOrigin = `https:${'//'}www.${'youtube.com'}`;

function createHarness(overrides = {}) {
  class HarnessPromise extends Promise {}
  class HarnessNode {
    appendChild(child) {
      this.lastAppended = child;
      return child;
    }
  }
  class HarnessIFrameElement extends HarnessNode {
    constructor(src = 'about:blank') {
      super();
      this.src = src;
      this.originalFetch = async () => new Response('{}');
      this.originalRequest = class FrameRequest {};
      this.contentWindow = {
        fetch: this.originalFetch,
        Request: this.originalRequest,
      };
    }
  }
  class HarnessStorage {
    constructor() {
      this.map = new Map();
    }
    get length() {
      return this.map.size;
    }
    getItem(key) {
      key = String(key);
      return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
      this.map.set(String(key), String(value));
    }
    key(index) {
      return Array.from(this.map.keys())[Number(index)] || null;
    }
    removeItem(key) {
      this.map.delete(String(key));
    }
    clear() {
      this.map.clear();
    }
  }
  const video = {
    currentTime: 0,
    duration: 30,
    loop: true,
  };
  const listeners = [];
  const document = {
    addEventListener: (name, handler) => {
      listeners.push({ name, handler });
    },
    querySelector: selector => (selector === 'video' ? video : null),
  };
  const context = {
    __talonYoutubePlayerGuardTest: true,
    Array: class HarnessArray extends Array {},
    clearInterval: () => {},
    document,
    fetch: async () => new Response('{}', {
      headers: { 'content-type': 'application/json' },
      status: 200,
      statusText: 'OK',
    }),
    location: {
      hostname: 'www.youtube.com',
      href: `${youtubeOrigin}/watch?v=test`,
      pathname: '/watch',
    },
    setInterval: () => 1,
    setTimeout: () => 1,
    addEventListener: () => {},
    Date,
    JSON: {
      parse: JSON.parse,
      stringify: JSON.stringify,
    },
    Promise: HarnessPromise,
    Proxy,
    Reflect,
    Node: HarnessNode,
    HTMLIFrameElement: HarnessIFrameElement,
    Storage: HarnessStorage,
    localStorage: new HarnessStorage(),
    sessionStorage: new HarnessStorage(),
    Request,
    Response,
    URL,
    WeakMap,
    WeakSet,
    XMLHttpRequest: undefined,
    ...overrides,
  };
  context.window = context;
  context.globalThis = context;
  return { context, document, listeners, video };
}

async function createController(overrides = {}) {
  const source = await readSource('js/scripting/youtube-player-guard.js');
  const harness = createHarness(overrides);
  vm.runInNewContext(source, harness.context);
  const controller = harness.context.__talonYoutubePlayerGuardCreateController(harness.context);
  return { ...harness, controller, source };
}

test('YouTube player guard leaves initial player ad metadata intact during install', async () => {
  const { context, controller } = await createController();

  assert.equal(controller.install(), true);
  context.ytInitialPlayerResponse = {
    adPlacements: [{ id: 'pre' }],
    adSlots: [{ id: 'slot' }],
    playerAds: [{ id: 'player' }],
    streamingData: { adaptiveFormats: [{ itag: 137 }] },
    nested: {
      playerResponse: {
        adPlacements: [{ id: 'nested' }],
        keep: true,
      },
    },
  };

  assert.deepEqual(context.ytInitialPlayerResponse.adPlacements, [{ id: 'pre' }]);
  assert.deepEqual(context.ytInitialPlayerResponse.adSlots, [{ id: 'slot' }]);
  assert.deepEqual(context.ytInitialPlayerResponse.playerAds, [{ id: 'player' }]);
  assert.deepEqual(context.ytInitialPlayerResponse.streamingData, {
    adaptiveFormats: [{ itag: 137 }],
  });
  assert.deepEqual(context.ytInitialPlayerResponse.nested.playerResponse.adPlacements, [{ id: 'nested' }]);
  assert.equal(context.ytInitialPlayerResponse.nested.playerResponse.keep, true);
});

test('YouTube player guard does not patch JSON.parse for player ad metadata', async () => {
  const { context, controller } = await createController();

  assert.equal(controller.install(), true);
  const watchParsed = context.JSON.parse(JSON.stringify({
    playerResponse: {
      adPlacements: [{ id: 'ad' }],
      playerAds: [{ id: 'player-ad' }],
      keep: 'video',
    },
  }));

  assert.deepEqual(watchParsed.playerResponse.adPlacements, [{ id: 'ad' }]);
  assert.deepEqual(watchParsed.playerResponse.playerAds, [{ id: 'player-ad' }]);
  assert.equal(watchParsed.playerResponse.keep, 'video');

  context.location.pathname = '/shorts/test';
  context.location.href = `${youtubeOrigin}/shorts/test`;
  const shortsParsed = context.JSON.parse(JSON.stringify({
    contents: [
      {
        reelItemRenderer: {
          navigationEndpoint: {
            reelWatchEndpoint: {
              adClientParams: { isAd: true },
            },
          },
        },
      },
      {
        reelItemRenderer: {
          navigationEndpoint: {
            reelWatchEndpoint: {
              videoId: 'real-short',
            },
          },
        },
      },
    ],
    playerResponse: {
      adPlacements: [{ id: 'ad' }],
      playerAds: [{ id: 'player-ad' }],
      keep: 'video',
    },
  }));

  assert.deepEqual(shortsParsed.playerResponse.adPlacements, [{ id: 'ad' }]);
  assert.deepEqual(shortsParsed.playerResponse.playerAds, [{ id: 'player-ad' }]);
  assert.equal(shortsParsed.playerResponse.keep, 'video');
  assert.equal(shortsParsed.contents.length, 2);
  assert.equal(
    shortsParsed.contents[1].reelItemRenderer.navigationEndpoint.reelWatchEndpoint.videoId,
    'real-short'
  );
});

test('YouTube player guard leaves player fetch responses intact', async () => {
  const { context, controller } = await createController({
    fetch: async url => new Response(JSON.stringify({
      adPlacements: [{ id: 'top' }],
      playerResponse: {
        adSlots: [{ id: 'slot' }],
        streamingData: { formats: [{ itag: 18 }] },
      },
      url,
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
      statusText: 'OK',
    }),
  });

  assert.equal(controller.install(), true);
  const response = await context.fetch(`${youtubeOrigin}/youtubei/v1/player?key=x`);
  const body = await response.json();

  assert.deepEqual(body.adPlacements, [{ id: 'top' }]);
  assert.deepEqual(body.playerResponse.adSlots, [{ id: 'slot' }]);
  assert.deepEqual(body.playerResponse.streamingData, {
    formats: [{ itag: 18 }],
  });
  assert.equal(
    controller.isPlayerResponseUrl(`${youtubeOrigin}/youtubei/v1/player/ad_break`),
    true
  );
  assert.equal(
    controller.isPlayerResponseUrl(`${youtubeOrigin}/youtubei/v1/player/get_drm_license`),
    false
  );
});

test('YouTube player guard returns player fetch responses without wrapping or pre-reading the body', async () => {
  let jsonReads = 0;
  let textReads = 0;
  let cloneReads = 0;
  class CountingResponse extends Response {
    json() {
      jsonReads += 1;
      return super.json();
    }
    text() {
      textReads += 1;
      return super.text();
    }
    clone() {
      cloneReads += 1;
      return super.clone();
    }
  }
  const { context, controller } = await createController({
    Response: CountingResponse,
    fetch: async url => new CountingResponse(JSON.stringify({
      adPlacements: [{ id: 'pre' }],
      streamingData: { formats: [{ itag: 18 }] },
      url,
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
      statusText: 'OK',
    }),
  });

  assert.equal(controller.install(), true);
  const response = await context.fetch(`${youtubeOrigin}/youtubei/v1/player?key=x`);

  assert.equal(jsonReads, 0);
  assert.equal(textReads, 0);
  assert.equal(cloneReads, 0);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(jsonReads, 1);
  assert.equal(textReads, 0);
  assert.equal(cloneReads, 0);
  assert.deepEqual(body.adPlacements, [{ id: 'pre' }]);
  assert.deepEqual(body.streamingData, { formats: [{ itag: 18 }] });
});

test('YouTube player guard skips heavy player-response parsing when no ad metadata keys are present', async () => {
  let parseCount = 0;
  const { context, controller } = await createController({
    JSON: {
      parse(text) {
        parseCount += 1;
        return JSON.parse(text);
      },
      stringify: JSON.stringify,
    },
    fetch: async url => new Response(JSON.stringify({
      streamingData: { formats: [{ itag: 18 }] },
      videoDetails: { videoId: 'clean' },
      url,
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
      statusText: 'OK',
    }),
  });

  assert.equal(controller.install(), true);
  const response = await context.fetch(`${youtubeOrigin}/youtubei/v1/player?key=x`);
  const body = await response.json();

  assert.equal(parseCount, 0);
  assert.deepEqual(body.streamingData, { formats: [{ itag: 18 }] });
  assert.equal(controller.textMayContainAdMetadata(JSON.stringify(body)), false);
});

test('YouTube player guard corrects only the armed SSAP restart loop shape', async () => {
  const withoutExperiment = await createController();

  assert.equal(withoutExperiment.controller.recordSsapRange({
    namespace: 'ssap',
    start: 0,
    end: 10000,
    id: 'ad-start',
  }), false);

  const { controller, video } = await createController({
    yt: {
      config_: {
        EXPERIMENT_FLAGS: {
          html5_enable_ssap_entity_id: true,
        },
      },
    },
  });

  assert.equal(controller.recordSsapRange({
    namespace: 'ssap',
    start: 10000,
    end: 30000,
    id: 'ad-break',
  }), false);
  assert.equal(controller.recordSsapRange({
    namespace: 'ssap',
    start: 0,
    end: 10000,
    id: 'ad-start',
  }), true);
  assert.equal(controller.recordSsapRange({
    namespace: 'ssap',
    start: 10000,
    end: 30000,
    id: 'ad-break',
  }), true);

  video.currentTime = 0;
  video.duration = 30;
  video.loop = true;
  assert.equal(controller.correctSsapLoop(), true);
  assert.ok(video.currentTime >= 10);
  assert.equal(video.loop, true);

  video.currentTime = 0;
  video.duration = 50;
  video.loop = true;
  assert.equal(controller.correctSsapLoop(), false);
  assert.equal(video.currentTime, 0);
});

test('YouTube player guard installs the global SSAP array hook only when the SSAP experiment is enabled', async () => {
  const { context, controller } = await createController();
  const nativePush = context.Array.prototype.push;

  assert.equal(controller.installSsapGuard(), false);
  assert.strictEqual(context.Array.prototype.push, nativePush);

  context.yt = {
    config_: {
      EXPERIMENT_FLAGS: {
        html5_enable_ssap_entity_id: true,
      },
    },
  };

  assert.equal(controller.installSsapGuard(), true);
  assert.notStrictEqual(context.Array.prototype.push, nativePush);

  const installedPush = context.Array.prototype.push;
  assert.equal(controller.installSsapGuard(), true);
  assert.strictEqual(context.Array.prototype.push, installedPush);
});

test('YouTube player guard keeps high-volume page hooks opt-in by default', async () => {
  const { context, controller } = await createController();
  const nativeArrayPush = context.Array.prototype.push;
  const nativePromiseThen = context.Promise.prototype.then;
  const nativeAppendChild = context.Node.prototype.appendChild;

  assert.equal(controller.install(), true);

  assert.strictEqual(context.Array.prototype.push, nativeArrayPush);
  assert.strictEqual(context.Promise.prototype.then, nativePromiseThen);
  assert.strictEqual(context.Node.prototype.appendChild, nativeAppendChild);
  assert.equal(controller.getAbnormalityGuardStats().installed, false);
});

test('YouTube player guard can explicitly suppress YouTube abnormality reset callbacks', async () => {
  const { context, controller } = await createController();
  let abnormalityRan = false;
  let normalRan = false;
  function onAbnormalityDetected() {
    abnormalityRan = true;
  }
  function normalContinuation() {
    normalRan = true;
  }

  assert.equal(controller.installAbnormalityGuard(), true);
  let stats = controller.getAbnormalityGuardStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.hits, 0);

  await context.Promise.resolve('x').then(onAbnormalityDetected);
  await context.Promise.resolve('x').then(normalContinuation);

  assert.equal(abnormalityRan, false);
  assert.equal(normalRan, true);
  stats = controller.getAbnormalityGuardStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.hits, 1);
});

test('YouTube player guard reset-lite shields enforcement storage without deleting user data', async () => {
  const { context, controller } = await createController();

  context.localStorage.setItem('yt-player-volume', '75');
  context.localStorage.setItem('yt-player-quality', 'hd1080');
  context.localStorage.setItem('yt-adblock-enforcement', 'wall');
  context.localStorage.setItem('playback_blocked_by_adblock', '1');
  context.sessionStorage.setItem('yt-player-session', 'keep');
  context.sessionStorage.setItem('blocker_detected_state', '1');

  assert.equal(controller.install(), true);
  let stats = controller.getStorageResetLiteStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.reads, 0);
  assert.equal(stats.writes, 0);

  assert.equal(context.localStorage.getItem('yt-player-volume'), '75');
  assert.equal(context.localStorage.getItem('yt-player-quality'), 'hd1080');
  assert.equal(context.sessionStorage.getItem('yt-player-session'), 'keep');
  assert.equal(context.localStorage.getItem('yt-adblock-enforcement'), null);
  assert.equal(context.localStorage.getItem('playback_blocked_by_adblock'), null);
  assert.equal(context.sessionStorage.getItem('blocker_detected_state'), null);

  context.localStorage.setItem('yt-adblock-enforcement', 'new-wall');
  context.localStorage.setItem('yt-player-volume', '80');

  assert.equal(context.localStorage.map.get('yt-adblock-enforcement'), 'wall');
  assert.equal(context.localStorage.getItem('yt-player-volume'), '80');
  assert.deepEqual(
    [0, 1, 2, 3].map(index => context.localStorage.key(index)).filter(Boolean),
    ['yt-player-volume', 'yt-player-quality']
  );
  stats = controller.getStorageResetLiteStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.reads, 3);
  assert.equal(stats.writes, 1);
});

test('YouTube player guard accelerates only the native 17-second detector timer', async () => {
  const scheduledTimers = [];
  const { context, controller } = await createController({
    setTimeout(callback, delay, ...args) {
      scheduledTimers.push({ callback, delay, args });
      return scheduledTimers.length;
    },
  });
  function nativeLookingCallback() {}
  nativeLookingCallback.toString = () => 'function check() { [native code] }';
  function normalCallback() {}

  assert.equal(controller.install(), true);
  let stats = controller.getDetectorTimerGuardStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.hits, 0);

  context.setTimeout(nativeLookingCallback, 17000, 'detector');
  context.setTimeout(normalCallback, 17000, 'normal');
  context.setTimeout(nativeLookingCallback, 16000, 'other-delay');

  assert.equal(scheduledTimers[0].delay, 17);
  assert.deepEqual(scheduledTimers[0].args, ['detector']);
  assert.equal(scheduledTimers[1].delay, 17000);
  assert.equal(scheduledTimers[2].delay, 16000);
  stats = controller.getDetectorTimerGuardStats();
  assert.equal(stats.installed, true);
  assert.equal(stats.hits, 1);
});

test('YouTube player guard can explicitly bridge guarded fetch into new about:blank iframes', async () => {
  const { context, controller } = await createController();
  const nativeAppendChild = context.Node.prototype.appendChild;

  assert.equal(controller.install(), true);
  assert.strictEqual(context.Node.prototype.appendChild, nativeAppendChild);
  assert.equal(controller.installIframeFetchBridge(), true);
  const parent = new context.Node();
  const blankFrame = new context.HTMLIFrameElement('about:blank');
  const remoteFrame = new context.HTMLIFrameElement('https://example.com/frame.html');

  assert.notStrictEqual(blankFrame.contentWindow.fetch, context.fetch);
  context.Node.prototype.appendChild.call(parent, blankFrame);
  context.Node.prototype.appendChild.call(parent, remoteFrame);

  assert.strictEqual(blankFrame.contentWindow.fetch, context.fetch);
  assert.strictEqual(blankFrame.contentWindow.Request, context.Request);
  assert.strictEqual(remoteFrame.contentWindow.fetch, remoteFrame.originalFetch);
  assert.strictEqual(remoteFrame.contentWindow.Request, remoteFrame.originalRequest);
});

test('YouTube player guard is public-safe page-world runtime without remote code', async () => {
  const source = await readSource('js/scripting/youtube-player-guard.js');

  assert.match(source, /talonYoutubePlayerGuard/);
  assert.match(source, /response payloads intact/);
  assert.match(source, /installStorageResetLiteGuard/);
  assert.match(source, /SSAP_NAMESPACE/);
  assert.doesNotMatch(source, /chrome\.runtime|browser\.runtime|runtime\.getURL/);
  assert.doesNotMatch(source, /createElement\(['"]script['"]\)/);
  const privateComparatorToken = String.fromCharCode(99, 111, 102, 102, 101, 101);
  assert.doesNotMatch(source, new RegExp(`analytics|posthog|${privateComparatorToken}-break`, 'i'));
  const httpsPrefix = 'https:' + '//';
  assert.doesNotMatch(source, new RegExp(`${httpsPrefix}analytics|${httpsPrefix}${privateComparatorToken}-break`, 'i'));
});

test('YouTube player guard loader injects only the local page-world guard', async () => {
  const source = await readSource('js/scripting/youtube-player-guard-loader.js');

  assert.match(source, /talonYoutubePlayerGuardLoader/);
  assert.match(source, /YOUTUBE_HOST_RE/);
  assert.match(source, /GUARD_SCRIPT_PATH = 'js\/scripting\/youtube-player-guard\.js'/);
  assert.match(source, /chrome\.runtime\.getURL\(GUARD_SCRIPT_PATH\)/);
  assert.match(source, /createElement\('script'\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /https?:\/\//);
  const privateComparatorToken = String.fromCharCode(99, 111, 102, 102, 101, 101);
  assert.doesNotMatch(source, new RegExp(`analytics|posthog|${privateComparatorToken}-break`, 'i'));
});
