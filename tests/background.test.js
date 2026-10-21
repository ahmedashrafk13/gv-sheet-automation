// Queue engine tests: background.js driven through its real message
// handlers, with mocked Chrome APIs, a scripted content script and a
// controllable clock.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEnv, createFakeContent, loadBackground } from './helpers/chrome-mock.js';
import { PANEL, CONTENT } from '../lib/protocol.js';
import { lookupNumbers } from '../lib/history.js';

const TAB = 7;
const GV_URL = 'https://voice.google.com/u/0/messages';
const NEXT = 'gvsh-next';
const WATCHDOG = 'gvsh-watchdog';
// Rows: 2 Sam, 3 Alex, 4 third, 5 duplicate of 2, 6 invalid
const CSV = [
  'Phone,Message',
  '(212) 555-0147,"Hello Sam, see you at 3."',
  '646-555-0123,"Hi ""Alex"", thanks!"',
  '415.555.0188,Third message',
  '2125550147,Duplicate of row 2',
  '123,Invalid',
].join('\n');

const realNow = Date.now;
let clock;
beforeEach(() => {
  clock = 1_800_000_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});
const advance = (ms) => {
  clock += ms;
};

async function setup({ settings, page, withTab = true, withContent = true } = {}) {
  const env = createChromeEnv();
  if (withTab) env.tabs.set(TAB, { id: TAB, url: GV_URL, active: true, windowId: 1 });
  const fc = withContent ? createFakeContent(env, TAB, { page }) : null;
  await loadBackground(env);
  // Most tests need exact timings, so the random extra delay and the sending
  // hours are off unless a test asks for them (results must not depend on the time zone).
  const saved = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, jitterSec: 0, maxConsecutiveFailures: 3, windowOn: 0, ...settings });
  assert.equal(saved.ok, true);
  const imp = await env.panel(PANEL.QUEUE_IMPORT, { text: CSV });
  assert.equal(imp.ok, true, imp.error);
  return { env, fc };
}

const row = (env, n) => env.state().items.find((i) => i.row === n);

/** Simulate the service worker being killed and started again. */
async function restartWorker(env, { chromeRestarted = false } = {}) {
  const env2 = createChromeEnv({ store: env.store, alarms: env.alarms, tabs: env.tabs });
  const fc2 = createFakeContent(env2, TAB);
  await loadBackground(env2);
  if (chromeRestarted) await env2.fire('onStartup');
  return { env: env2, fc: fc2 };
}

async function sendOne(fc, outcome = 'accepted', extra = {}) {
  await fc.prepared();
  const gate = await fc.commit();
  assert.equal(gate.proceed, true);
  await fc.result(outcome, extra);
}

test('import builds a reviewable queue; invalid rows and duplicates are never pending', async () => {
  const { env } = await setup();
  const s = env.state();
  assert.equal(s.status, 'ready');
  assert.deepEqual(
    s.items.map((i) => [i.row, i.status]),
    [[2, 'pending'], [3, 'pending'], [4, 'pending'], [5, 'skipped'], [6, 'invalid']],
  );
  assert.equal(row(env, 3).message, 'Hi "Alex", thanks!');

  assert.equal((await env.panel(PANEL.QUEUE_SET_DUPLICATES, { policy: 'keep' })).ok, true);
  assert.equal(row(env, 5).status, 'pending');
  await env.panel(PANEL.QUEUE_SET_DUPLICATES, { policy: 'skip' });
  assert.equal(row(env, 5).status, 'skipped');
});

