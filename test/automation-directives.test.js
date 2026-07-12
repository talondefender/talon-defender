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
const remoteCosmeticsSource = await fs.readFile(
  new URL('../js/scripting/remote-cosmetics.js', import.meta.url),
  'utf8'
);
const remoteCosmeticsGlobalSource = await fs.readFile(
  new URL('../js/scripting/remote-cosmetics-global.js', import.meta.url),
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
    this.priorities = new Map();
  }

  setProperty(name, value, priority = '') {
    const normalized = String(name || '').trim().toLowerCase();
    const camel = normalized.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const stringValue = String(value);
    this.values.set(normalized, stringValue);
    this.priorities.set(normalized, String(priority || '').toLowerCase());
    this[normalized] = stringValue;
    this[camel] = stringValue;
  }

  getPropertyValue(name) {
    return this.values.get(String(name || '').trim().toLowerCase()) || '';
  }

  getPropertyPriority(name) {
    return this.priorities.get(String(name || '').trim().toLowerCase()) || '';
  }

  removeProperty(name) {
    const normalized = String(name || '').trim().toLowerCase();
    const camel = normalized.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const oldValue = this.values.get(normalized) || '';
    this.values.delete(normalized);
    this.priorities.delete(normalized);
    this[normalized] = '';
    this[camel] = '';
    return oldValue;
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

  getRootNode() {
    let current = this;
    while (current?.parentNode) {
      current = current.parentNode;
    }
    return current;
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

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
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
      current = current.parentNode || (
        current instanceof FakeDocumentFragment ? current.host : null
      );
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

class FakeHTMLIFrameElement extends FakeElement {
  constructor(ownerDocument = null) {
    super('iframe', ownerDocument);
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
    if (String(tagName || '').toLowerCase() === 'iframe') {
      return new FakeHTMLIFrameElement(this);
    }
    return new FakeElement(tagName, this);
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
  guardOverrides = {},
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
    ...guardOverrides,
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

  const triggerMutations = async (records = []) => {
    for (const observer of mutationObservers) {
      if (observer.connected !== true) { continue; }
      observer.callback(records);
    }
    await settle();
  };

  const dispatchShadowRootsChanged = async () => {
    selfTarget.dispatchEvent(
      new FakeCustomEvent(shadowController.ROOTS_CHANGED_EVENT)
    );
    await settle();
  };

  const dispatchShadowContentChanged = async detail => {
    selfTarget.dispatchEvent(new FakeCustomEvent(
      shadowController.CONTENT_CHANGED_EVENT || 'talon-shadow-content-changed',
      { detail }
    ));
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
  let storageGetFailure = null;
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
      get: async key => {
        if (storageGetFailure !== null) { throw storageGetFailure; }
        return readStorage(key);
      },
    },
  };
  const browser = { runtime, storage };
  const chrome = { runtime, storage };

  const selfTarget = new FakeEventTarget();
  Object.assign(selfTarget, {
    browser,
    chrome,
    document,
    location: { hostname, href: 'https://example.com/' },
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
    HTMLIFrameElement: FakeHTMLIFrameElement,
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
    guard,
    shadowController,
    createElement,
    createShadowHost,
    async load() {
      vm.runInNewContext(automationSource, context, { filename: 'automation.js' });
      await settle();
      return selfTarget.TalonAutomationController;
    },
    reinject() {
      return vm.runInNewContext(automationSource, context, {
        filename: 'automation.js',
      });
    },
    setStorageGetFailure(reason = null) {
      storageGetFailure = reason;
    },
    async advanceTime(ms) {
      await advanceTime(ms);
    },
    async triggerMutations(records) {
      await triggerMutations(records);
    },
    async dispatchShadowRootsChanged() {
      await dispatchShadowRootsChanged();
    },
    async dispatchShadowContentChanged(detail) {
      await dispatchShadowContentChanged(detail);
    },
    async dispatchProtectionChanged() {
      selfTarget.dispatchEvent(new FakeCustomEvent('talon-protection-changed'));
      await settle();
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

test('automation repairs a detached document hide style without a selector sweep', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'repair-document-hide',
        hosts: ['*'],
        action: 'hide',
        directStyle: true,
        selectors: ['#document-popup'],
      },
    ],
  });
  const popup = harness.createElement({ id: 'document-popup' });
  await harness.load();

  const styleId = 'ubol-automation-style-repair-document-hide';
  const before = harness.readStyle(harness.document, styleId);
  assert.ok(before);
  const foreignShadow = harness.createShadowHost();
  foreignShadow.root.append(before);
  assert.equal(before.isConnected, true);
  assert.equal(before.getRootNode(), foreignShadow.root);
  assert.equal(harness.isHidden(popup), false);

  await harness.triggerMutations([{
    type: 'childList',
    target: harness.document.head,
    addedNodes: [],
    removedNodes: [before],
  }]);

  const after = harness.readStyle(harness.document, styleId);
  assert.ok(after);
  assert.notEqual(after, before);
  assert.equal(harness.isHidden(popup), true);
});

test('automation repairs a detached shadow-root hide style', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'repair-shadow-hide',
        hosts: ['*'],
        action: 'hide',
        directStyle: true,
        selectors: ['.shadow-popup'],
      },
    ],
  });
  const shadow = harness.createShadowHost();
  const popup = harness.createElement({
    className: 'shadow-popup',
    parent: shadow.root,
  });
  harness.shadowController.registerRoot(shadow.root);
  await harness.load();

  const styleId = 'ubol-automation-style-repair-shadow-hide';
  const before = harness.readStyle(shadow.root, styleId);
  assert.ok(before);
  before.remove();
  assert.equal(harness.isHidden(popup), false);

  await harness.dispatchShadowContentChanged({
    roots: [shadow.root],
    addedNodes: [],
    removedNodes: [before],
    overflowed: false,
  });

  const after = harness.readStyle(shadow.root, styleId);
  assert.ok(after);
  assert.notEqual(after, before);
  assert.equal(harness.isHidden(popup), true);
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
  assert.equal(documentBanner.getAttribute('data-ubol-automation'), 'stop-hide');
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
  assert.equal(documentBanner.getAttribute('data-ubol-automation'), null);

  await harness.setStorageLocal({
    rulesetConfig: { enabledRulesets: ['annoyances-overlays'] },
  });
  assert.equal(
    harness.isHidden(documentBanner),
    false,
    'an explicitly stopped controller must not restart from a storage event'
  );
});

