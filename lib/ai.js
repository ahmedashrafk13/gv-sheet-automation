// Asking an AI model for versions of a message (optional; off unless the
// user turns it on and adds their own API key).
//
// Providers with a free tier: Google Gemini, Groq and OpenRouter. Requests go
// straight from the side panel to the provider with the user's key; nothing
// else is sent. The request holds only the message with its {{placeholders}}
// (see lib/variations.js), never phone numbers or other contact data. This
// and lib/sheets.js are the only files that make network requests
// (tools/check.mjs enforces that).

import { buildPrompt, parseVersionsReply, cleanVersion, validateVersion, sameText } from './variations.js';

export const AI_KEY = 'gvsh.ai'; // chrome.storage.local: { enabled, provider, model, apiKey }

export const AI_PROVIDERS = Object.freeze({
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Free key from Google AI Studio (aistudio.google.com/apikey).',
    gapMs: 6500, // free tier: about 10 requests a minute
  },
  groq: {
    label: 'Groq',
    model: 'llama-3.1-8b-instant',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'Free key from console.groq.com/keys.',
    gapMs: 2500,
  },
  openrouter: {
    label: 'OpenRouter',
    model: 'openrouter/free',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'Free key from openrouter.ai/keys. "openrouter/free" picks a free model for each request.',
    gapMs: 3500,
  },
});

const BATCH = 15; // versions asked for per request
const MAX_ATTEMPTS = 4; // per request, when the provider is busy or rate-limiting
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export function normalizeAiConfig(raw) {
  const provider = AI_PROVIDERS[raw?.provider] ? raw.provider : 'gemini';
  const model = typeof raw?.model === 'string' && MODEL_RE.test(raw.model.trim()) ? raw.model.trim() : '';
  return {
    enabled: Boolean(raw?.enabled),
    provider,
    model,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '',
  };
}

export const modelFor = (config) => config.model || AI_PROVIDERS[config.provider].model;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestFor(config, system, user) {
  const model = modelFor(config);
  if (config.provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 1, responseMimeType: 'application/json' },
        }),
      },
      read: (data) => (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
    };
  }
  const base = config.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://openrouter.ai/api/v1';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
  if (config.provider === 'openrouter') headers['x-title'] = 'GV Sheet Helper';
  return {
    url: `${base}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 1,
        response_format: { type: 'json_object' },
      }),
    },
    read: (data) => data?.choices?.[0]?.message?.content ?? '',
  };
}

/** What went wrong, in words the user can act on. */
function describeFailure(status, body, config) {
  const name = AI_PROVIDERS[config.provider].label;
  const text = String(body ?? '');
  if (status === 401 || status === 403 || /api key not valid|invalid api key|invalid_api_key|unauthori[sz]ed/i.test(text)) {
    return `${name} didn’t accept the API key. Check it in Settings › AI message versions.`;
  }
  if (status === 404 || /not found|does not exist|model_not_found|decommissioned/i.test(text)) {
    return `${name} doesn’t offer the model “${modelFor(config)}”. Clear the model field in Settings to use the default, or enter another model name.`;
  }
  if (status === 429) return `${name} says the free limit is used up for now. Wait a few minutes (or until tomorrow for a daily limit) and try again.`;
  if (status === 402) return `${name} wants credit for this model. Choose a free model in Settings.`;
  if (status >= 500) return `${name} is having problems right now. Try again in a minute.`;
  return `${name} returned an error (${status}).`;
}

/** One request to the model, retried while the provider is busy. Resolves { ok, text } or { ok: false, error }. */
export async function askModel(config, system, user, { fetchImpl = fetch, sleep = defaultSleep } = {}) {
  if (!config.apiKey) return { ok: false, error: 'Add your API key in Settings › AI message versions.' };
  const { url, init, read } = requestFor(config, system, user);
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, cache: 'no-store', credentials: 'omit' });
    } catch {
      return { ok: false, error: `Couldn’t reach ${AI_PROVIDERS[config.provider].label}. Check your internet connection.` };
    }
    if (res.ok) {
      try {
        return { ok: true, text: read(await res.json()) };
      } catch {
        return { ok: false, error: `${AI_PROVIDERS[config.provider].label} sent a reply that couldn’t be read.` };
      }
    }
    const body = await res.text().catch(() => '');
    lastError = describeFailure(res.status, body, config);
    const busy = res.status === 429 || res.status >= 500;
    // A per-day quota won't clear by waiting a little.
    if (!busy || /per day|daily|PerDay/i.test(body) || attempt === MAX_ATTEMPTS) break;
    const after = Number(res.headers?.get?.('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 10_000 * attempt);
  }
  return { ok: false, error: lastError };
}

/**
 * Get `count` distinct, checked versions of `source`. Calls onProgress(done,
 * count) as versions arrive. Resolves { ok, versions, rejected, error }.
 * When only some versions could be written, ok is true and `error` says why.
 */
export async function generateVersions(config, source, count, { fetchImpl = fetch, sleep = defaultSleep, onProgress = () => {} } = {}) {
  const versions = [];
  let rejected = 0;
  let calls = 0;
  const maxCalls = Math.ceil(count / BATCH) + 3; // a few extra for versions that fail the checks
  const gap = AI_PROVIDERS[config.provider].gapMs;
  while (versions.length < count && calls < maxCalls) {
    if (calls > 0) await sleep(gap);
    calls++;
    const want = Math.min(BATCH, count - versions.length + 2);
    const avoid = versions.slice(-30).map((v) => v.split(/\s+/).slice(0, 4).join(' '));
    const { system, user } = buildPrompt(source, want, avoid);
    const res = await askModel(config, system, user, { fetchImpl, sleep });
    if (!res.ok) {
      if (versions.length) return { ok: true, versions, rejected, error: res.error };
      return { ok: false, versions, rejected, error: res.error };
    }
    const before = versions.length;
    for (const raw of parseVersionsReply(res.text)) {
      const v = cleanVersion(raw);
      if (!validateVersion(source, v).ok) {
        rejected++;
        continue;
      }
      if (versions.some((x) => sameText(x, v))) continue;
      versions.push(v);
      if (versions.length >= count) break;
    }
    onProgress(versions.length, count);
    if (versions.length === before && calls >= 3) break; // the model keeps failing the checks
  }
  if (!versions.length) {
    return {
      ok: false,
      versions,
      rejected,
      error: 'The AI didn’t write any versions that kept your placeholders, links, numbers and STOP wording. Try again, or try another model.',
    };
  }
  const short = versions.length < count;
  return { ok: true, versions, rejected, error: short ? `Only ${versions.length} of ${count} versions passed the checks; they’ll be used in rotation.` : null };
}
