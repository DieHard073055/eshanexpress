# EshanExpress — Architecture Plan

A static marketplace storefront hosted on GitHub Pages, with Supabase as a thin
transactional layer. Catalog is baked at build time; only auth, orders, stock
counts and receipts touch the network.

Design goal: **stay on free tiers until the store makes money**, accepting a
less dynamic catalog as the tradeoff.

---

## 1. Decisions made

| Decision | Choice | Why |
|---|---|---|
| Order intake | Supabase direct | One authoritative system, real order IDs, no fragile Google Form write path |
| Reconciliation | Offline matching workbench | Bank statement never leaves your machine |
| Payment matching | Amount + wide time window; nothing auto-confirms | No mandated reference format, so ambiguity must surface, not be guessed |
| Receipt lifecycle | Confirm → zip → verify → explicit purge | Turns the 1 GB cap into a recycled buffer instead of a hard ceiling |
| Order history | Supabase + RLS (v1); encrypted archive deferred to v2 | Order rows are ~0.05% of free tier per 1,000 orders — not the real constraint |
| Stock | Static total inventory − live Supabase reserved count | Catalog stays static; only the final checkout step is live |
| Receipts | Supabase Storage, no Google account required | Form-based upload would need Google sign-in and kill conversions |
| OCR | Tesseract.js, client-side, advisory only | Pre-fills the reference number; bank statement remains source of truth |
| Store owners | Admin-created accounts; draft products + fulfil own orders | Matches the approve-then-redeploy workflow |
| Supabase key | New `sb_publishable_...` format | Legacy `anon` JWT is being phased out late 2026 |

### Deferred to v2 (designed for, not built)

The encrypted offline order archive. The schema below carries an `archived_at`
column so archived rows can be purged without a migration. When built, it will
use **envelope encryption**: each order encrypted once with a random key, that
key wrapped three times (admin, user, store owner). User key derived from their
password client-side, with an admin-held recovery copy.

Revisit when receipt storage approaches 1GB — that is the limit that actually
binds, roughly 60x sooner than order rows.

---

## 2. Free-tier budget

Verified against Supabase's 2026 free tier.

| Resource | Limit | What uses it | Headroom |
|---|---|---|---|
| Database | 500 MB | Order rows (~250 B each) | ~200,000 orders = 10% |
| **File storage** | **1 GB** | **Receipt images (~300 KB each)** | **~3,000 receipts — binding, but now recyclable** |
| MAU | 50,000 | Logged-in shoppers | Ample |
| Egress | 5 GB/mo | Receipt uploads + API reads | Watch if receipts grow |
| Edge functions | 500k/mo | None in v1 | Unused |

**Two operational risks:**

1. **Receipt storage is the real ceiling** — but the archive-to-Drive flow
   turns it from a hard cap into a recycled buffer. Storage only needs to hold
   receipts for orders not yet confirmed-and-archived, so the practical limit
   is your *unreconciled backlog*, not lifetime order count. Combined with
   client-side downscaling (target ≤150 KB), 1 GB holds a backlog of roughly
   6,000 receipts. You would have to stop reconciling for a very long time to
   hit it.
2. **Free projects pause after one week of inactivity.** A new store with slow
   early traffic can silently break. Mitigation: a scheduled GitHub Actions
   workflow pings the project every 3 days.

---

## 3. Repository layout

```
eshanexpress/
├── .github/workflows/
│   ├── deploy.yml           # build + publish to GitHub Pages
│   └── keepalive.yml        # ping Supabase every 3 days
├── admin-offline/           # runs locally, never deployed
│   ├── products.html        # product entry UI
│   ├── workbench.html       # payment matching + receipt archival
│   └── images/              # source images (committed)
├── data/
│   ├── products.json        # authored offline, committed
│   └── stores.json
├── src/
│   ├── pages/               # storefront, product, cart, checkout, orders
│   ├── lib/                 # supabase client, cart, ocr, stock
│   └── components/
├── scripts/
│   ├── build-catalog.mjs    # products.json + images → static assets
│   └── pull-approved.mjs    # pull approved drafts from Supabase → data/
├── supabase/migrations/
└── dist/                    # build output → GitHub Pages
```

**Stack:** Vite + vanilla JS/TS, no framework. The storefront is mostly static
rendering; a framework would add bundle weight for little gain. Tailwind for
styling.

---

## 4. Data model

Only the tables below live in Supabase. Product content is **not** in Supabase
at runtime — it is baked into the build. `product_drafts` exists purely as an
inbox for store-owner submissions between deploys.

