# EshanExpress — Release Plan

Implementation spec for the work between here and a public release.

**Audience:** an implementing agent. Written to be executed without further
questions. Where a decision was already made by the owner, it is marked
**DECIDED** and must not be relitigated.

**Reviewer:** the changes will be tested against this document, so every task
states how it is verified.

---

## 0. Ground rules

These follow from decisions already made. Breaking one is a bug, not a
tradeoff.

1. **The catalog stays static.** Products are baked into `public/catalog/` at
   build time by `scripts/build-catalog.mjs` and served from GitHub Pages.
   Nothing added here may make the storefront read products from Supabase at
   runtime.
   **DECIDED:** store-owner product edits go through
   *submit → admin approves → rebuild → deploy*, exactly like a new product
   draft. Not live edits.

2. **Supabase holds as little as possible** — auth, orders, stock counts,
   receipts, drafts. Store decoration (§2) is the one new exception, and it
   holds only two image paths plus short text per store.

3. **RLS is the whole security model.** The publishable key ships in the
   bundle. Every new table and bucket gets RLS `enable`d *and* `force`d, with
   policies written in the existing style:
   - helpers `is_admin()`, `auth_role()`, `auth_store_id()` already exist and
     must stay `EXECUTE`able by `authenticated`
   - wrap `auth.uid()` as `(select auth.uid())` in policies — it re-evaluates
     per row otherwise
   - RLS decides *which rows*; use a `BEFORE UPDATE` trigger for *which
     columns* (see `guard_profile_update`)

4. **Money is integer cents.** Never floats. Never a formatted string in the
   database.

5. **Mobile first.** Every new screen is designed at 375px first and widened
   with `sm:`/`md:`/`lg:`. The global `min-width: 0` reset in
   `src/styles.css` is load-bearing — do not remove it. No new screen may
   introduce horizontal page scroll.

6. **Tests are the contract.** `npm test` must pass. Security claims are
   proved by tests that attack the live project over REST with the
   publishable key (see `tests/rls.test.mjs`,
   `tests/store-portal.test.mjs`), not by reading the UI.

---

## 1. Storefront redesign (AliExpress/Temu-style)

The site has **no categories or tags** and will not gain them. Stores are the
only taxonomy. The redesign leans on that rather than faking categories.

### 1.1 Home page

`src/pages/listing.js` currently renders "All products" with a category chip
row that never has categories in it: every product in `data/products.json`
carries `"categories": []`, so `categoriesOf()` returns `[]` and only the
"All" chip and the "In stock" toggle ever appear.

Replace the home view (`route('/')`) with:

1. **Store strip** — horizontally scrollable row of store cards at the top,
   each showing the store's logo, name, and product count. Tapping one goes
   to `#/store/:slug` (§1.2). On `sm:` and wider it becomes a grid rather
   than a scroller.
2. **Product grid** below it — the existing `productCard` grid, unchanged in
   behaviour, still honouring `?q=`, `?store=`, `?sort=`, `?stock=1`.
3. **Drop the category chip row entirely.** Keep the "In stock" toggle and
   the sort control. Remove `categoriesOf` from the import if nothing else
   uses it.

Density should read like a marketplace: 2 columns at 375px (already the
case), 3 at `sm:`, 4 at `lg:`. Keep `line-clamp-2` titles and bold prices.

### 1.2 Public store page — NEW

New route `route('/store/:slug', storefrontPage)` in `src/main.js`, new file
`src/pages/storefront.js`.

> **Naming:** `/store` (no slug) is the *owner portal* and already exists in
> `src/pages/store.js`. Do not merge the two. The public page is a different
> file with a different name to keep that distinction obvious.

Renders, from the baked catalog only:
- banner image (16:9 on mobile, wider on desktop), logo, store name, blurb
- product count
- that store's products in the standard grid

A slug with no matching store renders the same "not found" card style used
by `productPage`.

`src/components/layout.js` `header()` links the wordmark to `#/`; no nav
changes needed.

### 1.3 Verification

- At 375px, `document.documentElement.scrollWidth - clientWidth === 0` on
  `#/`, `#/store/<slug>`, and every existing route.
- A store with no banner/logo yet renders a neutral placeholder, not a
  broken image.
- `#/store/does-not-exist` shows the not-found card.

---

## 2. Store decoration (banner + logo)

### 2.1 Schema

New migration `supabase/migrations/<timestamp>_store_decoration.sql`:

```sql
alter table stores
  add column banner_path text,
  add column logo_path   text,
  add column blurb       text;
```

`blurb` moves into the database so an owner can edit it; `data/stores.json`
remains the build-time source and is reconciled in §2.4.

Owners may update **only their own store** and **only these three columns**.
RLS cannot compare columns, so:

