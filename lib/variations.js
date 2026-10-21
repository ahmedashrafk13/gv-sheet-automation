// AI message versions: checking what a model wrote, and handing the versions
// out to contacts. Pure functions, shared by the side panel (which asks the
// model, see lib/ai.js), the background worker and the tests.
//
// The model only ever sees the message with its {{placeholders}}, never a
// contact's name or number. Each version is filled in per contact afterwards,
// exactly like the original message. A version is only used when it keeps
// every placeholder, link, number and opt-out keyword of the original.

import { variableKey, renderTemplate, MESSAGE_HARD_LIMIT } from './parser.js';
import { ITEM } from './queue-model.js';

// At most this many versions per message; longer lists reuse them in rotation.
export const MAX_VERSIONS = 100;
// At most this many different messages in one import (each needs its own versions).
export const MAX_SOURCES = 10;

const VAR_RE = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
// Carrier opt-out and help keywords, matched in capitals only.
const KEYWORD_RE = /\b(?:STOP|UNSUBSCRIBE|CANCEL|END|QUIT|OPT[- ]?OUT|HELP|YES|NO)\b/g;

const tokens = (s) => [...String(s).matchAll(VAR_RE)].map((m) => `${variableKey(m[1])}|${(m[2] ?? '').trim()}`);
const withoutVars = (s) => String(s).replace(VAR_RE, ' ');
const urls = (s) => (withoutVars(s).match(URL_RE) || []).map((u) => u.replace(/[.,!?;:)\]]+$/, ''));
const numbers = (s) => withoutVars(s).replace(URL_RE, ' ').match(/\d+(?:[.:,/]\d+)*/g) || [];
const keywords = (s) => withoutVars(s).match(KEYWORD_RE) || [];

/** Lower-case letters and digits only: two versions that differ only in punctuation are the same. */
export const sameText = (a, b) => normalize(a) === normalize(b);
const normalize = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}{}]+/gu, '');

/** Tidy one version as models tend to write it: numbering, bullets, wrapping quotes. */
export function cleanVersion(raw) {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  s = s.replace(/^(?:version\s*)?\d{1,3}\s*[.):-]\s+/i, '').replace(/^[-*•]\s+/, '');
  if (/^(["“'])[\s\S]*(["”'])$/.test(s) && s.length > 1) s = s.slice(1, -1).trim();
  return s;
}

/**
 * Is `candidate` a faithful rewrite of `original`? Checks what must not
 * change; the wording and structure are meant to.
 */
export function validateVersion(original, candidate) {
  const c = String(candidate ?? '');
  if (!c.trim()) return { ok: false, reason: 'empty' };
  if (c.length > MESSAGE_HARD_LIMIT) return { ok: false, reason: 'too long' };
  const o = String(original);
  if (c.length > Math.max(o.length * 1.6, o.length + 80) || c.length < Math.min(o.length * 0.5, o.length - 10)) {
    return { ok: false, reason: 'length changed too much' };
  }
  if (sameText(o, c)) return { ok: false, reason: 'same as the original' };
  if (/[{}]/.test(withoutVars(c))) return { ok: false, reason: 'broken placeholder' };

  const want = new Set(tokens(o));
  const got = new Set(tokens(c));
  if (want.size !== got.size || [...want].some((t) => !got.has(t))) return { ok: false, reason: 'placeholders changed' };
  if (urls(o).some((u) => !c.includes(u))) return { ok: false, reason: 'link changed' };
  const gotNumbers = new Set(numbers(c));
  if (numbers(o).some((n) => !gotNumbers.has(n))) return { ok: false, reason: 'a number, date or price changed' };
  const gotKeywords = new Set(keywords(c));
  if (keywords(o).some((k) => !gotKeywords.has(k))) return { ok: false, reason: 'opt-out wording changed' };
  return { ok: true };
}

/** The instructions sent to the model. Only the message text is included. */
export function buildPrompt(source, count, avoid = []) {
  const system = [
    'You rewrite SMS text messages. Write different versions of the message you are given.',
    'Every version must say the same thing in the same language and tone, using different wording and sentence structure.',
    'Rules:',
    '- Copy every placeholder in double curly braces exactly as written, including anything after "|" (for example {{First Name|there}}). Do not add, remove or rename placeholders.',
    '- Keep all links, phone numbers, dates, times, prices, codes and names of businesses exactly as written.',
    '- Keep opt-out and reply instructions with the same keyword in capitals (for example "Reply STOP to opt out").',
    '- Do not add new facts, offers, emojis, hashtags or links.',
    '- Keep each version about as long as the original.',
    '- Make every version clearly different from the original and from the others.',
    'Reply with JSON only, in the form {"versions": ["...", "..."]}.',
  ].join('\n');
  const parts = [`Message:\n"""\n${source}\n"""`, `Write ${count} different versions.`];
  if (avoid.length) parts.push(`These openings are already used, so start differently:\n${avoid.map((a) => `- ${a}`).join('\n')}`);
  return { system, user: parts.join('\n\n') };
}

/** Pull the list of versions out of a model reply, even when it isn't clean JSON. */
export function parseVersionsReply(text) {
  const raw = String(text ?? '').trim();
  const attempts = [raw, raw.replace(/^```(?:json)?\s*|\s*```$/g, '')];
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) attempts.push(obj[0]);
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) attempts.push(arr[0]);
  for (const a of attempts) {
    try {
      const data = JSON.parse(a);
      const list = Array.isArray(data) ? data : Array.isArray(data?.versions) ? data.versions : Object.values(data ?? {}).find(Array.isArray);
      if (Array.isArray(list)) return list.filter((v) => typeof v === 'string');
    } catch {
      /* try the next form */
    }
  }
  return [];
}

/**
 * Give each item its own version of its message. Contacts that will be sent
 * get versions first, so they don't share one while skipped rows use them up.
 * `rows` are the parseContacts() rows the items were built from (same order);
 * `versions` maps a message (row.source) to its versions. Returns how many
 * items got a version.
 */
export function applyVersions(items, rows, versions, include = () => true) {
  if (!versions) return 0;
  const order = items
    .map((item, i) => i)
    .filter((i) => rows[i]?.valid && include(items[i]))
    .sort((a, b) => Number(items[a].status !== ITEM.PENDING) - Number(items[b].status !== ITEM.PENDING) || a - b);
  const next = new Map();
  let applied = 0;
  for (const i of order) {
    const row = rows[i];
    const list = versions[row.source];
    if (!Array.isArray(list) || !list.length) continue;
    const k = next.get(row.source) ?? 0;
    next.set(row.source, k + 1);
    const n = k % list.length;
    const rendered = renderTemplate(list[n], row.vars);
    const text = rendered.text.trim();
    // A version that can't be filled in for this contact falls back to the original.
    if (rendered.missing.length || rendered.unknown.length || !text || text.length > MESSAGE_HARD_LIMIT) continue;
    items[i].message = text;
    items[i].messageLength = text.length;
    items[i].version = n + 1;
    applied++;
  }
  return applied;
}

/** Keep only versions that pass validateVersion() for their message. */
export function sanitizeVersions(versions) {
  const out = {};
  for (const [source, list] of Object.entries(versions ?? {})) {
    const good = [];
    for (const v of Array.isArray(list) ? list : []) {
      if (validateVersion(source, v).ok && !good.some((g) => sameText(g, v))) good.push(v);
      if (good.length >= MAX_VERSIONS) break;
    }
    if (good.length) out[source] = good;
  }
  return out;
}
