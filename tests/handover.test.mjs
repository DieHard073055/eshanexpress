/**
 * Handover code tests — run against the live project over the public API.
 *
 * The security property under test: a store owner must NOT be able to mark an
 * order completed without the code the customer presents at handover. Only a
 * bcrypt hash is stored, so the owner cannot read the code from the row they
 * legitimately have RLS access to.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const env = existsSync('.env')
  ? Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\n')
      .filter((l) => l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }))
  : {};

const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const PASSWORD = 'TestPass!2026x';
const tok = {};
const ids = {};

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed: ${email}`);
  return { token: j.access_token, id: j.user.id };
}

/** Throws on non-2xx so a PostgREST error can never be mistaken for data. */
async function rest(path, as, init = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${tok[as]}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text.slice(0, 200)}`);
  return body;
}

async function newConfirmedOrder() {
  const [o] = await rest('orders', 'customer', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      order_number: `HT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      user_id: ids.customer, store_id: ids.store,
      items: [{ sku: 'EX-1001', qty: 1, unit_price: 34900 }], total_cents: 34900,
    }),
  });
  await rest(`orders?id=eq.${o.id}`, 'admin', {
    method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }),
  });
  return o.id;
}

describe('handover code', { skip: URL && KEY ? false : 'no .env' }, () => {
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
    ids.store = stores.find((s) => s.slug === 'eshan-electronics').id;
  });

  test('code is 6 unambiguous characters', async () => {
    const id = await newConfirmedOrder();
    const r = await rest('rpc/issue_handover_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id }),
    });
    assert.equal(r.ok, true);
    assert.match(r.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  });

  test('only a bcrypt hash is stored — the owner cannot read the code', async () => {
    const id = await newConfirmedOrder();
    const { code } = await rest('rpc/issue_handover_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id }),
    });
    const [row] = await rest(`orders?select=handover_code_hash&id=eq.${id}`, 'owner');
    assert.notEqual(row.handover_code_hash, code);
    assert.match(row.handover_code_hash, /^\$2[aby]\$/);
  });

  test('owner can hand off but CANNOT self-complete via PATCH', async () => {
    const id = await newConfirmedOrder();
    await rest('rpc/issue_handover_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id }),
    });
    await rest(`orders?id=eq.${id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'ready_for_pickup' }),
    });
    await rest(`orders?id=eq.${id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'completed' }),
    }).catch(() => {});
    const [row] = await rest(`orders?select=status,fulfilled_at&id=eq.${id}`, 'owner');
    assert.equal(row.status, 'ready_for_pickup', 'owner completed without the code');
    assert.ok(row.fulfilled_at);
  });

  test('correct code completes; wrong code does not', async () => {
    const id = await newConfirmedOrder();
    const { code } = await rest('rpc/issue_handover_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id }),
    });
    await rest(`orders?id=eq.${id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'shipped' }),
    });

    const bad = await rest('rpc/complete_with_code', 'owner', {
      method: 'POST', body: JSON.stringify({ p_order_id: id, p_code: 'WRONG1' }),
    });
    assert.equal(bad.reason, 'wrong_code');

    const good = await rest('rpc/complete_with_code', 'owner', {
      method: 'POST', body: JSON.stringify({ p_order_id: id, p_code: code.toLowerCase() }),
    });
    assert.equal(good.ok, true, 'code should be case-insensitive');

    const [row] = await rest(`orders?select=status,completed_by&id=eq.${id}`, 'owner');
    assert.equal(row.status, 'completed');
    assert.equal(row.completed_by, ids.owner);
  });

  test('locks after 5 failed attempts, and admin can rescue', async () => {
    const id = await newConfirmedOrder();
    await rest('rpc/issue_handover_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id }),
    });
    await rest(`orders?id=eq.${id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'shipped' }),
    });

    let locked = false;
    for (let i = 1; i <= 6 && !locked; i++) {
      const r = await rest('rpc/complete_with_code', 'owner', {
        method: 'POST', body: JSON.stringify({ p_order_id: id, p_code: `BAD${i}Z` }),
      });
      locked = r.locked === true || r.reason === 'locked';
    }
    assert.ok(locked, 'should lock after repeated failures');

    const forced = await rest('rpc/admin_force_complete', 'admin', {
      method: 'POST',
      body: JSON.stringify({ p_order_id: id, p_reason: 'Lost code, verified by phone' }),
    });
    assert.equal(forced.ok, true);

    const [row] = await rest(`orders?select=completion_override_reason&id=eq.${id}`, 'admin');
    assert.ok(row.completion_override_reason, 'override reason must be recorded');
  });

  test('only the store owner or admin may complete', async () => {
    const id = await newConfirmedOrder();
    const r = await rest('rpc/complete_with_code', 'customer', {
      method: 'POST', body: JSON.stringify({ p_order_id: id, p_code: 'ABCDEF' }),
    });
    assert.equal(r.reason, 'forbidden', 'customer must not complete their own order');
  });

  test('owner cannot force-complete', async () => {
    const id = await newConfirmedOrder();
    const r = await rest('rpc/admin_force_complete', 'owner', {
      method: 'POST', body: JSON.stringify({ p_order_id: id, p_reason: 'let me through' }),
    });
    assert.notEqual(r.ok, true);
  });

  // The suite's orders exist only to be attacked; nothing may survive the
  // run. The pattern is scoped to this suite's HT- prefix (PostgREST `like`
  // wildcards), so a crashed earlier run's strays are swept up too.
  after(async () => {
    await rest(`orders?order_number=like.HT-*`, 'admin', { method: 'DELETE' });
    const left = await rest(`orders?select=id&order_number=like.HT-*`, 'admin');
    assert.deepEqual(left, [], 'HT- test orders left behind');
  });
});
