// GV Sheet Helper — side panel.
//
// Renders the queue state that the background worker keeps in
// chrome.storage.local, and turns button presses into validated commands.
// The panel never changes queue state itself, so closing and reopening it
// is always safe.

import { PANEL, STEPS } from './lib/protocol.js';
import { parseContacts, inspectColumns, MAX_SHEET_ROWS } from './lib/parser.js';
import { HISTORY_KEY, restoreHistory, historyStats, lookupNumbers } from './lib/history.js';
import { parseSheetLink, fetchSheetCsv } from './lib/sheets.js';
import {
  STATUS,
  ITEM,
  ITEM_LABELS,
  DEFAULT_SETTINGS,
  computeCounts,
  retryKind,
  validateSettings,
  localDayKey,
  nextWindowOpen,
  windowLabel,
  averageGapSec,
} from './lib/queue-model.js';

const STATE_KEY = 'gvsh.state';
const SETTINGS_KEY = 'gvsh.settings';
const DAILY_KEY = 'gvsh.daily';
const GV_POLL_MS = 8000;

const $ = (id) => document.getElementById(id);

const ui = {
  tabBar: $('tabBar'),
  tabs: [...document.querySelectorAll('#tabBar [role="tab"]')],
  panels: [...document.querySelectorAll('[role="tabpanel"]')],
  sendDot: $('sendDot'),
  activityCount: $('activityCount'),
  connButton: $('connButton'),
  connText: $('connText'),
  runStateTag: $('runStateTag'),
  runStatus: $('runStatus'),
  statTotal: $('statTotal'),
  statSent: $('statSent'),
  statFailed: $('statFailed'),
  statRemaining: $('statRemaining'),
  emptyState: $('emptyState'),
  runBody: $('runBody'),
  progressBar: $('progressBar'),
  progressFill: $('progressFill'),
  progressLabel: $('progressLabel'),
  currentBox: $('currentBox'),
  currentText: $('currentText'),
  btnStart: $('btnStart'),
  btnPause: $('btnPause'),
  btnResume: $('btnResume'),
  btnStop: $('btnStop'),
  btnRetryFailed: $('btnRetryFailed'),
  btnClear: $('btnClear'),
  runAlert: $('runAlert'),
  importCard: $('importCard'),
  importText: $('importText'),
  importError: $('importError'),
  btnImport: $('btnImport'),
  btnImportClear: $('btnImportClear'),
  importHint: $('importHint'),
  sourceRadios: [...document.querySelectorAll('input[name="source"]')],
  uploadPane: $('uploadPane'),
  pastePane: $('pastePane'),
  dropzone: $('dropzone'),
  sheetPane: $('sheetPane'),
  sheetConnect: $('sheetConnect'),
  sheetUrl: $('sheetUrl'),
  btnSheetLoad: $('btnSheetLoad'),
  sheetCard: $('sheetCard'),
  sheetName: $('sheetName'),
  sheetMeta: $('sheetMeta'),
  btnSheetReload: $('btnSheetReload'),
  btnSheetRemove: $('btnSheetRemove'),
  historyControl: $('historyControl'),
  historyLabel: $('historyLabel'),
  historyCount: $('historyCount'),
  historyText: $('historyText'),
  btnHistoryAdd: $('btnHistoryAdd'),
  historyNote: $('historyNote'),
  btnHistoryClear: $('btnHistoryClear'),
  fileInput: $('fileInput'),
  fileCard: $('fileCard'),
  fileName: $('fileName'),
  fileMeta: $('fileMeta'),
  btnFileReplace: $('btnFileReplace'),
  btnFileRemove: $('btnFileRemove'),
  previewEmpty: $('previewEmpty'),
  contactSearch: $('contactSearch'),
  modeRadios: [...document.querySelectorAll('input[name="messageMode"]')],
  templateField: $('templateField'),
  templateText: $('templateText'),
  templateCount: $('templateCount'),
  variableBox: $('variableBox'),
  variableChips: $('variableChips'),
  variableStatus: $('variableStatus'),
  variableHint: $('variableHint'),
  previewBox: $('previewBox'),
  previewLabel: $('previewLabel'),
  previewMeta: $('previewMeta'),
  previewText: $('previewText'),
  contactsCard: $('contactsCard'),
  contactsSummary: $('contactsSummary'),
  dupControl: $('dupControl'),
  dupLabel: $('dupLabel'),
  filterBar: $('filterBar'),
  contactList: $('contactList'),
  contactEmpty: $('contactEmpty'),
  settingsForm: $('settingsForm'),
  delayInput: $('delayInput'),
  delayError: $('delayError'),
  jitterInput: $('jitterInput'),
  jitterError: $('jitterError'),
  dailyInput: $('dailyInput'),
  dailyError: $('dailyError'),
  dailyUsed: $('dailyUsed'),
  dailyLine: $('dailyLine'),
  failInput: $('failInput'),
  failError: $('failError'),
  windowOnInput: $('windowOnInput'),
  windowStartInput: $('windowStartInput'),
  windowEndInput: $('windowEndInput'),
  windowError: $('windowError'),
  notifyInput: $('notifyInput'),
  etaLine: $('etaLine'),
  btnExport: $('btnExport'),
  btnShowMore: $('btnShowMore'),
  optOutCount: $('optOutCount'),
  optOutText: $('optOutText'),
  btnOptOutAdd: $('btnOptOutAdd'),
  btnOptOutRemove: $('btnOptOutRemove'),
  optOutNote: $('optOutNote'),
  confirmAlt: $('confirmAlt'),
  settingsSaved: $('settingsSaved'),
  btnDiagnose: $('btnDiagnose'),
  diagResult: $('diagResult'),
  logList: $('logList'),
  logEmpty: $('logEmpty'),
  btnClearLog: $('btnClearLog'),
  dialog: $('confirmDialog'),
  confirmTitle: $('confirmTitle'),
  confirmBody: $('confirmBody'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
};

let state = null;
let settings = { ...DEFAULT_SETTINGS };
let daily = null; // { day, count } — messages sent per local day, kept by the background worker
let gv = { state: 'checking', message: 'Checking Google Voice…' };
let filter = 'all';
let busy = false;
let gvPolling = false;
let listSignature = '';
let logSignature = '';
let settingsDirty = false;
let messageMode = 'column';
let previewTimer = null;
const expandedIds = new Set();
const MODE_KEY = 'gvsh.messageMode'; // per-panel conveniences, not queue data
const SOURCE_KEY = 'gvsh.importSource';
const TAB_KEY = 'gvsh.tab';
// The message being written, so closing the panel doesn't lose it. Removed by Clear queue.
const DRAFT_KEY = 'gvsh.templateDraft';
// A linked sheet loaded longer ago than this is downloaded again on import.
const SHEET_FRESH_MS = 2 * 60_000;
const LIST_PAGE = 200; // contacts rendered at a time
let listLimit = LIST_PAGE;
let settingsTimer = null;
const SMS_SEGMENT = 160;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
let source = 'file'; // 'sheet' | 'file' | 'paste'
let fileData = null; // { name, size, text } — held in memory only, never stored
const SHEET_KEY = 'gvsh.sheetLink'; // the link only; the sheet's rows are never stored by the panel
// link: parseSheetLink() result; text: the CSV, in memory only until it is imported
let sheet = { link: null, text: null, title: null, loadedAt: null, rows: null, loading: false, imported: false };
let history = null; // read-only copy of the sent history (fingerprints) for the live preview
let fpSalt = null;
let fpCache = new Map();
let previewGen = 0;
let search = '';

// ---------------------------------------------------------------------------
// Messaging

async function send(type, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    return res ?? { ok: false, error: 'No response from the extension.' };
  } catch {
    return { ok: false, error: 'The extension’s background process is unavailable. Close and reopen this panel.' };
  }
}

/** Run a command with the controls locked, then re-render. */
async function command(fn) {
  if (busy) return;
  busy = true;
  render();
  try {
    await fn();
  } finally {
    busy = false;
    render();
  }
}

// ---------------------------------------------------------------------------
// Formatting

const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