test('template import: same personalised message for everyone; the exact text is what gets sent', async () => {
  const env = createChromeEnv();
  env.tabs.set(TAB, { id: TAB, url: GV_URL, active: true, windowId: 1 });
  const fc = createFakeContent(env, TAB);
  await loadBackground(env);
  await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, maxConsecutiveFailures: 3, windowOn: 0 });
  const text = 'Phone\tFirst Name\n2125550147\tSam\n6465550123\t\n4155550188\tJo';
  const bad = await env.panel(PANEL.QUEUE_IMPORT, { text, messageMode: 'template', template: 'Hi {{Frist Name}}' });
  assert.match(bad.error, /isn’t a column/);
  assert.equal(env.state()?.items?.length ?? 0, 0, 'nothing queued on a template error');

  const r = await env.panel(PANEL.QUEUE_IMPORT, { text, messageMode: 'template', template: 'Hi {{First Name|there}}, we open at 9.' });
  assert.equal(r.ok, true);
  assert.equal(r.summary.messageMode, 'template');
  assert.deepEqual(
    env.state().items.map((i) => i.message),
    ['Hi Sam, we open at 9.', 'Hi there, we open at 9.', 'Hi Jo, we open at 9.'],
  );
  await env.panel(PANEL.QUEUE_START);
  assert.equal(fc.job.message, 'Hi Sam, we open at 9.');
  await fc.result('aborted', { code: 'ABORTED' });
  await env.panel(PANEL.QUEUE_STOP);
  await fc.result('aborted', { code: 'ABORTED' });
  await env.panel(PANEL.QUEUE_CLEAR, { confirmed: true });
  assert.ok(!JSON.stringify(env.store).includes('we open at 9'), 'template removed with the queue');
});

test('contacts are processed one at a time with the configured delay between them', async () => {
  const { env, fc } = await setup();
  assert.equal((await env.panel(PANEL.QUEUE_START)).ok, true);
  assert.equal(fc.jobs.length, 1);
  assert.equal(fc.job.dial, '2125550147');
  assert.equal(row(env, 2).status, 'preparing');

  // An alarm firing while a job is in flight must not start another.
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1);

  await fc.prepared();
  assert.equal(row(env, 2).status, 'prepared');
  assert.equal((await fc.commit()).proceed, true);
  assert.equal(row(env, 2).status, 'sending', '"sending" is persisted before Send may be pressed');

  await fc.result('accepted');
  assert.equal(row(env, 2).status, 'accepted');
  assert.equal(row(env, 2).message, null, 'message body is dropped once sent');
  assert.equal(env.state().nextAt, clock + 60_000);
  assert.equal(env.alarms.get(NEXT).scheduledTime, clock + 60_000);

  advance(30_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1, 'too early');

  advance(30_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 2);
  assert.equal(fc.job.dial, '6465550123');
  await sendOne(fc);

  advance(60_000);
  await env.fireAlarm(NEXT);
  await sendOne(fc);

  const s = env.state();
  assert.equal(s.status, 'completed');
  assert.equal(fc.jobs.length, 3, 'duplicate and invalid rows were not sent');
  assert.match(s.log.at(-1).text, /Queue finished: 3 sent, 0 failed, 0 unconfirmed/);
});

test('double start is rejected and never dispatches two jobs', async () => {
  const { env, fc } = await setup();
  const [a, b] = await Promise.all([env.panel(PANEL.QUEUE_START), env.panel(PANEL.QUEUE_START)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.match([a, b].find((r) => !r.ok).error, /already running/);
  assert.equal(fc.jobs.length, 1);
});

test('pause before Send aborts the job, returns the contact to the queue and stays paused', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  const job1 = fc.job;
  assert.equal((await env.panel(PANEL.QUEUE_PAUSE)).ok, true);
  assert.deepEqual(fc.aborts, [job1.jobId]);
  assert.equal((await fc.commit(job1)).proceed, false, 'commit is refused after pause');

  await fc.result('aborted', { code: 'ABORTED' }, job1);
  assert.equal(row(env, 2).status, 'pending');
  assert.equal(env.state().status, 'paused');

  advance(10 * 60_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1, 'a paused queue does nothing in the background');

  assert.equal((await env.panel(PANEL.QUEUE_RESUME)).ok, true);
  assert.equal(fc.jobs.length, 2);
  assert.equal(fc.job.dial, '2125550147', 'resumes with the same contact');
});

test('pause after Send was pressed lets that message finish, then holds', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  await env.panel(PANEL.QUEUE_PAUSE);
  await fc.result('accepted');
  assert.equal(row(env, 2).status, 'accepted');
  assert.equal(env.state().status, 'paused');
  assert.equal(env.alarms.has(NEXT), false);
  assert.equal(fc.jobs.length, 1);
});

