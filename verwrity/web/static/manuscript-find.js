"use strict";

const bar = document.querySelector("[data-find-bar]");
const queryInput = bar?.querySelector("[data-find-query]");
const replacementInput = bar?.querySelector("[data-find-replacement]");
const scopeInput = bar?.querySelector("[data-find-scope]");
const caseSensitiveInput = bar?.querySelector("[data-find-case-sensitive]");
const countOutput = bar?.querySelector("[data-find-count]");
const projectId = document.querySelector("[data-workspace]")?.dataset.projectId || "unknown";
const storageKey = `verwrity-manuscript-find:${projectId}`;
let searchSequence = 0;
let searchTimer;
let matches = [], matchIndex = -1;
let replacing = false;
let matchNavigation = Promise.resolve();

function savedState() {
  try {
    const state = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
    return {
      query: typeof state.query === "string" ? state.query : "",
      replacement: typeof state.replacement === "string" ? state.replacement : "",
      scope: state.scope === "project" ? "project" : "current_scene",
      caseSensitive: state.caseSensitive === true,
      open: state.open === true,
      pendingMatch: state.pendingMatch || null,
    };
  } catch (_) {
    return { query: "", replacement: "", scope: "current_scene", caseSensitive: false, open: false };
  }
}

function saveState() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify({
      query: queryInput?.value || "",
      replacement: replacementInput?.value || "",
      scope: scopeInput?.value || "current_scene",
      caseSensitive: Boolean(caseSensitiveInput?.checked),
      open: Boolean(bar && !bar.hidden),
      pendingMatch: pendingMatch,
    }));
  } catch (_) { /* Find can still be used when tab storage is unavailable. */ }
}

const restoredState = savedState();
let pendingMatch = restoredState.pendingMatch;
if (queryInput) queryInput.value = restoredState.query;
if (replacementInput) replacementInput.value = restoredState.replacement;
if (scopeInput) scopeInput.value = restoredState.scope;
if (caseSensitiveInput) caseSensitiveInput.checked = restoredState.caseSensitive;

function clearSceneMatches() {
  document.querySelectorAll(".scene-row.has-search-match").forEach((row) => {
    row.classList.remove("has-search-match");
    row.removeAttribute("data-search-match-count");
    const button = row.querySelector(".scene");
    if (button?.dataset.searchOriginalTitle !== undefined) {
      button.title = button.dataset.searchOriginalTitle;
      delete button.dataset.searchOriginalTitle;
    }
  });
}

function showSceneMatches(matches) {
  clearSceneMatches();
  for (const match of matches) {
    const row = document.querySelector(`.scene-row[data-scene-id="${CSS.escape(match.scene_id)}"]`);
    if (!row) continue;
    row.classList.add("has-search-match");
    row.dataset.searchMatchCount = String(match.count);
    const button = row.querySelector(".scene");
    if (button) {
      button.dataset.searchOriginalTitle ??= button.title;
      button.title = `${button.dataset.searchOriginalTitle}${button.dataset.searchOriginalTitle ? " · " : ""}${match.count} search match${match.count === 1 ? "" : "es"}`;
    }
  }
}

