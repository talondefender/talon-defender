import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = process.cwd();
const directivesPath = path.join(repoRoot, 'automation', 'directives.json');
const automationSource = await fs.readFile(
  new URL('../js/scripting/automation.js', import.meta.url),
  'utf8'
);

const readDirectives = async () => JSON.parse(await fs.readFile(directivesPath, 'utf8'));

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) || [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type, listener) {
    const bucket = this.listeners.get(type) || [];
    this.listeners.set(
      type,
      bucket.filter(entry => entry !== listener)
    );
  }

  dispatchEvent(event) {
    const bucket = this.listeners.get(event?.type) || [];
    for (const listener of bucket) {
      listener.call(this, event);
    }
    return true;
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class FakeStyleDeclaration {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value) {
    const normalized = String(name || '').trim().toLowerCase();
    const camel = normalized.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const stringValue = String(value);
    this.values.set(normalized, stringValue);
    this[normalized] = stringValue;
    this[camel] = stringValue;
  }

  getPropertyValue(name) {
    return this.values.get(String(name || '').trim().toLowerCase()) || '';
  }
}

const setOwnerDocumentRecursive = (node, ownerDocument) => {
  if (!node || ownerDocument === null) { return; }
  node.ownerDocument = ownerDocument;
  for (const child of node.children || []) {
    setOwnerDocumentRecursive(child, ownerDocument);
  }
};

class FakeNode extends FakeEventTarget {
  constructor(ownerDocument = null) {
    super();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes.flat()) {
      if (!node) { continue; }
      if (node.parentNode) {
        node.remove();
      }
      node.parentNode = this;
      setOwnerDocumentRecursive(
        node,
        this instanceof FakeDocument ? this : this.ownerDocument
      );
      this.children.push(node);
    }
  }

  remove() {
    if (!this.parentNode) { return; }
    const siblings = this.parentNode.children || [];
    const index = siblings.indexOf(this);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
    this.parentNode = null;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName = 'div', ownerDocument = null) {
    super(ownerDocument);
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attributes = new Map();
    this.style = new FakeStyleDeclaration();
    this.textContent = '';
    this.id = '';
    this.className = '';
    this.width = 10;
    this.height = 10;
    this.shadowRoot = null;
    this.closedShadowRoot = null;
  }

  setAttribute(name, value) {
    const normalized = String(name);
    const stringValue = String(value);
    if (normalized === 'id') {
      this.id = stringValue;
      return;
    }
    if (normalized === 'class') {
      this.className = stringValue;
      return;
    }
    this.attributes.set(normalized, stringValue);
  }

  getAttribute(name) {
    const normalized = String(name);
    if (normalized === 'id') { return this.id || null; }
    if (normalized === 'class') { return this.className || null; }
    return this.attributes.has(normalized)
      ? this.attributes.get(normalized)
      : null;
  }

  removeAttribute(name) {
    const normalized = String(name);
    if (normalized === 'id') {
      this.id = '';
      return;
    }
    if (normalized === 'class') {
      this.className = '';
      return;
    }
    this.attributes.delete(normalized);
  }

  querySelectorAll(selector) {
    return querySelectorAllWithin(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return {
      width: this.width,
      height: this.height,
    };
  }

  click() {
    this.clickCount = (this.clickCount || 0) + 1;
  }
}

