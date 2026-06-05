import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { fallbackAgents } from "./agents";
import { requireAuth, type AuthedRequest } from "./auth";
import { buildConnectorContext, testConnectorConnection } from "./connectors";
import { learnFromMessage } from "./memory";
import { buildSystemPrompt, routeAgent } from "./orchestrator";
import { streamModel, testModelConnection, type Account } from "./providers";
import { createUserSupabase, supabaseAdmin } from "./supabase";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../../dist");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", requireAuth);

function authed(req: express.Request) {
  return req as AuthedRequest;
}

function userId(req: express.Request) {
  return authed(req).user.id;
}

function userDb(req: express.Request) {
  return createUserSupabase(authed(req).accessToken);
}

function publicAccount(account: Account & { id?: string; is_default?: boolean }) {
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    base_url: account.base_url,
    model: account.model,
    is_default: Boolean(account.is_default)
  };
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function sharedAccounts(): Array<Account & { id: string; is_default: boolean }> {
  const accounts: Array<Account & { id: string; is_default: boolean }> = [];

  const geminiKey = firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY");
  if (geminiKey) {
    accounts.push({
      id: "shared-gemini",
      label: "Shared Gemini",
      provider: "gemini",
      base_url: firstEnv("SHARED_GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta",
      model: firstEnv("SHARED_GEMINI_MODEL") || "gemini-2.5-flash",
      api_key_encrypted: geminiKey,
      is_default: true
    });
  }

  const openaiKey = firstEnv("SHARED_OPENAI_API_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_API_KEY", "DEFAULT_API_KEY");
  if (openaiKey) {
    accounts.push({
      id: "shared-openai",
      label: "Shared OpenAI",
      provider: "openai",
      base_url: firstEnv("SHARED_OPENAI_BASE_URL", "DEFAULT_OPENAI_COMPAT_BASE_URL") || "https://api.openai.com/v1",
      model: firstEnv("SHARED_OPENAI_MODEL", "DEFAULT_MODEL") || "gpt-4.1-mini",
      api_key_encrypted: openaiKey,
      is_default: accounts.length === 0
    });
  }

  const ollamaBaseUrl = firstEnv("SHARED_OLLAMA_BASE_URL", "OLLAMA_BASE_URL");
  if (ollamaBaseUrl) {
    accounts.push({
      id: "shared-ollama",
      label: "Shared Ollama",
      provider: "compatible",
      base_url: ollamaBaseUrl,
      model: firstEnv("SHARED_OLLAMA_MODEL", "OLLAMA_MODEL") || "llama3.1",
      api_key_encrypted: firstEnv("SHARED_OLLAMA_API_KEY", "OLLAMA_API_KEY") || "ollama",
      is_default: accounts.length === 0
    });
  }

  return accounts;
}

app.get("/api/agents", (_req, res) => {
  res.json({ agents: fallbackAgents.map(({ id, name, role }) => ({ id, name, role })) });
});

app.get("/api/accounts", async (req, res) => {
  const shared = sharedAccounts().map(publicAccount);
  try {
    const { data, error } = await userDb(req)
      .from("ai_accounts")
      .select("id,label,provider,base_url,model,is_default")
      .eq("user_id", userId(req));
    if (error) throw error;
    res.json({ accounts: [...shared, ...(data ?? [])] });
  } catch {
    res.json({ accounts: shared });
  }
});

app.post("/api/accounts", async (req, res, next) => {
  try {
    const { label, provider, baseUrl, model, apiKey, isDefault } = req.body;
    const { data, error } = await userDb(req).from("ai_accounts").insert({
      user_id: userId(req), label, provider, base_url: baseUrl, model, api_key_encrypted: apiKey, is_default: Boolean(isDefault)
    }).select("id,label,provider,base_url,model,is_default").single();
    if (error) throw error;
    res.json({ account: data });
  } catch (error) { next(error); }
});

app.post("/api/accounts/:id/test", async (req, res, next) => {
  try {
    const account = await getAccount(req, req.params.id);
    const detail = await testModelConnection(account);
    res.json({ ok: true, detail });
  } catch (error) { next(error); }
});

app.get("/api/connectors", async (req, res) => {
  try {
    const { data, error } = await userDb(req)
      .from("connectors")
      .select("id,label,type,enabled,config,created_at,updated_at")
      .eq("user_id", userId(req))
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ connectors: data ?? [] });
  } catch {
    res.json({ connectors: [] });
  }
});

app.post("/api/connectors", async (req, res, next) => {
  try {
    const { data, error } = await userDb(req).from("connectors").insert({
      user_id: userId(req),
      label: req.body.label,
      type: req.body.type,
      enabled: req.body.enabled ?? true,
      config: req.body.config ?? {}
    }).select("id,label,type,enabled,config,created_at,updated_at").single();
    if (error) throw error;
    res.json({ connector: data });
  } catch (error) { next(error); }
});

