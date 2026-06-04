import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import { requireAuth, type AuthedRequest } from "./auth";
import { fallbackAgents, getFallbackAgent } from "./agents";
import { buildConnectorContext, listConnectors, saveConnector, testConnectorConnection } from "./connectors";
import { deleteMemory, getRelevantMemory, learnFromMessage, listMemories, updateMemory } from "./memory";
import { buildSystemPrompt, routeAgent } from "./orchestrator";
import { collectModel, streamModel, testModelConnection, type Account, type ChatMessage } from "./providers";
import { keywordSearch } from "./search";
import { supabaseAdmin } from "./supabase";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const port = Number(process.env.PORT || 8787);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, "../../dist");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/agents", requireAuth, async (_req, res) => {
  try {
    await ensureAgentCatalog();
    res.json({ agents: fallbackAgents });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not load agents" });
  }
});

app.get("/api/deploy/check", requireAuth, async (_req, res) => {
  const checks = [
    { name: "Supabase URL", ok: Boolean(process.env.SUPABASE_URL), detail: process.env.SUPABASE_URL ? "Configured" : "Missing SUPABASE_URL" },
    { name: "Supabase service key", ok: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY), detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "Configured" : "Missing SUPABASE_SERVICE_ROLE_KEY" },
    { name: "Frontend API URL", ok: Boolean(process.env.VITE_API_URL), detail: process.env.VITE_API_URL || "Uses local default in development" },
    { name: "Default model", ok: Boolean(process.env.DEFAULT_MODEL), detail: process.env.DEFAULT_MODEL || "Uses account model or fallback" },
    { name: "Upload storage", ok: true, detail: "Bucket expected: kuhu-uploads" },
    { name: "Backend health", ok: true, detail: `Listening on port ${port}` }
  ];
  res.json({ checks });
});

app.get("/api/uploads", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { data, error } = await supabaseAdmin
    .from("uploads")
    .select("id,file_name,mime_type,byte_size,storage_path,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) res.status(500).json({ error: error.message });
  else res.json({ uploads: data ?? [] });
});
app.get("/api/accounts", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { data, error } = await supabaseAdmin
    .from("ai_accounts")
    .select("id,label,provider,base_url,model,is_default,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) res.status(500).json({ error: error.message });
  else res.json({ accounts: data });
});

app.post("/api/accounts", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { label, provider, baseUrl, model, apiKey, isDefault } = req.body;

  if (!label || !provider || !baseUrl || !model || !apiKey) {
    res.status(400).json({ error: "Missing account fields" });
    return;
  }

  if (isDefault) {
    await supabaseAdmin.from("ai_accounts").update({ is_default: false }).eq("user_id", userId);
  }

  const { data, error } = await supabaseAdmin
    .from("ai_accounts")
    .insert({
      user_id: userId,
      label,
      provider,
      base_url: baseUrl,
      model,
      api_key_encrypted: apiKey,
      is_default: Boolean(isDefault)
    })
    .select("id,label,provider,base_url,model,is_default")
    .single();

  if (error) res.status(500).json({ error: error.message });
  else res.json({ account: data });
});


app.post("/api/accounts/:id/test", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { data: account, error } = await getAccount(userId, req.params.id);
  if (error || !account) {
    res.status(404).json({ ok: false, detail: error || "AI account not found" });
    return;
  }

  try {
    const reply = await testModelConnection(account as Account);
    res.json({ ok: true, detail: `Connected. Test reply: ${reply.slice(0, 120)}` });
  } catch (testError) {
    res.status(400).json({ ok: false, detail: testError instanceof Error ? testError.message.slice(0, 300) : "AI account test failed" });
  }
});
app.delete("/api/memories/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  try {
    await deleteMemory(userId, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not delete memory" });
  }
});

app.patch("/api/memories/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  try {
    const memory = await updateMemory(userId, req.params.id, req.body ?? {});
    res.json({ memory });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not update memory" });
  }
});

