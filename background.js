// GV Sheet Helper — background service worker.
//
// Owns the queue. The side panel only sends commands and renders the state
// stored in chrome.storage.local; the content script only prepares and sends
// a single message when asked to.
//
// Service workers are stopped whenever Chrome likes, so:
//  - all queue state lives in chrome.storage.local and is written after every
//    meaningful transition;
//  - the delay between messages is a chrome.alarms alarm, not a setTimeout;
//  - a watchdog alarm checks on the in-flight message.
//
// Duplicate-send protection ("two-phase commit"): the content script fills in
// the composer, then asks for permission to press Send (CONTENT.COMMIT). The
// worker persists the item as `sending` before it answers yes. If anything is
// interrupted after that point, the item becomes `unknown`, and unknown items
// are never retried automatically.

import { parseContacts, extractPhones, MAX_CONTACTS, MAX_SHEET_ROWS } from './lib/parser.js';
import { applyVersions, sanitizeVersions } from './lib/variations.js';
import {
  HISTORY_KEY,
  createHistory,
  restoreHistory,
  historySize,
  historyStats,
  lookupNumbers,
  recordNumber,
  recordOptOut,
  removeOptOut,
  clearTexted,
  forgetUnconfirmed,
  pruneHistory,
} from './lib/history.js';
import {
  PANEL,
  CONTENT,
  describeError,
  isFatal,
  validatePanelMessage,
  validateContentMessage,
} from './lib/protocol.js';
import {
  STATUS,
  ITEM,
  LOG_LIMIT,
  SCHEMA_VERSION,
  createEmptyState,
  buildItems,
  applyPolicies,
  computeCounts,
  nextPendingItem,
  retryKind,
  itemLabel,
  redactDigits,
  normalizeSettings,
  pickDelayMs,
  validateSettings,
  localDayKey,
  sentOnDay,
  dailyLimitReached,
  nextSendTime,
  windowLabel,
} from './lib/queue-model.js';

const STATE_KEY = 'gvsh.state';
const SETTINGS_KEY = 'gvsh.settings';
// Messages sent per local day, kept apart from the queue so clearing or
// re-importing doesn't reset the daily limit.
const DAILY_KEY = 'gvsh.daily';
const ALARM_NEXT = 'gvsh-next';
const ALARM_WATCHDOG = 'gvsh-watchdog';

const GV_ORIGIN = 'https://voice.google.com/';
const GV_TAB_PATTERN = 'https://voice.google.com/*';
const GV_HOME_URL = 'https://voice.google.com/u/0/messages';
const CONTENT_FILES = ['gv-selectors.js', 'content.js'];

// The content script must press Send within COMMIT_WINDOW_MS of receiving a
// job; it then has roughly 45 s to observe the result. JOB_TIMEOUT_MS covers both.
const COMMIT_WINDOW_MS = 100_000;
const JOB_TIMEOUT_MS = 160_000;
const SEND_GRACE_MS = 30_000;
const LOST_JOB_GRACE_MS = 20_000;
const PING_TIMEOUT_MS = 4_000;
const DIAGNOSE_TIMEOUT_MS = 8_000;
const WATCHDOG_PERIOD_MIN = 0.5;
const BUSY_RETRY_MS = 30_000;
// A Google Voice tab that stops answering (Chrome froze or discarded it during
// a long wait) is reloaded once, then the send is tried again.
const RELOAD_RETRY_MS = 20_000;
const RELOAD_COOLDOWN_MS = 10 * 60_000;

let state = null;
let settings = null;
let daily = null;
let history = null; // numbers texted before, as fingerprints (lib/history.js)
let historyDirty = false;

// Every handler runs through this chain, so state transitions never interleave.
let chain = Promise.resolve();
function serialize(task) {
  const run = chain.then(task);
  chain = run.catch((err) => console.error('[GV Sheet Helper]', err));
  return run;
}

// ---------------------------------------------------------------------------
// State persistence

async function ensureLoaded() {
  if (state && settings && daily && history) return;
  const stored = await chrome.storage.local.get([STATE_KEY, SETTINGS_KEY, DAILY_KEY, HISTORY_KEY]);
  state = restoreState(stored[STATE_KEY]);
  settings = normalizeSettings(stored[SETTINGS_KEY]);
  const d = stored[DAILY_KEY];
  daily = d && typeof d.day === 'string' && Number.isInteger(d.count) ? d : { day: localDayKey(Date.now()), count: 0 };
  history = restoreHistory(stored[HISTORY_KEY]);
  if (!history) {
    // First run with a history: start it from whatever the current queue already sent.
    history = createHistory();
    for (const item of state.items) {
      if (item.status === ITEM.ACCEPTED || item.status === ITEM.UNKNOWN) {
        await recordNumber(history, item.phone, item.updatedAt ?? Date.now(), item.status === ITEM.ACCEPTED);
      }
    }
    historyDirty = true;
  }
}

function restoreState(raw) {
  if (!raw || raw.schema !== SCHEMA_VERSION || !Array.isArray(raw.items)) return createEmptyState();
  return { ...createEmptyState(), ...raw };
}

async function persist() {
  state.updatedAt = Date.now();
  const data = { [STATE_KEY]: state, [DAILY_KEY]: daily };
  // The history can be large, so it is only written when it changed.
  if (historyDirty) {
    pruneHistory(history);
    data[HISTORY_KEY] = history;
    historyDirty = false;
  }
  await chrome.storage.local.set(data);
  updateBadge();
}

let lastBadge = null;
/** The toolbar icon shows the run state: contacts left, paused, stopped or done. */
function updateBadge() {
  const c = computeCounts(state.items);
  let text = '';
  let color = '#2563eb';
  if (state.status === STATUS.RUNNING) text = c.remaining > 999 ? '999+' : String(c.remaining);
  else if (state.status === STATUS.PAUSED) [text, color] = ['II', '#b45309'];
  else if (state.status === STATUS.STOPPED && state.stopReason?.code !== 'STOPPED_BY_USER') [text, color] = ['!', '#b91c1c'];
  else if (state.status === STATUS.COMPLETED) [text, color] = ['✓', '#15803d'];
  const key = `${text}|${color}`;
  if (key === lastBadge || !chrome.action?.setBadgeText) return;
  lastBadge = key;
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor?.({ color }).catch(() => {});
}

