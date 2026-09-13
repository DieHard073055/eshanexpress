# Bank Statement CSV Format

Derived from a real export. **No header row.** 11 columns, positional.
Several fields use an Excel-injection wrapper: `=""VALUE""`, which parses as
the literal string `="VALUE"` and must be unwrapped.

| # | Field | Example | Notes |
|---|---|---|---|
| 0 | Post date | `2026/08/16` | `YYYY/MM/DD`. **Can differ from txn date** |
| 1 | Value date | `2026/08/16` | Usually same as 0 |
| 2 | Type | `Transfer Credit` | **Credit = money in.** Filter on this |
| 3 | Txn ID | `="BLAZ000000000000"` | Unique per txn — use as allocation key |
| 4 | Bank ref | `="FT00000X00XX\B00"` | Contains a backslash |
| 5 | **Txn timestamp** | `01-01-2026 12-00-00` | **`DD-MM-YYYY HH-MM-SS`** — dashes, not colons |
| 6 | Counterparty | `="AAAAAA BBBBB"` | **Payer name — the strongest matching signal** |
| 7 | Channel | `Internet Banking` | |
| 8 | Debit | `10` | Money out. Empty when credit |
| 9 | **Credit** | `1000` | **Money in. Empty when debit** |
| 10 | Balance | `1000.00` | Running balance |

## Parsing hazards

1. **No header row** — columns are positional only.
2. **`=""X""` wrapper** on cols 3, 4, 6. Strip `="` and `"`.
3. **Col 5 is `DD-MM-YYYY`, col 0 is `YYYY/MM/DD`** — two different orders in
   one row. Parsing col 5 as `MM-DD` silently yields wrong dates for any day
   ≤ 12, shifting transactions by months.
4. **Col 5 time uses `HH-MM-SS`**, not `HH:MM:SS`. `Date.parse` fails on it.
5. **Mixed date formats within col 5** — the ATM row is `YYYY-MM-DD` while
   every transfer row is `DD-MM-YYYY`. Detect per row, never assume.
6. **Txn date can precede post date** (txn 17 Aug → posted 18 Aug). Always
   window on col 5, never col 0.
7. Debit/credit are **separate columns**, not a signed amount.
8. Amounts may be bare integers (`10000`) or decimal (`3471.91`).

## Validation

The running balance reconciles exactly across the sample:
`balance[n] = balance[n-1] + credit[n] - debit[n]`

The importer asserts this on load. A mismatch means the parse is wrong (or
rows are out of order) and the import is rejected rather than silently
producing bad matches.

## Implications for matching

- **Filter to `Transfer Credit` only.** In the sample just 1 of 8 rows is money
  in. Debits, ATM withdrawals and fees must never appear as candidates.
- **Payer name (col 6) is the best signal available.** Since customers use
  their own reference, and cols 3/4 are bank-generated (meaningless to the
  customer), the name is what actually ties a transfer to a person. Fuzzy-match
  it against the account holder's name.
- **Col 3 is the allocation key** — stable and unique, stored in
  `orders.matched_txn_ref` so a transfer can never be allocated twice.
- Timezone is assumed to be the bank's local time, same as receipt upload time.
  Worth confirming if matches near midnight behave oddly.
