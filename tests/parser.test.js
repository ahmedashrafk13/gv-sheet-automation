import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContacts, parseDelimited, detectDelimiter, normalizePhone } from '../lib/parser.js';

const fields = (text, d) => parseDelimited(text, d).map((r) => r.fields);

test('detectDelimiter: tabs win, then commas, then semicolons', () => {
  assert.equal(detectDelimiter('Phone\tMessage\n1\t2'), '\t');
  assert.equal(detectDelimiter('Phone,Message'), ',');
  assert.equal(detectDelimiter('Phone;Message'), ';');
  assert.equal(detectDelimiter('"a,b";c'), ';', 'commas inside quotes are ignored');
  assert.equal(detectDelimiter('\n\n  \nPhone\tMessage'), '\t', 'leading blank lines are skipped');
});

test('parseDelimited: quoted commas, escaped quotes and embedded newlines', () => {
  assert.deepEqual(fields('a,"b, c","say ""hi"""\n', ','), [['a', 'b, c', 'say "hi"']]);
  assert.deepEqual(fields('a,"line 1\nline 2"\r\nb,c', ','), [['a', 'line 1\nline 2'], ['b', 'c']]);
  assert.deepEqual(fields('a,b\rc,d', ','), [['a', 'b'], ['c', 'd']], 'bare CR line endings');
});

test('parseDelimited: spaces around quoted fields', () => {
  assert.deepEqual(fields('+12125550147, "Hello, John" ,x', ','), [['+12125550147', 'Hello, John', 'x']]);
});

test('parseDelimited: unquoted cell containing quotes (as Sheets copies it)', () => {
  assert.deepEqual(fields('2125550147\t"Hi" there\n2125550148\tok', '\t'), [
    ['2125550147', '"Hi" there'],
    ['2125550148', 'ok'],
  ]);
});

test('parseDelimited: unmatched opening quote does not swallow later rows', () => {
  const recs = parseDelimited('2125550147,"Hi there\n2125550148,second\n', ',');
  assert.deepEqual(recs.map((r) => r.fields), [['2125550147', '"Hi there'], ['2125550148', 'second']]);
  assert.match(recs[0].warnings[0], /unmatched quotation mark/i);
});

test('normalizePhone: US/Canada formats', () => {
  for (const raw of ['2125550147', '(212) 555-0147', '212.555.0147', '1-212-555-0147', '+1 212 555 0147', ' 212 555 0147 ']) {
    const p = normalizePhone(raw);
    assert.equal(p.ok, true, raw);
    assert.equal(p.e164, '+12125550147', raw);
    assert.equal(p.display, '(212) 555-0147');
    assert.equal(p.dial, '2125550147');
  }
});

test('normalizePhone: rejects bad numbers with specific reasons', () => {
  const cases = [
    ['', /missing/i],
    ['555-0147', /too short/i],
    ['0125550147', /area codes can't start with 0 or 1/i],
    ['2121550147', /digit after the area code/i],
    ['+1234567890', /needs 10 digits after the country code/i],
    ['2.12556E+09', /scientific notation/i],
    ['212-555-0147 x12', /extensions/i],
    ['call me', /letters/i],
    ['212*555*0147', /unexpected characters/i],
    ['212+5550147', /only appear once, at the start/i],
    ['221255501477', /too long/i],
  ];
  for (const [raw, re] of cases) {
    const p = normalizePhone(raw);
    assert.equal(p.ok, false, raw);
    assert.match(p.error, re, raw);
  }
});

test('normalizePhone: international numbers need a + prefix', () => {
  const uk = normalizePhone('+44 20 7946 0958');
  assert.equal(uk.ok, true);
  assert.equal(uk.e164, '+442079460958');
  assert.equal(uk.international, true);
  assert.equal(normalizePhone('+4412').ok, false);
});

test('parseContacts: CSV with header and unquoted commas in the last column', () => {
  const r = parseContacts('Phone,Message\n+12125550147,Hello John, I wanted to follow up with you.\n(646) 555-0123,Hi Sarah, I hope you\'re doing well.');
  assert.equal(r.ok, true);
  assert.equal(r.headerDetected, true);
  assert.equal(r.delimiter, 'comma');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].message, 'Hello John, I wanted to follow up with you.');
  assert.equal(r.rows[1].message, "Hi Sarah, I hope you're doing well.");
  assert.equal(r.rows[0].row, 2, 'row numbers line up with spreadsheet rows');
});

test('parseContacts: quoted CSV fields with commas and quotes', () => {
  const r = parseContacts('Phone,Message\n2125550147,"Reply ""STOP"" to opt out, thanks"');
  assert.equal(r.rows[0].message, 'Reply "STOP" to opt out, thanks');
  assert.equal(r.rows[0].valid, true);
});