- policy `stores_owner_update`: `for update to authenticated`
  `using (auth_role() = 'store_owner' and id = (select auth_store_id()))`
  with the same `with check`
- trigger `guard_store_owner_update` (`BEFORE UPDATE ON stores`): if the
  caller is not admin, raise unless `slug`, `name`, `created_at` and `id` are
  unchanged. Model it on `guard_profile_update`.

Keep `stores_admin_write` and `stores_read_all` as they are.

### 2.2 Storage

New bucket `store-assets`, **public read** (these are public storefront
images; a signed URL on every card would be pointless and slow).

Policies, mirroring `draft-images`:
- insert/update/delete: `authenticated`, where
  `(storage.foldername(name))[1] = (select auth_store_id())::text`, or admin
- select: public

Path shape: `{store_id}/banner.<ext>` and `{store_id}/logo.<ext>`.

Enforce client-side before upload, and state in the UI:
- accept `image/jpeg`, `image/png`, `image/webp` only
- banner ≤ 2 MB, logo ≤ 1 MB
- downscale in-browser before upload (banner ≥ 1600px wide, logo 512×512) —
  reuse the approach already used for receipt downscaling

> Storage is shared with receipts against the 1 GB free-tier cap. Two images
> per store is negligible, but **replacing** an image must delete the old
> object, or it accumulates. Overwrite at a stable path (`banner.webp`) so
> replacement is idempotent.

### 2.3 Owner UI

In the owner portal, new tab/section "Store profile":
- current banner and logo previews
- file pickers with the limits stated in the UI
- blurb textarea (max 200 chars, counter shown)
- save button; success and failure both reported inline

### 2.4 Getting decoration into the static build

The storefront reads the **baked catalog**, not Supabase, so decoration must
reach `public/catalog/` at build time.

Add to `scripts/build-catalog.mjs`: when `SUPABASE_URL` and
`SUPABASE_SECRET_KEY` are present, fetch `stores` and merge
`banner_path`/`logo_path`/`blurb` onto the matching `data/stores.json` entry
by `slug`, download each image, and emit it through the existing image
pipeline into `public/catalog/img/stores/<slug>/`.

Rules:
- **absent credentials must not fail the build** — fall back to
  `data/stores.json` alone and `warn()`. Local `npm run catalog` has no
  secret key and must keep working.
- a store row with no `banner_path` is not an error
- a download failure is a `warn()`, not a `fail()` — a broken banner must not
  block a deploy that also carries product changes

`.github/workflows/deploy.yml` already exposes `SUPABASE_SECRET_KEY` to the
stock-sync step; the build step needs the same two env vars added.

### 2.5 Verification

- Owner A cannot write store B's row (REST, 403/0 rows) — new test in
  `tests/store-portal.test.mjs`.
- Owner cannot change `slug` or `name` on their own store (trigger raises).
- Owner cannot upload to `store-assets/{other_store_id}/…`.
- `npm run catalog` with no Supabase env vars still succeeds and warns.
- After a banner upload and rebuild, the image appears under
  `public/catalog/img/stores/<slug>/` and on `#/store/<slug>`.

---

## 3. Store owner product management

An owner sees their own live products and requests changes. **DECIDED:**
changes are requests, reviewed by the admin, applied at the next build.

### 3.1 Where the owner's product list comes from

The owner portal already loads the catalog (`loadCatalog()` in
`src/pages/store.js`). Filter `data.products` by
`p.storeSlug === profile.stores.slug`. No new query, no new table.

### 3.2 Edit requests

Reuse `product_drafts` rather than adding a table. Add a nullable column:

```sql
alter table product_drafts add column target_sku text;
```

