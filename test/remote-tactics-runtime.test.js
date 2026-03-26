import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const remoteTacticsSource = await fs.readFile(
  new URL('../js/scripting/remote-tactics.js', import.meta.url),
  'utf8'
);

const PAGE_URL = 'https://www.example.com/watch';
const DEFAULT_TACTICS = [
  {
    id: 'prune-ads',
    kind: 'jsonPrune',
    transport: 'both',
    urlPathPrefixes: ['/api/player'],
    jsonPaths: ['payload.ads'],
  },
];
const DEFAULT_BODY = {
  payload: {
    ads: [{ id: 1 }],
    keep: true,
  },
};

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
    const bucket = [...(this.listeners.get(event?.type) || [])];
    for (const listener of bucket) {
      listener.call(this, event);
    }
    return true;
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class FakeHeaders {
  constructor(init = undefined) {
    this.values = new Map();
    if (init instanceof FakeHeaders) {
      for (const [name, value] of init.values) {
        this.values.set(name, value);
      }
      return;
    }
    if (Array.isArray(init)) {
      for (const [name, value] of init) {
        this.set(name, value);
      }
      return;
    }
    if (init instanceof Map) {
      for (const [name, value] of init) {
        this.set(name, value);
      }
      return;
    }
    if (init && typeof init === 'object') {
      for (const [name, value] of Object.entries(init)) {
        this.set(name, value);
      }
    }
  }

  get(name) {
    return this.values.get(String(name || '').trim().toLowerCase()) || null;
  }

  set(name, value) {
    this.values.set(String(name || '').trim().toLowerCase(), String(value));
  }
}

class FakeResponse {
  constructor(body, options = {}) {
    this._body = cloneValue(body);
    this.status = options.status || 200;
    this.statusText = options.statusText || 'OK';
    this.headers = new FakeHeaders(options.headers);
    this.url = options.url || '';
    this.redirected = options.redirected || false;
    this.type = options.type || 'basic';
    this.ok = this.status >= 200 && this.status < 300;
  }

  clone() {
    return new FakeResponse(this._body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      url: this.url,
      redirected: this.redirected,
      type: this.type,
    });
  }

  async json() {
    if (typeof this._body === 'string') {
      return JSON.parse(this._body);
    }
    return cloneValue(this._body);
  }

  static json(value, options = {}) {
    const headers = new FakeHeaders(options.headers);
    if (headers.get('content-type') === null) {
      headers.set('content-type', 'application/json');
    }
    return new FakeResponse(value, {
      status: options.status,
      statusText: options.statusText,
      headers,
      url: options.url,
      redirected: options.redirected,
      type: options.type,
    });
  }
}

class FakeRequest {
  constructor(url) {
    this.url = String(url || '');
  }
}

const createFakeTimers = () => {
  let now = 0;
  let nextId = 1;
  const tasks = [];

  const runDueTasks = () => {
    tasks.sort((left, right) => left.time - right.time || left.id - right.id);
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const task of tasks) {
        if (task.cleared || task.ran || task.time > now) { continue; }
        task.ran = true;
        task.callback();
        advanced = true;
      }
    }
  };

  return {
    setTimeout(callback, delay = 0) {
      const id = nextId++;
      tasks.push({
        id,
        time: now + Math.max(0, Number(delay) || 0),
        callback,
        cleared: false,
        ran: false,
      });
      return id;
    },
    clearTimeout(id) {
      const task = tasks.find(entry => entry.id === id);
      if (task) {
        task.cleared = true;
      }
    },
    advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      runDueTasks();
    },
    runAll() {
      while (tasks.some(task => task.cleared === false && task.ran === false)) {
        tasks.sort((left, right) => left.time - right.time || left.id - right.id);
        now = tasks.find(task => task.cleared === false && task.ran === false)?.time || now;
        runDueTasks();
      }
    },
  };
};

