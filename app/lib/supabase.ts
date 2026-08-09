import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser's Supabase client. Auth only — all data goes through our own API,
 * which verifies the access token this client issues.
 *
 * Created lazily so that a missing/blank config surfaces as a clear message on
 * the auth screens rather than a module-load crash that white-screens the app.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) {
    throw new Error(
      "Supabase isn't configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.",
    );
  }
  if (!cached) {
    cached = createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return cached;
}
