import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor() {
    this.id = '';
    this.className = '';
  }

  matches() {
    return false;
  }

  querySelectorAll() {
    return [];
  }

  getBoundingClientRect() {
    return {
      width: 120,
      height: 40,
    };
  }
}

const storageData = Object.create(null);

const makeStorageArea = data => ({
  async get(key) {
    if (typeof key === 'string') {
      return Object.hasOwn(data, key)
        ? { [key]: structuredClone(data[key]) }
        : {};
    }
    return {};
  },
});

const loadGuard = async ({
  hostname = 'example.com',
  pathname = '/',
} = {}) => {
  const browserStub = {
    runtime: {
      async sendMessage() {
        return undefined;
      },
    },
    storage: {
      local: makeStorageArea(storageData),
    },
  };
  globalThis.self = globalThis;
  globalThis.browser = browserStub;
  globalThis.chrome = browserStub;
  globalThis.location = { hostname, pathname };
  globalThis.Element = FakeElement;
  globalThis.DocumentFragment = class DocumentFragment {};
  globalThis.NodeFilter = { SHOW_ELEMENT: 1 };
  globalThis.document = {
    readyState: 'complete',
    documentElement: new FakeElement(),
    body: new FakeElement(),
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createTreeWalker() {
      return {
        nextNode() {
          return false;
        },
        currentNode: null,
      };
    },
  };
  globalThis.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    overflow: 'visible',
    position: 'static',
  });
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  delete globalThis.TalonBreakageGuard;
  await import(
    new URL(`../js/scripting/breakage-guard.js?test=${Math.random()}`, import.meta.url)
  );
  return globalThis.TalonBreakageGuard;
};

test('breakage guard allows protected exact-host hide directives', async () => {
  const guard = await loadGuard({
    hostname: 'accounts.google.com',
    pathname: '/',
  });
  const directive = {
    id: 'protected-hide',
    category: 'annoyances',
    action: 'hide',
    hosts: ['=accounts.google.com'],
    selectors: ['.promo-banner'],
  };

  assert.equal(guard.shouldAllowDirective(directive), true);
});

test('breakage guard rejects protected non-hide directives', async () => {
  const guard = await loadGuard({
    hostname: 'accounts.google.com',
    pathname: '/',
  });
  const directive = {
    id: 'protected-click',
    category: 'annoyances',
    action: 'click',
    hosts: ['=accounts.google.com'],
    selectors: ['.promo-banner'],
  };

  assert.equal(guard.shouldAllowDirective(directive), false);
});

test('breakage guard rejects protected wildcard hosts', async () => {
  const guard = await loadGuard({
    hostname: 'accounts.google.com',
    pathname: '/',
  });
  const directive = {
    id: 'protected-wildcard',
    category: 'annoyances',
    action: 'hide',
    hosts: ['*.google.com'],
    selectors: ['.promo-banner'],
  };

  assert.equal(guard.shouldAllowDirective(directive), false);
});
