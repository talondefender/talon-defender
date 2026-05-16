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
const nativeHeuristicsSource = await fs.readFile(
  new URL('../js/scripting/native-heuristics.js', import.meta.url),
  'utf8'
);
const postHideCleanupSource = await fs.readFile(
  new URL('../js/scripting/post-hide-cleanup.js', import.meta.url),
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
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
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

  matches(selector) {
    return matchesSelectorList(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current instanceof FakeElement) {
      if (matchesSelectorList(current, selector)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get childElementCount() {
    return (this.children || []).filter(node => node instanceof FakeElement).length;
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current instanceof FakeDocument) { return true; }
      current = current.parentNode;
    }
    return false;
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
    this.nodeType = 11;
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
    this.nodeType = 9;
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
    this.targets = [];
    registry.push(this);
  }

  observe(target) {
    this.connected = true;
    this.targets.push(target);
  }

  disconnect() {
    this.connected = false;
    this.targets = [];
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

const matchesSelectorList = (element, selector) =>
  splitSelectorList(selector).some(part => matchesSingleSelector(element, part));

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

const isHiddenByAutomationStyle = (root, element) => {
  if (element instanceof FakeElement === false) { return false; }
  const hiddenIds = readAutomationHiddenIds(root);
  const automationMarker = element.getAttribute?.('data-ubol-automation');
  if (typeof automationMarker === 'string' && hiddenIds.has(automationMarker)) {
    return true;
  }
  const styles = querySelectorAllWithin(root, 'style');
  const rulePattern = /([^{}]+)\{display:none!important;visibility:hidden!important;\}/g;
  for (const style of styles) {
    const cssText = String(style.textContent || '');
    for (const match of cssText.matchAll(rulePattern)) {
      const selector = String(match[1] || '').trim();
      if (selector === '' || selector.includes('[data-ubol-automation=')) { continue; }
      try {
        const matched = querySelectorAllWithin(root, selector);
        if (matched.includes(element)) { return true; }
      } catch {
      }
    }
  }
  return false;
};

const createAutomationHarness = ({
  directives,
  hostname = 'example.com',
  storageData = {},
} = {}) => {
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
    const hiddenByAutomation = scope ? isHiddenByAutomationStyle(scope, element) : false;
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

  const localStorageData = structuredClone(storageData);
  const storageChangeListeners = [];
  const runtime = {
    getURL: input => input,
  };
  const readStorage = key => {
    if (key === null || key === undefined) {
      return { ...localStorageData };
    }
    if (Array.isArray(key)) {
      return Object.fromEntries(key.map(entry => [entry, localStorageData[entry]]));
    }
    if (typeof key === 'string') {
      return { [key]: localStorageData[key] };
    }
    return { ...localStorageData };
  };
  const storage = {
    onChanged: {
      addListener(listener) {
        storageChangeListeners.push(listener);
      },
      removeListener(listener) {
        const index = storageChangeListeners.indexOf(listener);
        if (index >= 0) {
          storageChangeListeners.splice(index, 1);
        }
      },
    },
    local: {
      get: async key => readStorage(key),
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
    async setStorageLocal(updates) {
      const changes = {};
      for (const [key, value] of Object.entries(updates || {})) {
        changes[key] = {
          oldValue: localStorageData[key],
          newValue: value,
        };
        localStorageData[key] = value;
      }
      for (const listener of storageChangeListeners) {
        listener(changes, 'local');
      }
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
  assert.deepEqual(
    consentManager.requiresRulesets,
    ['annoyances-overlays'],
    'consent automation should follow the pop-up/banner ruleset gate'
  );
});

test('guardian exact-host automation covers Sourcepoint consent, sign-in gate hydration, and both reader-revenue support prompts', async () => {
  const directives = await readDirectives();
  const byId = new Map(directives.map(entry => [entry.id, entry]));

  const guardianConsent = byId.get('guardian-sourcepoint-hide');
  assert.ok(guardianConsent, 'missing guardian-sourcepoint-hide directive');
  assert.deepEqual(guardianConsent.hosts, ['=www.theguardian.com']);
  assert.deepEqual(guardianConsent.requiresRulesets, ['annoyances-overlays']);
  assert.ok(
    guardianConsent.selectors.includes('div[id^="sp_message_container"]'),
    'guardian consent directive should target the Sourcepoint message container'
  );
  assert.ok(
    guardianConsent.selectors.includes('iframe[title="The Guardian consent message"]'),
    'guardian consent directive should target the Guardian consent iframe'
  );

  const guardianSignInGate = byId.get('guardian-sign-in-gate-hide');
  assert.ok(guardianSignInGate, 'missing guardian-sign-in-gate-hide directive');
  assert.deepEqual(guardianSignInGate.hosts, ['=www.theguardian.com']);
  assert.deepEqual(guardianSignInGate.requiresRulesets, ['annoyances-overlays']);
  assert.equal(guardianSignInGate.directStyle, true);
  assert.deepEqual(guardianSignInGate.selectors, ['#sign-in-gate']);

  const guardianStickySupport = byId.get('guardian-sticky-support-hide');
  assert.ok(guardianStickySupport, 'missing guardian-sticky-support-hide directive');
  assert.deepEqual(guardianStickySupport.hosts, ['=www.theguardian.com']);
  assert.deepEqual(guardianStickySupport.requiresRulesets, ['annoyances-overlays']);
  assert.equal(guardianStickySupport.directStyle, true);
  assert.ok(
    guardianStickySupport.selectors.includes('gu-island[name="StickyBottomBanner"]'),
    'guardian sticky support directive should target the sticky bottom banner island'
  );
  assert.ok(
    guardianStickySupport.selectors.includes('aside:has(gu-island[name="StickyBottomBanner"])'),
    'guardian sticky support directive should collapse the banner host aside as well'
  );

  const guardianBodyEndSupport = byId.get('guardian-body-end-support-hide');
  assert.ok(guardianBodyEndSupport, 'missing guardian-body-end-support-hide directive');
  assert.deepEqual(guardianBodyEndSupport.hosts, ['=www.theguardian.com']);
  assert.deepEqual(guardianBodyEndSupport.requiresRulesets, ['annoyances-overlays']);
  assert.equal(guardianBodyEndSupport.directStyle, true);
  assert.ok(
    guardianBodyEndSupport.selectors.includes('gu-island[name="SlotBodyEnd"]'),
    'guardian body-end support directive should target the SlotBodyEnd island'
  );
  assert.ok(
    guardianBodyEndSupport.selectors.includes('#slot-body-end'),
    'guardian body-end support directive should target the rendered article-end support slot'
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

test('direct-style hide directives apply selector-based CSS without waiting for element marking', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'direct-hide',
        hosts: ['*'],
        action: 'hide',
        directStyle: true,
        selectors: ['#banner'],
      },
    ],
  });
  const banner = harness.createElement({ id: 'banner', width: 200, height: 120 });

  await harness.load();

  assert.equal(harness.isHidden(banner), true);
  assert.equal(banner.getAttribute('data-ubol-automation'), null);
  const style = harness.readStyle(
    harness.document,
    'ubol-automation-style-direct-hide'
  );
  assert.ok(style);
  assert.match(String(style.textContent || ''), /#banner\{display:none!important;visibility:hidden!important;\}/);
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

test('automation directives honor required rulesets after the stored ruleset config changes and automation refreshes', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'gated-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.banner'],
        requiresRulesets: ['annoyances-overlays'],
      },
    ],
    storageData: {
      rulesetConfig: {
        enabledRulesets: ['easylist'],
      },
    },
  });
  const banner = harness.createElement({ className: 'banner' });

  const controller = await harness.load();
  assert.equal(
    harness.isHidden(banner),
    false,
    'directive should stay inactive while its required ruleset is disabled'
  );

  await harness.setStorageLocal({
    rulesetConfig: {
      enabledRulesets: ['easylist', 'annoyances-overlays'],
    },
  });
  await controller.refresh();
  await harness.settle();

  assert.equal(
    harness.isHidden(banner),
    true,
    'directive should apply after the required ruleset becomes enabled'
  );
});