test('parseContacts: TSV copied from Google Sheets with a multi-line cell', () => {
  const text = 'Phone Number\tText\n2125550147\t"Line one\nLine two"\n6465550123\tSingle line, with comma\n';
  const r = parseContacts(text);
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, 'tab');
  assert.equal(r.rows[0].message, 'Line one\nLine two');
  assert.equal(r.rows[1].message, 'Single line, with comma');
});

test('parseContacts: header aliases and column order', () => {
  const r = parseContacts('Name,Text,Mobile\nSam,"Hi, Sam",2125550147');
  assert.equal(r.ok, true);
  assert.deepEqual(r.columns, { phone: 2, message: 1 });
  assert.equal(r.rows[0].message, 'Hi, Sam');
  assert.equal(r.rows[0].phone, '+12125550147');
});

test('parseContacts: extra unquoted commas when the message is not the last column', () => {
  const r = parseContacts('Message,Phone\nHi, Sam,2125550147');
  assert.equal(r.rows[0].valid, false);
  assert.match(r.rows[0].errors[0], /more columns than the header/i);
});

test('parseContacts: no header, columns inferred (phone second)', () => {
  const r = parseContacts('Hello there\t2125550147\nSee you soon\t6465550123');
  assert.equal(r.ok, true);
  assert.equal(r.headerDetected, false);
  assert.deepEqual(r.columns, { phone: 1, message: 0 });
  assert.equal(r.rows[0].row, 1);
});

test('parseContacts: blank rows, whitespace and trailing empty cells', () => {
  const r = parseContacts('﻿Phone,Message\n\n  2125550147  ,  Hi there  ,,\n,\n\t\n6465550123,Bye\n');
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.equal(r.stats.blank, 3);
  assert.equal(r.rows[0].message, 'Hi there', 'trailing empty cells are not glued onto the message');
  assert.equal(r.rows[1].row, 6);
});

test('parseContacts: missing data and invalid rows are reported, not dropped', () => {
  const r = parseContacts('Phone,Message\n2125550147,\n,Hello\n123,Hi\n6465550123,Ok');
  assert.equal(r.stats.invalid, 3);
  assert.equal(r.stats.valid, 1);
  assert.deepEqual(r.rows[0].errors, ['Missing message.']);
  assert.deepEqual(r.rows[1].errors, ['Missing phone number.']);
  assert.match(r.rows[2].errors[0], /too short/);
});

test('parseContacts: duplicates are detected by normalized number', () => {
  const r = parseContacts('Phone,Message\n2125550147,One\n(212) 555-0147,Two\n+1 212 555 0147,Three\n6465550123,Four');
  assert.equal(r.stats.duplicates, 2);
  assert.equal(r.rows[1].duplicateOf, 2);
  assert.equal(r.rows[2].duplicateOf, 2);
  assert.equal(r.stats.sendable, 2);
});

test('parseContacts: header detection and missing columns', () => {
  // Two columns: the non-phone one is the message whatever it's called.
  const twoCols = parseContacts('Phone,Notes\n2125550147,hi');
  assert.equal(twoCols.ok, true);
  assert.equal(twoCols.rows[0].message, 'hi');

  // Three columns with no recognisable message column.
  const r = parseContacts('Name,Phone,Notes\nSam,2125550147,hi');
  assert.equal(r.ok, false);
  assert.match(r.error, /Couldn.t find a message column.*Same message for everyone/);

  // Unrecognised phone header: found from the data.
  const r3 = parseContacts('Who,Digits,Msg\nSam,2125550147,hi');
  assert.equal(r3.ok, true);
  assert.equal(r3.rows[0].phone, '+12125550147');

  // No phone numbers anywhere.
  assert.match(parseContacts('Name,Notes\nSam,hi').error, /Couldn.t find a column of phone numbers/);

  // A first row that contains a phone-like value is data, never a header.
  const r2 = parseContacts('2125550147,Text\n6465550123,Message');
  assert.equal(r2.ok, true);
  assert.equal(r2.headerDetected, false);
  assert.equal(r2.rows.length, 2);
  const invalidFirst = parseContacts('555-0147,hi');
  assert.equal(invalidFirst.ok, true, 'a short number in row 1 is reported as an invalid row, not taken as a header');
  assert.match(invalidFirst.rows[0].errors[0], /too short/);
});

test('template mode: same message for everyone, phone column only', () => {
  const r = parseContacts('2125550147\n(646) 555-0123\n\n415.555.0188', { template: 'Store opens at 9 tomorrow.' });
  assert.equal(r.ok, true);
  assert.equal(r.messageMode, 'template');
  assert.deepEqual(r.rows.map((x) => x.message), Array(3).fill('Store opens at 9 tomorrow.'));
  assert.match(parseContacts('2125550147', { template: '   ' }).error, /Write the message/);
});

