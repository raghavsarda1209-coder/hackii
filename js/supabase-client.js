import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

/**
 * The Supabase browser SDK is fetched from a CDN as an ES module.
 *
 * It is loaded lazily and defensively: if the network or the CDN is
 * unavailable the app still boots, in demo mode, instead of showing a blank
 * page. Only the PUBLISHABLE (anon) key is ever used here - the secret key
 * must stay server-side.
 */

const CDN_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
  'https://esm.sh/@supabase/supabase-js@2',
  'https://unpkg.com/@supabase/supabase-js@2?module',
];

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

let memo = null;

/** @returns {Promise<{client: object|null, error: string|null}>} */
export function loadSupabase() {
  if (memo) return memo;
  if (!isConfigured) {
    memo = Promise.resolve({ client: null, error: 'Supabase is not configured (missing URL or publishable key).' });
    return memo;
  }
  memo = (async () => {
    let lastErr = 'unknown error';
    for (const url of CDN_SOURCES) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        const createClient = mod.createClient || (mod.default && mod.default.createClient);
        if (!createClient) { lastErr = `${url} did not export createClient`; continue; }
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
          global: { headers: { 'x-client-info': 'smart-campus-booking/1.0' } },
        });
        return { client, error: null };
      } catch (err) {
        lastErr = err?.message || String(err);
      }
    }
    console.warn('[CampusBook] could not load the Supabase SDK:', lastErr);
    return { client: null, error: `Could not load the Supabase SDK (${lastErr}).` };
  })();
  return memo;
}
