// Sent history: every number this extension has texted, kept across queues
// and days so a growing sheet can be re-imported without texting anyone twice.
//
// Numbers are not stored in readable form. Each one is kept as a salted
// SHA-256 fingerprint of its E.164 form (+12125550147), which is enough to
// answer "was this number texted before?" and nothing more. The salt is random
// per install, so the stored list can't be matched against another one.
//
// Shape (chrome.storage.local, key HISTORY_KEY):
//   { v: 1, salt: '<hex>', entries: { [fingerprint]: [sentAt, confirmed] } }
// The flag is 1 when Google Voice accepted the message, 0 when Send was
// pressed but never confirmed (it may have gone out, so it still counts), and
// 2 when the number is on the do-not-text list (it opted out). Opted-out
// numbers are never texted, survive "Clear history" and are never pruned.

export const HISTORY_KEY = 'gvsh.history';
export const HISTORY_VERSION = 1;
export const HISTORY_LIMIT = 50_000;

const FINGERPRINT_HEX = 20; // 80 bits: collisions are negligible at HISTORY_LIMIT

function randomHex(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function createHistory() {
  return { v: HISTORY_VERSION, salt: randomHex(16), entries: {} };
}

/** A stored history, or null when there is none (or it is unusable). */
export function restoreHistory(raw) {
  if (!raw || raw.v !== HISTORY_VERSION || typeof raw.salt !== 'string' || !raw.entries || typeof raw.entries !== 'object') {
    return null;
  }
  return raw;
}

export const OPTED_OUT = 2;

/** Numbers remembered as texted (opt-outs not included). */
export const historySize = (history) => historyStats(history).texted;

export function historyStats(history) {
  let texted = 0;
  let optedOut = 0;
  for (const entry of Object.values(history?.entries ?? {})) {
    if (entry[1] === OPTED_OUT) optedOut++;
    else texted++;
  }
  return { texted, optedOut };
}

const encoder = new TextEncoder();

/** Fingerprint of one E.164 number under this history's salt. */
export async function fingerprint(history, e164) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${history.salt}:${e164}`));
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, FINGERPRINT_HEX);
}

/**
 * Look up many numbers at once. Returns Map(e164 -> { at, confirmed }) for
 * the numbers that were texted before. `cache` (Map) may be passed to reuse
 * fingerprints between calls; it is only valid for one salt.
 */
export async function lookupNumbers(history, numbers, cache = null) {
  const found = new Map();
  if (!history) return found;
  for (const e164 of new Set(numbers)) {
    if (!e164) continue;
    let key = cache?.get(e164);
    if (!key) {
      key = await fingerprint(history, e164);
      cache?.set(e164, key);
    }
    const entry = history.entries[key];
    if (entry) {
      found.set(e164, entry[1] === OPTED_OUT ? { at: entry[0], confirmed: false, optedOut: true } : { at: entry[0], confirmed: entry[1] === 1 });
    }
  }
  return found;
}

/**
 * Remember that `e164` was texted at `at`. A confirmed send is never
 * downgraded to unconfirmed. Returns true when the history changed.
 */
export async function recordNumber(history, e164, at, confirmed) {
  if (!e164) return false;
  const key = await fingerprint(history, e164);
  const prev = history.entries[key];
  if (prev?.[1] === OPTED_OUT) return false; // never downgraded
  const next = [at, confirmed || prev?.[1] === 1 ? 1 : 0];
  if (prev && prev[0] === next[0] && prev[1] === next[1]) return false;
  history.entries[key] = next;
  return true;
}

/** Forget an unconfirmed send that turned out to have failed. Confirmed sends are kept. */
export async function forgetUnconfirmed(history, e164) {
  const key = await fingerprint(history, e164);
  if (history.entries[key]?.[1] !== 0) return false;
  delete history.entries[key];
  return true;
}

/** Put a number on the do-not-text list. Returns true when it wasn't on it yet. */
export async function recordOptOut(history, e164, at) {
  const key = await fingerprint(history, e164);
  if (history.entries[key]?.[1] === OPTED_OUT) return false;
  history.entries[key] = [at, OPTED_OUT];
  return true;
}

/** Take a number off the do-not-text list. Returns true when it was on it. */
export async function removeOptOut(history, e164) {
  const key = await fingerprint(history, e164);
  if (history.entries[key]?.[1] !== OPTED_OUT) return false;
  delete history.entries[key];
  return true;
}

/** Forget every texted number but keep the do-not-text list. Returns how many were forgotten. */
export function clearTexted(history) {
  let n = 0;
  for (const [key, entry] of Object.entries(history.entries)) {
    if (entry[1] !== OPTED_OUT) {
      delete history.entries[key];
      n++;
    }
  }
  return n;
}

/** Drop the oldest texted entries beyond `limit` (opt-outs are kept). Returns how many were dropped. */
export function pruneHistory(history, limit = HISTORY_LIMIT) {
  const keys = Object.keys(history.entries).filter((k) => history.entries[k][1] !== OPTED_OUT);
  if (keys.length <= limit) return 0;
  keys.sort((a, b) => history.entries[a][0] - history.entries[b][0]);
  const drop = keys.slice(0, keys.length - limit);
  for (const k of drop) delete history.entries[k];
  return drop.length;
}
