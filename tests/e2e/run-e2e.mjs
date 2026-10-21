// End-to-end test: loads the unpacked extension in Chromium, serves
// tests/e2e/mock-voice.html at https://voice.google.com/ and drives the side
// panel through a full run. Takes about 6 minutes (the 45 s minimum delay
// between messages is real).
//
// This verifies the extension's own logic against a MOCK of Google Voice. It
// does not prove the selectors match the live site; see README "Testing".
//
// Requirements (not shipped with the extension):
//   npm i --no-save playwright-core     (or set PLAYWRIGHT_CORE=/path/to/playwright-core)
//   a Chromium build: CHROMIUM_PATH=/path/to/chrome (Playwright's Chromium works;
//   branded Google Chrome no longer allows --load-extension)
// Optional: SCREENSHOT_DIR=/some/folder, HEADLESS=0 to watch it run.

import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK = readFileSync(join(ROOT, 'tests', 'e2e', 'mock-voice.html'), 'utf8');
const GV_URL = 'https://voice.google.com/u/0/messages';
const SHEET_ID = '1E2eSheetForGvSheetHelperTests0000000000';
// (212) 555-0147 is texted during the run; (303) 555-0142 is new. Dana's
// message is long on purpose: typing it character by character would take
// well over the time allowed for preparing a message.
const LONG = `Hi Dana, welcome! ${'This is a long message to check that long texts still go out in one piece. '.repeat(20)}`.trim();
const SHEET_CSV = `Phone,First Name,Message\r\n2125550147,Sam,Hi Sam\r\n(303) 555-0142,Dana,"${LONG}"\r\n`;
let sheetCsv = SHEET_CSV; // the sheet can "grow" during the run
const SHOTS = process.env.SCREENSHOT_DIR || null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const pw = await import(
  process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, 'index.mjs')).href : 'playwright-core'
);
const { chromium } = pw.default ?? pw;

const results = [];
const t0 = Date.now();
const stamp = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'gvsh-e2e-')), {
  executablePath: process.env.CHROMIUM_PATH,
  headless: process.env.HEADLESS !== '0',
  args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
});

