import test from 'node:test';
import assert from 'node:assert/strict';

class FakeElement {
  constructor() {
    this.id = '';
    this.className = '';
    this.tagName = 'DIV';
    this.nodeType = 1;
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
  treeNodes = [],
  onTreeNodeRead = () => {},
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
      let index = 0;
      return {
        nextNode() {
          const node = treeNodes[index++] || null;
          if (node !== null) { onTreeNodeRead(node); }
          return node;
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

test('breakage guard reclassifies same-document checkout navigation', async () => {
  const guard = await loadGuard({ pathname: '/news/story' });
  assert.equal(guard.getProtection().allowedRiskTier, guard.RISK_TIERS.high);

  globalThis.location.pathname = '/checkout/payment';
  guard.reclassifyProtection({ resetBaseline: true });

  assert.equal(guard.getProtection().category, 'checkout/payment');
  assert.equal(guard.getProtection().allowedRiskTier, guard.RISK_TIERS.low);
});

test('breakage guard rejects selector syntax that can escape generated CSS', async () => {
  const guard = await loadGuard();

  assert.equal(guard.isSafeMutationSelector('.ad{display:block}'), false);
  assert.equal(guard.isSafeMutationSelector('.ad;body'), false);
  assert.equal(guard.isSafeMutationSelector('.ad-banner'), true);
});

test('breakage guard bounds primary-content subtree classification and fails closed', async () => {
  let nodesRead = 0;
  const treeNodes = Array.from({ length: 700 }, () => new FakeElement());
  const guard = await loadGuard({
    treeNodes,
    onTreeNodeRead() {
      nodesRead += 1;
    },
  });
  const container = new FakeElement();
  container.getBoundingClientRect = () => ({ width: 900, height: 400 });
  Object.defineProperty(container, 'textContent', {
    get() {
      throw new Error('classification must not materialize the whole subtree text');
    },
  });

  assert.equal(guard.isLikelyPrimaryContent(container), true);
  assert.equal(nodesRead, 513);
});

test('breakage guard recognizes bounded article-like content signals', async () => {
  const paragraphs = Array.from({ length: 3 }, () => {
    const el = new FakeElement();
    el.tagName = 'P';
    return el;
  });
  const text = {
    nodeType: 3,
    nodeValue: 'x'.repeat(500),
    parentElement: { tagName: 'DIV' },
  };
  const guard = await loadGuard({ treeNodes: [ ...paragraphs, text ] });
  const container = new FakeElement();
  container.getBoundingClientRect = () => ({ width: 900, height: 400 });

  assert.equal(guard.isLikelyPrimaryContent(container), true);
});
