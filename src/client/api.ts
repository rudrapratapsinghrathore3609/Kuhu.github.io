import { supabase } from "./supabase";

const API_URL = import.meta.env.VITE_API_URL || "";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You are not signed in.");
  return { Authorization: `Bearer ${token}` };
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, { method: "DELETE", headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function exportConversation(id: string) {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/export/${id}`, { headers });
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function uploadFiles(files: File[], conversationId?: string) {
  const headers = await authHeaders();
  const form = new FormData();
  for (const file of files) form.append("files", file);
  if (conversationId) form.append("conversationId", conversationId);

  const res = await fetch(`${API_URL}/api/uploads`, {
    method: "POST",
    headers,
    body: form
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ uploads: Upload[] }>;
}

export async function streamChat(params: {
  agentId: string;
  accountId?: string;
  conversationId?: string;
  message: string;
  uploadIds: string[];
  advisorAccountIds?: string[];
  teamAgentIds?: string[];
  onToken: (token: string) => void;
}) {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/chat/stream`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });

  if (!res.ok || !res.body) throw new Error(await res.text());

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: StreamDone | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const line = event.split("\n").find(item => item.startsWith("data: "));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6));
      if (payload.type === "token") params.onToken(payload.token);
      if (payload.type === "done") donePayload = payload;
      if (payload.type === "error") throw new Error(payload.error);
    }
  }

  return donePayload;
}

export type Agent = {
  id: string;
  name: string;
  role: string;
};

export type Account = {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  model: string;
  is_default: boolean;
};

export type Upload = {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  storage_path?: string;
  created_at?: string;
};

export type ChatMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
};

type StreamDone = {
  type: "done";
  conversationId: string;
  agentId: string;
  messageId?: string;
};

export type Connector = {
  id: string;
  label: string;
  type: "memory_search" | "web_search" | "google_drive" | "local_files" | "custom_api";
  enabled: boolean;
  config: Record<string, unknown>;
};
export type Conversation = {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type StoredMessage = {
  id: string;
  agent_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  created_at: string;
};

export type Memory = {
  id: string;
  agent_id: string;
  category: string;
  learning: string;
  confidence: number;
  created_at: string;
};
export type DeployCheck = {
  name: string;
  ok: boolean;
  detail: string;
};
