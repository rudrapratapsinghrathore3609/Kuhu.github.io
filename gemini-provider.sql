-- Run this once in Supabase SQL Editor to allow Gemini AI account profiles.
alter table public.ai_accounts drop constraint if exists ai_accounts_provider_check;

alter table public.ai_accounts add constraint ai_accounts_provider_check
  check (provider in ('openai', 'openrouter', 'gemini', 'groq', 'together', 'ollama', 'compatible', 'anthropic', 'claude'));