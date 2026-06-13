import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Browser (anon) Supabase client — used by the UI to subscribe to Realtime. */
export function supabaseBrowser(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