```sql
-- Roles
create type user_role as enum ('customer', 'store_owner', 'admin');

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  role user_role not null default 'customer',
  store_id uuid references stores(id),
  created_at timestamptz default now()
);

create table stores (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null
);

-- Store-owner submissions; invisible to shoppers until approved + redeployed
create table product_drafts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  submitted_by uuid not null references auth.users(id),
  payload jsonb not null,            -- title, description, price, stock, images
  status text not null default 'pending',  -- pending | approved | rejected
  created_at timestamptz default now()
);

-- Orders
create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique not null,  -- human-readable, shown to customer
  user_id uuid not null references auth.users(id),
  store_id uuid not null references stores(id),
  items jsonb not null,               -- [{sku, title, qty, unit_price}]
  total_cents integer not null,
  status text not null default 'awaiting_payment',
    -- awaiting_payment | payment_submitted | confirmed | declined
    -- | fulfilled | cancelled
  payment_reference text,             -- OCR pre-filled, user- and admin-editable
  receipt_path text,                  -- Supabase Storage path
  receipt_uploaded_at timestamptz,    -- anchor for the match time window
  matched_txn_ref text,               -- bank txn you allocated (audit trail)
  matched_at timestamptz,
  decline_reason text,                -- shown to customer on decline
  receipt_archived_at timestamptz,    -- set when zip verified; gates purge
  archived_at timestamptz,            -- v2 order-archive hook; null = live
  created_at timestamptz default now()
);

-- Live stock: reserved counts only. Total inventory is static.
create table stock_reservations (
  sku text primary key,
  reserved integer not null default 0
);
```

**Available stock** = `static_total(sku) − stock_reservations.reserved`,
computed at checkout only. The catalog page shows static totals; the product
page fetches the live delta.

### RLS policies

Every table has RLS enabled. Summary:

- `orders`: customer reads/creates own (`user_id = auth.uid()`); store owner
  reads + updates status on their `store_id`; admin full access.
- `product_drafts`: store owner CRUD own store's pending drafts; admin full.
- `profiles`: self-read; admin full. Role is **not** self-writable.
- `stock_reservations`: public read; writes only via a `security definer`
  function called during checkout, so clients can't set arbitrary values.

---

## 5. Flows

### Catalog publish (offline → live)

```
You author in admin-offline/  →  data/products.json + images (committed)
     ↓
scripts/pull-approved.mjs     →  merges approved store-owner drafts
     ↓
git push                       →  deploy.yml builds, optimises images, publishes
     ↓
GitHub Pages serves static catalog
```

Store-owner drafts are invisible until you approve and redeploy — exactly as
specified.

### Checkout

1. Cart lives in `localStorage`, never in Supabase.
2. At checkout, client re-checks live availability for each SKU.
3. Order row created (`awaiting_payment`), order number shown.
4. Customer pays by bank transfer offline.
5. Customer uploads receipt photo → downscaled client-side → Supabase Storage.
6. Tesseract.js runs in a Web Worker, pre-fills `payment_reference`.
   **The field stays editable — OCR is a convenience, not a control.**
   It is editable again later by you in the workbench, for when OCR failed.
7. `receipt_uploaded_at` is stamped — this anchors the match time window.
8. Status → `payment_submitted`.

### Reconciliation — the matching workbench (you, offline)

Runs in `admin-offline/`, on your machine. **The bank statement is parsed
in-browser and never uploaded, never deployed, never stored in Supabase.**

1. Pull `payment_submitted` orders from Supabase.
2. Drop in the bank statement CSV. Parsed locally — see
   [BANK_STATEMENT_FORMAT.md](./BANK_STATEMENT_FORMAT.md) for the exact
   column spec and parsing hazards. The import is **rejected** if the running
   balance fails to reconcile, since that means the parse is wrong.
3. For each order, the workbench proposes candidate transfers and you decide.
4. Confirmed orders → `confirmed`; unmatched → `declined`.
5. Store owners then mark their own orders `fulfilled`.

#### Candidate matching

Customers use their own transfer reference (no mandated format), so **amount +
time is the primary signal** and the reference is a ranking hint, not a gate.

A transfer is a candidate for an order when all hold:

- Row type is **`Transfer Credit`** — money in. Debits, ATM withdrawals and
  fees are never candidates. (In the sample statement only 1 of 8 rows
  qualified.)
- Amount matches the order total **exactly**
- **Transaction timestamp** (statement col 5) falls within the window of
  receipt upload (default **±24h**, configurable). Note this is the txn time,
  *not* the post date — a transfer on 17 Aug can post on 18 Aug.
