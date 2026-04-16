import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const helperSource = await fs.readFile(
  new URL('../js/scripting/shadow-dom-helper.js', import.meta.url),
  'utf8'
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) || [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  dispatchEvent(event) {
    const bucket = this.listeners.get(event?.type) || [];
    for (const listener of bucket) {
      listener.call(this, event);
    }
  }
}

class FakeNode extends FakeEventTarget {
  constructor() {
    super();
    this.children = [];
    this.parentNode = null;
  }

  append(child) {
    if (!child) { return; }
    child.parentNode = this;
    this.children.push(child);
  }
}

class FakeElement extends FakeNode {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.shadowRoot = null;
    this.closedShadowRoot = null;
  }
}

class FakeDocumentFragment extends FakeNode {}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class FakeMutationObserver {
  constructor(callback, registry) {
    this.callback = callback;
    this.registry = registry;
    this.targets = [];
    registry.push(this);
  }

  observe(target) {
    this.targets.push(target);
  }

  disconnect() {
    this.targets = [];
  }

  trigger(records = []) {
    this.callback(records);
  }
}

const collectDescendants = root => {
  const out = [];
  const queue = [];
  if (root instanceof FakeDocument) {
    if (root.documentElement) {
      queue.push(root.documentElement);
    }
  } else {
    queue.push(...(root.children || []));
  }
  while (queue.length !== 0) {
    const node = queue.shift();
    out.push(node);
    queue.push(...(node.children || []));
  }
  return out;
};

class FakeDocument extends FakeEventTarget {
  constructor(readyState = 'loading') {
    super();
    this.readyState = readyState;
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.documentElement.append(this.head);
  }

  createTreeWalker(root) {
    const nodes = collectDescendants(root);
    let index = -1;
    return {
      currentNode: null,
      nextNode() {
        index += 1;
        if (index >= nodes.length) { return false; }
        this.currentNode = nodes[index];
        return true;
      },
    };
  }
}

const createHelperHarness = (readyState = 'loading') => {
  const mutationObservers = [];
  const timers = new Map();
  let nextTimerId = 1;
  const document = new FakeDocument(readyState);
  const context = {
    console,
    self: null,
    document,
    Element: FakeElement,
    DocumentFragment: FakeDocumentFragment,
    NodeFilter: { SHOW_ELEMENT: 1 },
    CustomEvent: FakeCustomEvent,
    MutationObserver: class extends FakeMutationObserver {
      constructor(callback) {
        super(callback, mutationObservers);
      }
    },
    browser: {},
    chrome: {
      dom: {
        openOrClosedShadowRoot(node) {
          return node.closedShadowRoot || node.shadowRoot || null;
        },
      },
    },
    setTimeout(fn) {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  context.self = new FakeEventTarget();
  Object.assign(context.self, {
    browser: context.browser,
    chrome: context.chrome,
    document,
    Element: context.Element,
    DocumentFragment: context.DocumentFragment,
    NodeFilter: context.NodeFilter,
    CustomEvent: context.CustomEvent,
    MutationObserver: context.MutationObserver,
    setTimeout: context.setTimeout,
    clearTimeout: context.clearTimeout,
  });
  context.globalThis = context.self;
  const runAllTimers = () => {
    while (timers.size !== 0) {
      const callbacks = Array.from(timers.values());
      timers.clear();
      callbacks.forEach(fn => fn());
    }
  };
  return {
    context,
    document,
    mutationObservers,
    runAllTimers,
  };
};

const loadHelper = harness => {
  vm.runInNewContext(helperSource, harness.context, { filename: 'shadow-dom-helper.js' });
  return harness.context.self.TalonShadowRootController;
};

test('shadow helper discovers open and closed roots during initial scan', () => {
  const harness = createHelperHarness();
  const openHost = new FakeElement('section');
  openHost.shadowRoot = new FakeDocumentFragment();
  const closedHost = new FakeElement('aside');
  closedHost.closedShadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(openHost);
  harness.document.documentElement.append(closedHost);

  const controller = loadHelper(harness);
  const roots = controller.enumerateRoots();

  assert.equal(roots.length, 2);
  assert.equal(roots.includes(openHost.shadowRoot), true);
  assert.equal(roots.includes(closedHost.closedShadowRoot), true);
});

test('shadow helper rescans after mutation bursts and picks up newly attached roots', () => {
  const harness = createHelperHarness();
  const host = new FakeElement('section');
  harness.document.documentElement.append(host);

  const controller = loadHelper(harness);
  const lateHost = new FakeElement('article');
  lateHost.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(lateHost);

  harness.mutationObservers[0].trigger([
    {
      addedNodes: [lateHost],
      removedNodes: [],
    },
  ]);
  harness.runAllTimers();

  assert.equal(controller.enumerateRoots().includes(lateHost.shadowRoot), true);
});

test('shadow helper post-load rescans discover roots attached after initial paint', () => {
  const harness = createHelperHarness('complete');
  const host = new FakeElement('div');
  harness.document.documentElement.append(host);

  const controller = loadHelper(harness);
  host.closedShadowRoot = new FakeDocumentFragment();
  harness.runAllTimers();

  assert.equal(controller.enumerateRoots().includes(host.closedShadowRoot), true);
});

test('shadow helper disconnects removed roots before re-observing active ones', () => {
  const harness = createHelperHarness();
  const firstHost = new FakeElement('section');
  firstHost.shadowRoot = new FakeDocumentFragment();
  const secondHost = new FakeElement('aside');
  secondHost.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(firstHost);
  harness.document.documentElement.append(secondHost);

  const controller = loadHelper(harness);
  const observer = harness.mutationObservers[0];

  assert.equal(observer.targets.includes(firstHost.shadowRoot), true);
  assert.equal(observer.targets.includes(secondHost.shadowRoot), true);

  harness.document.documentElement.children =
    harness.document.documentElement.children.filter(node => node !== firstHost);
  firstHost.parentNode = null;
  observer.trigger([
    {
      addedNodes: [],
      removedNodes: [firstHost],
    },
  ]);
  harness.runAllTimers();

  assert.equal(controller.enumerateRoots().includes(firstHost.shadowRoot), false);
  assert.equal(observer.targets.includes(firstHost.shadowRoot), false);
  assert.equal(observer.targets.includes(secondHost.shadowRoot), true);
});