test('automation directives stay gated until rulesetConfig has been initialized', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'gated-hide-uninitialized',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.banner'],
        requiresRulesets: ['annoyances-overlays'],
      },
    ],
  });
  const banner = harness.createElement({ className: 'banner' });

  await harness.load();

  assert.equal(
    harness.isHidden(banner),
    false,
    'missing rulesetConfig should not guess that optional rulesets are enabled'
  );
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

const createContentScriptHarness = ({
  source,
  fetchJson = {},
  storageData = {},
  hostname = 'example.com',
  readyState = 'complete',
  shouldRun = true,
  canMutateElement = () => ({ allowed: true }),
  isLikelyPrimaryContent = () => false,
  isProtectedSurface = () => false,
  blockHints: blockHintsOverride = {},
  protection = {
    category: '',
    allowedRiskTier: 3,
    matchedBy: '',
  },
} = {}) => {
  let currentTime = 0;
  let nextTimerId = 1;
  let nextAnimationFrameId = 10000;
  const timers = new Map();
  const animationFrames = new Map();
  const mutationObservers = [];
  const document = new FakeDocument();
  document.readyState = readyState;
  const messages = [];
  const shadowRoots = [];
  let scheduledAnimationFrameCount = 0;

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

  const requestAnimationFrameFn = fn => {
    const id = nextAnimationFrameId++;
    scheduledAnimationFrameCount += 1;
    animationFrames.set(id, fn);
    return id;
  };

  const cancelAnimationFrameFn = id => {
    animationFrames.delete(id);
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

  const runAnimationFrames = () => {
    if (animationFrames.size === 0) { return false; }
    const callbacks = Array.from(animationFrames.values());
    animationFrames.clear();
    callbacks.forEach(callback => callback(currentTime));
    return callbacks.length !== 0;
  };

  const countDueTimers = () =>
    Array.from(timers.values()).filter(timer => timer.dueAt <= currentTime).length;

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };

  const settle = async () => {
    for (let i = 0; i < 30; i += 1) {
      await flushMicrotasks();
      const ranTimers = runDueTimers();
      const ranFrames = runAnimationFrames();
      await flushMicrotasks();
      if (
        ranTimers === false &&
        ranFrames === false &&
        countDueTimers() === 0 &&
        animationFrames.size === 0
      ) {
        return;
      }
    }
    throw new Error('content-script harness did not settle');
  };

  const getComputedStyle = element => ({
    display: element?.style?.display || 'block',
    visibility: element?.style?.visibility || 'visible',
    opacity: element?.style?.opacity || '1',
    overflow: element?.style?.overflow || 'visible',
    position: element?.style?.position || 'static',
    top: element?.style?.top || 'auto',
    zIndex: element?.style?.zIndex || '0',
  });

  const runtime = {
    getURL: input => input,
    sendMessage: async message => {
      messages.push(structuredClone(message));
      return {};
    },
  };

  const localStorageData = structuredClone(storageData);
  const readStorage = key => {
    if (key === null || key === undefined) {
      return { ...localStorageData };
    }
    if (Array.isArray(key)) {
      return Object.fromEntries(key.map(entry => [entry, localStorageData[entry]]));
    }
    if (typeof key === 'string') {
      return { [key]: localStorageData[key] };
    }
    return { ...localStorageData };
  };

  const storage = {
    local: {
      get: async key => readStorage(key),
      set: async updates => {
        Object.assign(localStorageData, updates || {});
      },
    },
  };

  const guard = {
    RISK_TIERS: { medium: 2, high: 3 },
    whenReady: async () => {},
    shouldRunSubsystem: () => shouldRun,
    canMutateElement,
    isLikelyPrimaryContent,
    getProtection: () => ({ ...protection }),
    registrableDomain: value => String(value || '').trim().toLowerCase(),
    isProtectedSurface,
    auditAfterMutation: () => {},
  };

  const hintedElements = [];
  const hintedSet = new WeakSet();
  const rememberHint = element => {
    if (element instanceof FakeElement === false || hintedSet.has(element)) {
      return false;
    }
    hintedSet.add(element);
    hintedElements.push(element);
    return true;
  };
  const hintElementAndAncestors = (element, ancestors = 1) => {
    let count = 0;
    let current = element;
    let remaining = Number.isFinite(ancestors) ? Math.max(0, ancestors) : 0;
    while (current instanceof FakeElement) {
      if (rememberHint(current)) {
        count += 1;
      }
      if (remaining <= 0) { break; }
      remaining -= 1;
      current = current.parentElement;
    }
    return count;
  };
  const defaultBlockHints = {
    HINT_ATTR: 'data-talon-block-hint',
    HINTS_CHANGED_EVENT: 'talon-block-hints-changed',
    noteElement: (element, { ancestors = 1 } = {}) =>
      hintElementAndAncestors(element, ancestors),
    hasRecentHint: (element, { includeSubtree = false } = {}) => {
      if (element instanceof FakeElement === false) { return false; }
      if (hintedSet.has(element)) { return true; }
      return includeSubtree === true &&
        collectDescendants(element).some(node => hintedSet.has(node));
    },
    hasRecentNetworkHit: () => false,
    getRecentElements: () =>
      hintedElements.filter(element => element.isConnected !== false),
  };
  const blockHints = { ...defaultBlockHints, ...blockHintsOverride };

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

  const selfTarget = new FakeEventTarget();
  Object.assign(selfTarget, {
    browser: { runtime, storage },
    chrome: { runtime, storage },
    document,
    location: { hostname },
    getComputedStyle,
    requestAnimationFrame: requestAnimationFrameFn,
    cancelAnimationFrame: cancelAnimationFrameFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    performance: {
      now: () => currentTime,
    },
    Date: class extends Date {
      static now() {
        return currentTime;
      }
    },
    Element: FakeElement,
    DocumentFragment: FakeDocumentFragment,
    MutationObserver: class extends FakeMutationObserver {
      constructor(callback) {
        super(callback, mutationObservers);
      }
    },
    CustomEvent: FakeCustomEvent,
    TalonBreakageGuard: guard,
    TalonBlockHintsController: blockHints,
    TalonShadowRootController: shadowController,
    innerHeight: 900,
    innerWidth: 1440,
    scrollTo() {},
  });

  const context = {
    console,
    document,
    self: selfTarget,
    globalThis: null,
    browser: selfTarget.browser,
    chrome: selfTarget.chrome,
    fetch: async () => ({
      ok: true,
      json: async () => structuredClone(fetchJson),
    }),
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    requestAnimationFrame: requestAnimationFrameFn,
    cancelAnimationFrame: cancelAnimationFrameFn,
    performance: selfTarget.performance,
    Date: selfTarget.Date,
    Element: FakeElement,
    DocumentFragment: FakeDocumentFragment,
    MutationObserver: selfTarget.MutationObserver,
    CustomEvent: FakeCustomEvent,
    TalonBreakageGuard: guard,
    TalonBlockHintsController: blockHints,
    TalonShadowRootController: shadowController,
    location: selfTarget.location,
  };
  context.globalThis = context;

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

  return {
    document,
    messages,
    mutationObservers,
    shadowController,
    createElement,
    hintElement(element, options) {
      return hintElementAndAncestors(element, options?.ancestors ?? 1);
    },
    async load() {
      vm.runInNewContext(source, context, { filename: 'content-script.js' });
      await settle();
      return (
        selfTarget.TalonNativeHeuristicsController ||
        selfTarget.TalonPostHideCleanupController
      );
    },
    async settle() {
      await settle();
    },
    triggerObserver(index, records) {
      const observer = mutationObservers[index];
      if (!observer || observer.connected !== true) { return; }
      observer.callback(records);
    },
    watchQueries(node) {
      const original = node.querySelectorAll.bind(node);
      let count = 0;
      node.querySelectorAll = selector => {
        count += 1;
        return original(selector);
      };
      return {
        get count() {
          return count;
        },
        restore() {
          node.querySelectorAll = original;
        },
      };
    },
    getScheduledAnimationFrameCount() {
      return scheduledAnimationFrameCount;
    },
    countConnectedObservers() {
      return mutationObservers.filter(observer => observer.connected === true).length;
    },
    isHidden(element) {
      const style = getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden';
    },
  };
};