app.post("/api/connectors/:id/test", async (req, res, next) => {
  try { res.json(await testConnectorConnection(userId(req), req.params.id)); } catch (error) { next(error); }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const { data, error } = await userDb(req)
      .from("conversations")
      .select("id,agent_id,title,created_at,updated_at")
      .eq("user_id", userId(req))
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ conversations: data ?? [] });
  } catch {
    res.json({ conversations: [] });
  }
});

app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { data, error } = await userDb(req)
      .from("messages")
      .select("id,agent_id,role,content,created_at")
      .eq("user_id", userId(req))
      .eq("conversation_id", req.params.id)
      .order("created_at");
    if (error) throw error;
    res.json({ messages: data ?? [] });
  } catch {
    res.json({ messages: [] });
  }
});

app.get("/api/memories", async (req, res) => {
  try {
    let query = userDb(req)
      .from("memories")
      .select("id,agent_id,category,learning,confidence,created_at")
      .eq("user_id", userId(req))
      .order("created_at", { ascending: false })
      .limit(80);
    const agentId = String(req.query.agentId || "");
    if (agentId) query = query.eq("agent_id", agentId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ memories: data ?? [] });
  } catch {
    res.json({ memories: [] });
  }
});

app.patch("/api/memories/:id", async (req, res, next) => {
  try {
    const updates: Record<string, string | number> = {};
    if (req.body.category) updates.category = req.body.category;
    if (req.body.learning) updates.learning = req.body.learning;
    if (typeof req.body.confidence === "number") updates.confidence = req.body.confidence;
    const { data, error } = await userDb(req)
      .from("memories")
      .update(updates)
      .eq("user_id", userId(req))
      .eq("id", req.params.id)
      .select("id,agent_id,category,learning,confidence,created_at")
      .single();
    if (error) throw error;
    res.json({ memory: data });
  } catch (error) { next(error); }
});

app.delete("/api/memories/:id", async (req, res, next) => {
  try {
    const { error } = await userDb(req).from("memories").delete().eq("user_id", userId(req)).eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/uploads", async (req, res) => {
  try {
    const { data, error } = await userDb(req)
      .from("uploads")
      .select("id,file_name,mime_type,byte_size,storage_path,created_at")
      .eq("user_id", userId(req))
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ uploads: data ?? [] });
  } catch {
    res.json({ uploads: [] });
  }
});

app.post("/api/uploads", upload.array("files"), async (req, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const rows = files.map(file => ({ user_id: userId(req), conversation_id: req.body.conversationId || null, file_name: file.originalname, mime_type: file.mimetype || "application/octet-stream", byte_size: file.size, storage_path: `${userId(req)}/${Date.now()}-${file.originalname}`, extracted_text: file.mimetype.startsWith("text/") ? file.buffer.toString("utf8").slice(0, 12000) : null }));
    const { data, error } = await userDb(req).from("uploads").insert(rows).select("id,file_name,mime_type,byte_size,storage_path,created_at");
    if (error) throw error;
    res.json({ uploads: data ?? [] });
  } catch (error) { next(error); }
});

app.get("/api/search", async (req, res) => {
  try {
    const { data, error } = await userDb(req).rpc("keyword_search", {
      search_user_id: userId(req),
      search_agent_id: String(req.query.agentId || "jarvis"),
      query: String(req.query.q || ""),
      match_count: 10
    });
    if (error) throw error;
    res.json({ results: data ?? [] });
  } catch {
    res.json({ results: [] });
  }
});

app.get("/api/export/:id", async (req, res, next) => {
  try {
    const { data, error } = await userDb(req)
      .from("messages")
      .select("role,content,created_at")
      .eq("user_id", userId(req))
      .eq("conversation_id", req.params.id)
      .order("created_at");
    if (error) throw error;
    res.type("text/markdown").send((data ?? []).map(message => `## ${message.role}\n\n${typeof message.content === "string" ? message.content : message.content?.text || JSON.stringify(message.content)}\n`).join("\n"));
  } catch (error) { next(error); }
});

app.get("/api/deploy-check", (_req, res) => res.json({ checks: [
  { name: "Supabase URL", ok: Boolean(process.env.SUPABASE_URL), detail: process.env.SUPABASE_URL ? "Configured" : "Missing" },
  { name: "Supabase public key", ok: Boolean(firstEnv("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY")), detail: firstEnv("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY") ? "Configured" : "Missing" },
  { name: "Supabase service key", ok: Boolean(firstEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY")), detail: firstEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY") ? "Configured, but app can now work without it for user data" : "Missing" },
  { name: "Shared Gemini", ok: Boolean(firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY")), detail: firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY") ? "Configured for all users" : "Missing" },
  { name: "Shared OpenAI", ok: Boolean(firstEnv("SHARED_OPENAI_API_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_API_KEY", "DEFAULT_API_KEY")), detail: firstEnv("SHARED_OPENAI_API_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_API_KEY", "DEFAULT_API_KEY") ? "Configured for all users" : "Missing" },
  { name: "Frontend build", ok: fs.existsSync(distPath), detail: fs.existsSync(distPath) ? "dist found" : "dist missing until build runs" }
] }));