- `target_sku IS NULL` → a **new product** (today's behaviour, unchanged)
- `target_sku` set → an **edit request** against that catalog SKU

The `payload` of an edit request carries only the fields being changed, plus
a `kind` discriminator:

```json
{ "kind": "edit", "priceCents": 19000, "stockTotal": 8,
  "description": "…", "hidden": false }
```

Editable by an owner: `priceCents`, `stockTotal`, `description`, `hidden`.
Everything else (title, images, options, variants, sku, storeSlug) is
admin-only and must be rejected if present — validate on the client *and*
assert in a test that a crafted payload is not silently honoured by the
approval flow.

Existing RLS on `product_drafts` already scopes insert/select/update to the
owner's store and forbids self-approval. Add to the insert policy that
`target_sku`, when present, must belong to a product of that store — this
cannot be checked in SQL against a static catalog, so **enforce it at
approval time in the admin editor** and cover it with a test that an owner
submitting a `target_sku` from another store is rejected by the admin flow.

### 3.3 Hidden products

**DECIDED:** hidden means *fully unorderable*, not merely delisted.

1. `data/products.json` gains an optional `"hidden": true` per product.
2. `scripts/build-catalog.mjs` omits hidden products from `catalog.json`
   and `index.json` entirely — they simply are not in the shipped catalog.
3. Because they are absent from the catalog, `scripts/sync-stock.mjs` already
   treats their SKUs as delisted and drops the stock rows, so a stale cart
   cannot reserve them. **Its existing guard (line ~67) keeps any delisted
   SKU that still has live reservations** — verify hiding a product with an
   open order takes that branch and leaves the reservation intact. No change
   to that file is expected; if one proves necessary, preserve the guard.
4. A direct link to a hidden product's SKU hits the existing "Product not
   found" card, which is the correct outcome.

### 3.4 Admin approval

`admin-offline/products.html` currently handles `kind: new` drafts only.
Extend the Drafts tab:

- render edit requests differently from new products: show
  **current value → requested value** per field, so the admin is approving a
  diff, not re-reading a product
- approving an edit applies the changed fields onto the matching product in
  `data/products.json` (match on `sku === target_sku`), marks the draft
  `approved`, and leaves the file dirty for the usual save-and-commit step
- reject works as it does today
- **reuse `cleanupDraftImages()`** — an edit request usually has no images,
  but the call must still run so the path stays uniform

Guard rails in the approval handler:
- refuse a `target_sku` that is not in `data/products.json`
- refuse a `target_sku` whose `storeSlug` does not match the submitting
  store
- ignore any payload key outside the editable set in §3.2

### 3.5 Verification

- Owner submits an edit for their own product → appears in admin Drafts as a
  diff → approving mutates only the intended fields in `data/products.json`.
- Owner submits `target_sku` belonging to another store → admin flow refuses.
- Owner submits `{"title": "…"}` → title is not applied.
- A product marked hidden disappears from `catalog.json`, `index.json`, and
  `#/`; its direct URL shows not-found.
- Hiding a product that has a live reservation sets stock 0 and warns rather
  than deleting the row.
- `npm test` green.

---

## 4. Order analytics for store owners

Read-only, computed from rows the owner can already see. No new table, no
new RPC, no schema change.

### 4.1 What to show

On the owner portal, above the order queue:

| Metric | Definition |
|---|---|
| Revenue this month | Σ `total_cents` where `status = 'fulfilled'` and `fulfilled_at` ≥ start of current month |
| Orders this month | count of the same set |
| Revenue all time | Σ `total_cents` where `status = 'fulfilled'` |
| Orders all time | count of the same set |
| Awaiting action | count where `status IN ('confirmed','ready_for_pickup','shipped')` |

**Only `fulfilled` counts as revenue.** `confirmed` means paid but not yet
handed over; counting it would overstate earnings and, worse, would move
backwards when an order is later declined or cancelled. State this in the UI
in one short line so the number is not mistaken for cash received.

Month boundary is the **viewer's local month**, computed client-side from
`fulfilled_at`. Do not introduce a timezone column for this.

### 4.2 Implementation

One query, reusing the existing pattern in `storePage()`:

```js
supabase.from('orders')
  .select('total_cents, status, fulfilled_at, created_at')
```

RLS already restricts this to the owner's store. Aggregate in JS. Format
with `formatCents` from `src/lib/money.js` — never hand-roll currency
formatting.

If the store has no fulfilled orders, show a zero state ("No completed
orders yet"), not `MVR 0.00` in large type.

### 4.3 Verification

- An owner's totals reflect only their own store's orders (a second store's
  fulfilled order must not move them) — test in
  `tests/store-portal.test.mjs`.
- A `confirmed` order does not count toward revenue; it does count toward
  "awaiting action".
- Zero state renders when there are no fulfilled orders.

---

## 5. Store owner onboarding

Today only an admin can create a `store_owner`: there is no signup path, and
`handle_new_user()` makes every new account a `customer`.

**Do not** let a user self-assign `store_owner` — `guard_profile_update`
blocks it and must keep blocking it.

### 5.1 Application flow

New table:

```sql
create table store_applications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  store_name   text not null,
  contact      text not null,
  note         text,
  status       draft_status not null default 'pending',
  review_note  text,
  created_at   timestamptz not null default now()
);
```

RLS (`enable` + `force`):
- applicant may insert their own row (`user_id = (select auth.uid())`,
  `status = 'pending'`) and select their own
- admin may select and update all
- nobody may update their own row once submitted (prevents flipping
  `status`)

One pending application per user: partial unique index on `user_id` where
`status = 'pending'`.

### 5.2 Customer-facing

A signed-in customer gets a "Sell on EshanExpress" entry on `#/account`
leading to a short form. After submitting, that page shows the application's
status and any `review_note`.

### 5.3 Admin side

Approval is **deliberately manual and offline** — creating a store owner
means creating a `stores` row and elevating a profile, which is exactly the
kind of privileged action that should not sit behind a web button.

Add a section to the admin editor listing pending applications with, for
each, the exact SQL to run (store insert + profile update), plus a button to
mark the application approved or rejected with a note.

Document the two statements in `docs/ARCHITECTURE.md` so the step is
repeatable.

### 5.4 Verification

- A customer can submit exactly one pending application.
- A customer cannot update their application's `status` (REST attack test).
- A customer cannot read another user's application.
- Approving in the admin editor sets status and note; it does **not** by
  itself grant the role.

---

## 6. Legal pages

Static content, no backend. New routes and one file each under
`src/pages/legal.js`, linked from the footer:

- `#/terms` — Terms of Service
- `#/privacy` — Privacy Policy
- `#/returns` — Returns & Refunds

Content must state plainly, and accurately for this system:

**Terms** — what the marketplace is; that stores are independent sellers;
that orders are accepted only after payment is verified against a bank
statement; that stock shown is indicative until checkout.

**Privacy** — what is collected (email, order contents, delivery details,
uploaded payment receipts); that receipts are stored in Supabase Storage and
deleted after reconciliation and archival; that the cart lives in the
browser's `localStorage` and is never sent to the server until checkout;
that OCR of receipts runs **in the browser** and receipt text is not sent to
any third party; how to request deletion.

**Returns** — bank-transfer payments mean refunds are manual; state the
window, the condition requirements, and who pays return delivery.

> These are **drafts for the owner to review**, not legal advice. Put a
> visible `<!-- REVIEW BEFORE LAUNCH -->` comment at the top of each and say
> so in the PR/commit message. Do not invent a company registration number,
> a physical address, or a regulator.

Footer gets the three links plus the existing copyright line, stacked on
mobile.

---

## 7. Receipt upload on mobile

**DECIDED:** receipts are always **screenshots from the banking app**, never
live camera photos. Do not add camera capture.

Consequences for `src/pages/order.js`'s upload step:
- the file input (line ~133) already uses
  `accept="image/*,application/pdf"` with no `capture` attribute, which is
  correct — **keep it that way**. Adding `capture` would force the camera
  on Android and make a screenshot impossible to attach.
- show a preview thumbnail after selection, with a "choose a different
  image" affordance, before the upload is committed
- the existing OTP-detection warning and crop offer must remain reachable
  and usable at 375px
- upload progress and failure must both be visible without scrolling on a
  phone

### 7.1 Verification

At 375px: select an image, see the preview, replace it, upload, see success.
No horizontal scroll at any step. OTP warning still triggers on a receipt
that contains one.

---

## 8. Order of work

Each step ends green (`npm test`) and is committed separately.

1. **§1 storefront redesign** — visible, self-contained, no schema change
2. **§6 legal pages** — static, no dependencies, gets it out of the way
3. **§2 store decoration** — migration + bucket + owner UI + build merge
4. **§3 product management** — the largest piece; depends on §2's owner-portal
   structure
5. **§4 analytics** — small, independent, fits beside §3 in the portal
6. **§5 onboarding** — new table, admin flow
7. **§7 receipt upload polish**

§2 and §3 both touch the owner portal and `build-catalog.mjs`; doing §2
first establishes the tab layout §3 extends.

---

## 9. Definition of done

- [ ] `npm test` passes, including new tests named in each section
- [ ] Zero horizontal overflow at 375px on every route, old and new
- [ ] `npm run catalog` succeeds with **no** Supabase env vars present
- [ ] `npm run build` + `npm run test:build` pass; no secret in the bundle
- [ ] Every new table and bucket has RLS enabled **and** forced
- [ ] Owner-scoped access proved by tests that attack REST with the
      publishable key, not by UI inspection
- [ ] `docs/ARCHITECTURE.md` updated: store decoration, edit-request drafts,
      hidden products, applications table, and the manual owner-approval SQL
- [ ] Legal pages carry the review-before-launch marker

---

## 10. Known gaps deliberately left open

State these in the final summary rather than silently fixing them:

- **Scrambled spec key/values** from the extension's extractor
  (`extension/extract.js` ~line 269) — e.g. key
  `"CategoryEarphones & Headphones"` with value `"Category"` on `CP-947933`.
  Tracked separately; do not fold it into this work.
- **Leaked-password protection** is still off in the Supabase dashboard
  (Authentication → Providers → Password → HaveIBeenPwned). Dashboard-only;
  cannot be enabled from the CLI.
- **Envelope-encrypted order archive** remains a v2 item.
- **No categories or tags**, by choice. Search and store filtering are the
  only discovery mechanisms.
