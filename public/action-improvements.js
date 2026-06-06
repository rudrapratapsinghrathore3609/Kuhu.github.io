(() => {
  const state = { queued: false, lastRun: 0 };
  const authoritative = new Set([
    "rbi.org.in", "sebi.gov.in", "bseindia.com", "nseindia.com", "moneycontrol.com", "economictimes.indiatimes.com", "livemint.com", "financialexpress.com",
    "reuters.com", "bloomberg.com", "ft.com", "wsj.com", "cnbc.com", "marketwatch.com", "india.gov.in", "pib.gov.in", "nih.gov", "who.int", "worldbank.org",
    "arxiv.org", "nature.com", "science.org", "pubmed.ncbi.nlm.nih.gov", "github.com", "developer.mozilla.org", "docs.microsoft.com", "cloud.google.com"
  ]);
  const news = new Set(["bbc.com", "ndtv.com", "thehindu.com", "hindustantimes.com", "indiatoday.in", "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "engadget.com", "towardsdatascience.com", "dev.to", "medium.com"]);
  const community = new Set(["reddit.com", "quora.com", "stackoverflow.com", "news.ycombinator.com"]);
  const textOf = node => (node?.textContent || "").trim();
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const buttonByText = text => qsa("button").find(button => textOf(button).toLowerCase() === text.toLowerCase());

  function selectedAgent() {
    const active = qs(".agent.active strong");
    const title = qs(".topbar h2");
    return textOf(active) || textOf(title) || "Agent";
  }

  function currentMessage() {
    const textarea = qs(".composer textarea");
    return textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : "";
  }

  function setMessage(value) {
    const textarea = qs(".composer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  }

  function clickTools() {
    (buttonByText("Tools") || buttonByText("Settings") || qs("button[aria-label*='settings' i]"))?.click();
  }

  function ensureTopControls() {
    const actions = qs(".top-actions");
    if (!actions || qs("[data-action-button='status']", actions)) return;
    [["Status", "Deployment Check"], ["Memory", "What AI Knows"], ["Team", "Agent Team"]].forEach(([label, target]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.actionButton = label.toLowerCase();
      button.textContent = label;
      button.addEventListener("click", () => {
        clickTools();
        setTimeout(() => qsa(".right-panel .panel-card h2").find(h => textOf(h).includes(target))?.scrollIntoView({ behavior: "smooth", block: "start" }), 180);
      });
      actions.insertBefore(button, actions.firstChild);
    });
  }

  function ensureWelcomePrompts() {
    const empty = qs(".empty");
    if (!empty || qs(".action-starters", empty)) return;
    const row = document.createElement("div");
    row.className = "action-starters";
    ["Use Jarvis to plan this with the right agents.", "Ask Coder for a safe implementation plan.", "Check sources and show links after the answer."].forEach(prompt => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => setMessage(prompt));
      row.appendChild(button);
    });
    empty.appendChild(row);
  }

  function ensureTransparency() {
    qsa(".bubble.assistant").slice(-12).forEach(bubble => {
      if (!(bubble instanceof HTMLElement) || qs(".action-transparency", bubble)) return;
      const cards = qsa(".source-card", bubble);
      const sourceCount = cards.reduce((sum, card) => sum + qsa("a[href]", card).length, 0);
      const model = cards.find(card => /active ai account/i.test(textOf(card)))?.querySelector("span")?.textContent?.trim() || "model";
      const connectors = cards.find(card => /connectors checked/i.test(textOf(card)))?.querySelector("span")?.textContent?.trim() || "no connectors";
      const bar = document.createElement("div");
      bar.className = "action-transparency";
      bar.innerHTML = `<span>Via: Jarvis -> ${selectedAgent()} -> ${model}</span><button type="button">${sourceCount || connectors.includes("none") ? "details" : `${sourceCount} source link(s)`}</button>`;
      qs("button", bar)?.addEventListener("click", () => {
        const grid = qs(".source-card-grid", bubble);
        if (grid) grid.classList.toggle("expanded");
      });
      bubble.insertBefore(bar, qs(".source-card-grid", bubble) || bubble.lastChild);
    });
  }

  function ensureSourceQuality() {
    qsa(".bubble.assistant").slice(-12).forEach(bubble => {
      const grid = qs(".source-card-grid", bubble);
      if (!grid) return;
      const cards = qsa(".source-card", grid);
      cards.forEach(enrichCard);
      const hasExternalLink = qsa("a[href^='http']", grid).length > 0;
      if (!hasExternalLink && !qs(".source-card--model", grid)) {
        const fallback = document.createElement("div");
        fallback.className = "source-card source-card--model unknown source-quality-card";
        fallback.innerHTML = `<div class="source-quality-head"><span class="source-quality-icon">AI</span><span class="source-quality-domain">model</span><span class="source-quality-badge unknown">Unverified</span></div><b>Model knowledge</b><span>This response is based on the model's training data, learned memory, or app context, not a live external web source.</span><div class="source-quality-foot"><span>type: model knowledge</span><span>date: not live</span></div>`;
        grid.appendChild(fallback);
      }
    });
  }

  function enrichCard(card) {
    if (!(card instanceof HTMLElement) || card.dataset.sourceQualityReady) return;
    card.dataset.sourceQualityReady = "1";
    card.classList.add("source-quality-card");
    const link = qs("a[href^='http']", card);
    const url = link?.href || extractUrl(textOf(card));
    const domain = url ? domainFromUrl(url) : inferDomain(textOf(card));
    const credibility = credibilityForDomain(domain, textOf(card));
    const type = inferType(textOf(card), url);
    const title = textOf(qs("b", card)) || (domain === "model" ? "Model knowledge" : domain || "Source");
    const date = extractDate(textOf(card));
    const excerpt = extractExcerpt(card, title, url);

    const head = document.createElement("div");
    head.className = "source-quality-head";
    head.innerHTML = `${domain && domain !== "model" ? `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="14" height="14" alt="" />` : `<span class="source-quality-icon">${type === "memory" ? "MEM" : type === "file" ? "FILE" : "AI"}</span>`}<span class="source-quality-domain">${escapeHtml(domain || "unknown")}</span><span class="source-quality-badge ${credibility}">${credibilityLabel(credibility)}</span>`;
    card.insertBefore(head, card.firstChild);

    if (excerpt && !qs(".source-quality-excerpt", card)) {
      const excerptNode = document.createElement("div");
      excerptNode.className = "source-quality-excerpt";
      excerptNode.textContent = excerpt;
      const firstSpan = qs("span", card);
      firstSpan?.insertAdjacentElement("afterend", excerptNode);
    }

    const foot = document.createElement("div");
    foot.className = "source-quality-foot";
    foot.innerHTML = `<span>type: ${escapeHtml(type.replace("_", " "))}</span><span>date: ${escapeHtml(date || "unknown")}</span>`;
    card.appendChild(foot);
    card.title = `${title} | ${domain || "unknown"} | ${credibilityLabel(credibility)} | ${type}`;
  }

  function credibilityForDomain(domain, text) {
    if (authoritative.has(domain) || /rbi|sebi|nse|bse|government|official|github|docs/i.test(text)) return "authoritative";
    if (news.has(domain)) return "news";
    if (community.has(domain)) return "community";
    return "unknown";
  }

  function credibilityLabel(credibility) {
    return credibility === "authoritative" ? "Authoritative" : credibility === "news" ? "News" : credibility === "community" ? "Community" : "Unverified";
  }

  function inferType(text, url) {
    const lower = text.toLowerCase();
    if (!url) return lower.includes("memory") || lower.includes("learned") ? "memory" : "model_knowledge";
    if (lower.includes("file") || lower.includes("upload")) return "file";
    if (lower.includes("memory") || lower.includes("learned")) return "memory";
    return "web";
  }

  function extractUrl(text) {
    return text.match(/https?:\/\/[^\s|;)]+/)?.[0] || "";
  }

  function domainFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  }

  function inferDomain(text) {
    if (/model knowledge|model/i.test(text)) return "model";
    return extractUrl(text) ? domainFromUrl(extractUrl(text)) : "app context";
  }

  function extractDate(text) {
    const iso = text.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
    if (iso) return iso;
    const named = text.match(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+20\d{2}\b/i)?.[0];
    return named || "";
  }

  function extractExcerpt(card, title, url) {
    const spans = qsa("span", card).map(span => textOf(span)).filter(Boolean);
    const source = spans.find(value => value.length > 24 && !value.includes(url) && value !== title) || "";
    return source.length > 160 ? `${source.slice(0, 157)}...` : source;
  }

  function ensureContinueButtons() {
    qsa(".bubble.assistant").slice(-8).forEach(bubble => {
      const text = textOf(bubble);
      if (!/MAX_TOKENS|stopped early|quota|rate limit|timed out|provider failed|every configured AI provider failed/i.test(text) || qs(".action-recovery", bubble)) return;
      const recovery = document.createElement("div");
      recovery.className = "action-recovery";
      recovery.innerHTML = `<button type="button" data-continue>Continue</button><button type="button" data-status>Check status</button><button type="button" data-shorter>Ask shorter</button>`;
      qs("[data-continue]", recovery)?.addEventListener("click", () => setMessage("Continue the previous answer from exactly where it stopped. Keep the same context and source trail."));
      qs("[data-status]", recovery)?.addEventListener("click", () => { clickTools(); setTimeout(() => buttonByText("Check deployment readiness")?.click(), 200); });
      qs("[data-shorter]", recovery)?.addEventListener("click", () => setMessage("Answer again, but keep it shorter and use fewer tokens. Include only the most important steps."));
      bubble.appendChild(recovery);
    });
  }

  function ensureCoderGate() {
    const form = qs(".composer");
    if (!(form instanceof HTMLFormElement) || form.dataset.coderGate) return;
    form.dataset.coderGate = "1";
    form.addEventListener("submit", event => {
      const prompt = currentMessage();
      const active = selectedAgent().toLowerCase();
      const risky = /delete|remove file|run command|shell|terminal|commit|push|deploy|api key|secret|env|database|migration|drop table|service role/i.test(prompt);
      if (!active.includes("coder") || !risky || form.dataset.coderApproved === "1") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showCoderConfirm(form, prompt);
    }, true);
  }

  function showCoderConfirm(form, prompt) {
    let card = qs(".coder-confirm", form);
    if (!card) {
      card = document.createElement("div");
      card.className = "coder-confirm";
      form.insertBefore(card, form.firstElementChild);
    }
    card.innerHTML = `<strong>Coder safety check</strong><span>This prompt may involve code, commands, secrets, deploys, or data changes. Coder must propose a plan or diff first.</span><textarea>${escapeHtml(prompt)}</textarea><div><button type="button" data-send>Send with safety gate</button><button type="button" data-plan>Ask for plan only</button><button type="button" data-cancel>Cancel</button></div>`;
    qs("[data-send]", card)?.addEventListener("click", () => { setMessage(qs("textarea", card)?.value || prompt); form.dataset.coderApproved = "1"; card.remove(); form.requestSubmit(); setTimeout(() => delete form.dataset.coderApproved, 0); });
    qs("[data-plan]", card)?.addEventListener("click", () => { setMessage(`Plan only first. Do not execute commands, write files, expose secrets, deploy, or change data until I explicitly approve.\n\n${prompt}`); card.remove(); });
    qs("[data-cancel]", card)?.addEventListener("click", () => card.remove());
  }

  function ensureLearningProfile() {
    const panel = qs(".right-panel");
    if (!panel || qs(".learning-profile-panel", panel)) return;
    const memoryCard = qsa(".panel-card", panel).find(card => /What AI Knows|Memory/i.test(textOf(qs("h2", card))));
    const card = document.createElement("section");
    card.className = "panel-card learning-profile-panel";
    card.innerHTML = `<h2>Learning Profile</h2><p class="panel-help">A quick editable view of what the agents should learn about your goals and style.</p><div class="profile-grid"><label>Goal<textarea data-profile="goal" placeholder="Example: build a reliable multi-agent app for me and my partner"></textarea></label><label>Style<textarea data-profile="style" placeholder="Example: direct steps, clear fixes, no repeated generic plans"></textarea></label><label>Constraints<textarea data-profile="constraints" placeholder="Example: free/low-cost providers, Render, Supabase, GitHub"></textarea></label></div><button type="button">Use in next prompt</button>`;
    panel.insertBefore(card, memoryCard || panel.firstElementChild);
    qsa("[data-profile]", card).forEach(input => {
      input.value = localStorage.getItem(`aiAgentsProfile:${input.dataset.profile}`) || "";
      input.addEventListener("input", () => localStorage.setItem(`aiAgentsProfile:${input.dataset.profile}`, input.value));
    });
    qs("button", card)?.addEventListener("click", () => {
      const goal = localStorage.getItem("aiAgentsProfile:goal") || "";
      const style = localStorage.getItem("aiAgentsProfile:style") || "";
      const constraints = localStorage.getItem("aiAgentsProfile:constraints") || "";
      setMessage(`Use my learning profile for this answer.\nGoal: ${goal || "not set"}\nStyle: ${style || "not set"}\nConstraints: ${constraints || "not set"}\n\n`);
    });
  }

  function ensureMobileAssist() {
    const tabbar = qs(".mobile-tabbar");
    if (!tabbar || qs("[data-mobile-more]", tabbar)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mobileMore = "1";
    button.textContent = "Status";
    button.addEventListener("click", () => { clickTools(); setTimeout(() => buttonByText("Check deployment readiness")?.click(), 200); });
    tabbar.appendChild(button);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char]));
  }

  function tick() {
    document.body.classList.add("action-improvements");
    ensureTopControls();
    ensureWelcomePrompts();
    ensureTransparency();
    ensureSourceQuality();
    ensureContinueButtons();
    ensureCoderGate();
    ensureLearningProfile();
    ensureMobileAssist();
  }

  function schedule() {
    const now = Date.now();
    if (state.queued || now - state.lastRun < 180) return;
    state.queued = true;
    requestAnimationFrame(() => {
      state.queued = false;
      state.lastRun = Date.now();
      tick();
    });
  }

  window.addEventListener("load", schedule);
  window.addEventListener("focus", schedule);
  new MutationObserver(schedule).observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
})();