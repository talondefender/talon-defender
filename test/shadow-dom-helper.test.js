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
  const runNextTimer = () => {
    const entry = timers.entries().next().value;
    if (entry === undefined) { return false; }
    const [id, callback] = entry;
    timers.delete(id);
    callback();
    return true;
  };
  const runAllTimers = () => {
    while (runNextTimer()) {}
  };
  return {
    context,
    document,
    mutationObservers,
    runNextTimer,
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
  harness.runAllTimers();
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

test('shadow helper coalesces oversized mutation queues into a bounded full scan', () => {
  const harness = createHelperHarness('complete');
  const controller = loadHelper(harness);
  const addedNodes = [];
  for (let i = 0; i < 700; i += 1) {
    const node = new FakeElement('div');
    harness.document.documentElement.append(node);
    addedNodes.push(node);
  }
  const lateHost = new FakeElement('section');
  lateHost.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(lateHost);
  addedNodes.push(lateHost);

  harness.mutationObservers[0].trigger([
    {
      target: harness.document.documentElement,
      addedNodes,
      removedNodes: [],
    },
  ]);
  harness.runAllTimers();

  assert.equal(controller.enumerateRoots().includes(lateHost.shadowRoot), true);
});

test('shadow helper time-slices one large added subtree', () => {
  const harness = createHelperHarness('loading');
  const controller = loadHelper(harness);
  const subtree = new FakeElement('section');
  for (let i = 0; i < 1000; i += 1) {
    subtree.append(new FakeElement('div'));
  }
  const lateHost = new FakeElement('article');
  lateHost.shadowRoot = new FakeDocumentFragment();
  subtree.append(lateHost);
  harness.document.documentElement.append(subtree);

  harness.mutationObservers[0].trigger([
    {
      target: harness.document.documentElement,
      addedNodes: [subtree],
      removedNodes: [],
    },
  ]);

  assert.equal(harness.runNextTimer(), true);
  assert.equal(
    controller.enumerateRoots().includes(lateHost.shadowRoot),
    false,
    'the first mutation callback slice must not synchronously walk the entire subtree'
  );

  controller.scheduleRescan(0);
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
  harness.runAllTimers();
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

test('shadow helper reports content added or removed inside an already-known root', () => {
  const harness = createHelperHarness('complete');
  const host = new FakeElement('section');
  host.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(host);
  const controller = loadHelper(harness);
  harness.runAllTimers();
  const events = [];
  harness.context.self.addEventListener(controller.CONTENT_CHANGED_EVENT, event => {
    events.push(event.detail);
  });

  const child = new FakeElement('div');
  host.shadowRoot.append(child);
  harness.mutationObservers[0].trigger([
    {
      target: host.shadowRoot,
      addedNodes: [child],
      removedNodes: [],
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].roots.includes(host.shadowRoot), true);
  assert.equal(events[0].addedNodes.includes(child), true);

  host.shadowRoot.children = host.shadowRoot.children.filter(node => node !== child);
  child.parentNode = null;
  harness.mutationObservers[0].trigger([
    {
      target: host.shadowRoot,
      addedNodes: [],
      removedNodes: [child],
    },
  ]);

  assert.equal(events.length, 2);
  assert.equal(events[1].roots.includes(host.shadowRoot), true);
  assert.equal(events[1].removedNodes.includes(child), true);
});

test('shadow helper signals bounded recovery when an existing-root content event truncates', () => {
  const harness = createHelperHarness('complete');
  const host = new FakeElement('section');
  host.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(host);
  const controller = loadHelper(harness);
  harness.runAllTimers();
  const events = [];
  harness.context.self.addEventListener(controller.CONTENT_CHANGED_EVENT, event => {
    events.push(event.detail);
  });
  const addedNodes = [];
  for (let i = 0; i < 200; i += 1) {
    const child = new FakeElement('div');
    host.shadowRoot.append(child);
    addedNodes.push(child);
  }

  harness.mutationObservers[0].trigger([{
    target: host.shadowRoot,
    addedNodes,
    removedNodes: [],
  }]);

  assert.equal(events.length, 1);
  assert.equal(events[0].overflowed, true);
  assert.equal(events[0].roots.includes(host.shadowRoot), true);
  assert.equal(events[0].addedNodes.length <= 128, true);
});

test('shadow helper stop and start control all observers and timers', () => {
  const harness = createHelperHarness('complete');
  const host = new FakeElement('section');
  host.shadowRoot = new FakeDocumentFragment();
  harness.document.documentElement.append(host);
  const controller = loadHelper(harness);
  const observer = harness.mutationObservers[0];

  controller.stop();
  assert.equal(observer.targets.length, 0);

  controller.start();
  harness.runAllTimers();
  assert.equal(observer.targets.includes(harness.document), true);
  assert.equal(observer.targets.includes(host.shadowRoot), true);
});
