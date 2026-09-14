/**
 * Store portal access rules, tested server-side.
 *
 * The UI hides what an owner may not do, but the guarantees live in RLS and
 * the order guard trigger. These assert the guarantees, not the UI.
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

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
});