app.get("/api/export/:id", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { data: convo, error: convoError } = await supabaseAdmin
    .from("conversations")
    .select("id,title,agent_id,created_at,updated_at")
    .eq("user_id", userId)
    .eq("id", req.params.id)
    .maybeSingle();

  if (convoError || !convo) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  const { data: rows, error } = await supabaseAdmin
    .from("messages")
    .select("role,content,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", req.params.id)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const body = [
    `# ${convo.title}`,
    "",
    `Agent: ${convo.agent_id}`,
    `Updated: ${convo.updated_at}`,
    "",
    ...(rows ?? []).map(row => `## ${row.role}\n\n${contentToPlainText(row.content)}\n`)
  ].join("\n");

  res.type("text/markdown").send(body);
});
app.get("/api/memories", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const agentId = String(req.query.agentId || "");
  try {
    res.json({ memories: await listMemories(userId, agentId || undefined) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not list memories" });
  }
});
app.get("/api/connectors", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  try {
    res.json({ connectors: await listConnectors(userId) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not list connectors" });
  }
});

app.post("/api/connectors", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { label, type, enabled = true, config = {} } = req.body;
  if (!label || !type) {
    res.status(400).json({ error: "Missing connector label or type" });
    return;
  }

  try {
    const connector = await saveConnector({ userId, label, type, enabled: Boolean(enabled), config });
    res.json({ connector });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Could not save connector" });
  }
});

app.post("/api/connectors/:id/test", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  try {
    const result = await testConnectorConnection(userId, req.params.id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    res.status(400).json({ ok: false, detail: error instanceof Error ? error.message.slice(0, 300) : "Connector test failed" });
  }
});
app.get("/api/conversations", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const agentId = String(req.query.agentId || "");
  let query = supabaseAdmin
    .from("conversations")
    .select("id,agent_id,title,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (agentId) query = query.eq("agent_id", agentId);

  const { data, error } = await query;
  if (error) res.status(500).json({ error: error.message });
  else res.json({ conversations: data });
});

app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id,agent_id,role,content,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", req.params.id)
    .order("created_at", { ascending: true });

  if (error) res.status(500).json({ error: error.message });
  else res.json({ messages: data });
});

