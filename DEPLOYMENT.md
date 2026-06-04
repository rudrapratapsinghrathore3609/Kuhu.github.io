# Deploy AI Agents Online

Recommended first deployment: Railway or Render.

## Required Environment Variables

Set these in the hosting provider. Do not paste them into public GitHub files.

```text
SUPABASE_URL=https://rduhruycdvrvmyksamhz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
VITE_SUPABASE_URL=https://rduhruycdvrvmyksamhz.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
DEFAULT_OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=gpt-4.1-mini
```

Do not deploy local Ollama as the default provider. Ollama runs on your laptop and will not be reachable from Railway/Render unless you host a model server separately.

## Build Command

```text
npm install && npm run build
```

## Start Command

```text
npm start
```

## After Deployment

1. Copy the deployed URL.
2. Open Supabase Dashboard.
3. Go to Authentication > URL Configuration.
4. Set Site URL to the deployed URL.
5. Add Redirect URLs:
   - deployed URL
   - deployed URL with trailing slash
6. Go to Authentication > Users.
7. Send password recovery or invite your friend.

## Friend Access

Your friend can use the deployed URL and sign in with:

```text
kavelsinghania@gmail.com
```

If he does not know his password, send a recovery email from Supabase Authentication > Users.