- Transfer is **not already allocated** — tracked by txn ID (col 3), which is
  unique and stable

Candidates are then *ranked* by fuzzy similarity between the OCR'd reference
and the transfer's bank reference fields. Ranking only orders the list; it
never promotes a non-candidate or auto-selects.

The payer name (col 6) is **displayed** for every candidate — you will often
recognise repeat customers — but is not matched on automatically, since no
name is collected at checkout.

> **Only one automated signal.** With no store-controlled reference and no name
> matching, amount + time is all the automation there is. This is why the OCR'd
> reference matters as a ranking hint, and why nothing auto-confirms.

Candidates are then *ranked* by fuzzy similarity between the OCR'd reference
and the transfer's reference field. Ranking only orders the list; it never
promotes a non-candidate or auto-selects.

**Nothing auto-confirms.** Even a single unambiguous candidate requires your
click. The workbench shows, side by side:

- the receipt image (full size, zoomable)
- the OCR'd reference, **editable** — you key in the correct value when OCR failed
- every candidate transfer, ranked
- an explicit **Decline** action when no candidate fits

Allocating a transfer marks it consumed for the session, so it cannot be
matched to a second order.

> **Why the window is wide.** Upload time lags the actual transfer — a customer
> may pay at the bank and upload that evening. A ±20min window would silently
> miss those. Default is ±24h; tighten it in settings once real data shows the
> true lag distribution.

> **Known cost of this design.** Without a store-controlled reference format,
> same-priced orders in the same window produce multiple candidates, so manual
> clicks scale with volume. Safe (nothing mis-confirms) but laborious at scale.
> The fix, if it bites: a checksummed reference (e.g. `EX-4417-K`) that
> collapses most ambiguity. Deliberately deferred — revisit if click load hurts.

#### Receipt archival

After orders are `confirmed`, receipts can be moved to cold storage (Drive):

1. Select confirmed orders → workbench downloads receipts as a zip.
2. Zip includes a manifest: order number, filename, size, SHA-256.
3. **You verify** the archive landed in Drive intact.
4. Only then does the explicit *Delete originals* action purge them from
   Supabase Storage, re-verifying checksums immediately before deletion.

Deletion is never automatic. A failed or partial download must never destroy
the only copy of a receipt.

### Order history

Last 10 completed orders cached in `localStorage` for instant load. Anything
older reads from Supabase via RLS. In v2 this read path switches to the
encrypted static archive — the UI does not change.

---

## 6. Security notes

- `sb_publishable_...` key is safe in client code **only because RLS is on
  every table**. RLS correctness is the entire security model.
- The `sb_secret_...` key never enters the repo or the bundle. It lives only in
  GitHub Actions secrets, used by `pull-approved.mjs`.
- Role escalation is blocked: `profiles.role` is not self-writable.
- Receipt images are private by default; access via short-lived signed URLs.
- Stock writes go through a `security definer` function, never direct client
  writes.

---

## 7. Build order

1. **Scaffold** — Vite, Tailwind, repo structure, GitHub Pages deploy workflow.
2. **Catalog pipeline** — `products.json` schema, image optimisation, build script.
3. **Storefront** — listing, search/filter, product page, localStorage cart.
4. **Supabase** — migrations, RLS policies, auth (email/password).
5. **Checkout** — order creation, live stock check, receipt upload, OCR worker.
6. **Order history** — RLS reads + localStorage cache of last 10.
7. **Store-owner portal** — draft submission, own-orders view, mark fulfilled.
8. **Admin** — offline product entry, draft approval.
9. **Matching workbench** (offline) — statement CSV import (positional parser
   per the format spec, balance-reconciliation guard), credit-only filtering,
   candidate ranking, receipt viewer, editable reference, allocate / decline,
   receipt zip + verified purge.
10. **Hardening** — keepalive workflow, RLS test suite, image size budget check.

Steps 1–3 produce a storefront you can click through with zero backend, so you
can see and redirect early.

---

## 8. Open items for later

- **Statement format is now known and specced** — see
  [BANK_STATEMENT_FORMAT.md](./BANK_STATEMENT_FORMAT.md). Timestamps include
  seconds, so the time window is precise. Re-verify the spec if the bank
  changes its export.
- **Timezone.** Assumed the bank's local time matches receipt upload time.
  Confirm if matches near midnight misbehave.
