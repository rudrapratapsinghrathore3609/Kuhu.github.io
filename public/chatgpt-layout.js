(() => {
  const authoritativeDomains = ["rbi.org.in", "sebi.gov.in", "bseindia.com", "nseindia.com"];
  const starterPrompts = [
    "Give me today’s useful updates with sources.",
    "Plan the next 3 improvements for this app.",
    "Ask the agent team to research this carefully."
  ];
  const agentColors = ["#69a7ff", "#5ee0ad", "#f6c177", "#c4a7ff", "#ff8ba7", "#89ddff", "#a6e3a1", "#f38ba8", "#fab387", "#94e2d5"];

  const isAuthoritative = text => authoritativeDomains.some(domain => text.toLowerCase().includes(domain));
  const textOf = node => (node?.textContent || "").trim();

  const clickButtonByText = label => {
    const button = Array.from(document.querySelectorAll("button")).find(item => textOf(item).toLowerCase() === label.toLowerCase());
    if (button) button.click();
  };

  const setComposerText = text => {
    const textarea = document.querySelector(".composer textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
  };

  const sendComposer = () => {
    const form = document.querySelector(".composer");
    if (form instanceof HTMLFormElement) form.requestSubmit();
  };

  const sourceCardsForBubble = bubble => Array.from(bubble.querySelectorAll(".source-card"));

  const activeModelText = bubble => {
    const cards = sourceCardsForBubble(bubble);
    const accountCard = cards.find(card => /active ai account/i.test(textOf(card)));
    if (!accountCard) return "Model details unavailable";
    return textOf(accountCard).replace(/active ai account:?/i, "").replace(/open source link|no link for this source|\w+ trust/gi, "").trim();
  };

  const makeInitials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "AI";

  const enhanceNavigation = () => {
    document.querySelectorAll(".sidebar .agent").forEach((agent, index) => {
      if (!(agent instanceof HTMLElement) || agent.querySelector(".agent-avatar")) return;
      const name = textOf(agent.querySelector("strong")) || textOf(agent);
      const avatar = document.createElement("span");
      avatar.className = "agent-avatar";
      avatar.textContent = makeInitials(name);
      avatar.style.setProperty("--avatar-color", agentColors[index % agentColors.length]);
      agent.prepend(avatar);
    });

    document.querySelectorAll(".sidebar .agent, .history-item").forEach(item => {
      if (item instanceof HTMLElement && !item.dataset.drawerBound) {
        item.dataset.drawerBound = "true";
        item.addEventListener("click", () => document.body.classList.remove("nav-open"));
      }
    });
  };

  const enhanceHistory = () => {
    const list = document.querySelector(".history-list-priority");
    if (!list || list.dataset.groupedAt === String(list.children.length)) return;
    list.querySelectorAll(".history-date-group").forEach(item => item.remove());
    const items = Array.from(list.querySelectorAll(".history-item"));
    let previous = "";
    items.forEach(item => {
      const raw = textOf(item.querySelector("span"));
      const datePart = raw.split(" - ").pop() || raw.split("·").pop() || "";
      const date = new Date(datePart);
      const now = new Date();
      const label = Number.isNaN(date.getTime()) ? "Older"
        : date.toDateString() === now.toDateString() ? "Today"
        : date > new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) ? "Yesterday"
        : date > new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7) ? "This week"
        : "Older";
      if (label !== previous) {
        const header = document.createElement("div");
        header.className = "history-date-group";
        header.textContent = label;
        list.insertBefore(header, item);
        previous = label;
      }
    });
    list.dataset.groupedAt = String(list.children.length);
  };

  const enhanceEmptyState = () => {
    const empty = document.querySelector(".empty");
    if (!(empty instanceof HTMLElement) || empty.querySelector(".starter-prompts")) return;
    empty.innerHTML = "<strong>What should your agents work on?</strong><span>Pick a starter or type your own prompt.</span>";
    const row = document.createElement("div");
    row.className = "starter-prompts";
    starterPrompts.forEach(prompt => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = prompt;
      chip.addEventListener("click", () => setComposerText(prompt));
      row.appendChild(chip);
    });
    empty.appendChild(row);
  };

  const enhanceBubbles = () => {
    document.querySelectorAll(".bubble.assistant").forEach(bubble => {
      if (!(bubble instanceof HTMLElement)) return;
      const text = textOf(bubble);
      const cards = sourceCardsForBubble(bubble);

      if (cards.length && !bubble.querySelector(".agent-chain-bar")) {
        const account = activeModelText(bubble);
        const chain = document.createElement("div");
        chain.className = "agent-chain-bar";
        chain.textContent = `Jarvis -> ${account.includes("Gemini") ? "Gemini" : account.includes("Groq") ? "Groq" : account.includes("OpenRouter") ? "OpenRouter" : "AI model"} -> response`;
        bubble.insertBefore(chain, bubble.querySelector(".source-summary") || bubble.firstChild?.nextSibling || null);
      }

      if (cards.length && !bubble.querySelector(".model-disclosure-pill")) {
        const pill = document.createElement("div");
        pill.className = "model-disclosure-pill";
        pill.textContent = `via ${activeModelText(bubble)}`;
        bubble.appendChild(pill);
      }

      if (/MAX_TOKENS|stopped early|continue/i.test(text) && !bubble.querySelector(".continue-answer")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "continue-answer";
        button.textContent = "Continue ->";
        button.addEventListener("click", () => { setComposerText("Continue the previous answer from exactly where it stopped. Keep the same sources and context."); sendComposer(); });
        bubble.appendChild(button);
      }
    });

    document.querySelectorAll(".source-summary").forEach(item => {
      if (item instanceof HTMLElement && !item.dataset.polished) {
        item.dataset.polished = "true";
        const text = textOf(item) || "direct agent response";
        if (!/^via:/i.test(text)) item.textContent = text;
      }
    });

    document.querySelectorAll(".source-card").forEach(card => {
      if (!(card instanceof HTMLElement) || card.dataset.authorityChecked) return;
      card.dataset.authorityChecked = "true";
      if (!isAuthoritative(textOf(card))) return;
      card.classList.add("authoritative-source");
      const badge = document.createElement("small");
      badge.className = "authority-badge";
      badge.textContent = "Authoritative Indian finance source";
      card.appendChild(badge);
    });
  };

  const enhanceVoice = () => {
    const voiceButton = Array.from(document.querySelectorAll(".composer-actions button")).find(button => /voice/i.test(textOf(button)));
    if (!voiceButton || !(voiceButton instanceof HTMLElement)) return;
    voiceButton.classList.add("voice-command-button");
    if (!voiceButton.querySelector(".voice-wave")) {
      const wave = document.createElement("span");
      wave.className = "voice-wave";
      wave.innerHTML = "<i></i><i></i><i></i>";
      voiceButton.appendChild(wave);
    }
  };

  const installShortcuts = () => {
    if (document.body.dataset.shortcutsInstalled) return;
    document.body.dataset.shortcutsInstalled = "true";
    document.addEventListener("keydown", event => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "k") { event.preventDefault(); clickButtonByText("+ New chat"); }
      if ((event.ctrlKey || event.metaKey) && key === "h") { event.preventDefault(); document.body.classList.add("nav-open"); }
      if (key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")) { event.preventDefault(); document.querySelector(".composer textarea")?.focus(); }
      if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(key)) {
        const agent = document.querySelectorAll(".sidebar .agent")[Number(key) - 1];
        if (agent instanceof HTMLElement) { event.preventDefault(); agent.click(); }
      }
    });
  };

  const ensureShell = () => {
    document.body.classList.add("chatgpt-enhanced");
    if (!document.querySelector(".layout-scrim")) {
      const scrim = document.createElement("button");
      scrim.type = "button";
      scrim.className = "layout-scrim";
      scrim.setAttribute("aria-label", "Close agents and history");
      scrim.addEventListener("click", () => document.body.classList.remove("nav-open"));
      document.body.appendChild(scrim);
    }

    const topbar = document.querySelector(".topbar");
    const titleBlock = topbar?.querySelector(":scope > div:first-child");
    const topActions = document.querySelector(".top-actions");

    if (titleBlock && !titleBlock.querySelector(".nav-toggle")) {
      const nav = document.createElement("button");
      nav.type = "button";
      nav.className = "nav-toggle";
      nav.textContent = "Agents";
      nav.title = "Ctrl+H opens Agents and History";
      nav.addEventListener("click", () => document.body.classList.add("nav-open"));
      titleBlock.prepend(nav);
    }

    if (topbar && !topbar.querySelector(".layout-title")) {
      const title = document.createElement("div");
      title.className = "layout-title";
      title.innerHTML = "<strong>AI Agents</strong><span>Full-width multi-agent chat</span>";
      topbar.insertBefore(title, topActions || null);
    }

    if (topActions && !topActions.querySelector(".history-toggle")) {
      const history = document.createElement("button");
      history.type = "button";
      history.className = "history-toggle";
      history.textContent = "History";
      history.title = "Ctrl+H";
      history.addEventListener("click", () => document.body.classList.add("nav-open"));
      topActions.insertBefore(history, topActions.firstChild);
    }

    const toolsButton = Array.from(document.querySelectorAll(".top-actions button")).find(button => textOf(button) === "Tools");
    if (toolsButton) { toolsButton.classList.add("settings-toggle"); toolsButton.textContent = "Settings"; }
    const textarea = document.querySelector(".composer textarea");
    if (textarea) textarea.setAttribute("title", "/ focuses input, Ctrl+K starts a new chat, Ctrl+1-9 switches agents");
  };

  const ready = () => {
    ensureShell();
    enhanceNavigation();
    enhanceHistory();
    enhanceEmptyState();
    enhanceBubbles();
    enhanceVoice();
    installShortcuts();
  };

  const schedule = () => window.requestAnimationFrame(ready);
  window.addEventListener("DOMContentLoaded", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