class FakeHTMLStyleElement extends FakeElement {
  constructor(ownerDocument = null) {
    super('style', ownerDocument);
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor(ownerDocument = null) {
    super(ownerDocument);
    this.host = null;
  }

  querySelectorAll(selector) {
    return querySelectorAllWithin(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.readyState = 'complete';
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.append(this.documentElement);
    this.documentElement.append(this.head, this.body);
  }

  createElement(tagName) {
    if (String(tagName || '').toLowerCase() === 'style') {
      return new FakeHTMLStyleElement(this);
    }
    return new FakeElement(tagName, this);
  }

  querySelectorAll(selector) {
    return querySelectorAllWithin(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getElementById(id) {
    const all = collectDescendants(this);
    return all.find(node => node instanceof FakeElement && node.id === id) || null;
  }
}

class FakeMutationObserver {
  constructor(callback, registry) {
    this.callback = callback;
    this.connected = false;
    registry.push(this);
  }

  observe() {
    this.connected = true;
  }

  disconnect() {
    this.connected = false;
  }
}

const splitSelectorList = selector =>
  String(selector || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const collectDescendants = root => {
  const out = [];
  const visit = node => {
    for (const child of node.children || []) {
      out.push(child);
      visit(child);
    }
  };
  if (root instanceof FakeDocument) {
    if (root.documentElement) {
      out.push(root.documentElement);
      visit(root.documentElement);
    }
    return out;
  }
  visit(root);
  return out;
};

const readAttributeSelector = selector => {
  const match = selector.match(
    /^\[([A-Za-z0-9_-]+)(?:([\^]?=)(?:"([^"]*)"|'([^']*)'))?\]/
  );
  if (!match) { return null; }
  return {
    consumed: match[0],
    name: match[1],
    operator: match[2] || '',
    value: match[3] ?? match[4] ?? '',
  };
};

const matchesSingleSelector = (element, selector) => {
  if (element instanceof FakeElement === false) { return false; }
  let remaining = String(selector || '').trim();
  if (remaining === '') { return false; }

  const tagMatch = remaining.match(/^[A-Za-z][A-Za-z0-9_-]*/);
  if (tagMatch) {
    if (element.tagName !== tagMatch[0].toUpperCase()) { return false; }
    remaining = remaining.slice(tagMatch[0].length);
  }

  while (remaining !== '') {
    if (remaining.startsWith('.')) {
      const match = remaining.match(/^\.([A-Za-z0-9_-]+)/);
      if (!match) { return false; }
      const classes = String(element.className || '')
        .split(/\s+/)
        .filter(Boolean);
      if (classes.includes(match[1]) === false) { return false; }
      remaining = remaining.slice(match[0].length);
      continue;
    }
    if (remaining.startsWith('#')) {
      const match = remaining.match(/^#([A-Za-z0-9_-]+)/);
      if (!match || element.id !== match[1]) { return false; }
      remaining = remaining.slice(match[0].length);
      continue;
    }
    if (remaining.startsWith('[')) {
      const attr = readAttributeSelector(remaining);
      if (!attr) { return false; }
      const value = element.getAttribute(attr.name);
      if (attr.operator === '') {
        if (value === null) { return false; }
      } else if (attr.operator === '=') {
        if (value !== attr.value) { return false; }
      } else if (attr.operator === '^=') {
        if (typeof value !== 'string' || value.startsWith(attr.value) === false) {
          return false;
        }
      } else {
        return false;
      }
      remaining = remaining.slice(attr.consumed.length);
      continue;
    }
    return false;
  }

  return true;
};

const querySelectorAllWithin = (root, selector) => {
  const selectors = splitSelectorList(selector);
  if (selectors.length === 0) { return []; }
  return collectDescendants(root).filter(node =>
    node instanceof FakeElement &&
    selectors.some(part => matchesSingleSelector(node, part))
  );
};

const getRootScope = node => {
  let current = node;
  while (current) {
    if (current instanceof FakeDocumentFragment || current instanceof FakeDocument) {
      return current;
    }
    current = current.parentNode;
  }
  return node?.ownerDocument || null;
};

const readAutomationHiddenIds = root => {
  const styles = querySelectorAllWithin(root, 'style');
  const hiddenIds = new Set();
  const pattern =
    /\[data-ubol-automation="((?:\\.|[^"])*)"\]\{display:none!important;visibility:hidden!important;\}/g;
  for (const style of styles) {
    const cssText = String(style.textContent || '');
    for (const match of cssText.matchAll(pattern)) {
      hiddenIds.add(
        match[1]
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"')
      );
    }
  }
  return hiddenIds;
};

const createAutomationHarness = ({ directives, hostname = 'example.com' } = {}) => {
  let currentTime = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const mutationObservers = [];
  const document = new FakeDocument();
  const shadowRoots = [];
  const auditTrail = [];
  const guard = {
    RISK_TIERS: { medium: 2, high: 3 },
    whenReady: async () => {},
    shouldRunSubsystem: subsystemId => subsystemId === 'automation',
    shouldAllowDirective: () => true,
    canMutateElement: () => ({ allowed: true }),
    auditAfterMutation: source => {
      auditTrail.push(source);
    },
  };
  const shadowController = {
    ROOTS_CHANGED_EVENT: 'talon-shadow-roots-changed',
    enumerateRoots() {
      return shadowRoots.slice();
    },
    rescanNow() {},
    scheduleRescan() {},
    registerRoot(root) {
      if (shadowRoots.includes(root)) { return; }
      shadowRoots.push(root);
    },
  };

  const getComputedStyle = element => {
    const scope = getRootScope(element);
    const hiddenIds = scope ? readAutomationHiddenIds(scope) : new Set();
    const automationMarker = element?.getAttribute?.('data-ubol-automation');
    const hiddenByAutomation =
      typeof automationMarker === 'string' && hiddenIds.has(automationMarker);
    return {
      display: element?.style?.display || (hiddenByAutomation ? 'none' : 'block'),
      visibility: element?.style?.visibility || (hiddenByAutomation ? 'hidden' : 'visible'),
      opacity: element?.style?.opacity || '1',
      overflow: element?.style?.overflow || 'visible',
      position: element?.style?.position || 'static',
    };
  };

  const setTimeoutFn = (fn, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, {
      callback: fn,
      dueAt: currentTime + Math.max(0, Number(delay) || 0),
    });
    return id;
  };

  const clearTimeoutFn = id => {
    timers.delete(id);
  };

  const runDueTimers = () => {
    let ran = false;
    while (true) {
      const dueEntries = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= currentTime)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0]);
      if (dueEntries.length === 0) { break; }
      for (const [id, timer] of dueEntries) {
        if (timers.has(id) === false) { continue; }
        timers.delete(id);
        timer.callback();
        ran = true;
      }
    }
    return ran;
  };

  const countDueTimers = () =>
    Array.from(timers.values()).filter(timer => timer.dueAt <= currentTime).length;

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };

