import OpenAI from "openai";
import { providerHealth } from "./providerHealth";

export type Account = {
  id?: string;
  label?: string;
  provider: string;
  base_url: string;
  model: string;
  api_key_encrypted: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

export function createOpenAICompatibleClient(account: Account) {
  return new OpenAI({
    apiKey: account.api_key_encrypted || "ollama",
    baseURL: account.base_url || process.env.DEFAULT_OPENAI_COMPAT_BASE_URL,
    defaultHeaders: compatibleHeaders(account)
  });
}

export async function* streamModel(account: Account, messages: ChatMessage[]) {
  const attempts = uniqueAccounts([account, ...envFallbackAccounts(account)]).filter(isUsableAccount);
  const healthyAttempts = attempts.filter(candidate => providerHealth.canUse(candidate));
  const failures: string[] = [];

  for (const candidate of healthyAttempts) {
    try {
      yield* streamSingleProvider(candidate, messages);
      providerHealth.recordSuccess(candidate);
      return;
    } catch (error) {
      const failure = friendlyProviderError(error);
      providerHealth.recordFailure(candidate, failure);
      failures.push(`${candidate.label || candidate.provider}: ${failure}`);
    }
  }

  const skipped = attempts.filter(candidate => !providerHealth.canUse(candidate));
  for (const candidate of skipped) failures.push(`${candidate.label || candidate.provider}: ${providerHealth.status(candidate)}`);
  yield providerSetupMessage(attempts, failures);
}

async function* streamSingleProvider(account: Account, messages: ChatMessage[]) {
  if (account.provider === "anthropic" || account.provider === "claude") {
    yield* streamAnthropic(account, messages);
    return;
  }

  if (account.provider === "gemini") {
    yield* streamGemini(account, messages);
    return;
  }

  const client = createOpenAICompatibleClient(account);
  const stream = await client.chat.completions.create({
    model: account.model || process.env.DEFAULT_MODEL || "gpt-4.1-mini",
    messages: messages as never,
    temperature: 0.7,
    stream: true
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

export async function collectModel(account: Account, messages: ChatMessage[], maxChars = 1800) {
  let text = "";
  for await (const token of streamModel(account, messages)) {
    text += token;
    if (text.length >= maxChars) break;
  }
  return text.slice(0, maxChars).trim();
}

export async function testModelConnection(account: Account) {
  const text = await collectModel(account, [
    { role: "system", content: "You are a connection test. Reply with OK only." },
    { role: "user", content: "Reply OK." }
  ], 80);
  return text || "Connected";
}

async function* streamAnthropic(account: Account, messages: ChatMessage[]) {
  const system = messages.find(message => message.role === "system")?.content;
  const conversational = messages
    .filter(message => message.role !== "system")
    .map(message => ({ role: message.role === "assistant" ? "assistant" : "user", content: stringifyContent(message.content) }));

  const response = await fetch(`${account.base_url || "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": account.api_key_encrypted, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: account.model || "claude-3-5-haiku-latest", max_tokens: 1200, stream: true, system: typeof system === "string" ? system : stringifyContent(system ?? ""), messages: conversational.length ? conversational : [{ role: "user", content: "Hello" }] })
  });

  if (!response.ok || !response.body) throw new Error(await response.text().catch(() => "Claude request failed"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const line = event.split("\n").find(item => item.startsWith("data: "));
      if (!line) continue;
      const payloadText = line.slice(6);
      if (payloadText === "[DONE]") return;
      const payload = JSON.parse(payloadText);
      const text = payload.delta?.text;
      if (payload.type === "content_block_delta" && text) yield text;
    }
  }
}

async function* streamGemini(account: Account, messages: ChatMessage[]) {
  const model = account.model || "gemini-2.5-flash";
  const baseUrl = account.base_url || "https://generativelanguage.googleapis.com/v1beta";
  const url = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(account.api_key_encrypted)}`;
  const system = messages.find(message => message.role === "system")?.content;
  const contents = messages.filter(message => message.role !== "system").map(message => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: stringifyContent(message.content) }] }));

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: stringifyContent(system ?? "") }] }, contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Hello" }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } })
  });

  if (!response.ok) throw new Error(await response.text().catch(() => "Gemini request failed"));
  const data = await response.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (text) yield text;
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") yield `\n\n[Model stopped early: ${finishReason}. Ask me to continue, or switch accounts if this keeps happening.]`;
}

