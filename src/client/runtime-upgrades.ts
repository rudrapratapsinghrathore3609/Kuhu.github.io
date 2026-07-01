const STATUS_ID = "runtime-status-strip";

function text(selector: string) {
  return document.querySelector(selector)?.textContent?.trim() || "";
}

function selectedText(selector: string) {
  const select = document.querySelector(selector) as HTMLSelectElement | null;
  return select?.selectedOptions?.[0]?.textContent?.trim() || "";
}

function ensureStatusStrip() {
  const topbar = document.querySelector(".topbar");
  if (!topbar || document.getElementById(STATUS_ID)) return;

  const strip = document.createElement("section");
  strip.id = STATUS_ID;
  strip.className = "status-strip runtime-status-strip";
  strip.setAttribute("aria-label", "Workspace status");
  topbar.insertAdjacentElement("afterend", strip);
}

function renderStatusStrip() {
  ensureStatusStrip();
  const strip = document.getElementById(STATUS_ID);
  if (!strip) return;

  const provider = selectedText(".top-actions select") || "Auto router";
  const historyCount = text(".history-heading span") || "0";
  const connectorCount = document.querySelectorAll(".connector-pill").length;
  const activeAgent = text(".topbar h2") || "Agent";
  const pendingCoder = document.querySelectorAll(".coder-proposal:not(.locked)").length;

  strip.innerHTML = `
    <div class="status-pill good"><strong>${escapeHtml(provider)}</strong><span>Active provider route</span></div>
    <div class="status-pill"><strong>${escapeHtml(activeAgent)} ready</strong><span>${historyCount} saved chats visible</span></div>
    <button type="button" class="${pendingCoder ? "status-pill action needs-action" : "status-pill action"}">
      <strong>${pendingCoder ? `${pendingCoder} Coder approval${pendingCoder === 1 ? "" : "s"}` : "Tools ready"}</strong>
      <span>${connectorCount} tool cards loaded</span>
    </button>
  `;

  strip.querySelector("button")?.addEventListener("click", () => {
    (document.querySelector(".top-actions button:nth-last-child(2)") as HTMLButtonElement | null)?.click();
  }, { once: true });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char] || char));
}

function installShortcuts() {
  window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      (document.querySelector(".new-chat") as HTMLButtonElement | null)?.click();
    }
    if (key === "h") {
      event.preventDefault();
      document.querySelector(".history-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (event.key === "/") {
      event.preventDefault();
      (document.querySelector(".top-actions button:nth-last-child(2)") as HTMLButtonElement | null)?.click();
    }
  });
}

function installPerformanceStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .chat { scroll-behavior: auto !important; }
    .workspace { grid-template-rows: auto auto minmax(0, 1fr) auto !important; }
    .runtime-status-strip { position: relative; z-index: 2; }
    @media (max-width: 760px) {
      .status-strip { grid-template-columns: 1fr !important; }
    }
  `;
  document.head.appendChild(style);
}

function bootRuntimeUpgrades() {
  installPerformanceStyles();
  installShortcuts();
  renderStatusStrip();

  const observer = new MutationObserver(() => {
    window.requestAnimationFrame(renderStatusStrip);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootRuntimeUpgrades, { once: true });
} else {
  bootRuntimeUpgrades();
}