app.post("/api/uploads", requireAuth, upload.array("files", 8), async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const files = (req.files as Express.Multer.File[]) || [];
  const conversationId = String(req.body.conversationId || "");

  const saved = [];
  for (const file of files) {
    const path = `${userId}/${Date.now()}-${file.originalname}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("kuhu-uploads")
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      res.status(500).json({ error: uploadError.message });
      return;
    }

    const extractedText = file.mimetype.startsWith("text/")
      ? file.buffer.toString("utf8").slice(0, 20000)
      : "";

    const { data, error } = await supabaseAdmin
      .from("uploads")
      .insert({
        user_id: userId,
        conversation_id: conversationId || null,
        file_name: file.originalname,
        mime_type: file.mimetype,
        byte_size: file.size,
        storage_path: path,
        extracted_text: extractedText
      })
      .select("id,file_name,mime_type,byte_size,storage_path,extracted_text")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    saved.push(data);
  }

  res.json({ uploads: saved });
});

app.post("/api/chat/stream", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const {
    agentId = "jarvis",
    conversationId,
    message,
    uploadIds = [],
    accountId,
    advisorAccountIds = [],
    teamAgentIds = []
  } = req.body as {
    agentId?: string;
    conversationId?: string;
    message: string;
    uploadIds?: string[];
    accountId?: string;
    advisorAccountIds?: string[];
    teamAgentIds?: string[];
  };

  if (!message?.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  const { data: account, error: accountError } = await getAccount(userId, accountId);
  if (accountError || !account) {
    res.status(400).json({ error: accountError || "No AI account configured" });
    return;
  }

  const routedAgent = routeAgent(agentId, message);
  await ensureAgentExists(routedAgent.id);
  const convo = await getOrCreateConversation(userId, conversationId, routedAgent.id, message);
  const uploads = await getUploads(userId, uploadIds);

  const userContent = buildUserContent(message, uploads);
  const { data: userMessage, error: userMessageError } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: convo.id,
      user_id: userId,
      agent_id: routedAgent.id,
      role: "user",
      content: userContent
    })
    .select("id")
    .single();

  if (userMessageError || !userMessage) {
    res.status(500).json({ error: userMessageError?.message || "Could not save message" });
    return;
  }

  await learnFromMessage({
    userId,
    agentId: routedAgent.id,
    messageId: userMessage.id,
    userText: message,
    fileNames: uploads.map(item => item.file_name)
  });

  const memory = await getRelevantMemory(userId, routedAgent.id);
  const history = await getRecentMessages(userId, convo.id);
  const connectorContext = await buildConnectorContext(userId, routedAgent.id, message);
  const effectiveTeamAgentIds = teamAgentIds.length ? teamAgentIds : getAutoTeamAgentIds(message, routedAgent.id);
  const sourceTrail = buildSourceTrail({
    account: account as Account,
    userText: message,
    historyCount: history.length,
    memoryCount: memory.length,
    uploads,
    connectorSources: connectorContext.sources,
    advisorCount: advisorAccountIds.length + effectiveTeamAgentIds.length,
    councilAgents: effectiveTeamAgentIds.map(id => getFallbackAgent(id).name)
  });
  const system = buildSystemPrompt({
    routedAgentId: routedAgent.id,
    requestedAgentId: agentId,
    memories: memory
  }) + connectorContext.context;
  const baseMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map(row => ({
      role: (row.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: row.content
    }))
  ];
  const advisorContext = await buildAdvisorContext(userId, advisorAccountIds, baseMessages, routedAgent.name);
  const agentCouncilContext = await buildAgentCouncilContext(account as Account, effectiveTeamAgentIds, baseMessages, routedAgent.id);
  const collaborationContext = [advisorContext, agentCouncilContext].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = collaborationContext
    ? [{ role: "system", content: `${system}\n\n${collaborationContext}` }, ...baseMessages.slice(1)]
    : baseMessages;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  let assistantText = "";
  try {
    for await (const token of streamModel(account as Account, messages)) {
      assistantText += token;
      res.write(`data: ${JSON.stringify({ type: "token", token })}\n\n`);
    }

    assistantText += sourceTrail;
    res.write(`data: ${JSON.stringify({ type: "token", token: sourceTrail })}\n\n`);

    const { data: assistantMessage } = await supabaseAdmin
      .from("messages")
      .insert({
        conversation_id: convo.id,
        user_id: userId,
        agent_id: routedAgent.id,
        role: "assistant",
        content: assistantText
      })
      .select("id")
      .single();

    await supabaseAdmin
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convo.id);

    res.write(`data: ${JSON.stringify({
      type: "done",
      conversationId: convo.id,
      agentId: routedAgent.id,
      messageId: assistantMessage?.id
    })}\n\n`);
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Stream failed" })}\n\n`);
    res.end();
  }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const agentId = String(req.query.agentId || "jarvis");
  const query = String(req.query.q || "");
  if (!query) {
    res.json({ results: [] });
    return;
  }
  res.json({ results: await keywordSearch(userId, agentId, query) });
});

