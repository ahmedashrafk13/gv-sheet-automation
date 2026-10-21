// Sent history (fingerprints), number extraction and Google Sheet links.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHistory,
  restoreHistory,
  historySize,
  fingerprint,
  lookupNumbers,
  recordNumber,
  forgetUnconfirmed,
  pruneHistory,
} from '../lib/history.js';
import { extractPhones } from '../lib/parser.js';
import { parseSheetLink, titleFromDisposition, fetchSheetCsv } from '../lib/sheets.js';
import { ITEM, buildItems, applyPolicies, computeCounts } from '../lib/queue-model.js';
import { parseContacts } from '../lib/parser.js';

test('history stores salted fingerprints, never the numbers', async () => {
  const h = createHistory();
  await recordNumber(h, '+12125550147', 1000, true);
  const json = JSON.stringify(h);
  assert.ok(!json.includes('2125550147'), 'number is not stored in readable form');
  assert.equal(historySize(h), 1);

  const other = createHistory();
  assert.notEqual(await fingerprint(h, '+12125550147'), await fingerprint(other, '+12125550147'), 'salt differs per install');
});

test('lookup finds texted numbers and reports when and whether confirmed', async () => {
  const h = createHistory();
  await recordNumber(h, '+12125550147', 1000, true);
  await recordNumber(h, '+16465550123', 2000, false);
  const cache = new Map();
  const found = await lookupNumbers(h, ['+12125550147', '+16465550123', '+14155550188', null], cache);
  assert.deepEqual(found.get('+12125550147'), { at: 1000, confirmed: true });
  assert.deepEqual(found.get('+16465550123'), { at: 2000, confirmed: false });
  assert.equal(found.has('+14155550188'), false);
  assert.equal(cache.size, 3, 'fingerprints are cached between lookups');
  assert.equal((await lookupNumbers(null, ['+12125550147'])).size, 0, 'no history means nothing texted');
});

test('a confirmed send is never downgraded; an unconfirmed one can be forgotten', async () => {
  const h = createHistory();
  await recordNumber(h, '+12125550147', 1000, true);
  await recordNumber(h, '+12125550147', 2000, false);
  assert.deepEqual((await lookupNumbers(h, ['+12125550147'])).get('+12125550147'), { at: 2000, confirmed: true });
  assert.equal(await forgetUnconfirmed(h, '+12125550147'), false, 'confirmed sends are kept');

  await recordNumber(h, '+16465550123', 3000, false);
  assert.equal(await forgetUnconfirmed(h, '+16465550123'), true);
  assert.equal(historySize(h), 1);
});

test('pruning drops the oldest entries first', async () => {
  const h = createHistory();
  for (let i = 0; i < 5; i++) await recordNumber(h, `+1212555010${i}`, 1000 + i, true);
  assert.equal(pruneHistory(h, 3), 2);
  const left = await lookupNumbers(h, ['+12125550100', '+12125550101', '+12125550104']);
  assert.deepEqual([...left.keys()], ['+12125550104']);
});

test('restoreHistory rejects unusable data', () => {
  assert.equal(restoreHistory(undefined), null);
  assert.equal(restoreHistory({ v: 99, salt: 'x', entries: {} }), null);
  assert.equal(restoreHistory({ v: 1, entries: {} }), null);
  const h = createHistory();
  assert.equal(restoreHistory(h), h);
});

test('extractPhones reads one number per line or a pasted column', () => {
  const r = extractPhones('Phone\n(212) 555-0147\n646.555.0123, +44 20 7946 0958\n212-555-0147\n123-4567\nSam');
  assert.deepEqual(r.numbers, ['+12125550147', '+16465550123', '+442079460958']);
  assert.equal(r.invalid, 1, '7-digit number without area code is reported');
});

test('items texted before are skipped by default and can be sent again', async () => {
  const parsed = parseContacts('Phone,Message\n2125550147,A\n6465550123,B\n2125550147,C', { maxContacts: 10 });
  const texted = new Map([['+12125550147', { at: 5, confirmed: true }]]);
  const items = buildItems(parsed, 'skip', { texted });
  assert.deepEqual(items.map((i) => i.status), [ITEM.ALREADY_SENT, ITEM.PENDING, ITEM.SKIPPED]);
  assert.equal(items[0].textedAt, 5);
  const c = computeCounts(items);
  assert.equal(c.alreadySent, 1);
  assert.equal(c.total, 1, 'already-texted rows are not part of the run');

  applyPolicies(items, 'skip', 'send');
  assert.deepEqual(items.map((i) => i.status), [ITEM.PENDING, ITEM.PENDING, ITEM.SKIPPED], 'duplicate row stays skipped');
  applyPolicies(items, 'keep', 'skip');
  assert.deepEqual(items.map((i) => i.status), [ITEM.ALREADY_SENT, ITEM.PENDING, ITEM.ALREADY_SENT]);
});

test('parseSheetLink turns an address-bar link into the CSV export URL', () => {
  const r = parseSheetLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=123456');
  assert.equal(r.ok, true);
  assert.equal(r.exportUrl, 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=csv&gid=123456');
  assert.equal(r.canonical, 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=123456');

  const multi = parseSheetLink('docs.google.com/spreadsheets/u/1/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?gid=7');
  assert.equal(multi.exportUrl, 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=csv&gid=7&authuser=1');

  const pub = parseSheetLink('https://docs.google.com/spreadsheets/d/e/2PACX-1vSabcdefghijklmnopqrstuvwxyz/pubhtml');
  assert.equal(pub.exportUrl, 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSabcdefghijklmnopqrstuvwxyz/pub?output=csv&single=true');

  assert.match(parseSheetLink('').error, /Paste the link/);
  assert.match(parseSheetLink('https://example.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz').error, /isn’t a Google Sheets link/);
  assert.match(parseSheetLink('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit').error, /isn’t a Google Sheets link/);
});

test('titleFromDisposition reads the sheet name', () => {
  assert.equal(titleFromDisposition('attachment; filename="Daily leads - Sheet1.csv"; filename*=UTF-8\'\'Daily%20leads%20-%20Sheet1.csv'), 'Daily leads - Sheet1');
  assert.equal(titleFromDisposition('attachment; filename="Leads.csv"'), 'Leads');
  assert.equal(titleFromDisposition(null), null);
});

const response = (status, body, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/csv; charset=utf-8', ...headers } });

test('fetchSheetCsv returns the CSV and explains each failure', async () => {
  const link = parseSheetLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit');
  let seen;
  const ok = await fetchSheetCsv(link, {
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return response(200, 'Phone\n2125550147', { 'content-disposition': 'attachment; filename="Leads - Sheet1.csv"' });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(new TextDecoder().decode(ok.buffer), 'Phone\n2125550147');
  assert.equal(ok.title, 'Leads - Sheet1');
  assert.equal(seen.opts.credentials, 'include', 'uses the Google sign-in in this profile');

  const notFound = await fetchSheetCsv(link, { fetchImpl: async () => response(404, 'nope', { 'content-type': 'text/html' }) });
  assert.match(notFound.error, /wouldn’t open that sheet/);
  const signIn = await fetchSheetCsv(link, { fetchImpl: async () => response(200, '<html>', { 'content-type': 'text/html' }) });
  assert.match(signIn.error, /sign-in/);
  const offline = await fetchSheetCsv(link, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.match(offline.error, /internet connection/);
});
