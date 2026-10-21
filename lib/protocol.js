// Message contracts between the side panel, the background service worker
// and the Google Voice content script, plus the shared error catalogue.
//
// content.js is a classic script and cannot import this module, so it keeps
// its own copy of the CONTENT message names. tests/protocol.test.js checks
// that the two copies stay identical.

export const PANEL = Object.freeze({
  STATE_GET: 'panel:state-get',
  QUEUE_IMPORT: 'panel:queue-import',
  QUEUE_SET_DUPLICATES: 'panel:queue-set-duplicates',
  QUEUE_SET_HISTORY: 'panel:queue-set-history',
  QUEUE_START: 'panel:queue-start',
  QUEUE_PAUSE: 'panel:queue-pause',
  QUEUE_RESUME: 'panel:queue-resume',
  QUEUE_STOP: 'panel:queue-stop',
  QUEUE_CLEAR: 'panel:queue-clear',
  QUEUE_RETRY_ITEM: 'panel:queue-retry-item',
  QUEUE_RETRY_FAILED: 'panel:queue-retry-failed',
  SETTINGS_SAVE: 'panel:settings-save',
  GV_STATUS: 'panel:gv-status',
  GV_OPEN: 'panel:gv-open',
  GV_DIAGNOSE: 'panel:gv-diagnose',
  LOG_CLEAR: 'panel:log-clear',
  HISTORY_ADD: 'panel:history-add',
  HISTORY_CLEAR: 'panel:history-clear',
  OPTOUT_ADD: 'panel:optout-add',
  OPTOUT_REMOVE: 'panel:optout-remove',
  QUEUE_EXCLUDE_ITEM: 'panel:queue-exclude-item',
  QUEUE_MARK_SENT: 'panel:queue-mark-sent',
});

export const CONTENT = Object.freeze({
  // background -> content
  PING: 'gv:ping',
  SEND: 'gv:send',
  ABORT: 'gv:abort',
  DIAGNOSE: 'gv:diagnose',
  // content -> background
  PROGRESS: 'gv:progress',
  COMMIT: 'gv:commit',
  RESULT: 'gv:result',
});

/** Steps the content script reports while preparing a message. */
export const STEPS = Object.freeze({
  check_page: 'Checking Google Voice',
  open_composer: 'Opening a new message',
  enter_recipient: 'Entering the phone number',
  verify_recipient: 'Confirming the recipient',
  enter_message: 'Entering the message',
  verify_message: 'Checking the message before sending',
  retrying: 'Retrying after a page hiccup',
  confirming: 'Waiting for Google Voice to confirm',
});

export const OUTCOMES = Object.freeze(['accepted', 'failed', 'unknown', 'aborted']);

/**
 * fatal: stop the whole queue (the problem affects every remaining contact).
 * Non-fatal errors fail one contact and count toward the consecutive-failure limit.
 */
export const ERRORS = Object.freeze({
  NO_GV_TAB: { fatal: true, message: 'Google Voice isn’t open. Open voice.google.com in a tab and try again.' },
  TAB_CLOSED: { fatal: true, message: 'The Google Voice tab was closed.' },
  TAB_NAVIGATED: { fatal: true, message: 'The Google Voice tab navigated to a different site.' },
  CONTENT_UNREACHABLE: { fatal: true, message: 'Couldn’t reach the Google Voice tab. Reload the tab and try again.' },
  CONTENT_BUSY: { fatal: false, message: 'The Google Voice tab was still busy with an earlier message.' },
  NOT_VOICE_PAGE: { fatal: true, message: 'The tab isn’t showing Google Voice.' },
  NOT_SIGNED_IN: { fatal: true, message: 'You’re not signed in to Google Voice. Sign in, then resume.' },
  NOT_SET_UP: { fatal: true, message: 'Google Voice isn’t set up for this Google account.' },
  PAGE_NOT_READY: { fatal: true, message: 'Google Voice didn’t finish loading. Reload the tab and resume.' },
  BLOCKING_DIALOG: { fatal: true, message: 'A Google Voice dialog is blocking the page (it may be a verification or limit notice). Review it in the tab before resuming.' },
  NEW_MESSAGE_NOT_FOUND: { fatal: true, message: 'Couldn’t find the “Send new message” button. Google Voice’s layout may have changed.' },
  RECIPIENT_FIELD_NOT_FOUND: { fatal: true, message: 'Couldn’t find the recipient field. Google Voice’s layout may have changed.' },
  RECIPIENT_REJECTED: { fatal: false, message: 'Google Voice didn’t accept this phone number.' },
  RECIPIENT_NOT_CONFIRMED: { fatal: false, message: 'Couldn’t confirm the recipient, so nothing was sent.' },
  RECIPIENT_MISMATCH: { fatal: false, message: 'The selected recipient didn’t match this row, so nothing was sent.' },
  MESSAGE_FIELD_NOT_FOUND: { fatal: false, message: 'Couldn’t find the message box for this conversation.' },
  MESSAGE_TEXT_MISMATCH: { fatal: false, message: 'Google Voice didn’t accept the full message text, so nothing was sent.' },
  SEND_BUTTON_NOT_FOUND: { fatal: false, message: 'Couldn’t find the Send button.' },
  SEND_DISABLED: { fatal: false, message: 'The Send button stayed disabled, so nothing was sent.' },
  SEND_FAILED: { fatal: false, message: 'Google Voice reported that the message wasn’t sent.' },
  SEND_UNCONFIRMED: { fatal: false, message: 'Send was pressed but Google Voice didn’t confirm the message. Check the conversation before retrying.' },
  JOB_LOST: { fatal: false, message: 'The Google Voice page reloaded while this message was being prepared. Nothing was sent.' },
  INTERRUPTED: { fatal: false, message: 'Processing was interrupted (Chrome or the extension restarted).' },
  TIMEOUT: { fatal: false, message: 'Timed out waiting for Google Voice.' },
  ABORTED: { fatal: false, message: 'Stopped before sending.' },
  TOO_MANY_FAILURES: { fatal: true, message: 'Stopped after too many failures in a row. Check the Google Voice tab and the activity log.' },
  STOPPED_BY_USER: { fatal: false, message: 'Stopped.' },
  UNEXPECTED: { fatal: false, message: 'Something unexpected went wrong.' },
});

