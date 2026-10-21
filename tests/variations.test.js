// AI message versions: the checks every version must pass, reading model
// replies, the provider requests (with a fake network) and how versions are
// handed out to contacts.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateVersion, cleanVersion, parseVersionsReply, applyVersions, sanitizeVersions, buildPrompt } from '../lib/variations.js';
import { generateVersions, askModel, normalizeAiConfig } from '../lib/ai.js';
import { parseContacts } from '../lib/parser.js';
import { buildItems } from '../lib/queue-model.js';
import { createChromeEnv, createFakeContent, loadBackground } from './helpers/chrome-mock.js';
import { PANEL } from '../lib/protocol.js';

const ORIGINAL = 'Hi {{First Name|there}}, your appointment is on {{Date}} at 3:30 pm. Details: https://example.com/a?b=1. Reply STOP to opt out.';
const GOOD = [
  'Hello {{First Name|there}}! We have you booked for {{Date}} at 3:30 pm. More at https://example.com/a?b=1. Reply STOP to opt out.',
  '{{First Name|there}}, a reminder that your appointment is {{Date}}, 3:30 pm. See https://example.com/a?b=1 for details. Reply STOP to opt out.',
  'Hey {{First Name|there}}, see you {{Date}} at 3:30 pm for your appointment (details: https://example.com/a?b=1). Text STOP to opt out.',
];

test('a version must keep placeholders, links, numbers and opt-out wording', () => {
  for (const v of GOOD) assert.deepEqual(validateVersion(ORIGINAL, v), { ok: true }, v);
  const bad = {
    'placeholders changed': 'Hello {{Name}}, booked for {{Date}} at 3:30 pm. https://example.com/a?b=1 Reply STOP to opt out.',
    'placeholder fallback dropped': 'Hello {{First Name}}, booked for {{Date}} at 3:30 pm. https://example.com/a?b=1 Reply STOP to opt out.',
    'link changed': 'Hello {{First Name|there}}, booked for {{Date}} at 3:30 pm. https://example.com/a Reply STOP to opt out.',
    'time changed': 'Hello {{First Name|there}}, booked for {{Date}} at 4:30 pm. https://example.com/a?b=1 Reply STOP to opt out.',
    'opt-out dropped': 'Hello {{First Name|there}}, booked for {{Date}} at 3:30 pm. Details: https://example.com/a?b=1. Reply stop to leave.',
    'broken placeholder': 'Hello {First Name|there}}, booked {{Date}} at 3:30 pm. https://example.com/a?b=1 Reply STOP to opt out.',
    'same as the original': ORIGINAL.replace('Hi', 'hi').replace('.', '!'),
    'far too long': `${GOOD[0]} ${'Extra words that were never asked for. '.repeat(10)}`,
  };
  for (const [why, v] of Object.entries(bad)) assert.equal(validateVersion(ORIGINAL, v).ok, false, why);
});

test('model replies are tidied and read even when they aren’t clean JSON', () => {
  assert.equal(cleanVersion('1. "Hello there"'), 'Hello there');
  assert.equal(cleanVersion('- Hi {{First Name}}'), 'Hi {{First Name}}');
  assert.deepEqual(parseVersionsReply('{"versions":["a","b"]}'), ['a', 'b']);
  assert.deepEqual(parseVersionsReply('```json\n{"versions": ["a"]}\n```'), ['a']);
  assert.deepEqual(parseVersionsReply('Sure! Here they are: ["x", "y"] Hope that helps.'), ['x', 'y']);
  assert.deepEqual(parseVersionsReply('{"messages":["m1"]}'), ['m1']);
  assert.deepEqual(parseVersionsReply('no json here'), []);
  const { system, user } = buildPrompt(ORIGINAL, 5, ['Hello there friend']);
  assert.match(system, /placeholder/);
  assert.match(user, /Write 5 different versions/);
  assert.match(user, /Hello there friend/);
  assert.ok(!/\d{3}.\d{3}.\d{4}/.test(system + user), 'no phone numbers in the prompt');
});