test('Chrome restart after Send was pressed marks the contact unknown and never re-sends it', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();

  const { env: env2, fc: fc2 } = await restartWorker(env, { chromeRestarted: true });
  const s = env2.state();
  assert.equal(s.status, 'paused');
  assert.match(s.pauseReason, /Chrome restarted/);
  const sam = s.items.find((i) => i.row === 2);
  assert.equal(sam.status, 'unknown');
  assert.equal(sam.error.code, 'SEND_UNCONFIRMED');
  assert.equal(sam.message, 'Hello Sam, see you at 3.', 'kept so the user can review and retry');

  assert.equal((await env2.panel(PANEL.QUEUE_RESUME)).ok, true);
  advance(60_000);
  await env2.fireAlarm(NEXT);
  assert.equal(fc2.jobs.length, 1);
  assert.equal(fc2.job.dial, '6465550123', 'moved on to the next contact');
  assert.ok(fc2.jobs.every((j) => j.dial !== '2125550147'));

  // The original job can't be committed again either.
  const late = await env2.fromContent(TAB, { type: CONTENT.COMMIT, jobId: fc.jobs[0].jobId });
  assert.equal(late.proceed, false);

  const retry = await env2.panel(PANEL.QUEUE_RETRY_ITEM, { itemId: sam.id });
  assert.equal(retry.ok, false);
  assert.equal(retry.needsConfirm, true, 'retrying an unknown send needs explicit confirmation');
});

test('Chrome restart while preparing (before Send) safely re-queues the contact', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  const { env: env2 } = await restartWorker(env, { chromeRestarted: true });
  assert.equal(env2.state().items.find((i) => i.row === 2).status, 'pending');
  assert.equal(env2.state().status, 'paused');
});

test('a worker restart between messages keeps the queue and its schedule', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  const { env: env2, fc: fc2 } = await restartWorker(env);
  assert.equal(env2.state().status, 'running');
  advance(60_000);
  await env2.fireAlarm(NEXT);
  assert.equal(fc2.jobs.length, 1);
  assert.equal(fc2.job.dial, '6465550123');
});

test('watchdog: page reloaded before Send -> failed (safe to retry); stale commit refused', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  const job1 = fc.job;
  fc.busyJobId = null; // the page reloaded and forgot the job

  advance(10_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'preparing', 'grace period right after dispatch');

  advance(15_000);
  await env.fireAlarm(WATCHDOG);
  const sam = row(env, 2);
  assert.equal(sam.status, 'failed');
  assert.equal(sam.error.code, 'JOB_LOST');
  assert.equal(sam.sendAttempted, false);
  assert.equal((await fc.commit(job1)).proceed, false);
  assert.equal((await env.panel(PANEL.QUEUE_RETRY_ITEM, { itemId: sam.id })).ok, true);
});

test('watchdog: page lost after Send -> unknown; a late confirmation upgrades it', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  fc.busyJobId = null;
  advance(25_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'unknown');

  await fc.result('accepted');
  assert.equal(row(env, 2).status, 'accepted');
  assert.equal(row(env, 2).message, null);
  assert.match(env.state().log.at(-1).text, /confirmed this message after all/);
});

test('watchdog: uses the page’s own record when the result message was lost', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  fc.busyJobId = null;
  fc.lastJob = { jobId: fc.job.jobId, outcome: 'accepted', sendAttempted: true };
  advance(30_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'accepted');
});

test('watchdog: stuck after Send gets one grace period, then becomes unknown', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  advance(161_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'sending');
  advance(31_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'unknown');
  assert.ok(fc.aborts.includes(fc.job.jobId));
});

