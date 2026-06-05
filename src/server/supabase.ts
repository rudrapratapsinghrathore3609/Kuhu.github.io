import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL?.trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "").trim();
const publicKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "").trim();

if (!url || !serviceKey) {
  throw new Error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY");
}

if (!publicKey) {
  throw new Error("Missing SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY");
}

export const supabaseAdmin = createClient(url, serviceKey, {
  auth: { persistSession: false }
});

export const supabaseAuth = createClient(url, publicKey, {
  auth: { persistSession: false }
});

export function createUserSupabase(accessToken: string) {
  return createClient(url, publicKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });
}
