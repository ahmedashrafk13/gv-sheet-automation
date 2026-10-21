// Queue features added after the first release: sending hours, adding rows to
// a running queue, skipping a contact, marking an unconfirmed message as sent,
// the do-not-text list, the toolbar badge and notifications, and recovery when
// the Google Voice tab stops answering.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEnv, createFakeContent, loadBackground } from './helpers/chrome-mock.js';
import { PANEL } from '../lib/protocol.js';
import { lookupNumbers } from '../lib/history.js';
import { nextSendTime, nextWindowOpen, validateSettings, DEFAULT_SETTINGS } from '../lib/queue-model.js';
import { parseSheetLink } from '../lib/sheets.js';

const TAB = 7;
const GV_URL = 'https://voice.google.com/u/0/messages';
const NEXT = 'gvsh-next';
// Rows: 2, 3, 4 valid; 5 duplicate of 2; 6 invalid
const CSV = [
  'Phone,Message',
  '(212) 555-0147,Hello Sam',
  '646-555-0123,Hi Alex',
  '415.555.0188,Third message',
  '2125550147,Duplicate of row 2',
  '123,Invalid',
].join('\n');

const realNow = Date.now;
let clock;
const at = (h, m = 0, day = 15) => new Date(2027, 0, day, h, m, 0).getTime();
beforeEach(() => {
  clock = at(10);
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});
const advance = (ms) => {
  clock += ms;
};

async function setup({ settings, withContent = true, csv = CSV } = {}) {
  const env = createChromeEnv();
  env.tabs.set(TAB, { id: TAB, url: GV_URL, active: true, windowId: 1 });
  const fc = withContent ? createFakeContent(env, TAB) : null;
  await loadBackground(env);
  const saved = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, jitterSec: 0, maxConsecutiveFailures: 3, windowOn: 0, ...settings });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  const imp = await env.panel(PANEL.QUEUE_IMPORT, { text: csv });
  assert.equal(imp.ok, true, imp.error);
  return { env, fc };
}

const row = (env, n) => env.state().items.find((i) => i.row === n);
const byPhone = (env, e164) => env.state().items.find((i) => i.phone === e164);

async function sendOne(fc, outcome = 'accepted', extra = {}) {
  await fc.prepared();
  const gate = await fc.commit();
  assert.equal(gate.proceed, true);
  await fc.result(outcome, extra);
}

// ---------------------------------------------------------------------------
// Sending hours

test('sending hours: helpers find the next open time and validate the range', () => {
  const s = { ...DEFAULT_SETTINGS }; // 8:00 to 21:00, on
  assert.equal(nextWindowOpen(at(10), s), at(10), 'inside the hours: now');
  assert.equal(nextWindowOpen(at(6, 30), s), at(8), 'early morning: today at 8');
  assert.equal(nextWindowOpen(at(21), s), at(8, 0, 16), 'after 9 PM: tomorrow at 8');
  assert.equal(nextWindowOpen(at(23), { ...s, windowOn: 0 }), at(23), 'off: any time');

  assert.equal(validateSettings({ delaySec: 60, maxConsecutiveFailures: 3, windowOn: 1, windowStart: 600, windowEnd: 630 }).ok, false);
  assert.match(
    validateSettings({ delaySec: 60, maxConsecutiveFailures: 3, windowOn: 1, windowStart: 1200, windowEnd: 480 }).errors.windowEnd,
    /at least an hour after the start/,
  );
  assert.equal(validateSettings({ delaySec: 60, maxConsecutiveFailures: 3, windowOn: 0, windowStart: 1200, windowEnd: 480 }).ok, true, 'ignored while off');

  // The delay still applies when the window opens.
  const r = nextSendTime({ now: at(7, 59), lastFinishedAt: at(7, 59), nextDelayMs: 120_000, daily: null, settings: s });
  assert.deepEqual(r, { at: at(8, 1), reason: 'delay' });
  const daily = { day: '2027-01-15', count: 5 };
  assert.deepEqual(
    nextSendTime({ now: at(15), lastFinishedAt: null, nextDelayMs: null, daily, settings: { ...s, dailyLimit: 5 } }),
    { at: at(8, 0, 16), reason: 'daily_limit' },
    'a used-up daily limit continues when tomorrow’s hours start, not at midnight',
  );
});