async function updateSearch() {
  const query = queryInput?.value || "";
  const caseSensitive = Boolean(caseSensitiveInput?.checked);
  const sequence = ++searchSequence;
  window.verwrityEditor?.setSearch(query, caseSensitive);
  saveState();
  if (!query) {
    matches = []; reflectMatchButtons();
    clearSceneMatches();
    if (countOutput) countOutput.textContent = "";
    return;
  }
  if (countOutput) countOutput.textContent = "Searching…";
  try {
    const response = await fetch("/manuscript/search", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query, scope: scopeInput?.value || "current_scene", case_sensitive: caseSensitive,
        active_text: window.verwrityEditor?.getText() || "",
        include_ranges: true,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Search failed");
    if (sequence !== searchSequence || query !== queryInput.value) return;
    showSceneMatches(result.matches || []);
    const previous = matches[matchIndex];
    matches = (result.matches || []).flatMap(scene => (scene.ranges || []).map(range => ({ sceneId: scene.scene_id, ...range })));
    matchIndex = previous ? matches.findIndex(match => match.sceneId === previous.sceneId && match.start === previous.start && match.quote === previous.quote) : -1;
    reflectMatchButtons();
    const count = (result.matches || []).reduce((total, match) => total + match.count, 0);
    if (countOutput) countOutput.textContent = matchIndex >= 0 ? `${matchIndex + 1} of ${count} matches` : `${count} match${count === 1 ? "" : "es"}`;
    return true;
  } catch (_) {
    if (sequence === searchSequence && countOutput) countOutput.textContent = "Search unavailable";
  }
}

function reflectMatchButtons() {
  for (const name of ['previous', 'next']) bar?.querySelector(`[data-find-${name}]`)?.toggleAttribute('disabled', !matches.length);
}
function goToMatch(direction, first = false) {
  const navigate = () => navigateToMatch(direction, first);
  matchNavigation = matchNavigation.then(navigate, navigate);
  return matchNavigation;
}
async function navigateToMatch(direction, first) {
  window.clearTimeout(searchTimer);
  if (!await updateSearch() || !matches.length) return;
  matchIndex = first ? 0 : matchIndex < 0 ? (direction < 0 ? matches.length - 1 : 0) : (matchIndex + direction + matches.length) % matches.length;
  const match = matches[matchIndex];
  if (match.sceneId === window.verwrityEditor?.sceneId) {
    const text = Array.from(window.verwrityEditor.getText()).slice(match.start, match.end).join('');
    if (text !== match.quote) { await updateSearch(); return; }
    window.verwrityEditor.selectSourceRange(match.start, match.end); window.verwrityEditor.focus();
    countOutput.textContent = `${matchIndex + 1} of ${matches.length} matches`;
  } else {
    if (await window.verwritySaveActiveScene?.() === false || await window.verwrityWiki?.prepareSceneNavigation() === false) return;
    pendingMatch = match; saveState();
    const form = document.createElement('form'); form.method = 'POST'; form.action = `/scene/select/${match.sceneId}`;
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'expected_project_id'; input.value = projectId; form.append(input);
    document.body.append(form); window.verwrityAllowUnload?.(); form.submit();
  }
}

function scheduleSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(updateSearch, 90);
}

async function openFind() {
  if (!bar) return;
  if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
  bar.hidden = false;
  saveState();
  queryInput?.focus();
  queryInput?.select();
  updateSearch();
}

function closeFind() {
  if (!bar) return;
  bar.hidden = true;
  saveState();
  window.verwrityEditor?.setSearch("", false);
  clearSceneMatches();
  if (countOutput) countOutput.textContent = "";
}