test('automation releases owned markers when hidden targets detach', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'detach-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.detaching-banner'],
      },
    ],
  });
  const banner = harness.createElement({ className: 'detaching-banner' });

  await harness.load();
  assert.equal(banner.getAttribute('data-ubol-automation'), 'detach-hide');

  banner.remove();
  await harness.triggerMutations([{
    type: 'childList',
    target: harness.document.body,
    addedNodes: [],
    removedNodes: [banner],
  }]);
  await harness.advanceTime(50);

  assert.equal(
    banner.getAttribute('data-ubol-automation'),
    null,
    'detached targets must not remain strongly retained by the owned-marker map'
  );
});

test('automation stop restores scroll styles changed by post-actions', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'unlock-scroll',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.modal-ad'],
        postActions: ['unlockScroll'],
      },
    ],
  });
  harness.document.body.style.setProperty('overflow', 'hidden', 'important');
  harness.createElement({ className: 'modal-ad' });

  const controller = await harness.load();
  assert.equal(harness.document.body.style.getPropertyValue('overflow'), 'auto');

  await controller.stop();
  await harness.settle();

  assert.equal(harness.document.body.style.getPropertyValue('overflow'), 'hidden');
});

test('automation stop preserves a site-owned style update with Talon\'s last value', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'unlock-scroll-ownership',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.modal-ad'],
        postActions: ['unlockScroll'],
      },
    ],
  });
  harness.document.body.style.setProperty('overflow', 'hidden', 'important');
  harness.createElement({ className: 'modal-ad' });

  const controller = await harness.load();
  harness.document.body.style.setProperty('overflow', 'auto');

  await controller.stop();
  await harness.settle();

  assert.equal(harness.document.body.style.getPropertyValue('overflow'), 'auto');
  assert.equal(harness.document.body.style.getPropertyPriority('overflow'), '');
});

test('automation resumes after SPA protection changes even when no directive was initially allowed', async () => {
  let directivesAllowed = false;
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'spa-protection-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.route-popup'],
      },
    ],
    guardOverrides: {
      shouldAllowDirective: () => directivesAllowed,
    },
  });
  const popup = harness.createElement({ className: 'route-popup' });

  await harness.load();
  assert.equal(harness.isHidden(popup), false);

  directivesAllowed = true;
  await harness.dispatchProtectionChanged();

  assert.equal(harness.isHidden(popup), true);
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

