import { matchesWikiPage, renderWikiBody } from "./wiki-rendering.js";
import { post } from "./wiki-ai.js";
import { visibleAnnotations, wikiAIControls, wikiAIReview } from "./wiki-ai.js";
import { attachWikiAuthorship } from "./wiki-authorship.js";
import { wikiInstruction } from "./wiki-instruction.js";
import { addWorldTools } from "./world-records.js";
import { wikiNavigation } from "./wiki-navigation.js";

const panel = document.querySelector("[data-wiki-panel]");
if (panel) {
  const current = panel.querySelector("[data-wiki-current-page]");
  const editor = panel.querySelector("[data-wiki-page-editor]");
  const list = panel.querySelector("[data-wiki-page-list]");
  const search = panel.querySelector("[data-wiki-search]");
  const wikiTemplates = {
    character: {
      label: "Character profile",
      body: [
        "## Identity",
        "- Name: ",
        "- Other names, titles, or aliases: ",
        "- Age (and age during the story): ",
        "- Pronouns: ",
        "- Species or kind: ",
        "- Occupation, role, or status: ",
        "",
        "## Background",
        "- Birthplace: ",
        "- Where they grew up: ",
        "- Family and upbringing: ",
        "- Education, training, or formative communities: ",
        "- Defining incident: What happened, and what did they take it to mean? ",
        "",
        "## Appearance",
        "- Build, bearing, and movement: ",
        "- Face, hair, eyes, or other distinguishing features: ",
        "- Clothing and objects they carry: ",
        "- What do they choose to show or conceal? ",
        "",
        "## Voice and manner",
        "- Sound, rhythm, vocabulary, accent, or register: ",
        "- What do they avoid saying? What do they say too often? ",
        "- Gestures, habits, or tells: ",
        "",
        "## Inner life",
        "- What do they want right now? ",
        "- What deeper need or fear sits underneath that want? ",
        "- What do they value most, and what would they refuse to trade away? ",
        "- What contradiction makes them difficult to sum up? ",
        "",
        "## Theory of control",
        "- What do they believe keeps them safe, loved, respected, or in control? ",
        "- What experience taught them this rule? ",
        "- What are they afraid would happen if they stopped following it? ",
        "- When an unexpected change arrives, what is their automatic response? ",
        "- When does that strategy help them, and what does it cost them or others? ",
        "",
        "## Relationships and knowledge",
        "- Who matters most to them, and why? ",
        "- What do they need from others but struggle to ask for? ",
        "- What do they know, suspect, misunderstand, or keep secret? ",
        "- How might their view of themselves differ from how others see them? ",
        "",
        "## Story role and change",
        "- What role do they play in the story, and what are they trying to achieve? ",
        "- What pressure tests their usual way of coping? ",
        "- What choices reveal who they are? ",
        "- Do they change, resist change, or change in an unexpected direction? ",
        "- What action or moment would let a reader see that change (or refusal) for themselves?",
      ].join("\n"),
    },
  };
  const pages = [...panel.querySelectorAll("template[data-wiki-page]")].map((template) => ({
    id: template.dataset.wikiPage,
    title: template.dataset.title,
    aliases: (template.dataset.aliases || "").split(",").map((value) => value.trim()).filter(Boolean),
    body: JSON.parse(template.dataset.bodyJson || JSON.stringify(template.dataset.body || "")),
    tags: template.dataset.tags || "",
    ...JSON.parse(template.dataset.provenance || "{}"),
    page_hash: template.dataset.pageHash,
    source_hash: template.dataset.sourceHash,
    world: JSON.parse(template.dataset.world || '{"kind":"note"}'),
    revisions: [...panel.querySelectorAll(`template[data-wiki-revision='${template.dataset.wikiPage}']`)].map((revision) => ({
      id: revision.dataset.revisionId, title: revision.dataset.title,
      body: JSON.parse(revision.dataset.bodyJson || JSON.stringify(revision.dataset.body || "")),
      tags: revision.dataset.tags || "", aliases: (revision.dataset.aliases || "").split(",").map((value) => value.trim()).filter(Boolean), savedAt: revision.dataset.savedAt || "",
      world: JSON.parse(revision.dataset.world || '{"kind":"note"}'),
    })),
    template,
  }));
  let currentPage = null;
  let aiControls = null;
  let authorshipEditor = null;
  const navigation = wikiNavigation(document.querySelector('[data-workspace]').dataset.projectId, () => {
    if (!currentPage) return null;
    const sheet = editor.querySelector('[data-world-record-form]');
    if (!editor.hidden && (sheet?.dataset.dirty === 'true' || sheet?.dataset.saving === 'true')) throw new Error('World record edits are open');
    const form = editor.hidden ? null : editor.querySelector('[data-wiki-save]');
    const { template, revisions, ...base } = currentPage;
    const body = form?.elements.body;
    return { pageId: currentPage.id, base, editing: Boolean(form),
      fields: form ? Object.fromEntries(['title', 'aliases', 'tags', 'purpose'].map(name => [name, form.elements[name].value])) : null,
      ownership: form ? authorshipEditor.snapshot() : null,
      instruction: form ? aiControls?.snapshot() : null, instructionOpen: Boolean(aiControls?.open),
      selection: body ? [body.selectionStart, body.selectionEnd] : null, bodyScroll: body?.scrollTop || 0,
      panelScroll: panel.scrollTop, editorScroll: editor.scrollTop,
      contentScroll: panel.querySelector('[data-wiki-content]').scrollTop };
  });
  function editingChrome(editing) {
    panel.dataset.editing = String(editing);
    for (const node of panel.querySelectorAll("[data-wiki-new], .wiki-search-label, [data-wiki-search]")) node.hidden = editing;
    if (editing) panel.querySelector(".wiki-page-list").hidden = true;
  }
  function hasPending() {
    if (!editor.hidden && editor.querySelector('[data-world-record-form]')?.dataset.dirty === 'true') return true;
    const form = editor.querySelector("[data-wiki-save]");
    if (editor.hidden || !form || !currentPage) return false;
    authorshipEditor?.sync();
    return ["title", "body", "purpose", "tags", "aliases"].some(name => form.elements[name].value !==
      (name === "aliases" ? currentPage.aliases.join(", ") : String(currentPage[name] || "").replace(/\r\n?/g, "\n")))
      || JSON.parse(form.elements.authorship_edits?.value || "[]").length > 0;
  }
  async function canNavigate() {
    const sheet = editor.querySelector("[data-world-record-form]");
    if (sheet?.dataset.saving === "true") return false;
    const form = editor.querySelector("[data-wiki-save]");
    if (form && !editor.hidden) authorshipEditor?.sync();
    const changed = !editor.hidden && (sheet?.dataset.dirty === "true" || (form && currentPage && (
      form.elements.body.value !== currentPage.body.replace(/\r\n?/g, "\n") || form.elements.title.value !== currentPage.title
      || form.elements.tags.value !== currentPage.tags || form.elements.aliases.value !== currentPage.aliases.join(", ")
      || form.elements.purpose.value !== (currentPage.purpose || "")
      || JSON.parse(form.elements.authorship_edits?.value || "[]").length)));
    return !changed || await window.verwrityDialog?.confirm("Discard unsaved wiki or world-record edits before opening another page?", {
      title: "Unsaved wiki edits", acceptLabel: "Discard edits",
    });
  }
  async function requestOpen(page) {
    if (page && await canNavigate()) {
      search.value = ""; open(page); panel.querySelector(".wiki-page-list").hidden = true;
    }
  }
  window.verwrityWiki = { canNavigate, hasPending, prepareSceneNavigation: () => navigation.preserve(), open: id => requestOpen(pages.find(page => page.id === id)),
    savePending: async () => {
      if (editor.hidden) return true;
      const form = editor.querySelector('form');
      if (!form?.savePending) return false;
      aiControls?.cancelRequest();
      return await form.savePending() !== false;
    },
    show: id => open(pages.find(page => page.id === id)),
    beginWorldEdit: () => { aiControls?.cancelRequest(); authorshipEditor?.destroy(); authorshipEditor = null; window.dispatchEvent(new Event("verwrity-wiki-view-changed")); },
    refresh: () => { if (currentPage && editor.hidden && current.dataset.view === "page") open(currentPage); } };
  panel.querySelector("[data-wiki-empty]").hidden = pages.length > 0;
  async function saveSceneThenSubmit(form) {
    try {
      const saved = await window.verwritySaveActiveScene?.();
      if (saved === false) {
        await window.verwrityDialog?.alert("The current scene could not be saved. Please retry before continuing.", { title: "Scene not saved" });
        return;
      }
      if (form.dataset.wikiSave) {
        const response = await fetch(form.action, { method: "POST", headers: { "Accept": "application/json" }, body: new FormData(form) });
        if (!response.ok) {
          const result = await response.json();
          await window.verwrityDialog?.alert(result.error || "The page could not be saved. Keep your edits and retry.", { title: "Wiki not saved" });
          return;
        }
        navigation.saved(); window.verwrityMarkProjectChanged?.(); window.verwrityAllowUnload?.();
        location.assign(response.url);
      } else {
        window.verwrityMarkProjectChanged?.(); window.verwrityAllowUnload?.(); form.submit();
      }
    } catch (_) {
      await window.verwrityDialog?.alert(form.dataset.wikiSave
        ? "The wiki page could not be saved. Your edits are still here; retry when ready."
        : "The current scene could not be saved. Please try again.", { title: "Save failed" });
    }
  }

  function open(page) {
    if (!page) return;
    editingChrome(false);
    authorshipEditor?.destroy(); authorshipEditor = null;
    aiControls?.cancelRequest();
    currentPage = page;
    current.dataset.view = "page";
    current.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = page.title;
    current.append(heading);
    window.dispatchEvent(new Event("verwrity-wiki-view-changed"));
    addWorldTools(current, page);
    if (page.tags.trim()) {
      const tags = document.createElement("p");
      tags.className = "wiki-tags";
      for (const tag of page.tags.split(",")) {
        const chip = document.createElement("span"); chip.textContent = tag.trim(); tags.append(chip);
      }
      current.append(tags);
    }
    if (page.aliases.length) {
      const aliases = document.createElement("p");
      aliases.className = "wiki-aliases";
      const label = document.createElement("strong"); label.textContent = "Also known as: "; aliases.append(label);
      aliases.append(document.createTextNode(page.aliases.join(", ")));
      current.append(aliases);
    }
    const body = document.createElement("div");
    body.className = "wiki-page-body";
    renderWikiBody(body, page.body, pages, visibleAnnotations(page));
    current.append(body);
    const actions = document.createElement("div");
    actions.className = "wiki-page-actions";
    const edit = document.createElement("button");
    edit.type = "button"; edit.textContent = "Edit page";
    edit.addEventListener("click", () => editPage(page));
    actions.append(edit);
    const dialogue = document.createElement("button"); dialogue.type = "button"; dialogue.textContent = "Dialogue";
    dialogue.addEventListener("click", () => window.dispatchEvent(new CustomEvent("verwrity-speaker-dialogue", { detail: page.id })));
    actions.append(dialogue);
    actions.append(templateControls((templateName) => editPage(page, templateName)));
    if (page.revisions.length) {
      const history = document.createElement("button");
      history.type = "button"; history.textContent = `History (${page.revisions.length})`;
      history.addEventListener("click", () => showHistory(page));
      actions.append(history);
    }
    const remove = document.createElement("form");
    remove.method = "post"; remove.action = `/wiki/page/${encodeURIComponent(page.id)}/delete`;
    const deleteButton = document.createElement("button");
    deleteButton.type = "submit"; deleteButton.textContent = "Delete";
    remove.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (await window.verwrityDialog?.confirm(`Delete “${page.title}”? Links to it will become plain text.`, {
        title: "Delete wiki page", acceptLabel: "Delete page",
      })) saveSceneThenSubmit(remove);
    });
    remove.append(deleteButton); actions.append(remove); current.append(actions);
    const update = (data, report = "") => {
      Object.assign(page, data, { tags: (data.tags || []).join(", ") });
      if (page.template) {
        page.template.dataset.bodyJson = JSON.stringify(page.body);
        page.template.dataset.provenance = JSON.stringify({ purpose: page.purpose, annotations: page.annotations });
        page.template.dataset.pageHash = page.page_hash;
      }
      open(page);
      if (report) {
        const status = document.createElement("p"); status.className = "wiki-ai-status"; status.setAttribute("role", "status");
        status.textContent = report; current.querySelector(".wiki-page-body")?.after(status);
      }
    };
    aiControls = wikiAIControls(page, update);
    current.append(aiControls, wikiAIReview(page, update));
    const backlinks = pages.filter((candidate) => candidate.id !== page.id && [...candidate.body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].some((match) => matchesWikiPage(page, match[1])));
    const backlinkSection = document.createElement("section"); backlinkSection.className = "wiki-backlinks";
    const backlinkHeading = document.createElement("h3"); backlinkHeading.textContent = `Linked from (${backlinks.length})`; backlinkSection.append(backlinkHeading);
    if (backlinks.length) {
      const backlinkList = document.createElement("ul");
      for (const source of backlinks) {
        const item = document.createElement("li");
        const link = document.createElement("button"); link.type = "button"; link.className = "wiki-inline-link";
        link.dataset.wikiPageId = source.id; link.textContent = source.title; item.append(link); backlinkList.append(item);
      }
      backlinkSection.append(backlinkList);
    } else {
      const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "No pages link here yet."; backlinkSection.append(empty);
    }
    current.append(backlinkSection);
    const query = search.value.trim().toLocaleLowerCase();
    if (query) current.querySelectorAll("h2, .wiki-tags, .wiki-aliases, .wiki-page-body").forEach((element) => highlightTextNodes(element, query));
    panel.querySelectorAll(".wiki-link").forEach((button) => {
      if (button.dataset.wikiPageId === page.id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
    editor.hidden = true;
    current.hidden = false;
  }

  function templateControls(onInsert) {
    const menu = document.createElement("details");
    menu.className = "editor-menu wiki-template-menu";
    const trigger = document.createElement("summary");
    trigger.textContent = "Insert form";
    const choices = document.createElement("div");
    choices.className = "editor-menu-content";
    for (const [name, template] of Object.entries(wikiTemplates)) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = template.label;
      button.addEventListener("click", () => {
        menu.open = false;
        onInsert(name);
      });
      choices.append(button);
    }
    menu.append(trigger, choices);
    return menu;
  }

  function appendTemplate(body, templateName) {
    const template = wikiTemplates[templateName];
    if (!template) return;
    const separator = body.value.trim() ? "\n\n---\n\n" : "";
    const start = body.value.length + separator.length;
    body.dispatchEvent(new CustomEvent("verwrity-textarea-before-edit", { detail: { start: body.value.length, end: body.value.length } }));
    body.value += separator + template.body;
    body.focus();
    body.setSelectionRange(start, body.value.length);
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function editPage(page, insertTemplateName = "", instructionState = null, focus = true) {
    aiControls?.cancelRequest();
    authorshipEditor?.destroy();
    current.hidden = true;
    editor.hidden = false;
    editingChrome(true);
    editor.replaceChildren();
    const form = document.createElement("form");
    form.method = "post"; form.action = `/wiki/page/${encodeURIComponent(page.id)}/save`;
    form.dataset.wikiSave = "true";
    for (const [name, value] of [["page_hash", page.page_hash], ["expected_project_id", document.querySelector("[data-workspace]")?.dataset.projectId]]) {
      const input = document.createElement("input"); input.type = "hidden"; input.name = name; input.value = value || ""; form.append(input);
    }
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Page title";
    const title = document.createElement("input");
    title.name = "title"; title.required = true; title.maxLength = 200; title.value = page.title;
    titleLabel.append(title);
    const tagsLabel = document.createElement("label"); tagsLabel.textContent = "Tags (comma-separated)";
    const tags = document.createElement("input"); tags.name = "tags"; tags.maxLength = 2000; tags.value = page.tags;
    tagsLabel.append(tags);
    const aliasesLabel = document.createElement("label"); aliasesLabel.textContent = "Alternative titles (comma-separated)";
    const aliases = document.createElement("input"); aliases.name = "aliases"; aliases.maxLength = 2000; aliases.value = page.aliases.join(", ");
    aliasesLabel.append(aliases);
    const aliasesHelp = document.createElement("small"); aliasesHelp.textContent = 'Alternative titles make names such as “Mara” and “Mara Vale” resolve to the same page.'; aliasesLabel.append(aliasesHelp);
    const purposeLabel = document.createElement("label"); purposeLabel.textContent = "Page purpose (for AI reviews)";
    const purpose = document.createElement("textarea"); purpose.name = "purpose"; purpose.rows = 2;
    purpose.id = `wiki-edit-purpose-${page.id}`; purposeLabel.htmlFor = purpose.id;
    purpose.maxLength = 2000; purpose.value = page.purpose || ""; purposeLabel.append(purpose);
    const bodyLabel = document.createElement("label");
    bodyLabel.textContent = "Page content";
    const body = document.createElement("textarea");
    body.name = "body"; body.rows = 14; body.maxLength = 100000; body.value = page.body;
    body.dataset.dictationInput = "wiki";
    bodyLabel.append(body);
    const help = document.createElement("p");
    help.className = "wiki-editor-help";
    help.textContent = "Use [[Page title]] or [[Page title|link text]] for wiki links; [source](https://example.com) for external links; # headings; - bullets or 1. numbered lists; > quotations; **bold**, *italic*, and `code` spans.";
    const tools = document.createElement("div"); tools.className = "wiki-editor-tools";
    const authorshipHelp = document.createElement("p"); authorshipHelp.className = "wiki-editor-help";
    authorshipHelp.textContent = "Dotted boxes mark text the AI may update. If you edit an AI paragraph, it will automatically be adopted as if it was written by a human.";
    const ownershipLegend = document.createElement("p"); ownershipLegend.className = "wiki-authorship-legend";
    const humanKey = document.createElement("span"); humanKey.className = "wiki-human-text";
    humanKey.textContent = "Human / adopted · protected";
    const aiKey = document.createElement("span"); aiKey.className = "wiki-ai-text";
    aiKey.textContent = "AI-maintained · may be updated";
    ownershipLegend.append(humanKey, aiKey);
    const selectionHelp = document.createElement("p"); selectionHelp.className = "wiki-editor-help"; selectionHelp.textContent = "Select a paragraph to choose whether to allow AI modification.";
    authorshipEditor = attachWikiAuthorship(body, page, form);
    const ownershipStatus = document.createElement("p"); ownershipStatus.className = "wiki-editor-help";
    ownershipStatus.setAttribute("role", "status");
    for (const [label, enabled] of [["Mark as AI maintained", true], ["Mark as human owned / protected", false]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      button.addEventListener("click", () => {
        ownershipStatus.textContent = authorshipEditor.setMaintenance(enabled)
          ? (enabled ? "Marked as AI maintained." : "Marked as human owned / protected.")
          : "Select some page text first.";
      }); tools.append(button);
    }
    const addHuman = document.createElement("button"); addHuman.type = "button"; addHuman.textContent = "Add human paragraph";
    addHuman.addEventListener("click", () => {
      ownershipStatus.textContent = authorshipEditor.insertParagraph()
        ? "" : "The page has reached its text limit.";
    }); tools.append(addHuman);
    const microphone = document.createElement("button");
    microphone.type = "button"; microphone.className = "dictation-button";
    microphone.dataset.dictationTarget = "wiki"; microphone.textContent = "🎙";
    microphone.setAttribute("aria-label", "Start wiki dictation"); microphone.title = "Start wiki dictation";
    tools.append(microphone);
    const insertLink = document.createElement("button"); insertLink.type = "button"; insertLink.textContent = "Insert link…";
    insertLink.addEventListener("click", async () => {
      const start = body.selectionStart; const end = body.selectionEnd;
      const target = await window.verwrityDialog?.prompt("Page title to link to", {
        title: "Insert wiki link", label: "Page title", acceptLabel: "Insert link", maxLength: 200,
      });
      if (!target?.trim()) return;
      const linkText = `[[${target.trim()}]]`;
      body.dispatchEvent(new CustomEvent("verwrity-textarea-before-edit", { detail: { start, end } }));
      body.setRangeText(linkText, start, end, "end"); body.focus();
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const previewButton = document.createElement("button"); previewButton.type = "button"; previewButton.textContent = "Preview";
    const preview = document.createElement("div"); preview.className = "wiki-preview"; preview.hidden = true;
    previewButton.addEventListener("click", () => {
      preview.hidden = !preview.hidden;
      previewButton.textContent = preview.hidden ? "Preview" : "Hide preview";
      if (!preview.hidden) renderWikiBody(preview, body.value, pages, authorshipEditor.annotations());
    });
    body.addEventListener("input", () => { if (!preview.hidden) renderWikiBody(preview, body.value, pages, authorshipEditor.annotations()); });
    body.addEventListener("verwrity-wiki-ownership-change", () => {
      if (!preview.hidden) renderWikiBody(preview, body.value, pages, authorshipEditor.annotations());
      window.verwrityMarkProjectChanged?.();
    });
    tools.append(insertLink, previewButton, templateControls((templateName) => appendTemplate(body, templateName)), microphone);
    const actions = document.createElement("div"); actions.className = "wiki-page-actions";
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save page";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel edit";
    cancel.addEventListener("click", () => open(pages.find(item => item.id === page.id) || page));
    actions.append(cancel, save);
    form.append(titleLabel, aliasesLabel, tagsLabel, purposeLabel, authorshipHelp, ownershipLegend, selectionHelp, bodyLabel, tools, ownershipStatus, preview, help, actions);
    async function saveSnapshot(signal) {
      if (!form.reportValidity()) throw new Error("Complete the page title before running an instruction.");
      if (await window.verwritySaveActiveScene?.() === false) throw new Error("Save the current scene successfully first.");
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      authorshipEditor.sync();
      const snapshot = new FormData(form), ownership = authorshipEditor;
      const fields = [...form.querySelectorAll("input, textarea, button")];
      const disabled = fields.map(field => field.disabled);
      fields.forEach(field => { field.disabled = true; });
      try {
        // Finish the local save even if generation is cancelled, so the editor
        // knows its committed hash and can safely save again.
        const response = await fetch(`${form.action}?response=json`, { method: "POST", headers: { Accept: "application/json" }, body: snapshot });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Your edits could not be saved. Keep the buffer and retry.");
        Object.assign(page, data, { tags: data.tags.join(", ") });
        Object.assign(pages.find(item => item.id === page.id), page);
        form.elements.page_hash.value = page.page_hash;
        title.value = page.title; aliases.value = page.aliases.join(", "); tags.value = page.tags;
        ownership.reset(page);
        window.verwrityMarkProjectChanged?.();
      } finally { fields.forEach((field, index) => { field.disabled = disabled[index]; }); }
    }
    form.savePending = () => saveSnapshot();
    const updateEditor = (data, report = "", instruction = "", request = null) => {
      const state = request ? { instruction, request } : aiControls.snapshot();
      Object.assign(page, data, { tags: data.tags.join(", ") });
      editPage(page, "", state);
      if (report) {
        const status = document.createElement("p"); status.className = "wiki-ai-status"; status.setAttribute("role", "status");
        status.textContent = report; editor.append(status);
      }
    };
    aiControls = wikiInstruction(page, saveSnapshot, updateEditor);
    if (instructionState) aiControls.restore(instructionState.instruction, instructionState.request);
    const review = wikiAIReview(page, updateEditor, async () => {
      if (form.elements.body.disabled) return false;
      authorshipEditor.sync();
      const changed = body.value !== page.body || title.value !== page.title || purpose.value !== page.purpose
        || tags.value !== page.tags || aliases.value !== page.aliases.join(", ")
        || JSON.parse(form.elements.authorship_edits.value).length;
      if (changed) {
        await window.verwrityDialog?.alert("Save your page edits before accepting or dismissing a suggestion."); return false;
      }
      aiControls.cancelRequest();
      const fields = [...form.querySelectorAll("input, textarea, button"),
        ...aiControls.querySelectorAll("input, textarea, select, button")];
      const disabled = fields.map(field => field.disabled);
      fields.forEach(field => { field.disabled = true; });
      return () => fields.forEach((field, index) => { field.disabled = disabled[index]; });
    });
    // Author input invalidates pending results; the buffer stays editable.
    const instructionControl = aiControls;
    form.addEventListener("input", () => instructionControl.cancelRequest());
    body.addEventListener("verwrity-wiki-ownership-change", () => instructionControl.cancelRequest());
    editor.append(form, aiControls, review);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      authorshipEditor.sync();
      if (form.reportValidity()) saveSceneThenSubmit(form);
    });
    const suggestPurpose = document.createElement("button"); suggestPurpose.type = "button"; suggestPurpose.textContent = "Suggest purpose (AI)";
    const purposeHeading = document.createElement("span"); purposeHeading.className = "wiki-purpose-heading";
    const purposeTitle = document.createElement("span"); purposeTitle.textContent = "Page purpose";
    purposeHeading.append(purposeTitle, suggestPurpose); purposeLabel.replaceChildren(purposeHeading, purpose);
    suggestPurpose.addEventListener("click", async () => {
      suggestPurpose.disabled = true;
      const before = purpose.value;
      const snapshot = [title.value, aliases.value, tags.value, body.value];
      try {
        if (await window.verwritySaveActiveScene?.() === false) return;
        const result = await post(`/ai/wiki/${page.id}`, { action: "suggest", purpose: before, page_hash: page.page_hash });
        if (!form.isConnected || purpose.value !== before || JSON.stringify(snapshot) !== JSON.stringify([title.value, aliases.value, tags.value, body.value])) return;
        purpose.value = result.purpose; purpose.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) { ownershipStatus.textContent = error.message; }
      finally { suggestPurpose.disabled = false; }
    });
    body.addEventListener("contextmenu", event => {
      if (event.shiftKey || body.selectionStart === body.selectionEnd) return;
      event.preventDefault();
      const menu = document.createElement("div"); menu.className = "wiki-ownership-menu"; menu.setAttribute("role", "menu");
      menu.style.left = `${Math.min(event.clientX, innerWidth - 260)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 100)}px`;
      for (const action of [...tools.querySelectorAll("button")].slice(0, 2)) {
        const choice = document.createElement("button"); choice.type = "button"; choice.textContent = action.textContent;
        choice.setAttribute("role", "menuitem"); choice.onmousedown = e => e.preventDefault(); choice.onclick = () => { action.click(); dismiss(); }; menu.append(choice);
      }
      const dismiss = () => { menu.remove(); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
      const outside = e => { if (!menu.contains(e.target)) dismiss(); };
      const escape = e => { if (e.key === "Escape") dismiss(); };
      editor.append(menu); document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    });
    authorshipEditor.refresh();
    if (focus) title.focus();
    if (insertTemplateName) appendTemplate(body, insertTemplateName);
  }

  function showHistory(page) {
    aiControls?.cancelRequest();
    authorshipEditor?.destroy(); authorshipEditor = null;
    current.dataset.view = "history";
    current.replaceChildren();
    const heading = document.createElement("h2"); heading.textContent = `History: ${page.title}`; current.append(heading);
    const back = document.createElement("button"); back.className = "panel-toggle"; back.type = "button"; back.textContent = "Back to page";
    back.addEventListener("click", () => open(page)); current.append(back);
    const list = document.createElement("ol"); list.className = "wiki-history-list";
    [...page.revisions].reverse().forEach((revision, index) => {
      const item = document.createElement("li");
      const title = document.createElement("strong"); title.textContent = revision.title; item.append(title);
      const date = document.createElement("time"); date.textContent = revision.savedAt ? new Date(revision.savedAt).toLocaleString() : "Earlier version";
      if (revision.savedAt) date.dateTime = revision.savedAt;
      item.append(date);
      const summary = document.createElement("p"); summary.textContent = revision.body.slice(0, 180) || "Empty page"; item.append(summary);
      const record = revision.world;
      if ((record?.kind === "character" && window.verwrityWorld?.characterEnabled) || (record?.kind === "location" && window.verwrityWorld?.mapEnabled)) {
        const detail = document.createElement("p");
        detail.textContent = record.kind === "character"
          ? `Character sheet · ${record.character.character_id}${record.character.combat ? ` · Might ${record.character.combat.might}, agility ${record.character.combat.agility}, resolve ${record.character.combat.resolve}` : ""}`
          : `Map location · ${record.location.location_id} · ${record.location.x}, ${record.location.y}`;
        item.append(detail);
      }
      const view = document.createElement("button"); view.type = "button"; view.textContent = "View this version";
      const content = document.createElement("div"); content.className = "wiki-page-body"; content.hidden = true;
      view.onclick = () => { content.hidden = !content.hidden; view.textContent = content.hidden ? "View this version" : "Hide this version"; if (!content.hidden) renderWikiBody(content, revision.body, pages); };
      item.append(view, content);
      const restore = document.createElement("form"); restore.method = "post";
      restore.action = `/wiki/page/${encodeURIComponent(page.id)}/restore/${encodeURIComponent(revision.id)}`;
      const button = document.createElement("button"); button.type = "submit"; button.textContent = "Restore this version";
      restore.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (await window.verwrityDialog?.confirm(`Restore version ${page.revisions.length - index} of “${page.title}”? The current page will remain in history.`, {
          title: "Restore wiki page version", acceptLabel: "Restore version",
        })) saveSceneThenSubmit(restore);
      });
      restore.append(button); item.append(restore); list.append(item);
    });
    current.append(list); editor.hidden = true; current.hidden = false;
  }

  panel.addEventListener("click", (event) => {
    const createLink = event.target.closest("[data-wiki-create-title]");
    if (createLink) {
      const form = panel.querySelector("[data-wiki-create-form]");
      form.querySelector("input[name='title']").value = createLink.dataset.wikiCreateTitle;
      form.requestSubmit();
      return;
    }
    const button = event.target.closest("[data-wiki-page-id]");
    if (!button) return;
    const page = pages.find((candidate) => candidate.id === button.dataset.wikiPageId);
    if (page) requestOpen(page);
  });
  panel.querySelector("[data-wiki-new]")?.addEventListener("click", async () => {
    if (!(await canNavigate())) return;
    const title = await window.verwrityDialog?.prompt("New wiki page title", {
      title: "New wiki page", label: "Page title", acceptLabel: "Create page", maxLength: 200,
    });
    if (!title?.trim()) return;
    const form = panel.querySelector("[data-wiki-create-form]");
    form.querySelector("input[name='title']").value = title;
    form.requestSubmit();
  });
  panel.querySelector("[data-wiki-create-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSceneThenSubmit(event.currentTarget);
  });
  function findPageMatch(page, query) {
    const fields = [
      { rank: 0, kind: "title", values: [page.title] },
      { rank: 1, kind: "alias", values: page.aliases },
      { rank: 2, kind: "tag", values: page.tags.split(",").map((tag) => tag.trim()).filter(Boolean) },
      { rank: 3, kind: "body", values: [page.body] },
    ];
    for (const field of fields) {
      const value = field.values.find((candidate) => candidate.toLocaleLowerCase().includes(query));
      if (value !== undefined) return { rank: field.rank, kind: field.kind, value };
    }
    return null;
  }

  function appendHighlightedText(host, text, query) {
    const loweredText = text.toLocaleLowerCase();
    let cursor = 0;
    let matchIndex = loweredText.indexOf(query, cursor);
    while (matchIndex >= 0) {
      host.append(document.createTextNode(text.slice(cursor, matchIndex)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(matchIndex, matchIndex + query.length);
      host.append(mark);
      cursor = matchIndex + query.length;
      matchIndex = loweredText.indexOf(query, cursor);
    }
    host.append(document.createTextNode(text.slice(cursor)));
  }

  function highlightTextNodes(host, query) {
    const textNodes = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    for (const node of textNodes) {
      if (!node.nodeValue.toLocaleLowerCase().includes(query)) continue;
      const fragment = document.createDocumentFragment();
      appendHighlightedText(fragment, node.nodeValue, query);
      node.replaceWith(fragment);
    }
  }

  function renderSearchMatch(item, page, match, query) {
    const titleButton = item.querySelector("[data-wiki-page-id]");
    if (!titleButton || !page) return;
    titleButton.replaceChildren();
    if (match.kind === "title") appendHighlightedText(titleButton, page.title, query);
    else titleButton.textContent = page.title;
    item.querySelector(".wiki-search-match")?.remove();
    if (match.kind === "title") return;

    const detail = document.createElement("span");
    detail.className = "wiki-search-match";
    const label = { alias: "Alias: ", tag: "Tag: ", body: "Text: " }[match.kind];
    detail.append(document.createTextNode(label));
    let excerpt = match.value;
    if (match.kind === "body") {
      const normalizedBody = page.body.replace(/\s+/g, " ").trim();
      const index = normalizedBody.toLocaleLowerCase().indexOf(query);
      const start = Math.max(0, index - 48);
      const end = Math.min(normalizedBody.length, index + query.length + 48);
      if (start > 0) detail.append(document.createTextNode("…"));
      excerpt = normalizedBody.slice(start, end);
      appendHighlightedText(detail, excerpt, query);
      if (end < normalizedBody.length) detail.append(document.createTextNode("…"));
    } else {
      appendHighlightedText(detail, excerpt, query);
    }
    item.append(detail);
  }

  function comparePagesByTitle(left, right) {
    return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  }

  function updateSearch() {
    const query = search.value.trim().toLocaleLowerCase();
    const pageList = panel.querySelector(".wiki-page-list");
    pageList.hidden = !query;
    const items = [...list.querySelectorAll("li")];
    if (!query) {
      for (const item of items) {
        item.hidden = false;
        item.querySelector(".wiki-search-match")?.remove();
        const titleButton = item.querySelector("[data-wiki-page-id]");
        const page = pages.find((candidate) => candidate.id === titleButton?.dataset.wikiPageId);
        if (titleButton && page) titleButton.textContent = page.title;
      }
      items.sort((left, right) => {
        const leftPage = pages.find((page) => page.id === left.querySelector("[data-wiki-page-id]")?.dataset.wikiPageId);
        const rightPage = pages.find((page) => page.id === right.querySelector("[data-wiki-page-id]")?.dataset.wikiPageId);
        return leftPage && rightPage ? comparePagesByTitle(leftPage, rightPage) : 0;
      });
      list.append(...items);
      panel.querySelector("[data-wiki-no-results]").hidden = true;
      panel.querySelector("[data-wiki-empty]").hidden = true;
      if (currentPage && current.dataset.view === "page" && !current.hidden) open(currentPage);
      return;
    }
    const matches = [];
    for (const item of items) {
      const pageId = item.querySelector("[data-wiki-page-id]")?.dataset.wikiPageId;
      const page = pages.find((candidate) => candidate.id === pageId);
      const match = page ? findPageMatch(page, query) : (item.textContent.toLocaleLowerCase().includes(query) ? { rank: 4, kind: "title", value: item.textContent } : null);
      item.hidden = !match;
      if (match) {
        renderSearchMatch(item, page, match, query);
        matches.push({ item, page, match });
      } else {
        item.querySelector(".wiki-search-match")?.remove();
        const titleButton = item.querySelector("[data-wiki-page-id]");
        if (titleButton && page) titleButton.textContent = page.title;
      }
    }
    matches.sort((left, right) => left.match.rank - right.match.rank || (left.page && right.page ? comparePagesByTitle(left.page, right.page) : 0));
    list.append(...matches.map((entry) => entry.item));
    panel.querySelector("[data-wiki-no-results]").hidden = matches.length > 0;
    panel.querySelector("[data-wiki-empty]").hidden = pages.length > 0 || Boolean(query);
    if (currentPage && current.dataset.view === "page" && !current.hidden) open(currentPage);
  }
  search?.addEventListener("input", updateSearch);
  updateSearch();
  window.addEventListener("verwrity-wiki-page-updated", (event) => {
    const data = event.detail;
    if (!data?.id) return;
    let page = pages.find((candidate) => candidate.id === data.id);
    if (!page) {
      page = { ...data, aliases: data.aliases || [], tags: (data.tags || []).join(", "), revisions: data.revisions || [], template: null };
      pages.push(page);
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button"; button.className = "wiki-link"; button.dataset.wikiPageId = page.id; button.textContent = page.title;
      const template = document.createElement("template");
      template.dataset.wikiPage = page.id; template.dataset.title = page.title; template.dataset.aliases = page.aliases.join(", ");
      template.dataset.bodyJson = JSON.stringify(page.body); template.dataset.tags = page.tags;
      item.append(button, template); list.append(item);
      page.template = template;
    } else {
      Object.assign(page, data, { tags: (data.tags || []).join(", ") });
      page.template?.setAttribute("data-body-json", JSON.stringify(page.body));
      const button = list.querySelector(`[data-wiki-page-id="${CSS.escape(page.id)}"]`);
      if (button) button.textContent = page.title;
    }
    updateSearch();
    if (data.open !== false) requestOpen(page);
  });
  window.addEventListener("verwrity-open-wiki-page", (event) => {
    const page = pages.find((candidate) => candidate.id === event.detail);
    if (!page) return;
    if (panel.hidden) document.querySelector('[data-panel-toggle="wiki"]')?.click();
    requestOpen(page);
  });
  function invalidateWikiReview() {
    aiControls?.cancelRequest();
    if (pages.every(page => page.source_hash === "stale")) return;
    for (const page of pages) page.source_hash = "stale";
    if (currentPage && current.dataset.view === "page" && !current.hidden) {
      renderWikiBody(current.querySelector(".wiki-page-body"), currentPage.body, pages, visibleAnnotations(currentPage));
      current.querySelector(".wiki-ai-review")?.replaceWith(wikiAIReview(currentPage, (data) => {
        Object.assign(currentPage, data, { tags: (data.tags || []).join(", ") }); open(currentPage);
      }));
    }
  }
  window.addEventListener("verwrity-editor-change", invalidateWikiReview);
  window.addEventListener("verwrity-scene-metadata-changed", invalidateWikiReview);
  window.addEventListener("verwrity-editor-source-changed", invalidateWikiReview);
  const savedWiki = navigation.read();
  const requestedPage = new URL(location.href).searchParams.get('wiki_page');
  const savedPage = (!requestedPage || requestedPage === savedWiki?.pageId) && pages.find(page => page.id === savedWiki?.pageId);
  if (savedPage) {
    const page = savedWiki.editing && savedPage.page_hash !== savedWiki.base.page_hash ? { ...savedPage, ...savedWiki.base } : savedPage;
    open(page);
    if (savedWiki.editing) {
      editPage(page, '', savedWiki.instruction, false);
      const form = editor.querySelector('[data-wiki-save]'), body = form.elements.body;
      for (const [name, value] of Object.entries(savedWiki.fields)) form.elements[name].value = value;
      authorshipEditor.restore(savedWiki.ownership);
      body.setSelectionRange(...savedWiki.selection);
      aiControls.open = savedWiki.instructionOpen;
      if (hasPending()) window.verwrityMarkProjectChanged?.();
    }
    requestAnimationFrame(() => {
      panel.scrollTop = savedWiki.panelScroll; editor.scrollTop = savedWiki.editorScroll;
      panel.querySelector('[data-wiki-content]').scrollTop = savedWiki.contentScroll;
      const body = editor.querySelector('[name=body]'); if (body) body.scrollTop = savedWiki.bodyScroll;
    });
  } else open(pages.find((page) => page.id === panel.dataset.initialPage));
}