test('sending hours: a queue started at night waits for the morning, then sends', async () => {
  clock = at(22, 30);
  const { env, fc } = await setup({ settings: { windowOn: 1, windowStart: 9 * 60, windowEnd: 20 * 60 } });
  assert.equal((await env.panel(PANEL.QUEUE_START)).ok, true);
  let s = env.state();
  assert.equal(fc.jobs.length, 0, 'nothing sent at night');
  assert.equal(s.status, 'running');
  assert.equal(s.waitReason, 'hours');
  assert.equal(s.nextAt, at(9, 0, 16));
  assert.match(s.log.at(-1).text, /Outside the sending hours/);

  clock = at(9, 0, 16) + 500;
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1, 'sends once the hours start');
  await sendOne(fc);
});

test('sending hours: a message due after the hours end waits for the next day', async () => {
  clock = at(19, 59) + 30_000;
  const { env, fc } = await setup({ settings: { windowOn: 1, windowStart: 9 * 60, windowEnd: 20 * 60 } });
  await env.panel(PANEL.QUEUE_START);
  assert.equal(fc.jobs.length, 1, 'still inside the hours');
  await sendOne(fc);
  const s = env.state();
  assert.equal(s.waitReason, 'hours', 'the delay would end after 8 PM');
  assert.equal(s.nextAt, at(9, 0, 16));
  advance(60_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1, 'an alarm in the evening sends nothing');
});

test('daily limit with sending hours: continues at the start of tomorrow’s hours', async () => {
  const { env, fc } = await setup({ settings: { dailyLimit: 1, windowOn: 1 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  advance(60_000);
  await env.fireAlarm(NEXT);
  const s = env.state();
  assert.equal(s.waitReason, 'daily_limit');
  assert.equal(s.nextAt, at(8, 0, 16), '8 AM, never midnight');
});

// ---------------------------------------------------------------------------
// Pause edge case

test('pausing while the last message is being sent finishes the queue instead of leaving it paused', async () => {
  const { env, fc } = await setup({ csv: 'Phone,Message\n2125550147,Only one' });
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  await env.panel(PANEL.QUEUE_PAUSE);
  assert.equal(env.state().status, 'paused');
  await fc.result('accepted');
  assert.equal(env.state().status, 'completed', 'nothing left to resume');
});

// ---------------------------------------------------------------------------
// Importing into an existing queue

test('re-importing a queue that never started replaces it without asking', async () => {
  const { env } = await setup();
  const r = await env.panel(PANEL.QUEUE_IMPORT, { text: `${CSV}\n718-555-0197,New` });
  assert.equal(r.ok, true, 'no confirmation needed: nothing was sent from it');
  assert.equal(env.state().items.length, 6);
});

test('new rows can be added to a running queue without stopping it', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc); // row 2 sent

  const plain = await env.panel(PANEL.QUEUE_IMPORT, { text: CSV });
  assert.match(plain.error, /Stop the current queue/);
  assert.equal(plain.canAppend, true);

  const grown = `${CSV}\n718-555-0197,New today\n(303) 555-0142,Also new\n7185550197,Dup of new`;
  const r = await env.panel(PANEL.QUEUE_IMPORT, { text: grown, append: true });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.added, r.inQueue, r.invalid], [2, 4, 1]);
  const s = env.state();
  assert.equal(s.status, 'running', 'still running');
  assert.equal(s.items.length, 7);
  assert.equal(byPhone(env, '+17185550197').status, 'pending');
  assert.equal(byPhone(env, '+13035550142').status, 'pending');
  assert.match(s.log.at(-1).text, /Added 2 new contacts to the queue \(4 already in the queue, 1 need fixing\)/);

  // The new rows go out after the ones already queued.
  for (let i = 0; i < 4; i++) {
    advance(60_000);
    await env.fireAlarm(NEXT);
    await sendOne(fc);
  }
  assert.deepEqual(fc.jobs.map((j) => j.dial), ['2125550147', '6465550123', '4155550188', '7185550197', '3035550142']);
  assert.equal(env.state().status, 'completed');

  // Adding to a finished queue re-opens it; numbers texted before are never added.
  const again = await env.panel(PANEL.QUEUE_IMPORT, { text: `${grown}\n(505) 555-0111,Tomorrow`, append: true });
  assert.deepEqual([again.added, again.inQueue], [1, 7]);
  assert.equal(env.state().status, 'ready');
});

