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

const supabaseUrl = url;
const supabaseServiceKey = serviceKey;
const supabasePublicKey = publicKey;

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false }
});

export const supabaseAuth = createClient(supabaseUrl, supabasePublicKey, {
  auth: { persistSession: false }
});

export function createUserSupabase(accessToken: string) {
  return createClient(supabaseUrl, supabasePublicKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  });
}