test('watchdog: stuck before Send times out as failed', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  advance(161_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(row(env, 2).status, 'failed');
  assert.equal(row(env, 2).error.code, 'TIMEOUT');
  assert.equal((await fc.commit()).proceed, false);
});

test('closing the Google Voice tab mid-send stops the queue and marks the contact unknown', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.prepared();
  await fc.commit();
  env.tabs.delete(TAB);
  await env.fire('onRemoved', TAB);
  const s = env.state();
  assert.equal(s.status, 'stopped');
  assert.equal(s.stopReason.code, 'TAB_CLOSED');
  assert.equal(row(env, 2).status, 'unknown');
});

test('closing the tab while preparing re-queues the contact', async () => {
  const { env } = await setup();
  await env.panel(PANEL.QUEUE_START);
  env.tabs.delete(TAB);
  await env.fire('onRemoved', TAB);
  assert.equal(row(env, 2).status, 'pending');
  assert.equal(env.state().status, 'stopped');
});

test('navigating the tab away is detected by the watchdog', async () => {
  const { env } = await setup();
  await env.panel(PANEL.QUEUE_START);
  env.tabs.get(TAB).url = 'https://example.com/';
  advance(30_000);
  await env.fireAlarm(WATCHDOG);
  assert.equal(env.state().stopReason.code, 'TAB_NAVIGATED');
  assert.equal(row(env, 2).status, 'pending');
});

test('stops after the configured number of consecutive failures', async () => {
  const { env, fc } = await setup({ settings: { delaySec: 45, maxConsecutiveFailures: 2 } });
  await env.panel(PANEL.QUEUE_START);
  await fc.result('failed', { code: 'RECIPIENT_REJECTED' });
  assert.equal(env.state().status, 'running');
  advance(45_000);
  await env.fireAlarm(NEXT);
  await fc.result('failed', { code: 'RECIPIENT_REJECTED' });
  const s = env.state();
  assert.equal(s.status, 'stopped');
  assert.equal(s.stopReason.code, 'TOO_MANY_FAILURES');
  assert.equal(fc.jobs.length, 2);
});

test('a fatal problem before Send (signed out) re-queues the contact and stops', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await fc.result('failed', { code: 'NOT_SIGNED_IN' });
  assert.equal(row(env, 2).status, 'pending');
  assert.equal(env.state().stopReason.code, 'NOT_SIGNED_IN');
});

