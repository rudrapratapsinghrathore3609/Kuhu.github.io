import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiGet, apiPost, exportConversation, streamChat, uploadFiles, type Account, type Agent, type ChatMessage, type Conversation, type Memory, type StoredMessage, type Upload } from "./api";
import { supabase } from "./supabase";
import "./styles.css";

const providers = [
  { provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
  { provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" }
];

type Task = { id: string; title: string; status: "todo" | "doing" | "done"; createdAt: string };

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) return String((content as { text?: unknown }).text ?? "");
  return content ? JSON.stringify(content) : "";
}

function visibleAnswer(text: string) {
  const marker = "\n---\nSource Trail";
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(0, index).trim() : text;
}

function sourceSummary(text: string) {
  const start = text.lastIndexOf("Source Trail");
  if (start < 0) return "";
  const lines = text.slice(start).split("\n").filter(line => line.startsWith("- "));
  return lines.length ? `What happened: ${lines.map(line => line.replace("- ", "")).join(" -> ")}` : "";
}

function friendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Something failed.");
  if (/whatsapp is not configured/i.test(raw)) return "WhatsApp is not configured yet. Add Twilio or Meta WhatsApp environment variables in Render.";
  if (/quota|429|billing/i.test(raw)) return "AI account failed: quota or billing limit reached. Try Gemini, another Team account, or add credits.";
  if (/api key|invalid key|unauthorized|401|403/i.test(raw)) return "Authentication failed: check the selected AI account or Supabase public key.";
  if (/fetch|network|failed to fetch/i.test(raw)) return "Connection failed: refresh the app. Render may be waking up from free sleep.";
  return raw.length > 420 ? `${raw.slice(0, 420)}...` : raw;
}

