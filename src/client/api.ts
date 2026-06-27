import { supabase } from "./supabase";

const API_URL = import.meta.env.VITE_API_URL || "";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You are not signed in.");
  return { Authorization: `Bearer ${token}` };
}

async function readError(res: Response) {
  const text = await res.text();
  if (res.status === 401) {
    await supabase.auth.signOut();
    throw new Error("Your sign-in session expired. Please sign in again.");
  }
  try {
    const payload = JSON.parse(text) as { error?: string; detail?: string };
    throw new Error(payload.error || payload.detail || `${res.status} ${res.statusText}`);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(text || `${res.status} ${res.statusText}`);
    throw error;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, { headers, cache: "no-store" });
  if (!res.ok) await readError(res);
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) await readError(res);
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, { method: "DELETE", headers });
  if (!res.ok) await readError(res);
  return res.json();
}

export async function exportConversation(id: string) {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}/api/export/${id}`, { headers, cache: "no-store" });
  if (!res.ok) await readError(res);
  return res.text();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) await readError(res);
  return res.json();
}

export async function getCoderProposals() {
  return apiGet<{ proposals: CoderActionProposal[] }>("/api/coder/proposals");
}

export async function proposeCoderAction(body: {
  session_id?: string;
  action_type: CoderActionProposal["action_type"];
  payload: Record<string, unknown>;
  description: string;
}) {
  return apiPost<{ status: "executed" | "pending_confirmation"; proposal: CoderActionProposal; result?: unknown }>(
    "/api/coder/propose",
    body
  );
}

export async function approveCoderProposal(id: string) {
  return apiPost<{ status: "executed"; result: unknown }>(`/api/coder/approve/${id}`, {});
}

export async function rejectCoderProposal(id: string) {
  return apiPost<{ status: "rejected" }>(`/api/coder/reject/${id}`, {});
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

  if (!res.ok) await readError(res);
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

  if (!res.ok) await readError(res);
  if (!res.body) throw new Error("The server did not return a stream.");

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

export type CoderActionProposal = {
  id: string;
  session_id: string;
  action_type:
    | "read_file"
    | "generate_preview"
    | "explain_code"
    | "write_file"
    | "run_command"
    | "install_package"
    | "delete_file"
    | "github_issue"
    | "deploy";
  risk_level: "safe" | "confirm" | "danger";
  payload: Record<string, unknown>;
  description: string;
  approved_by_user: boolean;
  rejected: boolean;
  executed: boolean;
  created_at: string;
  expires_at: string;
};
