"use strict";

const workspace = document.querySelector("[data-workspace]");
if (workspace) {
  const panelNames = ["storyboard", "wiki"];
  const panels = {
    storyboard: workspace.querySelector(".storyboard"),
    wiki: workspace.querySelector(".wiki"),
  };
  const splitters = Object.fromEntries(panelNames.map((name) => [
    name, workspace.querySelector(`[data-column-resizer="${name}"]`),
  ]));
  const toggles = [...document.querySelectorAll("[data-panel-toggle]")];
  const focusMenu = document.querySelector(".focus-menu");
  const focusSummary = focusMenu?.querySelector(":scope > summary");
  const typewriterToggle = document.querySelector("[data-typewriter-toggle]");
  const standardFocusToggle = document.querySelector("[data-standard-focus-toggle]");
  const restoreControls = document.querySelector(".writing-restore-controls");
  const writingModeIndicator = document.querySelector("[data-writing-mode-indicator]");
  const writingModeLabel = writingModeIndicator?.querySelector("[data-writing-mode-label]");
  const caretMovementToggle = document.querySelector("[data-caret-movement-toggle]");
  const storageKey = "verwrity-workspace-layout-v1";
  const minima = { storyboard: 120, wiki: 220 };
  const dividerWidth = 8;
  const manuscriptMinimum = 360;
  const defaultPanels = {
    normal: { storyboard: false, wiki: false },
    typewriter: { storyboard: true, wiki: true },
    focus: { storyboard: true, wiki: true },
  };
  const defaultMaximized = { normal: false, typewriter: true, focus: true };
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(storageKey) || "{}"); } catch (_) { saved = {}; }
  const wasInTypewriterMode = saved.typewriterMode === true;
  const legacyPanels = { storyboard: saved.storyboard === true, wiki: saved.wiki === true };
  const normalizePanelState = (state, fallback) => state && typeof state === "object"
    ? { storyboard: state.storyboard === true, wiki: state.wiki === true }
    : { ...fallback };
  let normalPanels = normalizePanelState(saved.normalPanels, wasInTypewriterMode ? defaultPanels.normal : legacyPanels);
  let typewriterPanels = normalizePanelState(saved.typewriterPanels, wasInTypewriterMode ? legacyPanels : defaultPanels.typewriter);
  let focusPanels = normalizePanelState(saved.focusPanels, defaultPanels.focus);
  let focusMode = saved.focusMode === "focus" ? "focus" : wasInTypewriterMode ? "typewriter" : "normal";
  // Each writing mode owns its layout. Exiting a maximized mode must save that
  // preference before restoring the normal workspace, rather than overwrite it.
  let normalMaximized = typeof saved.normalMaximized === "boolean" ? saved.normalMaximized
    : focusMode === "focus" ? saved.maximizeBeforeFocus === true
      : focusMode === "normal" && saved.maximized === true;
  let typewriterMaximized = typeof saved.typewriterMaximized === "boolean" ? saved.typewriterMaximized
    : focusMode === "typewriter" && typeof saved.maximized === "boolean" ? saved.maximized : defaultMaximized.typewriter;
  let focusMaximized = typeof saved.focusMaximized === "boolean" ? saved.focusMaximized
    : focusMode === "focus" ? saved.maximized === true : defaultMaximized.focus;
  let maximized = focusMode === "typewriter" ? typewriterMaximized : focusMode === "focus" ? focusMaximized : normalMaximized;
  let toolbarHidden = saved.toolbarHidden === true;
  let manuscriptControlsHidden = saved.manuscriptControlsHidden === true;
  let footerHidden = saved.footerHidden === true;

  function persist() {
    const currentPanels = { storyboard: panels.storyboard.hidden, wiki: panels.wiki.hidden };
    if (focusMode === "typewriter") {
      typewriterPanels = currentPanels;
      typewriterMaximized = maximized;
    } else if (focusMode === "focus") {
      focusPanels = currentPanels;
      focusMaximized = maximized;
    } else {
      normalPanels = currentPanels;
      normalMaximized = maximized;
    }
    const layout = {
      ...currentPanels,
      normalPanels,
      typewriterPanels,
      focusPanels, focusMode, maximized, normalMaximized, typewriterMaximized, focusMaximized,
      toolbarHidden, manuscriptControlsHidden, footerHidden,
      storyboardWidth: parseFloat(getComputedStyle(workspace).getPropertyValue("--storyboard-width")) || null,
      wikiWidth: parseFloat(getComputedStyle(workspace).getPropertyValue("--wiki-width")) || null,
      typewriterMode: workspace.dataset.typewriterMode === "true",
    };
    try { window.localStorage.setItem(storageKey, JSON.stringify(layout)); } catch (_) { /* Layout preferences are optional. */ }
  }

  let positionEpoch = 0;
  function retainPosition() {
    const viewport = document.querySelector("[data-editor-viewport]");
    if (!viewport) return;
    const token = ++positionEpoch, top = viewport.scrollTop, left = viewport.scrollLeft;
    const savedView = window.verwrityEditor?.captureViewPosition();
    const bounds = viewport.getBoundingClientRect();
    const paragraph = [...viewport.querySelectorAll(".tiptap p")].find(p => p.getBoundingClientRect().bottom > bounds.top);
    const offset = paragraph ? paragraph.getBoundingClientRect().top - bounds.top : null;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (token !== positionEpoch) return;
      if (savedView) { window.verwrityEditor.restoreViewPosition(savedView); return; }
      viewport.scrollTop = paragraph?.isConnected ? viewport.scrollTop + paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset : top;
      viewport.scrollLeft = left;
    }));
  }
  function syncControls() {
    retainPosition();
    const typewriterMode = workspace.dataset.typewriterMode === "true";
    document.body.dataset.editorMaximized = String(maximized);
    document.body.dataset.toolbarHidden = String(toolbarHidden);
    document.body.dataset.manuscriptControlsHidden = String(manuscriptControlsHidden);
    document.body.dataset.footerHidden = String(footerHidden);
    workspace.dataset.focusMode = focusMode;
    if (writingModeIndicator) writingModeIndicator.dataset.mode = focusMode;
    if (writingModeLabel) writingModeLabel.textContent = typewriterMode ? "Typewriter mode" : focusMode === "focus" ? "Focus mode" : "Normal mode";
    if (caretMovementToggle) caretMovementToggle.hidden = !typewriterMode;
    focusSummary?.setAttribute("aria-label", focusMode !== "normal" ? "Exit focus mode" : "Focus options");
    if (focusSummary) focusSummary.dataset.active = String(focusMode !== "normal");
    standardFocusToggle?.setAttribute("aria-pressed", String(focusMode === "focus"));
    typewriterToggle?.setAttribute("aria-pressed", String(typewriterMode));
    const maximizeButton = document.querySelector("[data-maximize-editor]");
    if (maximizeButton) maximizeButton.textContent = maximized ? "Show editor controls" : "Hide editor controls";
    document.querySelector("[data-maximize-editor]")?.setAttribute("aria-pressed", String(maximized));
    document.querySelector("[data-hide-manuscript-controls]").textContent = manuscriptControlsHidden ? "Show manuscript controls" : "Hide manuscript controls";
    restoreControls.hidden = !(maximized || toolbarHidden);
    if (restoreControls.hidden) restoreControls.open = false;
    restoreControls.querySelector("[data-restore-editor]").hidden = !maximized;
    restoreControls.querySelector("[data-exit-focus]").hidden = focusMode === "normal";
    restoreControls.querySelector("[data-show-toolbar]").hidden = maximized || !toolbarHidden;

    for (const name of panelNames) {
      const hidden = panels[name].hidden;
      splitters[name].hidden = hidden || window.matchMedia("(max-width: 800px)").matches;
      const other = name === "storyboard" ? "wiki" : "storyboard";
      const otherWidth = panels[other].hidden ? 0 : panels[other].getBoundingClientRect().width;
      const maximum = Math.max(minima[name], workspace.clientWidth - manuscriptMinimum - dividerWidth * 2 - otherWidth);
      splitters[name].setAttribute("aria-valuemin", String(minima[name]));
      splitters[name].setAttribute("aria-valuemax", String(Math.round(maximum)));
      splitters[name].setAttribute("aria-valuenow", String(Math.round(panels[name].getBoundingClientRect().width)));
      workspace.dataset[`${name}Hidden`] = String(hidden);
      const toggle = toggles.find((button) => button.dataset.panelToggle === name);
      if (toggle) {
        toggle.textContent = `${hidden ? "Show" : "Hide"} ${name === "wiki" ? "wiki" : "storyboard"}`;
        toggle.setAttribute("aria-pressed", String(!hidden));
        toggle.setAttribute("aria-label", `${hidden ? "Show" : "Hide"} ${name === "wiki" ? "wiki" : "storyboard"} panel`);
      }
    }
  }

  function setWidth(name, width) {
    const other = name === "storyboard" ? "wiki" : "storyboard";
    const otherWidth = panels[other].hidden ? 0 : panels[other].getBoundingClientRect().width;
    const maximum = Math.max(minima[name], workspace.clientWidth - manuscriptMinimum - dividerWidth * 2 - otherWidth);
    const value = Math.max(minima[name], Math.min(maximum, width));
    workspace.style.setProperty(`--${name}-width`, `${value}px`);
    splitters[name].setAttribute("aria-valuemin", String(minima[name]));
    splitters[name].setAttribute("aria-valuemax", String(Math.round(maximum)));
    splitters[name].setAttribute("aria-valuenow", String(Math.round(value)));
  }

  function setHidden(name, hidden) {
    panels[name].hidden = hidden;
    syncControls();
    persist();
  }

  function resetCaretControls() {
    document.querySelectorAll("[data-caret-movement-toggle], [data-focus-caret-toggle]").forEach((button) => {
      button.setAttribute("aria-pressed", "false");
      button.textContent = "Unlock caret";
    });
  }

  function setFocusMode(mode) {
    if (focusMode === mode) return;
    persist();
    focusMode = mode;
    maximized = mode === "typewriter" ? typewriterMaximized : mode === "focus" ? focusMaximized : normalMaximized;
    workspace.dataset.typewriterMode = String(mode === "typewriter");
    const panelState = mode === "typewriter" ? typewriterPanels : mode === "focus" ? focusPanels : normalPanels;
    restoreControls.open = false;
    for (const name of panelNames) panels[name].hidden = panelState[name];
    resetCaretControls();
    syncControls();
    persist();
    window.verwrityEditor?.setTypewriterMode(mode === "typewriter");
  }

  focusSummary?.addEventListener("click", (event) => {
    if (focusMode === "normal") return;
    event.preventDefault();
    if (focusMenu) focusMenu.open = false;
    setFocusMode("normal");
  });

  typewriterToggle?.addEventListener("click", () => {
    setFocusMode(focusMode === "typewriter" ? "normal" : "typewriter");
    if (focusMenu) focusMenu.open = false;
  });

  standardFocusToggle?.addEventListener("click", () => {
    setFocusMode(focusMode === "focus" ? "normal" : "focus");
    if (focusMenu) focusMenu.open = false;
  });

  function updateLayout() { restoreControls.open = false; syncControls(); persist(); }
  document.querySelectorAll("[data-restore-default-layout]").forEach((button) => button.addEventListener("click", () => {
    // Reset live state as well as storage so leaving focus cannot save old choices again.
    normalPanels = { ...defaultPanels.normal };
    typewriterPanels = { ...defaultPanels.typewriter };
    focusPanels = { ...defaultPanels.focus };
    normalMaximized = defaultMaximized.normal;
    typewriterMaximized = defaultMaximized.typewriter;
    focusMaximized = defaultMaximized.focus;
    focusMode = "normal";
    maximized = normalMaximized;
    toolbarHidden = manuscriptControlsHidden = footerHidden = false;
    workspace.dataset.typewriterMode = "false";
    for (const name of panelNames) {
      panels[name].hidden = normalPanels[name];
      workspace.style.removeProperty(`--${name}-width`);
    }
    document.querySelector(".layout-menu").open = false;
    restoreControls.open = false;
    resetCaretControls();
    syncControls();
    try { window.localStorage.removeItem(storageKey); } catch (_) { /* Live layout still resets without storage. */ }
    window.verwrityEditor?.setTypewriterMode(false);
    document.querySelector(".layout-menu > summary")?.focus();
  }));
  document.querySelector("[data-hide-footer]")?.addEventListener("click", () => {
    footerHidden = true;
    updateLayout();
    // The clicked close button leaves the layout; retain keyboard access to restore.
    document.querySelector(toolbarHidden ? ".writing-restore-controls > summary" : ".layout-menu > summary")?.focus();
  });
  document.querySelector("[data-footer-toggle]")?.addEventListener("click", () => {
    footerHidden = !footerHidden;
    document.querySelector(".layout-menu").open = false;
    updateLayout();
  });
  document.querySelector("[data-maximize-editor]")?.addEventListener("click", () => {
    maximized = !maximized;
    document.querySelector(".layout-menu").open = false;
    updateLayout();
    document.querySelector(".tiptap")?.focus({ preventScroll: true });
  });
  document.querySelector("[data-restore-editor]")?.addEventListener("click", () => {
    maximized = false;
    manuscriptControlsHidden = false;
    updateLayout();
    document.querySelector(toolbarHidden ? ".writing-restore-controls > summary" : "[data-focus-toggle]")?.focus();
  });
  document.querySelector("[data-exit-focus]")?.addEventListener("click", () => {
    setFocusMode("normal");
  });
  for (const [hide, show, key] of [["hide-toolbar", "show-toolbar", "toolbar"], ["hide-manuscript-controls", "show-manuscript-controls", "manuscript"]]) {
    for (const [action, hidden] of [[hide, true], [show, false]]) {
      document.querySelector(`[data-${action}]`)?.addEventListener("click", () => {
        if (key === "toolbar") toolbarHidden = hidden;
        else manuscriptControlsHidden = action === hide ? !manuscriptControlsHidden : false;
        document.querySelector(".layout-menu").open = false;
        updateLayout();
        document.querySelector(restoreControls.hidden ? ".layout-menu > summary" : ".writing-restore-controls > summary")?.focus();
      });
    }
  }

  document.querySelectorAll("[data-caret-movement-toggle], [data-focus-caret-toggle]").forEach((button) => button.addEventListener("click", () => {
    const enabled = caretMovementToggle.getAttribute("aria-pressed") !== "true";
    caretMovementToggle.setAttribute("aria-pressed", String(enabled));
    caretMovementToggle.textContent = enabled ? "Lock caret" : "Unlock caret";
    const focusCaret = restoreControls.querySelector("[data-focus-caret-toggle]");
    focusCaret?.setAttribute("aria-pressed", String(enabled));
    if (focusCaret) focusCaret.textContent = enabled ? "Lock caret" : "Unlock caret";
    window.verwrityEditor?.setCaretMovementEnabled(enabled);
    restoreControls.open = false;
  }));

  toggles.forEach((toggle) => toggle.addEventListener("click", () => {
    const name = toggle.dataset.panelToggle;
    setHidden(name, !panels[name].hidden);
  }));

  for (const name of panelNames) {
    const splitter = splitters[name];
    splitter.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panels[name].getBoundingClientRect().width;
      splitter.setPointerCapture(event.pointerId);
      const move = (pointerEvent) => {
        const delta = pointerEvent.clientX - startX;
        setWidth(name, startWidth + (name === "storyboard" ? delta : -delta));
      };
      const finish = () => {
        splitter.removeEventListener("pointermove", move);
        splitter.removeEventListener("pointerup", finish);
        splitter.removeEventListener("pointercancel", finish);
        persist();
      };
      splitter.addEventListener("pointermove", move);
      splitter.addEventListener("pointerup", finish);
      splitter.addEventListener("pointercancel", finish);
    });
    splitter.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const sign = name === "storyboard" ? 1 : -1;
      setWidth(name, panels[name].getBoundingClientRect().width + direction * sign * 16);
      persist();
    });
  }

  workspace.dataset.typewriterMode = String(focusMode === "typewriter");
  const initialPanels = focusMode === "typewriter" ? typewriterPanels : focusMode === "focus" ? focusPanels : normalPanels;
  for (const name of panelNames) panels[name].hidden = initialPanels[name];
  typewriterToggle?.setAttribute("aria-pressed", String(wasInTypewriterMode));
  if (Number.isFinite(saved.storyboardWidth)) setWidth("storyboard", saved.storyboardWidth);
  if (Number.isFinite(saved.wikiWidth)) setWidth("wiki", saved.wikiWidth);
  syncControls();
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 800px)").matches) {
      for (const name of panelNames) {
        const width = parseFloat(workspace.style.getPropertyValue(`--${name}-width`));
        if (Number.isFinite(width)) setWidth(name, width);
      }
    }
    syncControls();
  });
}
