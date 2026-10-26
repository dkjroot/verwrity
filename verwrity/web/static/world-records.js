"use strict";

let recordLoading = null;
window.addEventListener("verwrity-wiki-view-changed", () => recordLoading?.abort());

function element(tag, text = "", className = "") {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function button(text, action) {
  const node = element("button", text); node.type = "button"; node.addEventListener("click", action); return node;
}

function readFields(root) {
  const result = {};
  for (const node of root.children) {
    if (node.matches("[data-record-object]")) {
      result[node.dataset.recordObject] = node.querySelector(":scope > label input").checked
        ? readFields(node.querySelector(":scope > [data-record-object-fields]")) : null;
    } else if (node.matches("[data-record-list]")) {
      result[node.dataset.recordList] = [...node.querySelector(":scope > [data-record-rows]").children].map(readFields);
    } else {
      const input = node.querySelector("[data-record-field]");
      if (!input) continue;
      const type = input.dataset.recordType;
      result[input.dataset.recordField] = type === "boolean" ? input.checked
        : input.hasAttribute("data-record-nullable") && input.value === "" ? null
          : type === "number" ? Number(input.value)
            : type === "list" ? input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : input.value;
    }
  }
  return result;
}

function syncOptionalFields(form) {
  // Ignore required controls in deliberately omitted profiles, retaining drafts.
  form.querySelectorAll("[data-record-object]").forEach(group => {
    const enabled = group.querySelector(":scope > label input").checked;
    const body = group.querySelector(":scope > [data-record-object-fields]");
    body.hidden = !enabled;
    body.querySelectorAll("input, select, textarea").forEach(input => { input.disabled = !enabled; });
  });
  form.querySelectorAll("[data-record-list]").forEach(list => {
    list.querySelector(":scope > summary [data-record-count]").textContent = `(${list.querySelector(":scope > [data-record-rows]").children.length})`;
  });
  const nature = form.querySelector('[data-record-field="nature"]');
  const alignment = form.querySelector('[data-record-field="alignment"]');
  if (nature && alignment) alignment.disabled = nature.value === "person";
}

export async function openRecordEditor(page, kind) {
  if (!(await window.verwrityWiki?.canNavigate())) return;
  if (kind === "location" && !(await window.verwrityWorld.ensureMap())) return;
  window.verwrityWiki.beginWorldEdit();
  recordLoading?.abort();
  const controller = recordLoading = new AbortController();
  const host = document.querySelector("[data-wiki-page-editor]");
  const status = element("p", "Loading world record…");
  host.replaceChildren(status); host.hidden = false;
  document.querySelector("[data-wiki-current-page]").hidden = true;
  try {
    const response = await fetch(`/world/pages/${encodeURIComponent(page.id)}/editor/${kind}`, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error("Could not open the world record. Reopen its wiki page and retry.");
    const html = await response.text();
    if (controller.signal.aborted) return;
    host.innerHTML = html;
    const form = host.querySelector("form");
    syncOptionalFields(form);
    const formStatus = form.querySelector("[data-world-form-status]");
    form.addEventListener("input", () => { form.dataset.dirty = "true"; });
    form.addEventListener("change", event => {
      if (event.target.dataset.recordField === "nature" && event.target.value === "person") form.querySelector('[data-record-field="alignment"]').value = "not_applicable";
      syncOptionalFields(form); form.dataset.dirty = "true";
    });
    form.addEventListener("click", event => {
      const add = event.target.closest("[data-add-record]");
      const remove = event.target.closest("[data-remove-record]");
      if (add) {
        const group = add.closest("[data-record-list]");
        if (group.querySelector(":scope > [data-record-rows]").children.length >= 100) return;
        group.querySelector(":scope > [data-record-rows]").append(group.querySelector(":scope > template").content.cloneNode(true));
      }
      if (remove) remove.closest("[data-record-row]").remove();
      if (add || remove) { syncOptionalFields(form); form.dataset.dirty = "true"; }
    });
    form.querySelector("[data-cancel-world-record]").addEventListener("click", async () => {
      if (await window.verwrityWiki.canNavigate()) window.verwrityWiki.show(page.id);
    });
    form.savePending = async () => {
      if (form.dataset.saving === "true") return false;
      const invalid = [...form.querySelectorAll("input, textarea, select")].find(control => !control.disabled && !control.checkValidity());
      if (invalid) {
        let parent = invalid.parentElement;
        while (parent && parent !== form) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
        invalid.reportValidity(); return false;
      }
      const record = readFields(form.querySelector("[data-record-root]"));
      form.dataset.saving = "true";
      const controls = [...form.querySelectorAll("input, textarea, select, button")];
      controls.forEach(control => { control.disabled = true; });
      formStatus.textContent = "Saving world record…";
      try {
        const response = await fetch(`/world/pages/${encodeURIComponent(page.id)}`, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Verwrity-Project-Id": form.dataset.projectId },
          body: JSON.stringify({ kind, record, revision: form.dataset.revision, page_hash: form.dataset.pageHash }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not save; your edits are kept here.");
        form.dataset.saving = "false";
        form.dataset.dirty = "false";
        window.verwrityMarkProjectChanged?.();
        window.verwrityWorld.update(result);
        window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: result.page }));
        return true;
      } catch (error) {
        form.dataset.saving = "false";
        formStatus.textContent = error.message;
        controls.forEach(control => { control.disabled = false; });
        syncOptionalFields(form);
        return false;
      }
    };
    form.addEventListener("submit", event => { event.preventDefault(); form.savePending(); });
    form.querySelector("[data-record-field]")?.focus();
  } catch (error) { if (!controller.signal.aborted) status.textContent = error.message; }
}

export function addWorldTools(host, page) {
  const world = window.verwrityWorld;
  if (!world || !page.world) return;
  const kind = page.world.kind;
  if (kind === "note") {
    const tools = element("div", "", "wiki-page-actions wiki-world-tools");
    if (world.characterEnabled) tools.append(button("Add character sheet", () => openRecordEditor(page, "character")));
    if (world.mapEnabled) tools.append(button("Add map location", () => openRecordEditor(page, "location")));
    if (world.fingalEnabled) tools.append(button("Add item definition", () => openRecordEditor(page, "item")));
    if (tools.childNodes.length) host.append(tools);
    return;
  }
  if (kind === "item" ? !world.fingalEnabled : kind === "character" ? !world.characterEnabled : !world.mapEnabled) return;
  const label = kind === "character" ? "Character sheet" : kind === "item" ? "Item definition" : "Map location";
  const section = element("section", "", "wiki-world-record");
  section.setAttribute("aria-label", label);
  section.append(element("h3", label), element("p", page.world.source
    ? `Imported Fingal record${page.world.source.edited_fields.length ? ' · Human changes: ' + page.world.source.edited_fields.join(', ') : ''}`
    : "Human-authored starting-world data", "wiki-editor-help"));
  const record = page.world[kind];
  const fields = kind === "character" ? [["ID", record.character_id], ["Role", record.role], ["Pronouns", record.pronouns], ["Age", record.age], ["Nature", record.nature]]
    : kind === "item" ? [["ID", record.item_id], ["Type", record.item_type], ["Portable", record.portable ? "Yes" : "No"]]
      : [["ID", record.location_id], ["Coordinates", `${record.x}, ${record.y}`], ["Map", world.mapTitle(record.map_id)]];
  const facts = element("dl");
  for (const [label, value] of fields) if (value !== "" && value !== null) facts.append(element("dt", label), element("dd", String(value)));
  section.append(facts);
  if (record.description) section.append(element("p", record.description));
  if (kind === "character") {
    if (record.home_location) {
      const title = world.pageTitle(record.home_location);
      section.append(button(`Starting cell: ${title}`, () => window.verwrityWiki.open(record.home_location)));
      if (world.mapEnabled) section.append(button("Show starting cell on map", () => world.openLocation(record.home_location)));
    }
    if (record.combat) section.append(element("p", `Might ${record.combat.might} · Agility ${record.combat.agility} · Resolve ${record.combat.resolve} · Health ${record.combat.max_health} · Stamina ${record.combat.max_stamina}`));
    if (record.equipped.length) section.append(element("p", "Starting equipment: " + record.equipped.map(item => `${item.item} (${item.slot.replaceAll("_", " ")})`).join(", ")));
  } else if (kind === "location") {
    section.append(button("Show on map", () => world.openLocation(page.id)));
    for (const exit of record.directions) section.append(button(`${exit.direction.replaceAll("_", " ")}: ${world.pageTitle(exit.target_page_id)} (${exit.travel_time} minutes)`, () => window.verwrityWiki.open(exit.target_page_id)));
    const residents = world.residents(page.id);
    if (residents.length) {
      section.append(element("h4", "Starting characters"));
      residents.forEach(resident => section.append(button(resident.title, () => window.verwrityWiki.open(resident.id))));
    }
  }
  section.append(button(`Edit ${label.toLowerCase()}`, () => openRecordEditor(page, kind)));
  section.append(button("Remove structured record", async () => {
    if (!(await window.verwrityDialog?.confirm("Remove this structured record? Wiki prose stays intact and the record remains in page history. References must be removed explicitly first.", { title: "Remove world record", acceptLabel: "Remove record" }))) return;
    try {
      const result = await world.mutate(`/world/pages/${page.id}/detach`, { page_hash: page.page_hash });
      window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: result.page }));
    } catch (error) { await window.verwrityDialog?.alert(error.message); }
  }));
  host.append(section);
}
