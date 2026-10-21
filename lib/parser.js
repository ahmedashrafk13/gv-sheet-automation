// Spreadsheet import: CSV/TSV parsing, header detection, phone validation and
// message templates with {{Column}} variables.
// Pure functions only — shared by the background service worker, the side
// panel and the Node test suite.

export const MAX_CONTACTS = 1000;
// A sheet that grows every day can hold far more rows than one queue sends;
// rows texted before are skipped, and MAX_CONTACTS applies to the rest.
export const MAX_SHEET_ROWS = 5000;
export const MESSAGE_SOFT_LIMIT = 1000;
export const MESSAGE_HARD_LIMIT = 5000;
export const MAX_INPUT_CHARS = 2_000_000;

const PHONE_HEADERS = new Set([
  'phone', 'phone number', 'phonenumber', 'phone no', 'phone #', 'mobile',
  'mobile number', 'mobile phone', 'cell', 'cell phone', 'cellphone', 'number',
  'telephone', 'tel', 'to', 'recipient', 'contact number', 'cell #', 'mobile #',
  'phone numbers', 'numbers', 'sms number', 'text number',
]);
const MESSAGE_HEADERS = new Set([
  'message', 'text', 'message text', 'text message', 'sms', 'body', 'msg',
  'content', 'message body',
]);

function normalizeHeader(cell) {
  return String(cell)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[:*]+$/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Guess the delimiter from the first non-blank line, ignoring quoted text.
 * Spreadsheet copies are tab-separated; exported files are usually commas.
 */
export function detectDelimiter(text) {
  const counts = { '\t': 0, ',': 0, ';': 0 };
  let inQuotes = false;
  let started = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (started) break;
      continue;
    }
    if (ch === '\t' || !/\s/.test(ch)) started = true;
    if (!inQuotes && ch in counts) counts[ch]++;
  }
  if (counts['\t'] > 0) return '\t';
  if (counts[','] > 0) return ',';
  if (counts[';'] > 0) return ';';
  return ',';
}

/**
 * RFC 4180-style parser with lenient handling of the things spreadsheets
 * actually produce:
 *  - quoted fields with "" escapes, embedded delimiters and newlines
 *  - CRLF, LF or CR line endings
 *  - unquoted cells that merely contain a quote (Sheets copies `"Hi" there` as-is)
 *  - an opening quote that never closes (treated as literal text, not as
 *    "swallow the rest of the input")
 *
 * Returns records: [{ fields: string[], warnings: string[] }]
 */
export function parseDelimited(text, delimiter) {
  const literalQuotes = new Set();
  // Each pass either succeeds or marks one more unmatched opening quote as
  // literal text, so this terminates after at most (number of quotes) passes.
  for (;;) {
    const result = scan(text, delimiter, literalQuotes);
    if (result.unclosedAt === -1) return result.records;
    literalQuotes.add(result.unclosedAt);
  }
}

