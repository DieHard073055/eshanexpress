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

1. Drop images into `admin-offline/images/`.
2. Add an entry to `data/products.json`.
3. `npm run catalog` — validation fails the build on bad data.
4. Commit and push; GitHub Actions deploys.

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
| 4. Supabase project + client | done (auth UI next) |
| 5. Checkout + receipt upload + OCR | not started |
| 6. Order history | not started |
| 7. Store-owner portal | not started |
| 8. Admin (offline) | not started |
| 9. Matching workbench (offline) | not started |

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