test('template mode: variables from columns, case- and spacing-insensitive', () => {
  const sheet = 'First Name\tPhone\tAppointment Time\nSam\t2125550147\t3:00 pm\nAlex\t6465550123\t4:30 pm';
  const r = parseContacts(sheet, { template: 'Hi {{first_name}}, see you at {{ Appointment time }}. ({{FIRSTNAME}})' });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].message, 'Hi Sam, see you at 3:00 pm. (Sam)');
  assert.equal(r.rows[1].message, 'Hi Alex, see you at 4:30 pm. (Alex)');
  assert.deepEqual(r.variables.map((v) => v.label), ['First Name', 'Phone', 'Appointment Time']);
});

test('template mode: empty values need a fallback; fallbacks are applied', () => {
  const sheet = 'Phone,First Name\n2125550147,Sam\n6465550123,';
  const strict = parseContacts(sheet, { template: 'Hi {{First Name}}, thanks!' });
  assert.equal(strict.rows[0].valid, true);
  assert.equal(strict.rows[1].valid, false);
  assert.match(strict.rows[1].errors[0], /\{\{First Name\}\} is empty for this row.*\{\{First Name\|there\}\}/);

  const withFallback = parseContacts(sheet, { template: 'Hi {{First Name|there}}, thanks!' });
  assert.equal(withFallback.rows[1].message, 'Hi there, thanks!');
  const emptyFallback = parseContacts(sheet, { template: 'Hi {{First Name|}}, thanks!' });
  assert.equal(emptyFallback.rows[1].message, 'Hi, thanks!', 'gap left by an empty value is tidied');
});

test('template mode: unknown variables are rejected before anything is queued', () => {
  const r = parseContacts('Phone,First Name\n2125550147,Sam', { template: 'Hi {{Frist Name}}' });
  assert.equal(r.ok, false);
  assert.match(r.error, /\{\{Frist Name\}\} isn.t a column in your sheet\. Variables you can use: \{\{Phone\}\}, \{\{First Name\}\}/);
  const noHeader = parseContacts('2125550147', { template: 'Hi {{name}}' });
  assert.match(noHeader.error, /Include your header row/);
  assert.equal(parseContacts('2125550147', { template: 'Your number is {{phone}}' }).rows[0].message, 'Your number is 2125550147');
});

test('template mode: first/last name derived from a full-name column', () => {
  const r = parseContacts('Name,Phone\nSam Rivera Jones,2125550147\nCher,6465550123', {
    template: '{{First Name}}|{{Last Name|-}}',
  });
  assert.equal(r.rows[0].message, 'Sam|Jones');
  assert.equal(r.rows[1].message, 'Cher|-');
});

test('column mode: variables inside per-row message cells are filled in too', () => {
  const r = parseContacts('Phone,Name,Message\n2125550147,Sam,"Hi {{name}}, your order shipped"\n6465550123,Alex,{{Nmae}} typo');
  assert.equal(r.rows[0].message, 'Hi Sam, your order shipped');
  assert.equal(r.rows[1].valid, false);
  assert.match(r.rows[1].errors[0], /\{\{Nmae\}\} isn.t a column/);
});

test('messages over the hard limit are rejected', () => {
  assert.match(parseContacts('2125550147', { template: 'x'.repeat(5001) }).error, /too long/);
  const r = parseContacts(`Phone,Message\n2125550147,"${'y'.repeat(5001)}"`);
  assert.match(r.rows[0].errors[0], /too long/);
});

test('parseContacts: empty, header-only and oversized input', () => {
  assert.equal(parseContacts('').ok, false);
  assert.equal(parseContacts('   \n\t\n').ok, false);
  assert.match(parseContacts('Phone,Message\n').error, /Only a header row/);
  const many = ['Phone,Message', ...Array.from({ length: 5 }, (_, i) => `21255501${String(10 + i)},hi`)].join('\n');
  assert.match(parseContacts(many, { maxContacts: 3 }).error, /Import up to 3/);
});

test('parseContacts: semicolon-separated (European Excel)', () => {
  const r = parseContacts('Phone;Message\n2125550147;Hello, friend');
  assert.equal(r.delimiter, 'semicolon');
  assert.equal(r.rows[0].message, 'Hello, friend');
});

test('parseContacts: long and international messages get warnings, not errors', () => {
  const r = parseContacts(`Phone,Message\n+442079460958,"${'x'.repeat(1200)}"`);
  assert.equal(r.rows[0].valid, true);
  assert.equal(r.rows[0].warnings.length, 2);
});
