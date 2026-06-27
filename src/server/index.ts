import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "node:fs";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { fallbackAgents } from "./agents";
import { requireAuth, type AuthedRequest } from "./auth";
import { learnFromMessage } from "./memory";
import { buildSystemPrompt, routeAgent } from "./orchestrator";
import { streamModel, testModelConnection, type Account } from "./providers";
import { createUserSupabase } from "./supabase";
import { registerCoderRoutes } from "./coder/enforcement";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../../dist");
const sharedDailyRequestLimit = Number(process.env.SHARED_AI_DAILY_REQUEST_LIMIT || 30);
const sharedDailyTokenLimit = Number(process.env.SHARED_AI_DAILY_TOKEN_LIMIT || 60000);
const dailyNewsCronSecret = firstEnv("DAILY_NEWS_CRON_SECRET", "AUTOMATION_CRON_SECRET");
const startedAt = new Date().toISOString();
const buildSha = firstEnv("RENDER_GIT_COMMIT", "GIT_COMMIT", "COMMIT_SHA") || "local";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/healthz", (_req, res) => res.json({
  ok: true,
  app: "AI Agents",
  startedAt,
  buildSha,
  buildTime: process.env.BUILD_TIME || process.env.RENDER_DEPLOY_CREATED_AT || "unknown",
  nodeEnv: process.env.NODE_ENV || "development",
  dist: fs.existsSync(distPath)
}));
app.all("/cron/daily-news", async (req, res, next) => {
  try {
    if (!matchesSecret(cronSecret(req), dailyNewsCronSecret)) {
      res.status(403).json({ error: "Missing or invalid cron secret" });
      return;
    }
    const result = await sendDailyNewsUpdate();
    res.json({ ok: true, detail: `Daily news sent with ${result.provider}.`, result });
  } catch (error) {
    next(error);
  }
});
app.use("/api", requireAuth);

function authed(req: express.Request) { return req as AuthedRequest; }
function userId(req: express.Request) { return authed(req).user.id; }
function userDb(req: express.Request) { return createUserSupabase(authed(req).accessToken); }
function userEmail(req: express.Request) { return String((authed(req).user as { email?: string }).email || "").toLowerCase(); }

function publicAccount(account: Account & { id?: string; is_default?: boolean }) {
  return { id: account.id, label: account.label, provider: account.provider, base_url: account.base_url, model: account.model, is_default: Boolean(account.is_default) };
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !isPlaceholder(value)) return value;
  }
  return "";
}

function isPlaceholder(value: string) {
  const lowered = value.toLowerCase();
  return ["your gemini key", "your openai key", "your groq key", "your openrouter key", "your together key", "your api key", "api key", "placeholder", "changeme"].includes(lowered) || lowered.startsWith("your-") || lowered.startsWith("replace");
}