- **Currency, locale, tax.** Not yet specified.
- **Declined orders.** `decline_reason` is stored and shown to the customer,
  but there is no automated refund path — refunds stay manual, as with payment.
- **Revisit if manual click load hurts:** a checksummed payment reference
  (`EX-4417-K`) would collapse most matching ambiguity. Deliberately deferred.

---

## 9. Security model as built (step 4)

RLS is enabled **and forced** on every table. Verified by `tests/rls.test.mjs`,
a 38-case suite that attacks the live project over the public REST API with
the publishable key — the same surface an attacker has.

### Enforcement split

RLS decides **which rows** an identity may touch. It cannot compare old vs new
values, so **which columns** are writable is enforced by `BEFORE UPDATE`
triggers:

| Guard | Enforces |
|---|---|
| `guard_order_customer_update` | Customers may edit only `payment_reference` / receipt fields, only while unpaid. Store owners may only move `confirmed → fulfilled`. |
| `guard_profile_update` | `role` and `store_id` are admin-only — blocks self-elevation. |

### Verified properties

- Anonymous visitors read `stores` and `stock_reservations` only — never
  orders, profiles or drafts.
- A customer cannot read another customer's order, forge `matched_txn_ref`,
  alter `total_cents`, self-confirm, or become admin.
- A store owner sees only their own store's orders, cannot confirm payment
  (only the admin reconciles), and cannot self-approve a draft.
- Trigger functions are not reachable as RPC endpoints.

### Two things that bit, worth remembering

1. **RLS policies evaluate as the calling role, not the table owner.**
   Revoking `EXECUTE` on `is_admin()` from `authenticated` broke every policy
   referencing it (`permission denied for function is_admin`). The helpers
   must stay executable by `authenticated`; they are safe because each takes
   no arguments and reads only the caller's own row.

2. **`auth.uid()` in a policy re-evaluates per row.** All policies wrap it as
   `(select auth.uid())`, which matters once `orders` grows.

### Stock authority (fixed)

`reserve_stock` originally took the inventory total from the client, so a
crafted call could inflate it and over-reserve. **Closed.** The `product_stock`
table now owns totals, synced from the catalog on every deploy by
`scripts/sync-stock.mjs` using the secret key. The RPC takes only `(sku, qty)`;
the old three-argument signature no longer exists, and a test asserts that.

`reserve_cart(items)` reserves a whole cart in one transaction and rolls back
**every** line if any line fails, so a failed checkout cannot strand partial
reservations. SKUs are locked in sorted order to avoid deadlocks between
concurrent carts.

The sync never deletes a delisted SKU that still has live reservations —
doing so would silently free stock held by an open order.

### Preorder items

Items sourced from overseas carry `leadTimeDays` and a `maxPerOrder` soft cap
in `products.json`. Stock behaves normally; only the presentation differs:

- Listing card: a "Preorder" badge and "Ships in about N weeks"
- Product page: a notice explaining payment is taken now
- Cart: a per-line badge, plus a banner stating the whole order ships together
  at the pace of its slowest item

Lead-time wording is derived from `leadTimeDays`, so it cannot be forgotten in
an individual product description. `maxPerOrder` is enforced in three places:
the quantity input, `cart.resolve()`, and `reserve_cart` server-side.

> **Policy assumption to confirm:** the cart says a mixed order "ships
> together" at the slowest item's pace. If you would rather split shipments,
> the wording and the fulfilment flow both need changing.

### Outstanding

- **Leaked password protection is disabled.** Enable it in the dashboard:
  Authentication → Providers → Password → "Check against HaveIBeenPwned".
  Free, and blocks known-breached passwords at signup.


---

## 10. Store-owner capture (extension)

A seller signs into the browser extension and submits captures as
`product_drafts` for the admin to review. No local tooling on their side.

- Draft images go to the private `draft-images` bucket, pathed
  `<store_id>/<draft_id>/<file>`, so RLS scopes them by the first segment
- A `before insert` trigger enforces **50 pending drafts** and **100 MB** per
  store. Storage is shared with payment receipts, and a full bucket would stop
  customers proving payment — the quota protects that, not the seller.
- The extension holds only the publishable key, which is RLS-gated

Verified live: a draft arrives `pending`, an image uploads to the store's own
folder, an upload to another store's folder is refused (400), and an owner
cannot self-approve.

### Known gap: orphaned draft images

Deleting or approving a draft does not remove its images from Storage. They
accumulate against the store's quota until cleaned up manually. A cleanup
pass belongs in the admin approval flow — worth doing before onboarding
sellers in volume, not urgent for one or two.