function App() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [activeAgentId, setActiveAgentId] = useState("jarvis");
  const [activeAccountId, setActiveAccountId] = useState("auto");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>(() => JSON.parse(localStorage.getItem("aiAgentsTasks") || "[]"));
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [accountForm, setAccountForm] = useState({ label: "Gemini free", provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", apiKey: "" });
  const chatRef = useRef<HTMLElement | null>(null);

  const activeAgent = useMemo(() => agents.find(agent => agent.id === activeAgentId), [agents, activeAgentId]);
  const agentMap = useMemo(() => new Map(agents.map(agent => [agent.id, agent.name])), [agents]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSignedIn(Boolean(data.session)); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (signedIn) refresh().catch(error => setNotice(friendlyError(error))); }, [signedIn, activeAgentId]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }); }, [messages, streaming]);
  useEffect(() => localStorage.setItem("aiAgentsTasks", JSON.stringify(tasks)), [tasks]);

  async function refresh() {
    const [agentData, accountData, conversationData, memoryData, uploadData] = await Promise.all([
      apiGet<{ agents: Agent[] }>("/api/agents"),
      apiGet<{ accounts: Account[] }>("/api/accounts"),
      apiGet<{ conversations: Conversation[] }>("/api/conversations"),
      apiGet<{ memories: Memory[] }>(`/api/memories?agentId=${encodeURIComponent(activeAgentId)}`),
      apiGet<{ uploads: Upload[] }>("/api/uploads")
    ]);
    setAgents(agentData.agents);
    setAccounts(accountData.accounts);
    setConversations(conversationData.conversations);
    setMemories(memoryData.memories);
    setUploads(uploadData.uploads);
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setNotice("");
    const result = mode === "signin" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });
    setNotice(result.error ? result.error.message : mode === "signup" ? "Account created. Check your email if confirmation is enabled." : "Signed in.");
  }

  async function loadConversation(id: string) {
    const data = await apiGet<{ messages: StoredMessage[] }>(`/api/conversations/${id}/messages`);
    const conversation = conversations.find(item => item.id === id);
    if (conversation) setActiveAgentId(conversation.agent_id);
    setConversationId(id);
    setMessages(data.messages.filter(item => item.role === "user" || item.role === "assistant").map(item => ({ id: item.id, role: item.role as "user" | "assistant", content: textFromContent(item.content) })));
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if ((!message.trim() && !files.length) || streaming) return;
    setStreaming(true);
    setNotice("");
    try {
      const uploaded = files.length ? (await uploadFiles(files, conversationId)).uploads : [];
      setFiles([]);
      const userText = message.trim() || `Please analyze ${uploaded.length} uploaded file(s).`;
      setMessages(current => [...current, { role: "user", content: userText }, { role: "assistant", content: "" }]);
      setMessage("");
      const done = await streamChat({
        agentId: activeAgentId,
        accountId: activeAccountId,
        conversationId,
        message: userText,
        uploadIds: uploaded.map(file => file.id),
        onToken: token => setMessages(current => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + token };
          return copy;
        })
      });
      if (done?.conversationId) setConversationId(done.conversationId);
      await refresh();
    } catch (error) {
      const text = friendlyError(error);
      setNotice(text);
      setMessages(current => [...current, { role: "assistant", content: `Error: ${text}` }]);
    } finally {
      setStreaming(false);
    }
  }

  async function saveAccount(event: React.FormEvent) {
    event.preventDefault();
    await apiPost("/api/accounts", { label: accountForm.label, provider: accountForm.provider, baseUrl: accountForm.baseUrl, model: accountForm.model, apiKey: accountForm.apiKey, isDefault: accounts.length === 0 });
    setAccountForm({ ...accountForm, label: "", apiKey: "" });
    await refresh();
  }

  function applyProvider(provider: string) {
    const item = providers.find(providerItem => providerItem.provider === provider) ?? providers[0];
    setAccountForm(form => ({ ...form, provider, baseUrl: item.baseUrl, model: item.model }));
  }

  function addTask(title: string) {
    if (!title.trim()) return;
    setTasks(current => [{ id: crypto.randomUUID(), title: title.trim(), status: "todo", createdAt: new Date().toISOString() }, ...current]);
  }

  async function whatsappTask(task: Task) {
    setTestResults(current => ({ ...current, [`whatsapp:${task.id}`]: "Sending..." }));
    try {
      const result = await apiPost<{ ok: boolean; detail: string }>("/api/automations/whatsapp", { taskTitle: task.title, status: task.status });
      setTestResults(current => ({ ...current, [`whatsapp:${task.id}`]: result.detail }));
      setNotice(result.detail);
    } catch (error) {
      const text = friendlyError(error);
      setTestResults(current => ({ ...current, [`whatsapp:${task.id}`]: text }));
      setNotice(text);
    }
  }

  async function exportChat() {
    if (!conversationId) { setNotice("Open or send a chat first."); return; }
    const markdown = await exportConversation(conversationId);
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ai-agents-chat.md";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (!ready) return <main className="auth-page"><div className="auth-card">Loading AI Agents...</div></main>;
  if (!signedIn) return <main className="auth-page"><form className="auth-card auth-card-wide" onSubmit={authenticate}><div className="auth-mark">AI Agents</div><h1>{mode === "signin" ? "Welcome back" : "Create account"}</h1><p>Your agents, chat history, memory, and files stay synced with Supabase.</p><div className="auth-tabs"><button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button><button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Create account</button></div><label>Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></label><label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required /></label><button>{mode === "signin" ? "Sign in" : "Create account"}</button>{notice && <pre className="notice">{notice}</pre>}</form></main>;

  return <div className={`app-shell ${toolsOpen ? "tools-open" : "tools-closed"}`}>
    <aside className="sidebar"><div className="brand"><h1>AI Agents</h1><p>Multi-agent workspace</p><button className="new-chat" onClick={() => { setConversationId(undefined); setMessages([]); }}>+ New chat</button></div><div className="sidebar-section history-heading">All Bot History <span>{conversations.length}</span></div><div className="history-list history-list-priority">{conversations.length ? conversations.map(item => <button className={item.id === conversationId ? "history-item active" : "history-item"} key={item.id} onClick={() => loadConversation(item.id).catch(error => setNotice(friendlyError(error)))}><strong>{item.title}</strong><span>{agentMap.get(item.agent_id) ?? item.agent_id} - {new Date(item.updated_at).toLocaleString()}</span></button>) : <p className="history-empty">No saved chats yet. Send a message and it will appear here.</p>}</div><div className="sidebar-section">Agents</div><nav>{agents.map(agent => <button className={agent.id === activeAgentId ? "agent active" : "agent"} key={agent.id} onClick={() => { setActiveAgentId(agent.id); setConversationId(undefined); setMessages([]); }}><strong>{agent.name}</strong><span>{agent.role}</span></button>)}</nav></aside>
    <main className="workspace"><header className="topbar"><div><h2>{activeAgent?.name ?? "Jarvis"}</h2><p>{activeAgent?.role ?? "Chief Supervisor"}</p></div><div className="top-actions"><select value={activeAccountId} onChange={event => setActiveAccountId(event.target.value)}><option value="auto">Auto router</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label} - {account.model}</option>)}</select><button type="button" onClick={exportChat}>Export</button><button type="button" onClick={() => setToolsOpen(true)}>Tools</button><button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button></div></header><section ref={chatRef} className="chat">{!messages.length && <div className="empty">Start a conversation or reopen one from History. Chats are saved online.</div>}{messages.map((item, index) => <article className={`bubble ${item.role}`} key={`${item.id ?? index}-${index}`}><strong>{item.role === "user" ? "You" : activeAgent?.name}</strong><p>{item.role === "assistant" ? visibleAnswer(item.content) || (streaming ? "Thinking..." : "") : item.content}</p>{item.role === "assistant" && sourceSummary(item.content) && <div className="source-summary">{sourceSummary(item.content)}</div>}</article>)}</section><form className="composer" onSubmit={send}><div className="upload-row"><label className="upload-button">Upload files/photos<input type="file" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} /></label><span>{files.length ? `${files.length} file(s) ready` : "Text files are extracted; photos are stored for context."}</span></div><textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="Message your agent..." /><div className="composer-actions"><button type="button" onClick={() => setNotice("Voice works best in Chrome after the app is live. Use typing for now if permission is blocked.")}>Voice</button><button type="button" onClick={() => window.speechSynthesis?.speak(new SpeechSynthesisUtterance(visibleAnswer(messages.filter(item => item.role === "assistant").at(-1)?.content || "No answer yet")))}>Speak answer</button><button disabled={streaming}>{streaming ? "Working..." : "Send"}</button></div></form></main>
    {toolsOpen && <aside className="right-panel"><button className="drawer-close" onClick={() => setToolsOpen(false)}>Close tools</button><section className="panel-card"><h2>AI Accounts</h2><form className="account-form" onSubmit={saveAccount}><input placeholder="Label" value={accountForm.label} onChange={event => setAccountForm({ ...accountForm, label: event.target.value })} required /><select value={accountForm.provider} onChange={event => applyProvider(event.target.value)}>{providers.map(item => <option key={item.provider}>{item.provider}</option>)}</select><input placeholder="Base URL" value={accountForm.baseUrl} onChange={event => setAccountForm({ ...accountForm, baseUrl: event.target.value })} required /><input placeholder="Model" value={accountForm.model} onChange={event => setAccountForm({ ...accountForm, model: event.target.value })} required /><input placeholder="API key" type="password" value={accountForm.apiKey} onChange={event => setAccountForm({ ...accountForm, apiKey: event.target.value })} required /><button>Save account</button></form><div className="connector-list">{accounts.map(account => <div className="connector-pill" key={account.id}><strong>{account.label}</strong><span>{account.provider} - {account.model}</span></div>)}</div></section><section className="panel-card"><h2>Automation</h2><p className="panel-help">Add tasks, plan them with Automate, or send yourself a WhatsApp reminder whenever you want.</p><form className="search-row" onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("task") as HTMLInputElement; addTask(input.value); input.value = ""; }}><input name="task" placeholder="Add task or workflow" /><button>Add task</button></form><div className="task-list">{tasks.map(task => <div className={`task-row task ${task.status}`} key={task.id}><button type="button" onClick={() => setTasks(current => current.map(item => item.id === task.id ? { ...item, status: item.status === "todo" ? "doing" : item.status === "doing" ? "done" : "todo" } : item))}>{task.status}: {task.title}</button><button type="button" onClick={() => { setActiveAgentId("automate"); setMessage(`Turn this task into an automation plan: ${task.title}`); setToolsOpen(false); }}>Run</button><button type="button" onClick={() => whatsappTask(task)}>WhatsApp me</button>{testResults[`whatsapp:${task.id}`] && <small>{testResults[`whatsapp:${task.id}`]}</small>}</div>)}</div></section><section className="panel-card"><h2>What AI Knows</h2><div className="memory-list">{memories.length ? memories.map(memory => <div className="memory-item" key={memory.id}><strong>{memory.category}</strong><span>{memory.learning}</span><small>{Math.round(Number(memory.confidence) * 100)}% confidence</small></div>) : <p className="panel-help">No learned memories yet for this agent.</p>}</div></section><section className="panel-card"><h2>File Library</h2><div className="connector-list">{uploads.length ? uploads.map(file => <div className="connector-pill" key={file.id}><strong>{file.file_name}</strong><span>{file.mime_type} - {Math.round(file.byte_size / 1024)} KB</span></div>) : <p className="panel-help">No uploaded files yet.</p>}</div></section>{notice && <pre className="notice">{notice}</pre>}</aside>}
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