test('versions are handed out to contacts that will be sent first, and filled in per contact', () => {
  const csv = 'Phone,First Name,Date\n2125550147,Sam,Tue\n6465550123,,Wed\n4155550188,Jo,Thu\n2125550147,Dup,Fri';
  const parsed = parseContacts(csv, { template: ORIGINAL });
  const texted = new Map([['+12125550147', { at: 1, confirmed: true }]]);
  const items = buildItems(parsed, 'skip', { texted });
  const applied = applyVersions(items, parsed.rows, { [ORIGINAL]: GOOD.slice(0, 2) });
  assert.equal(applied, 4);
  assert.equal(items[1].message, GOOD[0].replace('{{First Name|there}}', 'there').replace('{{Date}}', 'Wed'), 'pending row 3 gets version 1');
  assert.equal(items[2].message, GOOD[1].replace('{{First Name|there}}', 'Jo').replace('{{Date}}', 'Thu'), 'pending row 4 gets version 2');
  assert.deepEqual(items.map((i) => i.version), [1, 1, 2, 2], 'skipped rows come after the pending ones');
  assert.equal(items[1].messageLength, items[1].message.length);
  // Bad versions are dropped by the background before use.
  assert.deepEqual(sanitizeVersions({ [ORIGINAL]: [GOOD[0], 'Hi {{Name}}', GOOD[0]] }), { [ORIGINAL]: [GOOD[0]] });
});

// ---------------------------------------------------------------------------
// Providers, through a fake fetch

function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = replies.shift();
    if (r.status && r.status !== 200) {
      return { ok: false, status: r.status, headers: { get: () => r.retryAfter ?? null }, text: async () => r.body ?? '' };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => r.json };
  };
  fn.calls = calls;
  return fn;
}
const geminiReply = (list) => ({ json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ versions: list }) }] } }] } });
const chatReply = (list) => ({ json: { choices: [{ message: { content: JSON.stringify({ versions: list }) } }] } });
const noSleep = async () => {};

