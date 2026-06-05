import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  exportConversation,
  streamChat,
  uploadFiles,
  type Account,
  type Agent,
  type ChatMessage,
  type Connector,
  type Conversation,
  type DeployCheck,
  type Memory,
  type StoredMessage,
  type Upload
} from "./api";
import { supabase } from "./supabase";
import "./styles.css";

const defaultProviders = [
  { provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant" },
  { provider: "together", baseUrl: "https://api.together.xyz/v1", model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo" },
  { provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3.1" },
  { provider: "compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" }
];

const websitePrompts = [
  "Plan a practical website stack for this project. Ask only the missing questions that matter.",
  "Generate the page structure, sections, and copy for this website.",
  "Review this website UI for layout, accessibility, mobile, and polish.",
  "Create an SEO checklist with metadata, schema, sitemap, keywords, and Core Web Vitals.",
  "Give me a deployment checklist for Render, Supabase, env vars, domains, and security."
];

const initialFolders = ["School", "Business", "Website", "Finance", "Personal"];

type SourceCard = { label: string; value: string; trust: "high" | "medium" | "low" | "unknown"; links: string[] };
type Task = { id: string; title: string; status: "todo" | "doing" | "done"; createdAt: string };

function contentToText(content: unknown) {
  if (typeof content === "string") return content.replace(/^User message:\n/i, "").trim();
  if (Array.isArray(content)) return content.map(part => typeof part === "string" ? part : JSON.stringify(part)).join("\n");
  if (content && typeof content === "object" && "text" in content) return String((content as { text?: unknown }).text ?? "");
  return content ? JSON.stringify(content) : "";
}

function visibleAnswer(text: string) {
  const start = text.lastIndexOf("\n---\nSource Trail");
  return start >= 0 ? text.slice(0, start).trim() : text;
}

function parseSourceCards(text: string): SourceCard[] {
  const marker = "Source Trail";
  const start = text.lastIndexOf(marker);
  if (start < 0) return [];
  return text.slice(start + marker.length).split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => {
      const clean = line.slice(2);
      const [label, ...rest] = clean.split(":");
      const value = rest.join(":").trim() || clean;
      const lower = clean.toLowerCase();
      const trust = lower.includes("error") || lower.includes("none enabled") || lower.includes("not used") ? "low"
        : lower.includes("saved") || lower.includes("used") || lower.includes("configured") || lower.includes("matched") ? "high"
        : lower.includes("available") || lower.includes("requested") ? "medium"
        : "unknown";
      const links = Array.from(value.matchAll(/https?:\/\/[^\s|;)]+/g)).map(match => match[0]);
      return { label: label.trim() || "Source", value, trust, links };
    });
}

function sourceSummary(cards: SourceCard[]) {
  if (!cards.length) return "";
  const account = cards.find(card => card.label === "Active AI account")?.value;
  const connectors = cards.find(card => card.label === "Connectors checked")?.value;
  const links = cards.reduce((sum, card) => sum + card.links.length, 0);
  const parts = [account && `AI: ${account}`, connectors && !connectors.includes("none enabled") && "connectors checked"].filter(Boolean);
  return `What happened: ${parts.length ? parts.join(" -> ") : "direct agent response"}${links ? ` -> ${links} link(s)` : ""}`;
}

function friendlyError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error || "Something failed.");
  if (/quota|429|billing/i.test(raw)) return "AI account failed: quota or billing limit reached. Try Gemini, another Team account, or add credits.";
  if (/api key|invalid key|unauthorized|401|403/i.test(raw)) return "Authentication failed: check the selected AI account or Supabase public key.";
  if (/fetch|network|failed to fetch/i.test(raw)) return "Connection failed: refresh the app. Render may be waking up from free sleep.";
  return raw.length > 420 ? `${raw.slice(0, 420)}...` : raw;
}

