(() => {
  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
    },
    set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  };

  const textOf = node => (node?.textContent || "").trim();
  const byText = (selector, needle) => Array.from(document.querySelectorAll(selector)).find(node => textOf(node).toLowerCase().includes(needle.toLowerCase()));
  const buttonByText = text => Array.from(document.querySelectorAll("button")).find(button => textOf(button).toLowerCase() === text.toLowerCase());

  function selectedAgentName() {
    const select = document.querySelector(".agent-switcher select");
    if (select instanceof HTMLSelectElement) return select.selectedOptions[0]?.textContent?.split(" - ")[0]?.trim() || "Agent";
    return textOf(document.querySelector(".agent.active strong")) || "Agent";
  }

  function setComposer(text) {
    const textarea = document.querySelector(".composer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function openToolsAndScroll(title) {
    const tools = buttonByText("Tools") || document.querySelector("button[aria-label*='settings' i]");
    tools?.click();
    setTimeout(() => byText(".right-panel .panel-card h2", title)?.scrollIntoView({ behavior: "smooth", block: "start" }), 180);
  }

  function ensureHeaderButtons() {
    const actions = document.querySelector(".top-actions");
    if (!actions || actions.querySelector("[data-advanced-button='workspace']")) return;
    [
      ["Workspace", "Shared Workspaces"],
      ["Tasks", "Scheduled Tasks"],
      ["Files", "RAG Files"]
    ].reverse().forEach(([label, target]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.advancedButton = label.toLowerCase();
      button.textContent = label;
      button.addEventListener("click", () => openToolsAndScroll(target));
      actions.insertBefore(button, actions.firstChild);
    });
  }

  function enhanceBubbles() {
    document.querySelectorAll(".bubble:not(.user)").forEach((bubble, index) => {
      if (bubble.dataset.performanceReady) return;
      bubble.dataset.performanceReady = "1";
      const bar = document.createElement("div");
      bar.className = "advanced-feedback-bar";
      bar.innerHTML = `<span>Rate this answer</span><button type="button" data-rate="1">Good</button><button type="button" data-rate="-1">Bad</button>`;
      bar.querySelectorAll("button[data-rate]").forEach(button => button.addEventListener("click", () => {
        const rating = Number(button.dataset.rate);
        const items = store.get("aiAgentsFeedback", []);
        items.unshift({ id: crypto.randomUUID(), rating, agent: selectedAgentName(), createdAt: new Date().toISOString(), excerpt: textOf(bubble).slice(0, 240) });
        store.set("aiAgentsFeedback", items.slice(0, 200));
        bar.classList.add(rating > 0 ? "good" : "bad");
        renderPerformancePanels();
      }));
      bubble.appendChild(bar);
    });
  }

  function ensureAdvancedPanels() {
    const panel = document.querySelector(".right-panel");
    if (!panel) return;
    ensureWorkspacePanel(panel);
    ensurePerformancePanel(panel);
    ensureSchedulePanel(panel);
    ensureRagPanel(panel);
  }

  function insertPanel(panel, card) {
    const firstRealCard = panel.querySelector(".panel-card");
    panel.insertBefore(card, firstRealCard || null);
  }

  function ensureWorkspacePanel(panel) {
    if (panel.querySelector(".advanced-workspace-panel")) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-workspace-panel";
    card.innerHTML = `
      <h2>Shared Workspaces</h2>
      <p class="panel-help">Create a shared project space for partners. Supabase tables and RLS are ready; this panel keeps drafts visible until server sync is wired.</p>
      <div class="advanced-grid"><input data-name placeholder="Workspace name" value="AI Agents Team"><button type="button" data-create>Create</button></div>
      <div class="advanced-grid"><input data-email placeholder="Partner email"><select data-role><option>admin</option><option selected>editor</option><option>viewer</option></select><button type="button" data-invite>Invite</button></div>
      <div class="advanced-list" data-list></div>
    `;
    insertPanel(panel, card);
    card.querySelector("[data-create]")?.addEventListener("click", () => {
      const name = card.querySelector("[data-name]")?.value?.trim() || "Shared workspace";
      const items = store.get("aiAgentsWorkspaces", []);
      items.unshift({ id: crypto.randomUUID(), name, members: [], createdAt: new Date().toISOString() });
      store.set("aiAgentsWorkspaces", items);
      renderWorkspace(card);
    });
    card.querySelector("[data-invite]")?.addEventListener("click", () => {
      const email = card.querySelector("[data-email]")?.value?.trim();
      if (!email) return;
      const role = card.querySelector("[data-role]")?.value || "editor";
      const items = store.get("aiAgentsWorkspaces", []);
      if (!items.length) items.push({ id: crypto.randomUUID(), name: "AI Agents Team", members: [], createdAt: new Date().toISOString() });
      items[0].members.unshift({ email, role, status: "invited", createdAt: new Date().toISOString() });
      store.set("aiAgentsWorkspaces", items);
      card.querySelector("[data-email]").value = "";
      renderWorkspace(card);
    });
    renderWorkspace(card);
  }

  function renderWorkspace(card) {
    const list = card.querySelector("[data-list]");
    const items = store.get("aiAgentsWorkspaces", []);
    list.innerHTML = items.length ? items.map(workspace => `
      <div class="advanced-row"><strong>${escapeHtml(workspace.name)}</strong><span>${workspace.members.length} member(s)</span>${workspace.members.map(member => `<small>${escapeHtml(member.email)} - ${escapeHtml(member.role)} - ${escapeHtml(member.status)}</small>`).join("")}</div>
    `).join("") : `<p class="panel-help">No shared workspace draft yet.</p>`;
  }

  function ensurePerformancePanel(panel) {
    if (panel.querySelector(".advanced-performance-panel")) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-performance-panel";
    card.innerHTML = `
      <h2>Agent Performance</h2>
      <p class="panel-help">Thumbs up/down per response. This helps you see which agents are strongest by topic.</p>
      <div class="advanced-list" data-performance></div>
    `;
    insertPanel(panel, card);
    renderPerformancePanels();
  }

  function renderPerformancePanels() {
    document.querySelectorAll(".advanced-performance-panel [data-performance]").forEach(list => {
      const items = store.get("aiAgentsFeedback", []);
      const byAgent = items.reduce((acc, item) => {
        acc[item.agent] ||= { good: 0, bad: 0 };
        if (item.rating > 0) acc[item.agent].good += 1;
        else acc[item.agent].bad += 1;
        return acc;
      }, {});
      const rows = Object.entries(byAgent);
      list.innerHTML = rows.length ? rows.map(([agent, score]) => `
        <div class="advanced-row"><strong>${escapeHtml(agent)}</strong><span>${score.good} good / ${score.bad} bad</span><meter min="0" max="100" value="${Math.round((score.good / Math.max(1, score.good + score.bad)) * 100)}"></meter></div>
      `).join("") : `<p class="panel-help">No ratings yet. Use Good/Bad under an agent response.</p>`;
    });
  }

  function ensureSchedulePanel(panel) {
    if (panel.querySelector(".advanced-schedule-panel")) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-schedule-panel";
    card.innerHTML = `
      <h2>Scheduled Tasks</h2>
      <p class="panel-help">Draft recurring agent jobs now. A Render Cron or Supabase Edge Function can execute these later.</p>
      <input data-title placeholder="Task title, e.g. Daily market briefing">
      <textarea data-prompt placeholder="Prompt to run on schedule"></textarea>
      <div class="advanced-grid"><select data-schedule><option>Every morning</option><option>Every evening</option><option>Weekly</option><option>Manual only</option></select><button type="button" data-add>Add task</button></div>
      <div class="advanced-list" data-list></div>
    `;
    insertPanel(panel, card);
    card.querySelector("[data-add]")?.addEventListener("click", () => {
      const title = card.querySelector("[data-title]")?.value?.trim();
      const prompt = card.querySelector("[data-prompt]")?.value?.trim();
      if (!title || !prompt) return;
      const items = store.get("aiAgentsScheduledTasks", []);
      items.unshift({ id: crypto.randomUUID(), title, prompt, agent: selectedAgentName(), schedule: card.querySelector("[data-schedule]")?.value || "Manual only", enabled: true, createdAt: new Date().toISOString() });
      store.set("aiAgentsScheduledTasks", items);
      card.querySelector("[data-title]").value = "";
      card.querySelector("[data-prompt]").value = "";
      renderSchedules(card);
    });
    renderSchedules(card);
  }

  function renderSchedules(card) {
    const list = card.querySelector("[data-list]");
    const items = store.get("aiAgentsScheduledTasks", []);
    list.innerHTML = items.length ? items.map(item => `
      <div class="advanced-row" data-id="${item.id}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.agent)} - ${escapeHtml(item.schedule)}</span><small>${escapeHtml(item.prompt)}</small><button type="button" data-run>Run now</button></div>
    `).join("") : `<p class="panel-help">No scheduled tasks yet.</p>`;
    list.querySelectorAll("[data-run]").forEach(button => button.addEventListener("click", () => {
      const id = button.closest("[data-id]")?.dataset.id;
      const item = store.get("aiAgentsScheduledTasks", []).find(task => task.id === id);
      if (item) setComposer(`[Scheduled task: ${item.title}]\n${item.prompt}`);
    }));
  }

  function ensureRagPanel(panel) {
    if (panel.querySelector(".advanced-rag-panel")) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-rag-panel";
    card.innerHTML = `
      <h2>RAG Files</h2>
      <p class="panel-help">Search your uploaded files before answering. Database tables are ready for document chunks.</p>
      <div class="advanced-grid"><input data-query placeholder="Search my files for..."><button type="button" data-search>Search</button></div>
      <div class="advanced-list" data-results></div>
    `;
    insertPanel(panel, card);
    card.querySelector("[data-search]")?.addEventListener("click", async () => {
      const query = card.querySelector("[data-query]")?.value?.trim();
      const results = card.querySelector("[data-results]");
      if (!query) return;
      results.innerHTML = `<p class="panel-help">Searching file memory...</p>`;
      try {
        const response = await fetch(`/api/rag?q=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const chunks = data.results || [];
        results.innerHTML = chunks.length ? chunks.map(chunk => `<div class="advanced-row"><strong>File match</strong><span>${escapeHtml(chunk.content || chunk.body || "")}</span></div>`).join("") : `<p class="panel-help">No file matches yet.</p>`;
      } catch {
        results.innerHTML = `<div class="advanced-row"><strong>Server RAG route pending</strong><span>Use this prompt instead: Search my uploaded files for ${escapeHtml(query)} and answer with sources.</span><button type="button" data-use>Use prompt</button></div>`;
        results.querySelector("[data-use]")?.addEventListener("click", () => setComposer(`Search my uploaded files for: ${query}\n\nUse any uploaded file context and cite the file names you used.`));
      }
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
  }

  function tick() {
    document.body.classList.add("advanced-features");
    ensureHeaderButtons();
    enhanceBubbles();
    ensureAdvancedPanels();
  }

  const observer = new MutationObserver(tick);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("load", tick);
  setInterval(tick, 1600);
})();