function scan(text, d, literalQuotes) {
  const records = [];
  let fields = [];
  let warnings = [];
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let quoteStart = -1;
  const n = text.length;

  const endField = () => {
    fields.push(field);
    field = '';
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push({ fields, warnings });
    fields = [];
    warnings = [];
  };
  const isPad = (ch) => ch === ' ' || (ch === '\t' && d !== '\t');

  let i = 0;
  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        // Closing quote, optionally followed by padding before the delimiter.
        let j = i + 1;
        while (j < n && isPad(text[j])) j++;
        const next = text[j];
        if (j >= n || next === d || next === '\n' || next === '\r') {
          inQuotes = false;
          i = j;
          continue;
        }
        // A quote followed by more text: this cell was never really quoted.
        inQuotes = false;
        fieldQuoted = false;
        field = `"${field}"`;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"' && !fieldQuoted && field.trim() === '') {
      if (literalQuotes.has(i)) {
        warnings.push('An unmatched quotation mark was kept as part of the text.');
      } else {
        inQuotes = true;
        fieldQuoted = true;
        quoteStart = i;
        field = '';
        i++;
        continue;
      }
    }
    if (c === d) {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      endRecord();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (c === '\n') {
      endRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  if (inQuotes) return { records: null, unclosedAt: quoteStart };
  if (field.length > 0 || fields.length > 0 || fieldQuoted) endRecord();
  return { records, unclosedAt: -1 };
}

const fail = (error) => ({ ok: false, error });

/**
 * Validate and normalise one phone number.
 * US/Canada numbers may be written in any common format; other countries
 * need a leading + and country code.
 */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return fail('Missing phone number.');
  if (/^[+-]?\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    return fail('This number was converted to scientific notation by Excel. Format the phone column as Text and copy it again.');
  }
  if (/(?:ext\.?|extension|x|#)\s*\d+$/i.test(s) && /\d.*(?:ext|x|#)/i.test(s)) {
    return fail("Phone extensions aren't supported.");
  }
  if (/[a-z]/i.test(s)) return fail('Phone number contains letters.');
  if (/[^\d\s().+\-/]/.test(s)) return fail('Phone number contains unexpected characters.');
  const plusCount = (s.match(/\+/g) || []).length;
  if (plusCount > 1 || (plusCount === 1 && !s.startsWith('+'))) {
    return fail('"+" can only appear once, at the start of the number.');
  }

  const digits = s.replace(/\D/g, '');
  let national;
  if (s.startsWith('+')) {
    if (digits.startsWith('1')) {
      if (digits.length !== 11) {
        return fail(`A +1 number needs 10 digits after the country code (found ${digits.length - 1}).`);
      }
      national = digits.slice(1);
    } else {
      if (digits.length < 8 || digits.length > 15) {
        return fail('International numbers need 8–15 digits including the country code.');
      }
      return {
        ok: true,
        e164: `+${digits}`,
        display: `+${digits}`,
        dial: `+${digits}`,
        digits,
        international: true,
      };
    }
  } else if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  } else if (digits.length < 10) {
    return fail(`Phone number is too short (${digits.length} digits).`);
  } else {
    return fail('Phone number is too long. For numbers outside the US and Canada, start with + and the country code.');
  }

  if (!/^[2-9]/.test(national)) return fail("US/Canada area codes can't start with 0 or 1.");
  if (!/^[2-9]/.test(national.slice(3))) {
    return fail("This isn't a valid US/Canada number (the digit after the area code can't be 0 or 1).");
  }
  return {
    ok: true,
    e164: `+1${national}`,
    display: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
    dial: national,
    digits: national,
    international: false,
  };
}


/**
 * Every phone number in free text: one per line, or separated by commas,
 * semicolons or tabs. Cells with fewer than 7 digits (names, headers) are
 * ignored. Used to add numbers texted before the extension kept a history.
 */
export function extractPhones(text) {
  const numbers = new Set();
  let invalid = 0;
  for (const cell of String(text ?? '').split(/[\r\n,;\t]+/)) {
    const s = cell.trim().replace(/^"|"$/g, '');
    if ((s.match(/\d/g) || []).length < 7) continue;
    const phone = normalizePhone(s);
    if (phone.ok) numbers.add(phone.e164);
    else invalid++;
  }
  return { numbers: [...numbers], invalid };
}

const isBlankRecord = (rec) => rec.fields.every((f) => f.trim() === '');
const digitCount = (s) => (String(s).match(/\d/g) || []).length;

// ---------------------------------------------------------------------------
// Variables / templates
//
// {{Column Name}} inserts that column's value for the row. Matching ignores
// case, spaces and punctuation, so {{first_name}}, {{First Name}} and
// {{firstname}} all match a "First Name" column. {{Column|fallback}} uses the
// fallback when the cell is empty. {{phone}} is always available, and
// {{first name}} / {{last name}} are derived from a "Name" column when the
// sheet has no dedicated columns for them.

const VARIABLE_RE = /\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g;
const FULL_NAME_KEYS = ['name', 'fullname', 'contactname', 'customername', 'clientname'];