test('retry rules: safe failures retry freely; possible sends need confirmation', async () => {
  const { env, fc } = await setup({ settings: { delaySec: 45, maxConsecutiveFailures: 10 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc, 'failed', { code: 'SEND_FAILED' }); // row 2: Send pressed, GV said not sent
  advance(45_000);
  await env.fireAlarm(NEXT);
  await fc.result('failed', { code: 'RECIPIENT_REJECTED' }); // row 3: nothing sent
  advance(45_000);
  await env.fireAlarm(NEXT);
  await sendOne(fc, 'unknown', { code: 'SEND_UNCONFIRMED' }); // row 4
  assert.equal(env.state().status, 'completed');

  const bulk = await env.panel(PANEL.QUEUE_RETRY_FAILED);
  assert.deepEqual([bulk.retried, bulk.needsReview], [1, 2]);
  assert.equal(row(env, 3).status, 'pending');
  assert.equal(row(env, 2).status, 'failed');
  assert.equal(row(env, 4).status, 'unknown');
  assert.equal(env.state().status, 'ready');

  for (const n of [2, 4]) {
    const id = row(env, n).id;
    const first = await env.panel(PANEL.QUEUE_RETRY_ITEM, { itemId: id });
    assert.equal(first.needsConfirm, true);
    assert.equal((await env.panel(PANEL.QUEUE_RETRY_ITEM, { itemId: id, acknowledgeRisk: true })).ok, true);
    assert.equal(row(env, n).status, 'pending');
  }
});

test('clear asks for confirmation on an active queue, refuses mid-send, and wipes contact data', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  const ask = await env.panel(PANEL.QUEUE_CLEAR);
  assert.equal(ask.needsConfirm, true);
  await fc.prepared();
  await fc.commit();
  assert.match((await env.panel(PANEL.QUEUE_CLEAR, { confirmed: true })).error, /being sent right now/);
  await fc.result('accepted');

  assert.equal((await env.panel(PANEL.QUEUE_CLEAR, { confirmed: true })).ok, true);
  const s = env.state();
  assert.equal(s.status, 'empty');
  assert.equal(s.items.length, 0);
  const stored = JSON.stringify(env.store);
  assert.ok(!stored.includes('2125550147') && !stored.includes('555-0147'), 'no phone numbers left in storage');
  assert.ok(!stored.includes('Hello Sam'), 'no message text left in storage');
  advance(120_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 1);
});

test('start explains why when Google Voice is unavailable', async () => {
  let { env } = await setup({ withTab: false });
  let r = await env.panel(PANEL.QUEUE_START);
  assert.equal(r.ok, false);
  assert.match(r.error, /isn’t open/);
  assert.equal(env.state().status, 'ready');

  ({ env } = await setup({ withContent: false }));
  r = await env.panel(PANEL.QUEUE_START);
  assert.match(r.error, /Couldn’t reach the Google Voice tab/);
  assert.equal(env.content.injected, 1, 'tried injecting the content script');

  ({ env } = await setup({ page: 'signed_out' }));
  r = await env.panel(PANEL.QUEUE_START);
  assert.match(r.error, /not signed in/);

  const status = await env.panel(PANEL.GV_STATUS);
  assert.equal(status.gv.state, 'signed_out');
});

test('stopping and starting again still honours the delay since the last send', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  const sentAt = clock;
  await env.panel(PANEL.QUEUE_STOP);
  advance(5_000);
  assert.equal((await env.panel(PANEL.QUEUE_START)).ok, true);
  assert.equal(fc.jobs.length, 1, 'no immediate send');
  assert.equal(env.state().nextAt, sentAt + 60_000);
});

test('if the page refuses the job, the contact is re-queued and the queue stops', async () => {
  const { env, fc } = await setup();
  fc.acceptJobs = false;
  await env.panel(PANEL.QUEUE_START);
  assert.equal(row(env, 2).status, 'pending');
  assert.equal(env.state().status, 'stopped');
  assert.equal(env.state().inFlight, null);
});

test('import is blocked while running and asks before replacing unsent contacts', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  assert.match((await env.panel(PANEL.QUEUE_IMPORT, { text: CSV })).error, /Stop the current queue/);
  await env.panel(PANEL.QUEUE_STOP);
  assert.match((await env.panel(PANEL.QUEUE_IMPORT, { text: CSV })).error, /Wait for the current message to finish/, 'still finishing the in-flight job');
  await fc.result('aborted', { code: 'ABORTED' });
  assert.equal(fc.jobs.length, 1);
  const ask = await env.panel(PANEL.QUEUE_IMPORT, { text: CSV });
  assert.equal(ask.needsConfirm, true);
  assert.equal((await env.panel(PANEL.QUEUE_IMPORT, { text: CSV, replace: true })).ok, true);
  assert.match((await env.panel(PANEL.QUEUE_IMPORT, { text: 'nonsense' })).error ?? '', /.+/);
});

