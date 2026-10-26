"use strict";
import { installFingalTransfer } from './fingal-transfer.js';

const workspace = document.querySelector("[data-workspace]");
let fragment = null, state = null, currentMap = "", selected = "", loading = null;
let mapEnabled = false, characterEnabled = false, fingalEnabled = false;
const viewKey = workspace ? `verwrity-world-view:${workspace.dataset.projectId}` : "";

function node(tag, text = "", className = "") {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function action(text, handler, className = "") {
  const element = node("button", text, className); element.type = "button"; element.addEventListener("click", handler); return element;
}
function locations() { return state?.pages.filter(page => page.world.kind === "location") || []; }
function residents(id) { return state?.pages.filter(page => page.world.character?.home_location === id) || []; }
function pageTitle(id) { return state?.pages.find(page => page.id === id)?.title || "Unknown location"; }
function update(result) {
  state = result;
  if (!state.maps.some(map => map.id === currentMap)) currentMap = state.maps[0]?.id || "";
  renderMap();
  window.verwrityWiki?.refresh();
}
async function reload() {
  const response = await fetch("/world/state", { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load world data.");
  if (result.project_id !== workspace.dataset.projectId) throw new Error("The active project changed. Reopen this project before editing the world.");
  update(result);
}
async function mutate(url, data) {
  if (!state) await reload();
  const response = await fetch(url, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Verwrity-Project-Id": workspace.dataset.projectId },
    body: JSON.stringify({ ...data, revision: state.revision }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Could not save the world; keep your edits and retry.");
    error.result = result; throw error;
  }
  window.verwrityMarkProjectChanged?.(); update(result); return result;
}
function message(text) { document.querySelector("[data-world-map-status]")?.replaceChildren(document.createTextNode(text)); }
async function attempt(task) {
  try { await task(); message(""); } catch (error) { message(error.message); await window.verwrityDialog?.alert(error.message, { title: "World editor" }); }
}
function setView(map) {
  if (map && !mapEnabled) return;
  document.body.dataset.workspaceView = map ? "map" : "manuscript";
  document.querySelector("[data-world-map-panel]")?.toggleAttribute("hidden", !map);
  document.querySelector("[data-map-nav]")?.toggleAttribute("hidden", !map);
  document.querySelectorAll("[data-open-world-map]").forEach(button => {
    button.textContent = map ? "Manuscript" : "Map"; button.setAttribute("aria-pressed", String(map));
  });
  document.querySelectorAll("[data-world-restore-controls] [data-open-world-map]").forEach(button => {
    button.textContent = "Map";
  });
  try { sessionStorage.setItem(viewKey, map ? "map" : "manuscript"); } catch (_) { /* View state is optional. */ }
  window.dispatchEvent(new Event("resize"));
}
async function openLocation(id) {
  if (!mapEnabled) return;
  const page = state.pages.find(page => page.id === id && page.world.location);
  if (!page || !(await window.verwrityWiki?.canNavigate())) return;
  selected = id; currentMap = page.world.location.map_id;
  setView(true); renderMap(); window.verwrityWiki.show(id);
  document.querySelector(`[data-map-cell="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
async function selectLocation(page) {
  if (!(await window.verwrityWiki?.canNavigate())) return;
  selected = page.id; renderMap(); window.verwrityWiki.show(page.id);
}
function renderMap() {
  const grid = document.querySelector("[data-world-map-grid]");
  if (!mapEnabled || !grid || !state) return;
  const map = state.maps.find(map => map.id === currentMap);
  document.querySelector("[data-world-map-title]").textContent = map?.title || "Create your first map";
  const choose = document.querySelector("[data-world-map-select]");
  choose.replaceChildren();
  if (!state.maps.length) choose.append(new Option("No maps yet", ""));
  state.maps.forEach(map => choose.append(new Option(map.title, map.id, false, map.id === currentMap)));
  const entries = locations().filter(page => page.world.location.map_id === currentMap);
  const list = document.querySelector("[data-world-location-list]"); list.replaceChildren();
  entries.slice().sort((a, b) => a.title.localeCompare(b.title)).forEach(page => {
    const item = node("li"); item.append(action(page.title, () => selectLocation(page), "wiki-link")); list.append(item);
  });
  grid.replaceChildren();
  const selection = document.querySelector("[data-world-selection]"); selection.replaceChildren();
  if (!map) { grid.append(node("p", "Create a map, then add locations by clicking empty cells.")); return; }
  const coordinates = new Map(entries.map(page => [`${page.world.location.x},${page.world.location.y}`, page]));
  const xs = entries.map(page => page.world.location.x), ys = entries.map(page => page.world.location.y);
  const minX = Math.min(0, ...xs) - 1, maxX = Math.max(0, ...xs) + 1;
  const minY = Math.min(0, ...ys) - 1, maxY = Math.max(0, ...ys) + 1;
  // Large offsets don't allocate thousands of empty cells between an island and zero.
  const left = entries.length ? Math.min(...xs) - 1 : minX, right = entries.length ? Math.max(...xs) + 1 : maxX;
  const top = entries.length ? Math.min(...ys) - 1 : minY, bottom = entries.length ? Math.max(...ys) + 1 : maxY;
  const axes = (low, high, values) => [...new Set([...Array.from({ length: Math.floor(high) - Math.ceil(low) + 1 }, (_, i) => Math.ceil(low) + i), ...values])].sort((a, b) => a - b);
  const xAxis = axes(left, right, xs), yAxis = axes(top, bottom, ys);
  const sparse = xAxis.length * yAxis.length > 4096;
  grid.style.gridTemplateColumns = `repeat(${sparse ? 4 : xAxis.length}, 140px)`;
  if (sparse) grid.append(node('p', 'This map has many fractional coordinates. Locations are listed by coordinate; edit placement in their wiki forms.'));
  const cells = sparse ? entries.map(page => [page.world.location.x, page.world.location.y]) : yAxis.flatMap(y => xAxis.map(x => [x, y]));
  for (const [x, y] of cells) {
    const page = coordinates.get(`${x},${y}`);
    const cell = node("div", "", `world-map-cell${page?.id === selected ? " is-selected" : ""}`);
    if (page) {
      const choose = action(page.title, () => selectLocation(page), "world-map-location"); choose.dataset.mapCell = page.id;
      choose.setAttribute("aria-label", `${page.title} at ${x}, ${y}`); choose.setAttribute("aria-pressed", String(page.id === selected)); cell.append(choose);
      cell.append(node("small", `${x}, ${y}${map.initial_location === page.id ? " · Start" : ""}`));
      const arrows = { north_west: "↖", north: "↑", north_east: "↗", west: "←", east: "→", south_west: "↙", south: "↓", south_east: "↘" };
      const routes = node("span", page.world.location.directions.map(exit => arrows[exit.direction]).join(" "), "world-cell-routes");
      routes.title = page.world.location.directions.map(exit => `${exit.direction.replaceAll("_", " ")}: ${pageTitle(exit.target_page_id)}`).join("\n"); cell.append(routes);
      const people = residents(page.id);
      people.slice(0, 2).forEach(person => cell.append(action(person.title, () => window.verwrityWiki.open(person.id), "world-cell-resident")));
      if (people.length > 2) cell.append(node("small", `+${people.length - 2} characters`));
    } else {
      const create = action(`+ ${x}, ${y}`, () => createLocation(x, y), "world-map-empty"); create.setAttribute("aria-label", `Add location at ${x}, ${y}`); cell.append(create);
    }
    grid.append(cell);
  }
  const page = entries.find(page => page.id === selected);
  if (!page) return;
  selection.append(node("h3", page.title), action("Open wiki location", () => window.verwrityWiki.open(page.id)));
  selection.append(action("Set initial location", () => attempt(() => mutate(`/world/maps/${map.id}`, { title: map.title, initial_location: page.id }))));
  if (map.initial_location === page.id) selection.append(action("Clear initial location", () => attempt(() => mutate(`/world/maps/${map.id}`, { title: map.title, initial_location: null }))));
  if (residents(page.id).length) {
    selection.append(node("h4", "Starting characters")); residents(page.id).forEach(person => selection.append(action(person.title, () => window.verwrityWiki.open(person.id))));
  }
}
async function createLocation(x, y) {
  if (!(await window.verwrityWiki?.canNavigate())) return;
  const title = await window.verwrityDialog?.prompt("Name this location. It will become a linked wiki page.", { title: "New map location", label: "Location name", acceptLabel: "Create location", maxLength: 200 });
  if (!title?.trim()) return;
  await attempt(async () => {
    const result = await createOrAdopt({ kind: "location", title: title.trim(), record: { location_id: `location_${crypto.randomUUID().slice(0, 8)}`, map_id: currentMap, x, y } });
    if (!result) return;
    currentMap = result.page.world.location.map_id;
    selected = result.page.id; renderMap(); window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: result.page }));
  });
}
async function createOrAdopt(data) {
  try { return await mutate("/world/pages", data); }
  catch (error) {
    const page = error.result?.existing_page;
    if (!page) throw error;
    if (!page.can_adopt) throw new Error(`“${page.title}” already has a ${page.kind} record. Open that wiki page to review it.`);
    const existing = page.kind === data.kind;
    const accepted = await window.verwrityDialog?.confirm(existing
      ? `“${page.title}” already has a ${data.kind} record. Open it with its current settings?`
      : `Use the existing wiki page “${page.title}” for this ${data.kind}? Its text, links and history will be preserved.`,
    { title: existing ? "Open existing wiki record" : "Use existing wiki page", acceptLabel: existing ? "Open existing record" : "Use existing page" });
    if (!accepted) return null;
    return mutate("/world/pages", { ...data, adopt_page_id: page.id, page_hash: page.page_hash });
  }
}
async function createMap() {
  const title = await window.verwrityDialog?.prompt("Name the map", { title: "New map", label: "Map name", acceptLabel: "Create map", maxLength: 200 });
  if (!title?.trim()) return;
  await attempt(async () => { const result = await mutate("/world/maps", { title: title.trim() }); currentMap = result.maps.at(-1).id; selected = ""; setView(true); renderMap(); });
}
async function createCharacter() {
  if (!(await window.verwrityWiki?.canNavigate())) return;
  const title = await window.verwrityDialog?.prompt("Name this character. Their sheet will live in a wiki page.", { title: "New character", label: "Character name", acceptLabel: "Create character", maxLength: 200 });
  if (!title?.trim()) return;
  await attempt(async () => {
    const result = await createOrAdopt({ kind: "character", title: title.trim(), record: { character_id: `character_${crypto.randomUUID().slice(0, 8)}` } });
    if (!result) return;
    window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: result.page }));
  });
}
async function createItem() {
  if (!(await window.verwrityWiki?.canNavigate())) return;
  const title = await window.verwrityDialog?.prompt('Name this item definition. It will live in the wiki.', { title: 'New item', label: 'Item name', acceptLabel: 'Create item', maxLength: 200 });
  if (!title?.trim()) return;
  await attempt(async () => {
    const result = await createOrAdopt({ kind: 'item', title: title.trim(), record: { item_id: `item_${crypto.randomUUID().slice(0, 8)}` } });
    if (result) window.dispatchEvent(new CustomEvent('verwrity-wiki-page-updated', { detail: result.page }));
  });
}
function install(root) {
  fragment = root;
  mapEnabled = root?.dataset.mapEnabled === "true"; characterEnabled = root?.dataset.characterEnabled === "true";
  fingalEnabled = root?.dataset.fingalEnabled === "true";
  installFingalTransfer(root, fingalEnabled);
  document.querySelector("[data-world-controls]").replaceChildren();
  document.querySelector("[data-world-restore-controls]").replaceChildren();
  document.querySelectorAll("[data-map-nav], [data-world-map-panel]").forEach(element => {
    if (!root?.contains(element)) element.remove();
  });
  document.querySelector("[data-world-controls]").append(...root?.querySelector("[data-world-actions]")?.childNodes || []);
  if (mapEnabled) {
    const restore = node("button", "Map"); restore.type = "button"; restore.dataset.openWorldMap = "";
    document.querySelector("[data-world-restore-controls]").append(restore);
    workspace.querySelector(".storyboard").append(root.querySelector("[data-map-nav]"));
    workspace.append(root.querySelector("[data-world-map-panel]"));
  }
  root?.remove();
  window.verwrityWorld = { get mapEnabled() { return mapEnabled; }, get characterEnabled() { return characterEnabled; }, get fingalEnabled() { return fingalEnabled; },
    update, mutate, residents, pageTitle, openLocation, reload,
    ensureMap: async () => { if (state?.maps.length) return true; await createMap(); return Boolean(state?.maps.length); },
    mapTitle: id => state?.maps.find(map => map.id === id)?.title || "No map",
    canChangeFeatures: async features => {
      const form = document.querySelector("[data-world-record-form]");
      const enabled = form?.dataset.kind === "item" ? features.fingal_mode : form?.dataset.kind === "character" ? features.fingal_mode || features.character_editor : features.fingal_mode || features.map_editor;
      return !form || enabled || await window.verwrityWiki.canNavigate();
    },
  };
  document.querySelectorAll("[data-open-world-map]").forEach(button => button.addEventListener("click", () => setView(document.body.dataset.workspaceView !== "map")));
  document.querySelector("[data-return-manuscript]")?.addEventListener("click", () => setView(false));
  document.querySelectorAll("[data-new-world-map]").forEach(button => button.addEventListener("click", createMap));
  document.querySelector("[data-new-world-character]")?.addEventListener("click", createCharacter);
  document.querySelector("[data-new-world-item]")?.addEventListener("click", createItem);
  document.querySelector("[data-reload-world]")?.addEventListener("click", () => attempt(reload));
  document.querySelector("[data-world-map-select]")?.addEventListener("change", event => { currentMap = event.target.value; selected = ""; renderMap(); });
  document.querySelector("[data-rename-world-map]")?.addEventListener("click", async () => {
    const map = state.maps.find(map => map.id === currentMap); if (!map) return;
    const title = await window.verwrityDialog?.prompt("Rename this map", { title: "Rename map", label: "Map name", value: map.title, acceptLabel: "Rename", maxLength: 200 });
    if (title?.trim()) await attempt(() => mutate(`/world/maps/${map.id}`, { title: title.trim(), initial_location: map.initial_location }));
  });
  document.querySelector("[data-delete-world-map]")?.addEventListener("click", async () => {
    if (!currentMap || !(await window.verwrityDialog?.confirm("Delete this empty map? Maps with locations cannot be deleted.", { title: "Delete map", acceptLabel: "Delete empty map" }))) return;
    await attempt(() => mutate(`/world/maps/${currentMap}/delete`, {}));
  });
}
async function bootstrap(root) {
  loading?.abort(); loading = new AbortController();
  const controller = loading;
  const oldForm = document.querySelector("[data-world-record-form]");
  const oldPage = oldForm?.dataset.pageId;
  const wasMap = document.body.dataset.workspaceView === "map";
  install(root);
  if (!mapEnabled && wasMap) setView(false);
  if (oldForm && !(oldForm.dataset.kind === "item" ? fingalEnabled : oldForm.dataset.kind === "character" ? characterEnabled : mapEnabled)) window.verwrityWiki?.show(oldPage);
  if (!mapEnabled && !characterEnabled) { state = null; window.verwrityWiki?.refresh(); return; }
  try {
    const response = await fetch("/world/state", { credentials: "same-origin", signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load world authoring.");
    if (controller.signal.aborted) return;
    if (result.project_id !== workspace.dataset.projectId) throw new Error("The active project changed; reopen it before editing.");
    update(result);
    let restoreMap = wasMap;
    try { restoreMap ||= sessionStorage.getItem(viewKey) === "map"; } catch (_) { /* View state is optional. */ }
    setView(restoreMap && mapEnabled);
    window.dispatchEvent(new Event("verwrity-world-ready"));
  } catch (error) { if (!controller.signal.aborted) message(error.message); }
}
if (workspace) {
  const initial = document.querySelector("[data-world-fragment]");
  if (initial) bootstrap(initial);
  window.addEventListener("verwrity-project-features-changed", async event => {
    const features = event.detail;
    const nextMap = features.fingal_mode || features.map_editor;
    const nextCharacter = features.fingal_mode || features.character_editor;
    // Remove revoked controls immediately, even if the subsequent GET fails.
    if (!nextMap) {
      setView(false);
      document.querySelectorAll("[data-open-world-map], [data-map-nav], [data-world-map-panel]").forEach(element => element.remove());
    }
    if (!nextCharacter) document.querySelector("[data-new-world-character]")?.remove();
    if (!features.fingal_mode) { document.querySelector('[data-new-world-item]')?.remove(); installFingalTransfer(null, false); }
    fingalEnabled = features.fingal_mode;
    mapEnabled = nextMap; characterEnabled = nextCharacter;
    const form = document.querySelector("[data-world-record-form]");
    if (form && !(form.dataset.kind === "item" ? fingalEnabled : form.dataset.kind === "character" ? nextCharacter : nextMap)) window.verwrityWiki?.show(form.dataset.pageId);
    window.verwrityWiki?.refresh();
    if (!nextMap && !nextCharacter) { await bootstrap(null); return; }
    try {
      const response = await fetch("/world/fragment", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Feature choices were saved, but the tools could not be loaded. Reopen the workspace when the server is available.");
      const template = document.createElement("template"); template.innerHTML = await response.text();
      await bootstrap(template.content.querySelector("[data-world-fragment]"));
    } catch (error) { await window.verwrityDialog?.alert(error.message, { title: "World tools unavailable" }); }
  });
  window.addEventListener("verwrity-world-ready", () => window.verwrityWiki?.refresh());
  window.addEventListener("verwrity-wiki-page-updated", event => {
    if (!mapEnabled && !characterEnabled) return;
    const page = state?.pages.find(page => page.id === event.detail?.id);
    if (!page || page.title !== event.detail.title) attempt(reload);
  });
  window.addEventListener("beforeunload", event => {
    if (document.querySelector('[data-world-record-form][data-dirty="true"]')) { event.preventDefault(); event.returnValue = ""; }
  });
}
