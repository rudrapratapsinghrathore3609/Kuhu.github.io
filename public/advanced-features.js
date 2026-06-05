(() => {
  const state = { scheduled: false, lastTick: 0 };
  const store = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
      catch { return fallback; }
    },
    set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  };

  const textOf = node => (node?.textContent || "").trim();
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byText = (selector, needle) => qsa(selector).find(node => textOf(node).toLowerCase().includes(needle.toLowerCase()));
  const buttonByText = text => qsa("button").find(button => textOf(button).toLowerCase() === text.toLowerCase());

  function selectedAgentName() {
    const select = qs(".agent-switcher select");
    if (select instanceof HTMLSelectElement) return select.selectedOptions[0]?.textContent?.split(" - ")[0]?.trim() || "Agent";
    return textOf(qs(".agent.active strong")) || "Agent";
  }

  function setComposer(text) {
    const textarea = qs(".composer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function openToolsAndScroll(title) {
    (buttonByText("Tools") || buttonByText("Settings") || qs("button[aria-label*='settings' i]"))?.click();
    setTimeout(() => byText(".right-panel .panel-card h2", title)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  }

  function ensureHeaderButtons() {
    const actions = qs(".top-actions");
    if (!actions || qs("[data-advanced-button='workspace']", actions)) return;
    [["Files", "RAG Files"], ["Tasks", "Scheduled Tasks"], ["Workspace", "Shared Workspaces"]].forEach(([label, target]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.advancedButton = label.toLowerCase();
      button.textContent = label;
      button.addEventListener("click", () => openToolsAndScroll(target));
      actions.insertBefore(button, actions.firstChild);
    });
  }

  function enhanceBubbles() {
    qsa(".bubble:not(.user):not([data-performance-ready])").slice(-8).forEach(bubble => {
      if (!(bubble instanceof HTMLElement)) return;
      bubble.dataset.performanceReady = "1";
      const bar = document.createElement("div");
      bar.className = "advanced-feedback-bar";
      bar.innerHTML = `<span>Rate this answer</span><button type="button" data-rate="1">Good</button><button type="button" data-rate="-1">Bad</button>`;
      qsa("button[data-rate]", bar).forEach(button => button.addEventListener("click", () => {
        const rating = Number(button.dataset.rate);
        const items = store.get("aiAgentsFeedback", []);
        items.unshift({ id: crypto.randomUUID(), rating, agent: selectedAgentName(), createdAt: new Date().toISOString(), excerpt: textOf(bubble).slice(0, 240) });
        store.set("aiAgentsFeedback", items.slice(0, 200));
        bar.classList.remove("good", "bad");
        bar.classList.add(rating > 0 ? "good" : "bad");
        renderPerformancePanels();
      }));
      bubble.appendChild(bar);
    });
  }

  function ensureAdvancedPanels() {
    const panel = qs(".right-panel");
    if (!panel || panel.dataset.advancedPanelsDone) return;
    ensureWorkspacePanel(panel);
    ensurePerformancePanel(panel);
    ensureSchedulePanel(panel);
    ensureRagPanel(panel);
    panel.dataset.advancedPanelsDone = "1";
  }

  function insertPanel(panel, card) {
    const firstCard = qs(".panel-card", panel);
    panel.insertBefore(card, firstCard || null);
  }

  function ensureWorkspacePanel(panel) {
    if (qs(".advanced-workspace-panel", panel)) return;
    const members = store.get("aiAgentsWorkspaceMembers", [{ email: "You", role: "Owner" }]);
    const card = document.createElement("section");
    card.className = "panel-card advanced-workspace-panel";
    card.innerHTML = `<h2>Shared Workspaces</h2><p class="panel-help">Shared chats, files, and agents for your team.</p><div class="advanced-workspace-list"></div><div class="advanced-inline-form"><input type="email" placeholder="partner@email.com"><select><option>Admin</option><option>Member</option><option>Viewer</option></select><button type="button">Add</button></div>`;
    insertPanel(panel, card);
    const render = () => {
      const list = qs(".advanced-workspace-list", card);
      list.innerHTML = members.map((member, index) => `<div class="advanced-row"><span>${escapeHtml(member.email)}</span><b>${escapeHtml(member.role)}</b>${index ? `<button type="button" data-remove="${index}">Remove</button>` : ""}</div>`).join("");
      qsa("[data-remove]", list).forEach(button => button.addEventListener("click", () => {
        members.splice(Number(button.dataset.remove), 1);
        store.set("aiAgentsWorkspaceMembers", members);
        render();
      }));
    };
    qs(".advanced-inline-form button", card)?.addEventListener("click", () => {
      const email = qs("input", card)?.value.trim();
      const role = qs("select", card)?.value || "Member";
      if (!email) return;
      members.push({ email, role });
      store.set("aiAgentsWorkspaceMembers", members);
      qs("input", card).value = "";
      render();
    });
    render();
  }

  function ensurePerformancePanel(panel) {
    if (qs(".advanced-performance-panel", panel)) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-performance-panel";
    card.innerHTML = `<h2>Agent Performance</h2><p class="panel-help">Ratings help route future work to the strongest agent.</p><div class="advanced-performance-list"></div>`;
    insertPanel(panel, card);
    renderPerformancePanels();
  }

  function renderPerformancePanels() {
    const feedback = store.get("aiAgentsFeedback", []);
    const totals = feedback.reduce((acc, item) => {
      acc[item.agent] ||= { good: 0, bad: 0 };
      item.rating > 0 ? acc[item.agent].good++ : acc[item.agent].bad++;
      return acc;
    }, {});
    qsa(".advanced-performance-list").forEach(list => {
      const rows = Object.entries(totals).sort((a, b) => (b[1].good - b[1].bad) - (a[1].good - a[1].bad));
      list.innerHTML = rows.length
        ? rows.map(([agent, score]) => `<div class="advanced-row"><span>${escapeHtml(agent)}</span><b>${score.good} good / ${score.bad} bad</b></div>`).join("")
        : `<p class="panel-help">No ratings yet.</p>`;
    });
  }

  function ensureSchedulePanel(panel) {
    if (qs(".advanced-schedule-panel", panel)) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-schedule-panel";
    card.innerHTML = `<h2>Scheduled Tasks</h2><p class="panel-help">Draft repeatable agent jobs before wiring Render Cron or Supabase Edge Functions.</p><div class="advanced-task-list"></div><div class="advanced-inline-form"><input placeholder="Daily market briefing"><select><option>Daily</option><option>Weekly</option><option>Manual</option></select><button type="button">Add</button></div>`;
    insertPanel(panel, card);
    renderTasks(card);
    qs(".advanced-inline-form button", card)?.addEventListener("click", () => {
      const title = qs("input", card)?.value.trim();
      const cadence = qs("select", card)?.value || "Manual";
      if (!title) return;
      const tasks = store.get("aiAgentsScheduledTasks", []);
      tasks.unshift({ id: crypto.randomUUID(), title, cadence, agent: selectedAgentName(), enabled: true });
      store.set("aiAgentsScheduledTasks", tasks);
      qs("input", card).value = "";
      renderTasks(card);
    });
  }

  function renderTasks(card) {
    const list = qs(".advanced-task-list", card);
    const tasks = store.get("aiAgentsScheduledTasks", []);
    list.innerHTML = tasks.length
      ? tasks.map(task => `<div class="advanced-row" data-id="${task.id}"><span>${escapeHtml(task.title)}</span><b>${escapeHtml(task.cadence)} - ${escapeHtml(task.agent)}</b><button type="button">Remove</button></div>`).join("")
      : `<p class="panel-help">No scheduled task drafts yet.</p>`;
    qsa("button", list).forEach(button => button.addEventListener("click", () => {
      const id = button.closest("[data-id]")?.dataset.id;
      store.set("aiAgentsScheduledTasks", tasks.filter(task => task.id !== id));
      renderTasks(card);
    }));
  }

  function ensureRagPanel(panel) {
    if (qs(".advanced-rag-panel", panel)) return;
    const card = document.createElement("section");
    card.className = "panel-card advanced-rag-panel";
    card.innerHTML = `<h2>RAG Files</h2><p class="panel-help">Choose whether uploaded knowledge should be searched before answers.</p><label class="advanced-check"><input type="checkbox" id="advanced-rag-toggle"> Search my uploaded files first</label><button type="button">Ask using files</button>`;
    insertPanel(panel, card);
    const input = qs("#advanced-rag-toggle", card);
    if (input instanceof HTMLInputElement) {
      input.checked = store.get("aiAgentsUseRag", false);
      input.addEventListener("change", () => store.set("aiAgentsUseRag", input.checked));
    }
    qs("button", card)?.addEventListener("click", () => setComposer("Use my uploaded files as the main context, cite what you used, and answer this: "));
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

  function schedule() {
    const now = Date.now();
    if (state.scheduled || now - state.lastTick < 220) return;
    state.scheduled = true;
    requestAnimationFrame(() => {
      state.scheduled = false;
      state.lastTick = Date.now();
      tick();
    });
  }

  window.addEventListener("load", schedule);
  window.addEventListener("focus", schedule);
  const root = document.getElementById("root") || document.body;
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
})();