export const variableKey = (name) => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Variables referenced by a template: [{ name, key, fallback }] (unique by key). */
export function templateVariables(template) {
  const seen = new Map();
  for (const m of String(template ?? '').matchAll(VARIABLE_RE)) {
    const key = variableKey(m[1]);
    if (key && !seen.has(key)) seen.set(key, { name: m[1].trim(), key, fallback: m[2] });
  }
  return [...seen.values()];
}

/** Names offered to the user as variables for a header row. */
export function availableVariables(headers) {
  const out = [];
  const keys = new Set();
  const add = (label) => {
    const key = variableKey(label);
    if (key && !keys.has(key)) {
      keys.add(key);
      out.push({ label, key });
    }
  };
  for (const h of headers ?? []) if (h.trim()) add(h.trim());
  add('Phone');
  if (FULL_NAME_KEYS.some((k) => keys.has(k))) {
    add('First Name');
    add('Last Name');
  }
  return out;
}

function rowVariables(headers, fields, rawPhone) {
  const vars = new Map();
  (headers ?? []).forEach((h, i) => {
    const key = variableKey(h);
    if (key && !vars.has(key)) vars.set(key, String(fields[i] ?? '').trim());
  });
  if (!vars.has('phone')) vars.set('phone', rawPhone);
  const fullKey = FULL_NAME_KEYS.find((k) => vars.has(k));
  if (fullKey) {
    const parts = vars.get(fullKey).split(/\s+/).filter(Boolean);
    if (!vars.has('firstname')) vars.set('firstname', parts[0] ?? '');
    if (!vars.has('lastname')) vars.set('lastname', parts.length > 1 ? parts.at(-1) : '');
  }
  return vars;
}

/** Fill a template for one row. Returns { text, missing: [names], unknown: [names] }. */
export function renderTemplate(template, vars) {
  const missing = [];
  const unknown = [];
  let emptied = false;
  let text = String(template).replace(VARIABLE_RE, (match, name, fallback) => {
    const value = vars.get(variableKey(name));
    if (value === undefined) {
      unknown.push(name.trim());
      return match;
    }
    if (value !== '') return value;
    if (fallback !== undefined) {
      const fb = fallback.trim();
      if (!fb) emptied = true;
      return fb;
    }
    missing.push(name.trim());
    emptied = true;
    return '';
  });
  // Tidy the gap an intentionally empty value leaves ("Hi  , there" -> "Hi, there").
  if (emptied) text = text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?;:])/g, '$1');
  return { text, missing, unknown };
}

// ---------------------------------------------------------------------------
// Layout detection

function bestPhoneColumn(rows) {
  const scores = [];
  for (const r of rows) {
    r.fields.forEach((f, i) => {
      if (normalizePhone(f).ok) scores[i] = (scores[i] ?? 0) + 1;
    });
  }
  let best = -1;
  scores.forEach((s, i) => {
    if (s > (scores[best] ?? 0)) best = i;
  });
  return best;
}

/**
 * Work out the header row (if any), the phone column and the message column.
 * A first row with no phone-number-like cell (7+ digits) is a header row.
 */
function detectLayout(records, firstIdx, { needMessageColumn }) {
  const first = records[firstIdx].fields;
  const hasHeader = !first.some((c) => digitCount(c) >= 7);
  const sample = records
    .slice(firstIdx + (hasHeader ? 1 : 0))
    .filter((r) => !isBlankRecord(r))
    .slice(0, 25);

  if (hasHeader) {
    const keys = first.map(normalizeHeader);
    let phoneCol = keys.findIndex((k) => PHONE_HEADERS.has(k));
    if (phoneCol < 0) phoneCol = bestPhoneColumn(sample);
    if (phoneCol < 0) {
      return fail('Couldn’t find a column of phone numbers. Name the column "Phone" and check that the numbers are in the rows you pasted.');
    }
    let msgCol = keys.findIndex((k, i) => i !== phoneCol && MESSAGE_HEADERS.has(k));
    if (msgCol < 0 && needMessageColumn) {
      if (first.length === 2) msgCol = 1 - phoneCol;
      else {
        return fail('Couldn’t find a message column. Name it "Message", or choose “Same message for everyone” and write the message here.');
      }
    }
    return { ok: true, headers: first.map((h) => h.trim()), phoneCol, msgCol, width: first.length, dataStart: firstIdx + 1 };
  }

  let phoneCol = bestPhoneColumn(sample);
  if (phoneCol < 0) phoneCol = 0;
  const msgCol = needMessageColumn ? (phoneCol === 0 ? 1 : 0) : -1;
  const width = needMessageColumn ? Math.max(2, phoneCol + 1) : Infinity;
  return { ok: true, headers: null, phoneCol, msgCol, width, dataStart: firstIdx };
}

