import OpenAI from "openai";

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
    baseURL: account.base_url || process.env.DEFAULT_OPENAI_COMPAT_BASE_URL
  });
}

export async function* streamModel(account: Account, messages: ChatMessage[]) {
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
    .map(message => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: stringifyContent(message.content)
    }));

  const response = await fetch(`${account.base_url || "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": account.api_key_encrypted,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: account.model || "claude-3-5-haiku-latest",
      max_tokens: 1200,
      stream: true,
      system: typeof system === "string" ? system : stringifyContent(system ?? ""),
      messages: conversational.length ? conversational : [{ role: "user", content: "Hello" }]
    })
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "Claude request failed");
    throw new Error(errorText);
  }

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
  const contents = messages
    .filter(message => message.role !== "system")
    .map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: stringifyContent(message.content) }]
    }));

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: stringifyContent(system ?? "") }] },
      contents: contents.length ? contents : [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Gemini request failed");
    throw new Error(errorText);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (text) yield text;

  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    yield `\n\n[Model stopped early: ${finishReason}. Ask me to continue, or switch to Ollama/OpenAI if this keeps happening.]`;
  }
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
