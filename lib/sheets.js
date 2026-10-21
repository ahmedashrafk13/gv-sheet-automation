// Reading contacts straight from a Google Sheet.
//
// Uses the sheet's own CSV export link with the Google sign-in already in
// this Chrome profile, so a private sheet stays private: no sharing changes,
// no API key, no OAuth app. The export redirects to a signed
// *.googleusercontent.com download link, which is why the manifest lists that
// host too. This is the only file in the extension that makes a network
// request (tools/check.mjs enforces that).

export const MAX_SHEET_BYTES = 2 * 1024 * 1024; // same limit as an uploaded file

const SHEET_PATH = /\/spreadsheets\/(?:u\/(\d+)\/)?d\/(e\/)?([A-Za-z0-9_-]{15,})/;

/**
 * Turn whatever the user pasted (the address-bar link of the sheet, any tab)
 * into the CSV export URL for that tab.
 */
export function parseSheetLink(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Paste the link to your Google Sheet.' };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, error: 'That doesn’t look like a link. Copy it from the address bar of the sheet.' };
  }
  const m = SHEET_PATH.exec(url.pathname);
  if (url.hostname !== 'docs.google.com' || !m) {
    return { ok: false, error: 'That isn’t a Google Sheets link. It should start with docs.google.com/spreadsheets/.' };
  }
  const [, pathUser, published, id] = m;
  const params = new URLSearchParams(url.hash.slice(1));
  const gidRaw = url.searchParams.get('gid') ?? params.get('gid');
  const gid = /^\d+$/.test(gidRaw ?? '') ? gidRaw : null;
  const authuserRaw = url.searchParams.get('authuser') ?? pathUser ?? null;
  const authuser = /^\d+$/.test(authuserRaw ?? '') ? authuserRaw : null;

  const q = new URLSearchParams();
  let exportUrl;
  if (published) {
    q.set('output', 'csv');
    if (gid) q.set('gid', gid);
    q.set('single', 'true');
    exportUrl = `https://docs.google.com/spreadsheets/d/e/${id}/pub?${q}`;
  } else {
    q.set('format', 'csv');
    if (gid) q.set('gid', gid);
    if (authuser) q.set('authuser', authuser);
    exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?${q}`;
  }
  // Keeps the account (/u/1/) so a remembered link still opens with the same Google account.
  const account = authuser && !published ? `u/${authuser}/` : '';
  const canonical = `https://docs.google.com/spreadsheets/${account}d/${published ? 'e/' : ''}${id}/edit${gid ? `#gid=${gid}` : ''}`;
  return { ok: true, id, gid, authuser, published: Boolean(published), exportUrl, canonical };
}

/** "Leads - Sheet1.csv" from a Content-Disposition header, without the extension. */
export function titleFromDisposition(header) {
  const h = String(header ?? '');
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
  let name = null;
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) name = /filename\s*=\s*"([^"]*)"/.exec(h)?.[1] ?? /filename\s*=\s*([^;]+)/.exec(h)?.[1]?.trim() ?? null;
  return name ? name.replace(/\.csv$/i, '').trim() || null : null;
}

/**
 * Download the sheet as CSV. Resolves to { ok, buffer, title } or
 * { ok: false, error } with a message the user can act on.
 */
export async function fetchSheetCsv(link, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(link.exportUrl, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  } catch {
    return { ok: false, error: 'Couldn’t reach Google Sheets. Check your internet connection and try again.' };
  }
  const type = res.headers.get('content-type') || '';
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error:
        'Google Sheets wouldn’t open that sheet. Check the link, and make sure the Google account signed in to this Chrome profile can open it' +
        `${link.authuser ? '' : ' (with several accounts signed in, the first one is used)'}.`,
    };
  }
  if (!res.ok) return { ok: false, error: `Google Sheets returned an error (${res.status}). Try again in a minute.` };
  if (/text\/html/i.test(type)) {
    return { ok: false, error: 'Google asked for a sign-in. Sign in to Google in this Chrome profile, then load the sheet again.' };
  }
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_SHEET_BYTES) return { ok: false, error: 'That sheet is too big (over 2 MB). Load a smaller tab.' };
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_SHEET_BYTES) return { ok: false, error: 'That sheet is too big (over 2 MB). Load a smaller tab.' };
  return { ok: true, buffer, title: titleFromDisposition(res.headers.get('content-disposition')) };
}