function getAutoTeamAgentIds(userText: string, activeAgentId: string) {
  const text = userText.toLowerCase();
  const looksMultitask = /\b(do all|all of this|multiple|multi[- ]?task|several|everything|plan and|build and|fix and|research and|also|then|checklist|steps|1\.|2\.|3\.|- )\b/i.test(userText)
    || (userText.match(/\b(and|also|then)\b/g)?.length ?? 0) >= 2;

  if (!looksMultitask) return [];

  const candidates: string[] = ["jarvis"];
  if (/\b(code|coding|coder|program|bug|debug|fix app|upgrade app|typescript|react|vite|express|github|repo|test|lint|build error|openhands|aider|cline|continue)\b/.test(text)) candidates.push("coder");
  if (/\b(website|app|ui|ux|frontend|backend|deploy|seo|supabase)\b/.test(text)) candidates.push("kuhu");
  if (/\b(automate|workflow|task|schedule|reminder|repeat|process)\b/.test(text)) candidates.push("automate");
  if (/\b(news|current|update|fact|source|research|general knowledge)\b/.test(text)) candidates.push("nova");
  if (/\b(history|timeline|ancient|war|empire|civilization)\b/.test(text)) candidates.push("history");
  if (/\b(study|exam|notes|homework|academic|revision)\b/.test(text)) candidates.push("noir");
  if (/\b(market|company|competitor|business|product|r&d)\b/.test(text)) candidates.push("phil");
  if (/\b(finance|stock|invest|money|crypto|fund)\b/.test(text)) candidates.push("mastermind");
  if (/\b(learn|skill|practice|roadmap|progress)\b/.test(text)) candidates.push("homelander");

  if (candidates.length === 1) candidates.push("automate", "nova");
  return [...new Set(candidates)].filter(id => id !== activeAgentId).slice(0, 4);
}
async function collectModelWithTimeout(account: Account, messages: ChatMessage[], maxChars: number, timeoutMs: number) {
  return Promise.race([
    collectModel(account, messages, maxChars),
    new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("advisor timeout")), timeoutMs))
  ]);
}
async function buildAgentCouncilContext(account: Account, teamAgentIds: string[], messages: ChatMessage[], activeAgentId: string) {
  const cleanIds = [...new Set(teamAgentIds)].filter(id => id && id !== activeAgentId).slice(0, 4);
  if (!cleanIds.length) return "";

  const notes: string[] = [];
  for (const agentId of cleanIds) {
    const agent = getFallbackAgent(agentId);
    try {
      const note = await collectModelWithTimeout(account, [
        {
          role: "system",
          content: `You are ${agent.name}, ${agent.role}. ${agent.systemPrompt}\n\nYou are part of a private agent council. Read the user request and give concise advice to the main agent. Focus on what your specialty adds, risks, missing context, and better next steps. Do not answer the user directly.`
        },
        ...messages.filter(message => message.role !== "system").slice(-8)
      ], 900, 9000);
      if (note) notes.push(`${agent.name} (${agent.role}): ${note}`);
    } catch (error) {
      notes.push(`${agent.name}: unavailable (${error instanceof Error ? error.message.slice(0, 160) : "error"})`);
    }
  }

  return notes.length
    ? `[AGENT COUNCIL NOTES]\nUse these private specialist notes to produce one stronger answer. Mention important disagreements or uncertainty when useful, but do not copy the notes verbatim.\n${notes.map(note => `- ${note}`).join("\n")}`
    : "";
}
async function buildAdvisorContext(userId: string, advisorAccountIds: string[], messages: ChatMessage[], agentName: string) {
  const cleanIds = [...new Set(advisorAccountIds)].filter(Boolean).slice(0, 3);
  if (!cleanIds.length) return "";

  const advisors = await getAccountsByIds(userId, cleanIds);
  if (!advisors.length) return "";

  const advisorNotes: string[] = [];
  for (const advisor of advisors) {
    try {
      const note = await collectModelWithTimeout(advisor as Account, [
        { role: "system", content: `You are an advisor model helping ${agentName}. Give concise guidance, risks, missing context, and source-quality cautions. Do not answer as the final assistant.` },
        ...messages.filter(message => message.role !== "system").slice(-8)
      ], 1200, 9000);
      if (note) advisorNotes.push(`${advisor.label || advisor.provider} (${advisor.model}): ${note}`);
    } catch (error) {
      advisorNotes.push(`${advisor.label || advisor.provider}: unavailable (${error instanceof Error ? error.message.slice(0, 180) : "error"})`);
    }
  }

  return advisorNotes.length
    ? `[MODEL ADVISOR NOTES]\nUse these as private guidance. Do not copy them verbatim; synthesize them into your answer.\n${advisorNotes.map(note => `- ${note}`).join("\n")}`
    : "";
}

async function ensureAgentExists(agentId: string) {
  const agent = getFallbackAgent(agentId);
  const { error } = await supabaseAdmin
    .from("agents")
    .upsert({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      system_prompt: agent.systemPrompt
    }, { onConflict: "id" });

  if (error) throw new Error(`Could not sync agent ${agent.name}: ${error.message}`);
}
async function ensureAgentCatalog() {
  const { error } = await supabaseAdmin
    .from("agents")
    .upsert(
      fallbackAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        system_prompt: agent.systemPrompt
      })),
      { onConflict: "id" }
    );

  if (error) throw new Error(`Could not sync agents: ${error.message}`);
}
async function getAccountsByIds(userId: string, ids: string[]) {
  const { data } = await supabaseAdmin
    .from("ai_accounts")
    .select("id,label,provider,base_url,model,api_key_encrypted")
    .eq("user_id", userId)
    .in("id", ids);

  return data ?? [];
}

