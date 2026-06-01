import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const readSource = relativePath =>
  fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const youtubeOrigin = `https:${'//'}www.${'youtube.com'}`;

function createHarness(overrides = {}) {
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
    },
    setInterval: () => 1,
    addEventListener: () => {},
    Date,
    JSON: {
      parse: JSON.parse,
      stringify: JSON.stringify,
    },
    Promise,
    Proxy,
    Reflect,
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

test('YouTube player guard prunes JSON.parse results and Shorts ad entries', async () => {
  const { context, controller } = await createController();

  assert.equal(controller.install(), true);
  const parsed = context.JSON.parse(JSON.stringify({
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

  assert.equal(parsed.playerResponse.adPlacements, undefined);
  assert.equal(parsed.playerResponse.playerAds, undefined);
  assert.equal(parsed.playerResponse.keep, 'video');
  assert.equal(parsed.contents.length, 1);
  assert.equal(
    parsed.contents[0].reelItemRenderer.navigationEndpoint.reelWatchEndpoint.videoId,
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

test('YouTube player guard corrects only the SSAP restart loop shape', async () => {
  const { controller, video } = await createController();

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
  assert.equal(video.loop, false);

  video.currentTime = 0;
  video.duration = 50;
  video.loop = true;
  assert.equal(controller.correctSsapLoop(), false);
  assert.equal(video.currentTime, 0);
});

test('YouTube player guard is public-safe page-world runtime without remote code', async () => {
  const source = await readSource('js/scripting/youtube-player-guard.js');

  assert.match(source, /talonYoutubePlayerGuard/);
  assert.match(source, /ytInitialPlayerResponse/);
  assert.match(source, /adPlacements/);
  assert.match(source, /SSAP_NAMESPACE/);
  assert.doesNotMatch(source, /chrome\.runtime|browser\.runtime|runtime\.getURL/);
  assert.doesNotMatch(source, /createElement\(['"]script['"]\)/);
  assert.doesNotMatch(source, /analytics|posthog|coffee-break/i);
  assert.doesNotMatch(source, /https:\/\/analytics|https:\/\/coffee-break/i);
});
