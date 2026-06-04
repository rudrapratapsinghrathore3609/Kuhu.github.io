# Kuhu Command Centre Full-Stack Starter

This is a real app scaffold for Kuhu agents, not a Claude Artifact. It includes:

- Backend server with authenticated APIs
- Supabase database schema and storage bucket
- Supabase Auth sign-in/sign-up
- Streaming AI responses over Server-Sent Events
- Multi-agent orchestration and Jarvis routing
- Learning memory system that extracts durable patterns instead of raw memorization
- Keyword search over memory/search documents
- File/photo upload foundation
- Mobile-responsive React UI
- Deployment steps

## 1. Create Supabase Project

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase/schema.sql`.
4. Confirm the `kuhu-uploads` private storage bucket exists.
5. Copy your project URL, anon key, and service role key.

The schema enables row-level security. User data is scoped by `auth.uid()`.

## 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in:

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

For local development:

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:8787`

## 3. Authentication

The React app uses Supabase Auth directly. The backend expects the Supabase access token in:

```http
Authorization: Bearer <token>
```

The backend verifies tokens with `supabaseAdmin.auth.getUser`.

## 4. AI Accounts

Users can save provider profiles in the UI:

- OpenAI
- OpenRouter
- Groq
- Together AI
- Ollama local
- Any OpenAI-compatible API

Important production note: this starter stores API keys in the `ai_accounts.api_key_encrypted` column as a placeholder. Before production, encrypt keys with a server-side KMS or Supabase Vault pattern. Do not expose the service role key to the frontend.

## 5. Streaming AI Responses

The frontend calls:

```http
POST /api/chat/stream
```

The server streams SSE events:

```text
data: {"type":"token","token":"Hello"}
data: {"type":"done","conversationId":"..."}
```

The frontend appends tokens live into the assistant bubble.

## 6. Multi-Agent Orchestration

`src/server/orchestrator.ts` routes Jarvis prompts to specialist agents using intent patterns:

- News/general knowledge -> Nova
- Market/company/product research -> Phil
- Finance/investing -> Mastermind
- Skills/learning/progress -> Homelander
- Studies/exams/notes -> Noir
- Website/product/frontend/deployment -> Kuhu
- Quotes/wisdom/philosophy -> Sage

When the user directly selects a specialist, that specialist answers directly.

## 7. Learning Memory

`src/server/memory.ts` saves distilled learning notes:

- Goals
- Learning style
- Tool preferences
- Accessibility preferences
- File context

It intentionally avoids storing raw chat excerpts as agent memory. Messages are still saved in conversation history, but memory is a compressed learning layer.

For stronger learning, replace the rule-based extractor with a model call that returns strict JSON:

```json
[
  {
    "category": "Goal",
    "learning": "User is building a standalone multi-agent command centre.",
    "confidence": 0.86
  }
]
```

## 8. Search System

The schema includes:

- `memories`
- `search_documents`
- trigram keyword search
- pgvector columns for semantic search

Current endpoint:

```http
GET /api/search?agentId=jarvis&q=deployment
```

To enable semantic search, add an embeddings provider and populate the `embedding` columns, then call `match_memories`.

## 9. Uploads

The backend accepts:

```http
POST /api/uploads
```

Text files are extracted into `uploads.extracted_text`. Other files/photos are stored in the private Supabase bucket and tracked as metadata. The chat endpoint adds extracted text into the model prompt.

For production photo vision, extend `buildUserContent` to create signed URLs or base64 image blocks for providers that support vision.

## 10. Deployment

Recommended simple split:

- Frontend: Vercel or Netlify
- Backend: Render, Railway, Fly.io, or a Node server
- Database/Auth/Storage: Supabase

Frontend environment:

```bash
VITE_API_URL=https://your-backend.example.com
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Backend environment:

```bash
PORT=8787
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DEFAULT_OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=gpt-4.1-mini
```

Build command:

```bash
npm run build
```

Development command:

```bash
npm run dev
```

Backend start command after adding a server build step:

```bash
npm run start
```

This scaffold currently runs the backend through `tsx` in development. For production, add an `esbuild` or `tsup` server build step, or deploy with a platform that supports TypeScript entrypoints.

## 11. Next Production Hardening

- Encrypt provider API keys server-side.
- Add semantic embeddings for memories and uploads.
- Add PDF/DOCX extraction workers.
- Add signed URL image support for multimodal providers.
- Add conversation list loading into the UI.
- Add background jobs for memory consolidation.
- Add rate limits per user.
- Add audit logs for sensitive account changes.