function formatDuration(sec) {
  if (sec < 90) return plural(Math.max(1, Math.round(sec)), 'second');
  if (sec < 90 * 60) return plural(Math.round(sec / 60), 'minute');
  return `${(sec / 3600).toFixed(1)} hours`;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function firstLine(text, max = 120) {
  const line = String(text ?? '').split('\n')[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function showAlert(message, tone = 'danger') {
  ui.runAlert.textContent = message;
  ui.runAlert.dataset.tone = tone;
  ui.runAlert.hidden = !message;
}

// ---------------------------------------------------------------------------
// Confirmation dialog

/**
 * Ask before doing something. Resolves true/false, or, when `altLabel` is
 * given (a third choice), 'confirm' | 'alt' | null.
 */
function confirmAction({ title, body, confirmLabel = 'Confirm', danger = false, altLabel = null, altDanger = false }) {
  return new Promise((resolve) => {
    const dlg = ui.dialog;
    ui.confirmTitle.textContent = title;
    ui.confirmBody.textContent = body;
    ui.confirmOk.textContent = confirmLabel;
    ui.confirmOk.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    ui.confirmAlt.hidden = !altLabel;
    ui.confirmAlt.textContent = altLabel ?? '';
    ui.confirmAlt.className = altDanger ? 'btn btn-danger' : 'btn';
    dlg.returnValue = '';
    dlg.addEventListener(
      'close',
      () => {
        const v = dlg.returnValue;
        if (altLabel) resolve(v === 'confirm' || v === 'alt' ? v : null);
        else resolve(v === 'confirm');
      },
      { once: true },
    );
    dlg.showModal();
    ui.confirmCancel.focus();
  });
}

// ---------------------------------------------------------------------------
// Rendering

const CONN_LABELS = {
  checking: 'Checking…',
  ready: 'Connected',
  loading: 'Loading…',
  signed_out: 'Signed out',
  not_set_up: 'Not set up',
  not_open: 'Open Google Voice',
  unreachable: 'Reload tab',
};

function renderConnection() {
  ui.connButton.dataset.state = gv.state;
  ui.connText.textContent = CONN_LABELS[gv.state] ?? 'Unknown';
  let title = gv.message || '';
  if (gv.tabCount > 1) title += ' Several Google Voice tabs are open; the most recently used one is used.';
  ui.connButton.title = `${title} Click to open Google Voice.`.trim();
}

const STATE_TAGS = {
  [STATUS.EMPTY]: ['Empty', 'neutral'],
  [STATUS.READY]: ['Ready', 'accent'],
  [STATUS.RUNNING]: ['Running', 'accent'],
  [STATUS.PAUSED]: ['Paused', 'warning'],
  [STATUS.STOPPED]: ['Stopped', 'danger'],
  [STATUS.COMPLETED]: ['Finished', 'success'],
};

function runStatusText(s, c) {
  switch (s.status) {
    case STATUS.READY:
      if (c.pending > 0) {
        return c.alreadySent
          ? `${plural(c.pending, 'new contact')} ready. ${plural(c.alreadySent, 'number')} texted before ${c.alreadySent === 1 ? 'is' : 'are'} skipped.`
          : `${plural(c.pending, 'contact')} ready. Review the list below, then start.`;
      }
      return c.alreadySent
        ? 'Nothing new to send: every number in this list was texted before.'
        : 'No contacts can be sent. Fix the rows marked below and import again.';
    case STATUS.RUNNING:
      if (s.inFlight) return `Sending ${plural(c.remaining, 'message')} left, one at a time.`;
      if (s.waitReason === 'daily_limit') {
        return `Today’s limit of ${settings.dailyLimit} is used up. The queue continues by itself ${settings.windowOn ? 'when tomorrow’s sending hours start' : 'after midnight'} — keep Chrome and the Google Voice tab open.`;
      }
      if (s.waitReason === 'hours') {
        return `Outside your sending hours (${windowLabel(settings)}). The queue continues by itself — keep Chrome and the Google Voice tab open.`;
      }
      return 'Waiting before the next message.';
    case STATUS.PAUSED: {
      if (s.inFlight) return 'Pausing after the current message…';
      const reason = s.pauseReason && s.pauseReason !== 'Paused by you.' ? ` ${s.pauseReason}` : '';
      return `Paused with ${plural(c.pending, 'contact')} left.${reason}`;
    }
    case STATUS.STOPPED:
      if (s.stopReason?.code === 'STOPPED_BY_USER') {
        return `Stopped. ${plural(c.pending, 'contact')} not sent yet. Start the queue to continue.`;
      }
      return /^stopped\b/i.test(s.stopReason?.message ?? '')
        ? s.stopReason.message
        : `Stopped: ${s.stopReason?.message ?? 'an error occurred.'}`;
    case STATUS.COMPLETED: {
      const review = c.unknown ? ' Check unconfirmed messages in Google Voice before retrying them.' : '';
      return `Finished: ${c.accepted} sent, ${c.failed} failed, ${c.unknown} unconfirmed.${review}`;
    }
    default:
      return 'No contacts loaded. Paste rows from your spreadsheet below.';
  }
}

function currentLine(s) {
  if (s.inFlight) {
    const item = s.items.find((i) => i.id === s.inFlight.itemId);
    const step = STEPS[s.inFlight.step] ?? 'Working';
    return item ? `Row ${item.row} · ${item.display} — ${step}` : step;
  }
  if (s.status === STATUS.RUNNING && s.nextAt) {
    const left = s.nextAt - Date.now();
    if ((s.waitReason === 'daily_limit' || s.waitReason === 'hours') && left > 0) {
      const at = new Date(s.nextAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      return `${s.waitReason === 'hours' ? 'Waiting for sending hours' : 'Paused for the day'} — continues ${at}`;
    }
    return left > 0 ? `Next message in ${formatCountdown(left)}` : 'Starting the next message…';
  }
  return null;
}

/** "About 25 minutes left (done around 3:40 PM)", or the number of days the daily limit spreads the rest over. */
function etaText(s, c) {
  if (![STATUS.RUNNING, STATUS.PAUSED].includes(s.status) || c.remaining === 0) return null;
  const limit = settings.dailyLimit ?? 0;
  const leftToday = Math.max(0, limit - sentToday());
  if (limit > 0 && c.remaining > leftToday) {
    const days = Math.ceil((c.remaining - leftToday) / limit);
    return `${plural(c.remaining, 'message')} left · ${leftToday ? `${leftToday} today, the rest` : 'spread'} over ${plural(days, 'more day')} (${limit} a day)`;
  }
  const seconds = c.remaining * averageGapSec(settings);
  if (s.status === STATUS.PAUSED) return `${plural(c.remaining, 'message')} left · about ${formatDuration(seconds)} of sending`;
  const start = Math.max(Date.now(), s.nextAt ?? 0);
  const done = new Date(start + seconds * 1000);
  const wraps = settings.windowOn && nextWindowOpen(done.getTime(), settings) > done.getTime();
  return `${plural(c.remaining, 'message')} left · about ${formatDuration(seconds)}${wraps ? ', continuing in the next sending hours' : ` (done around ${clockTime(done)})`}`;
}

/** Messages sent today, from the background worker's counter. */
function sentToday() {
  return daily && daily.day === localDayKey(Date.now()) ? daily.count : 0;
}

function renderDaily() {
  const limit = settings.dailyLimit ?? 0;
  const today = sentToday();
  ui.dailyUsed.textContent = limit > 0 ? `Today: ${today} of ${limit} sent` : `Today: ${plural(today, 'message')} sent`;
  const show = limit > 0 && (state?.items?.length ?? 0) > 0;
  ui.dailyLine.hidden = !show;
  if (show) {
    ui.dailyLine.textContent = `Today: ${Math.min(today, limit)} of ${limit} daily limit${today >= limit ? ' (reached)' : ''}`;
    ui.dailyLine.dataset.tone = today >= limit ? 'warning' : '';
  }
}

function renderRun() {
  const s = state ?? { status: STATUS.EMPTY, items: [] };
  const c = computeCounts(s.items);
  const [tagText, tone] = STATE_TAGS[s.status] ?? STATE_TAGS[STATUS.EMPTY];
  ui.runStateTag.textContent = tagText;
  ui.runStateTag.dataset.tone = s.status === STATUS.STOPPED && s.stopReason?.code === 'STOPPED_BY_USER' ? 'neutral' : tone;

  let status = runStatusText(s, c);
  if (s.status === STATUS.RUNNING && gv.state === 'ready' && gv.visible === false) {
    status += ' Keep the Google Voice tab in front — Chrome slows down background tabs.';
  }
  ui.runStatus.textContent = status;

  ui.statTotal.textContent = c.total;
  ui.statSent.textContent = c.accepted;
  ui.statFailed.textContent = c.failed + c.unknown;
  ui.statSent.dataset.zero = String(c.accepted === 0);
  ui.statFailed.dataset.zero = String(c.failed + c.unknown === 0);
  ui.statFailed.title = c.unknown ? `${c.failed} failed, ${c.unknown} unconfirmed` : '';
  ui.statRemaining.textContent = c.remaining;

  const hasQueue = s.items.length > 0;
  ui.emptyState.hidden = hasQueue;
  ui.runBody.hidden = !hasQueue;

  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  ui.progressFill.style.width = `${pct}%`;
  ui.progressLabel.textContent = `${pct}%`;
  ui.progressBar.setAttribute('aria-valuenow', String(pct));
  ui.progressBar.setAttribute('aria-valuetext', `${c.done} of ${c.total} processed`);
  ui.progressBar.dataset.complete = String(s.status === STATUS.COMPLETED);

  const line = currentLine(s);
  ui.currentBox.hidden = !line;
  ui.currentBox.dataset.wait = !s.inFlight && s.waitReason ? s.waitReason : '';
  if (line) ui.currentText.textContent = line;
  const eta = etaText(s, c);
  ui.etaLine.hidden = !eta;
  if (eta) ui.etaLine.textContent = eta;
  renderDaily();

  const idle = [STATUS.READY, STATUS.STOPPED, STATUS.COMPLETED].includes(s.status);
  // Only the controls that make sense right now are shown.
  ui.btnStart.hidden = !idle || c.pending === 0;
  ui.btnResume.hidden = s.status !== STATUS.PAUSED;
  ui.btnPause.hidden = s.status !== STATUS.RUNNING;
  ui.btnStop.hidden = s.status !== STATUS.RUNNING && s.status !== STATUS.PAUSED;

  // Run state stays visible from the other tabs.
  ui.sendDot.hidden = !hasQueue || s.status === STATUS.READY;
  ui.sendDot.dataset.tone = ui.runStateTag.dataset.tone;
  ui.btnStart.disabled = busy || !idle || c.pending === 0 || Boolean(s.inFlight);
  ui.btnPause.disabled = busy || s.status !== STATUS.RUNNING;
  ui.btnResume.disabled = busy || s.status !== STATUS.PAUSED;
  ui.btnStop.disabled = busy || (s.status !== STATUS.RUNNING && s.status !== STATUS.PAUSED);
  ui.btnRetryFailed.disabled = busy || !s.items.some((i) => retryKind(i) === 'yes');
  ui.btnClear.disabled = busy || s.items.length === 0 || s.inFlight?.stage === 'sending';
  // While a queue runs, importing adds the sheet's new rows to it.
  ui.btnImport.disabled = busy;
  ui.btnImport.querySelector('span').textContent =
    s.status === STATUS.RUNNING || s.status === STATUS.PAUSED || s.inFlight ? 'Add new contacts to the queue' : 'Validate & preview';
}

function matchesSearch(item) {
  if (!search) return true;
  const q = search.toLowerCase();
  const digits = q.replace(/\D/g, '');
  if (String(item.row) === q.trim()) return true;
  if (digits.length >= 3 && String(item.phone || item.display || '').replace(/\D/g, '').includes(digits)) return true;
  return String(item.message || '').toLowerCase().includes(q) || String(item.display || '').toLowerCase().includes(q);
}

const SKIPPED_STATUSES = [ITEM.SKIPPED, ITEM.ALREADY_SENT, ITEM.OPTED_OUT, ITEM.EXCLUDED];

function matchesFilter(item) {
  if (!matchesSearch(item)) return false;
  switch (filter) {
    case 'pending':
      return [ITEM.PENDING, ITEM.PREPARING, ITEM.PREPARED, ITEM.SENDING].includes(item.status);
    case 'sent':
      return item.status === ITEM.ACCEPTED;
    case 'issues':
      return [ITEM.INVALID, ITEM.FAILED, ITEM.UNKNOWN].includes(item.status);
    case 'skipped':
      return SKIPPED_STATUSES.includes(item.status);
    default:
      return true;
  }
}

const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function contactNotes(item) {
  const notes = [];
  if (item.textedAt != null && item.status !== ITEM.ACCEPTED) {
    const when = `${item.textedConfirmed ? 'Texted' : 'Possibly texted (unconfirmed)'} ${shortDate(item.textedAt)}`;
    if (item.status === ITEM.ALREADY_SENT) notes.push(['neutral', `${when}. Skipped.`]);
    else if (item.attempts === 0 && item.duplicateOf == null) notes.push(['warning', `${when}. Will be texted again.`]);
  }
  if (item.status === ITEM.INVALID) notes.push(['danger', item.errors.join(' ')]);
  if (item.status === ITEM.OPTED_OUT) notes.push(['danger', 'On your do-not-text list (Settings). Never texted.']);
  if (item.status === ITEM.EXCLUDED) notes.push(['neutral', 'You skipped this contact. It won’t be texted unless you include it again.']);
  if (item.duplicateOf != null) {
    notes.push(['neutral', `Same number as row ${item.duplicateOf}${item.status === ITEM.SKIPPED ? ' — will be skipped.' : '.'}`]);
  }
  if (item.error && (item.status === ITEM.FAILED || item.status === ITEM.UNKNOWN)) {
    const detail = item.error.detail ? ` (${item.error.detail})` : '';
    notes.push([item.status === ITEM.UNKNOWN ? 'warning' : 'danger', `${item.error.message}${detail}`]);
  }
  if (item.status !== ITEM.ACCEPTED) for (const w of item.warnings || []) notes.push(['warning', w]);
  return notes;
}

function buildContactRow(item, inFlightId) {
  const li = document.createElement('li');
  li.className = 'contact';
  li.dataset.status = item.status;

  const num = document.createElement('span');
  num.className = 'contact-row-num';
  num.textContent = item.row;
  num.title = `Row ${item.row}`;

  const main = document.createElement('div');
  main.className = 'contact-main';

  const top = document.createElement('div');
  top.className = 'contact-top';
  const phone = document.createElement('span');
  phone.className = 'contact-phone';
  phone.textContent = item.display || '(no phone number)';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.dataset.status = item.status;
  badge.textContent = ITEM_LABELS[item.status] ?? item.status;
  top.append(phone, badge);

  let msg;
  if (item.message) {
    // The exact text that will be sent (variables already filled in). Click to expand.
    const expanded = expandedIds.has(item.id);
    msg = document.createElement('button');
    msg.type = 'button';
    msg.className = 'contact-msg is-toggle';
    msg.dataset.expand = item.id;
    msg.setAttribute('aria-expanded', String(expanded));
    msg.title = expanded ? 'Collapse message' : 'Show the full message';
    if (expanded) msg.classList.add('is-expanded');
    msg.textContent = expanded ? item.message : firstLine(item.message) || '(empty message)';
  } else {
    msg = document.createElement('div');
    msg.className = 'contact-msg is-cleared';
    msg.textContent = item.status === ITEM.ACCEPTED ? 'Message text removed after sending' : '(no message)';
  }
  main.append(top, msg);

  for (const [tone, text] of contactNotes(item)) {
    const note = document.createElement('div');
    note.className = 'contact-note';
    note.dataset.tone = tone;
    note.textContent = text;
    main.append(note);
  }

  if (item.id !== inFlightId) {
    const kind = retryKind(item);
    const buttons = [];
    const link = (action, text, label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-link';
      btn.dataset.action = action;
      btn.dataset.id = item.id;
      btn.textContent = text;
      btn.setAttribute('aria-label', `${label} row ${item.row}`);
      btn.disabled = busy;
      buttons.push(btn);
    };
    if (kind === 'yes') link('retry', 'Retry', 'Retry');
    if (kind === 'confirm') {
      link('mark-sent', 'It was sent', 'Mark as sent:');
      link('retry', 'Retry after checking…', 'Retry');
    }
    if (item.status === ITEM.PENDING) link('exclude', 'Don’t send', 'Don’t send to');
    if (item.status === ITEM.EXCLUDED) link('include', 'Include again', 'Include');
    if (buttons.length) {
      const actions = document.createElement('div');
      actions.className = 'contact-actions';
      actions.append(...buttons);
      main.append(actions);
    }
  }

  li.append(num, main);
  return li;
}

function renderContacts() {
  const items = state?.items ?? [];
  ui.contactsCard.hidden = items.length === 0;
  if (!items.length) {
    listSignature = '';
    return;
  }

  const c = computeCounts(items);
  const sum = state.importSummary;
  // From the items, not the import summary: contacts can be added to a queue later.
  ui.contactsSummary.textContent = `${plural(items.length, 'row')} · ${items.length - c.invalid} valid${c.invalid ? ` · ${c.invalid} to fix` : ''}${sum?.messageMode === 'template' ? ' · same message' : ''}`;

  const textedNumbers = new Set(items.filter((i) => i.textedAt != null).map((i) => i.phone)).size;
  ui.historyControl.hidden = textedNumbers === 0;
  if (textedNumbers) {
    ui.historyLabel.textContent = `${plural(textedNumbers, 'number')} texted before`;
    const editable = state.status === STATUS.READY && !items.some((i) => i.attempts > 0) && !busy;
    for (const radio of ui.historyControl.querySelectorAll('input[name="historyPolicy"]')) {
      radio.checked = radio.value === (state.historyPolicy ?? 'skip');
      radio.disabled = !editable;
    }
  }

  const dupCount = items.filter((i) => i.duplicateOf != null).length;
  ui.dupControl.hidden = dupCount === 0;
  if (dupCount) {
    ui.dupLabel.textContent = `${plural(dupCount, 'duplicate number')} in this list`;
    const editable = state.status === STATUS.READY && !items.some((i) => i.attempts > 0) && !busy;
    for (const radio of ui.dupControl.querySelectorAll('input[name="dupPolicy"]')) {
      radio.checked = radio.value === state.duplicatePolicy;
      radio.disabled = !editable;
    }
  }

  const counts = {
    all: items.length,
    pending: c.pending + c.inProgress,
    sent: c.accepted,
    issues: c.invalid + c.failed + c.unknown,
    skipped: c.skipped + c.alreadySent + c.optedOut + c.excluded,
  };
  for (const span of ui.filterBar.querySelectorAll('[data-count]')) span.textContent = counts[span.dataset.count];
  for (const btn of ui.filterBar.querySelectorAll('.filter')) btn.setAttribute('aria-pressed', String(btn.dataset.filter === filter));

  const inFlightId = state.inFlight?.itemId ?? null;
  const signature = [
    filter,
    search,
    busy,
    inFlightId,
    listLimit,
    state.duplicatePolicy,
    state.historyPolicy,
    ...items.map((i) => `${i.id}:${i.status}:${i.error?.code ?? ''}:${i.message ? 1 : 0}`),
  ].join('|');
  if (signature === listSignature) return;
  listSignature = signature;

  // Long lists are rendered a page at a time so updates stay quick.
  const visible = items.filter(matchesFilter);
  const shown = visible.slice(0, listLimit);
  const scrollTop = ui.contactList.scrollTop;
  const frag = document.createDocumentFragment();
  for (const item of shown) frag.append(buildContactRow(item, inFlightId));
  ui.contactList.replaceChildren(frag);
  ui.contactList.scrollTop = scrollTop;
  ui.contactList.hidden = visible.length === 0;
  ui.contactEmpty.hidden = visible.length !== 0;
  const more = visible.length - shown.length;
  ui.btnShowMore.hidden = more <= 0;
  ui.btnShowMore.textContent = `Show ${Math.min(more, LIST_PAGE)} more (${plural(more, 'contact')} not shown)`;
}

/** The queue as a CSV file, to mark in your sheet who was texted. Built in the panel; nothing leaves the computer. */
function exportResults() {
  const items = state?.items ?? [];
  if (!items.length) return;
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Free text must not start like a formula when the file is opened in a spreadsheet.
  const text = (v) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const lines = [['Row', 'Phone', 'Status', 'Details', 'Updated'].join(',')];
  for (const item of items) {
    const details = contactNotes(item)
      .map(([, note]) => note)
      .join(' ');
    lines.push([item.row, item.display, ITEM_LABELS[item.status] ?? item.status, text(details), when(item.updatedAt)].map(cell).join(','));
  }
  const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gv-sheet-helper-results-${localDayKey(Date.now())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function renderLog() {
  const entries = state?.log ?? [];
  const signature = `${entries.length}:${entries.at(-1)?.t ?? 0}`;
  if (signature === logSignature) return;
  logSignature = signature;

  const frag = document.createDocumentFragment();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const li = document.createElement('li');
    li.dataset.level = e.level;
    const dot = document.createElement('span');
    dot.className = 'log-dot';
    dot.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'log-body';
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = e.text;
    const time = document.createElement('time');
    time.className = 'log-time';
    time.dateTime = new Date(e.t).toISOString();
    time.textContent = timeFormat.format(e.t);
    body.append(text, time);
    li.append(dot, body);
    frag.append(li);
  }
  ui.logList.replaceChildren(frag);
  ui.logList.hidden = entries.length === 0;
  ui.logEmpty.hidden = entries.length !== 0;
  ui.btnClearLog.disabled = entries.length === 0;
  ui.activityCount.hidden = entries.length === 0;
  ui.activityCount.textContent = entries.length > 99 ? '99+' : String(entries.length);
}

function render() {
  ui.btnHistoryClear.disabled = busy || historyStats(history).texted === 0;
  ui.btnExport.disabled = busy || !(state?.items?.length > 0);
  renderConnection();
  renderRun();
  renderContacts();
  renderLog();
}

const toTimeValue = (min) => (min >= 1440 ? '23:59' : `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);

function fromTimeValue(value, { end = false } = {}) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || '');
  if (!m) return NaN;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return end && min === 1439 ? 1440 : min; // 23:59 as the end means "until midnight"
}

function renderSettingsForm() {
  ui.delayInput.value = settings.delaySec;
  ui.jitterInput.value = settings.jitterSec;
  ui.failInput.value = settings.maxConsecutiveFailures;
  ui.dailyInput.value = settings.dailyLimit ?? 0;
  ui.windowOnInput.checked = Boolean(settings.windowOn);
  ui.windowStartInput.value = toTimeValue(settings.windowStart ?? DEFAULT_SETTINGS.windowStart);
  ui.windowEndInput.value = toTimeValue(settings.windowEnd ?? DEFAULT_SETTINGS.windowEnd);
  ui.notifyInput.checked = Boolean(settings.notify);
  syncWindowInputs();
  clearSettingsErrors();
  settingsDirty = false;
  renderDaily();
}

function clearSettingsErrors() {
  setFieldError(ui.delayInput, ui.delayError, null);
  setFieldError(ui.jitterInput, ui.jitterError, null);
  setFieldError(ui.failInput, ui.failError, null);
  setFieldError(ui.dailyInput, ui.dailyError, null);
  setFieldError(ui.windowEndInput, ui.windowError, null);
  ui.windowStartInput.removeAttribute('aria-invalid');
}

function syncWindowInputs() {
  ui.windowStartInput.disabled = !ui.windowOnInput.checked;
  ui.windowEndInput.disabled = !ui.windowOnInput.checked;
}

function setFieldError(input, errorEl, message) {
  errorEl.textContent = message ?? '';
  errorEl.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

// ---------------------------------------------------------------------------
// Tabs

function selectTab(name, { focus = false } = {}) {
  const tab = ui.tabs.find((t) => t.dataset.tab === name) ?? ui.tabs[0];
  for (const t of ui.tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
  }
  for (const panel of ui.panels) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  if (focus) tab.focus();
  try {
    localStorage.setItem(TAB_KEY, tab.dataset.tab);
  } catch {
    /* not remembered */
  }
}

function onTabKey(e) {
  const i = ui.tabs.indexOf(e.target.closest('[role="tab"]'));
  if (i < 0) return;
  const last = ui.tabs.length - 1;
  const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  selectTab(ui.tabs[next].dataset.tab, { focus: true });
}

// ---------------------------------------------------------------------------
// Google Voice connection

async function refreshGv() {
  if (gvPolling || document.visibilityState !== 'visible') return;
  gvPolling = true;
  try {
    const res = await send(PANEL.GV_STATUS);
    gv = res.ok ? res.gv : { state: 'unreachable', message: res.error };
  } finally {
    gvPolling = false;
  }
  renderConnection();
  renderRun();
}

// ---------------------------------------------------------------------------
// Contacts source: uploaded file or pasted rows

/** The text the import uses, from whichever source is selected. */
function currentText() {
  if (source === 'sheet') return sheet.text ?? '';
  return source === 'file' ? fileData?.text ?? '' : ui.importText.value;
}

function applySource(next, { focus = false } = {}) {
  source = ['sheet', 'paste'].includes(next) ? next : 'file';
  for (const radio of ui.sourceRadios) radio.checked = radio.value === source;
  ui.sheetPane.hidden = source !== 'sheet';
  ui.uploadPane.hidden = source !== 'file';
  ui.pastePane.hidden = source !== 'paste';
  if (source === 'sheet' && sheet.link && !sheet.text && !sheet.loading && !sheet.imported) loadSheet();
  if (focus && source === 'sheet' && !sheet.link) ui.sheetUrl.focus();
  try {
    localStorage.setItem(SOURCE_KEY, source);
  } catch {
    /* not remembered */
  }
  hideImportError();
  if (focus && source === 'paste') ui.importText.focus();
  updatePreview();
}

const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Decode a CSV the way spreadsheet apps write it: UTF-8, UTF-16 (BOM) or legacy Windows-1252. */
function decodeText(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

async function loadFile(file) {
  if (!file) return;
  hideImportError();
  const name = file.name || 'file';
  if (/\.(xlsx|xlsm|xls|ods|numbers)$/i.test(name)) {
    showImportError('Spreadsheet files can’t be read directly. In Excel use File › Save As › CSV; in Google Sheets use File › Download › CSV. Then upload that file.', ui.fileInput);
    return;
  }
  if (!/\.(csv|tsv|txt)$/i.test(name) && file.type && !/^text\//.test(file.type)) {
    showImportError('Upload a .csv, .tsv or .txt file.', ui.fileInput);
    return;
  }
  if (file.size === 0) {
    showImportError('That file is empty.', ui.fileInput);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showImportError(`That file is ${formatBytes(file.size)}. Upload a file up to 2 MB, or split it into smaller batches.`, ui.fileInput);
    return;
  }
  try {
    fileData = { name, size: file.size, text: decodeText(await file.arrayBuffer()) };
  } catch {
    showImportError('That file couldn’t be read. Try saving it again as CSV.', ui.fileInput);
    return;
  }
  ui.fileInput.value = ''; // allow choosing the same file again later
  renderFileCard();
  updatePreview();
}

function removeFile() {
  fileData = null;
  ui.fileInput.value = '';
  renderFileCard();
  updatePreview();
}

function renderFileCard(stats = null, headers = null) {
  ui.fileCard.hidden = !fileData;
  ui.dropzone.hidden = Boolean(fileData);
  if (!fileData) return;
  ui.fileName.textContent = fileData.name;
  const parts = [formatBytes(fileData.size)];
  if (stats) parts.push(plural(stats.dataRows, 'row'));
  if (headers?.length) parts.push(headers.filter(Boolean).join(', '));
  ui.fileMeta.textContent = parts.join(' · ');
  ui.fileMeta.title = ui.fileMeta.textContent;
}

// ---------------------------------------------------------------------------
// Google Sheet link

const clockTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function renderSheetCard() {
  const linked = Boolean(sheet.link);
  ui.sheetConnect.hidden = linked;
  ui.sheetCard.hidden = !linked;
  if (!linked) return;
  ui.sheetName.textContent = sheet.title || 'Google Sheet';
  ui.sheetName.title = sheet.link.canonical;
  let meta;
  if (sheet.loading) meta = 'Loading the latest rows…';
  else if (sheet.text != null) meta = `${sheet.rows != null ? `${plural(sheet.rows, 'row')} · ` : ''}loaded ${clockTime(sheet.loadedAt)}`;
  else if (sheet.imported) meta = `Imported ${clockTime(sheet.loadedAt)} · Reload for new rows`;
  else meta = 'Not loaded yet';
  ui.sheetMeta.textContent = meta;
  ui.btnSheetReload.disabled = sheet.loading;
  ui.btnSheetReload.setAttribute('aria-busy', String(sheet.loading));
}

/** Fetch the linked sheet (or the link typed in the box) and preview it. Resolves true when it loaded. */
async function loadSheet() {
  hideImportError();
  const link = sheet.link ?? parseSheetLink(ui.sheetUrl.value);
  if (!link.ok) {
    showImportError(link.error, ui.sheetUrl);
    return false;
  }
  const wasLinked = Boolean(sheet.link);
  sheet = { ...sheet, link, loading: true, imported: false };
  renderSheetCard();
  const res = await fetchSheetCsv(link);
  sheet.loading = false;
  if (!res.ok) {
    if (!wasLinked) sheet.link = null; // bring the link box back so it can be corrected
    renderSheetCard();
    showImportError(res.error, ui.sheetUrl);
    return false;
  }
  sheet.text = decodeText(res.buffer);
  sheet.title = res.title;
  sheet.loadedAt = Date.now();
  try {
    localStorage.setItem(SHEET_KEY, link.canonical);
  } catch {
    /* not remembered */
  }
  renderSheetCard();
  updatePreview();
  return true;
}

function removeSheet() {
  sheet = { link: null, text: null, title: null, loadedAt: null, rows: null, loading: false, imported: false };
  ui.sheetUrl.value = '';
  try {
    localStorage.removeItem(SHEET_KEY);
  } catch {
    /* nothing stored */
  }
  hideImportError();
  renderSheetCard();
  updatePreview();
  ui.sheetUrl.focus();
}

// ---------------------------------------------------------------------------
// Sent history (read-only here; the background worker owns it)

function setHistory(raw) {
  history = restoreHistory(raw);
  if (history?.salt !== fpSalt) {
    fpSalt = history?.salt ?? null;
    fpCache = new Map();
  }
  const { texted, optedOut } = historyStats(history);
  ui.historyCount.textContent = plural(texted, 'number');
  ui.optOutCount.textContent = plural(optedOut, 'number');
  ui.btnHistoryClear.disabled = texted === 0 || busy;
}

async function changeOptOuts(type) {
  const text = ui.optOutText.value;
  if (!text.trim()) {
    ui.optOutText.focus();
    return;
  }
  const res = await send(type, { text });
  if (!res.ok) {
    ui.optOutNote.textContent = '';
    showAlert(res.error);
    return;
  }
  ui.optOutText.value = '';
  const parts = [`${type === PANEL.OPTOUT_ADD ? 'Added' : 'Removed'} ${res.changed}`];
  if (res.held) parts.push(`${res.held} in this queue won’t be texted`);
  if (res.invalid) parts.push(`${res.invalid} not valid`);
  ui.optOutNote.textContent = parts.join(' · ');
  setTimeout(() => {
    ui.optOutNote.textContent = '';
  }, 5000);
}

async function addToHistory() {
  const text = ui.historyText.value;
  if (!text.trim()) {
    ui.historyNote.textContent = '';
    ui.historyText.focus();
    return;
  }
  const res = await send(PANEL.HISTORY_ADD, { text });
  if (!res.ok) {
    ui.historyNote.textContent = '';
    showAlert(res.error);
    return;
  }
  ui.historyText.value = '';
  const parts = [`Added ${res.added}`];
  if (res.known) parts.push(`${res.known} already there`);
  if (res.invalid) parts.push(`${res.invalid} not valid`);
  ui.historyNote.textContent = parts.join(' · ');
  setTimeout(() => {
    ui.historyNote.textContent = '';
  }, 4000);
}

async function clearHistory() {
  const { texted: n, optedOut } = historyStats(history);
  const ok = await confirmAction({
    title: 'Clear the sent history?',
    body: `${plural(n, 'number')} will be forgotten. Future imports won’t recognise them, so they can be texted again. This can’t be undone.${optedOut ? `\n\nYour do-not-text list (${plural(optedOut, 'number')}) is kept.` : ''}`,
    confirmLabel: 'Clear history',
    danger: true,
  });
  if (!ok) return;
  const res = await send(PANEL.HISTORY_CLEAR, { confirmed: true });
  if (!res.ok) showAlert(res.error);
}

function bindDropzone() {
  // A file dropped anywhere else would navigate the panel away. Never let it.
  for (const type of ['dragover', 'drop']) {
    window.addEventListener(type, (e) => e.preventDefault());
  }
  const zone = ui.dropzone;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragover');
    loadFile(e.dataTransfer.files?.[0]);
  });
  ui.fileInput.addEventListener('change', () => loadFile(ui.fileInput.files?.[0]));
  ui.btnFileReplace.addEventListener('click', () => ui.fileInput.click());
  ui.btnFileRemove.addEventListener('click', removeFile);
}

// ---------------------------------------------------------------------------
// Composing: message mode, variables and live preview

const MODE_COPY = {
  column: {
    hint: 'Paste a phone column and a message column, with the header row. Other columns become variables.',
    placeholder: 'Phone\tFirst Name\tMessage\n(212) 555-0147\tSam\tHi {{First Name}}, your order is ready.',
    variables: 'Use these in your Message cells, e.g. Hi {{First Name}}. Click to copy.',
  },
  template: {
    hint: 'Paste the phone column and any variable columns, with the header row.',
    placeholder: 'Phone\tFirst Name\n(212) 555-0147\tSam\n(646) 555-0123\tAlex',
    variables: 'Click to insert. Fallback for blank cells: {{First Name|there}}.',
  },
};

function applyMode(mode, { focus = false } = {}) {
  messageMode = mode === 'template' ? 'template' : 'column';
  for (const radio of ui.modeRadios) radio.checked = radio.value === messageMode;
  const copy = MODE_COPY[messageMode];
  ui.importHint.textContent = copy.hint;
  ui.importText.placeholder = copy.placeholder;
  ui.variableHint.textContent = copy.variables;
  ui.templateField.hidden = messageMode !== 'template';
  try {
    localStorage.setItem(MODE_KEY, messageMode);
  } catch {
    /* storage unavailable: the choice just isn't remembered */
  }
  if (focus && messageMode === 'template') ui.templateText.focus();
  updateTemplateCount();
  updatePreview();
}

function updateTemplateCount() {
  const text = ui.templateText.value;
  const n = text.length;
  let note = `${plural(n, 'character')}`;
  if (/\{\{[^}]+\}\}/.test(text)) note += ' before variables are filled in';
  if (n > SMS_SEGMENT) note += ` · over ${SMS_SEGMENT}, may arrive as more than one text`;
  ui.templateCount.textContent = note;
  ui.templateCount.dataset.tone = n > SMS_SEGMENT ? 'warning' : '';
}

function renderVariableChips(columns) {
  const vars = columns.variables;
  ui.variableStatus.textContent = columns.headers
    ? `${plural(columns.headers.filter(Boolean).length, 'column')} found`
    : 'Your columns appear here';
  const frag = document.createDocumentFragment();
  for (const v of vars) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'var-chip';
    chip.dataset.variable = v.label;
    chip.textContent = `{{${v.label}}}`;
    chip.setAttribute(
      'aria-label',
      messageMode === 'template' ? `Insert ${v.label}` : `Copy {{${v.label}}} to the clipboard`,
    );
    frag.append(chip);
  }
  ui.variableChips.replaceChildren(frag);
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 250);
}

/** True when importing should offer to add to the current queue instead of simply replacing it. */
function queueInProgress() {
  const items = state?.items ?? [];
  if (!items.length) return false;
  if (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED || state.inFlight) return true;
  return items.some((i) => i.attempts > 0) && items.some((i) => [ITEM.PENDING, ITEM.FAILED, ITEM.UNKNOWN].includes(i.status));
}

/** Validate the draft locally as the user types: the same parser the import uses. */
async function updatePreview() {
  const gen = ++previewGen;
  const text = currentText();
  const columns = inspectColumns(text);
  renderVariableChips(columns);
  ui.variableBox.hidden = !text.trim();
  const template = messageMode === 'template' ? ui.templateText.value : null;
  const awaitingMessage = template !== null && !template.trim();
  // Row counts don't depend on the message, so a placeholder lets the file
  // card show them before the message is written.
  const result = text.trim() ? parseContacts(text, { template: awaitingMessage ? '-' : template, maxContacts: MAX_SHEET_ROWS }) : null;
  if (source === 'file') renderFileCard(result?.ok ? result.stats : null, columns.headers);
  if (source === 'sheet') {
    sheet.rows = result?.ok ? result.stats.dataRows : null;
    renderSheetCard();
  }

  if (!result || awaitingMessage) {
    ui.previewBox.hidden = true;
    ui.previewEmpty.hidden = false;
    ui.previewEmpty.textContent = !result
      ? `${{ sheet: 'Load your sheet', file: 'Upload a file', paste: 'Paste rows' }[source]} to preview the first message.`
      : 'Write the message to preview it for the first contact.';
    return;
  }
  ui.previewEmpty.hidden = true;
  ui.previewBox.hidden = false;
  if (!result.ok) {
    ui.previewBox.dataset.tone = 'danger';
    ui.previewLabel.textContent = 'Check your data';
    ui.previewMeta.textContent = '';
    ui.previewText.textContent = result.error;
    return;
  }
  // Numbers texted before are skipped on import; count and preview only the new ones.
  const valid = result.rows.filter((r) => r.valid);
  const known = await lookupNumbers(history, valid.map((r) => r.phone), fpCache);
  if (gen !== previewGen) return; // a newer preview started while this one waited
  // While a queue is in progress, an import adds to it, so numbers already in it aren't new.
  const inQueue = queueInProgress() ? new Set(state.items.map((i) => i.phone).filter(Boolean)) : new Set();
  const optedOut = [...known.values()].filter((k) => k.optedOut).length;
  const texted = known.size - optedOut;
  const queued = new Set(valid.filter((r) => inQueue.has(r.phone)).map((r) => r.phone)).size;
  const fresh = valid.filter((r) => r.duplicateOf == null && !known.has(r.phone) && !inQueue.has(r.phone));
  const sample = fresh[0] ?? valid[0] ?? result.rows[0];
  const { invalid } = result.stats;
  ui.previewMeta.textContent = [
    `${fresh.length} ${inQueue.size ? 'new' : 'ready'}`,
    queued && `${queued} already in the queue`,
    texted && `${texted} texted before`,
    optedOut && `${optedOut} opted out`,
    invalid && `${invalid} to fix`,
  ]
    .filter(Boolean)
    .join(' · ');
  if (sample.valid) {
    ui.previewBox.dataset.tone = '';
    ui.previewLabel.textContent = `Preview · row ${sample.row}, ${sample.display}`;
    ui.previewText.textContent = sample.message;
  } else {
    ui.previewBox.dataset.tone = 'danger';
    ui.previewLabel.textContent = `Row ${sample.row} needs fixing`;
    ui.previewText.textContent = sample.errors.join(' ');
  }
}

async function onVariableChip(label) {
  const token = `{{${label}}}`;
  if (messageMode === 'template') {
    const ta = ui.templateText;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.setRangeText(token, start, end, 'end');
    ta.focus();
    saveDraft();
    updateTemplateCount();
    schedulePreview();
    return;
  }
  try {
    await navigator.clipboard.writeText(token);
    ui.variableHint.textContent = `Copied ${token}. Paste it into a Message cell in your sheet.`;
  } catch {
    ui.variableHint.textContent = `Type ${token} into a Message cell to use this column.`;
  }
}

// ---------------------------------------------------------------------------
// Actions

async function importContacts() {
  hideImportError();
  // A linked sheet is always imported as it is now, not as it was when the panel opened.
  if (source === 'sheet' && sheet.link && (sheet.text == null || Date.now() - (sheet.loadedAt ?? 0) > SHEET_FRESH_MS)) {
    if (!(await loadSheet())) return;
  }
  const text = currentText();
  if (!text.trim()) {
    if (source === 'sheet') showImportError(sheet.link ? 'Load the sheet first.' : 'Paste the link to your Google Sheet, then load it.', ui.sheetUrl);
    else if (source === 'file') showImportError('Choose a CSV file first, or switch to Paste rows.', ui.fileInput);
    else showImportError('Paste at least one row with a phone number.');
    return;
  }
  const template = messageMode === 'template' ? ui.templateText.value : undefined;
  if (template !== undefined && !template.trim()) {
    showImportError('Write the message to send to everyone.', ui.templateText);
    return;
  }
  const duplicatePolicy = state?.duplicatePolicy ?? 'skip';
  // historyPolicy is always 'skip' on import: numbers texted before are never re-texted by default.
  const payload = { text, duplicatePolicy, historyPolicy: 'skip', messageMode, ...(template !== undefined ? { template } : {}) };
  let res;
  if (queueInProgress()) {
    // A queue is under way: the usual wish is to add the sheet's new rows to it.
    const c = computeCounts(state.items);
    const running = state.status === STATUS.RUNNING || Boolean(state.inFlight);
    const choice = await confirmAction({
      title: 'Add the new contacts to this queue?',
      body:
        `The current queue has ${plural(c.remaining, 'contact')} still to send. Adding keeps it ${running ? 'running' : 'as it is'} and only adds numbers that ` +
        'aren’t in it already and weren’t texted before.' +
        (running ? '' : '\n\nReplacing starts a new list instead. Numbers texted before are still skipped.'),
      confirmLabel: 'Add to queue',
      altLabel: running ? null : 'Replace queue',
      altDanger: true,
    });
    if (!choice) return;
    res = await send(PANEL.QUEUE_IMPORT, { ...payload, ...(choice === 'alt' ? { replace: true } : { append: true }) });
  } else {
    res = await send(PANEL.QUEUE_IMPORT, payload);
    if (!res.ok && res.needsConfirm) {
      const ok = await confirmAction({
        title: 'Replace the current queue?',
        body: 'The current queue still has unsent contacts. Importing replaces the whole list. Numbers texted before are still skipped.',
        confirmLabel: 'Replace queue',
        danger: true,
      });
      if (!ok) return;
      res = await send(PANEL.QUEUE_IMPORT, { ...payload, replace: true });
    }
  }
  if (!res.ok) {
    const aboutTemplate = template !== undefined && /\{\{|message/i.test(res.error);
    const field = { sheet: ui.sheetUrl, file: ui.fileInput, paste: ui.importText }[source];
    showImportError(res.error, aboutTemplate ? ui.templateText : field);
    return;
  }
  if (res.appended) {
    finishImport();
    const notes = [
      res.inQueue && `${res.inQueue} already in the queue`,
      res.texted && `${res.texted} texted before`,
      res.optedOut && `${res.optedOut} opted out`,
      res.invalid && `${res.invalid} need fixing in the sheet`,
    ].filter(Boolean);
    showAlert(`${res.added ? `Added ${plural(res.added, 'new contact')} to the queue.` : 'No new contacts to add.'}${notes.length ? ` Skipped: ${notes.join(', ')}.` : ''}`, 'info');
    filter = 'pending';
    return;
  }
  finishImport();
  filter = res.summary.invalid > 0 ? 'issues' : res.summary.alreadyTexted > 0 ? 'pending' : 'all';
  showAlert('');
  ui.contactsCard.scrollIntoView({ block: 'nearest' });
}

/** After an import: drop the raw contact data from the panel; the template and sheet link are kept for reuse. */
function finishImport() {
  ui.importText.value = '';
  fileData = null;
  if (sheet.text != null) sheet = { ...sheet, text: null, imported: true };
  renderSheetCard();
  updatePreview();
  expandedIds.clear();
  listLimit = LIST_PAGE;
  ui.importCard.open = false;
}

function showImportError(message, field = ui.importText) {
  ui.importError.textContent = message;
  ui.importError.hidden = false;
  ui.importText.removeAttribute('aria-invalid');
  ui.templateText.removeAttribute('aria-invalid');
  if (field === ui.fileInput || (field === ui.sheetUrl && sheet.link)) {
    ui.importError.scrollIntoView({ block: 'nearest' });
    return;
  }
  field.setAttribute('aria-invalid', 'true');
  field.focus();
}

function hideImportError() {
  ui.importError.hidden = true;
  ui.importText.removeAttribute('aria-invalid');
  ui.templateText.removeAttribute('aria-invalid');
}

async function startQueue() {
  const c = computeCounts(state?.items ?? []);
  const seconds = c.pending * averageGapSec(settings) - (settings.delaySec + settings.jitterSec / 2); // no wait before the first
  const limit = settings.dailyLimit ?? 0;
  let dailyNote = '';
  if (limit > 0) {
    const leftToday = Math.max(0, limit - sentToday());
    if (leftToday === 0) {
      dailyNote = `\n\nToday’s limit of ${limit} is already used up, so sending starts after midnight.`;
    } else if (c.pending > leftToday) {
      const days = 1 + Math.ceil((c.pending - leftToday) / limit);
      dailyNote = `\n\nYour daily limit is ${limit}: ${leftToday} will go out today and the rest over the next ${plural(days - 1, 'day')}. Keep Chrome and the Google Voice tab open.`;
    }
  }
  if (settings.windowOn) {
    const opens = nextWindowOpen(Date.now(), settings);
    dailyNote +=
      opens > Date.now()
        ? `\n\nIt’s outside your sending hours (${windowLabel(settings)}), so sending starts ${new Date(opens).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
        : `\n\nMessages only go out between ${windowLabel(settings)}; outside those hours the queue waits.`;
  }
  const ok = await confirmAction({
    title: `Send ${plural(c.pending, 'message')}?`,
    body:
      `They’ll go out from your Google Voice account one at a time, ${settings.jitterSec > 0 ? `${settings.delaySec} to ${settings.delaySec + settings.jitterSec} seconds (random) apart` : `${settings.delaySec} seconds apart`} (about ${formatDuration(seconds)} of sending in total).${dailyNote}\n\n` +
      'Only continue if everyone on this list has agreed to receive these messages. Keep the Google Voice tab open until the queue finishes.',
    confirmLabel: 'Start sending',
  });
  if (!ok) return;
  const res = await send(PANEL.QUEUE_START);
  if (!res.ok) {
    showAlert(res.error);
    refreshGv();
  } else {
    showAlert('');
  }
}

async function simpleCommand(type) {
  const res = await send(type);
  showAlert(res.ok ? '' : res.error);
  if (!res.ok && type === PANEL.QUEUE_RESUME) refreshGv();
}

async function clearQueue() {
  const c = computeCounts(state?.items ?? []);
  const active = state && (state.status === STATUS.RUNNING || state.status === STATUS.PAUSED);
  const unsent = c.pending + c.failed + c.unknown;
  if (active || unsent > 0) {
    const ok = await confirmAction({
      title: active ? 'Clear the active queue?' : 'Clear the queue?',
      body: `${active ? 'The queue will stop. ' : ''}${plural(unsent, 'contact')} haven’t been sent and will be removed. This can’t be undone.`,
      confirmLabel: 'Clear queue',
      danger: true,
    });
    if (!ok) return;
  }
  const res = await send(PANEL.QUEUE_CLEAR, { confirmed: true });
  showAlert(res.ok ? '' : res.error);
  if (res.ok) {
    filter = 'all';
    listLimit = LIST_PAGE;
    ui.importCard.open = true;
    // Clear queue removes the template too (README promise).
    ui.templateText.value = '';
    saveDraft();
    updateTemplateCount();
    updatePreview();
  }
}

function saveDraft() {
  try {
    if (ui.templateText.value) localStorage.setItem(DRAFT_KEY, ui.templateText.value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* not remembered */
  }
}

async function excludeItem(itemId, exclude) {
  const res = await send(PANEL.QUEUE_EXCLUDE_ITEM, { itemId, exclude });
  showAlert(res.ok ? '' : res.error);
}

async function markSent(itemId) {
  const item = state?.items.find((i) => i.id === itemId);
  if (!item) return;
  const ok = await confirmAction({
    title: `Mark row ${item.row} as sent?`,
    body: 'Only do this after finding the message in the Google Voice conversation. The number is then remembered as texted and won’t be texted again.',
    confirmLabel: 'Mark as sent',
  });
  if (!ok) return;
  const res = await send(PANEL.QUEUE_MARK_SENT, { itemId });
  showAlert(res.ok ? '' : res.error);
}

async function retryFailed() {
  const res = await send(PANEL.QUEUE_RETRY_FAILED);
  if (!res.ok) return showAlert(res.error);
  if (res.needsReview) {
    showAlert(
      `${plural(res.retried, 'contact')} queued to retry. ${plural(res.needsReview, 'other message')} may already have been sent — check each one in Google Voice and retry it individually.`,
      'info',
    );
  } else {
    showAlert(`${plural(res.retried, 'contact')} queued to retry.`, 'info');
  }
}

async function retryItem(itemId) {
  const item = state?.items.find((i) => i.id === itemId);
  if (!item) return;
  let acknowledgeRisk = false;
  if (retryKind(item) === 'confirm') {
    acknowledgeRisk = await confirmAction({
      title: `Retry row ${item.row}?`,
      body:
        'Google Voice may already have sent this message. Open the conversation in Google Voice and check first — retrying could send it twice.',
      confirmLabel: 'Retry anyway',
      danger: true,
    });
    if (!acknowledgeRisk) return;
  }
  const res = await send(PANEL.QUEUE_RETRY_ITEM, { itemId, acknowledgeRisk });
  showAlert(res.ok ? '' : res.error);
}

async function setHistoryPolicy(policy) {
  const res = await send(PANEL.QUEUE_SET_HISTORY, { policy });
  if (!res.ok) showAlert(res.error);
  listSignature = '';
}

async function setDuplicatePolicy(policy) {
  const res = await send(PANEL.QUEUE_SET_DUPLICATES, { policy });
  if (!res.ok) showAlert(res.error);
  listSignature = '';
}

function readSettingsForm() {
  return {
    delaySec: Number(ui.delayInput.value),
    jitterSec: Number(ui.jitterInput.value),
    maxConsecutiveFailures: Number(ui.failInput.value),
    dailyLimit: Number(ui.dailyInput.value),
    windowOn: ui.windowOnInput.checked ? 1 : 0,
    // While the hours are off, keep the saved ones rather than whatever the disabled fields hold.
    windowStart: ui.windowOnInput.checked ? fromTimeValue(ui.windowStartInput.value) : settings.windowStart ?? DEFAULT_SETTINGS.windowStart,
    windowEnd: ui.windowOnInput.checked ? fromTimeValue(ui.windowEndInput.value, { end: true }) : settings.windowEnd ?? DEFAULT_SETTINGS.windowEnd,
    notify: ui.notifyInput.checked ? 1 : 0,
  };
}

function showSettingsErrors(errors = {}, fallback = null) {
  setFieldError(ui.delayInput, ui.delayError, errors.delaySec ?? fallback);
  setFieldError(ui.jitterInput, ui.jitterError, errors.jitterSec);
  setFieldError(ui.failInput, ui.failError, errors.maxConsecutiveFailures);
  setFieldError(ui.dailyInput, ui.dailyError, errors.dailyLimit);
  const windowMsg = errors.windowStart || errors.windowEnd ? errors.windowEnd ?? 'Choose a start time.' : null;
  setFieldError(ui.windowEndInput, ui.windowError, windowMsg);
  if (errors.windowStart) ui.windowStartInput.setAttribute('aria-invalid', 'true');
  else ui.windowStartInput.removeAttribute('aria-invalid');
}

/**
 * Save the form. `auto` saves come from editing a field: they stay quiet about
 * fields that are still being typed and don't rewrite the form.
 */
async function saveSettings({ auto = false } = {}) {
  clearTimeout(settingsTimer);
  const check = validateSettings(readSettingsForm());
  if (!check.ok) {
    if (!auto) showSettingsErrors(check.errors);
    return;
  }
  showSettingsErrors();
  const unchanged = Object.keys(check.value).every((k) => check.value[k] === settings[k]);
  if (auto && unchanged) {
    settingsDirty = false;
    return;
  }
  const res = await send(PANEL.SETTINGS_SAVE, check.value);
  if (!res.ok) {
    showSettingsErrors(res.errors, res.error);
    return;
  }
  settings = res.settings;
  if (auto) settingsDirty = false;
  else renderSettingsForm();
  renderRun();
  ui.settingsSaved.textContent = 'Saved';
  setTimeout(() => {
    ui.settingsSaved.textContent = '';
  }, 2500);
}

function scheduleSettingsSave() {
  settingsDirty = true;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => saveSettings({ auto: true }), 700);
}

async function runDiagnostics() {
  const label = ui.btnDiagnose.querySelector('span');
  ui.btnDiagnose.setAttribute('aria-busy', 'true');
  label.textContent = 'Checking…';
  const res = await send(PANEL.GV_DIAGNOSE);
  ui.btnDiagnose.removeAttribute('aria-busy');
  label.textContent = 'Check page';
  const list = ui.diagResult;
  list.replaceChildren();
  list.hidden = false;
  if (!res.ok) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span class="missing">Failed</span>';
    li.firstChild.textContent = res.error;
    list.append(li);
    return;
  }
  const { report } = res;
  const rows = [
    ['Page state', report.page === 'ready' ? 'ok' : 'missing', report.page.replace('_', ' ')],
    ...report.checks.map((c) => [
      c.label.charAt(0).toUpperCase() + c.label.slice(1),
      c.found ? 'ok' : c.optional ? 'optional' : 'missing',
      c.found ? 'Found' : c.optional ? 'Not shown now' : 'Not found',
    ]),
  ];
  if (report.blockingDialogs) rows.push(['Open dialogs', 'missing', String(report.blockingDialogs)]);
  for (const [label, cls, value] of rows) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('span');
    b.className = cls;
    b.textContent = value;
    li.append(a, b);
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// Wiring

function bindEvents() {
  ui.tabBar.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tab.dataset.tab);
  });
  ui.tabBar.addEventListener('keydown', onTabKey);
  ui.connButton.addEventListener('click', async () => {
    await send(PANEL.GV_OPEN);
    setTimeout(refreshGv, 1500);
  });
  ui.btnImport.addEventListener('click', () => command(importContacts));
  ui.btnImportClear.addEventListener('click', () => {
    ui.importText.value = '';
    fileData = null;
    ui.fileInput.value = '';
    renderFileCard();
    hideImportError();
    updatePreview();
  });
  bindDropzone();
  ui.btnSheetLoad.addEventListener('click', () => loadSheet());
  ui.sheetUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadSheet();
    }
  });
  ui.btnSheetReload.addEventListener('click', () => loadSheet());
  ui.btnSheetRemove.addEventListener('click', removeSheet);
  ui.btnHistoryAdd.addEventListener('click', () => command(addToHistory));
  ui.btnHistoryClear.addEventListener('click', () => command(clearHistory));
  ui.historyControl.addEventListener('change', (e) => {
    if (e.target.name === 'historyPolicy') command(() => setHistoryPolicy(e.target.value));
  });
  for (const radio of ui.sourceRadios) {
    radio.addEventListener('change', () => applySource(radio.value, { focus: true }));
  }
  ui.contactSearch.addEventListener('input', () => {
    search = ui.contactSearch.value.trim();
    listLimit = LIST_PAGE;
    renderContacts();
  });
  ui.btnStart.addEventListener('click', () => command(startQueue));
  ui.btnPause.addEventListener('click', () => command(() => simpleCommand(PANEL.QUEUE_PAUSE)));
  ui.btnResume.addEventListener('click', () => command(() => simpleCommand(PANEL.QUEUE_RESUME)));
  ui.btnStop.addEventListener('click', () => command(() => simpleCommand(PANEL.QUEUE_STOP)));
  ui.btnRetryFailed.addEventListener('click', () => command(retryFailed));
  ui.btnClear.addEventListener('click', () => command(clearQueue));

  ui.filterBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter');
    if (!btn) return;
    filter = btn.dataset.filter;
    listLimit = LIST_PAGE;
    renderContacts();
  });
  for (const radio of ui.modeRadios) {
    radio.addEventListener('change', () => applyMode(radio.value, { focus: true }));
  }
  ui.importText.addEventListener('input', schedulePreview);
  ui.templateText.addEventListener('input', () => {
    updateTemplateCount();
    saveDraft();
    schedulePreview();
  });
  ui.variableChips.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-variable]');
    if (chip) onVariableChip(chip.dataset.variable);
  });
  ui.contactList.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-expand]');
    if (toggle) {
      const id = toggle.dataset.expand;
      if (expandedIds.has(id)) expandedIds.delete(id);
      else expandedIds.add(id);
      listSignature = '';
      renderContacts();
      ui.contactList.querySelector(`[data-expand="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const actions = {
      retry: () => retryItem(id),
      'mark-sent': () => markSent(id),
      exclude: () => excludeItem(id, true),
      include: () => excludeItem(id, false),
    };
    if (actions[btn.dataset.action]) command(actions[btn.dataset.action]);
  });
  ui.btnShowMore.addEventListener('click', () => {
    listLimit += LIST_PAGE;
    renderContacts();
  });
  ui.btnExport.addEventListener('click', exportResults);
  ui.dupControl.addEventListener('change', (e) => {
    if (e.target.name === 'dupPolicy') command(() => setDuplicatePolicy(e.target.value));
  });

  ui.settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    command(() => saveSettings());
  });
  // Changes save by themselves; leaving a field shows what's wrong with it.
  ui.settingsForm.addEventListener('input', scheduleSettingsSave);
  ui.settingsForm.addEventListener('change', (e) => {
    if (e.target === ui.windowOnInput) syncWindowInputs();
    const check = validateSettings(readSettingsForm());
    if (!check.ok) showSettingsErrors(check.errors);
    scheduleSettingsSave();
  });
  ui.btnOptOutAdd.addEventListener('click', () => command(() => changeOptOuts(PANEL.OPTOUT_ADD)));
  ui.btnOptOutRemove.addEventListener('click', () => command(() => changeOptOuts(PANEL.OPTOUT_REMOVE)));
  ui.btnDiagnose.addEventListener('click', () => command(runDiagnostics));
  ui.btnClearLog.addEventListener('click', () => command(() => send(PANEL.LOG_CLEAR)));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STATE_KEY]) {
      state = changes[STATE_KEY].newValue ?? null;
      render();
    }
    if (changes[SETTINGS_KEY]) {
      settings = { ...DEFAULT_SETTINGS, ...changes[SETTINGS_KEY].newValue };
      if (!settingsDirty) renderSettingsForm();
    }
    if (changes[DAILY_KEY]) {
      daily = changes[DAILY_KEY].newValue ?? null;
      renderDaily();
    }
    if (changes[HISTORY_KEY]) {
      setHistory(changes[HISTORY_KEY].newValue);
      schedulePreview();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshGv();
  });
  setInterval(refreshGv, GV_POLL_MS);
  setInterval(() => {
    if (state?.status === STATUS.RUNNING && !state.inFlight) renderRun();
  }, 1000);
}

async function init() {
  bindEvents();
  const res = await send(PANEL.STATE_GET);
  if (res.ok) {
    state = res.state;
    settings = res.settings;
    const stored = await chrome.storage.local.get([DAILY_KEY, HISTORY_KEY]);
    daily = stored[DAILY_KEY] ?? null;
    setHistory(stored[HISTORY_KEY]);
  } else {
    showAlert(res.error);
  }
  renderSettingsForm();
  if (state?.items?.length) ui.importCard.open = false;
  let savedTab = 'send';
  try {
    savedTab = localStorage.getItem(TAB_KEY) || savedTab;
  } catch {
    /* storage unavailable */
  }
  selectTab(savedTab);

  // Restore the message setup: the current queue's template wins, then the last choice.
  let mode = 'column';
  try {
    mode = localStorage.getItem(MODE_KEY) || mode;
  } catch {
    /* storage unavailable */
  }
  const sum = state?.importSummary;
  if (sum?.messageMode) mode = sum.messageMode;
  let draft = null;
  try {
    draft = localStorage.getItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
  // The latest typed message wins; otherwise the current queue's template.
  if (draft) ui.templateText.value = draft;
  else if (sum?.template) ui.templateText.value = sum.template;
  let savedSource = 'file';
  try {
    savedSource = localStorage.getItem(SOURCE_KEY) || savedSource;
  } catch {
    /* storage unavailable */
  }
  try {
    const savedLink = localStorage.getItem(SHEET_KEY);
    const link = savedLink ? parseSheetLink(savedLink) : null;
    if (link?.ok) {
      sheet.link = link;
      ui.sheetUrl.value = link.canonical;
    }
  } catch {
    /* storage unavailable */
  }
  renderSheetCard();
  applySource(savedSource);
  applyMode(mode);

  render();
  refreshGv();
}

init();
