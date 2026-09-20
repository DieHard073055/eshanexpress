/**
 * RLS attack suite.
 *
 * Runs against the REAL project over the public REST API with the publishable
 * key — the same surface an attacker has. Every test asserts that something
 * which SHOULD be forbidden actually is.
 *
 * Requires .env with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY,
 * and the rlstest.* users seeded. Skips cleanly if either is missing.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const env = existsSync('.env')
  ? Object.fromEntries(
      readFileSync('.env', 'utf8').trim().split('\n').filter((l) => l.includes('='))
        .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
    )
  : {};

const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const PASSWORD = 'TestPass!2026x';

const USERS = {
  customer:  'rlstest.customer@eshanexpress.test',
  customer2: 'rlstest.customer2@eshanexpress.test',
  owner:     'rlstest.owner@eshanexpress.test',
  admin:     'rlstest.admin@eshanexpress.test',
};

const tokens = {};
const ids = {};

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j).slice(0, 160)}`);
  return { token: j.access_token, userId: j.user.id };
}

/** REST call as a given identity (null = anonymous). */
async function rest(path, { as = null, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  headers.Authorization = `Bearer ${as ? tokens[as] : KEY}`;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: r.status, body: json, raw: text };
}

const configured = Boolean(URL && KEY);

describe('RLS policy enforcement', { skip: configured ? false : 'no .env — skipping live RLS tests' }, () => {
  before(async () => {
    for (const [k, email] of Object.entries(USERS)) {
      const { token, userId } = await signIn(email);
      tokens[k] = token;
      ids[k] = userId;
    }
    const stores = await rest('stores?select=id,slug');
    ids.storeElectronics = stores.body.find((s) => s.slug === 'eshan-electronics').id;
    ids.storeTextiles    = stores.body.find((s) => s.slug === 'island-textiles').id;

    // Provision stock fixtures as admin. The deploy-time sync purges SKUs
    // that are not in the catalog, so the suite must create its own rather
    // than depend on rows surviving between runs.
    await rest('stock_reservations?sku=like.RLS-*', { as: 'admin', method: 'DELETE' });
    await rest('product_stock?sku=like.RLS-*',      { as: 'admin', method: 'DELETE' });
    await rest('product_stock', {
      as: 'admin', method: 'POST', prefer: 'return=minimal',
      body: [
        { sku: 'RLS-CAP',    total: 4,  lead_time_days: null, max_per_order: null },
        { sku: 'RLS-PRE',    total: 15, lead_time_days: 35,   max_per_order: 2 },
        { sku: 'RLS-ATOMIC', total: 9,  lead_time_days: null, max_per_order: null },
      ],
    });
  });

  // ------------------------------------------------------------- anonymous
  test('anonymous can read stores (public storefront needs this)', async () => {
    const r = await rest('stores?select=slug');
    assert.equal(r.status, 200);
    assert.ok(r.body.length >= 2);
  });

  test('anonymous CANNOT read orders', async () => {
    const r = await rest('orders?select=*');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [], 'anonymous must see zero order rows');
  });

  test('anonymous CANNOT read profiles', async () => {
    const r = await rest('profiles?select=*');
    assert.deepEqual(r.body, [], 'anonymous must see zero profile rows');
  });

  test('anonymous CANNOT read product drafts', async () => {
    const r = await rest('product_drafts?select=*');
    assert.deepEqual(r.body, [], 'drafts must never be public');
  });

  test('anonymous CANNOT insert an order', async () => {
    const r = await rest('orders', {
      method: 'POST',
      body: { order_number: `ANON-${Date.now()}`, user_id: ids.customer,
              store_id: ids.storeElectronics, items: [], total_cents: 100 },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  test('anonymous CANNOT call reserve_stock', async () => {
    const r = await rest('rpc/reserve_stock', {
      method: 'POST', body: { p_sku: 'EX-1001', p_qty: 1, p_total: 10 },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  // -------------------------------------------------------------- customer
  test('customer can create an order for themselves', async () => {
    const r = await rest('orders', {
      as: 'customer', method: 'POST', prefer: 'return=representation',
      body: { order_number: `T-${Date.now()}`, user_id: ids.customer,
              store_id: ids.storeElectronics,
              items: [{ sku: 'EX-1001', qty: 1, unit_price: 34900 }],
              total_cents: 34900 },
    });
    assert.equal(r.status, 201, r.raw.slice(0, 200));
    ids.order = r.body[0].id;
  });

  test('customer CANNOT create an order in someone else\'s name', async () => {
    const r = await rest('orders', {
      as: 'customer', method: 'POST',
      body: { order_number: `T-spoof-${Date.now()}`, user_id: ids.customer2,
              store_id: ids.storeElectronics, items: [], total_cents: 100 },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  test('customer CANNOT create an order pre-marked confirmed', async () => {
    const r = await rest('orders', {
      as: 'customer', method: 'POST',
      body: { order_number: `T-conf-${Date.now()}`, user_id: ids.customer,
              store_id: ids.storeElectronics, items: [], total_cents: 100,
              status: 'confirmed' },
    });
    assert.ok(r.status >= 400, 'must not self-confirm at insert');
  });

  test('customer CANNOT see another customer\'s order', async () => {
    const r = await rest(`orders?select=id&id=eq.${ids.order}`, { as: 'customer2' });
    assert.deepEqual(r.body, [], 'order leaked to a different customer');
  });

  test('customer CANNOT change their order to confirmed', async () => {
    await rest(`orders?id=eq.${ids.order}`, {
      as: 'customer', method: 'PATCH', body: { status: 'confirmed' },
    });
    const check = await rest(`orders?select=status&id=eq.${ids.order}`, { as: 'customer' });
    assert.notEqual(check.body[0].status, 'confirmed', 'customer self-confirmed an order');
  });

  test('customer CANNOT alter their order total', async () => {
    await rest(`orders?id=eq.${ids.order}`, {
      as: 'customer', method: 'PATCH', body: { total_cents: 1 },
    });
    const check = await rest(`orders?select=total_cents&id=eq.${ids.order}`, { as: 'customer' });
    assert.equal(check.body[0].total_cents, 34900, 'customer changed the price');
  });

  test('customer CAN set their own payment reference', async () => {
    const r = await rest(`orders?id=eq.${ids.order}`, {
      as: 'customer', method: 'PATCH', prefer: 'return=representation',
      body: { payment_reference: 'FT26230F30WR', status: 'payment_submitted' },
    });
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    assert.equal(r.body[0].payment_reference, 'FT26230F30WR');
  });

  test('customer CANNOT forge reconciliation fields', async () => {
    await rest(`orders?id=eq.${ids.order}`, {
      as: 'customer', method: 'PATCH',
      body: { matched_txn_ref: 'BLAZ999', matched_at: new Date().toISOString() },
    });
    const check = await rest(`orders?select=matched_txn_ref&id=eq.${ids.order}`, { as: 'customer' });
    assert.equal(check.body[0].matched_txn_ref, null, 'customer forged a bank match');
  });

  test('customer CANNOT elevate themselves to admin', async () => {
    await rest(`profiles?id=eq.${ids.customer}`, {
      as: 'customer', method: 'PATCH', body: { role: 'admin' },
    });
    const check = await rest(`profiles?select=role&id=eq.${ids.customer}`, { as: 'customer' });
    assert.equal(check.body[0].role, 'customer', 'PRIVILEGE ESCALATION');
  });

  test('customer CANNOT read other profiles', async () => {
    const r = await rest('profiles?select=id,role', { as: 'customer' });
    assert.equal(r.body.length, 1, 'customer can enumerate other users');
    assert.equal(r.body[0].id, ids.customer);
  });

  test('customer CANNOT write stock reservations directly', async () => {
    const r = await rest('stock_reservations', {
      as: 'customer', method: 'POST', body: { sku: 'HACK-1', reserved: -50 },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  test('customer CANNOT submit a product draft', async () => {
    const r = await rest('product_drafts', {
      as: 'customer', method: 'POST',
      body: { store_id: ids.storeElectronics, submitted_by: ids.customer,
              payload: { title: 'Fake' } },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  // ----------------------------------------------------------- store owner
  test('store owner CAN see orders for their own store', async () => {
    const r = await rest(`orders?select=id&id=eq.${ids.order}`, { as: 'owner' });
    assert.equal(r.body.length, 1, 'owner cannot see their own store order');
  });

  test('store owner CANNOT see orders from another store', async () => {
    const other = await rest('orders', {
      as: 'customer', method: 'POST', prefer: 'return=representation',
      body: { order_number: `T-tex-${Date.now()}`, user_id: ids.customer,
              store_id: ids.storeTextiles, items: [], total_cents: 500 },
    });
    const r = await rest(`orders?select=id&id=eq.${other.body[0].id}`, { as: 'owner' });
    assert.deepEqual(r.body, [], 'cross-store order leak');
  });

  test('store owner CANNOT confirm an order (only admin reconciles)', async () => {
    await rest(`orders?id=eq.${ids.order}`, {
      as: 'owner', method: 'PATCH', body: { status: 'confirmed' },
    });
    const check = await rest(`orders?select=status&id=eq.${ids.order}`, { as: 'owner' });
    assert.notEqual(check.body[0].status, 'confirmed', 'store owner confirmed payment');
  });

  test('store owner CAN submit a draft for their own store', async () => {
    const r = await rest('product_drafts', {
      as: 'owner', method: 'POST', prefer: 'return=representation',
      body: { store_id: ids.storeElectronics, submitted_by: ids.owner,
              payload: { title: 'New Product', priceCents: 1000 } },
    });
    assert.equal(r.status, 201, r.raw.slice(0, 200));
    ids.draft = r.body[0].id;
    assert.equal(r.body[0].status, 'pending');
  });

  test('store owner CANNOT submit a draft for another store', async () => {
    const r = await rest('product_drafts', {
      as: 'owner', method: 'POST',
      body: { store_id: ids.storeTextiles, submitted_by: ids.owner, payload: {} },
    });
    assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
  });

  test('store owner CANNOT self-approve a draft', async () => {
    await rest(`product_drafts?id=eq.${ids.draft}`, {
      as: 'owner', method: 'PATCH', body: { status: 'approved' },
    });
    const check = await rest(`product_drafts?select=status&id=eq.${ids.draft}`, { as: 'owner' });
    assert.equal(check.body[0].status, 'pending', 'store owner self-approved a product');
  });

  // ----------------------------------------------------------------- admin
  test('admin CAN see all orders', async () => {
    const r = await rest('orders?select=id', { as: 'admin' });
    assert.ok(r.body.length >= 2, 'admin cannot see all orders');
  });

  test('admin CAN confirm an order', async () => {
    const r = await rest(`orders?id=eq.${ids.order}`, {
      as: 'admin', method: 'PATCH', prefer: 'return=representation',
      body: { status: 'confirmed', matched_txn_ref: 'BLAZ719464188834',
              matched_at: new Date().toISOString() },
    });
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    assert.equal(r.body[0].status, 'confirmed');
  });

  test('store owner CAN hand off a confirmed order', async () => {
    const r = await rest(`orders?id=eq.${ids.order}`, {
      as: 'owner', method: 'PATCH', prefer: 'return=representation',
      body: { status: 'ready_for_pickup' },
    });
    assert.equal(r.status, 200, r.raw.slice(0, 200));
    assert.equal(r.body[0].status, 'ready_for_pickup');
  });

  test('store owner CANNOT skip straight to completed', async () => {
    // Completion must go through complete_with_code(), which verifies the
    // code the customer presents. See tests/handover.test.mjs.
    await rest(`orders?id=eq.${ids.order}`, {
      as: 'owner', method: 'PATCH', body: { status: 'completed' },
    });
    const check = await rest(`orders?select=status&id=eq.${ids.order}`, { as: 'owner' });
    assert.notEqual(check.body[0].status, 'completed',
      'store owner completed an order without the handover code');
  });

  test('customer CANNOT modify an order once confirmed', async () => {
    const r = await rest(`orders?id=eq.${ids.order}`, {
      as: 'customer', method: 'PATCH', body: { payment_reference: 'CHANGED' },
    });
    const check = await rest(`orders?select=payment_reference&id=eq.${ids.order}`, { as: 'customer' });
    assert.notEqual(check.body[0].payment_reference, 'CHANGED',
      'customer edited a fulfilled order');
  });

  test('admin CAN approve a draft', async () => {
    const r = await rest(`product_drafts?id=eq.${ids.draft}`, {
      as: 'admin', method: 'PATCH', prefer: 'return=representation',
      body: { status: 'approved' },
    });
    assert.equal(r.body[0].status, 'approved');
  });

  // ------------------------------------------------------------ stock RPC
  test('reserve_stock no longer accepts a client-supplied total', async () => {
    // The old vulnerable signature must be gone entirely.
    const r = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST',
      body: { p_sku: 'EX-1001', p_qty: 1, p_total: 999999 },
    });
    assert.ok(r.status >= 400,
      'the 3-argument signature still exists — clients can still inflate the total');
  });

  test('reserve_stock uses the server-side total', async () => {
    const ok = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST', body: { p_sku: 'RLS-CAP', p_qty: 2 },
    });
    assert.equal(ok.body.ok, true, JSON.stringify(ok.body));

    const over = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST', body: { p_sku: 'RLS-CAP', p_qty: 5 },
    });
    assert.equal(over.body.ok, false);
    assert.equal(over.body.reason, 'insufficient_stock');
  });

  test('reserve_stock rejects an unknown sku', async () => {
    const r = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST', body: { p_sku: 'NOT-A-REAL-SKU', p_qty: 1 },
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'unknown_sku');
  });

  test('reserve_stock enforces max_per_order', async () => {
    const r = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST', body: { p_sku: 'RLS-PRE', p_qty: 3 },
    });
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, 'exceeds_max_per_order');
  });

  test('reserve_stock rejects non-positive quantities', async () => {
    const r = await rest('rpc/reserve_stock', {
      as: 'customer', method: 'POST', body: { p_sku: 'RLS-CAP', p_qty: -5 },
    });
    assert.ok(r.status >= 400, 'negative quantity must be rejected');
  });

  test('reserve_cart is all-or-nothing', async () => {
    const before = await rest('stock_availability?select=sku,reserved&sku=eq.RLS-ATOMIC');
    const startReserved = before.body[0]?.reserved ?? 0;

    // Second line exceeds stock, so NOTHING should be reserved.
    const r = await rest('rpc/reserve_cart', {
      as: 'customer', method: 'POST',
      body: { p_items: [{ sku: 'RLS-ATOMIC', qty: 1 }, { sku: 'RLS-CAP', qty: 9999 }] },
    });
    assert.equal(r.body.ok, false, 'cart with an impossible line must fail');

    const after = await rest('stock_availability?select=sku,reserved&sku=eq.RLS-ATOMIC');
    assert.equal(after.body[0].reserved, startReserved,
      'partial reservation leaked from a failed cart');
  });

  test('anonymous cannot call reserve_cart', async () => {
    const r = await rest('rpc/reserve_cart', {
      method: 'POST', body: { p_items: [{ sku: 'RLS-CAP', qty: 1 }] },
    });
    assert.ok(r.status >= 400, 'reserve_cart is callable anonymously');
  });

  test('stock_availability is publicly readable but product_stock is not writable', async () => {
    const read = await rest('stock_availability?select=sku,available&limit=1');
    assert.equal(read.status, 200, 'storefront needs to read availability');

    const write = await rest('product_stock', {
      as: 'customer', method: 'POST', body: { sku: 'HACK-STOCK', total: 99999 },
    });
    assert.ok(write.status >= 400, 'customer wrote to product_stock');
  });

  // ------------------------------------------------- internal functions
  // Trigger functions must never be reachable over REST.
  for (const fn of ['handle_new_user', 'guard_profile_update',
                    'guard_order_customer_update', 'touch_updated_at']) {
    test(`trigger function ${fn} is not callable over REST`, async () => {
      const r = await rest(`rpc/${fn}`, { as: 'customer', method: 'POST', body: {} });
      assert.ok(r.status >= 400, `${fn} is exposed as an RPC endpoint`);
    });
  }

  // Helpers MUST be executable by authenticated users: RLS policies evaluate
  // as the calling role, so revoking these breaks every policy using them.
  // They are safe — each returns only the caller's own attributes.
  test('is_admin is callable but reports false for a customer', async () => {
    const r = await rest('rpc/is_admin', { as: 'customer', method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body, false, 'is_admin must not report true for a customer');
  });

  test('auth_role reports the caller\'s own role, not another\'s', async () => {
    const c = await rest('rpc/auth_role', { as: 'customer', method: 'POST', body: {} });
    const o = await rest('rpc/auth_role', { as: 'owner',    method: 'POST', body: {} });
    assert.equal(c.body, 'customer');
    assert.equal(o.body, 'store_owner');
  });

  test('helper functions are NOT callable anonymously', async () => {
    for (const fn of ['is_admin', 'auth_role', 'auth_store_id']) {
      const r = await rest(`rpc/${fn}`, { method: 'POST', body: {} });
      assert.ok(r.status >= 400, `${fn} is callable by anon`);
    }
  });

  // Nothing the suite creates may survive the run — leftover orders skew the
  // §4 analytics and stranded reservations block stock. Patterns are scoped
  // to this suite's unique prefixes (T- orders, the one draft, RLS-*
  // fixtures), so a crashed earlier run's strays are swept up too. The
  // stock fixtures are recreated by before() on the next run.
  after(async () => {
    await rest('orders?order_number=like.T-*', { as: 'admin', method: 'DELETE' });
    if (ids.draft) await rest(`product_drafts?id=eq.${ids.draft}`, { as: 'admin', method: 'DELETE' });
    await rest('stock_reservations?sku=like.RLS-*', { as: 'admin', method: 'DELETE' });
    await rest('product_stock?sku=like.RLS-*', { as: 'admin', method: 'DELETE' });

    const ordersLeft = await rest('orders?select=id&order_number=like.T-*', { as: 'admin' });
    assert.deepEqual(ordersLeft.body, [], 'T- test orders left behind');
    const reservedLeft = await rest('stock_reservations?select=sku&sku=like.RLS-*', { as: 'admin' });
    assert.deepEqual(reservedLeft.body, [], 'RLS- reservations left behind');
  });
});
