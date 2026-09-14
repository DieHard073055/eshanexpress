# Product variants

A product can offer options (Colour, Length, "Ships From") where each
combination has its own price and stock.

## Why no database migration

The stock layer is keyed by an opaque `sku` string, and `orders.items` is
untyped JSON. Nothing server-side parses or constrains the SKU format.

So **every variant is simply its own SKU** to the database. `product_stock`,
`reserve_cart`, `stock_reservations` and the workbench all work unchanged.
The change is confined to the catalog schema and the frontend.

## Catalog schema

A product without options is unchanged — `priceCents` and `stockTotal` stay on
the product. Adding `options` and `variants` turns it into a variant product:

```jsonc
{
  "sku": "EX-5001",                  // the product (never ordered directly)
  "title": "KZ EDX Pro Earphones",
  "storeSlug": "eshan-electronics",
  "images": ["edx-1.jpg"],
  "description": "...",

  "options": [                        // display order of the pickers
    { "name": "Colour", "values": ["Black", "Cyan", "Transparent"] },
    { "name": "Mic",    "values": ["With mic", "No mic"] }
  ],

  "variants": [
    {
      "sku": "EX-5001-BLK-MIC",       // what actually goes in the cart
      "choices": { "Colour": "Black", "Mic": "With mic" },
      "priceCents": 11584,
      "stockTotal": 709,
      "image": "edx-black.jpg"        // optional, swaps the hero on select
    }
  ]
}
```

Rules enforced by the build:

- Every variant SKU is unique across the whole catalog, products included
- Every variant's `choices` covers exactly the declared option names
- No two variants share the same combination of choices
- Not every combination need exist — unavailable ones simply have no variant
- `leadTimeDays` and `maxPerOrder` live on the product and apply to all
  variants

## Derived fields

The build computes these so the storefront never recalculates them:

| Field | Meaning |
|---|---|
| `priceFrom` / `priceTo` | Range across in-stock variants; the card shows "from X" |
| `stockTotal` | Sum across variants, so existing out-of-stock logic works |
| `inStock` | True when any variant has stock |

## Frontend

- **Listing card** — shows "from MVR X" when variants differ in price
- **Product page** — one picker per option. A combination with no variant, or
  a sold-out one, is disabled rather than hidden, so the shopper can see it
  exists. Price, stock and image update on selection.
- **Cart** — stores the *variant* SKU. The line shows the chosen options.
- **Checkout** — reserves the variant SKU, exactly as it reserves any SKU.

## Cart migration

Cart lines hold a SKU. When a product gains variants, an old line pointing at
the product SKU no longer resolves — it is reported as stale and removed with
a notice, which is the existing behaviour for a delisted SKU. No new failure
mode, and no silent price substitution.