test('Gemini: the key goes in a header, only the message is sent, and bad versions are thrown away', async () => {
  const config = normalizeAiConfig({ provider: 'gemini', apiKey: 'AIza-test-key' });
  const fetchImpl = fakeFetch([geminiReply([GOOD[0], 'Hi {{Name}} wrong', GOOD[1], GOOD[0]])]);
  const progress = [];
  const r = await generateVersions(config, ORIGINAL, 2, { fetchImpl, sleep: noSleep, onProgress: (d) => progress.push(d) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions, [GOOD[0], GOOD[1]]);
  assert.equal(r.rejected, 1);
  assert.deepEqual(progress, [2]);
  const call = fetchImpl.calls[0];
  assert.match(call.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(call.init.headers['x-goog-api-key'], 'AIza-test-key');
  assert.ok(!call.url.includes('AIza'), 'the key is not in the URL');
  assert.equal(call.init.credentials, 'omit');
  assert.ok(JSON.stringify(call.body).includes('{{First Name|there}}'));
});

test('Groq and OpenRouter use the OpenAI-style API with a bearer key', async () => {
  for (const [provider, host, model] of [
    ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'llama-3.1-8b-instant'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'openrouter/free'],
  ]) {
    const fetchImpl = fakeFetch([chatReply(GOOD)]);
    const r = await generateVersions(normalizeAiConfig({ provider, apiKey: 'k1' }), ORIGINAL, 3, { fetchImpl, sleep: noSleep });
    assert.equal(r.versions.length, 3, provider);
    assert.equal(fetchImpl.calls[0].url, host);
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer k1');
    assert.equal(fetchImpl.calls[0].body.model, model);
  }
});

test('more versions than one request gives are fetched in batches, with a pause between requests', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `Hello {{First Name|there}} (${i}), your appointment is on {{Date}} at 3:30 pm. Details: https://example.com/a?b=1. Reply STOP to opt out.`);
  // Each version adds a new number, which the checks allow (only the original's numbers must stay).
  const fetchImpl = fakeFetch([geminiReply(many.slice(0, 15)), geminiReply(many.slice(15))]);
  const sleeps = [];
  const r = await generateVersions(normalizeAiConfig({ apiKey: 'k' }), ORIGINAL, 20, { fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(r.versions.length, 20);
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(sleeps, [6500], 'stays under the free tier’s requests per minute');
  assert.match(fetchImpl.calls[1].body.contents[0].parts[0].text, /already used/);
});

test('rate limits are waited out; a rejected key or missing model is explained', async () => {
  const config = normalizeAiConfig({ provider: 'groq', apiKey: 'k' });
  const slept = [];
  const retry = await askModel(config, 's', 'u', {
    fetchImpl: fakeFetch([{ status: 429, retryAfter: '3' }, chatReply(['ok'])]),
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(slept, [3000], 'honours Retry-After');

  const daily = await askModel(config, 's', 'u', { fetchImpl: fakeFetch([{ status: 429, body: 'Rate limit reached: requests per day' }]), sleep: noSleep });
  assert.match(daily.error, /free limit is used up/);

  const badKey = await generateVersions(config, ORIGINAL, 3, { fetchImpl: fakeFetch([{ status: 401, body: 'invalid_api_key' }]), sleep: noSleep });
  assert.equal(badKey.ok, false);
  assert.match(badKey.error, /didn’t accept the API key/);

  const noModel = await askModel(normalizeAiConfig({ provider: 'gemini', apiKey: 'k', model: 'gemini-9' }), 's', 'u', {
    fetchImpl: fakeFetch([{ status: 404, body: 'models/gemini-9 is not found' }]),
    sleep: noSleep,
  });
  assert.match(noModel.error, /doesn’t offer the model “gemini-9”/);

  const offline = await askModel(config, 's', 'u', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.match(offline.error, /Couldn’t reach Groq/);

  const noKey = await askModel(normalizeAiConfig({}), 's', 'u');
  assert.match(noKey.error, /Add your API key/);
});

test('when the model keeps breaking the rules, nothing is used and the user is told', async () => {
  const fetchImpl = fakeFetch(Array.from({ length: 5 }, () => geminiReply(['Hi {{Name}}'])));
  const r = await generateVersions(normalizeAiConfig({ apiKey: 'k' }), ORIGINAL, 5, { fetchImpl, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.match(r.error, /didn’t write any versions that kept your placeholders/);
  assert.equal(fetchImpl.calls.length, 3, 'gives up after a few tries');
});

// ---------------------------------------------------------------------------
// Background: versions on import

const realNow = Date.now;
beforeEach(() => {
  Date.now = () => new Date(2027, 0, 15, 10).getTime();
});
afterEach(() => {
  Date.now = realNow;
});

test('import: each contact gets its own checked version, which is exactly what is sent', async () => {
  const env = createChromeEnv();
  env.tabs.set(7, { id: 7, url: 'https://voice.google.com/u/0/messages', active: true, windowId: 1 });
  const fc = createFakeContent(env, 7);
  await loadBackground(env);
  await env.panel(PANEL.SETTINGS_SAVE, { delaySec: 60, maxConsecutiveFailures: 3, windowOn: 0 });
  const text = 'Phone,First Name,Date\n2125550147,Sam,Tue\n6465550123,Alex,Wed';
  const r = await env.panel(PANEL.QUEUE_IMPORT, {
    text,
    messageMode: 'template',
    template: ORIGINAL,
    versions: { [ORIGINAL]: ['Hi {{Name}} (bad)', GOOD[0], GOOD[1]] },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary.versioned, 2);
  const items = env.state().items;
  assert.equal(items[0].message, GOOD[0].replace('{{First Name|there}}', 'Sam').replace('{{Date}}', 'Tue'));
  assert.equal(items[1].message, GOOD[1].replace('{{First Name|there}}', 'Alex').replace('{{Date}}', 'Wed'));
  assert.notEqual(items[0].message, items[1].message);
  assert.match(env.state().log.at(-1).text, /AI versions for 2/);
  await env.panel(PANEL.QUEUE_START);
  assert.equal(fc.job.message, items[0].message, 'the content script gets the version');

  const bad = await env.panel(PANEL.QUEUE_IMPORT, { text, versions: { a: 'not a list' } });
  assert.match(bad.error, /Invalid field "versions"/);
});