// ---------------------------------------------------------------------------
// Per-contact actions

test('a pending contact can be skipped and included again', async () => {
  const { env, fc } = await setup();
  const id = row(env, 3).id;
  assert.equal((await env.panel(PANEL.QUEUE_EXCLUDE_ITEM, { itemId: id, exclude: true })).ok, true);
  assert.equal(row(env, 3).status, 'excluded');
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  advance(60_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.job.dial, '4155550188', 'the skipped row is passed over');
  await sendOne(fc);
  assert.equal(env.state().status, 'completed');

  assert.equal((await env.panel(PANEL.QUEUE_EXCLUDE_ITEM, { itemId: id, exclude: false })).ok, true);
  assert.equal(row(env, 3).status, 'pending');
  assert.equal(env.state().status, 'ready', 'can be started again for that one');
  assert.match((await env.panel(PANEL.QUEUE_EXCLUDE_ITEM, { itemId: row(env, 2).id, exclude: true })).error, /Only contacts waiting/);
});

test('skipping the last waiting contact of a running queue finishes it', async () => {
  const { env, fc } = await setup({ csv: 'Phone,Message\n2125550147,One\n6465550123,Two' });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  await env.panel(PANEL.QUEUE_EXCLUDE_ITEM, { itemId: row(env, 3).id, exclude: true });
  assert.equal(env.state().status, 'completed');
});

test('an unconfirmed message can be marked as sent after checking Google Voice', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc, 'unknown', { code: 'SEND_UNCONFIRMED' });
  const id = row(env, 2).id;
  assert.match((await env.panel(PANEL.QUEUE_MARK_SENT, { itemId: row(env, 3).id })).error, /Only unconfirmed/);
  assert.equal((await env.panel(PANEL.QUEUE_MARK_SENT, { itemId: id })).ok, true);
  assert.equal(row(env, 2).status, 'accepted');
  assert.equal(row(env, 2).message, null, 'message text removed like any sent message');
  const h = (await lookupNumbers(env.store['gvsh.history'], ['+12125550147'])).get('+12125550147');
  assert.equal(h.confirmed, true);
});

// ---------------------------------------------------------------------------
// Do-not-text list

