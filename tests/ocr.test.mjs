import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReferences } from '../src/lib/ocr.js';

// Formats taken from the real bank statement sample.
test('finds an FT transaction reference', () => {
  const c = extractReferences('Transfer successful\nRef: FT26230F30WR\nAmount 10,000.00');
  assert.equal(c[0].value, 'FT26230F30WR');
  assert.equal(c[0].confident, true);
});

test('finds a BLAZ transfer id', () => {
  const c = extractReferences('Transaction ID BLAZ719464188834 completed');
  assert.ok(c.some((x) => x.value === 'BLAZ719464188834' && x.confident));
});

test('prefers the bank format over generic runs', () => {
  const c = extractReferences('ACCOUNT 1234567890123\nREF FT26229XN4DF\nBRANCH 00912345678');
  assert.equal(c[0].value, 'FT26229XN4DF', 'bank format should outrank a long number');
});

test('reads a labelled reference line', () => {
  const c = extractReferences('Reference No: ABC123456789');
  assert.equal(c[0].value, 'ABC123456789');
  assert.equal(c[0].confident, true);
});

test('recovers from the classic l/I/| OCR confusion', () => {
  const c = extractReferences('Ref: FT26230F30WR|');
  assert.ok(c.some((x) => x.value.startsWith('FT26230F30WR')));
});

test('ignores short tokens', () => {
  const c = extractReferences('OK 123 MVR 50');
  assert.deepEqual(c, []);
});

test('requires a digit, so plain words are not references', () => {
  const c = extractReferences('TRANSFER COMPLETED SUCCESSFULLY');
  assert.deepEqual(c, []);
});

test('returns an empty list for empty input rather than throwing', () => {
  assert.deepEqual(extractReferences(''), []);
});

test('deduplicates a reference that appears twice', () => {
  const c = extractReferences('FT26230F30WR ... later ... FT26230F30WR');
  assert.equal(c.filter((x) => x.value === 'FT26230F30WR').length, 1);
});

test('handles a realistic multi-line receipt', () => {
  const receipt = `
    BANK OF MALDIVES
    Transfer Receipt
    Date: 17-08-2026 22:28:38
    From: 7730000012345
    To:   7730000099999
    Amount: MVR 10,000.00
    Reference: FT26230F30WR
    Status: SUCCESS
  `;
  const c = extractReferences(receipt);
  assert.equal(c[0].value, 'FT26230F30WR');
});

// ---------------------------------------------------------------------------
// Real BML app receipts (from screenshots supplied by the store owner).
// Reference format is consistently BLAZ + 12 digits.
// ---------------------------------------------------------------------------
import { detectsOtp } from '../src/lib/ocr.js';

const REAL = [
  'BLAZ100000000001', 'BLAZ100000111112', 'BLAZ100000222223',
  'BLAZ100000333334', 'BLAZ100000444445',
];

const bmlReceipt = (ref, amount, date) => `
  Thank you. Transfer transaction is successful.
  ${amount}
  MVR
  Status SUCCESS
  Message Thank you. Transfer transaction is successful.
  Reference ${ref}
  Transaction date ${date}
  From TEST CUSTOMER
  To Test Payee 7700000000000
  Amount MVR ${amount}
  Bank of Maldives`;

for (const ref of REAL) {
  test(`real BML reference ${ref} is the top candidate`, () => {
    const c = extractReferences(bmlReceipt(ref, '1,400.00', '06/09/2026 19:39'));
    assert.equal(c[0].value, ref);
    assert.equal(c[0].confident, true);
  });
}

test('reference outranks the destination account number', () => {
  const c = extractReferences(bmlReceipt('BLAZ100000000001', '1,400.00', '06/09/2026 19:39'));
  assert.equal(c[0].value, 'BLAZ100000000001');
  assert.ok(c.findIndex((x) => x.value === '7700000000000') > 0,
    'account number must rank below the reference');
});

test('detects an OTP left visible in the notification shade', () => {
  const withOtp = 'BML Internet Banking: Your One Time Password is 000000. '
                + 'It will expire after use or after 06/09/...\n'
                + bmlReceipt('BLAZ100000000001', '1,400.00', '06/09/2026 19:39');
  assert.equal(detectsOtp(withOtp), true);
});

test('a clean receipt is not flagged for an OTP', () => {
  assert.equal(detectsOtp(bmlReceipt('BLAZ100000222223', '60.00', '22/08/2026 18:06')), false);
});

test('the OTP digits are never offered as a reference', () => {
  const withOtp = 'Your One Time Password is 000000.\n'
                + bmlReceipt('BLAZ100000000001', '1,400.00', '06/09/2026 19:39');
  const c = extractReferences(withOtp);
  assert.equal(c[0].value, 'BLAZ100000000001');
  assert.ok(!c.some((x) => x.value === '000000'), 'OTP must not appear as a candidate');
});
