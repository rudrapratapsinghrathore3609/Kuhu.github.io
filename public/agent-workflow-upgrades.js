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

  const state = { lastAgentName: "", lastContext: "", scheduled: false, lastTick: 0 };
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

  function currentComposerText() {
    const textarea = qs(".composer textarea");
    return textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : "";
  }

  function collectRecentContext() {
    return qsa(".bubble").slice(-5).map(bubble => textOf(bubble).slice(0, 700)).filter(Boolean).join("\n\n");
  }

  function ensureTopButtons() {
    const actions = qs(".top-actions");
    if (!actions || qs("[data-workflow-button='memory']", actions)) return;
    [["GitHub", "GitHub"], ["Memory", "Memory"]].forEach(([label, target]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.workflowButton = label.toLowerCase();
      button.textContent = label;
      button.addEventListener("click", () => {
        (buttonByText("Tools") || buttonByText("Settings") || qs("button[aria-label*='settings' i]"))?.click();
        setTimeout(() => byText(".panel-card h2", target)?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
      });
      actions.insertBefore(button, actions.firstChild);
    });
  }

  function ensureRouteHint() {
    const form = qs(".composer");
    const textarea = qs("textarea", form);
    if (!(form instanceof HTMLFormElement) || !(textarea instanceof HTMLTextAreaElement)) return;
    let hint = qs(".workflow-route-hint", form);
    if (!hint) {
      hint = document.createElement("div");
      hint.className = "workflow-route-hint";
      form.insertBefore(hint, form.firstElementChild);
    }
    const value = textarea.value.trim();
    const match = value ? routeHints.find(item => item.agent !== selectedAgentName() && item.words.test(value)) : null;
    if (!match) {
      hint.hidden = true;
      return;
    }
    if (hint.dataset.agent === match.agent) {
      hint.hidden = false;
      return;
    }
    hint.dataset.agent = match.agent;
    hint.hidden = false;
    hint.innerHTML = `<span>Best agent: <b>${match.agent}</b></span><button type="button" data-switch>Switch</button><button type="button" data-keep>Keep current</button>`;
    qs("[data-switch]", hint)?.addEventListener("click", () => switchToAgent(match.agent));
    qs("[data-keep]", hint)?.addEventListener("click", () => { hint.hidden = true; });
  }

  function switchToAgent(agentName) {
    const select = qs(".agent-switcher select");
    if (select instanceof HTMLSelectElement) {
      const option = Array.from(select.options).find(item => item.textContent?.toLowerCase().startsWith(agentName.toLowerCase()));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
    qsa(".agent").find(item => textOf(item).toLowerCase().startsWith(agentName.toLowerCase()))?.click();
  }

  function attachComposerGuards() {
    const form = qs(".composer");
    const textarea = qs("textarea", form);
    if (!(form instanceof HTMLFormElement) || !(textarea instanceof HTMLTextAreaElement) || form.dataset.workflowGuarded) return;
    form.dataset.workflowGuarded = "1";
    let inputTimer;
    textarea.addEventListener("input", () => {
      clearTimeout(inputTimer);
      inputTimer = setTimeout(ensureRouteHint, 140);
    });
    form.addEventListener("submit", event => {
      if (form.dataset.teamPlanAccepted === "1") {
        delete form.dataset.teamPlanAccepted;
        return;
      }
      const teamToggle = qs(".team-toggle input");
      const teamOn = teamToggle instanceof HTMLInputElement && teamToggle.checked;
      if (!teamOn || !currentComposerText()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showTeamPlan(form);
    }, true);
  }

  function showTeamPlan(form) {
    let card = qs(".workflow-team-plan", form);
    if (!card) {
      card = document.createElement("div");
      card.className = "workflow-team-plan";
      form.insertBefore(card, form.firstElementChild);
    }
    const prompt = currentComposerText();
    const checked = qsa(".advisor-list input:checked").length;
    const estimate = Math.max(2, checked + 2);
    card.innerHTML = `<div><strong>Team mode plan</strong><span>You -> ${selectedAgentName()} -> selected team agents. About ${estimate} AI call(s).</span></div><textarea>${escapeHtml(prompt)}</textarea><div class="workflow-actions"><button type="button" data-accept>Accept</button><button type="button" data-cancel>Cancel</button></div>`;
    qs("[data-accept]", card)?.addEventListener("click", () => {
      setComposer(qs("textarea", card)?.value || prompt);
      form.dataset.teamPlanAccepted = "1";
      card.remove();
      form.requestSubmit();
    });
    qs("[data-cancel]", card)?.addEventListener("click", () => card.remove());
  }

  function attachHandoff() {
    const select = qs(".agent-switcher select");
    if (!(select instanceof HTMLSelectElement) || select.dataset.handoffAttached) return;
    select.dataset.handoffAttached = "1";
    select.addEventListener("pointerdown", () => {
      state.lastAgentName = selectedAgentName();
      state.lastContext = collectRecentContext();
    }, true);
    select.addEventListener("change", () => setTimeout(showHandoffPrompt, 120));
  }

  function showHandoffPrompt() {
    if (!state.lastContext) return;
    const form = qs(".composer");
    if (!form || qs(".workflow-handoff", form)) return;
    const card = document.createElement("div");
    card.className = "workflow-handoff";
    card.innerHTML = `<strong>Share last 5 messages with ${selectedAgentName()}?</strong><span>Preserve context from ${state.lastAgentName} instead of starting cold.</span><div><button type="button" data-use>Use context</button><button type="button" data-skip>Skip</button></div>`;
    form.insertBefore(card, form.firstElementChild);
    qs("[data-use]", card)?.addEventListener("click", () => {
      setComposer(`Continue this task using context from ${state.lastAgentName}.\n\n${state.lastContext}\n\nNow help me with the next step.`);
      card.remove();
    });
    qs("[data-skip]", card)?.addEventListener("click", () => card.remove());
  }

  function enhanceToolsDrawer() {
    const panel = qs(".right-panel");
    if (!panel || panel.dataset.workflowDrawerDone) return;
    enhanceMemoryPanel(panel);
    ensureCoderPanel(panel);
    enhanceGithubPanel(panel);
    panel.dataset.workflowDrawerDone = "1";
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
    if (qs(".workflow-coder-panel", panel)) return;
    const card = document.createElement("section");
    card.className = "panel-card workflow-coder-panel";
    card.innerHTML = `<h2>Coder Project</h2><p class="panel-help">Proposed code work lands here first. Accept or reject before treating it as approved.</p><div class="workflow-coder-list"></div><button type="button" data-add>Stage current prompt for Coder</button>`;
    const github = byText(".right-panel .panel-card h2", "GitHub")?.closest(".panel-card");
    panel.insertBefore(card, github || panel.children[1] || null);
    qs("[data-add]", card)?.addEventListener("click", () => addCoderChange(currentComposerText() || "Review current app improvement"));
    renderCoderChanges(card);
  }

  const coderChanges = () => {
    try { return JSON.parse(localStorage.getItem("aiAgentsCoderChanges") || "[]"); }
    catch { return []; }
  };
  const saveCoderChanges = items => localStorage.setItem("aiAgentsCoderChanges", JSON.stringify(items));

  function addCoderChange(title) {
    const items = coderChanges();
    items.unshift({ id: crypto.randomUUID(), title, file: "pending", status: "pending", diff: "Coder must show a diff or command plan here before execution." });
    saveCoderChanges(items);
    qsa(".workflow-coder-panel").forEach(renderCoderChanges);
  }

  function renderCoderChanges(card) {
    const list = qs(".workflow-coder-list", card);
    if (!list) return;
    const items = coderChanges();
    list.innerHTML = items.length
      ? items.map(item => `<div class="workflow-coder-change ${item.status}" data-id="${item.id}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.file)}</span><pre>${escapeHtml(item.diff)}</pre><div><button type="button" data-status="accepted">Accept</button><button type="button" data-status="rejected">Reject</button><button type="button" data-status="pending">Reset</button></div></div>`).join("")
      : `<p class="panel-help">No staged Coder changes yet.</p>`;
    qsa("button[data-status]", list).forEach(button => button.addEventListener("click", () => {
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
    qs("[data-sync]", bar)?.addEventListener("click", async () => {
      const repoInput = qs("input[placeholder*='Repository']", card);
      const repo = repoInput instanceof HTMLInputElement ? repoInput.value : "";
      const status = qs("span", bar);
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
    enhanceToolsDrawer();
  }

  function schedule() {
    const now = Date.now();
    if (state.scheduled || now - state.lastTick < 180) return;
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