test('messages are validated and senders are checked', async () => {
  const { env, fc } = await setup();
  assert.match((await env.panel('panel:bogus')).error, /Unknown message type/);
  assert.match((await env.panel(PANEL.QUEUE_IMPORT, { text: 42 })).error, /Invalid field "text"/);
  assert.match((await env.panel(PANEL.SETTINGS_SAVE, { delaySec: '60', maxConsecutiveFailures: 3 })).error, /Invalid field/);

  await env.panel(PANEL.QUEUE_START);
  const jobId = fc.job.jobId;
  const foreignOrigin = await env.fromContent(TAB, { type: CONTENT.COMMIT, jobId }, 'https://evil.example/');
  assert.equal(foreignOrigin, undefined, 'messages from other sites are ignored');
  const otherExt = await env.raw({ type: PANEL.STATE_GET }, { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' });
  assert.equal(otherExt, undefined);
  const wrongTab = await env.fromContent(99, { type: CONTENT.COMMIT, jobId }, GV_URL);
  assert.equal(wrongTab.proceed, false, 'only the tab that owns the job may commit it');
  const badOutcome = await env.fromContent(TAB, { type: CONTENT.RESULT, jobId, outcome: 'delivered', sendAttempted: true });
  assert.match(badOutcome.error, /Invalid field "outcome"/);
  assert.equal(row(env, 2).status, 'preparing');
});

test('settings are validated and persisted', async () => {
  const { env } = await setup();
  const bad = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 30, maxConsecutiveFailures: 0 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.delaySec, /45 to 3600/);
  assert.match(bad.errors.maxConsecutiveFailures, /1 to 10/);
  const badJitter = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, jitterSec: 4000, maxConsecutiveFailures: 3 });
  assert.equal(badJitter.ok, false);
  assert.match(badJitter.errors.jitterSec, /0 to 3600/);
  const good = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 45, maxConsecutiveFailures: 5 });
  assert.equal(good.ok, true);
  // Fields left out of a save keep their current values (setup() set jitterSec to 0).
  assert.deepEqual(env.store['gvsh.settings'], {
    delaySec: 45, jitterSec: 0, maxConsecutiveFailures: 5, dailyLimit: 0, windowOn: 0, windowStart: 480, windowEnd: 1260, notify: 1,
  });
});

test('logs identify contacts by row and last four digits only', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  const log = JSON.stringify(env.state().log);
  assert.match(log, /Row 2 \(…0147\): accepted by Google Voice/);
  assert.ok(!log.includes('2125550147') && !log.includes('Hello Sam'));
});

test('page check results are summarised in the activity log', async () => {
  const { env } = await setup();
  const r = await env.panel(PANEL.GV_DIAGNOSE);
  assert.equal(r.ok, true);
  assert.match(env.state().log.at(-1).text, /Page check \(ready\): 1 of 1 elements found/);
});

test('a fresh random delay is chosen after every message and stays within the range', async () => {
  const { env, fc } = await setup({ settings: { delaySec: 45, jitterSec: 20 } });
  const realRandom = Math.random;
  const picks = [0, 0.9999999, 0.5]; // Math.random() never returns exactly 1
  Math.random = () => picks.shift() ?? 0;
  try {
    await env.panel(PANEL.QUEUE_START);
    await sendOne(fc);
    assert.equal(env.state().nextDelayMs, 45_000, 'first pick: no extra');
    assert.equal(env.state().nextAt, env.state().lastFinishedAt + 45_000);
    advance(45_000);
    await env.fireAlarm(NEXT);
    await sendOne(fc);
    assert.equal(env.state().nextDelayMs, 65_000, 'second pick: full extra, so a different delay than the first');
    assert.equal(env.state().nextAt, env.state().lastFinishedAt + 65_000);
  } finally {
    Math.random = realRandom;
  }
});

