(() => {
  const routeHints = [
    { agent: "Mastermind", words: /stock|finance|market|valuation|invest|portfolio|money|budget/i },
    { agent: "Phil", words: /research|source|competitor|market research|r&d|analyse|analyze/i },
    { agent: "History", words: /history|past|timeline|ancient|war|empire|dynasty/i },
    { agent: "Automate", words: /automate|workflow|task|remind|schedule|process|repeat/i },
    { agent: "Kuhu", words: /website|app|landing|seo|deploy|frontend|backend|render|supabase/i },
    { agent: "Coder", words: /code|bug|fix|github|repo|commit|diff|typescript|react|api/i },
    { agent: "Nova", words: /news|latest|current|update|today|recent/i }
  ];

  const state = {
    lastAgentName: "",
    lastContext: "",
    teamAccepted: false
  };

  const textOf = node => (node?.textContent || "").trim();
  const byText = (selector, needle) => Array.from(document.querySelectorAll(selector)).find(node => textOf(node).toLowerCase().includes(needle.toLowerCase()));
  const buttonByText = text => Array.from(document.querySelectorAll("button")).find(button => textOf(button).toLowerCase() === text.toLowerCase());

  function selectedAgentName() {
    const select = document.querySelector(".agent-switcher select");
    if (select instanceof HTMLSelectElement) return select.selectedOptions[0]?.textContent?.split(" - ")[0]?.trim() || "Agent";
    const active = document.querySelector(".agent.active strong");
    return textOf(active) || "Agent";
  }

  function setComposer(text) {
    const textarea = document.querySelector(".composer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function currentComposerText() {
    const textarea = document.querySelector(".composer textarea");
    return textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : "";
  }

  function collectRecentContext() {
    const bubbles = Array.from(document.querySelectorAll(".bubble")).slice(-5);
    return bubbles.map(bubble => textOf(bubble).slice(0, 700)).filter(Boolean).join("\n\n");
  }

  function ensureTopButtons() {
    const actions = document.querySelector(".top-actions");
    if (!actions || actions.querySelector("[data-workflow-button='memory']")) return;

    const memory = document.createElement("button");
    memory.type = "button";
    memory.dataset.workflowButton = "memory";
    memory.textContent = "Memory";
    memory.addEventListener("click", () => {
      const tools = buttonByText("Tools") || document.querySelector("button[aria-label*='settings' i]");
      tools?.click();
      setTimeout(() => byText(".panel-card h2", "Memory")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    });

    const github = document.createElement("button");
    github.type = "button";
    github.dataset.workflowButton = "github";
    github.textContent = "GitHub";
    github.addEventListener("click", () => {
      const tools = buttonByText("Tools") || document.querySelector("button[aria-label*='settings' i]");
      tools?.click();
      setTimeout(() => byText(".panel-card h2", "GitHub")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    });

    actions.insertBefore(memory, actions.firstChild);
    actions.insertBefore(github, actions.firstChild);
  }

  function ensureRouteHint() {
    const form = document.querySelector(".composer");
    const textarea = form?.querySelector("textarea");
    if (!(form instanceof HTMLFormElement) || !(textarea instanceof HTMLTextAreaElement)) return;
    let hint = form.querySelector(".workflow-route-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "workflow-route-hint";
      const first = form.firstElementChild;
      form.insertBefore(hint, first);
    }

    const match = routeHints.find(item => item.agent !== selectedAgentName() && item.words.test(textarea.value));
    if (!match || !textarea.value.trim()) {
      hint.hidden = true;
      return;
    }

    hint.hidden = false;
    hint.innerHTML = `<span>Best agent: <b>${match.agent}</b></span><button type="button" data-switch>Switch</button><button type="button" data-keep>Keep current</button>`;
    hint.querySelector("[data-switch]")?.addEventListener("click", () => switchToAgent(match.agent));
    hint.querySelector("[data-keep]")?.addEventListener("click", () => { hint.hidden = true; });
  }

  function switchToAgent(agentName) {
    const select = document.querySelector(".agent-switcher select");
    if (select instanceof HTMLSelectElement) {
      const option = Array.from(select.options).find(item => item.textContent?.toLowerCase().startsWith(agentName.toLowerCase()));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
    const button = Array.from(document.querySelectorAll(".agent")).find(item => textOf(item).toLowerCase().startsWith(agentName.toLowerCase()));
    button?.click();
  }

  function attachComposerGuards() {
    const form = document.querySelector(".composer");
    const textarea = form?.querySelector("textarea");
    if (!(form instanceof HTMLFormElement) || !(textarea instanceof HTMLTextAreaElement) || form.dataset.workflowGuarded) return;
    form.dataset.workflowGuarded = "1";

    textarea.addEventListener("input", ensureRouteHint);
    form.addEventListener("submit", event => {
      if (form.dataset.teamPlanAccepted === "1") {
        delete form.dataset.teamPlanAccepted;
        return;
      }
      const teamOn = document.querySelector(".team-toggle input") instanceof HTMLInputElement && document.querySelector(".team-toggle input").checked;
      if (!teamOn || !currentComposerText()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showTeamPlan(form);
    }, true);
  }

  function showTeamPlan(form) {
    let card = form.querySelector(".workflow-team-plan");
    if (!card) {
      card = document.createElement("div");
      card.className = "workflow-team-plan";
      form.insertBefore(card, form.firstElementChild);
    }
    const agent = selectedAgentName();
    const checked = Array.from(document.querySelectorAll(".advisor-list input:checked")).length;
    const estimate = Math.max(2, checked + 2);
    const prompt = currentComposerText();
    card.innerHTML = `
      <div><strong>Team mode plan</strong><span>You -> ${agent} -> selected team agents. About ${estimate} AI call(s).</span></div>
      <textarea>${escapeHtml(prompt)}</textarea>
      <div class="workflow-actions"><button type="button" data-accept>Accept</button><button type="button" data-cancel>Cancel</button></div>
    `;
    card.querySelector("[data-accept]")?.addEventListener("click", () => {
      const edited = card.querySelector("textarea")?.value || prompt;
      setComposer(edited);
      form.dataset.teamPlanAccepted = "1";
      card.remove();
      form.requestSubmit();
    });
    card.querySelector("[data-cancel]")?.addEventListener("click", () => card.remove());
  }

  function attachHandoff() {
    const select = document.querySelector(".agent-switcher select");
    if (!(select instanceof HTMLSelectElement) || select.dataset.handoffAttached) return;
    select.dataset.handoffAttached = "1";
    select.addEventListener("pointerdown", () => {
      state.lastAgentName = selectedAgentName();
      state.lastContext = collectRecentContext();
    }, true);
    select.addEventListener("change", () => setTimeout(showHandoffPrompt, 150));
  }

  function showHandoffPrompt() {
    if (!state.lastContext) return;
    const form = document.querySelector(".composer");
    if (!form || form.querySelector(".workflow-handoff")) return;
    const card = document.createElement("div");
    card.className = "workflow-handoff";
    card.innerHTML = `<strong>Share last 5 messages with ${selectedAgentName()}?</strong><span>Preserve context from ${state.lastAgentName} instead of starting cold.</span><div><button type="button" data-use>Use context</button><button type="button" data-skip>Skip</button></div>`;
    form.insertBefore(card, form.firstElementChild);
    card.querySelector("[data-use]")?.addEventListener("click", () => {
      setComposer(`Continue this task using context from ${state.lastAgentName}.\n\n${state.lastContext}\n\nNow help me with the next step.`);
      card.remove();
    });
    card.querySelector("[data-skip]")?.addEventListener("click", () => card.remove());
  }

  function enhanceToolsDrawer() {
    const panel = document.querySelector(".right-panel");
    if (!panel) return;
    enhanceMemoryPanel(panel);
    ensureCoderPanel(panel);
    enhanceGithubPanel(panel);
  }

  function enhanceMemoryPanel(panel) {
    const heading = byText(".right-panel .panel-card h2", "What AI Knows") || byText(".right-panel .panel-card h2", "Memory");
    const card = heading?.closest(".panel-card");
    if (!card || card.dataset.memoryEnhanced) return;
    card.dataset.memoryEnhanced = "1";
    heading.textContent = "Memory";
    card.classList.add("workflow-memory-panel");
    const help = document.createElement("p");
    help.className = "panel-help";
    help.textContent = "Visible learned patterns. Use Edit to correct a memory or Delete to forget it.";
    heading.insertAdjacentElement("afterend", help);
  }

  function ensureCoderPanel(panel) {
    if (panel.querySelector(".workflow-coder-panel")) return;
    const card = document.createElement("section");
    card.className = "panel-card workflow-coder-panel";
    card.innerHTML = `
      <h2>Coder Project</h2>
      <p class="panel-help">Proposed code work lands here first. Accept or reject before treating it as approved.</p>
      <div class="workflow-coder-list"></div>
      <button type="button" data-add>Stage current prompt for Coder</button>
    `;
    const github = byText(".right-panel .panel-card h2", "GitHub")?.closest(".panel-card");
    panel.insertBefore(card, github || panel.children[1] || null);
    card.querySelector("[data-add]")?.addEventListener("click", () => addCoderChange(currentComposerText() || "Review current app improvement"));
    renderCoderChanges(card);
  }

  function coderChanges() {
    try { return JSON.parse(localStorage.getItem("aiAgentsCoderChanges") || "[]"); } catch { return []; }
  }

  function saveCoderChanges(items) {
    localStorage.setItem("aiAgentsCoderChanges", JSON.stringify(items));
  }

  function addCoderChange(title) {
    const items = coderChanges();
    items.unshift({ id: crypto.randomUUID(), title, file: "pending", status: "pending", diff: "Coder must show a diff or command plan here before execution." });
    saveCoderChanges(items);
    document.querySelectorAll(".workflow-coder-panel").forEach(renderCoderChanges);
  }

  function renderCoderChanges(card) {
    const list = card.querySelector(".workflow-coder-list");
    if (!list) return;
    const items = coderChanges();
    list.innerHTML = items.length ? items.map(item => `
      <div class="workflow-coder-change ${item.status}" data-id="${item.id}">
        <strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.file)}</span><pre>${escapeHtml(item.diff)}</pre>
        <div><button type="button" data-status="accepted">Accept</button><button type="button" data-status="rejected">Reject</button><button type="button" data-status="pending">Reset</button></div>
      </div>`).join("") : `<p class="panel-help">No staged Coder changes yet.</p>`;
    list.querySelectorAll("button[data-status]").forEach(button => button.addEventListener("click", () => {
      const id = button.closest("[data-id]")?.dataset.id;
      const status = button.dataset.status;
      saveCoderChanges(coderChanges().map(item => item.id === id ? { ...item, status } : item));
      renderCoderChanges(card);
    }));
  }

  function enhanceGithubPanel(panel) {
    const heading = byText(".right-panel .panel-card h2", "GitHub");
    const card = heading?.closest(".panel-card");
    if (!card || card.dataset.githubEnhanced) return;
    card.dataset.githubEnhanced = "1";
    const bar = document.createElement("div");
    bar.className = "workflow-github-sync";
    bar.innerHTML = `<button type="button" data-sync>Sync issues</button><span>Uses /api/github/issues when configured; otherwise keeps local drafts.</span>`;
    heading.insertAdjacentElement("afterend", bar);
    bar.querySelector("[data-sync]")?.addEventListener("click", async () => {
      const repoInput = card.querySelector("input[placeholder*='Repository']");
      const repo = repoInput instanceof HTMLInputElement ? repoInput.value : "";
      const status = bar.querySelector("span");
      status.textContent = "Checking GitHub...";
      try {
        const response = await fetch(`/api/github/issues?repo=${encodeURIComponent(repo)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        status.textContent = `Synced ${data.issues?.length || 0} issue(s).`;
      } catch {
        status.textContent = "Live GitHub sync is not configured on the server yet. Local drafts still work.";
      }
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
  }

  function tick() {
    document.body.classList.add("workflow-upgrades");
    ensureTopButtons();
    attachComposerGuards();
    attachHandoff();
    ensureRouteHint();
    enhanceToolsDrawer();
  }

  const observer = new MutationObserver(tick);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("load", tick);
  setInterval(tick, 1500);
})();
