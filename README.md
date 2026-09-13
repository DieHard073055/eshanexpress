# EshanExpress

A static marketplace storefront on GitHub Pages. The catalog is baked at build
time; only auth, orders and receipts touch the network.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Requirements

Node 20+ (`.nvmrc` pins 20.20.2 — run `nvm use`).

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

## What is built

| Step | Status |
|---|---|
| 1. Scaffold + deploy workflow | done |
| 2. Catalog pipeline | done |
| 3. Storefront (listing, product, cart) | done |
| 4. Supabase auth | not started |
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
