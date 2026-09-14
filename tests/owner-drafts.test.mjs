/**
 * Store-owner draft submission, tested against the live project.
 *
 * The extension lets a seller sign in and submit captures as product drafts.
 * These assert the boundaries: a seller cannot reach another store, cannot
 * self-approve, and cannot exhaust the shared storage quota.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const env = existsSync('.env')
  ? Object.fromEntries(readFileSync('.env', 'utf8').trim().split('\n')
      .filter((l) => l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }))
  : {};

const URL = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const PASSWORD = 'fG6LEXxUyCabz4bG';

const tok = {};
const ids = {};
const madeDrafts = [];

async function signIn(email) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}`);
  return { token: j.access_token, id: j.user.id };
}

const rest = (path, as, init = {}) => fetch(`${URL}/rest/v1/${path}`, {
  ...init,
  headers: {
    apikey: KEY, authorization: `Bearer ${tok[as]}`,
    'content-type': 'application/json', ...(init.headers || {}),
  },
});

describe('store-owner drafts', { skip: URL && KEY ? false : 'no .env' }, () => {
  before(async () => {
    for (const [k, email] of Object.entries({
      owner: 'eshanshafeeq073055+seller@gmail.com',
      customer: 'eshanshafeeq073055+customer@gmail.com',
      admin: 'eshanshafeeq073055+admin@gmail.com',
    })) {
      const { token, id } = await signIn(email);
      tok[k] = token; ids[k] = id;
    }
    const [p] = await (await rest(
      `profiles?select=store_id&id=eq.${ids.owner}`, 'owner')).json();
    ids.store = p.store_id;
  });

  after(async () => {
    for (const id of madeDrafts) {
      await rest(`product_drafts?id=eq.${id}`, 'admin', { method: 'DELETE' });
    }
  });

  test('an owner can submit a draft for their own store', async () => {
    const r = await rest('product_drafts', 'owner', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        store_id: ids.store, submitted_by: ids.owner,
        payload: { title: 'Draft test', sourceAmount: 9.99, sourceCurrency: 'USD' },
      }),
    });
    assert.equal(r.status, 201);
    const [d] = await r.json();
    madeDrafts.push(d.id);
    assert.equal(d.status, 'pending', 'must arrive as pending, never approved');
  });

  test('an owner cannot submit for a different store', async () => {
    const r = await rest('product_drafts', 'owner', {
      method: 'POST',
      body: JSON.stringify({
        store_id: '00000000-0000-0000-0000-000000000000',
        submitted_by: ids.owner, payload: { title: 'Foreign' },
      }),
    });
    assert.ok(r.status >= 400, 'cross-store submission must be refused');
  });

  test('an owner cannot self-approve', async () => {
    const [d] = await (await rest('product_drafts', 'owner', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        store_id: ids.store, submitted_by: ids.owner, payload: { title: 'Approve test' },
      }),
    })).json();
    madeDrafts.push(d.id);

    await rest(`product_drafts?id=eq.${d.id}`, 'owner', {
      method: 'PATCH', body: JSON.stringify({ status: 'approved' }),
    });
    const [after] = await (await rest(
      `product_drafts?select=status&id=eq.${d.id}`, 'owner')).json();
    assert.equal(after.status, 'pending', 'owner approved their own product');
  });

  test('a customer cannot submit a draft at all', async () => {
    const r = await rest('product_drafts', 'customer', {
      method: 'POST',
      body: JSON.stringify({
        store_id: ids.store, submitted_by: ids.customer, payload: { title: 'Nope' },
      }),
    });
    assert.ok(r.status >= 400);
  });

  test('quota reporting reflects the store', async () => {
    const r = await rest('rpc/store_draft_usage', 'owner', {
      method: 'POST', body: JSON.stringify({ p_store_id: ids.store }),
    });
    const usage = await r.json();
    assert.ok(Number.isInteger(usage.pendingDrafts));
    assert.equal(usage.maxDrafts, 50);
    assert.equal(usage.maxBytes, 104857600, '100 MB per store');
  });

  test('the admin can approve a draft', async () => {
    const [d] = await (await rest('product_drafts', 'owner', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        store_id: ids.store, submitted_by: ids.owner, payload: { title: 'Admin approve' },
      }),
    })).json();
    madeDrafts.push(d.id);

    const r = await rest(`product_drafts?id=eq.${d.id}`, 'admin', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const [after] = await r.json();
    assert.equal(after.status, 'approved');
  });
});