async function getAccount(userId: string, accountId?: string) {
  let query = supabaseAdmin
    .from("ai_accounts")
    .select("id,label,provider,base_url,model,api_key_encrypted")
    .eq("user_id", userId);

  query = accountId ? query.eq("id", accountId) : query.eq("is_default", true);
  const { data, error } = await query.limit(1).maybeSingle();
  return { data, error: error?.message };
}


async function getOrCreateConversation(userId: string, conversationId: string | undefined, agentId: string, message: string) {
  await ensureAgentCatalog();

  if (conversationId) {
    const { data } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .eq("id", conversationId)
      .maybeSingle();
    if (data) return data;
  }

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      user_id: userId,
      agent_id: agentId,
      title: message.slice(0, 60) || "New conversation"
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(error?.message || "Could not create conversation");
  return data;
}

async function getRecentMessages(userId: string, conversationId: string) {
  const { data } = await supabaseAdmin
    .from("messages")
    .select("role,content")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(18);

  return (data ?? []).reverse();
}

async function getUploads(userId: string, uploadIds: string[]) {
  if (!uploadIds.length) return [];
  const { data } = await supabaseAdmin
    .from("uploads")
    .select("id,file_name,mime_type,byte_size,storage_path,extracted_text")
    .eq("user_id", userId)
    .in("id", uploadIds);

  return data ?? [];
}

function buildUserContent(message: string, uploads: Array<{ file_name: string; mime_type: string; extracted_text?: string | null }>) {
  const blocks = [`User message:\n${message}`];
  for (const upload of uploads) {
    if (upload.extracted_text) {
      blocks.push(`[Uploaded file: ${upload.file_name}]\n${upload.extracted_text}`);
    } else {
      blocks.push(`[Uploaded file: ${upload.file_name}, ${upload.mime_type}. File is available in storage but was not text-extracted.]`);
    }
  }
  return blocks.join("\n\n");
}

function contentToPlainText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text?: unknown }).text ?? "");
  }
  return content ? JSON.stringify(content, null, 2) : "";
}
function buildSourceTrail(params: {
  account: Account;
  userText: string;
  historyCount: number;
  memoryCount: number;
  uploads: Array<{ file_name: string; mime_type: string; extracted_text?: string | null }>;
  connectorSources: Array<{ label: string; type: string; status: string; resultCount: number; note?: string; links?: Array<{ title: string; url: string }> }>;
  advisorCount: number;
  councilAgents: string[];
}) {
  const linkLines = params.connectorSources.flatMap(item =>
    (item.links ?? []).map(link => `- Source link: ${item.label} | ${link.title} | ${link.url}`)
  );

  const lines = [
    "",
    "",
    "---",
    "Source Trail",
    `- Current prompt: ${params.userText.slice(0, 140).replace(/\s+/g, " ")}${params.userText.length > 140 ? "..." : ""}`,
    `- Active AI account: ${params.account.label || params.account.provider} (${params.account.model})`,
    `- Recent chat history: ${params.historyCount} saved message(s) from this conversation`,
    `- Learned memory: ${params.memoryCount} saved pattern(s) considered`,
    params.uploads.length
      ? `- Uploaded files/photos: ${params.uploads.map(item => `${item.file_name} (${item.mime_type}${item.extracted_text ? ", text extracted" : ", stored as file context"})`).join("; ")}`
      : "- Uploaded files/photos: none used for this reply",
    params.connectorSources.length
      ? `- Connectors checked: ${params.connectorSources.map(item => `${item.label} (${item.type}, ${item.status}, ${item.resultCount} result(s)${item.note ? `, ${item.note}` : ""})`).join("; ")}`
      : "- Connectors checked: none enabled or no connector context used",
    ...linkLines,
    linkLines.length ? "- Source links status: shown above" : "- Source links status: no link-bearing source used for this reply",
    params.councilAgents.length ? `- Agent council used: ${params.councilAgents.join(", ")}` : "- Agent council used: none",
    params.advisorCount ? `- Advisor models requested: ${params.advisorCount}` : "- Advisor models requested: none",
    "- Live web browsing: not used unless a connector above says it fetched live data"
  ];

  return lines.join("\n");
}

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path === "/health") return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
  console.log(`Serving frontend from ${distPath}`);
}
app.listen(port, () => {
  console.log(`Kuhu backend listening on http://localhost:${port}`);
});