const DELIMITER_NAMES = { '\t': 'tab', ',': 'comma', ';': 'semicolon' };

function splitRecords(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  if (!text.trim()) return fail('Paste at least one row with a phone number.');
  if (text.length > MAX_INPUT_CHARS) return fail('That paste is too large. Import a smaller batch.');
  const delimiter = detectDelimiter(text);
  const records = parseDelimited(text, delimiter);
  const firstIdx = records.findIndex((r) => !isBlankRecord(r));
  if (firstIdx === -1) return fail('Paste at least one row with a phone number.');
  return { ok: true, delimiter, records, firstIdx };
}

/** Header names and variables for the panel's "insert variable" chips. */
export function inspectColumns(input) {
  const split = splitRecords(input);
  if (!split.ok) return { ok: false, headers: null, variables: availableVariables(null) };
  const layout = detectLayout(split.records, split.firstIdx, { needMessageColumn: false });
  const headers = layout.ok ? layout.headers : null;
  return { ok: layout.ok, headers, variables: availableVariables(headers) };
}

/**
 * Parse pasted spreadsheet text into validated contact rows.
 *
 * options.template: when a string, every row gets this message (with its
 * variables filled in) and no message column is needed. When null, each row's
 * message comes from the sheet's message column; variables in those cells are
 * filled in too.
 *
 * Row numbers are 1-based record numbers including the header and blank
 * rows, so they line up with spreadsheet row numbers when the paste starts
 * at row 1.
 */
