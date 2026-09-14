# EshanExpress

A static marketplace storefront on GitHub Pages. The catalog is baked at build
time; only auth, orders and receipts touch the network.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Requirements

Node 20+ (`.nvmrc` pins 20.20.2 — run `nvm use`).

## Supabase

Project `eshanexpress` (`wcnaiywglzpudivwxjss`), region ap-south-1 (Mumbai),
free tier. The CLI is linked — `supabase` commands target it directly.

Copy `.env.example` to `.env` and fill in the URL and publishable key from
the dashboard (Settings → API). Both values are public and ship in the
bundle; that is safe **only because RLS is enabled on every table**.

> **Free projects pause after ~7 days of inactivity.** `.github/workflows/keepalive.yml`
> pings every 3 days to prevent this. It needs repo secrets `SUPABASE_URL`
> and `SUPABASE_PUBLISHABLE_KEY`.

## Commands

```bash
npm install
npm run dev       # build catalog + dev server
npm run build     # build catalog + production bundle to dist/
npm test          # cart logic tests
npm run catalog   # rebuild catalog only
```

## Adding products

```bash
npm run admin
```

Opens the product editor at http://127.0.0.1:4321 — a local page that writes
directly to `data/products.json` and `admin-offline/images/`. It binds to
loopback only and is never deployed.

1. Add or edit products; drag images straight onto the form.
2. Validation mirrors the build exactly, so a save can never break `npm run build`.
3. Save, then `npm run build`, then commit and push to publish.

The **Drafts** tab pulls pending submissions from store owners, so you can add
images and a SKU before approving them into the catalog.

Editing `data/products.json` by hand still works — the editor is a convenience,
not a lock-in.

Prices are **integer cents** (`34900` = MVR 349.00). Never use floats for money.

### Preorder items

For goods ordered from overseas, add two fields:

```json
{ "sku": "EX-4001", "stockTotal": 15, "leadTimeDays": 35, "maxPerOrder": 2 }
```

- `leadTimeDays` drives all preorder messaging automatically (badges on the
  card, product page, and cart) — you never write it in the description.
- `maxPerOrder` caps how many one customer can order at once.
- `stockTotal` is your soft cap: how many you are willing to source.

`stockTotal: 0` still means **sold out**, not preorder.

### Product variants

A product can offer options (Colour, Size, …) where each combination has its
own price and stock. Add `options` and `variants` instead of a flat
`priceCents`/`stockTotal` — see [docs/VARIANTS.md](docs/VARIANTS.md).

Each variant is its own SKU to the database, so stock reservation, checkout
and the workbench needed no changes. The parent SKU is never orderable.

### Stock authority

The database owns inventory at checkout. `scripts/sync-stock.mjs` pushes
totals to Supabase on every deploy; `reserve_cart()` reads them and accepts
no total from the client. The deploy needs a `SUPABASE_SECRET_KEY` repo
secret — without it the sync is skipped with a warning and checkout uses
whatever totals the database already holds.

## What is built

| Step | Status |
|---|---|
| 1. Scaffold + deploy workflow | done |
| 2. Catalog pipeline | done |
| 3. Storefront (listing, product, cart) | done |
| 4. Supabase schema, RLS, auth | done |
| 5. Checkout + receipt upload + OCR | done |
| 6. Order history | done |
| 7. Store-owner portal | done |
| 8. Admin product entry (offline) | done |
| 9. Matching workbench (offline) | done |

## Payment workbench (offline)

Open `admin-offline/workbench.html` locally — it is never deployed. On first
run it asks for your Supabase URL and publishable key and stores them in that
browser.

1. Sign in with your admin account.
2. Drop in the bank statement CSV. It is parsed **in the browser** and never
   uploaded, never stored in Supabase.
3. For each order, pick the matching transfer and confirm, or decline with a
   reason the customer will see.

The import is **rejected** if the running balance does not reconcile, since
that means the columns were misread. Only `Transfer Credit` rows can match.
Nothing auto-confirms — Confirm stays disabled until you pick a transfer. A
transfer allocated to one order disappears from every other order's
candidates, so one payment can never settle two orders.

## Deployment

Push to `main`. The workflow builds with `BASE_PATH=/<repo-name>/` and publishes
to Pages. Enable Pages → Source → **GitHub Actions** in repo settings first.

For a user/org page (`<user>.github.io`), set `BASE_PATH: /` in
`.github/workflows/deploy.yml`.

## Notes

- **Hash routing** (`#/product/EX-1001`) is deliberate — GitHub Pages 404s on
  unknown paths, which would break deep links and refreshes.
- **Cart is localStorage only**, never synced to Supabase. It stores SKU + qty
  only, so prices refresh from the catalog on each deploy.
- **Never commit bank statements.** `.gitignore` excludes `*statement*.csv`.
