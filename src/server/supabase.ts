import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publicKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !serviceKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
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