export function parseContacts(input, { template = null, maxContacts = MAX_CONTACTS } = {}) {
  const useTemplate = typeof template === 'string';
  if (useTemplate && !template.trim()) return fail('Write the message to send to everyone.');
  if (useTemplate && template.length > MESSAGE_HARD_LIMIT) {
    return fail(`The message is too long (${template.length.toLocaleString('en-US')} characters; the limit is ${MESSAGE_HARD_LIMIT.toLocaleString('en-US')}).`);
  }

  const split = splitRecords(input);
  if (!split.ok) return split;
  const { delimiter, records, firstIdx } = split;

  const layout = detectLayout(records, firstIdx, { needMessageColumn: !useTemplate });
  if (!layout.ok) return layout;
  const { headers, phoneCol, msgCol, width, dataStart } = layout;
  const variables = availableVariables(headers);
  const knownKeys = new Set(variables.map((v) => v.key));

  if (useTemplate) {
    const unknown = templateVariables(template).filter((v) => !knownKeys.has(v.key));
    if (unknown.length) {
      const names = unknown.map((v) => `{{${v.name}}}`).join(', ');
      const help = headers
        ? `Variables you can use: ${variables.map((v) => `{{${v.label}}}`).join(', ')}.`
        : 'Include your header row (for example "Phone, First Name") to use columns as variables.';
      return fail(`${names} ${unknown.length === 1 ? 'isn’t a column' : 'aren’t columns'} in your sheet. ${help}`);
    }
  }

  const messageIsLast = msgCol >= 0 && msgCol > phoneCol && msgCol === width - 1;
  const rows = [];
  const firstRowFor = new Map();
  const stats = { dataRows: 0, valid: 0, invalid: 0, duplicates: 0, blank: 0 };

  for (let idx = dataStart; idx < records.length; idx++) {
    const rec = records[idx];
    const rowNumber = idx + 1;
    if (isBlankRecord(rec)) {
      stats.blank++;
      continue;
    }
    stats.dataRows++;

    const fields = rec.fields.slice();
    while (fields.length > width && fields[fields.length - 1].trim() === '') fields.pop();

    const errors = [];
    const warnings = [...rec.warnings];
    let source = useTemplate ? template : fields[msgCol] ?? '';

    if (fields.length > width) {
      if (!useTemplate && messageIsLast && delimiter !== '\t') {
        // Unquoted commas inside the message: rebuild it from the overflow.
        source = fields.slice(msgCol).join(delimiter);
      } else if (delimiter === '\t') {
        warnings.push('Extra cells beyond the header were ignored.');
      } else {
        errors.push('This row has more columns than the header. Put quotation marks around values that contain commas.');
      }
    }

    const rawPhone = String(fields[phoneCol] ?? '').trim();
    const phone = normalizePhone(rawPhone);
    if (!phone.ok) errors.push(phone.error);

    const sourceText = String(source).replace(/\r\n?/g, '\n');
    const vars = rowVariables(headers, fields, rawPhone);
    const rendered = renderTemplate(sourceText, vars);
    const message = rendered.text.trim();
    if (rendered.unknown.length) {
      errors.push(`{{${rendered.unknown[0]}}} isn’t a column in your sheet.`);
    }
    if (rendered.missing.length) {
      const names = rendered.missing.map((n) => `{{${n}}}`).join(', ');
      errors.push(
        `${names} ${rendered.missing.length === 1 ? 'is' : 'are'} empty for this row. Fill it in, or add a fallback like {{${rendered.missing[0]}|there}}.`,
      );
    }
    if (!message) errors.push('Missing message.');
    else if (message.length > MESSAGE_HARD_LIMIT) {
      errors.push(`Message is too long (${message.length.toLocaleString('en-US')} characters; the limit is ${MESSAGE_HARD_LIMIT.toLocaleString('en-US')}).`);
    } else if (message.length > MESSAGE_SOFT_LIMIT) {
      warnings.push(`Long message (${message.length.toLocaleString('en-US')} characters). Google Voice may split or reject it.`);
    }
    if (phone.ok && phone.international) {
      warnings.push('International number. Google Voice may charge for or block this message.');
    }

    let duplicateOf = null;
    if (errors.length === 0) {
      if (firstRowFor.has(phone.e164)) {
        duplicateOf = firstRowFor.get(phone.e164);
        stats.duplicates++;
      } else {
        firstRowFor.set(phone.e164, rowNumber);
      }
    }

    const valid = errors.length === 0;
    if (valid) stats.valid++;
    else stats.invalid++;

    rows.push({
      row: rowNumber,
      rawPhone,
      phone: valid ? phone.e164 : null,
      display: valid ? phone.display : rawPhone,
      dial: valid ? phone.dial : null,
      digits: valid ? phone.digits : null,
      international: valid ? phone.international : false,
      message,
      // The message before variables were filled in, and this row's values:
      // used to fill in an AI-written version (lib/variations.js). Never stored.
      source: sourceText,
      vars,
      valid,
      errors,
      warnings,
      duplicateOf,
    });
  }

  if (stats.dataRows === 0) {
    return fail('Only a header row was found. Paste the rows underneath it too.');
  }
  if (stats.valid > maxContacts) {
    return fail(`That's ${stats.valid.toLocaleString('en-US')} valid rows. Import up to ${maxContacts.toLocaleString('en-US')} at a time.`);
  }

  return {
    ok: true,
    delimiter: DELIMITER_NAMES[delimiter],
    headerDetected: Boolean(headers),
    headers,
    variables,
    messageMode: useTemplate ? 'template' : 'column',
    columns: { phone: phoneCol, message: msgCol },
    rows,
    stats: { ...stats, sendable: stats.valid - stats.duplicates },
  };
}