test('automation preserves last-good directives and rejects live readiness on storage failure', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'last-good-hide',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.last-good-banner'],
      },
    ],
  });
  const banner = harness.createElement({ className: 'last-good-banner' });

  await harness.load();
  assert.equal(harness.isHidden(banner), true);

  harness.setStorageGetFailure(new Error('transient automation storage failure'));
  const readiness = harness.reinject();
  await assert.rejects(readiness, /transient automation storage failure/);
  await harness.settle();

  assert.equal(
    harness.isHidden(banner),
    true,
    'a failed authoritative refresh must retain the active directive state'
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

test('automation routes unrelated mutation churn without four-hertz full sweeps', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'missing-overlay',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.never-present'],
      },
    ],
  });
  await harness.load();

  const originalQuerySelectorAll = harness.document.querySelectorAll.bind(harness.document);
  let fullQueries = 0;
  harness.document.querySelectorAll = selector => {
    fullQueries += 1;
    return originalQuerySelectorAll(selector);
  };
  const noise = harness.createElement({ className: 'unrelated' });
  for (let i = 0; i < 40; i += 1) {
    await harness.triggerMutations([
      { type: 'childList', addedNodes: [noise], target: harness.document.body },
    ]);
    await harness.advanceTime(250);
  }

  assert.ok(
    fullQueries <= 8,
    `negative backoff should bound full selector sweeps (observed ${fullQueries})`
  );
});