/** Desktop notification for something the user needs to know while away. */
function notifyUser(title, message) {
  if (!settings?.notify || !chrome.notifications?.create) return;
  chrome.notifications
    .create(`gvsh-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 })
    .catch(() => {});
}

/** Keep Chrome from discarding the Google Voice tab while a queue runs. */
function keepTabLoaded(tabId, keep) {
  if (tabId == null) return;
  chrome.tabs.update(tabId, { autoDiscardable: !keep }).catch(() => {});
}

/** Remember that this item's number was texted (or may have been). */
async function rememberSent(item, confirmed) {
  if (await recordNumber(history, item.phone, Date.now(), confirmed)) historyDirty = true;
}

/** Re-check a queue that hasn't started against the current history. */
async function refreshTextedFlags() {
  if (state.status !== STATUS.READY || state.items.some((i) => i.attempts > 0)) return;
  const texted = await lookupNumbers(history, state.items.map((i) => i.phone));
  for (const item of state.items) {
    const found = item.phone ? texted.get(item.phone) : null;
    const hit = found?.optedOut ? null : found;
    item.textedAt = hit?.at ?? null;
    item.textedConfirmed = Boolean(hit?.confirmed);
  }
  applyPolicies(state.items, state.duplicatePolicy, state.historyPolicy);
}

/** Count one message toward today's limit (called when Send is about to be pressed). */
function countTowardDailyLimit(now) {
  const day = localDayKey(now);
  daily = daily?.day === day ? { day, count: daily.count + 1 } : { day, count: 1 };
}

const formatResumeTime = (t) =>
  new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });


function log(level, text) {
  state.log.push({ t: Date.now(), level, text });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

const findItem = (id) => state.items.find((i) => i.id === id) || null;
const isGvUrl = (url) => typeof url === 'string' && url.startsWith(GV_ORIGIN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

function errorRecord(code, detail) {
  return {
    code,
    message: describeError(code),
    detail: detail ? redactDigits(detail).slice(0, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle

function configurePanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  configurePanel();
  serialize(() => recover('The extension was installed, updated or reloaded.'));
});

chrome.runtime.onStartup.addListener(() => {
  configurePanel();
  serialize(() => recover('Chrome restarted.'));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NEXT) serialize(onNextAlarm);
  else if (alarm.name === ALARM_WATCHDOG) serialize(watchdog);
});

chrome.notifications?.onClicked?.addListener((id) => {
  chrome.notifications.clear(id).catch(() => {});
  serialize(async () => {
    await ensureLoaded();
    const tab = await resolveTab();
    if (tab.ok) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      if (tab.tab.windowId != null) await chrome.windows.update(tab.tab.windowId, { focused: true }).catch(() => {});
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => onTabGone(tabId, 'TAB_CLOSED'));
});

chrome.runtime.onMessage.addListener(onMessage);

serialize(onWake);

/** Runs every time the worker starts. Never dispatches directly. */
async function onWake() {
  await ensureLoaded();
  if (state.status !== STATUS.RUNNING) return;
  if (state.inFlight) {
    await ensureWatchdog();
  } else if (!(await chrome.alarms.get(ALARM_NEXT))) {
    await chrome.alarms.create(ALARM_NEXT, { when: Math.max(state.nextAt ?? 0, Date.now() + 1000) });
  }
}

/**
 * Chrome or the extension restarted: content scripts from before are gone or
 * orphaned. Resolve the in-flight item conservatively and pause.
 */
async function recover(reason) {
  await ensureLoaded();
  let changed = false;
  if (state.status === STATUS.RUNNING) {
    state.status = STATUS.PAUSED;
    state.pauseReason = `${reason} Review the queue, then resume.`;
    log('warn', `Queue paused. ${reason}`);
    changed = true;
  }
  if (state.inFlight) {
    sendToTab(state.inFlight.tabId, { type: CONTENT.ABORT, jobId: state.inFlight.jobId });
    await resolveInterruptedJob('INTERRUPTED');
    changed = true;
  }
  await chrome.alarms.clear(ALARM_NEXT);
  await chrome.alarms.clear(ALARM_WATCHDOG);
  if (changed) await persist();
}

async function resolveInterruptedJob(code) {
  if (state.inFlight?.stage === 'sending') {
    await finishJob({ outcome: 'unknown', code: 'SEND_UNCONFIRMED', detail: describeError(code) });
  } else {
    await finishJob({ outcome: 'aborted', code });
  }
}

async function onTabGone(tabId, code) {
  await ensureLoaded();
  if (state.tabId !== tabId && state.inFlight?.tabId !== tabId) return;
  const wasRunning = state.status === STATUS.RUNNING;
  if (wasRunning) stopQueue(code);
  if (state.inFlight) await resolveInterruptedJob(code);
  state.tabId = null;
  if (!wasRunning) log('info', describeError(code));
  await persist();
}

// ---------------------------------------------------------------------------
// Tabs and the content script

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function resolveTab() {
  if (state.tabId != null) {
    const tab = await getTab(state.tabId);
    if (tab && isGvUrl(tab.url)) return { ok: true, id: tab.id, tab, count: 1 };
  }
  const tabs = await chrome.tabs.query({ url: GV_TAB_PATTERN });
  if (!tabs.length) return { ok: false, code: 'NO_GV_TAB' };
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return { ok: true, id: tabs[0].id, tab: tabs[0], count: tabs.length };
}

async function sendToTab(tabId, message, timeoutMs = PING_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ping(tabId) {
  const pong = await sendToTab(tabId, { type: CONTENT.PING });
  return pong && pong.ok === true ? pong : null;
}

/** Ping the content script, injecting it if the tab predates the extension. */
async function ensureContentScript(tabId) {
  let pong = await ping(tabId);
  if (pong) return pong;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch (err) {
    console.warn('[GV Sheet Helper] Could not inject content script:', err?.message);
    return null;
  }
  for (let i = 0; i < 4; i++) {
    await sleep(250);
    pong = await ping(tabId);
    if (pong) return pong;
  }
  return null;
}

const GV_STATE_MESSAGES = {
  ready: 'Connected to Google Voice.',
  loading: 'Google Voice is still loading.',
  signed_out: describeError('NOT_SIGNED_IN'),
  not_set_up: describeError('NOT_SET_UP'),
  not_open: describeError('NO_GV_TAB'),
  unreachable: describeError('CONTENT_UNREACHABLE'),
};

async function checkGv() {
  const tab = await resolveTab();
  if (!tab.ok) return { state: 'not_open', message: GV_STATE_MESSAGES.not_open };
  const pong = await ensureContentScript(tab.id);
  if (!pong) return { state: 'unreachable', tabId: tab.id, message: GV_STATE_MESSAGES.unreachable };
  const s = { ready: 'ready', signed_out: 'signed_out', not_set_up: 'not_set_up', loading: 'loading' }[pong.page] ?? 'unreachable';
  return {
    state: s,
    tabId: tab.id,
    tabCount: tab.count,
    visible: pong.visibility === 'visible',
    message: GV_STATE_MESSAGES[s],
  };
}

async function ensureWatchdog() {
  if (!(await chrome.alarms.get(ALARM_WATCHDOG))) {
    await chrome.alarms.create(ALARM_WATCHDOG, { delayInMinutes: WATCHDOG_PERIOD_MIN, periodInMinutes: WATCHDOG_PERIOD_MIN });
  }
}

// ---------------------------------------------------------------------------
// Page focus

// Google Voice shows its "Send to …" suggestion only while its page has
// keyboard focus, and clicking Start leaves focus in the side panel. While a
// message is prepared and sent, the debugger makes the tab behave as focused;
// Chrome shows a "started debugging this browser" bar meanwhile.
async function emulateFocus(tabId) {
  if (!chrome.debugger) return;
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3').catch((e) => {
      if (!/already attached/i.test(e?.message ?? '')) throw e;
    });
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) {
    log('warn', `Couldn’t keep the Google Voice tab focused (${e?.message ?? e}). Its “Send to” suggestion may not appear.`);
  }
}

function releaseFocus(tabId) {
  if (chrome.debugger && tabId != null) chrome.debugger.detach({ tabId }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Queue engine

function stopQueue(code) {
  state.status = STATUS.STOPPED;
  state.stopReason = { code, message: describeError(code) };
  state.pauseReason = null;
  state.nextAt = null;
  state.waitReason = null;
  chrome.alarms.clear(ALARM_NEXT);
  keepTabLoaded(state.tabId, false);
  if (code === 'STOPPED_BY_USER') {
    const { pending } = computeCounts(state.items);
    log('info', `Queue stopped. ${pending} contact${pending === 1 ? '' : 's'} not sent yet. Start again to continue.`);
  } else {
    log('error', `Queue stopped: ${describeError(code)}`);
    notifyUser('GV Sheet Helper stopped', describeError(code));
  }
}

function completeQueue() {
  state.status = STATUS.COMPLETED;
  state.nextAt = null;
  state.waitReason = null;
  state.pauseReason = null;
  keepTabLoaded(state.tabId, false);
  const c = computeCounts(state.items);
  const summary = `${c.accepted} sent, ${c.failed} failed, ${c.unknown} unconfirmed.`;
  log('success', `Queue finished: ${summary}`);
  notifyUser('GV Sheet Helper finished', `Queue finished: ${summary}`);
}

/**
 * Start the next contact now, or wait: for the delay since the last message,
 * for tomorrow when the daily limit is used up, or for the sending hours.
 */
async function scheduleNext() {
  if (state.status !== STATUS.RUNNING || state.inFlight) return;
  if (!nextPendingItem(state.items)) {
    completeQueue();
    return;
  }
  const now = Date.now();
  if (state.lastFinishedAt && state.nextDelayMs == null) state.nextDelayMs = pickDelayMs(settings);
  const { at, reason } = nextSendTime({ now, lastFinishedAt: state.lastFinishedAt, nextDelayMs: state.nextDelayMs, daily, settings });
  if (!reason) {
    state.nextAt = null;
    state.waitReason = null;
    await dispatchNext();
    return;
  }
  if (reason !== 'delay' && (state.waitReason !== reason || state.nextAt !== at)) {
    log(
      'info',
      reason === 'daily_limit'
        ? `Daily limit reached (${settings.dailyLimit} sent today). The queue will continue at ${formatResumeTime(at)}.`
        : `Outside the sending hours (${windowLabel(settings)}). The queue will continue at ${formatResumeTime(at)}.`,
    );
  }
  state.waitReason = reason;
  state.nextAt = at;
  await chrome.alarms.create(ALARM_NEXT, { when: at });
}

async function onNextAlarm() {
  await ensureLoaded();
  if (state.status !== STATUS.RUNNING || state.inFlight) return;
  if (state.nextAt && Date.now() < state.nextAt - 1000) {
    await chrome.alarms.create(ALARM_NEXT, { when: state.nextAt });
    return;
  }
  state.nextAt = null;
  await scheduleNext();
  await persist();
}

/** Hand exactly one contact to the content script. */
async function dispatchNext() {
  if (state.status !== STATUS.RUNNING || state.inFlight) return;
  const item = nextPendingItem(state.items);
  if (!item) {
    completeQueue();
    return;
  }
  state.waitReason = null;

  const tab = await resolveTab();
  if (!tab.ok) return stopQueue(tab.code);
  const pong = await ensureContentScript(tab.id);
  if (!pong) {
    if (chrome.tabs.reload && Date.now() - (state.reloadedTabAt ?? 0) > RELOAD_COOLDOWN_MS) {
      state.reloadedTabAt = Date.now();
      log('warn', 'The Google Voice tab wasn’t responding, so it was reloaded. Trying again in 20 seconds.');
      await chrome.tabs.reload(tab.id).catch(() => {});
      state.waitReason = 'delay';
      state.nextAt = Date.now() + RELOAD_RETRY_MS;
      await chrome.alarms.create(ALARM_NEXT, { when: state.nextAt });
      return;
    }
    return stopQueue('CONTENT_UNREACHABLE');
  }
  if (pong.page === 'signed_out') return stopQueue('NOT_SIGNED_IN');
  if (pong.page === 'not_set_up') return stopQueue('NOT_SET_UP');
  if (pong.page === 'not_voice') return stopQueue('NOT_VOICE_PAGE');
  if (pong.busyJobId) {
    sendToTab(tab.id, { type: CONTENT.ABORT, jobId: pong.busyJobId });
    log('warn', 'The Google Voice tab was still busy with an earlier message. Trying again in 30 seconds.');
    state.nextAt = Date.now() + BUSY_RETRY_MS;
    await chrome.alarms.create(ALARM_NEXT, { when: state.nextAt });
    return;
  }

  const now = Date.now();
  const jobId = crypto.randomUUID();
  item.status = ITEM.PREPARING;
  item.attempts += 1;
  item.lastJobId = jobId;
  item.error = null;
  item.sendAttempted = false;
  item.updatedAt = now;
  state.tabId = tab.id;
  state.inFlight = {
    jobId,
    itemId: item.id,
    tabId: tab.id,
    stage: 'preparing',
    step: 'check_page',
    startedAt: now,
    deadline: now + JOB_TIMEOUT_MS,
    abortRequested: false,
    graceUsed: false,
  };
  log('info', `${itemLabel(item)}: preparing message.`);
  await persist();
  await ensureWatchdog();
  await emulateFocus(tab.id);

  const ack = await sendToTab(tab.id, {
    type: CONTENT.SEND,
    jobId,
    dial: item.dial,
    digits: item.digits,
    international: item.international,
    message: item.message,
    commitBy: now + COMMIT_WINDOW_MS,
  });
  if (!ack?.accepted) {
    // Nothing happened in the page. Put the contact back and stop.
    stopQueue(ack?.code === 'CONTENT_BUSY' ? 'CONTENT_BUSY' : 'CONTENT_UNREACHABLE');
    await finishJob({ outcome: 'aborted', code: 'CONTENT_UNREACHABLE' });
  }
}

/** Record the outcome of the in-flight job and decide what happens next. */
async function finishJob({ outcome, code = null, detail = null, sendAttempted = false }) {
  const f = state.inFlight;
  if (!f) return;
  state.inFlight = null;
  releaseFocus(f.tabId);
  await chrome.alarms.clear(ALARM_WATCHDOG);

  const now = Date.now();
  const item = findItem(f.itemId);
  // A fatal problem before Send was pressed isn't this contact's fault:
  // put it back in the queue instead of marking it failed.
  const requeue = outcome === 'aborted' || (outcome === 'failed' && !sendAttempted && isFatal(code));

  if (item) {
    item.updatedAt = now;
    if (requeue) {
      item.status = ITEM.PENDING;
      item.sendAttempted = false;
      if (outcome === 'aborted') {
        const why = !code || code === 'ABORTED' ? 'stopped before sending' : describeError(code).replace(/\.$/, '').toLowerCase();
        log('info', `${itemLabel(item)}: not sent (${why}). It’s back in the queue.`);
      } else {
        log('error', `${itemLabel(item)}: ${describeError(code)} Nothing was sent; it’s back in the queue.`);
      }
    } else if (outcome === 'accepted') {
      item.status = ITEM.ACCEPTED;
      item.error = null;
      item.sendAttempted = true;
      item.message = null; // the body isn't needed any more
      state.consecutiveFailures = 0;
      await rememberSent(item, true);
      log('success', `${itemLabel(item)}: accepted by Google Voice.`);
    } else if (outcome === 'unknown') {
      item.status = ITEM.UNKNOWN;
      item.sendAttempted = true;
      item.error = errorRecord(code || 'SEND_UNCONFIRMED', detail);
      state.consecutiveFailures += 1;
      // It may have gone out, so it counts as texted until it's known to have failed.
      await rememberSent(item, false);
      log('warn', `${itemLabel(item)}: ${item.error.message}`);
    } else {
      item.status = ITEM.FAILED;
      item.sendAttempted = Boolean(sendAttempted);
      item.error = errorRecord(code || 'UNEXPECTED', detail);
      state.consecutiveFailures += 1;
      log('error', `${itemLabel(item)}: ${item.error.message}${item.error.detail ? ` (${item.error.detail})` : ''}`);
    }
  }

  if (!requeue) {
    state.lastFinishedAt = now;
    // Choose a fresh random delay after every message. It is stored so the wait
    // stays the same if the service worker restarts or the queue is paused.
    state.nextDelayMs = pickDelayMs(settings);
  }
  if (state.status === STATUS.PAUSED && !nextPendingItem(state.items)) {
    // Paused while the last message was going out: nothing is left to resume.
    completeQueue();
    return;
  }
  if (state.status !== STATUS.RUNNING) return;
  if (!requeue || outcome === 'failed') {
    if (isFatal(code)) return stopQueue(code);
    if (state.consecutiveFailures >= settings.maxConsecutiveFailures) return stopQueue('TOO_MANY_FAILURES');
  }
  await scheduleNext();
}

/** Periodic check on the in-flight job: tab closed, page reloaded, or stuck. */
async function watchdog() {
  await ensureLoaded();
  const f = state.inFlight;
  if (!f) {
    await chrome.alarms.clear(ALARM_WATCHDOG);
    return;
  }
  const tab = await getTab(f.tabId);
  if (!tab) return onTabGone(f.tabId, 'TAB_CLOSED');
  if (!isGvUrl(tab.url)) return onTabGone(f.tabId, 'TAB_NAVIGATED');

  const now = Date.now();
  const pong = await ping(f.tabId);
  if (state.inFlight !== f) return; // resolved while we were waiting

  if (pong?.lastJob?.jobId === f.jobId) {
    // The page finished but its result message was lost. Use its record.
    const r = pong.lastJob;
    await finishJob({ outcome: r.outcome, code: r.code, detail: r.detail, sendAttempted: r.sendAttempted });
    return persist();
  }

  const alive = pong?.busyJobId === f.jobId;
  if (alive && now < f.deadline) return;

  if (!alive) {
    if (now - f.startedAt < LOST_JOB_GRACE_MS) return;
    if (f.stage === 'sending') {
      await finishJob({ outcome: 'unknown', code: 'SEND_UNCONFIRMED', detail: 'The page stopped responding after Send was pressed.' });
    } else {
      await finishJob({ outcome: 'failed', code: pong ? 'JOB_LOST' : 'CONTENT_UNREACHABLE' });
    }
    return persist();
  }

  // Alive but past the deadline.
  if (f.stage === 'sending' && !f.graceUsed) {
    f.graceUsed = true;
    f.deadline = now + SEND_GRACE_MS;
    return persist();
  }
  await sendToTab(f.tabId, { type: CONTENT.ABORT, jobId: f.jobId });
  if (f.stage === 'sending') {
    await finishJob({ outcome: 'unknown', code: 'SEND_UNCONFIRMED', detail: 'Timed out waiting for confirmation.' });
  } else {
    await finishJob({ outcome: 'failed', code: 'TIMEOUT' });
  }
  return persist();
}

async function requestAbort() {
  const f = state.inFlight;
  if (!f) return;
  f.abortRequested = true;
  await sendToTab(f.tabId, { type: CONTENT.ABORT, jobId: f.jobId });
}

async function startRun(kind) {
  const counts = computeCounts(state.items);
  if (counts.pending === 0 && !state.inFlight) return fail('There are no contacts waiting to be sent.');
  const gv = await checkGv();
  if (gv.state !== 'ready') return fail(gv.message, { gv });

  state.status = STATUS.RUNNING;
  state.tabId = gv.tabId;
  state.stopReason = null;
  state.pauseReason = null;
  if (kind === 'start') state.consecutiveFailures = 0;
  log(
    'info',
    kind === 'start'
      ? `Queue started: ${counts.pending} to send, ${settings.delaySec} to ${settings.delaySec + settings.jitterSec} s between messages.`
      : 'Queue resumed.',
  );
  // Background tabs are heavily throttled by Chrome; keep Google Voice in front.
  chrome.tabs.update(gv.tabId, { active: true, autoDiscardable: false }).catch(() => {});
  await scheduleNext();
  await persist();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages

function onMessage(msg, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const fromVoiceTab = !fromExtensionPage && sender.tab?.id != null && isGvUrl(sender.url) && (sender.frameId ?? 0) === 0;

  let task;
  if (fromExtensionPage) {
    const check = validatePanelMessage(msg);
    if (!check.ok) {
      sendResponse(fail(check.error));
      return false;
    }
    task = () => handlePanel(msg);
  } else if (fromVoiceTab) {
    const check = validateContentMessage(msg);
    if (!check.ok) {
      sendResponse(fail(check.error));
      return false;
    }
    task = () => handleContent(msg, sender.tab.id);
  } else {
    return false;
  }

  serialize(async () => {
    await ensureLoaded();
    return task();
  }).then(
    (res) => sendResponse(res ?? { ok: true }),
    (err) => {
      console.error('[GV Sheet Helper]', err);
      sendResponse(fail('Something went wrong in the extension. Check the activity log.'));
    },
  );
  return true;
}

async function handlePanel(msg) {
  switch (msg.type) {
    case PANEL.STATE_GET:
      if (historyDirty) await persist();
      return {
        ok: true,
        state,
        settings,
        sentToday: sentOnDay(daily, Date.now()),
        historyCount: historySize(history),
        optOutCount: historyStats(history).optedOut,
      };

    case PANEL.QUEUE_IMPORT: {
      const template = msg.messageMode === 'template' ? msg.template ?? '' : null;
      if (msg.append && state.items.length) return appendContacts(msg, template);
      if (state.status === STATUS.RUNNING) {
        return fail('Stop the current queue before replacing it, or add the new contacts to it instead.', { canAppend: true });
      }
      if (state.inFlight) return fail('Wait for the current message to finish, then import.');
      const unfinished = state.items.some((i) => [ITEM.PENDING, ITEM.FAILED, ITEM.UNKNOWN].includes(i.status));
      // A queue that never sent anything can be replaced freely (re-importing a corrected sheet).
      const started = state.items.some((i) => i.attempts > 0);
      if (unfinished && started && !msg.replace) {
        return fail('The current queue still has unsent contacts.', { needsConfirm: true, canAppend: true });
      }
      const parsed = parseContacts(msg.text, { template, maxContacts: MAX_SHEET_ROWS });
      if (!parsed.ok) return fail(parsed.error);

      const policy = msg.duplicatePolicy ?? state.duplicatePolicy;
      // Never carried over from the last queue: a daily re-import must not re-text everyone.
      const historyPolicy = msg.historyPolicy ?? 'skip';
      const texted = await lookupNumbers(history, parsed.rows.filter((r) => r.valid).map((r) => r.phone));
      const items = buildItems(parsed, policy, { texted, historyPolicy });
      // Checked again here: only versions that keep the original's placeholders, links, numbers and STOP wording.
      const versioned = applyVersions(items, parsed.rows, sanitizeVersions(msg.versions));
      const toSend = computeCounts(items).pending;
      if (toSend > MAX_CONTACTS) {
        return fail(`That's ${toSend.toLocaleString('en-US')} contacts to send. Import up to ${MAX_CONTACTS.toLocaleString('en-US')} at a time.`);
      }
      const { log: keptLog, lastFinishedAt, nextDelayMs } = state;
      await chrome.alarms.clear(ALARM_NEXT);
      state = createEmptyState(policy, historyPolicy);
      state.log = keptLog;
      state.lastFinishedAt = lastFinishedAt; // re-importing must not skip the delay
      state.nextDelayMs = nextDelayMs;
      state.items = items;
      state.status = STATUS.READY;
      state.importSummary = {
        ...parsed.stats,
        delimiter: parsed.delimiter,
        headerDetected: parsed.headerDetected,
        messageMode: parsed.messageMode,
        template, // kept with the queue so the panel can show it; removed by Clear queue
        alreadyTexted: new Set(items.filter((i) => i.textedAt != null).map((i) => i.phone)).size,
        optedOut: items.filter((i) => i.status === ITEM.OPTED_OUT).length,
        versioned,
        importedAt: Date.now(),
      };
      const s = parsed.stats;
      const { alreadyTexted, optedOut } = state.importSummary;
      const textedNote =
        (alreadyTexted ? `, ${alreadyTexted} texted before${historyPolicy === 'skip' ? ' (skipped)' : ''}` : '') +
        (optedOut ? `, ${optedOut} opted out` : '') +
        (versioned ? `, AI versions for ${versioned}` : '');
      log(
        'info',
        `Imported ${s.dataRows} row${s.dataRows === 1 ? '' : 's'} (${parsed.delimiter}-separated, ${parsed.messageMode === 'template' ? 'same message for everyone' : 'message from the sheet'}): ${s.valid} valid, ${s.invalid} need fixing, ${s.duplicates} duplicate${textedNote}.`,
      );
      await persist();
      return { ok: true, summary: state.importSummary };
    }

    case PANEL.QUEUE_SET_DUPLICATES: {
      if (state.status !== STATUS.READY || state.items.some((i) => i.attempts > 0)) {
        return fail('Duplicate handling can only be changed before sending starts.');
      }
      state.duplicatePolicy = msg.policy;
      applyPolicies(state.items, state.duplicatePolicy, state.historyPolicy);
      await persist();
      return { ok: true };
    }

    case PANEL.QUEUE_SET_HISTORY: {
      if (state.status !== STATUS.READY || state.items.some((i) => i.attempts > 0)) {
        return fail('This can only be changed before sending starts.');
      }
      const before = state.historyPolicy;
      state.historyPolicy = msg.policy;
      applyPolicies(state.items, state.duplicatePolicy, state.historyPolicy);
      const toSend = computeCounts(state.items).pending;
      if (toSend > MAX_CONTACTS) {
        state.historyPolicy = before;
        applyPolicies(state.items, state.duplicatePolicy, state.historyPolicy);
        return fail(`That would be ${toSend.toLocaleString('en-US')} contacts to send. A queue holds up to ${MAX_CONTACTS.toLocaleString('en-US')}.`);
      }
      if (msg.policy === 'send') log('warn', 'Numbers texted before will be texted again in this queue.');
      await persist();
      return { ok: true };
    }

    case PANEL.HISTORY_ADD: {
      const { numbers, invalid } = extractPhones(msg.text);
      if (!numbers.length) return fail('No phone numbers found. Put one number per line.');
      const known = await lookupNumbers(history, numbers);
      const now = Date.now();
      let added = 0;
      for (const e164 of numbers) {
        if (known.has(e164)) continue;
        await recordNumber(history, e164, now, true);
        added++;
      }
      if (added) historyDirty = true;
      await refreshTextedFlags();
      log('info', `Added ${added} number${added === 1 ? '' : 's'} to the sent history${known.size ? ` (${known.size} already there)` : ''}.`);
      await persist();
      return { ok: true, added, known: known.size, invalid, historyCount: historySize(history) };
    }

    case PANEL.OPTOUT_ADD:
    case PANEL.OPTOUT_REMOVE: {
      const adding = msg.type === PANEL.OPTOUT_ADD;
      const { numbers, invalid } = extractPhones(msg.text);
      if (!numbers.length) return fail('No phone numbers found. Put one number per line.');
      const now = Date.now();
      let changed = 0;
      for (const e164 of numbers) {
        if (adding ? await recordOptOut(history, e164, now) : await removeOptOut(history, e164)) changed++;
      }
      if (changed) historyDirty = true;
      const blocked = adding ? new Set(numbers) : new Set();
      const unblocked = adding ? new Set() : new Set(numbers);
      let held = 0;
      for (const item of state.items) {
        if (!item.phone || item.id === state.inFlight?.itemId) continue;
        if (blocked.has(item.phone) && item.status === ITEM.PENDING) {
          item.status = ITEM.OPTED_OUT;
          held++;
        } else if (unblocked.has(item.phone) && item.status === ITEM.OPTED_OUT) {
          item.status = ITEM.PENDING;
        }
      }
      await refreshTextedFlags();
      if (state.status === STATUS.RUNNING && !state.inFlight && !nextPendingItem(state.items)) completeQueue();
      const n = numbers.length;
      log(
        'info',
        adding
          ? `Added ${changed} number${changed === 1 ? '' : 's'} to the do-not-text list${held ? ` (${held} pending in this queue won’t be texted)` : ''}.`
          : `Removed ${changed} of ${n} number${n === 1 ? '' : 's'} from the do-not-text list.`,
      );
      await persist();
      return { ok: true, changed, invalid, held, optOutCount: historyStats(history).optedOut };
    }

    case PANEL.HISTORY_CLEAR: {
      if (!msg.confirmed) return fail('Confirm to clear the sent history.', { needsConfirm: true });
      const n = historySize(history);
      // The do-not-text list is kept; without one, start over with a new salt.
      if (historyStats(history).optedOut) clearTexted(history);
      else history = createHistory();
      historyDirty = true;
      await refreshTextedFlags();
      log('warn', `Sent history cleared (${n} number${n === 1 ? '' : 's'}). Numbers in future imports won't be recognised as texted before.`);
      await persist();
      return { ok: true, historyCount: 0 };
    }

    case PANEL.QUEUE_START:
      if (state.status === STATUS.RUNNING) return fail('The queue is already running.');
      if (state.status === STATUS.PAUSED) return fail('The queue is paused. Use Resume to continue.');
      if (state.inFlight) return fail('Wait for the current message to finish.');
      return startRun('start');

    case PANEL.QUEUE_RESUME:
      if (state.status !== STATUS.PAUSED) return fail('The queue isn’t paused.');
      return startRun('resume');

    case PANEL.QUEUE_PAUSE:
      if (state.status !== STATUS.RUNNING) return fail('The queue isn’t running.');
      state.status = STATUS.PAUSED;
      state.pauseReason = 'Paused by you.';
      state.nextAt = null;
      await chrome.alarms.clear(ALARM_NEXT);
      if (state.inFlight) {
        await requestAbort();
        log('info', 'Pausing. A message that is already being sent will finish first.');
      } else {
        log('info', 'Queue paused.');
      }
      await persist();
      return { ok: true };

    case PANEL.QUEUE_STOP:
      if (state.status !== STATUS.RUNNING && state.status !== STATUS.PAUSED) return fail('The queue isn’t running.');
      stopQueue('STOPPED_BY_USER');
      if (state.inFlight) await requestAbort();
      await persist();
      return { ok: true };

    case PANEL.QUEUE_CLEAR: {
      if (state.inFlight?.stage === 'sending') {
        return fail('A message is being sent right now. Wait a moment, then clear the queue.');
      }
      const active = state.status === STATUS.RUNNING || state.status === STATUS.PAUSED || state.inFlight;
      if (active && !msg.confirmed) return fail('The queue is active.', { needsConfirm: true });
      if (state.inFlight) await requestAbort();
      await chrome.alarms.clear(ALARM_NEXT);
      await chrome.alarms.clear(ALARM_WATCHDOG);
      const { log: keptLog, duplicatePolicy, historyPolicy, lastFinishedAt, nextDelayMs } = state;
      state = createEmptyState(duplicatePolicy, historyPolicy);
      state.log = keptLog;
      state.lastFinishedAt = lastFinishedAt;
      state.nextDelayMs = nextDelayMs;
      log('info', 'Queue cleared. Phone numbers and messages were removed from storage.');
      await persist();
      return { ok: true };
    }

    case PANEL.QUEUE_RETRY_ITEM: {
      const item = findItem(msg.itemId);
      if (!item) return fail('That contact is no longer in the queue.');
      if (state.inFlight?.itemId === item.id) return fail('That contact is being processed right now.');
      const kind = retryKind(item);
      if (kind === 'no') return fail('Only failed or unconfirmed contacts can be retried.');
      if (kind === 'confirm' && !msg.acknowledgeRisk) {
        return fail('Google Voice may already have sent this message.', { needsConfirm: true });
      }
      requeueItem(item);
      log('info', `${itemLabel(item)}: queued to retry${kind === 'confirm' ? ' (confirmed by you after checking Google Voice)' : ''}.`);
      await persist();
      return { ok: true };
    }

    case PANEL.QUEUE_RETRY_FAILED: {
      let retried = 0;
      let needsReview = 0;
      for (const item of state.items) {
        const kind = retryKind(item);
        if (kind === 'yes') {
          requeueItem(item);
          retried++;
        } else if (kind === 'confirm') {
          needsReview++;
        }
      }
      if (retried) log('info', `${retried} failed contact${retried === 1 ? '' : 's'} queued to retry.`);
      await persist();
      return { ok: true, retried, needsReview };
    }

    case PANEL.QUEUE_EXCLUDE_ITEM: {
      const item = findItem(msg.itemId);
      if (!item) return fail('That contact is no longer in the queue.');
      if (state.inFlight?.itemId === item.id) return fail('That contact is being processed right now.');
      if (msg.exclude) {
        if (item.status !== ITEM.PENDING) return fail('Only contacts waiting to be sent can be skipped.');
        item.status = ITEM.EXCLUDED;
        log('info', `${itemLabel(item)}: skipped by you.`);
        if (state.status === STATUS.RUNNING && !state.inFlight && !nextPendingItem(state.items)) completeQueue();
      } else {
        if (item.status !== ITEM.EXCLUDED) return fail('That contact isn’t skipped.');
        requeueItem(item);
        log('info', `${itemLabel(item)}: back in the queue.`);
      }
      item.updatedAt = Date.now();
      await persist();
      return { ok: true };
    }

    case PANEL.QUEUE_MARK_SENT: {
      const item = findItem(msg.itemId);
      if (!item) return fail('That contact is no longer in the queue.');
      if (retryKind(item) !== 'confirm') return fail('Only unconfirmed messages can be marked as sent.');
      item.status = ITEM.ACCEPTED;
      item.error = null;
      item.message = null;
      item.updatedAt = Date.now();
      await rememberSent(item, true);
      log('success', `${itemLabel(item)}: marked as sent by you after checking Google Voice.`);
      await persist();
      return { ok: true };
    }

    case PANEL.SETTINGS_SAVE: {
      const check = validateSettings(msg, settings);
      if (!check.ok) return fail('Check the highlighted settings.', { errors: check.errors });
      settings = check.value;
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      log(
        'info',
        `Settings saved: ${settings.delaySec} s plus up to ${settings.jitterSec} s random extra between messages, ` +
          `${settings.dailyLimit ? `at most ${settings.dailyLimit} per day` : 'no daily limit'}, ` +
          `${settings.windowOn ? `only ${windowLabel(settings)}` : 'any time of day'}, ` +
          `stop after ${settings.maxConsecutiveFailures} failure${settings.maxConsecutiveFailures === 1 ? '' : 's'} in a row.`,
      );
      if (state.status === STATUS.RUNNING && !state.inFlight) {
        if (state.lastFinishedAt) state.nextDelayMs = pickDelayMs(settings); // apply new settings to the current wait
        await chrome.alarms.clear(ALARM_NEXT);
        await scheduleNext();
      }
      await persist();
      return { ok: true, settings };
    }

    case PANEL.GV_STATUS:
      return { ok: true, gv: await checkGv() };

    case PANEL.GV_OPEN: {
      const tab = await resolveTab();
      if (tab.ok) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.tab.windowId != null) await chrome.windows.update(tab.tab.windowId, { focused: true }).catch(() => {});
      } else {
        await chrome.tabs.create({ url: GV_HOME_URL });
      }
      return { ok: true };
    }

    case PANEL.GV_DIAGNOSE: {
      const tab = await resolveTab();
      if (!tab.ok) return fail(describeError('NO_GV_TAB'));
      if (!(await ensureContentScript(tab.id))) return fail(describeError('CONTENT_UNREACHABLE'));
      const report = await sendToTab(tab.id, { type: CONTENT.DIAGNOSE }, DIAGNOSE_TIMEOUT_MS);
      if (!report?.ok) return fail('The page check didn’t finish. Reload the Google Voice tab and try again.');
      const missing = report.checks.filter((c) => !c.found && !c.optional).map((c) => c.label);
      log(
        missing.length ? 'warn' : 'success',
        `Page check (${report.page}): ${report.checks.filter((c) => c.found).length} of ${report.checks.length} elements found.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`,
      );
      await persist();
      return { ok: true, report };
    }

    case PANEL.LOG_CLEAR:
      state.log = [];
      await persist();
      return { ok: true };

    default:
      return fail('Unsupported request.');
  }
}

