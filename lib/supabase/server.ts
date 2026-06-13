import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Service-role Supabase client — server only (the /api/generate route). */
export function supabaseService(): SupabaseClient {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
