const editor = document.querySelector("[data-rich-editor]");
const menu = document.querySelector("[data-wiki-selection-menu]");
const section = menu?.querySelector("[data-thesaurus]");
const form = section?.querySelector("form");
const input = section?.querySelector("input");
const results = section?.querySelector("[data-thesaurus-results]");
const status = section?.querySelector("[data-thesaurus-status]");
let target;
let controller;
let anchor = { x: 8, y: 8 };

function positionMenu() {
  menu.style.left = `${Math.max(8, Math.min(anchor.x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(anchor.y, innerHeight - menu.offsetHeight - 8))}px`;
}

function closeMenu() {
  controller?.abort();
  target = null;
  if (menu) menu.hidden = true;
}

async function lookup() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const snapshot = target;
  results.replaceChildren();
  status.textContent = "Looking up in the local thesaurus…";
  positionMenu();
  try {
    const response = await fetch("/thesaurus", {
      method: "POST", credentials: "same-origin", signal: request.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ word: input.value }),
    });
    const data = await response.json();
    if (request.signal.aborted || target !== snapshot || menu.hidden) return;
    if (!response.ok) throw new Error(data.error || "Thesaurus lookup failed.");
    status.textContent = !data.senses.length ? "No entry found. Try the base form or another spelling."
      : snapshot.canReplace ? "Open a sense below to see its synonyms."
      : "Lookup only. Return to the current draft or unlock the caret to replace text.";
    for (const sense of data.senses) {
      const group = document.createElement("details");
      const heading = document.createElement("summary");
      const part = { adj: "Adjective", adv: "Adverb", noun: "Noun", verb: "Verb" }[sense.part_of_speech] || sense.part_of_speech;
      heading.textContent = `${part} · ${sense.terms.slice(0, 3).map(term => term.text).join(", ")}`;
      group.append(heading);
      for (const relation of ["synonym", "similar term", "antonym", "related term", "generic term"]) {
        const terms = sense.terms.filter(term => term.relation === relation);
        if (!terms.length) continue;
        const label = document.createElement("p");
        label.className = "thesaurus-relation";
        label.textContent = { synonym: "Synonyms", "similar term": "Similar words", antonym: "Antonyms",
          "related term": "Related terms", "generic term": "Broader terms" }[relation];
        group.append(label);
        for (const term of terms) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = term.text;
          button.dataset.thesaurusTerm = term.text;
          button.dataset.relation = relation;
          button.disabled = !snapshot.canReplace;
          button.title = `Replace “${snapshot.range.quote}” with “${term.text}”`;
          button.addEventListener("click", () => {
            if (!snapshot.replace(term.text)) {
              status.textContent = "The target changed. Right-click the word again.";
              results.replaceChildren();
              return;
            }
            closeMenu();
          });
          group.append(button);
        }
      }
      results.append(group);
    }
    positionMenu();
  } catch (error) {
    if (!request.signal.aborted && target === snapshot && !menu.hidden) {
      status.textContent = error.message || "The local thesaurus is unavailable. Try again.";
      positionMenu();
    }
  }
}

editor?.addEventListener("contextmenu", (event) => {
  if (event.shiftKey) { closeMenu(); return; }
  if (!menu) return;
  const next = window.verwrityEditor?.getContextTarget(event.clientX, event.clientY);
  if (!next) { closeMenu(); return; }
  event.preventDefault();
  closeMenu();
  target = next;
  anchor = { x: event.clientX || 8, y: event.clientY || 8 };
  menu.hidden = false;
  menu.querySelector("[data-add-comment]").disabled = !next.canReplace;
  menu.querySelector("[data-create-wiki]").disabled = !next.canReplace;
  window.dispatchEvent(new CustomEvent("verwrity-context-opened", { detail: next }));
  const word = next.range.quote.trim();
  section.hidden = !/^[\p{L}\p{M}]+(?:['’ -][\p{L}\p{M}]+)*$/u.test(word) || word.length > 80;
  if (!section.hidden) {
    input.value = word;
    lookup();
  }
  positionMenu();
  if (!event.clientX && !event.clientY) {
    (section.hidden ? menu.querySelector("[data-close-context]") : input)?.focus();
  }
});
form?.addEventListener("submit", (event) => { event.preventDefault(); if (target) lookup(); });
results?.addEventListener("toggle", positionMenu, true);
menu?.querySelector("[data-close-context]")?.addEventListener("click", () => { closeMenu(); window.verwrityEditor?.focus(); });
document.addEventListener("mousedown", (event) => { if (menu && !menu.contains(event.target)) closeMenu(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu && !menu.hidden) {
    event.preventDefault();
    closeMenu();
    window.verwrityEditor?.focus();
  }
});
window.addEventListener("verwrity-editor-change", closeMenu);
window.addEventListener("verwrity-editor-source-changed", closeMenu);
window.addEventListener("resize", closeMenu);
editor?.addEventListener("scroll", closeMenu, true);
