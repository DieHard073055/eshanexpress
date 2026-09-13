import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client.
 *
 * The URL and publishable key are PUBLIC and ship in the bundle. That is safe
 * ONLY because row-level security is enabled on every table — RLS is the
 * entire security model here, not the key.
 *
 * The sb_secret_ key must never reach this file or the bundle.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** False when env vars are absent, so the storefront can degrade rather than crash. */
export const isConfigured = Boolean(url && key);

if (!isConfigured && import.meta.env.DEV) {
  console.warn('Supabase not configured — copy .env.example to .env. Auth and orders are disabled.');
}

export const supabase = isConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Sessions land on a hash route; let the client parse them.
        detectSessionInUrl: true,
      },
    })
  : null;

/** Current user, or null when signed out or unconfigured. */
export async function currentUser() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}
