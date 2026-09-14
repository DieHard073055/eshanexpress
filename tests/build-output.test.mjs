/**
 * Guards on what actually ships.
 *
 * A deploy once went out with no Supabase config because CI has no .env and
 * the workflow did not pass VITE_* through, so the live site reported
 * "Accounts unavailable" for sign-in, checkout and orders. These assert the
 * shape of the built bundle rather than trusting the build to be correct.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const assets = existsSync(join(DIST, 'assets'))
  ? readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'))
  : [];
const bundle = assets.map((f) => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');

describe('built bundle', { skip: assets.length ? false : 'no dist/ — run npm run build first' }, () => {
  test('carries a Supabase URL, or auth silently dies in production', () => {
    assert.match(bundle, /https:\/\/[a-z0-9]+\.supabase\.co/,
      'no Supabase URL in the bundle — sign-in and checkout will be disabled');
  });

  test('carries a publishable key', () => {
    assert.match(bundle, /sb_publishable_|eyJ[A-Za-z0-9_-]{20,}/,
      'no Supabase key in the bundle');
  });

  test('never ships a secret key', () => {
    assert.doesNotMatch(bundle, /sb_secret_/, 'SECRET KEY IN THE CLIENT BUNDLE');
    assert.doesNotMatch(bundle, /service_role/, 'service_role reference in the bundle');
  });

  test('ships bank details customers need in order to pay', () => {
    assert.match(bundle, /77\d{11}/, 'no account number in the bundle');
  });

  test('the offline admin pages are never deployed', () => {
    assert.equal(existsSync(join(DIST, 'admin-offline')), false,
      'admin tooling must not be published');
    assert.doesNotMatch(bundle, /workbench\.html/);
  });

  test('the catalog is published alongside the app', () => {
    assert.ok(existsSync(join(DIST, 'catalog', 'index.json')));
    assert.ok(existsSync(join(DIST, 'catalog', 'catalog.json')));
  });
});