const createFakeXMLHttpRequestClass = sentRequests => class FakeXMLHttpRequest {
  constructor() {
    this.method = '';
    this.url = '';
    this.async = true;
    this.readyState = 0;
    this.sendCount = 0;
    this.abortCount = 0;
    this._responseType = '';
    this._responseText = '';
    this._response = '';
    this._responseHeaders = new Map();
  }

  open(method, url, async = true) {
    this.method = String(method || '');
    this.url = String(url || '');
    this.async = async !== false;
    this.readyState = 1;
    this._responseText = '';
    this._response = this._responseType === 'json' ? null : '';
  }

  send(...args) {
    this.sendArgs = args;
    this.sendCount += 1;
    this.readyState = 2;
    sentRequests.push(this);
  }

  abort() {
    this.abortCount += 1;
    this.readyState = 0;
  }

  get responseType() {
    return this._responseType;
  }

  set responseType(value) {
    this._responseType = String(value || '');
    if (this.readyState < 4) {
      this._response = this._responseType === 'json' ? null : '';
    }
  }

  get response() {
    if (this.readyState < 4) {
      return this._responseType === 'json' ? null : '';
    }
    return this._responseType === 'json'
      ? this._response
      : this._responseText;
  }

  get responseText() {
    if (this._responseType === 'json') {
      throw new Error('InvalidStateError');
    }
    return this.readyState < 4 ? '' : this._responseText;
  }

  getResponseHeader(name) {
    if (this.readyState < 2) { return null; }
    return this._responseHeaders.get(String(name || '').trim().toLowerCase()) || null;
  }

  respondJson(value, { contentType = 'application/json' } = {}) {
    const cloned = cloneValue(value);
    this.readyState = 4;
    this._responseHeaders.set('content-type', contentType);
    this._responseText = JSON.stringify(cloned);
    this._response = this._responseType === 'json'
      ? cloneValue(cloned)
      : this._responseText;
  }
};

const cloneValue = value => (
  value === null || typeof value !== 'object'
    ? value
    : structuredClone(value)
);

const resolveUrl = input => {
  const raw = input instanceof FakeRequest ? input.url : String(input || '');
  return new URL(raw, PAGE_URL).toString();
};

const flushMicrotasks = async (count = 4) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

