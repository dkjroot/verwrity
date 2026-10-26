/* One editor for saved vocabulary; scanning proposes words but never accepts them. */
const workspace = document.querySelector("[data-workspace]");
const unique = values => [...new Map(values.map(word => [word.trim().toLocaleLowerCase(), word.trim()])).values()].filter(Boolean);
const parse = text => unique(text.split(/[,\n]/));
async function request(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || "Word lists could not be saved."); return value;
}
export async function reviewVocabulary({ projectId, sections = [], scan = false }) {
  let state = await request("/project/words"), user = await request("/spelling-dictionary/global");
  if (state.project_id !== projectId) throw new Error("Project changed. Reopen Word lists.");
  let groups = [], choices = new Set(), moving = new Set();
  const dialog = document.createElement("dialog"); dialog.className = "file-dialog app-dialog project-words-dialog";
  dialog.setAttribute("aria-label", "Word lists");
  dialog.innerHTML = `<div class="file-dialog-heading"><h2>Word lists</h2><button type="button" data-words-close aria-label="Close word lists">×</button></div><div class="app-dialog-body">
    <div class="word-list-columns"><section><div class="word-list-heading"><strong>Project Words</strong><button type="button" data-words-edit>Edit list</button></div><div class="word-list-selection" data-words-selection></div><textarea rows="6" aria-label="Edit Project Words" data-words-project hidden></textarea></section><section><div class="word-list-heading"><strong>User words · all projects</strong></div><textarea rows="6" aria-label="User words · all projects" data-words-global></textarea></section></div>
    <p>Project Words are used by spelling, dictation and OCR. User words are used by spelling in all your projects.</p>
    <div class="app-dialog-actions"><button type="button" data-words-move>Move selected project words to user words</button><button type="button" data-words-save>Save word lists</button><button type="button" data-words-use>Save and close</button></div>
    <p data-words-status role="status"></p>
    <h3>Find Project Words</h3><button type="button" data-words-scan>Scan manuscript${sections.length ? " + import text" : ""}</button>
    <div data-words-groups></div>
    <div class="app-dialog-actions"><button type="button" data-words-wiki>Create wiki pages and add selected words</button><button type="button" data-words-add>Add selected words</button></div></div>`;
  const $ = name => dialog.querySelector(`[data-words-${name}]`);
  $("project").value = unique([...state.curated, ...(state.dictionary || [])]).join("\n"); $("global").value = user.words.join("\n");
  function drawSelection() {
    $("selection").replaceChildren();
    for (const word of parse($("project").value)) {
      const label = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox'; check.value = word; check.checked = moving.has(word);
      check.onchange = () => { if (check.checked) moving.add(word); else moving.delete(word); };
      label.append(check, document.createTextNode(word)); $("selection").append(label);
    }
  }
  $("edit").onclick = () => {
    const editing = $("project").hidden;
    $("project").hidden = !editing; $("selection").hidden = editing;
    $("edit").textContent = editing ? 'Done editing' : 'Edit list';
    if (editing) $("project").focus(); else drawSelection();
  };
  $("project").addEventListener('input', () => { moving.clear(); drawSelection(); });
  function draw() {
    drawSelection();
    const known = new Set([...parse($("project").value), ...parse($("global").value)].map(word => word.toLocaleLowerCase()));
    groups = groups.map(group => group.filter(item => !known.has(item.term.toLocaleLowerCase()))).filter(group => group.length);
    $("groups").replaceChildren();
    for (const group of groups) {
      const field = document.createElement("fieldset"), legend = document.createElement("legend");
      legend.textContent = group.length > 1 ? `Similar spellings · ${group[0].term}` : group[0].term; field.append(legend);
      for (const item of group) {
        const label = document.createElement("label"), check = document.createElement("input"); check.type = "checkbox"; check.dataset.word = item.term; check.checked = choices.has(item.term);
        check.onchange = () => { if (check.checked) choices.add(item.term); else choices.delete(item.term); };
        label.className = "word-candidate"; label.append(check, document.createTextNode(item.term));
        if (item.examples?.length) { const example = document.createElement("small"); example.textContent = item.examples.join(" / "); label.append(example); }
        field.append(label);
      }
      $("groups").append(field);
    }
    $("add").hidden = $("wiki").hidden = !groups.length;
  }
  async function save(createWiki = false, addChoices = false) {
    const words = unique([...parse($("project").value), ...(addChoices ? choices : [])]), globalWords = parse($("global").value);
    // Publish user additions first: a later project failure leaves duplicates,
    // rather than losing words moved between the two independent stores.
    if (JSON.stringify(globalWords) !== JSON.stringify(user.words)) {
      user = await request("/spelling-dictionary/global", { words: globalWords, previous: user.words }); $("global").value = user.words.join("\n");
    }
    state = await request("/project/words", { project_id: projectId, version: state.version, words, replace_dictionary: true, create_wiki: createWiki, wiki_words: [...choices] });
    $("project").value = state.curated.join("\n"); choices.clear(); draw();
    for (const page of state.created || []) window.dispatchEvent(new CustomEvent("verwrity-wiki-page-updated", { detail: { ...page, open: false } }));
    window.verwrityMarkProjectChanged?.(); window.dispatchEvent(new CustomEvent("verwrity-project-words-changed", { detail: state })); $("status").textContent = "Word lists saved.";
  }
  async function scanning() {
    $("scan").disabled = true; $("status").textContent = "Scanning locally…";
    try {
      const value = await request("/ai/import-vocabulary", { project_id: projectId, sections, selected: parse($("project").value) });
      groups = value.groups; choices.clear(); draw(); $("status").textContent = `${groups.reduce((n, group) => n + group.length, 0)} suggested words.`;
    } finally { $("scan").disabled = false; }
  }
  document.body.append(dialog); draw(); dialog.showModal();
  return new Promise(resolve => {
    let result = null, saving = false;
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); }, { once: true });
    $("close").onclick = () => { if (!saving) dialog.close(); }; dialog.addEventListener("cancel", event => { if (saving) event.preventDefault(); });
    const action = (name, fn) => $(name).onclick = async () => {
      if (saving) return; saving = true; const buttons = [...dialog.querySelectorAll("button")]; buttons.forEach(button => { button.disabled = true; });
      try { await fn(); } catch (error) { $("status").textContent = error.message; }
      finally { saving = false; buttons.forEach(button => { button.disabled = false; }); }
    };
    action("scan", scanning); action("save", () => save()); action("add", () => save(false, true)); action("wiki", () => save(true, true));
    action("move", () => {
      const input = $("project"), selected = [...moving].filter(word => parse(input.value).includes(word));
      if (!selected.length) { $("status").textContent = "Select project words to move."; return; }
      $("global").value = unique([...parse($("global").value), ...selected]).join("\n");
      const moved = new Set(selected.map(word => word.toLocaleLowerCase())); input.value = parse(input.value).filter(word => !moved.has(word.toLocaleLowerCase())).join("\n"); moving.clear(); drawSelection();
    });
    action("use", async () => { await save(); result = state.words; dialog.close(); });
    if (scan) scanning().catch(error => { $("status").textContent = error.message; });
  });
}
export async function addProjectWords(projectId, words) {
  const state = await request("/project/words"); if (state.project_id !== projectId) throw new Error("Project changed. Reopen Word lists.");
  const saved = await request("/project/words", { project_id: projectId, version: state.version, words: unique([...state.curated, ...words]) });
  window.verwrityMarkProjectChanged?.(); window.dispatchEvent(new CustomEvent("verwrity-project-words-changed", { detail: saved })); return saved.words;
}
document.querySelectorAll("[data-open-project-words]").forEach(button => button.addEventListener("click", () => reviewVocabulary({ projectId: workspace.dataset.projectId }).catch(error => window.verwrityDialog.alert(error.message))));
