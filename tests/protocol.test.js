import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTENT, ERRORS, STEPS, validateContentMessage, validatePanelMessage, PANEL } from '../lib/protocol.js';
import { computeCounts, retryKind, validateSettings, normalizeSettings, pickDelayMs, redactDigits, itemLabel } from '../lib/queue-model.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('content.js message names match lib/protocol.js', () => {
  const src = read('content.js');
  const block = src.match(/const MSG = Object\.freeze\(\{([\s\S]*?)\}\);/)[1];
  const names = Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(names, { ...CONTENT });
});

test('every error code the content script can raise has a user-facing message', () => {
  const src = read('content.js');
  const codes = new Set([...src.matchAll(/GvError\('([A-Z_]+)'/g)].map((m) => m[1]));
  codes.add('SEND_UNCONFIRMED');
  for (const code of codes) assert.ok(ERRORS[code], `missing ERRORS.${code}`);
  for (const step of [...src.matchAll(/reportStep\(ctx, '([a-z_]+)'\)/g)].map((m) => m[1])) {
    assert.ok(STEPS[step], `missing STEPS.${step}`);
  }
});

test('content messages are schema-checked', () => {
  assert.equal(validateContentMessage({ type: CONTENT.COMMIT, jobId: '123e4567-e89b-12d3-a456-426614174000' }).ok, true);
  assert.equal(validateContentMessage({ type: CONTENT.COMMIT, jobId: 'x' }).ok, false);
  assert.equal(validateContentMessage({ type: CONTENT.PROGRESS, jobId: 'abcdefgh', stage: 'prepared', step: 'nope' }).ok, false);
  assert.equal(validateContentMessage({ type: CONTENT.RESULT, jobId: 'abcdefgh', outcome: 'accepted' }).ok, false, 'sendAttempted is required');
  assert.equal(validateContentMessage({ type: CONTENT.RESULT, jobId: 'abcdefgh', outcome: 'accepted', sendAttempted: true }).ok, true);
  assert.equal(validateContentMessage({ type: CONTENT.SEND }).ok, false, 'background->content types are not accepted from pages');
  assert.equal(validateContentMessage(null).ok, false);
  assert.equal(validatePanelMessage([]).ok, false);
  assert.equal(validatePanelMessage({ type: PANEL.QUEUE_RETRY_ITEM }).ok, false);
});

test('settings validation enforces the 45 second minimum', () => {
  assert.equal(validateSettings({ delaySec: 44, maxConsecutiveFailures: 3 }).ok, false);
  assert.equal(validateSettings({ delaySec: 45, maxConsecutiveFailures: 3 }).ok, true);
  assert.equal(validateSettings({ delaySec: 60.5, maxConsecutiveFailures: 3 }).ok, false);
  assert.deepEqual(normalizeSettings({ delaySec: 10, maxConsecutiveFailures: 4 }), {
    delaySec: 60, jitterSec: 30, maxConsecutiveFailures: 4, dailyLimit: 0, windowOn: 1, windowStart: 480, windowEnd: 1260, notify: 1,
  });
});

test('random extra delay setting is validated and optional', () => {
  assert.equal(validateSettings({ delaySec: 45, jitterSec: 0, maxConsecutiveFailures: 3 }).ok, true, '0 turns it off');
  assert.equal(validateSettings({ delaySec: 45, jitterSec: -1, maxConsecutiveFailures: 3 }).ok, false);
  assert.equal(validateSettings({ delaySec: 45, jitterSec: 3601, maxConsecutiveFailures: 3 }).ok, false);
  assert.equal(validateSettings({ delaySec: 45, jitterSec: 1.5, maxConsecutiveFailures: 3 }).ok, false);
  assert.equal(validateSettings({ delaySec: 45, maxConsecutiveFailures: 3 }).value.jitterSec, 30, 'missing field uses the default');
});

test('pickDelayMs stays between the base delay and base + extra', () => {
  const s = { delaySec: 60, jitterSec: 30 };
  assert.equal(pickDelayMs(s, () => 0), 60_000);
  assert.equal(pickDelayMs(s, () => 0.5), 75_000);
  assert.ok(pickDelayMs(s, () => 0.999999) <= 90_000);
  assert.equal(pickDelayMs({ delaySec: 60, jitterSec: 0 }, () => 0.9), 60_000, 'no extra when off');
  for (let i = 0; i < 200; i++) {
    const d = pickDelayMs(s);
    assert.ok(d >= 60_000 && d <= 90_000, `delay ${d} out of range`);
  }
});

test('counts and retry classification', () => {
  const items = [
    { status: 'pending' }, { status: 'sending' }, { status: 'accepted' }, { status: 'failed', sendAttempted: false },
    { status: 'failed', sendAttempted: true }, { status: 'unknown' }, { status: 'invalid' }, { status: 'skipped' },
  ];
  const c = computeCounts(items);
  assert.deepEqual(
    [c.total, c.pending, c.inProgress, c.accepted, c.failed, c.unknown, c.invalid, c.skipped, c.remaining, c.done],
    [6, 1, 1, 1, 2, 1, 1, 1, 2, 4],
  );
  assert.deepEqual(items.map(retryKind), ['no', 'no', 'no', 'yes', 'confirm', 'confirm', 'no', 'no']);
});

test('redaction helpers keep logs free of full numbers', () => {
  assert.equal(redactDigits('Call (212) 555-0147 now'), 'Call •••• now');
  assert.equal(itemLabel({ row: 4, phone: '+12125550147' }), 'Row 4 (…0147)');
});

test('daily limit helpers use local calendar days', async () => {
  const { localDayKey, startOfNextDay, sentOnDay, dailyLimitReached } = await import('../lib/queue-model.js');
  const t = new Date(2027, 2, 9, 23, 59, 30).getTime();
  assert.equal(localDayKey(t), '2027-03-09');
  assert.equal(startOfNextDay(t), new Date(2027, 2, 10).getTime());
  assert.equal(sentOnDay({ day: '2027-03-09', count: 4 }, t), 4);
  assert.equal(sentOnDay({ day: '2027-03-08', count: 4 }, t), 0, 'yesterday’s count doesn’t carry over');
  assert.equal(dailyLimitReached({ day: '2027-03-09', count: 4 }, { dailyLimit: 4 }, t), true);
  assert.equal(dailyLimitReached({ day: '2027-03-09', count: 4 }, { dailyLimit: 0 }, t), false, '0 means no limit');
});