test('native heuristics keeps added-node scans incremental and batches mutation bursts into one frame', async () => {
  const harness = createContentScriptHarness({
    source: nativeHeuristicsSource,
    fetchJson: {
      disableHosts: [],
      labelRegexes: ['sponsored'],
      labelSelectors: ['.sponsored-label'],
      widgetSelectors: [],
      containerStopSelectors: ['article'],
      maxLabelTextLength: 40,
      minContainerHeight: 60,
      minContainerWidth: 120,
      minScore: 1,
      minScoreLowConfidence: 1,
    },
  });

  await harness.load();

  const article = harness.createElement({
    tagName: 'article',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  const label = harness.createElement({
    tagName: 'span',
    className: 'sponsored-label',
    textContent: 'Sponsored',
    parent: article,
    width: 20,
    height: 10,
  });
  void label;

  const documentQueries = harness.watchQueries(harness.document);
  const bodyQueries = harness.watchQueries(harness.document.body);
  const articleQueries = harness.watchQueries(article);
  await harness.settle();
  const baselineDocumentQueries = documentQueries.count;
  const baselineBodyQueries = bodyQueries.count;
  const baselineArticleQueries = articleQueries.count;
  const beforeFrames = harness.getScheduledAnimationFrameCount();

  harness.triggerObserver(0, [{ addedNodes: [article], removedNodes: [] }]);
  harness.triggerObserver(0, [{ addedNodes: [article], removedNodes: [] }]);
  await harness.settle();

  assert.equal(
    bodyQueries.count - baselineBodyQueries,
    0,
    'native heuristics should not fall back to a full body text scan for added-node mutations'
  );
  assert.ok(documentQueries.count - baselineDocumentQueries <= 2);
  assert.ok(articleQueries.count - baselineArticleQueries >= 3);
  assert.equal(
    harness.getScheduledAnimationFrameCount() - beforeFrames,
    1,
    'native heuristics should batch a mutation burst into one animation frame'
  );
  assert.equal(harness.isHidden(article), true);

  documentQueries.restore();
  bodyQueries.restore();
  articleQueries.restore();
});

test('native heuristics stop disconnects keep-hidden observers created for hidden containers', async () => {
  const harness = createContentScriptHarness({
    source: nativeHeuristicsSource,
    fetchJson: {
      disableHosts: [],
      labelRegexes: ['sponsored'],
      labelSelectors: ['.sponsored-label'],
      widgetSelectors: [],
      containerStopSelectors: ['article'],
      maxLabelTextLength: 40,
      minContainerHeight: 60,
      minContainerWidth: 120,
      minScore: 1,
      minScoreLowConfidence: 1,
    },
  });

  const controller = await harness.load();

  const article = harness.createElement({
    tagName: 'article',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  harness.createElement({
    tagName: 'span',
    className: 'sponsored-label',
    textContent: 'Sponsored',
    parent: article,
    width: 20,
    height: 10,
  });

  harness.triggerObserver(0, [{ addedNodes: [article], removedNodes: [] }]);
  await harness.settle();

  assert.equal(harness.isHidden(article), true);
  assert.equal(
    harness.countConnectedObservers(),
    2,
    'native heuristics should have one document observer and one keep-hidden observer'
  );

  await controller.stop();
  await harness.settle();

  assert.equal(
    harness.countConnectedObservers(),
    0,
    'native heuristics stop should disconnect both the main observer and keep-hidden observers'
  );
});

test('post-hide cleanup collects ad-shell candidates before DOMContentLoaded', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
    readyState: 'loading',
  });

  const wrapper = harness.createElement({
    tagName: 'section',
    className: 'leaderboard-shell',
    width: 970,
    height: 250,
  });
  const shell = harness.createElement({
    className: 'freestar-ads',
    parent: wrapper,
    width: 970,
    height: 250,
  });
  shell.style.setProperty('display', 'none', 'important');

  await harness.load();

  assert.equal(harness.document.readyState, 'loading');
  assert.equal(
    harness.isHidden(wrapper),
    true,
    'early hidden ad shell evidence should collapse its reserved wrapper'
  );
});

test('post-hide cleanup preserves protected page surfaces', async () => {
  const structuralHarness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  structuralHarness.document.body.className = 'ad-slot';
  structuralHarness.document.body.width = 300;
  structuralHarness.document.body.height = 250;
  const header = structuralHarness.createElement({
    tagName: 'header',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  const nav = structuralHarness.createElement({
    tagName: 'nav',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  const footer = structuralHarness.createElement({
    tagName: 'footer',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });

  await structuralHarness.load();

  assert.equal(structuralHarness.isHidden(structuralHarness.document.body), false);
  assert.equal(structuralHarness.isHidden(header), false);
  assert.equal(structuralHarness.isHidden(nav), false);
  assert.equal(structuralHarness.isHidden(footer), false);

  const primaryHarness = createContentScriptHarness({
    source: postHideCleanupSource,
    isLikelyPrimaryContent: element => element.tagName === 'ARTICLE',
  });
  const article = primaryHarness.createElement({
    tagName: 'article',
    className: 'ad-slot',
    width: 728,
    height: 90,
  });

  await primaryHarness.load();

  assert.equal(primaryHarness.isHidden(article), false);

  const guardedHarness = createContentScriptHarness({
    source: postHideCleanupSource,
    canMutateElement: element => ({
      allowed: element.id !== 'checkout-panel',
    }),
  });
  const checkout = guardedHarness.createElement({
    tagName: 'section',
    id: 'checkout-panel',
    className: 'ad-slot',
    width: 300,
    height: 250,
  });

  await guardedHarness.load();

  assert.equal(guardedHarness.isHidden(checkout), false);
});

test('post-hide cleanup needs strong evidence to collapse nonstandard parent gaps', async () => {
  const weakHarness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  const weakWrapper = weakHarness.createElement({
    tagName: 'section',
    width: 420,
    height: 180,
  });
  const weakSlot = weakHarness.createElement({
    className: 'ad-slot',
    parent: weakWrapper,
    width: 300,
    height: 250,
  });
  weakSlot.style.setProperty('display', 'none', 'important');

  await weakHarness.load();

  assert.equal(
    weakHarness.isHidden(weakWrapper),
    false,
    'weak hidden naming alone should not collapse a nonstandard wrapper'
  );

  const hintedHarness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  const hintedWrapper = hintedHarness.createElement({
    tagName: 'section',
    width: 420,
    height: 180,
  });
  const hintedSlot = hintedHarness.createElement({
    className: 'ad-slot',
    parent: hintedWrapper,
    width: 300,
    height: 250,
  });
  hintedSlot.style.setProperty('display', 'none', 'important');
  hintedHarness.hintElement(hintedSlot, { ancestors: 1 });

  await hintedHarness.load();

  assert.equal(
    hintedHarness.isHidden(hintedWrapper),
    true,
    'a block hint should allow a nonstandard empty wrapper to collapse'
  );
});

test('post-hide cleanup keeps added-node scans incremental and batches mutation bursts into one frame', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });

  await harness.load();

  const wrapper = harness.createElement({
    tagName: 'section',
    width: 320,
    height: 260,
  });
  const slot = harness.createElement({
    className: 'ad-slot',
    parent: wrapper,
    width: 300,
    height: 250,
  });

  const documentQueries = harness.watchQueries(harness.document);
  const wrapperQueries = harness.watchQueries(wrapper);
  const beforeFrames = harness.getScheduledAnimationFrameCount();

  harness.triggerObserver(0, [{ addedNodes: [wrapper], removedNodes: [] }]);
  harness.triggerObserver(0, [{ addedNodes: [wrapper], removedNodes: [] }]);
  await harness.settle();

  assert.equal(documentQueries.count, 0);
  assert.ok(wrapperQueries.count >= 1);
  assert.equal(
    harness.getScheduledAnimationFrameCount() - beforeFrames,
    1,
    'post-hide cleanup should batch a mutation burst into one animation frame'
  );
  assert.equal(harness.isHidden(slot), true);

  documentQueries.restore();
  wrapperQueries.restore();
});

test('post-hide cleanup stop disconnects the observer and cancels pending frame work', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });

  const controller = await harness.load();

  const wrapper = harness.createElement({
    tagName: 'section',
    width: 320,
    height: 260,
  });
  const slot = harness.createElement({
    className: 'ad-slot',
    parent: wrapper,
    width: 300,
    height: 250,
  });

  harness.triggerObserver(0, [{ addedNodes: [wrapper], removedNodes: [] }]);
  await controller.stop();
  await harness.settle();

  assert.equal(harness.countConnectedObservers(), 0);
  assert.equal(
    harness.isHidden(slot),
    false,
    'stop should cancel queued cleanup work before it mutates the page'
  );
});