function sharedAccounts(): Array<Account & { id: string; is_default: boolean }> {
  const accounts: Array<Account & { id: string; is_default: boolean }> = [];
  const add = (account: Account & { id: string }) => accounts.push({ ...account, is_default: accounts.length === 0 });

  const geminiKey = firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY");
  if (geminiKey) add({ id: "shared-gemini", label: "Shared Gemini", provider: "gemini", base_url: firstEnv("SHARED_GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta", model: firstEnv("SHARED_GEMINI_MODEL") || "gemini-2.5-flash", api_key_encrypted: geminiKey });

  const groqKey = firstEnv("SHARED_GROQ_API_KEY", "GROQ_API_KEY");
  if (groqKey) add({ id: "shared-groq", label: "Shared Groq", provider: "groq", base_url: firstEnv("SHARED_GROQ_BASE_URL") || "https://api.groq.com/openai/v1", model: firstEnv("SHARED_GROQ_MODEL") || "llama-3.1-8b-instant", api_key_encrypted: groqKey });

  const openRouterKey = firstEnv("SHARED_OPENROUTER_API_KEY", "OPENROUTER_API_KEY");
  if (openRouterKey) add({ id: "shared-openrouter", label: "Shared OpenRouter", provider: "openrouter", base_url: firstEnv("SHARED_OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1", model: firstEnv("SHARED_OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free", api_key_encrypted: openRouterKey });

  const togetherKey = firstEnv("SHARED_TOGETHER_API_KEY", "TOGETHER_API_KEY");
  if (togetherKey) add({ id: "shared-together", label: "Shared Together", provider: "together", base_url: firstEnv("SHARED_TOGETHER_BASE_URL") || "https://api.together.xyz/v1", model: firstEnv("SHARED_TOGETHER_MODEL") || "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", api_key_encrypted: togetherKey });

  const openaiKey = firstEnv("SHARED_OPENAI_API_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_API_KEY", "DEFAULT_API_KEY");
  if (openaiKey) add({ id: "shared-openai", label: "Shared OpenAI", provider: "openai", base_url: firstEnv("SHARED_OPENAI_BASE_URL", "DEFAULT_OPENAI_COMPAT_BASE_URL") || "https://api.openai.com/v1", model: firstEnv("SHARED_OPENAI_MODEL", "DEFAULT_MODEL") || "gpt-4.1-mini", api_key_encrypted: openaiKey });

  const ollamaBaseUrl = firstEnv("SHARED_OLLAMA_BASE_URL", "OLLAMA_BASE_URL");
  if (ollamaBaseUrl) add({ id: "shared-ollama", label: "Shared Ollama", provider: "compatible", base_url: ollamaBaseUrl, model: firstEnv("SHARED_OLLAMA_MODEL", "OLLAMA_MODEL") || "llama3.1", api_key_encrypted: firstEnv("SHARED_OLLAMA_API_KEY", "OLLAMA_API_KEY") || "ollama" });

  return accounts;
}

app.get("/api/agents", (_req, res) => res.json({ agents: fallbackAgents.map(({ id, name, role }) => ({ id, name, role })) }));

app.get("/api/accounts", async (req, res) => {
  const shared = sharedAccounts().map(publicAccount);
  try {
    const { data, error } = await userDb(req).from("ai_accounts").select("id,label,provider,base_url,model,is_default").eq("user_id", userId(req));
    if (error) throw error;
    res.json({ accounts: [...shared, ...(data ?? [])] });
  } catch { res.json({ accounts: shared }); }
});

app.post("/api/accounts", async (req, res, next) => {
  try {
    const { label, provider, baseUrl, model, apiKey, isDefault } = req.body;
    const { data, error } = await userDb(req).from("ai_accounts").insert({ user_id: userId(req), label, provider, base_url: baseUrl, model, api_key_encrypted: apiKey, is_default: Boolean(isDefault) }).select("id,label,provider,base_url,model,is_default").single();
    if (error) throw error;
    res.json({ account: data });
  } catch (error) { next(error); }
});

app.post("/api/accounts/:id/test", async (req, res, next) => {
  try { res.json({ ok: true, detail: await testModelConnection(await getAccount(req, req.params.id)) }); }
  catch (error) { next(error); }
});

app.get("/api/connectors", async (req, res) => {
  try {
    const { data, error } = await userDb(req).from("connectors").select("id,label,type,enabled,config,created_at,updated_at").eq("user_id", userId(req)).order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ connectors: data ?? [] });
  } catch { res.json({ connectors: [] }); }
});

app.post("/api/connectors", async (req, res, next) => {
  try {
    const { data, error } = await userDb(req).from("connectors").insert({ user_id: userId(req), label: req.body.label, type: req.body.type, enabled: req.body.enabled ?? true, config: req.body.config ?? {} }).select("id,label,type,enabled,config,created_at,updated_at").single();
    if (error) throw error;
    res.json({ connector: data });
  } catch (error) { next(error); }
});

app.post("/api/connectors/:id/test", async (req, res, next) => {
  try {
    const { data, error } = await userDb(req).from("connectors").select("id,label,type,enabled,config").eq("user_id", userId(req)).eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ ok: false, detail: "Connector not found." });
    if (!data.enabled) return res.status(400).json({ ok: false, detail: "Connector is saved but disabled." });
    const config = (data.config ?? {}) as Record<string, unknown>;
    if (data.type === "web_search") {
      const provider = String(config.provider || "").trim();
      const apiKey = String(config.apiKey || config.api_key || "").trim();
      return res.status(provider && apiKey ? 200 : 400).json({ ok: Boolean(provider && apiKey), detail: provider && apiKey ? `Web search connector is configured for ${provider}.` : "Web search needs provider and apiKey in connector config." });
    }
    res.json({ ok: true, detail: `${data.label || data.type} is saved and readable for this user.` });
  } catch (error) { next(error); }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const { data, error } = await userDb(req).from("conversations").select("id,agent_id,title,created_at,updated_at").eq("user_id", userId(req)).order("updated_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ conversations: data ?? [] });
  } catch { res.json({ conversations: [] }); }
});

