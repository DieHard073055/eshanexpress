/**
 * Cart — localStorage only, never synced to Supabase (by design).
 *
 * Stores {sku, qty} pairs only. Prices and titles are resolved from the
 * catalog at read time, so a redeployed price change is picked up rather than
 * being frozen at the moment of adding. A SKU that vanishes from the catalog
 * between deploys is reported as stale rather than silently dropped.
 */

const KEY = 'ex.cart.v1';
const listeners = new Set();

function readRaw() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (l) => l && typeof l.sku === 'string' && Number.isInteger(l.qty) && l.qty > 0,
    );
  } catch {
    // Corrupt or unavailable (private mode, cleared storage) — start empty.
    return [];
  }
}

function writeRaw(lines) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Quota or private mode: the cart stays in memory for this page only.
  }
  for (const fn of listeners) fn();
}

export function onCartChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLines() {
  return readRaw();
}

export function count() {
  return readRaw().reduce((n, l) => n + l.qty, 0);
}

/**
 * Resolve cart lines against the catalog.
 * Returns { items, stale, subtotalCents } where `stale` lists SKUs no longer
 * sold, so the UI can tell the user instead of quietly losing their items.
 */
export function resolve(productsBySku) {
  const items = [];
  const stale = [];

  for (const line of readRaw()) {
    const product = productsBySku.get(line.sku);
    if (!product) {
      stale.push(line.sku);
      continue;
    }
    // Clamp to what the static catalog says exists, and to any per-order cap.
    // Live availability is re-checked server-side at checkout.
    const cap = Math.min(product.stockTotal, product.maxPerOrder ?? Infinity);
    const qty = Math.min(line.qty, Math.max(cap, 0));
    items.push({
      sku: product.sku,
      title: product.title,
      priceCents: product.priceCents,
      qty,
      requestedQty: line.qty,
      clamped: qty < line.qty,
      stockTotal: product.stockTotal,
      maxPerOrder: product.maxPerOrder ?? null,
      leadTimeDays: product.leadTimeDays ?? null,
      thumb: product.thumb ?? product.images?.[0],
      lineTotalCents: product.priceCents * qty,
    });
  }

  return {
    items,
    stale,
    subtotalCents: items.reduce((n, i) => n + i.lineTotalCents, 0),
  };
}

export function add(sku, qty = 1, stockTotal = Infinity) {
  if (!Number.isInteger(qty) || qty < 1) return;
  const lines = readRaw();
  const existing = lines.find((l) => l.sku === sku);
  const max = Number.isFinite(stockTotal) ? stockTotal : Infinity;

  if (existing) existing.qty = Math.min(existing.qty + qty, max);
  else lines.push({ sku, qty: Math.min(qty, max) });

  writeRaw(lines.filter((l) => l.qty > 0));
}

export function setQty(sku, qty) {
  const lines = readRaw();
  const line = lines.find((l) => l.sku === sku);
  if (!line) return;
  if (qty < 1) return remove(sku);
  line.qty = qty;
  writeRaw(lines);
}

export function remove(sku) {
  writeRaw(readRaw().filter((l) => l.sku !== sku));
}

export function clear() {
  writeRaw([]);
}
