/**
 * Store portal access rules, tested server-side.
 *
 * The UI hides what an owner may not do, but the guarantees live in RLS and
 * the order guard trigger. These assert the guarantees, not the UI.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { aggregateOrders } from '../src/lib/analytics.js';

const env = existsSync('.env')
  ? Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\n')
      .filter((l) => l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }))
  : {};

const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const tok = {};
const ids = {};

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass!2026x' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed: ${email}`);
  return { token: j.access_token, id: j.user.id };
}

async function rest(path, as, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${tok[as]}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

describe('store portal', { skip: URL && KEY ? false : 'no .env' }, () => {
  before(async () => {
    for (const [k, email] of Object.entries({
      customer: 'rlstest.customer@eshanexpress.test',
      owner: 'rlstest.owner@eshanexpress.test',
      admin: 'rlstest.admin@eshanexpress.test',
    })) {
      const { token, id } = await signIn(email);
      tok[k] = token; ids[k] = id;
    }
    const stores = await rest('stores?select=id,slug', 'customer');
    ids.store = stores.body.find((s) => s.slug === 'eshan-electronics').id;
  });

  test('owner profile resolves their store via the nested join', async () => {
    const r = await rest(`profiles?select=role,store_id,stores(slug,name)&id=eq.${ids.owner}`, 'owner');
    assert.equal(r.body[0].role, 'store_owner');
    assert.equal(r.body[0].stores.slug, 'eshan-electronics');
  });

  test('a customer profile carries no store', async () => {
    const r = await rest(`profiles?select=role,store_id&id=eq.${ids.customer}`, 'customer');
    assert.equal(r.body[0].role, 'customer');
    assert.equal(r.body[0].store_id, null);
  });

  test('the portal queue query returns only this store\'s orders', async () => {
    const r = await rest(
      'orders?select=id,store_id,status&status=in.(confirmed,ready_for_pickup,shipped)', 'owner');
    assert.equal(r.status, 200);
    for (const o of r.body) {
      assert.equal(o.store_id, ids.store, 'a foreign store order leaked into the queue');
    }
  });

  test('owner cannot move an order backwards to awaiting_payment', async () => {
    const [o] = (await rest('orders', 'customer', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        order_number: `SP-${Date.now()}`, user_id: ids.customer, store_id: ids.store,
        items: [{ sku: 'EX-1001', qty: 1, unit_price: 34900 }], total_cents: 34900,
      }),
    })).body;
    await rest(`orders?id=eq.${o.id}`, 'admin', {
      method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }),
    });

    await rest(`orders?id=eq.${o.id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'awaiting_payment' }),
    });
    const check = await rest(`orders?select=status&id=eq.${o.id}`, 'owner');
    assert.equal(check.body[0].status, 'confirmed', 'owner reverted a confirmed order');

    await rest(`orders?id=eq.${o.id}`, 'admin', { method: 'DELETE' });
  });

  test('owner cannot edit order contents or totals', async () => {
    const [o] = (await rest('orders', 'customer', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        order_number: `SP2-${Date.now()}`, user_id: ids.customer, store_id: ids.store,
        items: [{ sku: 'EX-1001', qty: 1, unit_price: 34900 }], total_cents: 34900,
      }),
    })).body;
    await rest(`orders?id=eq.${o.id}`, 'admin', {
      method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }),
    });

    await rest(`orders?id=eq.${o.id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'shipped', total_cents: 1 }),
    });
    const check = await rest(`orders?select=total_cents&id=eq.${o.id}`, 'owner');
    assert.equal(check.body[0].total_cents, 34900, 'owner changed the order total');

    await rest(`orders?id=eq.${o.id}`, 'admin', { method: 'DELETE' });
  });

  test('draft submitted through the portal is pending and store-scoped', async () => {
    const r = await rest('product_drafts', 'owner', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        store_id: ids.store, submitted_by: ids.owner,
        payload: { title: 'Portal Test Item', priceCents: 45950, stockTotal: 12 },
      }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body[0].status, 'pending');
    await rest(`product_drafts?id=eq.${r.body[0].id}`, 'admin', { method: 'DELETE' });
  });

  test('customer cannot read the drafts table at all', async () => {
    const r = await rest('product_drafts?select=id', 'customer');
    assert.deepEqual(r.body, [], 'drafts leaked to a customer');
  });

  // ------------------------------------------------------ store decoration
  test('owner can update only decoration columns on their own store', async () => {
    const before = (await rest(`stores?select=blurb&id=eq.${ids.store}`, 'owner')).body[0];
    const next = before.blurb === 'RLS test blurb' ? null : 'RLS test blurb';

    const r = await rest(`stores?id=eq.${ids.store}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ blurb: next }),
    });
    assert.ok([200, 204].includes(r.status), `owner update refused: ${JSON.stringify(r.body)}`);

    const check = (await rest(`stores?select=blurb&id=eq.${ids.store}`, 'owner')).body[0];
    assert.equal(check.blurb, next, 'owner blurb update did not apply');

    await rest(`stores?id=eq.${ids.store}`, 'admin', {
      method: 'PATCH', body: JSON.stringify({ blurb: before.blurb }),
    });
  });

  test('owner cannot change their own store slug or name (trigger)', async () => {
    const original = (await rest(`stores?select=slug,name&id=eq.${ids.store}`, 'owner')).body[0];

    const r = await rest(`stores?id=eq.${ids.store}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ slug: `${original.slug}-hacked` }),
    });
    assert.ok([400, 403].includes(r.status),
      `expected the guard trigger to raise, got ${r.status}: ${JSON.stringify(r.body)}`);

    const check = (await rest(`stores?select=slug,name&id=eq.${ids.store}`, 'owner')).body[0];
    assert.equal(check.slug, original.slug, 'owner changed the slug');
    assert.equal(check.name, original.name);
  });

  test('owner cannot write another store\'s row', async () => {
    const [b] = (await rest('stores', 'admin', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ slug: `rls-test-b-${Date.now()}`, name: 'RLS Test Store B' }),
    })).body;

    const r = await rest(`stores?id=eq.${b.id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ blurb: 'not yours' }),
    });
    const check = (await rest(`stores?select=blurb&id=eq.${b.id}`, 'admin')).body[0];
    assert.notEqual(check.blurb, 'not yours', 'owner wrote store B\'s row');

    await rest(`stores?id=eq.${b.id}`, 'admin', { method: 'DELETE' });
    void r;
  });

  test('owner cannot upload to another store\'s storage folder', async () => {
    const [b] = (await rest('stores', 'admin', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ slug: `rls-test-c-${Date.now()}`, name: 'RLS Test Store C' }),
    })).body;

    const r = await fetch(`${URL}/storage/v1/object/store-assets/${b.id}/banner.webp`, {
      method: 'POST',
      headers: {
        apikey: KEY, Authorization: `Bearer ${tok.owner}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // minimal bytes; RLS fires first
    });
    assert.ok([400, 403].includes(r.status),
      `cross-store upload was not refused: HTTP ${r.status}`);

    await rest(`stores?id=eq.${b.id}`, 'admin', { method: 'DELETE' });
  });

  test('owner can upload to their own storage folder, and replace it', async () => {
    const path = `${ids.store}/rls-test.webp`;
    // The portal uploads with upsert, because replacing a banner writes the
    // same stable path. A plain POST to an existing object is refused by
    // Storage with 400/Duplicate regardless of RLS, so the header here is
    // what makes this a test of the policy rather than of POST semantics.
    const put = (token) => fetch(`${URL}/storage/v1/object/store-assets/${path}`, {
      method: 'POST',
      headers: {
        apikey: KEY, Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]),
    });

    try {
      const first = await put(tok.owner);
      assert.ok([200, 201].includes(first.status),
        `own-folder upload refused: HTTP ${first.status}`);
      const second = await put(tok.owner);
      assert.ok([200, 201].includes(second.status),
        `replacement upload refused: HTTP ${second.status}`);
    } finally {
      await fetch(`${URL}/storage/v1/object/store-assets/${path}`, {
        method: 'DELETE',
        headers: { apikey: KEY, Authorization: `Bearer ${tok.owner}` },
      });
    }
  });

  // -------------------------------------------------------- analytics (§4)
  test('analytics query sees only this store; fulfilled-only revenue', async () => {
    // One fulfilled order for this store, one for a throwaway second store.
    const [b] = (await rest('stores', 'admin', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ slug: `rls-test-d-${Date.now()}`, name: 'RLS Test Store D' }),
    })).body;

    const mk = async (storeId, total) => {
      const [o] = (await rest('orders', 'customer', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          order_number: `AN-${Date.now()}-${total}`, user_id: ids.customer, store_id: storeId,
          items: [{ sku: 'EX-1001', qty: 1, unit_price: total }], total_cents: total,
        }),
      })).body;
      await rest(`orders?id=eq.${o.id}`, 'admin', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'fulfilled', fulfilled_at: new Date().toISOString() }),
      });
      return o;
    };

    try {
      const own = await mk(ids.store, 34900);
      const foreign = await mk(b.id, 99900);

      // The exact query the portal's analytics strip runs.
      const r = await rest('orders?select=id,total_cents,status,fulfilled_at,created_at', 'owner');
      assert.equal(r.status, 200);
      const idsSeen = r.body.map((o) => o.id);
      assert.ok(idsSeen.includes(own.id), 'own fulfilled order missing from the analytics query');
      assert.ok(!idsSeen.includes(foreign.id), 'a foreign store order leaked into the query');

      // The metric definitions agree: only the own-store fulfilled order counts.
      const a = aggregateOrders(r.body);
      assert.equal(a.revenueAll, 34900, `revenue includes foreign orders: ${a.revenueAll}`);
      assert.equal(a.ordersAll, 1);
      assert.equal(a.revenueMonth, 34900, 'fulfilled_at this month counts as this month');
    } finally {
      await rest(`orders?store_id=eq.${b.id}`, 'admin', { method: 'DELETE' });
      await rest(`orders?order_number=like.AN-%25`, 'admin', { method: 'DELETE' });
      await rest(`stores?id=eq.${b.id}`, 'admin', { method: 'DELETE' });
    }
  });
});