app.get("/api/conversations/:id/messages", async (req, res) => {
  try {
    const { data, error } = await userDb(req).from("messages").select("id,agent_id,role,content,created_at").eq("user_id", userId(req)).eq("conversation_id", req.params.id).order("created_at");
    if (error) throw error;
    res.json({ messages: data ?? [] });
  } catch { res.json({ messages: [] }); }
});

app.get("/api/memories", async (req, res) => {
  try {
    let query = userDb(req).from("memories").select("id,agent_id,category,learning,confidence,created_at").eq("user_id", userId(req)).order("created_at", { ascending: false }).limit(80);
    const agentId = String(req.query.agentId || "");
    if (agentId) query = query.eq("agent_id", agentId);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ memories: data ?? [] });
  } catch { res.json({ memories: [] }); }
});

app.patch("/api/memories/:id", async (req, res, next) => {
  try {
    const updates: Record<string, string | number> = {};
    if (req.body.category) updates.category = req.body.category;
    if (req.body.learning) updates.learning = req.body.learning;
    if (typeof req.body.confidence === "number") updates.confidence = req.body.confidence;
    const { data, error } = await userDb(req).from("memories").update(updates).eq("user_id", userId(req)).eq("id", req.params.id).select("id,agent_id,category,learning,confidence,created_at").single();
    if (error) throw error;
    res.json({ memory: data });
  } catch (error) { next(error); }
});

app.delete("/api/memories/:id", async (req, res, next) => {
  try { const { error } = await userDb(req).from("memories").delete().eq("user_id", userId(req)).eq("id", req.params.id); if (error) throw error; res.json({ ok: true }); }
  catch (error) { next(error); }
});

app.get("/api/uploads", async (req, res) => {
  try {
    const { data, error } = await userDb(req).from("uploads").select("id,file_name,mime_type,byte_size,storage_path,created_at").eq("user_id", userId(req)).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ uploads: data ?? [] });
  } catch { res.json({ uploads: [] }); }
});

app.post("/api/uploads", upload.array("files"), async (req, res, next) => {
  try {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) return res.json({ uploads: [] });
    const rows = files.map(file => ({ user_id: userId(req), conversation_id: req.body.conversationId || null, file_name: file.originalname, mime_type: file.mimetype || "application/octet-stream", byte_size: file.size, storage_path: `${userId(req)}/${Date.now()}-${file.originalname}`, extracted_text: file.mimetype.startsWith("text/") ? file.buffer.toString("utf8").slice(0, 12000) : null }));
    const { data, error } = await userDb(req).from("uploads").insert(rows).select("id,file_name,mime_type,byte_size,storage_path,created_at");
    if (error) throw error;
    res.json({ uploads: data ?? [] });
  } catch (error) { next(error); }
});

app.get("/api/search", async (req, res) => {
  try {
    const { data, error } = await userDb(req).rpc("keyword_search", { search_user_id: userId(req), search_agent_id: String(req.query.agentId || "jarvis"), query: String(req.query.q || ""), match_count: 10 });
    if (error) throw error;
    res.json({ results: data ?? [] });
  } catch { res.json({ results: [] }); }
});

app.get("/api/export/:id", async (req, res, next) => {
  try {
    const { data, error } = await userDb(req).from("messages").select("role,content,created_at").eq("user_id", userId(req)).eq("conversation_id", req.params.id).order("created_at");
    if (error) throw error;
    res.type("text/markdown").send((data ?? []).map((message: { role: string; content: unknown }) => {
      const content = message.content as { text?: string } | string | null;
      const text = typeof content === "string" ? content : content?.text || JSON.stringify(content);
      return `## ${message.role}\n\n${text}\n`;
    }).join("\n"));
  } catch (error) { next(error); }
});