test('the random delay survives a worker restart and is not re-rolled', async () => {
  const { env, fc } = await setup({ settings: { delaySec: 45, jitterSec: 20 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  const { nextAt, nextDelayMs } = env.state();
  const { env: env2 } = await restartWorker(env);
  assert.equal(env2.state().nextDelayMs, nextDelayMs);
  assert.equal(env2.state().nextAt, nextAt);
});

test('with the random extra set to 0 the delay is exactly the base delay', async () => {
  const { env, fc } = await setup({ settings: { delaySec: 50, jitterSec: 0 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  assert.equal(env.state().nextDelayMs, 50_000);
});

// ---------------------------------------------------------------------------
// Daily limit

const tenAm = () => new Date(2027, 0, 15, 10, 0, 0).getTime();
const midnightAfter = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

test('daily limit: stops for the day once reached, then continues after midnight', async () => {
  clock = tenAm();
  const { env, fc } = await setup({ settings: { dailyLimit: 2 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  advance(60_000);
  await env.fireAlarm(NEXT);
  await sendOne(fc);
  assert.deepEqual(env.store['gvsh.daily'], { day: '2027-01-15', count: 2 });

  advance(60_000);
  await env.fireAlarm(NEXT);
  let s = env.state();
  assert.equal(fc.jobs.length, 2, 'no third message today');
  assert.equal(s.status, 'running', 'the queue keeps running and waits');
  assert.equal(s.waitReason, 'daily_limit');
  assert.equal(s.nextAt, midnightAfter(clock));
  assert.equal(env.alarms.get(NEXT).scheduledTime, midnightAfter(clock));
  assert.match(s.log.at(-1).text, /Daily limit reached \(2 sent today\)/);

  // An early alarm during the night does nothing.
  advance(3 * 3600_000);
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 2);

  clock = midnightAfter(clock) + 1000;
  await env.fireAlarm(NEXT);
  assert.equal(fc.jobs.length, 3, 'continues on the new day');
  assert.equal(fc.job.dial, '4155550188');
  await sendOne(fc);
  assert.deepEqual(env.store['gvsh.daily'], { day: '2027-01-16', count: 1 }, 'counter resets each day');
  assert.equal(env.state().status, 'completed');
});

test('daily limit: survives clearing and re-importing the queue', async () => {
  clock = tenAm();
  const { env, fc } = await setup({ settings: { dailyLimit: 1 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  await env.panel(PANEL.QUEUE_STOP);
  await env.panel(PANEL.QUEUE_CLEAR, { confirmed: true });
  await env.panel(PANEL.QUEUE_IMPORT, { text: CSV });
  advance(120_000);
  assert.equal((await env.panel(PANEL.QUEUE_START)).ok, true);
  assert.equal(fc.jobs.length, 1, 'still at today’s limit');
  assert.equal(env.state().waitReason, 'daily_limit');
});

test('daily limit: lowering it while a message is being prepared stops that send before Send is pressed', async () => {
  clock = tenAm();
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc); // 1 sent today, no limit yet
  advance(60_000);
  await env.fireAlarm(NEXT);
  await fc.prepared();
  assert.equal((await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, jitterSec: 0, maxConsecutiveFailures: 3, dailyLimit: 1 })).ok, true);
  assert.equal((await fc.commit()).proceed, false, 'commit refused at the limit');
  await fc.result('aborted', { code: 'ABORTED' });
  assert.equal(row(env, 3).status, 'pending', 'the contact waits for tomorrow');
  assert.equal(env.state().waitReason, 'daily_limit');
  assert.equal(env.store['gvsh.daily'].count, 1);
});

test('daily limit: raising it while waiting resumes sending', async () => {
  clock = tenAm();
  const { env, fc } = await setup({ settings: { dailyLimit: 1 } });
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  advance(60_000);
  await env.fireAlarm(NEXT);
  assert.equal(env.state().waitReason, 'daily_limit');
  await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, jitterSec: 0, maxConsecutiveFailures: 3, dailyLimit: 5 });
  assert.equal(fc.jobs.length, 2);
  assert.equal(env.state().waitReason, null);
});

test('daily limit: a save that leaves the field out keeps the current limit', async () => {
  const { env } = await setup({ settings: { dailyLimit: 25 } });
  await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, maxConsecutiveFailures: 3 });
  assert.equal(env.store['gvsh.settings'].dailyLimit, 25);
  const bad = await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, maxConsecutiveFailures: 3, dailyLimit: 5000 });
  assert.match(bad.errors.dailyLimit, /0 to 1000/);
});

// ---------------------------------------------------------------------------
// Sent history: a number texted once is never texted again by a later import.

const texted = async (env, e164) => (await lookupNumbers(env.store['gvsh.history'], [e164])).get(e164) ?? null;

test('sent history: re-importing the same sheet only queues numbers not texted before', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc); // row 2, (212) 555-0147
  assert.deepEqual(await texted(env, '+12125550147'), { at: clock, confirmed: true });
  assert.ok(!JSON.stringify(env.store['gvsh.history']).includes('2125550147'), 'history holds fingerprints only');
  await env.panel(PANEL.QUEUE_STOP);

  // The next day the same sheet (plus new rows) is imported again.
  const r = await env.panel(PANEL.QUEUE_IMPORT, { text: `${CSV}\n718-555-0197,New row`, replace: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary.alreadyTexted, 1);
  assert.deepEqual(
    env.state().items.map((i) => [i.row, i.status]),
    [[2, 'already_sent'], [3, 'pending'], [4, 'pending'], [5, 'skipped'], [6, 'invalid'], [7, 'pending']],
  );
  assert.match(env.state().log.at(-1).text, /1 texted before \(skipped\)/);

  // Sending again is an explicit, per-queue choice...
  assert.equal((await env.panel(PANEL.QUEUE_SET_HISTORY, { policy: 'send' })).ok, true);
  assert.equal(row(env, 2).status, 'pending');
  assert.equal(row(env, 5).status, 'skipped', 'a repeated row is still a duplicate');
  // ...that a new import never inherits.
  await env.panel(PANEL.QUEUE_IMPORT, { text: CSV, replace: true });
  assert.equal(env.state().historyPolicy, 'skip');
  assert.equal(row(env, 2).status, 'already_sent');
});

test('sent history: an unconfirmed send counts as texted until it is known to have failed', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  const job = fc.job;
  await fc.prepared();
  await fc.commit();
  await fc.result('unknown', { code: 'SEND_UNCONFIRMED' });
  assert.deepEqual(await texted(env, '+12125550147'), { at: clock, confirmed: false });

  // Google Voice later reports the message wasn't sent after all.
  await fc.result('failed', { code: 'SEND_FAILED' }, job);
  assert.equal(row(env, 2).status, 'failed');
  assert.equal(await texted(env, '+12125550147'), null);
});