/**
 * Add the new rows of a sheet to the current queue without stopping it.
 * Only valid rows whose number isn't in the queue already, wasn't texted
 * before and isn't opted out are added.
 */
async function appendContacts(msg, template) {
  const parsed = parseContacts(msg.text, { template, maxContacts: MAX_SHEET_ROWS });
  if (!parsed.ok) return fail(parsed.error);
  const texted = await lookupNumbers(history, parsed.rows.filter((r) => r.valid).map((r) => r.phone));
  const inQueue = new Set(state.items.map((i) => i.phone).filter(Boolean));
  const built = buildItems(parsed, state.duplicatePolicy, { texted, historyPolicy: 'skip' });
  const isNew = (i) => i.status === ITEM.PENDING && !inQueue.has(i.phone);
  const versioned = applyVersions(built, parsed.rows, sanitizeVersions(msg.versions), isNew);
  const added = built.filter(isNew);
  const report = {
    added: added.length,
    inQueue: built.filter((i) => i.phone && inQueue.has(i.phone)).length,
    texted: built.filter((i) => i.status === ITEM.ALREADY_SENT && !inQueue.has(i.phone)).length,
    optedOut: built.filter((i) => i.status === ITEM.OPTED_OUT && !inQueue.has(i.phone)).length,
    invalid: parsed.stats.invalid,
  };
  const toSend = computeCounts(state.items).remaining + added.length;
  if (toSend > MAX_CONTACTS) {
    return fail(`That would be ${toSend.toLocaleString('en-US')} contacts to send. A queue holds up to ${MAX_CONTACTS.toLocaleString('en-US')}.`);
  }
  if (added.length) {
    state.items.push(...added);
    if (state.status === STATUS.COMPLETED) state.status = STATUS.READY;
    if (template != null && state.importSummary) state.importSummary.template = template;
  }
  const notes = [
    report.inQueue && `${report.inQueue} already in the queue`,
    report.texted && `${report.texted} texted before`,
    report.optedOut && `${report.optedOut} opted out`,
    report.invalid && `${report.invalid} need fixing`,
    versioned && `AI versions for ${versioned}`,
  ].filter(Boolean);
  log('info', `Added ${added.length} new contact${added.length === 1 ? '' : 's'} to the queue${notes.length ? ` (${notes.join(', ')})` : ''}.`);
  await persist();
  return { ok: true, appended: true, ...report };
}