async function replace(replaceAll) {
  if (replacing) return;
  const query = queryInput?.value || "";
  if (!query) {
    queryInput?.focus();
    return;
  }
  window.clearTimeout(searchTimer);
  if (!await updateSearch()) return;
  let target = null;
  if (!replaceAll) {
    const activeId = window.verwrityEditor?.sceneId;
    const selection = window.verwrityEditor?.getSelectedRange();
    target = matches.find(match => match.sceneId === activeId && match.start === selection?.start && match.end === selection?.end)
      || (matches[matchIndex]?.sceneId === activeId ? matches[matchIndex] : matches.find(match => match.sceneId === activeId));
    if (!target) { if (matches.length) await goToMatch(1, true); return; }
  }
  replacing = true;
  const buttons = [...bar.querySelectorAll('[data-find-replace], [data-find-replace-all]')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (!(await window.verwritySaveActiveScene())) return;
    const replacement = replacementInput?.value || "";
    const response = await fetch("/manuscript/replace", {
      method: "POST", credentials: "same-origin",
      body: JSON.stringify({
        query,
        replacement,
        scope: scopeInput?.value || "current_scene",
        replace_all: replaceAll,
        case_sensitive: Boolean(caseSensitiveInput?.checked),
        active_scene_id: window.verwrityEditor.sceneId,
        scene_base_hash: window.verwritySceneHash?.(),
        ...(target ? { target: { scene_id: target.sceneId, start: target.start, end: target.end, quote: target.quote } } : {}),
      }),
      headers: { "Content-Type": "application/json", "X-Verwrity-Project-Id": projectId },
    });
    const result = await response.json();
    if (!response.ok) {
      if (countOutput) countOutput.textContent = result.error || "Replace failed";
      return;
    }
    const previousText = window.verwrityEditor?.getText() || "";
    window.verwrityUpdateSavedSceneHash?.(response);
    window.verwrityEditor?.setText(result.active_text || "", result.active_comments || [], true, result.active_dialogue || []);
    window.verwrityUpdateSceneWordCounts?.(result.scene_word_counts);
    if (result.active_text !== previousText) {
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: result.active_text } }));
    }
    window.verwrityMarkProjectChanged?.();
    if (countOutput) countOutput.textContent = `${result.count} replacement${result.count === 1 ? "" : "s"}`;
    await updateSearch();
    if (target) {
      const after = target.start + Array.from(replacement).length;
      const active = matches.filter(match => match.sceneId === target.sceneId);
      const next = active.find(match => match.start >= after) || active[0];
      if (next) {
        matchIndex = matches.indexOf(next);
        window.verwrityEditor.selectSourceRange(next.start, next.end);
        countOutput.textContent = `${matchIndex + 1} of ${matches.length} matches`;
      }
    }
  } catch (error) {
    if (countOutput) countOutput.textContent = error.serverUnavailable ? "Server unavailable" : "Replace failed";
  } finally {
    replacing = false; buttons.forEach(button => { button.disabled = false; });
  }
}

document.querySelector("[data-open-find]")?.addEventListener("click", openFind);
bar?.querySelector("[data-close-find]")?.addEventListener("click", closeFind);
queryInput?.addEventListener("input", () => { matchIndex = -1; matches = []; reflectMatchButtons(); saveState(); scheduleSearch(); });
bar?.querySelector('[data-find-run]')?.addEventListener('click', () => goToMatch(1, true));
bar?.querySelector('[data-find-previous]')?.addEventListener('click', () => goToMatch(-1));
bar?.querySelector('[data-find-next]')?.addEventListener('click', () => goToMatch(1));
bar?.addEventListener('submit', event => { event.preventDefault(); goToMatch(1); });
queryInput?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); goToMatch(event.shiftKey ? -1 : 1); } });
replacementInput?.addEventListener("input", saveState);
scopeInput?.addEventListener("change", () => { saveState(); updateSearch(); });
caseSensitiveInput?.addEventListener("change", () => { saveState(); updateSearch(); });
bar?.querySelector("[data-find-replace]")?.addEventListener("click", () => replace(false));
bar?.querySelector("[data-find-replace-all]")?.addEventListener("click", () => replace(true));
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openFind();
  } else if (event.key === "Escape" && bar && !bar.hidden) {
    closeFind();
  }
}, true);
window.addEventListener("verwrity-editor-change", scheduleSearch);

async function restoreOpenSearch() {
  if (!restoredState.open || !bar) return;
  bar.hidden = false;
  await updateSearch();
  if (pendingMatch) {
    const index = matches.findIndex(match => match.sceneId === pendingMatch.sceneId && match.start === pendingMatch.start && match.quote === pendingMatch.quote);
    pendingMatch = null; saveState();
    if (index >= 0) { matchIndex = index - 1; await goToMatch(1); }
  }
}

if (window.verwrityEditor) restoreOpenSearch();
else window.addEventListener("verwrity-editor-ready", restoreOpenSearch, { once: true });