test('automation mutation overflow wakes a late matching target without losing it', async () => {
  const harness = createAutomationHarness({
    directives: [
      {
        id: 'late-overflow-target',
        hosts: ['*'],
        action: 'hide',
        selectors: ['.late-overflow-target'],
      },
    ],
  });
  await harness.load();

  const addedNodes = [];
  for (let i = 0; i < 40; i += 1) {
    addedNodes.push(harness.createElement({ className: 'unrelated' }));
  }
  const target = harness.createElement({ className: 'late-overflow-target' });
  addedNodes.push(target);
  await harness.triggerMutations([{
    type: 'childList',
    addedNodes,
    removedNodes: [],
    target: harness.document.body,
  }]);
  await harness.advanceTime(50);

  assert.equal(harness.isHidden(target), true);
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
  let storageGetFailure = null;
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
      get: async key => {
        if (storageGetFailure !== null) { throw storageGetFailure; }
        return readStorage(key);
      },
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
    location: { hostname, href: 'https://example.com/' },
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
    HTMLStyleElement: FakeHTMLStyleElement,
    HTMLIFrameElement: FakeHTMLIFrameElement,
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
    URL,
    Object,
    Element: FakeElement,
    HTMLStyleElement: FakeHTMLStyleElement,
    HTMLIFrameElement: FakeHTMLIFrameElement,
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
        selfTarget.TalonPostHideCleanupController ||
        selfTarget.TalonRemoteCosmeticsController
      );
    },
    runScript(script) {
      return vm.runInNewContext(script, context, {
        filename: 'content-script.js',
      });
    },
    reinject() {
      return vm.runInNewContext(source, context, {
        filename: 'content-script.js',
      });
    },
    setStorageGetFailure(reason = null) {
      storageGetFailure = reason;
    },
    async settle() {
      await settle();
    },
    async advanceTime(ms) {
      currentTime += Math.max(0, Number(ms) || 0);
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

test('native heuristics keeps added-node scans incremental and pipelines mutation bursts in bounded frames', async () => {
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
  assert.ok(articleQueries.count - baselineArticleQueries <= 2);
  assert.ok(
    harness.getScheduledAnimationFrameCount() - beforeFrames <= 2,
    'native heuristics should pipeline a mutation burst through bounded scan and apply frames'
  );
  assert.equal(harness.isHidden(article), true);

  documentQueries.restore();
  bodyQueries.restore();
  articleQueries.restore();
});

test('native heuristics preserves last-good state and rejects live readiness on storage failure', async () => {
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
  const connectedBefore = harness.countConnectedObservers();
  assert.ok(connectedBefore > 0, 'native controller should be active before refresh');

  harness.setStorageGetFailure(new Error('transient native storage failure'));
  const readiness = harness.reinject();
  await assert.rejects(readiness, /transient native storage failure/);
  await harness.settle();

  assert.equal(
    harness.countConnectedObservers(),
    connectedBefore,
    'a failed authoritative refresh must not tear down the active observer state'
  );
});

test('remote cosmetics retains last-good CSS and rejects wrapper readiness on storage failure', async () => {
  const harness = createContentScriptHarness({
    source: remoteCosmeticsSource,
    storageData: {
      communityBundleCosmetics: {
        all: ['.remote-last-good-ad'],
        hosts: {},
      },
    },
  });

  const controller = await harness.load();
  assert.ok(controller, 'remote cosmetics controller should initialize');
  await harness.runScript(remoteCosmeticsGlobalSource);
  const styleId = 'talon-remote-cosmetics-global-style';
  const style = harness.document.getElementById(styleId);
  assert.ok(style, 'initial remote cosmetic CSS should be applied');
  const lastGoodCss = style.textContent;
  assert.match(lastGoodCss, /\.remote-last-good-ad/);

  harness.setStorageGetFailure(new Error('transient remote cosmetics storage failure'));
  const readiness = harness.runScript(remoteCosmeticsGlobalSource);
  await assert.rejects(readiness, /transient remote cosmetics storage failure/);
  await harness.settle();

  const preservedStyle = harness.document.getElementById(styleId);
  assert.ok(preservedStyle, 'failed refresh must not remove last-good remote CSS');
  assert.equal(preservedStyle.textContent, lastGoodCss);
});

test('native heuristic mutation backpressure coalesces overload into one bounded full scan', async () => {
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

  const addedNodes = [];
  for (let i = 0; i < 700; i += 1) {
    addedNodes.push(harness.createElement({ className: `noise-${i}` }));
  }
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
  addedNodes.push(article);
  const framesBefore = harness.getScheduledAnimationFrameCount();

  harness.triggerObserver(0, [{
    type: 'childList',
    target: harness.document.body,
    addedNodes,
    removedNodes: [],
  }]);
  await harness.settle();

  assert.equal(
    harness.isHidden(article),
    true,
    'the coalesced scan should still find a late ad candidate after overload'
  );
  assert.ok(
    harness.getScheduledAnimationFrameCount() - framesBefore <= 16,
    'overload recovery must remain bounded across animation frames'
  );
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
  assert.equal(
    harness.isHidden(article),
    false,
    'native heuristics stop should restore styles it owns'
  );
});

test('native heuristics releases observers and owned styles when containers detach', async () => {
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
  harness.createElement({
    tagName: 'span',
    className: 'sponsored-label',
    textContent: 'Sponsored',
    parent: article,
    width: 20,
    height: 10,
  });
  harness.triggerObserver(0, [{
    type: 'childList',
    target: harness.document.body,
    addedNodes: [article],
    removedNodes: [],
  }]);
  await harness.settle();
  assert.equal(harness.countConnectedObservers(), 2);

  article.remove();
  harness.triggerObserver(0, [{
    type: 'childList',
    target: harness.document.body,
    addedNodes: [],
    removedNodes: [article],
  }]);
  await harness.settle();

  assert.equal(
    harness.countConnectedObservers(),
    1,
    'detaching a hidden container should leave only the document observer connected'
  );
  assert.equal(
    harness.isHidden(article),
    false,
    'detached containers must not retain Talon-owned inline hiding styles'
  );
});

test('native heuristics does not hide standard-size third-party or payment frames without ad evidence', async () => {
  const harness = createContentScriptHarness({
    source: nativeHeuristicsSource,
    hostname: 'page.example',
    fetchJson: {
      disableHosts: [],
      labelRegexes: ['sponsored'],
      labelSelectors: [],
      widgetSelectors: [],
      containerStopSelectors: ['section'],
      maxLabelTextLength: 40,
      minContainerHeight: 60,
      minContainerWidth: 120,
      minScore: 4,
      minScoreLowConfidence: 5,
    },
  });

  const ordinary = harness.createElement({
    tagName: 'iframe',
    attrs: { src: 'https://example.com/widgets/chart' },
    width: 300,
    height: 250,
  });
  const payment = harness.createElement({
    tagName: 'iframe',
    attrs: {
      src: 'https://example.com/payments/checkout',
      title: 'Secure payment checkout',
      allow: 'payment',
    },
    width: 300,
    height: 250,
  });

  await harness.load();

  assert.equal(harness.isHidden(ordinary), false);
  assert.equal(harness.isHidden(payment), false);
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

  const controller = await harness.load();

  assert.equal(harness.document.readyState, 'loading');
  assert.equal(
    harness.isHidden(wrapper),
    true,
    'early hidden ad shell evidence should collapse its reserved wrapper'
  );

  await controller.stop();
  assert.equal(
    harness.isHidden(wrapper),
    false,
    'stopping cleanup should restore collapsed wrappers owned by Talon'
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

test('post-hide cleanup preserves interactive standard-size content', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  const card = harness.createElement({
    className: 'ad-card',
    width: 300,
    height: 250,
  });
  harness.createElement({
    tagName: 'button',
    textContent: 'Continue',
    parent: card,
    width: 120,
    height: 40,
  });

  await harness.load();

  assert.equal(
    harness.isHidden(card),
    false,
    'standard dimensions plus an ad-like class must not hide interactive content'
  );
});

test('post-hide cleanup revisits an ad shell after its meaningful child is removed', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  const shell = harness.createElement({
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  const content = harness.createElement({
    className: 'creative-content',
    parent: shell,
    width: 280,
    height: 220,
  });

  await harness.load();
  assert.equal(harness.isHidden(shell), false);

  content.remove();
  harness.triggerObserver(0, [{
    type: 'childList',
    target: shell,
    addedNodes: [],
    removedNodes: [content],
  }]);
  await harness.settle();

  assert.equal(harness.isHidden(shell), true);
});

test('post-hide cleanup releases owned styles when a collapsed shell detaches', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  const shell = harness.createElement({
    className: 'ad-slot',
    width: 300,
    height: 250,
  });

  await harness.load();
  assert.equal(harness.isHidden(shell), true);

  shell.remove();
  harness.triggerObserver(0, [{
    type: 'childList',
    target: harness.document.body,
    addedNodes: [],
    removedNodes: [shell],
  }]);
  await harness.settle();

  assert.equal(
    harness.isHidden(shell),
    false,
    'detached shells must not retain Talon-owned inline hiding styles'
  );
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
  assert.ok(
    wrapperQueries.count <= 2,
    'added-subtree processing should only run bounded candidate safety queries'
  );
  assert.ok(
    harness.getScheduledAnimationFrameCount() - beforeFrames <= 2,
    'post-hide cleanup should batch a mutation burst into bounded collection and apply frames'
  );
  assert.equal(harness.isHidden(slot), true);

  documentQueries.restore();
  wrapperQueries.restore();
});

test('post-hide cleanup time-slices one large inserted subtree', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  await harness.load();

  const subtree = harness.createElement({ tagName: 'section' });
  for (let i = 0; i < 900; i += 1) {
    harness.createElement({ className: `subtree-noise-${i}`, parent: subtree });
  }
  const shell = harness.createElement({
    className: 'ad-slot',
    parent: subtree,
    width: 300,
    height: 250,
  });
  const framesBefore = harness.getScheduledAnimationFrameCount();

  harness.triggerObserver(0, [{
    type: 'childList',
    target: harness.document.body,
    addedNodes: [subtree],
    removedNodes: [],
  }]);
  await harness.settle();

  assert.equal(harness.isHidden(shell), true);
  assert.ok(
    harness.getScheduledAnimationFrameCount() - framesBefore <= 12,
    'one large subtree must be divided into bounded collection slices'
  );
});

test('post-hide cleanup bounds candidate queues during mutation churn', async () => {
  const harness = createContentScriptHarness({
    source: postHideCleanupSource,
  });
  await harness.load();

  const records = [];
  for (let i = 0; i < 700; i += 1) {
    const target = harness.createElement({
      className: 'ad-slot',
      width: 10,
      height: 10,
    });
    records.push({
      type: 'childList',
      target,
      addedNodes: [],
      removedNodes: [harness.document.createElement('div')],
    });
  }
  const shell = harness.createElement({
    className: 'ad-slot',
    width: 300,
    height: 250,
  });
  records.push({
    type: 'childList',
    target: shell,
    addedNodes: [],
    removedNodes: [harness.document.createElement('div')],
  });
  const framesBefore = harness.getScheduledAnimationFrameCount();

  harness.triggerObserver(0, records);
  await harness.settle();

  assert.equal(
    harness.isHidden(shell),
    false,
    'the hard cap should defer a late candidate instead of growing the queue'
  );
  await harness.advanceTime(100);
  assert.equal(harness.isHidden(shell), true);
  assert.ok(
    harness.getScheduledAnimationFrameCount() - framesBefore <= 16,
    'overflow recovery must remain budgeted across collection and processing slices'
  );
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
