// Queue data model: state shape, item statuses, counters and settings.
// Pure functions shared by the background service worker and the side panel.

export const SCHEMA_VERSION = 1;
export const LOG_LIMIT = 300;

export const STATUS = Object.freeze({
  EMPTY: 'empty',
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
});

/**
 * Item lifecycle:
 *   pending -> preparing -> prepared -> sending -> accepted | failed | unknown
 * invalid, skipped (duplicate row), already_sent (texted in an earlier
 * queue, see lib/history.js), opted_out (on the do-not-text list) and
 * excluded (skipped by the user) items are never processed.
 *
 * "accepted" means the Google Voice interface accepted the message. Carrier
 * delivery is not observable and is never claimed.
 */
export const ITEM = Object.freeze({
  INVALID: 'invalid',
  SKIPPED: 'skipped',
  ALREADY_SENT: 'already_sent',
  OPTED_OUT: 'opted_out',
  EXCLUDED: 'excluded',
  PENDING: 'pending',
  PREPARING: 'preparing',
  PREPARED: 'prepared',
  SENDING: 'sending',
  ACCEPTED: 'accepted',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
});

export const ITEM_LABELS = Object.freeze({
  invalid: 'Needs fixing',
  skipped: 'Duplicate',
  already_sent: 'Texted before',
  opted_out: 'Opted out',
  excluded: 'Skipped by you',
  pending: 'Pending',
  preparing: 'Preparing',
  prepared: 'Prepared',
  sending: 'Sending',
  accepted: 'Sent',
  failed: 'Failed',
  unknown: 'Unconfirmed',
});

const IN_PROGRESS = new Set([ITEM.PREPARING, ITEM.PREPARED, ITEM.SENDING]);

export const SETTINGS_LIMITS = Object.freeze({
  delaySec: { min: 45, max: 3600, default: 60 },
  // Random extra wait added on top of delaySec after every message (0 = off).
  jitterSec: { min: 0, max: 3600, default: 30, optional: true },
  maxConsecutiveFailures: { min: 1, max: 10, default: 3 },
  // Most messages to send per calendar day (local time). 0 = no limit.
  dailyLimit: { min: 0, max: 1000, default: 0, optional: true },
  // Sending hours, in minutes after local midnight. Outside them the queue
  // waits (8 AM to 9 PM by default: the TCPA quiet hours are 9 PM to 8 AM).
  windowOn: { min: 0, max: 1, default: 1, optional: true },
  windowStart: { min: 0, max: 1439, default: 8 * 60, optional: true },
  windowEnd: { min: 1, max: 1440, default: 21 * 60, optional: true },
  // Desktop notification when a queue finishes or stops on a problem.
  notify: { min: 0, max: 1, default: 1, optional: true },
});

export const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(Object.entries(SETTINGS_LIMITS).map(([key, limits]) => [key, limits.default])),
);

// ---------------------------------------------------------------------------
// Daily limit. The counter is { day: 'YYYY-MM-DD' (local), count } and counts
// every message where Send was pressed, across queues.

export function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local midnight at the start of the day after `t`. */
export function startOfNextDay(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** Messages counted so far on the local day containing `t`. */
export function sentOnDay(daily, t) {
  return daily && daily.day === localDayKey(t) ? daily.count : 0;
}

export function dailyLimitReached(daily, settings, t) {
  return settings.dailyLimit > 0 && sentOnDay(daily, t) >= settings.dailyLimit;
}

// ---------------------------------------------------------------------------
// Sending hours

/** The earliest time at or after `t` that is inside the sending hours. */
export function nextWindowOpen(t, settings) {
  if (!settings.windowOn) return t;
  const d = new Date(t);
  const minute = d.getHours() * 60 + d.getMinutes();
  const opensOn = (dayOffset) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, Math.floor(settings.windowStart / 60), settings.windowStart % 60).getTime();
  if (minute < settings.windowStart) return opensOn(0);
  if (minute >= settings.windowEnd) return opensOn(1);
  return t;
}

