// Minimal in-memory implementation of the Chrome APIs background.js uses.
// Passing the same `store`, `alarms` and `tabs` to a second mock simulates a
// service-worker restart: persistent data survives, in-memory state doesn't.

import { CONTENT, PANEL } from '../../lib/protocol.js';

const EXT_ID = 'test-extension-id';
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

export function createChromeEnv({ store = {}, alarms = new Map(), tabs = new Map() } = {}) {
  const ev = {
    onMessage: event(),
    onInstalled: event(),
    onStartup: event(),
    onAlarm: event(),
    onRemoved: event(),
    onChanged: event(),
  };
  const content = { handler: null, injected: 0, sent: [], reloads: 0 };
  const ui = { badge: '', notifications: [] };

  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p = '') => `chrome-extension://${EXT_ID}/${p}`,
      onMessage: ev.onMessage,
      onInstalled: ev.onInstalled,
      onStartup: ev.onStartup,
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: clone(v) };
            store[k] = clone(v);
          }
          ev.onChanged.listeners.forEach((fn) => fn(changes, 'local'));
        },
      },
      onChanged: ev.onChanged,
    },
    alarms: {
      async create(name, info) {
        alarms.set(name, {
          name,
          scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? info.periodInMinutes ?? 0) * 60_000,
          periodInMinutes: info.periodInMinutes,
        });
      },
      async get(name) {
        return clone(alarms.get(name));
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: ev.onAlarm,
    },
    tabs: {
      async query({ url }) {
        const prefix = url.replace('*', '');
        return [...tabs.values()].filter((t) => t.url?.startsWith(prefix)).map(clone);
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        return clone(tabs.get(id));
      },
      async update(id, props) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        Object.assign(tabs.get(id), props);
        return clone(tabs.get(id));
      },
      async create(props) {
        const id = 500 + tabs.size;
        tabs.set(id, { id, windowId: 1, active: true, ...props });
        return clone(tabs.get(id));
      },
      async sendMessage(tabId, msg) {
        content.sent.push({ tabId, msg: clone(msg) });
        if (!tabs.has(tabId) || !content.handler) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return clone(await content.handler(tabId, clone(msg)));
      },
      async reload(id) {
        if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
        content.reloads++;
      },
      onRemoved: ev.onRemoved,
    },
    action: {
      async setBadgeText({ text }) {
        ui.badge = text;
      },
      async setBadgeBackgroundColor() {},
    },
    notifications: {
      async create(id, options) {
        ui.notifications.push({ id, ...options });
        return id;
      },
      async clear() {
        return true;
      },
      onClicked: event(),
    },
    scripting: {
      async executeScript() {
        content.injected++;
      },
    },
    sidePanel: { async setPanelBehavior() {} },
    windows: { async update() {} },
  };

  function dispatch(msg, sender) {
    return new Promise((resolve) => {
      let responded = false;
      let willRespond = false;
      const sendResponse = (r) => {
        responded = true;
        resolve(clone(r));
      };
      for (const fn of ev.onMessage.listeners) {
        if (fn(clone(msg), sender, sendResponse) === true) willRespond = true;
      }
      if (!willRespond && !responded) resolve(undefined);
    });
  }

  return {
    chrome,
    store,
    alarms,
    tabs,
    content,
    ui,
    events: ev,
    panel: (type, payload = {}) =>
      dispatch({ type, ...payload }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html` }),
    fromContent: (tabId, msg, url = tabs.get(tabId)?.url) =>
      dispatch(msg, { id: EXT_ID, url, tab: { id: tabId }, frameId: 0 }),
    raw: dispatch,
    async fire(eventName, ...args) {
      ev[eventName].listeners.forEach((fn) => fn(...args));
      await dispatch({ type: PANEL.STATE_GET }, { id: EXT_ID, url: `chrome-extension://${EXT_ID}/sidepanel.html` });
    },
    async fireAlarm(name) {
      await this.fire('onAlarm', { name });
    },
    state: () => clone(store['gvsh.state']),
  };
}

/**
 * Scripted stand-in for content.js. Tests drive each job explicitly:
 * fc.prepared(), fc.commit(), fc.result('accepted').
 */
export function createFakeContent(env, tabId, { page = 'ready' } = {}) {
  const fc = {
    page,
    busyJobId: null,
    lastJob: null,
    jobs: [],
    aborts: [],
    acceptJobs: true,
    committed: new Set(),
    get job() {
      return fc.jobs.at(-1);
    },
    prepared: (job = fc.job) =>
      env.fromContent(tabId, { type: CONTENT.PROGRESS, jobId: job.jobId, stage: 'prepared', step: 'verify_message' }),
    async commit(job = fc.job) {
      const r = await env.fromContent(tabId, { type: CONTENT.COMMIT, jobId: job.jobId });
      if (r?.proceed) fc.committed.add(job.jobId);
      return r;
    },
    result(outcome, extra = {}, job = fc.job) {
      if (fc.busyJobId === job.jobId) fc.busyJobId = null;
      const msg = {
        type: CONTENT.RESULT,
        jobId: job.jobId,
        outcome,
        sendAttempted: fc.committed.has(job.jobId) && outcome !== 'aborted',
        ...extra,
      };
      return env.fromContent(tabId, msg);
    },
  };
  env.content.handler = async (_tab, msg) => {
    switch (msg.type) {
      case CONTENT.PING:
        return { ok: true, page: fc.page, busyJobId: fc.busyJobId, lastJob: fc.lastJob, visibility: 'visible' };
      case CONTENT.SEND:
        if (!fc.acceptJobs) return { accepted: false, code: 'CONTENT_BUSY' };
        fc.jobs.push(msg);
        fc.busyJobId = msg.jobId;
        return { accepted: true };
      case CONTENT.ABORT:
        fc.aborts.push(msg.jobId);
        return fc.committed.has(msg.jobId) ? { aborted: false, committed: true } : { aborted: true };
      case CONTENT.DIAGNOSE:
        return { ok: true, page: fc.page, checks: [{ key: 'appShell', label: 'app navigation', found: true, optional: false }], blockingDialogs: 0 };
      default:
        return undefined;
    }
  };
  return fc;
}

let instance = 0;
/** Import a fresh copy of background.js bound to `env.chrome`. */
export async function loadBackground(env) {
  globalThis.chrome = env.chrome;
  await import(new URL(`../../background.js?instance=${++instance}`, import.meta.url));
  await env.panel(PANEL.STATE_GET); // let onWake finish
}