  const settle = async () => {
    for (let i = 0; i < 25; i += 1) {
      await flushMicrotasks();
      const ran = runDueTimers();
      await flushMicrotasks();
      if (ran === false && countDueTimers() === 0) {
        return;
      }
    }
    throw new Error('automation harness did not settle');
  };

  const advanceTime = async ms => {
    currentTime += Math.max(0, Number(ms) || 0);
    await settle();
  };

  const triggerMutations = async () => {
    for (const observer of mutationObservers) {
      if (observer.connected !== true) { continue; }
      observer.callback([]);
    }
    await settle();
  };

  const dispatchShadowRootsChanged = async () => {
    selfTarget.dispatchEvent(
      new FakeCustomEvent(shadowController.ROOTS_CHANGED_EVENT)
    );
    await settle();
  };

  const createElement = ({
    tagName = 'div',
    className = '',
    id = '',
    textContent = '',
    attrs = {},
    parent = document.body,
    width = 10,
    height = 10,
  } = {}) => {
    const element = document.createElement(tagName);
    element.className = className;
    element.id = id;
    element.textContent = textContent;
    element.width = width;
    element.height = height;
    for (const [name, value] of Object.entries(attrs)) {
      element.setAttribute(name, value);
    }
    parent?.append?.(element);
    return element;
  };

  const createShadowHost = ({ parent = document.body } = {}) => {
    const host = createElement({ tagName: 'section', parent });
    const root = new FakeDocumentFragment(document);
    root.host = host;
    host.shadowRoot = root;
    return { host, root };
  };

  const fetchFn = async () => ({
    ok: true,
    json: async () => directives,
  });