test('do-not-text list: never texted, even mid-queue or with "Send again"; kept by Clear history', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc); // row 2

  const add = await env.panel(PANEL.OPTOUT_ADD, { text: '646-555-0123\n(212) 555-0147' });
  assert.equal(add.ok, true);
  assert.deepEqual([add.changed, add.held, add.optOutCount], [2, 1, 2]);
  assert.equal(row(env, 3).status, 'opted_out', 'a pending contact in the running queue is held back');
  assert.equal(row(env, 2).status, 'accepted', 'history of what was already sent is unchanged');
  advance(60_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.job.dial, '4155550188');
  await sendOne(fc);

  // A new import marks them opted out, and "Send again" doesn't override that.
  await env.panel(PANEL.QUEUE_STOP);
  const imp = await env.panel(PANEL.QUEUE_IMPORT, { text: CSV, replace: true });
  assert.equal(imp.summary.optedOut, 3, 'rows 2, 3 and row 5 (same number as row 2)');
  await env.panel(PANEL.QUEUE_SET_HISTORY, { policy: 'send' });
  assert.equal(row(env, 3).status, 'opted_out');
  assert.equal(row(env, 4).status, 'pending', 'texted before, sent again on request');

  // Clear history forgets texted numbers but not the opt-outs.
  await env.panel(PANEL.HISTORY_CLEAR, { confirmed: true });
  const state = await env.panel(PANEL.STATE_GET);
  assert.deepEqual([state.historyCount, state.optOutCount], [0, 2]);
  assert.ok(!JSON.stringify(env.store['gvsh.history']).includes('6465550123'), 'fingerprints only');

  const removed = await env.panel(PANEL.OPTOUT_REMOVE, { text: '6465550123' });
  assert.equal(removed.changed, 1);
  assert.equal(row(env, 3).status, 'pending', 'removing it lets the contact be texted');
});

// ---------------------------------------------------------------------------
// Toolbar badge, notifications, tab recovery

test('the toolbar badge shows contacts left, and a notification says when the queue finishes', async () => {
  const { env, fc } = await setup({ csv: 'Phone,Message\n2125550147,One\n6465550123,Two' });
  await env.panel(PANEL.QUEUE_START);
  assert.equal(env.ui.badge, '2');
  await sendOne(fc);
  assert.equal(env.ui.badge, '1');
  await env.panel(PANEL.QUEUE_PAUSE);
  assert.equal(env.ui.badge, 'II');
  await env.panel(PANEL.QUEUE_RESUME);
  advance(60_000);
  await env.fireAlarm(NEXT);
  await sendOne(fc);
  assert.equal(env.ui.badge, '✓');
  assert.match(env.ui.notifications.at(-1).message, /Queue finished: 2 sent/);
});

test('a stop on a problem notifies; notifications can be turned off', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  env.tabs.delete(TAB);
  await env.fire('onRemoved', TAB);
  assert.equal(env.state().status, 'stopped');
  assert.equal(env.ui.badge, '!');
  assert.match(env.ui.notifications.at(-1).message, /tab was closed/);
  assert.equal(fc.jobs.length, 1);

  const quiet = await setup({ settings: { notify: 0 } });
  await quiet.env.panel(PANEL.QUEUE_START);
  quiet.env.tabs.delete(TAB);
  await quiet.env.fire('onRemoved', TAB);
  assert.equal(quiet.env.ui.notifications.length, 0);
});

test('a Google Voice tab that stops answering is reloaded once before the queue gives up', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  const handler = env.content.handler;
  env.content.handler = null; // the page stopped answering (frozen or discarded)
  advance(60_000);
  await env.fireAlarm(NEXT);
  let s = env.state();
  assert.equal(env.content.reloads, 1);
  assert.equal(s.status, 'running', 'still running, waiting for the reload');
  assert.match(s.log.at(-1).text, /reloaded/);

  env.content.handler = handler; // the reload brought it back
  advance(20_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 2, 'the send goes ahead');
  await sendOne(fc);

  // If it keeps failing straight away, the queue stops instead of reloading in a loop.
  env.content.handler = null;
  advance(60_000);
  await env.fireAlarm(NEXT);
  s = env.state();
  assert.equal(env.content.reloads, 1);
  assert.equal(s.status, 'stopped');
  assert.equal(s.stopReason.code, 'CONTENT_UNREACHABLE');
});

test('a sheet link remembers which Google account it belongs to', () => {
  const r = parseSheetLink('https://docs.google.com/spreadsheets/u/1/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=5');
  assert.equal(r.canonical, 'https://docs.google.com/spreadsheets/u/1/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=5');
  const again = parseSheetLink(r.canonical);
  assert.equal(again.authuser, '1');
  assert.match(again.exportUrl, /authuser=1/);
});
