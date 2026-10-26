"use strict";

(() => {
  const storageKey = "verwrity-workspace-tips-v1";
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(storageKey) || "{}") || {}; } catch (_) { /* Storage is optional. */ }
  if (typeof saved !== "object" || Array.isArray(saved)) saved = {};
  // A document reload starts a fresh UI session; scene/form navigations do not.
  // Run this on Help and Storyboard too, so returning from a reload there agrees.
  if (performance.getEntriesByType("navigation")[0]?.type === "reload") {
    delete saved.dismissedDay;
    delete saved.index;
  }
  const persist = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(saved)); } catch (_) { /* In-memory dismissal still works. */ }
  };
  persist();

  const panel = document.querySelector("[data-wiki-panel]");
  const wikiContent = panel?.querySelector("[data-wiki-content]");
  const card = panel?.querySelector("[data-workspace-tips]");
  const deck = [...document.querySelectorAll("template[data-workspace-tip]")];
  if (!card || !wikiContent || !deck.length) return;
  const day = () => new Date().toLocaleDateString("en-CA");
  const content = card.querySelector("[data-tip-content]");
  const kicker = card.querySelector("[data-tip-kicker]");
  let index = Number.isInteger(saved.index) && saved.index >= 0
    ? saved.index % deck.length : Math.floor(Math.random() * deck.length);
  let frame = 0;

  function updateSpace() {
    frame = 0;
    const editing = !panel.querySelector("[data-wiki-page-editor]").hidden;
    const searching = document.activeElement?.matches("[data-wiki-search]");
    if (saved.dismissedDay === day() || panel.hidden || editing || searching
        || document.querySelector("dialog[open]") || matchMedia("(max-width: 800px)").matches) {
      card.hidden = true;
      return;
    }
    // Measure at the real column width without reserving or taking wiki space.
    card.hidden = false;
    const room = panel.clientHeight - 16 - wikiContent.offsetTop - wikiContent.offsetHeight;
    card.hidden = room < Math.max(200, card.offsetHeight + 24);
  }

  function scheduleSpace() {
    if (!frame) frame = requestAnimationFrame(updateSpace);
  }

  function showTip() {
    content.replaceChildren(deck[index].content.cloneNode(true));
    kicker.textContent = deck[index].dataset.kind === "support" ? "Support the developer" : "Did you know?";
    const helpLink = card.querySelector("[data-tip-help]");
    helpLink.href = deck[index].dataset.helpUrl;
    helpLink.textContent = deck[index].dataset.kind === "support" ? "Ways to support" : "Learn more in Help";
    saved.index = index;
    persist();
    scheduleSpace();
  }

  function nextTip() {
    index = (index + 1) % deck.length;
    showTip();
  }

  card.querySelector("[data-tip-dismiss]").addEventListener("click", () => {
    saved.dismissedDay = day();
    persist();
    card.hidden = true;
  });
  card.querySelector("[data-tip-next]").addEventListener("click", nextTip);
  const resize = new ResizeObserver(scheduleSpace);
  resize.observe(panel);
  resize.observe(wikiContent);
  const changes = new MutationObserver(scheduleSpace);
  changes.observe(wikiContent, { subtree: true, childList: true, attributes: true, characterData: true });
  changes.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  for (const dialog of document.querySelectorAll("dialog")) {
    changes.observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  panel.addEventListener("focusin", scheduleSpace);
  panel.addEventListener("focusout", scheduleSpace);
  window.addEventListener("resize", scheduleSpace);
  window.addEventListener("pageshow", (event) => {
    // Back/forward cache restores old JS objects; use the tab's latest dismissal.
    if (event.persisted) {
      try {
        const latest = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
        if (latest && typeof latest === "object" && !Array.isArray(latest)) saved = latest;
      } catch (_) { /* Retain in-memory state if storage is unavailable. */ }
    }
    scheduleSpace();
  });
  window.addEventListener("focus", scheduleSpace);
  document.addEventListener("visibilitychange", scheduleSpace);
  document.fonts?.ready.then(scheduleSpace);

  // Visible idle cards rotate slowly; never swap links under a pointer or focus.
  setInterval(() => {
    if (!card.hidden && !document.hidden && !card.matches(":hover") && !card.contains(document.activeElement)) nextTip();
    scheduleSpace();
  }, 60_000);
  showTip();
})();