const pageErrors = [];
try {
  await context.route('https://voice.google.com/**', (route) =>
    route.request().resourceType() === 'document'
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: MOCK })
      : route.fulfill({ status: 204 }),
  );
  // Google Sheets CSV export. The real one redirects to a signed
  // googleusercontent.com download; Playwright doesn't intercept the second
  // hop of a fulfilled redirect, so the mock answers directly. (The real
  // redirect is covered by loading Google's public sample sheet by hand.)
  await context.route('https://docs.google.com/spreadsheets/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/csv; charset=utf-8',
      headers: { 'access-control-allow-origin': '*', 'content-disposition': 'attachment; filename="Daily leads - Sheet1.csv"' },
      body: sheetCsv,
    }),
  );

  // Google's Gemini API, mocked: writes the number of versions asked for. Every
  // request body is kept to check that no contact data is sent.
  const aiRequests = [];
  await context.route('https://generativelanguage.googleapis.com/**', (route) => {
    const body = route.request().postData() || '';
    aiRequests.push({ url: route.request().url(), headers: route.request().headers(), body });
    const prompt = JSON.parse(body).contents[0].parts[0].text;
    const n = Number(/Write (\d+) different versions/.exec(prompt)?.[1] ?? 3);
    const message = /"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? '';
    const versions = Array.from({ length: n }, (_, i) => `Quick note ${i + 1}: ${message}`);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ versions }) }] } }] }),
    });
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('extension loads and its service worker starts', Boolean(extId), extId);

  const gv = await context.newPage();
  await gv.goto(GV_URL);

  const openPanel = async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 380, height: 1100 });
    p.on('pageerror', (e) => pageErrors.push(`panel: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && pageErrors.push(`panel console: ${m.text()}`));
    await p.goto(`chrome-extension://${extId}/sidepanel.html`);
    return p;
  };
  let panel = await openPanel();
  const text = (sel) => panel.locator(sel).first().innerText();
  const waitText = (sel, re, timeout = 30_000) =>
    panel.waitForFunction(
      ([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent ?? ''),
      [sel, re.source],
      { timeout },
    );

  // 1. Connection status ----------------------------------------------------
  await panel.waitForSelector('#connButton[data-state="ready"]', { timeout: 30_000 });
  check('header shows Google Voice connected', (await text('#connText')) === 'Connected');
  await shot(panel, '01-empty');

  // 2. Settings validation ----------------------------------------------------
  await panel.click('[role="tab"][data-tab="settings"]');
  await panel.fill('#delayInput', '30');
  await panel.click('#btnSaveSettings');
  check('delay below 45 s is rejected', /45 to 3600/.test(await text('#delayError')));
  await panel.fill('#delayInput', '45');
  await panel.click('#btnSaveSettings');
  await waitText('#settingsSaved', /Saved/);
  check('delay of 45 s is saved', true);
  // Sending hours are on by default; turn them off so the run doesn't depend on the time of day.
  await panel.uncheck('#windowOnInput');
  await panel.fill('#dailyInput', '500');
  await panel.waitForFunction(async () => {
    const { 'gvsh.settings': s } = await chrome.storage.local.get('gvsh.settings');
    return s?.dailyLimit === 500 && s?.windowOn === 0;
  }, null, { timeout: 10_000 });
  check('settings save by themselves without pressing Save', true);
  check('the time fields are disabled while sending hours are off', await panel.isDisabled('#windowStartInput'));
  await panel.fill('#dailyInput', '0');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('gvsh.settings'))['gvsh.settings']?.dailyLimit === 0);
  await panel.click('[role="tab"][data-tab="send"]');

  // 3. Upload a CSV file ---------------------------------------------------------
  check('upload is the default way to add contacts', await panel.isVisible('#dropzone'));
  await panel.setInputFiles('#fileInput', { name: 'contacts.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK') });
  await waitText('#importError', /Save As . CSV/);
  check('an Excel file is rejected with how-to-export guidance', true);

  // Legacy Excel CSV export in Windows-1252 ("Jos\xe9")
  await panel.check('input[name="messageMode"][value="template"]');
  await panel.fill('#templateText', 'Hi {{First Name}}');
  await panel.setInputFiles('#fileInput', {
    name: 'legacy.csv',
    mimeType: 'text/csv',
    buffer: Buffer.concat([Buffer.from('Phone,First Name\r\n2125550147,Jos'), Buffer.from([0xe9]), Buffer.from('\r\n')]),
  });
  await waitText('#previewText', /Hi Jos/);
  check('Windows-1252 CSV exports decode correctly', (await text('#previewText')) === 'Hi José', await text('#previewText'));
  await panel.click('#btnFileRemove');
  check('removing the file brings back the drop zone', await panel.isVisible('#dropzone'));

  // 4. Same message for everyone, with variables ------------------------------------
  check('template field appears in "Same for everyone" mode', await panel.isVisible('#templateText'));
  const csv = [
    'Phone,First Name,City',
    '(212) 555-0147,Sam,Boston',
    '646-555-0199,Alex,Denver',
    '415.555.0198,,Austin',
    '212-555-0147,Sam again,Boston',
    '123,Bad,Nowhere',
    '718-555-0197,Ri,Reno',
  ].join('\r\n');
  await panel.setInputFiles('#fileInput', { name: 'march-reminders.csv', mimeType: 'text/csv', buffer: Buffer.from(`﻿${csv}`, 'utf8') });
  await panel.waitForSelector('#fileCard:not([hidden])');
  const fileMeta = await text('#fileMeta');
  check('file card shows name, rows and columns', (await text('#fileName')) === 'march-reminders.csv' && /6 rows/.test(fileMeta) && /Phone, First Name, City/.test(fileMeta), fileMeta);
  await panel.waitForFunction(() => document.querySelectorAll('#variableChips .var-chip').length >= 3);
  const chips = await panel.locator('#variableChips .var-chip').allInnerTexts();
  check('variable chips come from the header row', ['{{Phone}}', '{{First Name}}', '{{City}}'].every((c) => chips.includes(c)), chips.join(' '));

  await panel.fill('#templateText', 'Hi ');
  await panel.click('#variableChips .var-chip:has-text("{{First Name}}")');
  check('clicking a chip inserts the variable', (await panel.inputValue('#templateText')) === 'Hi {{First Name}}');

  await panel.fill('#templateText', 'Hi {{Frist Name}}');
  await waitText('#previewText', /isn.t a column/);
  check('typo in a variable is caught in the live preview', true, await text('#previewText'));

  const TEMPLATE = 'Hi {{First Name|there}},\nSee you in {{city}} tomorrow.';
  await panel.fill('#templateText', TEMPLATE);
  await waitText('#previewText', /See you in Boston/);
  check('live preview renders the first row', (await text('#previewText')) === 'Hi Sam,\nSee you in Boston tomorrow.');
  check('preview counts ready and invalid rows', /4 ready . 1 to fix/.test(await text('#previewMeta')), await text('#previewMeta'));
  await shot(panel, '02-compose');

  // 5. Validate & preview --------------------------------------------------------
  await panel.click('#btnImport');
  await panel.waitForSelector('#contactsCard:not([hidden])');
  await panel.click('.filter[data-filter="all"]');
  const badges = await panel.locator('#contactList .badge').allInnerTexts();
  check('preview lists every row with its status', badges.join(',') === 'Pending,Pending,Pending,Duplicate,Needs fixing,Pending', badges.join(','));
  await panel.click('#contactList [data-expand]');
  const expanded = await panel.locator('#contactList .contact-msg.is-expanded').first().innerText();
  check('a contact expands to its exact final message', expanded === 'Hi Sam,\nSee you in Boston tomorrow.');
  await shot(panel, '03-preview');

  // 6. Start ---------------------------------------------------------------------
  await panel.click('#btnStart');
  await panel.waitForSelector('#confirmDialog[open]');
  check('start asks for confirmation (consent reminder)', /agreed to receive/.test(await text('#confirmBody')));
  await shot(panel, '04-confirm');
  await panel.click('#confirmOk');
  await waitText('#runStateTag', /Running/);
  check('queue starts', true);

  await waitText('#statSent', /^1$/, 90_000);
  check('first message accepted', true);
  await shot(panel, '05-running');

  // 7. Pause / resume while waiting -------------------------------------------------
  await panel.click('#btnPause');
  await waitText('#runStateTag', /Paused/);
  await sleep(3000);
  check('paused queue sends nothing', (await gv.evaluate(() => window.__gv.sent.length)) === 1);
  await panel.click('#btnResume');
  await waitText('#runStateTag', /Running/);
  check('resume continues the queue', true);

  // 8. Reopen the panel mid-run ---------------------------------------------------------
  await panel.close();
  panel = await openPanel();
  await waitText('#runStateTag', /Running/);
  check('state survives closing and reopening the panel', (await panel.locator('#contactList .contact').count()) > 0);
  check('the message being written survives closing the panel', (await panel.inputValue('#templateText')) === TEMPLATE);
  check('the queue shows how long is left', /left/.test(await text('#etaLine')), await text('#etaLine'));

  // 9. Run to the end (3 failures in a row stop the queue) --------------------------------
  await waitText('#runStateTag', /Stopped/, 360_000);
  const sent = await gv.evaluate(() => window.__gv);
  const to = (d) => sent.sent.filter((s) => s.to === d);
  check('message 1 sent once with variables filled in', to('2125550147').length === 1 && to('2125550147')[0].text === 'Hi Sam,\nSee you in Boston tomorrow.');
  check('empty First Name used the fallback', to('4155550198')[0]?.text === 'Hi there,\nSee you in Austin tomorrow.');
  check('"Not sent" contact was not retried automatically', to('6465550199').length === 1);
  check('stuck "Sending" contact was not retried automatically', to('4155550198').length === 1);
  check('rejected number never reached Send', to('7185550197').length === 0);
  check('duplicate and invalid rows were not sent', sent.sent.length === 3, `${sent.sent.length} sends`);
  check('Send clicked exactly once per message', sent.sendClicks === 3, `${sent.sendClicks} clicks`);
  check('Enter was never pressed in the message box', sent.enterPressed === 0);
  const gap = sent.sent[1].at - sent.sent[0].at;
  check('at least 45 s between sends', gap >= 44_000, `${Math.round(gap / 1000)} s`);
  check('stats: 1 sent, 3 failed, 0 remaining',
    (await text('#statSent')) === '1' && (await text('#statFailed')) === '3' && (await text('#statRemaining')) === '0');
  check('stop reason explains the failure limit', /too many failures/i.test(await text('#runStatus')), await text('#runStatus'));
  const finalBadges = await panel.locator('#contactList .badge').allInnerTexts();
  check('outcomes are distinguished (sent / failed / unconfirmed)', finalBadges.join(',') === 'Sent,Failed,Unconfirmed,Duplicate,Needs fixing,Failed', finalBadges.join(','));
  await shot(panel, '06-stopped');

  // 10. Retry rules -------------------------------------------------------------------------
  await panel.click('#btnRetryFailed');
  await waitText('#runAlert', /queued to retry/);
  check('"Retry failed" only re-queues contacts that were never sent', /1 contact queued to retry\. 2 other messages may already have been sent/.test(await text('#runAlert')), await text('#runAlert'));
  await panel.click('#contactList button:has-text("Retry after checking")');
  await panel.waitForSelector('#confirmDialog[open]');
  check('retrying an unconfirmed message warns about duplicates', /could send it twice/.test(await text('#confirmBody')));
  await panel.click('#confirmCancel');

  // 11. Google Voice closed ----------------------------------------------------------------------
  await gv.close();
  await panel.waitForSelector('#connButton[data-state="not_open"]', { timeout: 30_000 });
  check('header shows Google Voice is not open', (await text('#connText')) === 'Open Google Voice');
  await panel.click('#btnStart');
  await panel.click('#confirmOk');
  await waitText('#runAlert', /open/i);
  check('start explains that Google Voice is not open', /isn.t open/.test(await text('#runAlert')), await text('#runAlert'));

  // 11b. Add rows to a queue that is under way -------------------------------------------------------
  await panel.click('#importCard > summary');
  await panel.check('input[name="source"][value="paste"]');
  await panel.fill('#importText', 'Phone,First Name,City\n(212) 555-0147,Sam,Boston\n(505) 555-0111,Lee,Taos');
  await waitText('#previewMeta', /1 new . 1 already in the queue/);
  check('preview counts only numbers that are new to the queue', true, await text('#previewMeta'));
  await panel.click('#btnImport');
  await panel.waitForSelector('#confirmDialog[open]');
  check('importing into a started queue offers Add or Replace', /Add the new contacts/.test(await text('#confirmTitle')) && (await panel.isVisible('#confirmAlt')));
  await panel.click('#confirmOk');
  await waitText('#runAlert', /Added 1 new contact/);
  check('Add to queue adds only the new number', /Skipped: 1 already in the queue/.test(await text('#runAlert')), await text('#runAlert'));

  // 12. Clear --------------------------------------------------------------------------------------
  await panel.click('#btnClear');
  await panel.waitForSelector('#confirmDialog[open]');
  await panel.click('#confirmOk');
  await panel.waitForSelector('#contactsCard[hidden]', { state: 'attached' });
  const stored = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  check('clearing removes numbers, messages and the template from storage',
    !stored.includes('2125550147') && !stored.includes('See you in') && !stored.includes('{{city}}'));

  // 13. Column mode with variables in message cells ----------------------------------------------------
  await panel.check('input[name="messageMode"][value="column"]');
  await panel.check('input[name="source"][value="paste"]');
  check('paste mode shows the text box', await panel.isVisible('#importText'));
  await panel.fill('#importText', 'Phone,Name,Message\n2125550147,Sam Rivera,"Hi {{First Name}}, your order shipped, thanks!"');
  await waitText('#previewText', /Hi Sam, your order shipped, thanks!/);
  await panel.click('#btnImport');
  await panel.waitForSelector('#contactsCard:not([hidden])');
  await panel.click('.filter[data-filter="all"]');
  check('column mode: quoted commas and variables in cells', (await panel.locator('#contactList .contact-msg').first().innerText()) === 'Hi Sam, your order shipped, thanks!');

  // 14. Sent history: the number texted in step 9 is never texted again ----------------------------
  check('a number texted earlier is skipped on the next import',
    (await panel.locator('#contactList .badge').first().innerText()) === 'Texted before' && /Nothing new to send/.test(await text('#runStatus')),
    await text('#runStatus'));
  check('history stores no readable numbers',
    !JSON.stringify(await sw.evaluate(() => chrome.storage.local.get('gvsh.history'))).includes('2125550147'));

  // 15. Load contacts straight from a Google Sheet link ------------------------------------------------
  await panel.click('#importCard > summary');
  await panel.check('input[name="source"][value="sheet"]');
  await panel.fill('#sheetUrl', `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`);
  await panel.click('#btnSheetLoad');
  await waitText('#sheetName', /Daily leads/);
  check('a Google Sheet link loads the sheet by name (export redirect followed)', (await text('#sheetName')) === 'Daily leads - Sheet1');
  await waitText('#previewMeta', /1 ready . 1 texted before/);
  check('preview counts only new numbers and shows the first new message', (await text('#previewText')) === LONG, (await text('#previewText')).slice(0, 40));
  await shot(panel, '09-sheet');
  await panel.click('#btnImport');
  await waitText('#runStatus', /1 new contact ready/);
  await panel.click('.filter[data-filter="all"]');
  const sheetBadges = await panel.locator('#contactList .badge').allInnerTexts();
  check('sheet import: texted-before row skipped, new row pending', sheetBadges.join(',') === 'Texted before,Pending', sheetBadges.join(','));
  const sheetMeta = () => panel.textContent('#sheetMeta'); // inside the Import card, which is collapsed after an import
  check('the sheet link is kept; its rows are dropped from the panel after import', /Imported/.test(await sheetMeta()), await sheetMeta());
  await shot(panel, '10-sheet-imported');

  await panel.close();
  panel = await openPanel();
  await waitText('#sheetMeta', /loaded/);
  check('the linked sheet reloads by itself when the panel opens', /2 rows/.test(await sheetMeta()), await sheetMeta());

  // 16. A long message, and a sheet that grows while the queue runs ------------------------------------
  const gv2 = await context.newPage();
  await gv2.goto(GV_URL);
  await panel.waitForSelector('#connButton[data-state="ready"]', { timeout: 30_000 });
  await panel.click('#btnStart');
  await panel.click('#confirmOk');
  await waitText('#runStateTag', /Running/);
  sheetCsv = `${SHEET_CSV}(720) 555-0133,Kim,Hi Kim\r\n`;
  await panel.click('#importCard > summary').catch(() => {});
  await panel.check('input[name="source"][value="sheet"]');
  await panel.click('#btnSheetReload');
  await waitText('#sheetMeta', /3 rows/);
  await panel.click('#btnImport');
  await panel.waitForSelector('#confirmDialog[open]');
  check('while running, importing only offers to add (no replace)', !(await panel.isVisible('#confirmAlt')));
  await panel.click('#confirmOk');
  await waitText('#runAlert', /Added 1 new contact/);
  check('a sheet that grew during the run adds just its new row, fetched fresh', /2 already in the queue/.test(await text('#runAlert')), await text('#runAlert'));
  const t1 = Date.now();
  await waitText('#statSent', /^1$/, 150_000);
  const sent2 = await gv2.evaluate(() => window.__gv.sent);
  check('a long message is sent in full, once', sent2.length === 1 && sent2[0].text === LONG, `${sent2[0]?.text.length} of ${LONG.length} chars`);
  check('long messages finish well inside the prepare window', Date.now() - t1 < 90_000, `${Math.round((Date.now() - t1) / 1000)} s`);
  await panel.click('#btnStop');
  await waitText('#runStateTag', /Stopped/);

  // 17. Optional AI versions: a different wording for each contact ------------------------------------
  await panel.click('[role="tab"][data-tab="settings"]');
  check('AI versions are off until a key is added', (await text('#aiState')) === 'No key');
  await panel.fill('#aiKey', 'AIza-e2e-test-key');
  await panel.click('#btnAiTest');
  await panel.waitForSelector('#aiSamples:not([hidden]) li', { timeout: 20_000 });
  check('Test writes 3 versions with the key', (await panel.locator('#aiSamples li').count()) === 3, await text('#aiSamples'));
  check('the key is sent in a header, not the URL', aiRequests[0]?.headers['x-goog-api-key'] === 'AIza-e2e-test-key' && !aiRequests[0].url.includes('AIza'));
  await panel.click('[role="tab"][data-tab="send"]');
  await panel.click('#importCard > summary').catch(() => {});
  await panel.check('input[name="messageMode"][value="template"]');
  await panel.check('#aiToggle');
  check('turning AI versions on explains when they are written', /Validate & preview/.test(await text('#aiToggleHint')));
  await panel.fill('#templateText', 'Hi {{First Name|there}}, see you in {{City}} tomorrow. Reply STOP to opt out.');
  await panel.check('input[name="source"][value="paste"]');
  await panel.fill('#importText', 'Phone,First Name,City\n(801) 555-0161,Robin,Provo\n(802) 555-0162,,Burlington\n(803) 555-0163,Casey,Columbia');
  await waitText('#previewMeta', /AI versions on/);
  const before = aiRequests.length;
  await panel.click('#btnImport');
  await panel.waitForSelector('#confirmDialog[open]');
  await panel.click('#confirmAlt'); // Replace queue
  await waitText('#runAlert', /AI versions written for 3 contacts/, 30_000);
  check('importing writes an AI version for each new contact', true, await text('#runAlert'));
  const sentToAi = aiRequests.slice(before).map((r) => r.body).join(' ');
  check('the AI request holds the message with placeholders only — no numbers or names',
    sentToAi.includes('{{First Name|there}}') && !/555|0161|Robin|Casey|Provo/.test(sentToAi));
  await panel.click('.filter[data-filter="all"]');
  const aiMessages = await panel.evaluate(async () => (await chrome.storage.local.get('gvsh.state'))['gvsh.state'].items.map((i) => i.message));
  check('every contact has its own wording, with its own name filled in',
    new Set(aiMessages).size === 3 && /^Quick note \d+: Hi Robin, see you in Provo/.test(aiMessages[0]) && /^Quick note \d+: Hi there, see you in Burlington/.test(aiMessages[1]),
    aiMessages.join(' | '));
  check('the contact list says which messages the AI wrote', /AI-written version/.test(await panel.textContent('#contactList')));
  await shot(panel, '11-ai-versions');
  await panel.click('#importCard > summary'); // the Import card closes after an import
  await panel.uncheck('#aiToggle');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await shot(panel, '07-dark');
  await panel.setViewportSize({ width: 320, height: 1100 });
  const overflow = await panel.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check('no horizontal scrolling at 320 px', !overflow);
  await shot(panel, '08-narrow');

  check('no errors in the side panel console', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('e2e run completed without exceptions', false, err.stack || String(err));
} finally {
  await context.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(failed.length ? 1 : 0);