const createHarness = ({
  tactics = DEFAULT_TACTICS,
  autoRespond = true,
  fetchBody = DEFAULT_BODY,
} = {}) => {
  const document = new FakeEventTarget();
  const timers = createFakeTimers();
  const requestEvents = [];
  const sentRequests = [];
  const FakeXMLHttpRequest = createFakeXMLHttpRequestClass(sentRequests);
  const originalFetch = async input => new FakeResponse(fetchBody, {
    url: resolveUrl(input),
    headers: { 'content-type': 'application/json' },
  });

  const dispatchConfig = (
    requestId = requestEvents.at(-1)?.requestId || 0,
    nextTactics = tactics,
    nextHostname = 'www.example.com'
  ) => document.dispatchEvent(new FakeCustomEvent('td-remote-tactics-config', {
    detail: {
      hostname: nextHostname,
      requestId,
      tactics: nextTactics,
    },
  }));

  document.addEventListener('td-remote-tactics-request', event => {
    requestEvents.push(event.detail);
    if (autoRespond) {
      dispatchConfig(event.detail.requestId, tactics, event.detail.hostname);
    }
  });

  const context = {
    Object,
    Array,
    JSON,
    Map,
    Set,
    WeakMap,
    Proxy,
    Reflect,
    URL,
    Request: FakeRequest,
    Response: FakeResponse,
    CustomEvent: FakeCustomEvent,
    Promise,
    structuredClone,
    document,
    fetch: originalFetch,
    XMLHttpRequest: FakeXMLHttpRequest,
    location: {
      href: PAGE_URL,
      hostname: 'www.example.com',
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console,
  };
  context.self = context;

  vm.runInNewContext(remoteTacticsSource, context, { filename: 'remote-tactics.js' });

  return {
    context,
    document,
    dispatchConfig,
    originalFetch,
    requestEvents,
    sentRequests,
    FakeXMLHttpRequest,
    timers,
  };
};

test('remote tactics mutates same-origin fetch JSON responses', async () => {
  const harness = createHarness();

  const response = await harness.context.fetch('https://www.example.com/api/player');

  assert.notEqual(harness.context.fetch, harness.originalFetch);
  assert.deepEqual(await response.json(), {
    payload: {
      keep: true,
    },
  });
});

test('remote tactics mutates async XHR when responseText is read first', () => {
  const harness = createHarness();
  const xhr = new harness.context.XMLHttpRequest();

  xhr.open('GET', '/api/player');
  xhr.send();
  xhr.respondJson(DEFAULT_BODY);

  assert.equal(xhr.responseText, JSON.stringify({
    payload: {
      keep: true,
    },
  }));
  assert.equal(xhr.response, xhr.responseText);
});

test('remote tactics keeps XHR response and responseText consistent for text-backed responses', () => {
  const harness = createHarness();
  const xhr = new harness.context.XMLHttpRequest();

  xhr.open('GET', '/api/player');
  xhr.send();
  xhr.respondJson(DEFAULT_BODY);

  const response = xhr.response;

  assert.equal(response, JSON.stringify({
    payload: {
      keep: true,
    },
  }));
  assert.equal(xhr.responseText, response);
});

test('remote tactics preserves native responseText behavior for responseType json', () => {
  const harness = createHarness();
  const xhr = new harness.context.XMLHttpRequest();

  xhr.responseType = 'json';
  xhr.open('GET', '/api/player');
  xhr.send();
  xhr.respondJson(DEFAULT_BODY);

  assert.deepEqual(xhr.response, {
    payload: {
      keep: true,
    },
  });
  assert.throws(() => xhr.responseText, /InvalidStateError/);
});

test('remote tactics delays async same-origin XHR until config is ready but does not delay sync XHR', async () => {
  const harness = createHarness({ autoRespond: false });
  const asyncXhr = new harness.context.XMLHttpRequest();
  const syncXhr = new harness.context.XMLHttpRequest();

  asyncXhr.open('GET', '/api/player', true);
  asyncXhr.send();
  assert.equal(harness.sentRequests.length, 0);

  syncXhr.open('GET', '/api/player', false);
  syncXhr.send();
  assert.equal(harness.sentRequests.length, 1);
  assert.equal(harness.sentRequests[0], syncXhr);

  harness.dispatchConfig(harness.requestEvents[0].requestId);
  await flushMicrotasks();

  assert.equal(harness.sentRequests.length, 2);
  assert.equal(harness.sentRequests[1], asyncXhr);

  asyncXhr.respondJson(DEFAULT_BODY);
  assert.equal(asyncXhr.responseText, JSON.stringify({
    payload: {
      keep: true,
    },
  }));
});

test('remote tactics stop restores native globals and allows a clean reinstall', async () => {
  const harness = createHarness();
  const wrappedFetch = harness.context.fetch;
  const WrappedXMLHttpRequest = harness.context.XMLHttpRequest;

  assert.equal(harness.document.listenerCount('td-remote-tactics-config'), 1);
  assert.notEqual(wrappedFetch, harness.originalFetch);
  assert.notEqual(WrappedXMLHttpRequest, harness.FakeXMLHttpRequest);

  await harness.context.TalonRemoteTacticsController.stop();

  assert.equal(harness.context.fetch, harness.originalFetch);
  assert.equal(harness.context.XMLHttpRequest, harness.FakeXMLHttpRequest);
  assert.equal('TalonRemoteTacticsController' in harness.context, false);
  assert.equal(harness.document.listenerCount('td-remote-tactics-config'), 0);

  vm.runInNewContext(remoteTacticsSource, harness.context, { filename: 'remote-tactics.js' });

  assert.notEqual(harness.context.fetch, harness.originalFetch);
  assert.notEqual(harness.context.XMLHttpRequest, harness.FakeXMLHttpRequest);
  assert.equal(harness.document.listenerCount('td-remote-tactics-config'), 1);
});