app.get("/api/deploy-check", (_req, res) => res.json({ checks: [
  { name: "Supabase URL", ok: Boolean(process.env.SUPABASE_URL), detail: process.env.SUPABASE_URL ? "Configured" : "Missing" },
  { name: "Supabase public key", ok: Boolean(firstEnv("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY")), detail: firstEnv("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY") ? "Configured" : "Missing" },
  { name: "Supabase service key", ok: Boolean(firstEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY")), detail: firstEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY") ? "Configured, but app can now work without it for user data" : "Missing" },
  { name: "Shared Gemini", ok: Boolean(firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY")), detail: firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY") ? "Configured for all users" : "Missing" },
  { name: "Shared Groq", ok: Boolean(firstEnv("SHARED_GROQ_API_KEY", "GROQ_API_KEY")), detail: firstEnv("SHARED_GROQ_API_KEY", "GROQ_API_KEY") ? "Configured fallback" : "Optional fallback missing" },
  { name: "Shared OpenRouter", ok: Boolean(firstEnv("SHARED_OPENROUTER_API_KEY", "OPENROUTER_API_KEY")), detail: firstEnv("SHARED_OPENROUTER_API_KEY", "OPENROUTER_API_KEY") ? "Configured fallback" : "Optional fallback missing" },
  { name: "Daily quota guard", ok: true, detail: `${sharedDailyRequestLimit} requests/day and ${sharedDailyTokenLimit} estimated tokens/day per user` },
  { name: "Free Telegram automation", ok: telegramConfigured(), detail: telegramConfigured() ? "Configured for daily updates" : "Optional: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for free daily updates" },
  { name: "WhatsApp automation", ok: whatsappConfigured(), detail: whatsappConfigured() ? `Configured with ${whatsappProvider()} as optional fallback` : "Optional legacy fallback; Telegram is preferred for free daily updates" },
  { name: "Daily news cron", ok: Boolean(dailyNewsCronSecret), detail: dailyNewsCronSecret ? "Use /cron/daily-news at 9 AM IST with the cron secret" : "Add DAILY_NEWS_CRON_SECRET for scheduled delivery" },
  { name: "Vite secret audit", ok: viteSecretAudit().ok, detail: viteSecretAudit().detail },
  { name: "Deploy status", ok: true, detail: `healthz ready, build SHA ${buildSha}` },
  { name: "Frontend build", ok: fs.existsSync(distPath), detail: fs.existsSync(distPath) ? "dist found" : "dist missing until build runs" }
] }));

registerCoderRoutes(app, { userId });

