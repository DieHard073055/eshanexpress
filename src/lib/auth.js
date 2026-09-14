import { supabase, isConfigured } from './supabase.js';

/**
 * Auth wrapper. Keeps Supabase error strings out of the UI and gives the
 * rest of the app a small, stable surface.
 */

const listeners = new Set();
let cachedUser = null;
let ready = false;

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(cachedUser);
}

export async function initAuth() {
  if (!isConfigured) { ready = true; return null; }
  const { data } = await supabase.auth.getSession();
  cachedUser = data.session?.user ?? null;
  ready = true;
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedUser = session?.user ?? null;
    clearProfileCache();   // role must never survive a user change
    emit();
  });
  emit();
  return cachedUser;
}

export function getUser() {
  return cachedUser;
}

export function isReady() {
  return ready;
}

/** Supabase messages are terse and sometimes leak internals. */
function friendly(message = '') {
  const m = message.toLowerCase();
  if (m.includes('invalid login')) return 'That email or password is not right.';
  if (m.includes('email not confirmed')) return 'Check your inbox and confirm your email first.';
  if (m.includes('already registered')) return 'That email already has an account — sign in instead.';
  if (m.includes('password should be')) return 'Password must be at least 6 characters.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('pwned') || m.includes('compromised')) {
    return 'That password appears in a known data breach. Please choose another.';
  }
  return message || 'Something went wrong. Try again.';
}

export async function signIn(email, password) {
  if (!supabase) return { error: 'Accounts are unavailable right now.' };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: friendly(error.message) };
  cachedUser = data.user;
  emit();
  return { user: data.user };
}

export async function signUp(email, password) {
  if (!supabase) return { error: 'Accounts are unavailable right now.' };
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: friendly(error.message) };
  // With email confirmation on, there is no session until the link is clicked.
  const needsConfirmation = !data.session;
  cachedUser = data.session?.user ?? null;
  emit();
  return { user: data.user, needsConfirmation };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
  cachedUser = null;
  clearProfileCache();
  emit();
}

export async function resetPassword(email) {
  if (!supabase) return { error: 'Accounts are unavailable right now.' };
  const redirectTo = `${location.origin}${location.pathname}#/reset`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return { error: friendly(error.message) };
  return { ok: true };
}

/**
 * Profile row (role, store). Null when signed out.
 *
 * Cached per user: role gates several pages, and refetching on every route
 * change would add a round trip to each navigation. Cleared on auth change.
 */
let profileCache = null;
let profileFor = null;

export async function getProfile() {
  if (!supabase || !cachedUser) return null;
  if (profileFor === cachedUser.id && profileCache) return profileCache;

  const { data, error } = await supabase
    .from('profiles')
    .select('role, store_id, stores(slug, name)')
    .eq('id', cachedUser.id)
    .maybeSingle();
  if (error) return null;

  profileCache = data;
  profileFor = cachedUser.id;
  return data;
}

export function clearProfileCache() {
  profileCache = null;
  profileFor = null;
}

/** True when the signed-in user can act on a store's orders. */
export async function isStaff() {
  const p = await getProfile();
  return p?.role === 'store_owner' || p?.role === 'admin';
}