function requeueItem(item) {
  item.status = ITEM.PENDING;
  item.error = null;
  item.updatedAt = Date.now();
  if (state.status === STATUS.COMPLETED || state.status === STATUS.STOPPED) {
    state.status = STATUS.READY;
    state.stopReason = null;
  }
}

async function handleContent(msg, tabId) {
  const f = state.inFlight;
  const isCurrent = Boolean(f && f.jobId === msg.jobId && f.tabId === tabId);

  switch (msg.type) {
    case CONTENT.PROGRESS: {
      if (!isCurrent) return { ok: false, stale: true };
      if (msg.stage === 'heartbeat') return { ok: true }; // keeps the worker awake; nothing to store
      const item = findItem(f.itemId);
      if (msg.stage === 'prepared' && f.stage === 'preparing') {
        f.stage = 'prepared';
        if (item) item.status = ITEM.PREPARED;
      }
      if (msg.step) f.step = msg.step;
      await persist();
      return { ok: true };
    }

    case CONTENT.COMMIT: {
      const item = isCurrent ? findItem(f.itemId) : null;
      const allowed =
        isCurrent &&
        state.status === STATUS.RUNNING &&
        !f.abortRequested &&
        f.stage !== 'sending' &&
        item &&
        (item.status === ITEM.PREPARING || item.status === ITEM.PREPARED) &&
        // Re-checked here too, in case the limit was lowered while this message was being prepared.
        !dailyLimitReached(daily, settings, Date.now());
      if (!allowed) return { ok: true, proceed: false };
      countTowardDailyLimit(Date.now());
      f.stage = 'sending';
      f.step = 'confirming';
      item.status = ITEM.SENDING;
      item.sendAttempted = true;
      item.updatedAt = Date.now();
      // This write must land before Send is pressed: it is what turns any
      // later interruption into "unknown" instead of a silent re-send.
      await persist();
      return { ok: true, proceed: true };
    }

    case CONTENT.RESULT: {
      if (isCurrent) {
        await finishJob({ outcome: msg.outcome, code: msg.code, detail: msg.detail, sendAttempted: msg.sendAttempted });
        await persist();
        return { ok: true };
      }
      return handleLateResult(msg);
    }

    default:
      return fail('Unsupported request.');
  }
}

/** A result for a job the watchdog already gave up on. Only ever upgrades "unknown". */
async function handleLateResult(msg) {
  const item = state.items.find((i) => i.lastJobId === msg.jobId);
  if (!item || item.status !== ITEM.UNKNOWN) return { ok: true, stale: true };
  if (msg.outcome === 'accepted') {
    item.status = ITEM.ACCEPTED;
    item.error = null;
    item.message = null;
    await rememberSent(item, true);
    log('success', `${itemLabel(item)}: Google Voice confirmed this message after all.`);
  } else if (msg.outcome === 'failed' && msg.code === 'SEND_FAILED') {
    item.status = ITEM.FAILED;
    item.error = errorRecord('SEND_FAILED', msg.detail);
    if (await forgetUnconfirmed(history, item.phone)) historyDirty = true;
    log('error', `${itemLabel(item)}: ${item.error.message}`);
  } else {
    return { ok: true, stale: true };
  }
  item.updatedAt = Date.now();
  await persist();
  return { ok: true, stale: true };
}