/** "8:00 AM" style label for minutes after midnight (1440 = midnight at the end of the day). */
export function formatMinutes(min) {
  const d = new Date(2000, 0, 1, Math.floor(min / 60), min % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "8:00 AM–9:00 PM" */
export const windowLabel = (settings) => `${formatMinutes(settings.windowStart)}–${formatMinutes(settings.windowEnd)}`;

/**
 * When the next message may start, given the delay since the last one, the
 * daily limit and the sending hours. reason is null when it can start now,
 * otherwise 'delay', 'daily_limit' or 'hours'.
 */
export function nextSendTime({ now, lastFinishedAt, nextDelayMs, daily, settings }) {
  let at = lastFinishedAt && nextDelayMs != null ? Math.max(now, lastFinishedAt + nextDelayMs) : now;
  let reason = at > now + 1000 ? 'delay' : null;
  if (dailyLimitReached(daily, settings, at)) {
    at = startOfNextDay(at);
    reason = 'daily_limit';
  }
  const open = nextWindowOpen(at, settings);
  if (open > at) {
    at = open;
    if (reason !== 'daily_limit') reason = 'hours';
  }
  return { at: reason ? at : now, reason };
}

/**
 * Pick how long to wait after a message: the base delay plus a random extra
 * between 0 and jitterSec seconds (inclusive, whole milliseconds).
 * `random` is injectable so tests can make the result predictable.
 */
export function pickDelayMs(settings, random = Math.random) {
  const base = settings.delaySec * 1000;
  const extra = Math.floor(random() * ((settings.jitterSec ?? 0) * 1000 + 1));
  return base + extra;
}

/** Validate settings entered by the user. Returns field-level error messages. */
export function validateSettings(input, base = DEFAULT_SETTINGS) {
  const errors = {};
  const value = {};
  for (const [key, limits] of Object.entries(SETTINGS_LIMITS)) {
    // Optional settings keep their current value (or the default) when the field is missing.
    if (limits.optional && (input?.[key] === undefined || input?.[key] === null)) {
      value[key] = base?.[key] ?? limits.default;
      continue;
    }
    const n = Number(input?.[key]);
    if (!Number.isInteger(n)) {
      errors[key] = 'Enter a whole number.';
    } else if (n < limits.min || n > limits.max) {
      errors[key] = `Enter a value from ${limits.min} to ${limits.max}.`;
    } else {
      value[key] = n;
    }
  }
  if (value.windowOn && !errors.windowStart && !errors.windowEnd && value.windowEnd - value.windowStart < 60) {
    errors.windowEnd = 'The end must be at least an hour after the start (same day).';
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Coerce stored settings into a valid object, falling back to defaults per field. */
export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, limits] of Object.entries(SETTINGS_LIMITS)) {
    const n = raw?.[key];
    if (Number.isInteger(n) && n >= limits.min && n <= limits.max) out[key] = n;
  }
  if (out.windowEnd - out.windowStart < 60) {
    out.windowStart = DEFAULT_SETTINGS.windowStart;
    out.windowEnd = DEFAULT_SETTINGS.windowEnd;
  }
  return out;
}

export function createEmptyState(duplicatePolicy = 'skip', historyPolicy = 'skip') {
  return {
    schema: SCHEMA_VERSION,
    status: STATUS.EMPTY,
    items: [],
    duplicatePolicy,
    historyPolicy, // 'skip' numbers texted in an earlier queue, or 'send' them again
    importSummary: null,
    tabId: null,
    inFlight: null,
    nextAt: null,
    lastFinishedAt: null,
    nextDelayMs: null, // the random delay chosen after the last finished message
    consecutiveFailures: 0,
    stopReason: null,
    pauseReason: null,
    updatedAt: Date.now(),
    log: [],
  };
}

let idCounter = 0;
function newItemId(row) {
  idCounter = (idCounter + 1) % 1e6;
  return `r${row}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Turn a parseContacts() result into queue items.
 * `texted` is Map(e164 -> { at, confirmed }) of numbers texted before.
 */
export function buildItems(parsed, duplicatePolicy, { texted = new Map(), historyPolicy = 'skip' } = {}) {
  const items = parsed.rows.map((r) => ({
    id: newItemId(r.row),
    row: r.row,
    phone: r.phone,
    display: r.display,
    dial: r.dial,
    digits: r.digits,
    international: r.international,
    message: r.message,
    messageLength: r.message.length,
    status: r.valid ? ITEM.PENDING : ITEM.INVALID,
    errors: r.errors,
    warnings: r.warnings,
    duplicateOf: r.duplicateOf,
    textedAt: (r.valid && !texted.get(r.phone)?.optedOut && texted.get(r.phone)?.at) || null,
    textedConfirmed: Boolean(r.valid && texted.get(r.phone)?.confirmed),
    error: null,
    attempts: 0,
    sendAttempted: false,
    lastJobId: null,
    updatedAt: Date.now(),
  }));
  // On the do-not-text list: never sent, whatever the policies say.
  for (const item of items) if (item.phone && texted.get(item.phone)?.optedOut) item.status = ITEM.OPTED_OUT;
  applyPolicies(items, duplicatePolicy, historyPolicy);
  return items;
}

const POLICY_STATUSES = new Set([ITEM.PENDING, ITEM.SKIPPED, ITEM.ALREADY_SENT]);

/**
 * Decide which untouched items are sent: a repeated row is skipped when
 * duplicatePolicy is 'skip', and a number texted in an earlier queue is
 * skipped when historyPolicy is 'skip'. Only valid before any sending.
 */
export function applyPolicies(items, duplicatePolicy, historyPolicy = 'skip') {
  for (const item of items) {
    if (!POLICY_STATUSES.has(item.status) || item.attempts > 0) continue;
    if (item.duplicateOf != null && duplicatePolicy !== 'keep') item.status = ITEM.SKIPPED;
    else if (item.textedAt != null && historyPolicy !== 'send') item.status = ITEM.ALREADY_SENT;
    else item.status = ITEM.PENDING;
  }
  return items;
}

export function computeCounts(items) {
  const c = {
    rows: items.length,
    total: 0,
    invalid: 0,
    skipped: 0,
    alreadySent: 0,
    optedOut: 0,
    excluded: 0,
    pending: 0,
    inProgress: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
  };
  for (const item of items) {
    if (item.status === ITEM.INVALID) c.invalid++;
    else if (item.status === ITEM.SKIPPED) c.skipped++;
    else if (item.status === ITEM.ALREADY_SENT) c.alreadySent++;
    else if (item.status === ITEM.OPTED_OUT) c.optedOut++;
    else if (item.status === ITEM.EXCLUDED) c.excluded++;
    else {
      c.total++;
      if (item.status === ITEM.PENDING) c.pending++;
      else if (IN_PROGRESS.has(item.status)) c.inProgress++;
      else if (item.status === ITEM.ACCEPTED) c.accepted++;
      else if (item.status === ITEM.FAILED) c.failed++;
      else if (item.status === ITEM.UNKNOWN) c.unknown++;
    }
  }
  c.remaining = c.pending + c.inProgress;
  c.done = c.accepted + c.failed + c.unknown;
  return c;
}

export const nextPendingItem = (items) => items.find((i) => i.status === ITEM.PENDING) || null;

/**
 * Can this item be put back in the queue?
 *  'no'      - not retryable
 *  'yes'     - nothing was sent, safe to retry
 *  'confirm' - Google Voice may already have sent it; the user must check first
 */
export function retryKind(item) {
  if (item.status === ITEM.UNKNOWN) return 'confirm';
  if (item.status === ITEM.FAILED) return item.sendAttempted ? 'confirm' : 'yes';
  return 'no';
}

/** Rough seconds per message on top of the delay: opening the composer, typing, confirming. */
export const WORK_SEC_PER_MESSAGE = 20;

/** Average seconds between the starts of two messages with these settings. */
export const averageGapSec = (settings) => settings.delaySec + (settings.jitterSec ?? 0) / 2 + WORK_SEC_PER_MESSAGE;

/** Short, non-identifying label for logs: "Row 4 (…0147)". */
export function itemLabel(item) {
  const digits = String(item.phone || item.display || '').replace(/\D/g, '');
  const tail = digits.length >= 4 ? ` (…${digits.slice(-4)})` : '';
  return `Row ${item.row}${tail}`;
}

/** Remove phone-number-like digit runs from free text before logging it. */
export function redactDigits(text) {
  return String(text ?? '').replace(/\+?\(?\d[\d\s().-]{3,}\d/g, '••••');
}
