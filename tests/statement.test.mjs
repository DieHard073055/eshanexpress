import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unwrap, parseTimestamp, parseStatement, referenceScore, findCandidates, matchQuality,
} from '../src/lib/statement.js';

// Mirrors the real export's structure. Values are synthetic; the SHAPE is real.
const SAMPLE = [
  '"2026/08/16","2026/08/16","Transfer Debit","=""BLAZ000000000001""","=""FT00000AAAA\\B26""","14-08-2026 11-45-35","=""PAYER ONE""","Internet Banking","10","","3471.91"',
  '"2026/08/16","2026/08/16","Transfer Debit","=""BLAZ000000000002""","=""FT00000BBBB\\B26""","14-08-2026 17-50-28","=""PAYER ONE""","Internet Banking","250","","3221.91"',
  '"2026/08/17","2026/08/17","ATM Withdrawal","=""0000000000000003""","=""FT00000CCCC\\B26""","2026-08-17 21-57-29","=""ATM057 832421""","SOME ATM","2000","","1221.91"',
  '"2026/08/18","2026/08/18","Transfer Credit","=""BLAZ000000000004""","=""FT00000DDDD\\B26""","17-08-2026 22-28-38","=""PAYER TWO""","Internet Banking","","10000","11221.91"',
].join('\n');

test('unwrap strips the Excel-injection wrapper', () => {
  assert.equal(unwrap('="BLAZ123"'), 'BLAZ123');
  assert.equal(unwrap('plain'), 'plain');
});

test('DD-MM-YYYY is not misread as MM-DD', () => {
  // 08-09-2026 must be 8 September, not 9 August.
  const d = parseTimestamp('08-09-2026 10-00-00');
  assert.equal(d.getMonth(), 8, 'month should be September');
  assert.equal(d.getDate(), 8);
});

test('handles the YYYY-MM-DD rows that appear in the same column', () => {
  const d = parseTimestamp('2026-08-17 21-57-29');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);
  assert.equal(d.getDate(), 17);
});

test('times use HH-MM-SS, which Date.parse cannot read', () => {
  const d = parseTimestamp('14-08-2026 11-45-35');
  assert.equal(d.getHours(), 11);
  assert.equal(d.getMinutes(), 45);
  assert.equal(d.getSeconds(), 35);
});

test('parses the statement and keeps only money in', () => {
  const r = parseStatement(SAMPLE);
  assert.equal(r.transactions.length, 4);
  assert.equal(r.credits.length, 1, 'only Transfer Credit rows are candidates');
  assert.equal(r.credits[0].txnId, 'BLAZ000000000004');
  assert.equal(r.credits[0].credit, 10000);
});

test('an ATM withdrawal never becomes a candidate', () => {
  const r = parseStatement(SAMPLE);
  assert.ok(!r.credits.some((t) => /ATM/i.test(t.type)));
});

test('balance reconciliation passes on a well-formed file', () => {
  assert.equal(parseStatement(SAMPLE).balanceOk, true);
});

test('a corrupted balance is detected rather than matched against', () => {
  const broken = SAMPLE.replace('"11221.91"', '"99999.99"');
  const r = parseStatement(broken);
  assert.equal(r.balanceOk, false);
  assert.match(r.balanceError, /does not reconcile/);
});

test('a non-statement file is rejected with a clear message', () => {
  assert.throws(() => parseStatement('a,b,c\n1,2,3'), /Expected 11 columns/);
});

// ------------------------------------------------------------- matching
const credits = parseStatement(SAMPLE).credits;
const orderAt = (iso, cents, ref = null) => ({
  id: 'o1', total_cents: cents, receipt_uploaded_at: iso,
  created_at: iso, payment_reference: ref,
});

test('matches on exact amount inside the time window', () => {
  const c = findCandidates(orderAt('2026-08-17T22:40:00', 1000000), credits);
  assert.equal(c.length, 1);
  assert.equal(c[0].txn.txnId, 'BLAZ000000000004');
});

test('a different amount never matches', () => {
  assert.equal(findCandidates(orderAt('2026-08-17T22:40:00', 999999), credits).length, 0);
});

test('outside the window it does not match', () => {
  const c = findCandidates(orderAt('2026-08-25T22:40:00', 1000000), credits, { windowHours: 24 });
  assert.equal(c.length, 0);
});

test('an already-allocated transfer is excluded', () => {
  const c = findCandidates(orderAt('2026-08-17T22:40:00', 1000000), credits,
    { allocated: new Set(['BLAZ000000000004']) });
  assert.equal(c.length, 0, 'a transfer must not pay for two orders');
});

test('a matching reference scores highest', () => {
  assert.equal(referenceScore('BLAZ000000000004', credits[0]), 100);
  assert.equal(referenceScore('TOTALLYDIFFERENT', credits[0]), 0);
});

test('reference tolerates a couple of OCR slips', () => {
  // One transposed character in an otherwise identical reference.
  assert.ok(referenceScore('BLAZ000000000904', credits[0]) > 0);
});

test('a too-short reference is ignored rather than matching everything', () => {
  assert.equal(referenceScore('AB', credits[0]), 0);
});

test('match quality distinguishes confident from ambiguous', () => {
  assert.equal(matchQuality([]).level, 'none');
  assert.equal(matchQuality([{ refScore: 100 }]).level, 'strong');
  assert.equal(matchQuality([{ refScore: 0 }]).level, 'single');
  assert.equal(matchQuality([{ refScore: 0 }, { refScore: 0 }]).level, 'ambiguous');
});

test('ranks the reference match above a closer-in-time one', () => {
  const two = parseStatement(SAMPLE + '\n' +
    '"2026/08/18","2026/08/18","Transfer Credit","=""BLAZ000000000005""","=""FT00000EEEE\\B26""","17-08-2026 22-35-00","=""PAYER THREE""","Internet Banking","","10000","21221.91"'
  ).credits;
  const c = findCandidates(orderAt('2026-08-17T22:36:00', 1000000, 'BLAZ000000000004'), two);
  assert.equal(c.length, 2);
  assert.equal(c[0].txn.txnId, 'BLAZ000000000004', 'reference should outrank time proximity');
});