  const runtime = {
    getURL: input => input,
  };
  const storage = {
    local: {
      get: async () => ({}),
    },
  };
  const browser = { runtime, storage };
  const chrome = { runtime, storage };

  const selfTarget = new FakeEventTarget();
  Object.assign(selfTarget, {
    browser,
    chrome,
    document,
    location: { hostname },
    getComputedStyle,
    TalonBreakageGuard: guard,
    TalonShadowRootController: shadowController,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });

  const FakeDate = class extends Date {
    static now() {
      return currentTime;
    }
  };

  const context = {
    console,
    document,
    self: selfTarget,
    globalThis: null,
    browser,
    chrome,
    location: selfTarget.location,
    fetch: fetchFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    Date: FakeDate,
    Element: FakeElement,
    HTMLStyleElement: FakeHTMLStyleElement,
    DocumentFragment: FakeDocumentFragment,
    MutationObserver: class extends FakeMutationObserver {
      constructor(callback) {
        super(callback, mutationObservers);
      }
    },
    CustomEvent: FakeCustomEvent,
    TalonBreakageGuard: guard,
    TalonShadowRootController: shadowController,
  };
  context.globalThis = context;

  return {
    auditTrail,
    document,
    shadowController,
    createElement,
    createShadowHost,
    async load() {
      vm.runInNewContext(automationSource, context, { filename: 'automation.js' });
      await settle();
      return selfTarget.TalonAutomationController;
    },
    async advanceTime(ms) {
      await advanceTime(ms);
    },
    async triggerMutations() {
      await triggerMutations();
    },
    async dispatchShadowRootsChanged() {
      await dispatchShadowRootsChanged();
    },
    async settle() {
      await settle();
    },
    isHidden(element) {
      const style = getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden';
    },
    readStyle(root, styleId) {
      return root.querySelector(
        `style[data-ubol-automation-style="${styleId}"]`
      );
    },
  };
};

test('generic consent automation includes supported CMP families', async () => {
  const directives = await readDirectives();
  const byId = new Map(directives.map(entry => [entry.id, entry]));

  const oneTrust = byId.get('onetrust-dismiss');
  assert.ok(oneTrust, 'missing onetrust-dismiss directive');
  assert.equal(oneTrust.category, 'consent');

  const consentManager = byId.get('consentmanager-hide');
  assert.ok(consentManager, 'missing consentmanager-hide directive');
  assert.equal(consentManager.category, 'consent');
  assert.equal(consentManager.action, 'hide');
  assert.deepEqual(consentManager.hosts, ['*']);
  assert.ok(
    consentManager.selectors.includes('#cmp-ui-iframe'),
    'consentmanager-hide should target the CMP iframe shell'
  );
  assert.ok(
    consentManager.selectors.includes('[id^="cmpbox"]'),
    'consentmanager-hide should target consentmanager box roots'
  );
  assert.ok(
    consentManager.selectors.includes('.cmpboxinner'),
    'consentmanager-hide should target consentmanager inner shells'
  );
});

test('automation hide applies across all matching selectors and does not trigger fallback after a primary match', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'layered-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.banner', '.overlay'],
        fallbackAction: 'hide',
        fallbackSelectors: ['.fallback'],
      },
    ],
  });
  const banner = harness.createElement({ className: 'banner' });
  const overlay = harness.createElement({ className: 'overlay' });
  const fallback = harness.createElement({ className: 'fallback' });

  await harness.load();

  assert.equal(banner.getAttribute('data-ubol-automation'), 'layered-hide');
  assert.equal(overlay.getAttribute('data-ubol-automation'), 'layered-hide');
  assert.equal(fallback.getAttribute('data-ubol-automation'), null);
  assert.equal(harness.isHidden(banner), true);
  assert.equal(harness.isHidden(overlay), true);
  assert.equal(harness.isHidden(fallback), false);
});