app.post("/api/chat/stream", async (req, res, next) => {
  try {
    const uid = userId(req);
    const requestedAgentId = req.body.agentId || "jarvis";
    const userText = String(req.body.message || "");
    const routed = routeAgent(requestedAgentId, userText);
    const account = await getAccount(req, req.body.accountId);
    const memories = await safeGetRelevantMemory(req, routed.id);
    const connectorContext = await safeBuildConnectorContext(uid, routed.id, userText);
    const conversationId = await getOrCreateConversation(req, req.body.conversationId, routed.id, userText);
    const userMessage = await insertMessage(req, conversationId, routed.id, "user", userText);
    const system = buildSystemPrompt({ routedAgentId: routed.id, requestedAgentId, memories });
    const modelMessages = [{ role: "system" as const, content: system }, { role: "user" as const, content: `${userText}${connectorContext.context}` }];

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let answer = "";
    for await (const token of streamModel(account, modelMessages)) {
      answer += token;
      res.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
    }
    const sourceTrail = buildSourceTrail(account, memories.length, connectorContext.sources);
    answer += sourceTrail;
    res.write(`data: ${JSON.stringify({ type: "token", token: sourceTrail })}\n\n`);
    const assistantMessage = await insertMessage(req, conversationId, routed.id, "assistant", answer);
    await safeLearnFromMessage({ userId: uid, agentId: routed.id, messageId: userMessage.id, userText, fileNames: [] });
    await userDb(req).from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    res.write(`data: ${JSON.stringify({ type: "done", conversationId, agentId: routed.id, messageId: assistantMessage.id })}\n\n`);
    res.end();
  } catch (error) { next(error); }
});

async function getAccount(req: express.Request, accountId?: string): Promise<Account> {
  const shared = sharedAccounts();
  if (accountId && accountId !== "auto") {
    const sharedMatch = shared.find(account => account.id === accountId);
    if (sharedMatch) return sharedMatch;
  }

  try {
    let query = userDb(req).from("ai_accounts").select("id,label,provider,base_url,model,api_key_encrypted,is_default").eq("user_id", userId(req));
    if (accountId && accountId !== "auto") query = query.eq("id", accountId);
    else query = query.order("is_default", { ascending: false }).limit(1);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) throw error;
    if (data) return data as Account;
  } catch {
    // Fall back to shared environment accounts.
  }

  const fallback = shared.find(account => account.is_default) ?? shared[0];
  if (fallback) return fallback;
  throw new Error("No shared AI account is configured. Add SHARED_GEMINI_API_KEY or SHARED_OPENAI_API_KEY in Render Environment.");
}

async function safeGetRelevantMemory(req: express.Request, agentId: string) {
  try {
    const { data, error } = await userDb(req)
      .from("memories")
      .select("category, learning")
      .eq("user_id", userId(req))
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) throw error;
    return data ?? [];
  } catch { return []; }
}

async function safeBuildConnectorContext(userIdValue: string, agentId: string, userText: string) {
  try { return await buildConnectorContext(userIdValue, agentId, userText); } catch { return { context: "", sources: [] }; }
}

async function safeLearnFromMessage(params: { userId: string; agentId: string; messageId: string; userText: string; fileNames: string[] }) {
  try { await learnFromMessage(params); } catch { /* Learning should not block answers. */ }
}

async function getOrCreateConversation(req: express.Request, id: string | undefined, agentId: string, userText: string) {
  if (id) return id;
  const title = userText.slice(0, 60) || "New conversation";
  try {
    const { data, error } = await userDb(req).from("conversations").insert({ user_id: userId(req), agent_id: agentId, title }).select("id").single();
    if (error) throw error;
    return data.id as string;
  } catch {
    return randomUUID();
  }
}

async function insertMessage(req: express.Request, conversationId: string, agentId: string, role: "user" | "assistant", text: string) {
  try {
    const { data, error } = await userDb(req).from("messages").insert({ conversation_id: conversationId, user_id: userId(req), agent_id: agentId, role, content: text }).select("id").single();
    if (error) throw error;
    return data as { id: string };
  } catch {
    return { id: randomUUID() };
  }
}

function buildSourceTrail(account: Account, memoryCount: number, sources: Array<{ label: string; note?: string; links?: Array<{ title: string; url: string }> }>) {
  const connectorLine = sources.length ? sources.map(source => `${source.label}${source.links?.length ? ` | ${source.links.map(link => link.url).join(" ")}` : ""}`).join("; ") : "none enabled or no connector context used";
  return `\n\n---\nSource Trail\n- Active AI account: ${account.label || account.provider} (${account.model})\n- Learned memory: ${memoryCount} saved pattern(s) considered\n- Connectors checked: ${connectorLine}\n- Source links status: ${sources.some(source => source.links?.length) ? "links included above" : "no link-bearing source used for this reply"}`;
}

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Server error";
  if (!res.headersSent) res.status(500).json({ error: message });
});

app.listen(port, () => console.log(`AI Agents listening on http://localhost:${port}`));
