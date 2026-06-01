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

test('YouTube player guard prunes ad metadata from initial player globals', async () => {
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

  assert.equal(context.ytInitialPlayerResponse.adPlacements, undefined);
  assert.equal(context.ytInitialPlayerResponse.adSlots, undefined);
  assert.equal(context.ytInitialPlayerResponse.playerAds, undefined);
  assert.deepEqual(context.ytInitialPlayerResponse.streamingData, {
    adaptiveFormats: [{ itag: 137 }],
  });
  assert.equal(context.ytInitialPlayerResponse.nested.playerResponse.adPlacements, undefined);
  assert.equal(context.ytInitialPlayerResponse.nested.playerResponse.keep, true);
});

test('YouTube player guard limits JSON.parse pruning to Shorts entries', async () => {
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

  assert.equal(shortsParsed.playerResponse.adPlacements, undefined);
  assert.equal(shortsParsed.playerResponse.playerAds, undefined);
  assert.equal(shortsParsed.playerResponse.keep, 'video');
  assert.equal(shortsParsed.contents.length, 1);
  assert.equal(
    shortsParsed.contents[0].reelItemRenderer.navigationEndpoint.reelWatchEndpoint.videoId,
    'real-short'
  );
});

test('YouTube player guard sanitizes player fetch responses only on YouTube player endpoints', async () => {
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

  assert.equal(body.adPlacements, undefined);
  assert.equal(body.playerResponse.adSlots, undefined);
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

test('YouTube player guard suppresses YouTube abnormality reset callbacks', async () => {
  const { context, controller } = await createController();
  let abnormalityRan = false;
  let normalRan = false;
  function onAbnormalityDetected() {
    abnormalityRan = true;
  }
  function normalContinuation() {
    normalRan = true;
  }

  assert.equal(controller.install(), true);
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

test('YouTube player guard bridges guarded fetch into new about:blank iframes', async () => {
  const { context, controller } = await createController();

  assert.equal(controller.install(), true);
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
  assert.match(source, /ytInitialPlayerResponse/);
  assert.match(source, /adPlacements/);
  assert.match(source, /SSAP_NAMESPACE/);
  assert.doesNotMatch(source, /chrome\.runtime|browser\.runtime|runtime\.getURL/);
  assert.doesNotMatch(source, /createElement\(['"]script['"]\)/);
  const privateComparatorToken = String.fromCharCode(99, 111, 102, 102, 101, 101);
  assert.doesNotMatch(source, new RegExp(`analytics|posthog|${privateComparatorToken}-break`, 'i'));
  const httpsPrefix = 'https:' + '//';
  assert.doesNotMatch(source, new RegExp(`${httpsPrefix}analytics|${httpsPrefix}${privateComparatorToken}-break`, 'i'));
});
