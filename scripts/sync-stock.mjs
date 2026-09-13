/**
 * Push inventory totals from the static catalog into Supabase.
 *
 * The database is the authority on stock at checkout — reserve_cart() reads
 * product_stock and accepts no total from the client. This script keeps that
 * table in step with the catalog on every deploy.
 *
 * Requires the SECRET key (bypasses RLS). It runs only in CI and never in
 * the browser bundle.
 *
 *   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/sync-stock.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'public', 'stock-manifest.json');

const URL = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;

if (!URL || !SECRET) {
  console.error('\n  SUPABASE_URL and SUPABASE_SECRET_KEY are required.\n');
  process.exit(1);
}
if (!existsSync(MANIFEST)) {
  console.error('\n  stock-manifest.json not found — run `npm run catalog` first.\n');
  process.exit(1);
}

const items = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(items) || items.length === 0) {
  console.error('\n  Manifest is empty — refusing to sync.\n');
  process.exit(1);
}

const headers = {
  apikey: SECRET,
  Authorization: `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
};

async function api(path, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const rows = items.map((i) => ({
  sku: i.sku,
  total: i.total,
  lead_time_days: i.leadTimeDays,
  max_per_order: i.maxPerOrder,
  updated_at: new Date().toISOString(),
}));

// Upsert every SKU in one call.
await api('product_stock?on_conflict=sku', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});

// Remove SKUs no longer in the catalog, but never touch one that still has
// live reservations — that would silently free stock held by open orders.
const existing = await api('product_stock?select=sku');
const current = new Set(rows.map((r) => r.sku));
const stale = existing.map((r) => r.sku).filter((s) => !current.has(s));

let removed = 0;
let skipped = [];
if (stale.length) {
  const reserved = await api(
    `stock_reservations?select=sku,reserved&sku=in.(${stale.map(encodeURIComponent).join(',')})`,
  );
  const held = new Set(reserved.filter((r) => r.reserved > 0).map((r) => r.sku));

  const deletable = stale.filter((s) => !held.has(s));
  skipped = stale.filter((s) => held.has(s));

  if (deletable.length) {
    await api(`product_stock?sku=in.(${deletable.map(encodeURIComponent).join(',')})`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });
    removed = deletable.length;
  }
}

const preorder = rows.filter((r) => r.lead_time_days).length;
console.log(`\n  Stock synced — ${rows.length} SKUs (${preorder} preorder), ${removed} removed`);
if (skipped.length) {
  console.log(`  Kept ${skipped.length} delisted SKU(s) with live reservations: ${skipped.join(', ')}`);
}
console.log('');
