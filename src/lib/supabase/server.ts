import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadServerSupabaseConfig } from "../../config/supabase.js";
import type { Database } from "../../types/database.generated.js";

export type MonarchServerSupabaseClient = SupabaseClient<Database>;

let singleton: MonarchServerSupabaseClient | undefined;

export function getServerSupabaseClient(): MonarchServerSupabaseClient {
  if (singleton) return singleton;

  const { url, secretKey } = loadServerSupabaseConfig();

  singleton = createClient<Database>(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
  return singleton;
}