function envFallbackAccounts(primary: Account): Account[] {
  const accounts: Account[] = [];
  const geminiKey = firstEnv("SHARED_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY");
  if (geminiKey) accounts.push({ id: "shared-gemini-fallback", label: "Shared Gemini", provider: "gemini", base_url: firstEnv("SHARED_GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta", model: firstEnv("SHARED_GEMINI_MODEL") || "gemini-2.5-flash", api_key_encrypted: geminiKey });
  const groqKey = firstEnv("SHARED_GROQ_API_KEY", "GROQ_API_KEY");
  if (groqKey) accounts.push({ id: "shared-groq-fallback", label: "Shared Groq", provider: "groq", base_url: firstEnv("SHARED_GROQ_BASE_URL") || "https://api.groq.com/openai/v1", model: firstEnv("SHARED_GROQ_MODEL") || "llama-3.1-8b-instant", api_key_encrypted: groqKey });
  const openRouterKey = firstEnv("SHARED_OPENROUTER_API_KEY", "OPENROUTER_API_KEY");
  if (openRouterKey) accounts.push({ id: "shared-openrouter-fallback", label: "Shared OpenRouter", provider: "openrouter", base_url: firstEnv("SHARED_OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1", model: firstEnv("SHARED_OPENROUTER_MODEL") || "meta-llama/llama-3.1-8b-instruct:free", api_key_encrypted: openRouterKey });
  const togetherKey = firstEnv("SHARED_TOGETHER_API_KEY", "TOGETHER_API_KEY");
  if (togetherKey) accounts.push({ id: "shared-together-fallback", label: "Shared Together", provider: "together", base_url: firstEnv("SHARED_TOGETHER_BASE_URL") || "https://api.together.xyz/v1", model: firstEnv("SHARED_TOGETHER_MODEL") || "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", api_key_encrypted: togetherKey });
  const openaiKey = firstEnv("SHARED_OPENAI_API_KEY", "OPENAI_API_KEY", "DEFAULT_OPENAI_API_KEY", "DEFAULT_API_KEY");
  if (openaiKey) accounts.push({ id: "shared-openai-fallback", label: "Shared OpenAI", provider: "openai", base_url: firstEnv("SHARED_OPENAI_BASE_URL", "DEFAULT_OPENAI_COMPAT_BASE_URL") || "https://api.openai.com/v1", model: firstEnv("SHARED_OPENAI_MODEL", "DEFAULT_MODEL") || "gpt-4.1-mini", api_key_encrypted: openaiKey });
  const ollamaBaseUrl = firstEnv("SHARED_OLLAMA_BASE_URL", "OLLAMA_BASE_URL");
  if (ollamaBaseUrl) accounts.push({ id: "shared-ollama-fallback", label: "Shared Ollama", provider: "compatible", base_url: ollamaBaseUrl, model: firstEnv("SHARED_OLLAMA_MODEL", "OLLAMA_MODEL") || "llama3.1", api_key_encrypted: firstEnv("SHARED_OLLAMA_API_KEY", "OLLAMA_API_KEY") || "ollama" });
  return accounts.filter(candidate => candidate.provider !== primary.provider || candidate.base_url !== primary.base_url || candidate.model !== primary.model);
}

function uniqueAccounts(accounts: Account[]) {
  const seen = new Set<string>();
  return accounts.filter(account => {
    const key = `${account.provider}|${account.base_url}|${account.model}|${maskKey(account.api_key_encrypted)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compatibleHeaders(account: Account) {
  if (account.provider !== "openrouter") return undefined;
  return { "HTTP-Referer": process.env.PUBLIC_APP_URL || "https://ai-agents-31pz.onrender.com", "X-Title": "AI Agents" };
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (isUsableSecret(value)) return value;
  }
  return "";
}

function isUsableAccount(account: Account) {
  if (!account.base_url || !account.model) return false;
  if (account.provider === "compatible" && /11434/.test(account.base_url)) return true;
  return isUsableSecret(account.api_key_encrypted);
}

function isUsableSecret(value?: string) {
  if (!value) return false;
  const lowered = value.toLowerCase();
  if (["your gemini key", "your openai key", "your groq key", "your openrouter key", "your together key", "your api key", "api key", "key", "placeholder", "changeme"].includes(lowered)) return false;
  if (lowered.startsWith("your-") || lowered.startsWith("replace")) return false;
  return value.length >= 12;
}

function maskKey(value?: string) {
  if (!value) return "";
  return `${value.slice(0, 4)}:${value.length}`;
}

function friendlyProviderError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "request failed");
  if (/api key|invalid.*key|unauthorized|permission|401|403/i.test(raw)) return "API key is invalid or not allowed for this model.";
  if (/quota|billing|429|rate/i.test(raw)) return "quota, billing, or rate limit blocked the request.";
  if (/model|not found|404/i.test(raw)) return "model name is not available for this provider.";
  if (/fetch|network|ECONN|timeout/i.test(raw)) return "network connection failed.";
  return raw.length > 220 ? `${raw.slice(0, 220)}...` : raw;
}

function providerSetupMessage(attempts: Account[], failures: string[]) {
  if (!attempts.length) return "I could not reach an AI model because no usable shared AI account is configured. In Render Environment, set SHARED_GEMINI_API_KEY to a real Gemini key from Google AI Studio, set SHARED_GEMINI_MODEL to gemini-2.5-flash, then save and redeploy.";
  return ["I tried to answer, but every configured AI provider failed. The app itself is running; the issue is the AI account configuration.", "", "What to fix in Render Environment:", "1. Make sure SHARED_GEMINI_API_KEY contains the real key, not text like 'your Gemini key'.", "2. Optional fallbacks: add SHARED_GROQ_API_KEY, SHARED_OPENROUTER_API_KEY, or SHARED_TOGETHER_API_KEY.", "3. Use model envs like SHARED_GEMINI_MODEL=gemini-2.5-flash and SHARED_GROQ_MODEL=llama-3.1-8b-instant.", "4. Remove duplicate SHARED_* variables with placeholder values, then save and redeploy.", failures.length ? `\nProvider checks: ${failures.join(" | ")}` : ""].filter(Boolean).join("\n");
}

function stringifyContent(content: ChatMessage["content"] | unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
      if (part && typeof part === "object" && "image_url" in part) return "[Image attached]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return content ? JSON.stringify(content) : "";
}