test('automation hide styles are mirrored into existing and newly discovered shadow roots', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'shadow-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.shadow-banner'],
      },
    ],
  });
  const firstShadow = harness.createShadowHost();
  const firstBanner = harness.createElement({
    className: 'shadow-banner',
    parent: firstShadow.root,
  });
  harness.shadowController.registerRoot(firstShadow.root);

  await harness.load();

  const styleId = 'ubol-automation-style-shadow-hide';
  assert.ok(harness.readStyle(firstShadow.root, styleId));
  assert.equal(harness.isHidden(firstBanner), true);

  const secondShadow = harness.createShadowHost();
  const secondBanner = harness.createElement({
    className: 'shadow-banner',
    parent: secondShadow.root,
  });
  harness.shadowController.registerRoot(secondShadow.root);

  await harness.dispatchShadowRootsChanged();

  assert.ok(harness.readStyle(secondShadow.root, styleId));
  assert.equal(harness.isHidden(secondBanner), true);
});

test('automation stop removes document and shadow-root hide styles', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'stop-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.banner'],
      },
    ],
  });
  const documentBanner = harness.createElement({ className: 'banner' });
  const shadow = harness.createShadowHost();
  const shadowBanner = harness.createElement({
    className: 'banner',
    parent: shadow.root,
  });
  harness.shadowController.registerRoot(shadow.root);

  const controller = await harness.load();

  assert.equal(harness.isHidden(documentBanner), true);
  assert.equal(harness.isHidden(shadowBanner), true);
  assert.ok(harness.document.getElementById('ubol-automation-style-stop-hide'));
  assert.ok(
    harness.readStyle(shadow.root, 'ubol-automation-style-stop-hide')
  );

  await controller.stop();
  await harness.settle();

  assert.equal(harness.document.getElementById('ubol-automation-style-stop-hide'), null);
  assert.equal(
    harness.readStyle(shadow.root, 'ubol-automation-style-stop-hide'),
    null
  );
  assert.equal(harness.isHidden(documentBanner), false);
  assert.equal(harness.isHidden(shadowBanner), false);
});

test('default automation retry backoff continues past three applies and resets after inactivity', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'bounded-retry',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.banner'],
      },
    ],
  });
  const first = harness.createElement({ className: 'banner' });

  await harness.load();
  assert.equal(harness.isHidden(first), true);

  const second = harness.createElement({ className: 'banner' });
  await harness.triggerMutations();
  await harness.advanceTime(250);
  assert.equal(harness.isHidden(second), true);

  const third = harness.createElement({ className: 'banner' });
  await harness.triggerMutations();
  await harness.advanceTime(250);
  assert.equal(
    harness.isHidden(third),
    false,
    'third apply should wait for the 500ms backoff window'
  );
  await harness.advanceTime(250);
  assert.equal(harness.isHidden(third), true);

  const fourth = harness.createElement({ className: 'banner' });
  await harness.triggerMutations();
  await harness.advanceTime(250);
  assert.equal(
    harness.isHidden(fourth),
    false,
    'fourth apply should wait for the 2000ms backoff window'
  );
  await harness.advanceTime(1750);
  assert.equal(
    harness.isHidden(fourth),
    true,
    'default retry logic should still reapply after more than three successes'
  );

  await harness.advanceTime(5 * 60 * 1000);
  const afterReset = harness.createElement({ className: 'banner' });
  await harness.triggerMutations();
  await harness.advanceTime(250);
  assert.equal(
    harness.isHidden(afterReset),
    true,
    'retry state should reset after 5 minutes of inactivity'
  );
});

test('explicit maxApplies still hard-stops a directive after the configured limit', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'limited-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.limited'],
        maxApplies: 2,
      },
    ],
  });
  const first = harness.createElement({ className: 'limited' });

  await harness.load();
  assert.equal(harness.isHidden(first), true);

  const second = harness.createElement({ className: 'limited' });
  await harness.triggerMutations();
  await harness.advanceTime(250);
  assert.equal(harness.isHidden(second), true);

  const third = harness.createElement({ className: 'limited' });
  await harness.triggerMutations();
  await harness.advanceTime(5000);

  assert.equal(
    harness.isHidden(third),
    false,
    'explicit maxApplies should still stop the directive permanently'
  );
});