export function describeError(code) {
  return (ERRORS[code] || ERRORS.UNEXPECTED).message;
}

export function isFatal(code) {
  return Boolean(ERRORS[code]?.fatal);
}

// ---------------------------------------------------------------------------
// Validation. Every message crossing a context boundary is checked against a
// tiny schema: required fields, types and size limits. Unknown types are
// rejected outright.

const str = (max, { optional = false, pattern } = {}) => (v) => {
  if (v === undefined && optional) return true;
  return typeof v === 'string' && v.length <= max && (!pattern || pattern.test(v));
};
const bool = ({ optional = true } = {}) => (v) => (v === undefined && optional) || typeof v === 'boolean';
const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const optInt = (min, max) => (v) => v === undefined || int(min, max)(v);
const oneOf = (values, { optional = false } = {}) => (v) => (v === undefined && optional) || values.includes(v);

const JOB_ID = /^[A-Za-z0-9-]{8,64}$/;

const PANEL_SCHEMAS = {
  [PANEL.STATE_GET]: {},
  [PANEL.QUEUE_IMPORT]: {
    text: str(2_000_000),
    replace: bool(),
    append: bool(),
    duplicatePolicy: oneOf(['skip', 'keep'], { optional: true }),
    historyPolicy: oneOf(['skip', 'send'], { optional: true }),
    messageMode: oneOf(['column', 'template'], { optional: true }),
    template: str(5000, { optional: true }),
    // AI-written versions: { [message]: [version, ...] } (lib/variations.js)
    versions: (v) =>
      v === undefined ||
      (v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).length <= 10 &&
        Object.entries(v).every(
          ([k, list]) => k.length <= 5000 && Array.isArray(list) && list.length <= 200 && list.every((s) => typeof s === 'string' && s.length <= 5000),
        )),
  },
  [PANEL.QUEUE_SET_DUPLICATES]: { policy: oneOf(['skip', 'keep']) },
  [PANEL.QUEUE_SET_HISTORY]: { policy: oneOf(['skip', 'send']) },
  [PANEL.QUEUE_START]: {},
  [PANEL.QUEUE_PAUSE]: {},
  [PANEL.QUEUE_RESUME]: {},
  [PANEL.QUEUE_STOP]: {},
  [PANEL.QUEUE_CLEAR]: { confirmed: bool() },
  [PANEL.QUEUE_RETRY_ITEM]: { itemId: str(64), acknowledgeRisk: bool() },
  [PANEL.QUEUE_RETRY_FAILED]: {},
  [PANEL.QUEUE_EXCLUDE_ITEM]: { itemId: str(64), exclude: bool({ optional: false }) },
  [PANEL.QUEUE_MARK_SENT]: { itemId: str(64) },
  // Fields after the first three are optional so older panels that don't send them still work.
  [PANEL.SETTINGS_SAVE]: {
    delaySec: int(0, 86_400),
    jitterSec: optInt(0, 86_400),
    maxConsecutiveFailures: int(0, 1000),
    dailyLimit: optInt(0, 100_000),
    windowOn: optInt(0, 1),
    windowStart: optInt(0, 1440),
    windowEnd: optInt(0, 1440),
    notify: optInt(0, 1),
  },
  [PANEL.GV_STATUS]: {},
  [PANEL.GV_OPEN]: {},
  [PANEL.GV_DIAGNOSE]: {},
  [PANEL.LOG_CLEAR]: {},
  [PANEL.HISTORY_ADD]: { text: str(2_000_000) },
  [PANEL.HISTORY_CLEAR]: { confirmed: bool() },
  [PANEL.OPTOUT_ADD]: { text: str(2_000_000) },
  [PANEL.OPTOUT_REMOVE]: { text: str(2_000_000) },
};

const CONTENT_SCHEMAS = {
  [CONTENT.PROGRESS]: {
    jobId: str(64, { pattern: JOB_ID }),
    stage: oneOf(['preparing', 'prepared', 'heartbeat']),
    step: oneOf(Object.keys(STEPS), { optional: true }),
  },
  [CONTENT.COMMIT]: { jobId: str(64, { pattern: JOB_ID }) },
  [CONTENT.RESULT]: {
    jobId: str(64, { pattern: JOB_ID }),
    outcome: oneOf(OUTCOMES),
    code: str(64, { optional: true, pattern: /^[A-Z_]+$/ }),
    detail: str(300, { optional: true }),
    sendAttempted: bool({ optional: false }),
  },
};

function validateAgainst(schemas, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'Malformed message.' };
  const schema = schemas[msg.type];
  if (!schema) return { ok: false, error: `Unknown message type: ${String(msg.type).slice(0, 40)}` };
  for (const [field, check] of Object.entries(schema)) {
    if (!check(msg[field])) return { ok: false, error: `Invalid field "${field}" in ${msg.type}.` };
  }
  return { ok: true };
}

export const validatePanelMessage = (msg) => validateAgainst(PANEL_SCHEMAS, msg);
export const validateContentMessage = (msg) => validateAgainst(CONTENT_SCHEMAS, msg);