app.post("/api/automations/whatsapp", async (req, res, next) => {
  try {
    const taskTitle = String(req.body.taskTitle || "").trim();
    const customMessage = String(req.body.message || "").trim();
    const taskStatus = String(req.body.status || "todo").trim();
    const body = customMessage || `AI Agents task reminder\n\nTask: ${taskTitle}\nStatus: ${taskStatus}\nRequested by: ${userEmail(req) || "signed-in user"}`;

    if (!body.trim() || (!taskTitle && !customMessage)) {
      res.status(400).json({ error: "Task title or message is required" });
      return;
    }

    const result = await sendWhatsAppMessage(body.slice(0, 1500));
    res.json({ ok: true, detail: `WhatsApp message sent with ${result.provider}.`, result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/automations/telegram", async (req, res, next) => {
  try {
    const taskTitle = String(req.body.taskTitle || "").trim();
    const customMessage = String(req.body.message || "").trim();
    const taskStatus = String(req.body.status || "todo").trim();
    const body = customMessage || `AI Agents task reminder\n\nTask: ${taskTitle}\nStatus: ${taskStatus}\nRequested by: ${userEmail(req) || "signed-in user"}`;

    if (!body.trim() || (!taskTitle && !customMessage)) {
      res.status(400).json({ error: "Task title or message is required" });
      return;
    }

    const result = await sendTelegramMessage(body.slice(0, 3900));
    res.json({ ok: true, detail: `Telegram message sent.`, result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/automations/daily-news/test", async (_req, res, next) => {
  try {
    const result = await sendDailyNewsUpdate();
    res.json({ ok: true, detail: `Daily news sent with ${result.provider}.`, result });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat/stream", async (req, res, next) => {
  try {
    const uid = userId(req);
    const requestedAgentId = req.body.agentId || "jarvis";
    const userText = String(req.body.message || "");
    await checkQuota(req, userText);
    const routed = routeAgent(requestedAgentId, userText);
    const account = await getAccount(req, req.body.accountId);
    const memories = await safeGetRelevantMemory(req, routed.id);
    const connectorContext = await safeBuildConnectorContext(req, routed.id);
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
    const sourceTrail = shouldShowSourceTrail(memories.length, connectorContext.sources) ? buildSourceTrail(account, memories.length, connectorContext.sources) : "";
    if (sourceTrail) {
      answer += sourceTrail;
      res.write(`data: ${JSON.stringify({ type: "token", token: sourceTrail })}\n\n`);
    }
    const assistantMessage = await insertMessage(req, conversationId, routed.id, "assistant", answer);
    await safeLearnFromMessage({ userId: uid, agentId: routed.id, messageId: userMessage.id, userText, fileNames: [] });
    await userDb(req).from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
    res.write(`data: ${JSON.stringify({ type: "done", conversationId, agentId: routed.id, messageId: assistantMessage.id })}\n\n`);
    res.end();
  } catch (error) {
    const message = errorMessage(error);
    if (res.headersSent) { res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`); res.end(); return; }
    next(error);
  }
});

async function checkQuota(req: express.Request, userText: string) {
  if (isQuotaExempt(req)) return;
  const tokenEstimate = Math.max(1, Math.ceil(userText.length / 4));
  const { data, error } = await userDb(req).rpc("increment_ai_daily_usage", { target_user_id: userId(req), request_increment: 1, token_increment: tokenEstimate });
  if (error) {
    console.warn("Daily quota check failed", error.message);
    if (process.env.SHARED_AI_QUOTA_FAIL_OPEN === "true") return;
    throw new Error("Daily quota guard is not ready. Run supabase/ai_daily_usage.sql, then retry.");
  }
  const row = Array.isArray(data) ? data[0] : data;
  const requestCount = Number(row?.request_count ?? 0);
  const tokenCount = Number(row?.token_estimate ?? 0);
  if (requestCount > sharedDailyRequestLimit || tokenCount > sharedDailyTokenLimit) {
    throw new Error(`Daily shared AI limit reached (${requestCount}/${sharedDailyRequestLimit} requests today). Add your own AI account or try again tomorrow.`);
  }
}

function isQuotaExempt(req: express.Request) {
  const allowlist = String(process.env.SHARED_AI_LIMIT_EXEMPT_EMAILS || "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  return allowlist.includes(userEmail(req));
}

function whatsappProvider() {
  if (firstEnv("TWILIO_ACCOUNT_SID") && firstEnv("TWILIO_AUTH_TOKEN")) return "Twilio";
  if (firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN") && firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID")) return "Meta Cloud API";
  return "none";
}

function whatsappConfigured() {
  const twilioReady = Boolean(
    firstEnv("TWILIO_ACCOUNT_SID") &&
    firstEnv("TWILIO_AUTH_TOKEN") &&
    firstEnv("TWILIO_WHATSAPP_FROM") &&
    firstEnv("TWILIO_WHATSAPP_TO")
  );
  const metaReady = Boolean(
    firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN") &&
    firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID") &&
    firstEnv("WHATSAPP_TO")
  );
  return twilioReady || metaReady;
}

async function sendWhatsAppMessage(body: string) {
  if (firstEnv("TWILIO_ACCOUNT_SID") && firstEnv("TWILIO_AUTH_TOKEN")) {
    return sendTwilioWhatsApp(body);
  }
  if (firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN") && firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID")) {
    return sendMetaWhatsApp(body);
  }
  throw new Error("WhatsApp is not configured. Add Twilio or Meta WhatsApp env vars in Render.");
}

async function sendDailyNewsUpdate() {
  const brief = await buildDailyNewsBrief();
  if (telegramConfigured()) return sendTelegramMessage(brief.slice(0, 3900));
  return sendWhatsAppMessage(brief.slice(0, 3000));
}

function telegramConfigured() {
  return Boolean(firstEnv("TELEGRAM_BOT_TOKEN") && firstEnv("TELEGRAM_CHAT_ID"));
}

async function sendTelegramMessage(body: string) {
  const token = firstEnv("TELEGRAM_BOT_TOKEN");
  const chatId = firstEnv("TELEGRAM_CHAT_ID");
  if (!token || !chatId) throw new Error("Telegram is not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Render.");

  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: false })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Telegram failed: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { result?: { message_id?: number } };
  return { provider: "Telegram", id: payload.result?.message_id, status: "sent" };
}

async function buildDailyNewsBrief() {
  const feeds = [
    { section: "World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { section: "India", url: "https://www.thehindu.com/news/national/feeder/default.rss" },
    { section: "Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
    { section: "Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
    { section: "Science", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
    { section: "Sports", url: "https://feeds.bbci.co.uk/sport/rss.xml" }
  ];
  const sections = await Promise.all(feeds.map(async feed => {
    const items = await fetchRssItems(feed.url);
    return { ...feed, item: items[0] };
  }));
  const today = new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeZone: "Asia/Kolkata" }).format(new Date());
  const lines = [
    `AI Agents Daily News - ${today}`,
    "Top updates with source links:",
    ""
  ];

  for (const section of sections) {
    if (!section.item) continue;
    lines.push(`${section.section}: ${section.item.title}`);
    lines.push(section.item.link);
    lines.push("");
  }

  lines.push("Source standard: BBC RSS + The Hindu national feed; links are included directly above.");
  return lines.join("\n").trim();
}

async function fetchRssItems(url: string) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "AI Agents daily news bot" } });
    if (!response.ok) throw new Error(`RSS failed ${response.status}`);
    const xml = await response.text();
    return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map(match => ({
      title: decodeXml(readXmlTag(match[0], "title")),
      link: decodeXml(readXmlTag(match[0], "link"))
    })).filter(item => item.title && item.link).slice(0, 3);
  } catch (error) {
    console.warn(`Daily news feed failed: ${url}`, errorMessage(error));
    return [];
  }
}

async function sendTwilioWhatsApp(body: string) {
  const sid = firstEnv("TWILIO_ACCOUNT_SID");
  const token = firstEnv("TWILIO_AUTH_TOKEN");
  const from = ensureWhatsAppPrefix(firstEnv("TWILIO_WHATSAPP_FROM"));
  const to = ensureWhatsAppPrefix(firstEnv("TWILIO_WHATSAPP_TO"));
  if (!sid || !token || !from || !to) throw new Error("Missing Twilio WhatsApp env vars.");

  const form = new URLSearchParams({ From: from, To: to });
  const contentSid = firstEnv("TWILIO_CONTENT_SID");
  if (contentSid) {
    form.set("ContentSid", contentSid);
    form.set("ContentVariables", buildTwilioContentVariables(body));
  } else {
    form.set("Body", body);
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Twilio WhatsApp failed: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { sid?: string; status?: string };
  return { provider: "Twilio", id: payload.sid, status: payload.status };
}

async function sendMetaWhatsApp(body: string) {
  const token = firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN");
  const phoneNumberId = firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID");
  const to = firstEnv("WHATSAPP_TO").replace(/[^\d]/g, "");
  const version = firstEnv("WHATSAPP_CLOUD_API_VERSION") || "v20.0";
  if (!token || !phoneNumberId || !to) throw new Error("Missing Meta WhatsApp Cloud API env vars.");

  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Meta WhatsApp failed: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { messages?: Array<{ id?: string }> };
  return { provider: "Meta Cloud API", id: payload.messages?.[0]?.id, status: "sent" };
}

function ensureWhatsAppPrefix(value: string) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function buildTwilioContentVariables(body: string) {
  const custom = firstEnv("TWILIO_CONTENT_VARIABLES");
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, String(value || " ").trim() || " "])
      ));
    } catch {
      console.warn("TWILIO_CONTENT_VARIABLES is not valid JSON; using daily-news defaults.");
    }
  }
  const compactBody = body.replace(/\s+/g, " ").trim().slice(0, 950) || "Daily news update";
  return JSON.stringify({
    "1": compactBody,
    "2": new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeZone: "Asia/Kolkata"
    }).format(new Date())
  });
}

function readXmlTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return (match?.[1] || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function cronSecret(req: express.Request) {
  return String(req.query.secret || req.headers["x-cron-secret"] || req.headers.authorization?.replace(/^Bearer\s+/i, "") || "");
}

function matchesSecret(actual: string, expected: string) {
  if (!expected || !actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function viteSecretAudit() {
  const risky = Object.keys(process.env).filter(name => /^VITE_/.test(name) && /(KEY|SECRET|TOKEN|PASSWORD)/i.test(name) && name !== "VITE_SUPABASE_ANON_KEY");
  return risky.length
    ? { ok: false, detail: `Possible browser-exposed secrets: ${risky.join(", ")}` }
    : { ok: true, detail: "No VITE_* secret env vars detected except the public Supabase anon key" };
}

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
  } catch { /* Fall back to shared environment accounts. */ }
  const fallback = shared.find(account => account.is_default) ?? shared[0];
  if (fallback) return fallback;
  throw new Error("No shared AI account is configured. Add SHARED_GEMINI_API_KEY or SHARED_GROQ_API_KEY in Render Environment.");
}

async function safeGetRelevantMemory(req: express.Request, agentId: string) {
  try {
    const { data, error } = await userDb(req).from("memories").select("category, learning").eq("user_id", userId(req)).eq("agent_id", agentId).order("created_at", { ascending: false }).limit(12);
    if (error) throw error;
    return data ?? [];
  } catch { return []; }
}

async function safeBuildConnectorContext(req: express.Request, agentId: string) {
  try {
    const { data, error } = await userDb(req).from("connectors").select("label,type,enabled,config").eq("user_id", userId(req)).eq("enabled", true);
    if (error) throw error;
    const sources = (data ?? []).map((connector: { label: string; type: string; config: Record<string, unknown> | null }) => {
      const config = (connector.config ?? {}) as Record<string, unknown>;
      const links = String(config.url || config.baseUrl || config.link || "") ? [{ title: `${connector.label} link`, url: String(config.url || config.baseUrl || config.link) }] : undefined;
      return { label: connector.label, type: connector.type, status: "available", resultCount: 0, note: connector.type === "web_search" ? "Connector is configured for source checking." : "Connector is available for this agent.", links };
    });
    const memories = await safeGetRelevantMemory(req, agentId);
    const context = memories.length ? `\n\n[LEARNED MEMORY]\n${memories.slice(0, 6).map((memory: { category: string; learning: string }) => `- ${memory.category}: ${memory.learning}`).join("\n")}` : "";
    return { context, sources };
  } catch { return { context: "", sources: [] }; }
}

async function safeLearnFromMessage(params: { userId: string; agentId: string; messageId: string; userText: string; fileNames: string[] }) {
  try { await learnFromMessage(params); } catch { /* Learning should not block answers. */ }
}

async function getOrCreateConversation(req: express.Request, id: string | undefined, agentId: string, userText: string) {
  if (id) return id;
  try {
    const { data, error } = await userDb(req).from("conversations").insert({ user_id: userId(req), agent_id: agentId, title: userText.slice(0, 60) || "New conversation" }).select("id").single();
    if (error) throw error;
    return data.id as string;
  } catch { return randomUUID(); }
}

async function insertMessage(req: express.Request, conversationId: string, agentId: string, role: "user" | "assistant", text: string) {
  try {
    const { data, error } = await userDb(req).from("messages").insert({ conversation_id: conversationId, user_id: userId(req), agent_id: agentId, role, content: text }).select("id").single();
    if (error) throw error;
    return data as { id: string };
  } catch { return { id: randomUUID() }; }
}

function shouldShowSourceTrail(memoryCount: number, sources: Array<{ links?: Array<{ title: string; url: string }> }>) {
  return memoryCount > 0 || sources.some(source => source.links?.length);
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return "Server error";
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = errorMessage(error);
  if (!res.headersSent) res.status(500).json({ error: friendlyServerError(message), detail: message });
});

function friendlyServerError(message: string) {
  if (/daily shared ai limit/i.test(message)) return message;
  if (/telegram is not configured/i.test(message)) return "Telegram is not configured yet. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Render Environment.";
  if (/whatsapp is not configured/i.test(message)) return "WhatsApp is not configured. Telegram is the preferred free automation channel.";
  if (/api key|unauthorized|401|403/i.test(message)) return "AI provider authentication failed. Check the shared provider key in Render Environment.";
  if (/quota|billing|429|rate limit/i.test(message)) return "The selected AI provider hit a quota, billing, or rate limit. Try again later or enable a fallback provider.";
  if (/timeout|timed out|abort/i.test(message)) return "The AI provider took too long to respond. The app will use a fallback provider when one is configured.";
  return message === "Server error" ? "Something went wrong on the server. Check Render logs for the technical detail." : message;
}

app.listen(port, () => console.log(`AI Agents listening on http://localhost:${port}`));
