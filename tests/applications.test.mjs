/**
 * Store-owner applications, tested against the live project.
 *
 * The flow: a customer submits one pending application; an admin records the
 * decision. The decision must never be self-servable, and recording an
 * approval must NOT by itself grant the store_owner role — elevation is
 * manual SQL.
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

const tok = {};
const ids = {};

async function signIn(email, password = 'TestPass!2026x') {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

describe('store applications', { skip: URL && KEY ? false : 'no .env' }, () => {
  before(async () => {
    for (const [k, email] of Object.entries({
      customer: 'rlstest.customer@eshanexpress.test',
      owner: 'rlstest.owner@eshanexpress.test',
      admin: 'rlstest.admin@eshanexpress.test',
    })) {
      const { token, id } = await signIn(email);
      tok[k] = token; ids[k] = id;
    }
    // Clear leftovers from a previous interrupted run so the one-pending
    // index does not false-fail.
    await rest(`store_applications?user_id=eq.${ids.customer}`, 'admin', { method: 'DELETE' });
  });

  after(async () => {
    await rest(`store_applications?user_id=eq.${ids.customer}`, 'admin', { method: 'DELETE' });
    await rest(`store_applications?user_id=eq.${ids.owner}`, 'admin', { method: 'DELETE' });
  });

  test('a customer can submit exactly one pending application', async () => {
    const first = await rest('store_applications', 'customer', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: ids.customer, store_name: 'Test Bazaar', contact: 'test@example.com',
      }),
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body[0].status, 'pending');

    const second = await rest('store_applications', 'customer', {
      method: 'POST',
      body: JSON.stringify({
        user_id: ids.customer, store_name: 'Second Bazaar', contact: 'test@example.com',
      }),
    });
    assert.ok(second.status >= 400,
      `a second pending application was accepted: HTTP ${second.status}`);
  });

  test('an applicant cannot submit for someone else', async () => {
    const r = await rest('store_applications', 'customer', {
      method: 'POST',
      body: JSON.stringify({
        user_id: ids.owner, store_name: 'Impersonation', contact: 'x@example.com',
      }),
    });
    assert.ok(r.status >= 400, `insert as another user accepted: HTTP ${r.status}`);
  });

  test('an applicant cannot flip their own status to approved', async () => {
    const mine = (await rest(
      `store_applications?select=id,status&user_id=eq.${ids.customer}`, 'customer')).body;
    assert.equal(mine.length, 1, 'setup: expected exactly one application');

    const r = await rest(`store_applications?id=eq.${mine[0].id}`, 'customer', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'approved' }),
    });
    // No self-update policy: zero rows pass the USING clause.
    assert.ok(r.status >= 400 || (Array.isArray(r.body) && r.body.length === 0),
      `self-approval went through: HTTP ${r.status} ${JSON.stringify(r.body)}`);

    const check = (await rest(
      `store_applications?select=status&id=eq.${mine[0].id}`, 'customer')).body;
    assert.equal(check[0].status, 'pending', 'applicant flipped their own status');
  });

  test('an applicant cannot read another user\'s application', async () => {
    await rest('store_applications', 'admin', {
      method: 'POST',
      body: JSON.stringify({
        user_id: ids.owner, store_name: 'Owner Application', contact: 'o@example.com',
      }),
    });
    const r = await rest(
      `store_applications?select=id&user_id=eq.${ids.owner}`, 'customer');
    assert.deepEqual(r.body, [], 'another user\'s application leaked');
  });

  test('admin records a decision with a note; the role is NOT granted', async () => {
    const [mine] = (await rest(
      `store_applications?select=id&user_id=eq.${ids.customer}`, 'customer')).body;

    const r = await rest(`store_applications?id=eq.${mine.id}`, 'admin', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'approved', review_note: 'Welcome aboard.' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body[0].status, 'approved');
    assert.equal(r.body[0].review_note, 'Welcome aboard.');

    // The decision is recorded — the elevation is manual SQL, not a button.
    const [profile] = (await rest(
      `profiles?select=role,store_id&id=eq.${ids.customer}`, 'admin')).body;
    assert.equal(profile.role, 'customer',
      'approving the application granted the role by itself');
  });

  test('a rejected applicant can apply again; a pending one cannot', async () => {
    const [mine] = (await rest(
      `store_applications?select=id&user_id=eq.${ids.customer}`, 'customer')).body;
    await rest(`store_applications?id=eq.${mine.id}`, 'admin', {
      method: 'PATCH', body: JSON.stringify({ status: 'rejected', review_note: 'Not this time.' }),
    });

    // After a decision the unique index frees up.
    const again = await rest('store_applications', 'customer', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: ids.customer, store_name: 'Test Bazaar 2', contact: 'test@example.com',
      }),
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));

    // But two pendings still cannot coexist.
    const dup = await rest('store_applications', 'customer', {
      method: 'POST',
      body: JSON.stringify({
        user_id: ids.customer, store_name: 'Test Bazaar 3', contact: 'test@example.com',
      }),
    });
    assert.ok(dup.status >= 400, `duplicate pending accepted: HTTP ${dup.status}`);
  });
});
