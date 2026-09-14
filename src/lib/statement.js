/**
 * Bank statement CSV parser and candidate matcher.
 *
 * Runs entirely in the browser, in the OFFLINE admin page. The statement is
 * never uploaded, never stored in Supabase, and never leaves the machine.
 *
 * Format spec and parsing hazards: docs/BANK_STATEMENT_FORMAT.md.
 * Validated against a real export — every rule here exists because the real
 * file broke a naive assumption.
 */

/** Strip the bank's Excel-injection wrapper: `="VALUE"` -> `VALUE`. */
export function unwrap(s) {
  const m = /^="?(.*?)"?$/.exec(String(s ?? '').trim());
  return m ? m[1] : String(s ?? '').trim();
}

/**
 * Parse the transaction timestamp (column 5).
 *
 * Transfers use DD-MM-YYYY, but the ATM rows in the real sample use
 * YYYY-MM-DD — in the same column. Detect per row. Parsing DD-MM as MM-DD
 * silently shifts any day <= 12 by months.
 *
 * Time is HH-MM-SS with dashes, so Date.parse cannot be used.
 */
export function parseTimestamp(raw) {
  const s = unwrap(raw);
  let m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2})[-:](\d{2})[-:](\d{2})$/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);

  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})[-:](\d{2})[-:](\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);

  // Date only — degrade to midnight rather than failing the whole import.
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);

  return null;
}

/** Minimal RFC4180 reader: handles quoted fields and "" escapes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field);
      if (row.some((x) => x !== '')) rows.push(row);
      row = []; field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((x) => x !== '')) rows.push(row);
  }
  return rows;
}

const COL = {
  postDate: 0, valueDate: 1, type: 2, txnId: 3,
  bankRef: 4, timestamp: 5, payer: 6, channel: 7,
  debit: 8, credit: 9, balance: 10,
};

const num = (v) => {
  const s = unwrap(v).replace(/,/g, '');
  return s ? parseFloat(s) : 0;
};

/**
 * Parse a statement export.
 *
 * Returns { transactions, credits, warnings, balanceOk }.
 * Throws only when the file is not a statement at all — a caller should show
 * `warnings` and refuse to match when `balanceOk` is false.
 */
export function parseStatement(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('That file is empty.');

  // No header row: columns are positional. Reject anything that is not the
  // 11-column shape rather than silently mis-reading columns.
  const bad = rows.filter((r) => r.length < 11);
  if (bad.length === rows.length) {
    throw new Error(
      `Expected 11 columns per row, found ${rows[0].length}. ` +
      'This does not look like the bank export — check the file.',
    );
  }

  const warnings = [];
  if (bad.length) warnings.push(`${bad.length} row(s) skipped: fewer than 11 columns.`);

  const transactions = rows
    .filter((r) => r.length >= 11)
    .map((r, i) => {
      const ts = parseTimestamp(r[COL.timestamp]);
      if (!ts) warnings.push(`Row ${i + 1}: could not read the timestamp "${unwrap(r[COL.timestamp])}".`);
      return {
        row: i + 1,
        postDate: unwrap(r[COL.postDate]),
        type: unwrap(r[COL.type]),
        txnId: unwrap(r[COL.txnId]),
        bankRef: unwrap(r[COL.bankRef]),
        timestamp: ts,
        payer: unwrap(r[COL.payer]),
        channel: unwrap(r[COL.channel]),
        debit: num(r[COL.debit]),
        credit: num(r[COL.credit]),
        balance: num(r[COL.balance]),
      };
    });

  // The running balance reconciles exactly in a correct parse, so a mismatch
  // means the columns were misread. Refusing to match beats matching on
  // garbage.
  let balanceOk = true;
  let balanceError = null;
  for (let n = 1; n < transactions.length; n++) {
    const expected = transactions[n - 1].balance + transactions[n].credit - transactions[n].debit;
    if (Math.abs(expected - transactions[n].balance) > 0.005) {
      balanceOk = false;
      balanceError =
        `Row ${transactions[n].row}: balance does not reconcile ` +
        `(expected ${expected.toFixed(2)}, file says ${transactions[n].balance.toFixed(2)}). ` +
        'The file may be a partial export, out of order, or a different format.';
      break;
    }
  }

  // Only money IN can pay for an order. In the real sample just 1 of 8 rows
  // qualified — filtering here keeps debits and ATM withdrawals out of the
  // candidate list entirely.
  const credits = transactions.filter((t) => t.credit > 0 && /credit/i.test(t.type));

  return { transactions, credits, warnings, balanceOk, balanceError };
}

// ---------------------------------------------------------------- matching

/** Normalise a reference for comparison: strip anything non-alphanumeric. */
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Similarity between an OCR'd reference and a transaction's fields.
 * Ranking only — never promotes a non-candidate.
 */
export function referenceScore(orderRef, txn) {
  const a = norm(orderRef);
  if (a.length < 4) return 0;

  const fields = [txn.txnId, txn.bankRef].map(norm);
  for (const b of fields) {
    if (!b) continue;
    if (a === b) return 100;
    if (b.includes(a) || a.includes(b)) return 85;

    // Tolerate a couple of OCR slips in an otherwise matching string.
    if (Math.abs(a.length - b.length) <= 2) {
      const len = Math.min(a.length, b.length);
      let same = 0;
      for (let i = 0; i < len; i++) if (a[i] === b[i]) same++;
      const ratio = same / Math.max(a.length, b.length);
      if (ratio >= 0.8) return Math.round(ratio * 80);
    }
  }
  return 0;
}

/**
 * Candidate transactions for one order.
 *
 * A transaction qualifies only when ALL hold:
 *   - it is money in (already filtered by parseStatement)
 *   - the amount matches the order total exactly
 *   - its timestamp is within `windowHours` of the receipt upload
 *   - it is not already allocated to another order
 *
 * Results are ranked by reference similarity, then by time proximity.
 * Ranking orders the list; it never adds or auto-selects.
 */
export function findCandidates(order, credits, { windowHours = 24, allocated = new Set() } = {}) {
  const anchor = order.receipt_uploaded_at
    ? new Date(order.receipt_uploaded_at)
    : new Date(order.created_at);
  const windowMs = windowHours * 3600 * 1000;
  const totalMvr = order.total_cents / 100;

  return credits
    .filter((t) => {
      if (allocated.has(t.txnId)) return false;
      if (Math.abs(t.credit - totalMvr) > 0.005) return false;
      if (!t.timestamp) return false;
      return Math.abs(t.timestamp - anchor) <= windowMs;
    })
    .map((t) => ({
      txn: t,
      refScore: referenceScore(order.payment_reference, t),
      minutesApart: Math.round(Math.abs(t.timestamp - anchor) / 60000),
    }))
    .sort((a, b) => b.refScore - a.refScore || a.minutesApart - b.minutesApart);
}

/** Human summary of why matching is or is not confident. */
export function matchQuality(candidates) {
  if (candidates.length === 0) return { level: 'none', text: 'No matching transfer found' };
  if (candidates.length === 1) {
    return candidates[0].refScore >= 85
      ? { level: 'strong', text: 'One match, reference agrees' }
      : { level: 'single', text: 'One match on amount and time' };
  }
  if (candidates[0].refScore >= 85 && candidates[1].refScore < 85) {
    return { level: 'strong', text: `${candidates.length} candidates, one reference matches` };
  }
  return { level: 'ambiguous', text: `${candidates.length} possible transfers — check carefully` };
}
