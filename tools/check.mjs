// Static checks for the extension package. Usage: node tools/check.mjs
//  - manifest.json parses and follows Manifest V3 rules used here
//  - every file referenced by the manifest and sidepanel.html exists
//  - every JavaScript file passes a syntax check
//  - no remote code (http/https script or stylesheet URLs, eval, new Function)
//  - every <button> in sidepanel.html is wired up in sidepanel.js

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const passed = [];
const check = (ok, message) => (ok ? passed : problems).push(message);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Manifest ------------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(read('manifest.json'));
  check(true, 'manifest.json is valid JSON');
} catch (err) {
  console.error(`manifest.json: ${err.message}`);
  process.exit(1);
}

check(manifest.manifest_version === 3, 'manifest_version is 3');
check(typeof manifest.background?.service_worker === 'string', 'background uses a service worker');
check(manifest.background?.type === 'module', 'service worker is an ES module');
check(!('browser_action' in manifest) && !('page_action' in manifest), 'no MV2 browser_action/page_action');
check(!manifest.background?.scripts && !manifest.background?.page, 'no MV2 background pages');
check(
  !manifest.content_security_policy || typeof manifest.content_security_policy === 'object',
  'content_security_policy uses the MV3 object form (or the default)',
);
const hosts = manifest.host_permissions ?? [];
// Google Voice, Google Sheets' CSV export (docs.google.com redirects to a
// signed *.googleusercontent.com download link) and the optional AI providers.
const AI_HOSTS = ['https://generativelanguage.googleapis.com', 'https://api.groq.com', 'https://openrouter.ai'];
const expectedHosts = [
  'https://voice.google.com/*',
  'https://docs.google.com/*',
  'https://*.googleusercontent.com/*',
  ...AI_HOSTS.map((h) => `${h}/*`),
];
check(
  hosts.length === expectedHosts.length && expectedHosts.every((h) => hosts.includes(h)),
  `host access limited to ${expectedHosts.join(', ')}`,
);
const perms = new Set(manifest.permissions ?? []);
const expectedPerms = ['sidePanel', 'storage', 'alarms', 'scripting', 'notifications', 'debugger'];
check(
  perms.size === expectedPerms.length && expectedPerms.every((p) => perms.has(p)),
  `permissions are exactly ${expectedPerms.join(', ')}`,
);
for (const cs of manifest.content_scripts ?? []) {
  check(cs.matches.every((m) => m.startsWith('https://voice.google.com/')), 'content scripts only match Google Voice');
}

const referenced = new Set([
  manifest.background.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
]);

// Side panel HTML -------------------------------------------------------------
const html = read('sidepanel.html');
for (const m of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
  const url = m[1];
  if (/^https?:/i.test(url)) problems.push(`sidepanel.html loads a remote resource: ${url}`);
  else referenced.add(url);
}
check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'sidepanel.html has no inline scripts');
check(!/\son[a-z]+="/i.test(html), 'sidepanel.html has no inline event handlers');

// Module imports ----------------------------------------------------------------
const jsFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(m?js)$/.test(name)) jsFiles.push(relative(ROOT, full).replaceAll('\\', '/'));
  }
})(ROOT);

const shipped = jsFiles.filter((f) => !f.startsWith('tests/') && !f.startsWith('tools/'));
for (const f of shipped) {
  const src = read(f);
  for (const m of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    referenced.add(join(dirname(f), m[1]).replaceAll('\\', '/'));
  }
  if (/\beval\s*\(|new Function\s*\(/.test(src)) problems.push(`${f} uses eval/new Function`);
  if (/import\s*\(\s*['"]https?:/.test(src) || /['"]https?:\/\/[^'"]+\.js['"]/.test(src)) {
    problems.push(`${f} references remote JavaScript`);
  }
  if (/XMLHttpRequest|navigator\.sendBeacon|new WebSocket/.test(src)) {
    problems.push(`${f} makes network requests`);
  }
  // The allowed requests: lib/sheets.js downloading a Google Sheet as CSV, and
  // lib/ai.js asking the user's chosen AI provider for message versions.
  if (/fetch\s*\(|fetchImpl\s*\(/.test(src) && f !== 'lib/sheets.js' && f !== 'lib/ai.js') {
    problems.push(`${f} makes network requests (only lib/sheets.js and lib/ai.js may)`);
  }
}
const sheetsSrc = read('lib/sheets.js');
const sheetUrls = [...sheetsSrc.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
check(
  sheetUrls.length > 0 && sheetUrls.every((u) => u === 'https://docs.google.com'),
  'lib/sheets.js only builds docs.google.com URLs',
);
const aiSrc = read('lib/ai.js');
// Every URL in lib/ai.js is an API host, except the "get a free key" links shown in Settings.
const aiRequestUrls = aiSrc
  .split('\n')
  .filter((line) => !/^\s*keyUrl:|^\s*\/\//.test(line))
  .flatMap((line) => [...line.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]));
check(
  aiRequestUrls.length >= 2 && aiRequestUrls.every((u) => AI_HOSTS.includes(u)),
  `lib/ai.js only sends requests to ${AI_HOSTS.join(', ')}`,
);
check(!problems.some((p) => /eval|remote|network/.test(p)), 'no remote code or eval; only lib/sheets.js and lib/ai.js make network requests');

for (const ref of referenced) {
  if (!ref) continue;
  check(existsSync(join(ROOT, ref)), `referenced file exists: ${ref}`);
}

// Syntax ----------------------------------------------------------------------
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`syntax error in ${f}:\n${err.stderr?.toString().trim()}`);
  }
}
check(true, `syntax-checked ${jsFiles.length} JavaScript files`);

// Buttons are wired -------------------------------------------------------------
const panelJs = read('sidepanel.js');
const buttons = [...html.matchAll(/<button([^>]*)>/g)].map((m) => ({
  id: /\bid="([^"]+)"/.exec(m[1])?.[1],
  submit: /\btype="submit"/.test(m[1]),
}));
const dialogButtons = new Set(['confirmCancel', 'confirmOk', 'confirmAlt']); // submit the <dialog> form natively
for (const { id, submit } of buttons) {
  if (!id || dialogButtons.has(id)) continue;
  if (submit) {
    check(/ui\.settingsForm\.addEventListener\('submit'/.test(panelJs), `submit button #${id} is handled by its form`);
    continue;
  }
  const prop = new RegExp(`(\\w+): \\$\\('${id}'\\)`).exec(panelJs)?.[1];
  const wired = prop && new RegExp(`ui\\.${prop}\\.addEventListener\\('click'`).test(panelJs);
  check(Boolean(wired), `button #${id} has a click handler`);
}
check(/ui\.filterBar\.addEventListener\('click'/.test(panelJs), 'filter buttons are handled (delegated)');
check(/ui\.contactList\.addEventListener\('click'/.test(panelJs), 'per-contact retry buttons are handled (delegated)');
check(/ui\.settingsForm\.addEventListener\('submit'/.test(panelJs), 'settings form submit is handled');

// UI code stays out of the service worker -------------------------------------
const bg = read('background.js');
check(!/\bdocument\.|\bwindow\./.test(bg), 'background.js has no DOM access');

// Report ----------------------------------------------------------------------
for (const p of passed) console.log(`  ok   ${p}`);
for (const p of problems) console.log(`  FAIL ${p}`);
console.log(`\n${passed.length} passed, ${problems.length} failed`);
process.exit(problems.length ? 1 : 0);