function App() {
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [notice, setNotice] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [fileLibrary, setFileLibrary] = useState<Upload[]>([]);
  const [deployChecks, setDeployChecks] = useState<DeployCheck[]>([]);
  const [activeAgentId, setActiveAgentId] = useState("jarvis");
  const [activeAccountId, setActiveAccountId] = useState("auto");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploaded, setUploaded] = useState<Upload[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyAgentFilter, setHistoryAgentFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [advisorAccountIds, setAdvisorAccountIds] = useState<string[]>([]);
  const [agentTeamEnabled, setAgentTeamEnabled] = useState(false);
  const [teamAgentIds, setTeamAgentIds] = useState<string[]>(() => JSON.parse(localStorage.getItem("aiAgentsTeamAgents") || "[\"nova\",\"kuhu\"]"));
  const [folders, setFolders] = useState<string[]>(() => JSON.parse(localStorage.getItem("aiAgentsFolders") || JSON.stringify(initialFolders)));
  const [activeFolder, setActiveFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [tasks, setTasks] = useState<Task[]>(() => JSON.parse(localStorage.getItem("aiAgentsTasks") || "[]"));
  const [voiceStatus, setVoiceStatus] = useState("");
  const [accountForm, setAccountForm] = useState({ label: "", provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", apiKey: "" });
  const [connectorForm, setConnectorForm] = useState({ label: "Memory Search", type: "memory_search", config: "{}" });
  const chatRef = useRef<HTMLElement | null>(null);

  const activeAgent = useMemo(() => agents.find(agent => agent.id === activeAgentId) ?? agents[0], [agents, activeAgentId]);
  const activeAccount = useMemo(() => accounts.find(account => account.id === activeAccountId), [accounts, activeAccountId]);
  const agentNameById = useMemo(() => new Map(agents.map(agent => [agent.id, agent.name])), [agents]);
  const visibleConversations = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    return conversations.filter(item => {
      const agentName = agentNameById.get(item.agent_id) ?? item.agent_id;
      const matchesAgent = historyAgentFilter === "all" || item.agent_id === historyAgentFilter;
      const haystack = `${item.title} ${agentName} ${new Date(item.updated_at).toLocaleString()}`.toLowerCase();
      return matchesAgent && (!query || haystack.includes(query));
    });
  }, [conversations, historySearch, historyAgentFilter, agentNameById]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSignedIn(Boolean(data.session)); setSessionReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => { if (signedIn) refreshAppData().catch(error => setNotice(friendlyError(error))); }, [signedIn, activeAgentId]);
  useEffect(() => localStorage.setItem("aiAgentsTasks", JSON.stringify(tasks)), [tasks]);
  useEffect(() => localStorage.setItem("aiAgentsFolders", JSON.stringify(folders)), [folders]);
  useEffect(() => localStorage.setItem("aiAgentsTeamAgents", JSON.stringify(teamAgentIds)), [teamAgentIds]);
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }); }, [messages, streaming]);

  async function refreshAppData() {
    const results = await Promise.allSettled([
      apiGet<{ agents: Agent[] }>("/api/agents"),
      apiGet<{ accounts: Account[] }>("/api/accounts"),
      apiGet<{ connectors: Connector[] }>("/api/connectors"),
      apiGet<{ conversations: Conversation[] }>("/api/conversations"),
      apiGet<{ memories: Memory[] }>(`/api/memories?agentId=${encodeURIComponent(activeAgentId)}`),
      apiGet<{ uploads: Upload[] }>("/api/uploads")
    ]);

    const [agentData, accountData, connectorData, conversationData, memoryData, uploadData] = results;
    if (agentData.status === "fulfilled") setAgents(agentData.value.agents);
    if (accountData.status === "fulfilled") setAccounts(accountData.value.accounts);
    if (connectorData.status === "fulfilled") setConnectors(connectorData.value.connectors);
    if (conversationData.status === "fulfilled") setConversations(conversationData.value.conversations);
    if (memoryData.status === "fulfilled") setMemories(memoryData.value.memories);
    if (uploadData.status === "fulfilled") setFileLibrary(uploadData.value.uploads);

    const failures = results.filter(result => result.status === "rejected") as PromiseRejectedResult[];
    if (failures.length) setNotice(failures.map(item => friendlyError(item.reason)).join("\n"));
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    setNotice("");
    const { error } = mode === "signin" ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password });
    setAuthBusy(false);
    setNotice(error ? error.message : mode === "signup" ? "Account created. Check email if confirmation is enabled." : "Signed in.");
  }

  async function loadConversation(id: string) {
    const data = await apiGet<{ messages: StoredMessage[] }>(`/api/conversations/${id}/messages`);
    const selected = conversations.find(item => item.id === id);
    if (selected) setActiveAgentId(selected.agent_id);
    setConversationId(id);
    setMessages(data.messages.filter(item => item.role === "user" || item.role === "assistant").map(item => ({ id: item.id, role: item.role as "user" | "assistant", content: contentToText(item.content) })));
  }

  async function saveAccount(event: React.FormEvent) {
    event.preventDefault();
    await apiPost("/api/accounts", { label: accountForm.label, provider: accountForm.provider, baseUrl: accountForm.baseUrl, model: accountForm.model, apiKey: accountForm.apiKey, isDefault: accounts.length === 0 });
    setAccountForm({ ...accountForm, label: "", apiKey: "" });
    await refreshAppData();
  }

  async function saveConnector(event: React.FormEvent) {
    event.preventDefault();
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(connectorForm.config || "{}"); } catch { setNotice("Connector config must be valid JSON."); return; }
    await apiPost("/api/connectors", { label: connectorForm.label, type: connectorForm.type, enabled: true, config });
    setConnectorForm({ label: "Memory Search", type: "memory_search", config: "{}" });
    await refreshAppData();
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if ((!message.trim() && !pendingFiles.length) || streaming) return;
    setStreaming(true);
    setNotice("");

    try {
      let uploadRows = uploaded;
      if (pendingFiles.length) {
        const result = await uploadFiles(pendingFiles, conversationId);
        uploadRows = result.uploads;
        setUploaded(uploadRows);
        setPendingFiles([]);
      }

      const folderPrefix = activeFolder ? `[Knowledge folder: ${activeFolder}]\n` : "";
      const userText = folderPrefix + (message.trim() || `Please analyze ${uploadRows.length} uploaded file(s).`);
      setMessages(current => [...current, { role: "user", content: userText }, { role: "assistant", content: "" }]);
      setMessage("");

      const done = await streamChat({
        agentId: activeAgentId,
        accountId: activeAccountId === "auto" ? undefined : activeAccountId,
        conversationId,
        message: userText,
        uploadIds: uploadRows.map(file => file.id),
        advisorAccountIds,
        teamAgentIds: agentTeamEnabled ? teamAgentIds : [],
        onToken: token => setMessages(current => {
          const copy = [...current];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, content: last.content + token };
          return copy;
        })
      });

      if (done?.conversationId) setConversationId(done.conversationId);
      setUploaded([]);
      await refreshAppData();
    } catch (error) {
      const text = friendlyError(error);
      setNotice(text);
      setMessages(current => {
        const copy = [...current];
        const last = copy[copy.length - 1];
        if (last?.role === "assistant" && !last.content) copy[copy.length - 1] = { ...last, content: `Error: ${text}` };
        else copy.push({ role: "assistant", content: `Error: ${text}` });
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  async function runSearch() {
    if (!search.trim()) return;
    const data = await apiGet<{ results: Array<{ title: string; body: string }> }>(`/api/search?agentId=${encodeURIComponent(activeAgentId)}&q=${encodeURIComponent(search)}`);
    setNotice(data.results.length ? data.results.map(item => `${item.title}: ${item.body}`).join("\n") : "No search results yet.");
  }

  async function exportChat() {
    if (!conversationId) { setNotice("Open or send a chat first, then export."); return; }
    const markdown = await exportConversation(conversationId);
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ai-agents-chat.md";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function runDeployCheck() {
    const data = await apiGet<{ checks: DeployCheck[] }>("/api/deploy-check");
    setDeployChecks(data.checks);
  }

  async function testAIAccount(account: Account) {
    setTestResults(current => ({ ...current, [`account:${account.id}`]: "Testing..." }));
    try {
      const result = await apiPost<{ ok: boolean; detail: string }>(`/api/accounts/${account.id}/test`, {});
      setTestResults(current => ({ ...current, [`account:${account.id}`]: result.detail }));
    } catch (error) {
      setTestResults(current => ({ ...current, [`account:${account.id}`]: friendlyError(error) }));
    }
  }

  async function testConnector(connector: Connector) {
    setTestResults(current => ({ ...current, [`connector:${connector.id}`]: "Testing..." }));
    try {
      const result = await apiPost<{ ok: boolean; detail: string }>(`/api/connectors/${connector.id}/test`, {});
      setTestResults(current => ({ ...current, [`connector:${connector.id}`]: result.detail }));
    } catch (error) {
      setTestResults(current => ({ ...current, [`connector:${connector.id}`]: friendlyError(error) }));
    }
  }

  function applyProvider(provider: string) {
    const defaults = defaultProviders.find(item => item.provider === provider) ?? defaultProviders[0];
    setAccountForm(form => ({ ...form, provider, baseUrl: defaults.baseUrl, model: defaults.model }));
  }

  function insertPrompt(text: string, agentId = activeAgentId) {
    setActiveAgentId(agentId);
    setMessage(text);
    setRightPanelOpen(false);
  }

  function startVoice() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setVoiceStatus("Voice input is not supported in this browser."); return; }
    const recognizer = new SpeechRecognition();
    recognizer.lang = "en-IN";
    recognizer.interimResults = false;
    recognizer.continuous = false;
    recognizer.onresult = event => {
      const text = Array.from(event.results).map(result => result[0]?.transcript || "").join(" ").trim();
      if (text) setMessage(current => current ? `${current} ${text}` : text);
      setVoiceStatus(text ? "Voice captured." : "No speech captured.");
    };
    recognizer.onerror = event => setVoiceStatus(`Voice error: ${event.error}`);
    recognizer.start();
    setVoiceStatus("Listening...");
  }

  function speakLatestAnswer() {
    const answer = messages.filter(item => item.role === "assistant").at(-1)?.content;
    if (!answer) { setVoiceStatus("No answer to speak yet."); return; }
    window.speechSynthesis?.speak(new SpeechSynthesisUtterance(visibleAnswer(answer)));
  }

  async function editMemory(memory: Memory) {
    const learning = window.prompt("Edit memory", memory.learning);
    if (!learning || learning === memory.learning) return;
    await apiPatch(`/api/memories/${memory.id}`, { learning });
    await refreshAppData();
  }

  async function removeMemory(memory: Memory) {
    if (!confirm("Delete this learned memory?")) return;
    await apiDelete(`/api/memories/${memory.id}`);
    await refreshAppData();
  }

  function addTask(title: string) {
    if (!title.trim()) return;
    setTasks(current => [{ id: crypto.randomUUID(), title: title.trim(), status: "todo", createdAt: new Date().toISOString() }, ...current]);
  }

  if (!sessionReady) return <main className="auth-page"><div className="auth-card">Loading AI Agents...</div></main>;

  if (!signedIn) return (
    <main className="auth-page">
      <form className="auth-card auth-card-wide" onSubmit={authenticate}>
        <div className="auth-mark">AI Agents</div>
        <h1>{mode === "signin" ? "Welcome back" : "Create account"}</h1>
        <p>Your agents, chat history, memory, uploads, connectors, and settings stay synced with Supabase.</p>
        <div className="auth-tabs">
          <button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Create account</button>
        </div>
        <label>Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></label>
        <label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required /></label>
        <button disabled={authBusy}>{authBusy ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}</button>
        {notice && <pre className="notice">{notice}</pre>}
      </form>
    </main>
  );

  return (
    <div className={`app-shell ${rightPanelOpen ? "tools-open" : "tools-closed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <h1>AI Agents</h1>
          <p>Multi-agent workspace</p>
          <button type="button" className="new-chat" onClick={() => { setConversationId(undefined); setMessages([]); setMessage(""); }}>+ New chat</button>
        </div>

        <div className="sidebar-section history-heading">All Bot History <span>{visibleConversations.length}</span></div>
        <div className="history-controls">
          <input value={historySearch} onChange={event => setHistorySearch(event.target.value)} placeholder="Search history..." />
          <select value={historyAgentFilter} onChange={event => setHistoryAgentFilter(event.target.value)}>
            <option value="all">All agents</option>
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </div>
        <div className="history-list history-list-priority">
          {visibleConversations.length ? visibleConversations.map(item => <button type="button" className={item.id === conversationId ? "history-item active" : "history-item"} key={item.id} onClick={() => loadConversation(item.id).catch(error => setNotice(friendlyError(error)))}><strong>{item.title}</strong><span>{agentNameById.get(item.agent_id) ?? item.agent_id} - {new Date(item.updated_at).toLocaleString()}</span></button>) : <p className="history-empty">No saved chats yet. Send a message and it will appear here.</p>}
        </div>

        <div className="sidebar-section">Agents</div>
        <nav>{agents.map(agent => <button className={agent.id === activeAgentId ? "agent active" : "agent"} key={agent.id} onClick={() => { setActiveAgentId(agent.id); setConversationId(undefined); setMessages([]); }}><strong>{agent.name}</strong><span>{agent.role}</span></button>)}</nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><h2>{activeAgent?.name ?? "Jarvis"}</h2><p>{activeAgent?.role ?? "Chief Supervisor"}</p></div>
          <div className="top-actions">
            <select value={activeAccountId} onChange={event => setActiveAccountId(event.target.value)}>
              <option value="auto">Auto router</option>
              {accounts.map(account => <option value={account.id} key={account.id}>{account.label} - {account.model}</option>)}
            </select>
            <select value={activeFolder} onChange={event => setActiveFolder(event.target.value)}>
              <option value="">No folder</option>
              {folders.map(folder => <option key={folder} value={folder}>{folder}</option>)}
            </select>
            <button type="button" onClick={exportChat}>Export</button>
            <button type="button" onClick={() => setRightPanelOpen(true)}>Tools</button>
            <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </header>

        <section ref={chatRef} className="chat" aria-live="polite">
          {!messages.length && <div className="empty">Start a conversation or reopen one from History. Chats are saved in Supabase.</div>}
          {messages.map((item, index) => {
            const cards = item.role === "assistant" ? parseSourceCards(item.content) : [];
            return <article className={`bubble ${item.role}`} key={`${item.id ?? index}-${index}`}>
              <strong>{item.role === "user" ? "You" : activeAgent?.name}</strong>
              <p>{item.role === "assistant" ? visibleAnswer(item.content) || (streaming ? "Thinking..." : "") : item.content}</p>
              {cards.length > 0 && <div className="source-summary">{sourceSummary(cards)}</div>}
              {cards.length > 0 && <div className="source-card-grid">{cards.map(card => <div className={`source-card ${card.trust}`} key={`${card.label}-${card.value}`}><b>{card.label}</b><span>{card.value}</span>{card.links.length ? card.links.map(link => <a href={link} target="_blank" rel="noreferrer" key={link}>Open source link</a>) : <small>No link for this source</small>}<em>{card.trust} trust</em></div>)}</div>}
            </article>;
          })}
        </section>

        <form className="composer" onSubmit={send}>
          <div className="upload-row"><label className="upload-button">Upload files/photos<input type="file" multiple onChange={event => setPendingFiles(Array.from(event.target.files ?? []))} /></label><span>{pendingFiles.length ? `${pendingFiles.length} file(s) ready` : "Text files are extracted; photos are stored for context."}</span></div>
          <textarea value={message} onChange={event => setMessage(event.target.value)} placeholder="Message your agent..." />
          <div className="composer-actions"><button type="button" onClick={startVoice}>Voice</button><button type="button" onClick={speakLatestAnswer}>Speak answer</button><button disabled={streaming || (!activeAccount && activeAccountId !== "auto")}>{streaming ? "Working..." : "Send"}</button></div>
          {voiceStatus && <span className="voice-status">{voiceStatus}</span>}
        </form>
      </main>

      {rightPanelOpen && <aside className="right-panel" aria-label="Tools drawer"><button type="button" className="drawer-close" onClick={() => setRightPanelOpen(false)}>Close tools</button>
        <section className="panel-card"><h2>AI Accounts</h2><form onSubmit={saveAccount} className="account-form"><input placeholder="Label" value={accountForm.label} onChange={event => setAccountForm({ ...accountForm, label: event.target.value })} required /><select value={accountForm.provider} onChange={event => applyProvider(event.target.value)}>{defaultProviders.map(item => <option key={item.provider}>{item.provider}</option>)}</select><input placeholder="Base URL" value={accountForm.baseUrl} onChange={event => setAccountForm({ ...accountForm, baseUrl: event.target.value })} required /><input placeholder="Model" value={accountForm.model} onChange={event => setAccountForm({ ...accountForm, model: event.target.value })} required /><input placeholder="API key" type="password" value={accountForm.apiKey} onChange={event => setAccountForm({ ...accountForm, apiKey: event.target.value })} required /><button>Save account</button></form><div className="connector-list">{accounts.length ? accounts.map(account => <div className="connector-pill testable" key={account.id}><strong>{account.label}</strong><span>{account.provider} - {account.model}</span><button type="button" onClick={() => testAIAccount(account)}>Test account</button>{testResults[`account:${account.id}`] && <small>{testResults[`account:${account.id}`]}</small>}</div>) : <p className="panel-help">No AI accounts visible for this login. Use the same email as the shared account or add Gemini here.</p>}</div></section>

        <section className="panel-card"><h2>Website Builder</h2><div className="quick-grid">{websitePrompts.map(prompt => <button type="button" key={prompt} onClick={() => insertPrompt(prompt, "kuhu")}>{prompt.split(".")[0]}</button>)}</div></section>

        <section className="panel-card"><h2>Agent Team</h2><p className="panel-help">Let multiple agents privately advise the answer.</p><label className="advisor-option"><input type="checkbox" checked={agentTeamEnabled} onChange={() => setAgentTeamEnabled(enabled => !enabled)} /><span>{agentTeamEnabled ? "Agent Team on" : "Agent Team off"}</span></label>{agentTeamEnabled && <div className="advisor-list">{agents.filter(agent => agent.id !== activeAgentId).map(agent => <label className="advisor-option" key={agent.id}><input type="checkbox" checked={teamAgentIds.includes(agent.id)} onChange={() => setTeamAgentIds(current => current.includes(agent.id) ? current.filter(id => id !== agent.id) : [...current, agent.id])} /><span>{agent.name} - {agent.role}</span></label>)}</div>}</section>

        <section className="panel-card"><h2>Model Advisors</h2><div className="advisor-list">{accounts.length ? accounts.map(account => <label className="advisor-option" key={account.id}><input type="checkbox" checked={advisorAccountIds.includes(account.id)} disabled={account.id === activeAccountId} onChange={() => setAdvisorAccountIds(current => current.includes(account.id) ? current.filter(id => id !== account.id) : [...current, account.id])} /><span>{account.label} - {account.model}</span></label>) : <p className="panel-help">Add or share AI accounts first.</p>}</div></section>

        <section className="panel-card"><h2>Connectors</h2><form onSubmit={saveConnector} className="account-form"><input placeholder="Connector label" value={connectorForm.label} onChange={event => setConnectorForm({ ...connectorForm, label: event.target.value })} required /><select value={connectorForm.type} onChange={event => setConnectorForm({ ...connectorForm, type: event.target.value })}><option value="memory_search">memory_search</option><option value="web_search">web_search</option><option value="google_drive">google_drive</option><option value="local_files">local_files</option><option value="custom_api">custom_api</option></select><textarea className="small-textarea" value={connectorForm.config} onChange={event => setConnectorForm({ ...connectorForm, config: event.target.value })} /><button>Save connector</button></form><div className="connector-list">{connectors.length ? connectors.map(connector => <div className="connector-pill testable" key={connector.id}><strong>{connector.label}</strong><span>{connector.type} {connector.enabled ? "on" : "off"}</span><button type="button" onClick={() => testConnector(connector)}>Test connector</button>{testResults[`connector:${connector.id}`] && <small>{testResults[`connector:${connector.id}`]}</small>}</div>) : <p className="panel-help">Add Memory Search first. For Web Search, use JSON like {`{"provider":"brave","apiKey":"..."}`}.</p>}</div></section>

        <section className="panel-card"><h2>What AI Knows</h2><div className="memory-list">{memories.length ? memories.map(memory => <div className="memory-item" key={memory.id}><strong>{memory.category}</strong><span>{memory.learning}</span><small>{Math.round(Number(memory.confidence) * 100)}% confidence</small><div><button type="button" onClick={() => editMemory(memory)}>Edit</button><button type="button" onClick={() => removeMemory(memory)}>Delete</button></div></div>) : <p className="panel-help">No learned memories yet for this agent.</p>}</div></section>

        <section className="panel-card"><h2>File Library</h2><div className="connector-list">{fileLibrary.length ? fileLibrary.map(file => <div className="connector-pill" key={file.id}><strong>{file.file_name}</strong><span>{file.mime_type} - {Math.round(file.byte_size / 1024)} KB{file.created_at ? ` - ${new Date(file.created_at).toLocaleString()}` : ""}</span></div>) : <p className="panel-help">No uploaded files yet.</p>}</div></section>

        <section className="panel-card"><h2>Automation</h2><form className="search-row" onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("task") as HTMLInputElement; addTask(input.value); input.value = ""; }}><input name="task" placeholder="Add task or workflow" /><button>Add task</button></form><div className="task-list">{tasks.map(task => <div className={`task-row task ${task.status}`} key={task.id}><button type="button" onClick={() => setTasks(current => current.map(item => item.id === task.id ? { ...item, status: item.status === "todo" ? "doing" : item.status === "doing" ? "done" : "todo" } : item))}>{task.status}: {task.title}</button><button type="button" onClick={() => insertPrompt(`Turn this task into an automation plan: ${task.title}`, "automate")}>Run</button></div>)}</div></section>

        <section className="panel-card"><h2>Knowledge Folders</h2><div className="folder-list"><button type="button" className={!activeFolder ? "folder active" : "folder"} onClick={() => setActiveFolder("")}>No folder</button>{folders.map(folder => <button type="button" className={folder === activeFolder ? "folder active" : "folder"} key={folder} onClick={() => setActiveFolder(folder)}>{folder}</button>)}</div><form className="search-row" onSubmit={event => { event.preventDefault(); if (newFolder.trim() && !folders.includes(newFolder.trim())) setFolders(current => [...current, newFolder.trim()]); setNewFolder(""); }}><input value={newFolder} onChange={event => setNewFolder(event.target.value)} placeholder="New folder" /><button>Add</button></form></section>

        <section className="panel-card"><h2>Deployment Check</h2><button type="button" onClick={() => runDeployCheck().catch(error => setNotice(friendlyError(error)))}>Check deployment readiness</button><div className="connector-list">{deployChecks.map(check => <div className={`connector-pill ${check.ok ? "ok" : "bad"}`} key={check.name}><strong>{check.ok ? "Ready" : "Fix"}: {check.name}</strong><span>{check.detail}</span></div>)}</div></section>

        <section className="panel-card"><h2>Search Memory</h2><div className="search-row"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search learned memory..." /><button type="button" onClick={runSearch}>Search</button></div>{notice && <pre className="notice">{notice}</pre>}</section>
      </aside>}
      <nav className="mobile-tabbar" aria-label="Mobile navigation"><button type="button" onClick={() => { setConversationId(undefined); setMessages([]); }}>Chat</button><button type="button" onClick={() => document.querySelector(".sidebar")?.scrollIntoView({ behavior: "smooth" })}>Agents</button><button type="button" onClick={() => document.querySelector(".history-heading")?.scrollIntoView({ behavior: "smooth" })}>History</button><button type="button" onClick={() => setRightPanelOpen(true)}>Tools</button></nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