test('sent history: numbers can be added by hand and the history can be cleared', async () => {
  const { env } = await setup();
  const add = await env.panel(PANEL.HISTORY_ADD, { text: 'Phone\n646-555-0123\n(212) 555-0147\n555-0110' });
  assert.equal(add.ok, true);
  assert.deepEqual([add.added, add.known, add.invalid, add.historyCount], [2, 0, 1, 2]);
  assert.equal(row(env, 3).status, 'already_sent', 'a queue that has not started is re-checked');
  assert.equal((await env.panel(PANEL.HISTORY_ADD, { text: '6465550123' })).known, 1);
  assert.match((await env.panel(PANEL.HISTORY_ADD, { text: 'no numbers here' })).error, /No phone numbers/);

  assert.equal((await env.panel(PANEL.HISTORY_CLEAR)).needsConfirm, true);
  assert.equal((await env.panel(PANEL.HISTORY_CLEAR, { confirmed: true })).ok, true);
  assert.equal(row(env, 3).status, 'pending');
  assert.equal(await texted(env, '+16465550123'), null);
});

test('sent history: an existing install starts its history from the current queue', async () => {
  const { env, fc } = await setup();
  await env.panel(PANEL.QUEUE_START);
  await sendOne(fc);
  delete env.store['gvsh.history']; // as before this feature existed
  const { env: env2 } = await restartWorker(env);
  assert.equal((await env2.panel(PANEL.STATE_GET)).historyCount, 1);
  assert.deepEqual(await texted(env2, '+12125550147'), { at: clock, confirmed: true });
});
