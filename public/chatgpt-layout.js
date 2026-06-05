(() => {
  const authoritativeDomains = ["rbi.org.in", "sebi.gov.in", "bseindia.com", "nseindia.com"];

  const isAuthoritative = text => authoritativeDomains.some(domain => text.toLowerCase().includes(domain));

  const ready = () => {
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
      history.addEventListener("click", () => document.body.classList.add("nav-open"));
      topActions.insertBefore(history, topActions.firstChild);
    }

    const toolsButton = Array.from(document.querySelectorAll(".top-actions button")).find(button => button.textContent?.trim() === "Tools");
    if (toolsButton) {
      toolsButton.classList.add("settings-toggle");
      toolsButton.textContent = "Settings";
    }

    document.querySelectorAll(".sidebar .agent, .history-item").forEach(item => {
      if (item instanceof HTMLElement && !item.dataset.drawerBound) {
        item.dataset.drawerBound = "true";
        item.addEventListener("click", () => document.body.classList.remove("nav-open"));
      }
    });

    document.querySelectorAll(".source-summary").forEach(item => {
      if (item instanceof HTMLElement && !item.dataset.polished) {
        item.dataset.polished = "true";
        const text = item.textContent?.trim() || "direct agent response";
        if (!/^via:/i.test(text)) item.textContent = text;
      }
    });

    document.querySelectorAll(".source-card").forEach(card => {
      if (!(card instanceof HTMLElement) || card.dataset.authorityChecked) return;
      card.dataset.authorityChecked = "true";
      const text = card.textContent || "";
      if (!isAuthoritative(text)) return;
      card.classList.add("authoritative-source");
      const badge = document.createElement("small");
      badge.className = "authority-badge";
      badge.textContent = "Authoritative Indian finance source";
      card.appendChild(badge);
    });
  };

  const schedule = () => window.requestAnimationFrame(ready);
  window.addEventListener("DOMContentLoaded", schedule);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
