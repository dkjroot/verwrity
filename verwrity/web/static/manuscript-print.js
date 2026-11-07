const dialog = document.querySelector("#manuscript-print-dialog");
const form = dialog.querySelector("form");
const status = form.querySelector("[data-print-status]");
const submit = form.querySelector("[type=submit]");
const output = document.querySelector("#manuscript-print-output");
const pageMargins = document.createElement("style");
document.head.append(pageMargins);
const projectId = document.querySelector("[data-workspace]").dataset.projectId;
let scope, pending;

for (const button of document.querySelectorAll("[data-print-scope]")) {
  button.addEventListener("click", () => {
    scope = button.dataset.printScope;
    dialog.querySelector("h2").textContent = scope === "scene" ? "Print scene" : "Print manuscript";
    status.textContent = "";
    button.closest("dialog")?.close();
    button.closest("details")?.removeAttribute("open");
    dialog.showModal();
  });
}

dialog.querySelectorAll("[data-close-print]").forEach(button => {
  button.addEventListener("click", () => dialog.close());
});

dialog.addEventListener("close", () => {
  if (!dialog.open) pending?.abort();
});

function appendText(parent, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
}

function cssString(text) {
  return '"' + text.replace(/["\\\x00-\x1f\x7f]/g, character => `\\${character.codePointAt(0).toString(16)} `) + '"';
}

function renderPageMargins(title) {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date());
  pageMargins.textContent = `
    @page manuscript {
      @top-left { content: ${cssString(form.elements.print_date.checked ? date : "")}; }
      @top-right { content: ${cssString(form.elements.header_title.checked ? title : "")}; }
      @bottom-left { content: ""; }
      @bottom-right { content: ${form.elements.page_number.checked ? 'counter(page) " / " counter(pages)' : '""'}; }
    }
  `;
}

function renderPrintout(snapshot) {
  output.style.fontFamily = form.elements.font.value;
  output.style.fontSize = `${form.elements.size.value}pt`;
  output.style.lineHeight = form.elements.spacing.value;
  const indent = form.elements.indent.checked;
  const headings = form.elements.headings.checked;
  renderPageMargins(scope === "scene" ? snapshot.scenes[0].title : snapshot.title);
  output.replaceChildren();
  if (headings && scope === "manuscript") appendText(output, "h1", snapshot.title);
  for (const scene of snapshot.scenes) {
    const section = document.createElement("section");
    if (headings) appendText(section, scope === "scene" ? "h1" : "h2", scene.title);
    const text = scene.text.replace(/\r\n?/g, "\n").trimEnd();
    for (const paragraph of text ? text.split("\n\n") : []) {
      // Like the editor, treat a leading tab or horizontal space as a running paragraph marker.
      const marker = /^[\t\p{Zs}]+/u.exec(paragraph)?.[0] || "";
      const prose = document.createElement("p");
      prose.textContent = paragraph.slice(marker.length);
      if (indent && marker && prose.textContent.trim()) prose.classList.add("print-indent");
      section.append(prose);
    }
    output.append(section);
  }
}

function clearPrintout() {
  delete document.body.dataset.printingManuscript;
  pageMargins.textContent = "";
  output.replaceChildren();
}

window.addEventListener("afterprint", clearPrintout);

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (pending) return;
  if (document.querySelector(".is-revision-preview")) {
    status.textContent = "Return to the current scene before printing.";
    return;
  }
  const editor = window.verwrityEditor;
  const source = document.querySelector("[data-rich-editor]");
  if (source?.dataset.sceneId && !editor) {
    status.textContent = "The editor is still loading. Try again in a moment.";
    return;
  }
  const sceneId = editor?.sceneId;
  const text = editor?.getText();
  const controller = new AbortController();
  pending = controller;
  submit.disabled = true;
  status.textContent = "Preparing printout…";
  try {
    const response = await fetch("/project/print-snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Verwrity-Project-Id": projectId },
      body: JSON.stringify({ scope, scene_id: sceneId, source_hash: window.verwritySceneHash(), text }),
      signal: controller.signal,
    });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Could not prepare the printout.");
    if (!dialog.open || controller.signal.aborted) return;
    if (editor?.sceneId !== sceneId || editor?.getText() !== text || document.querySelector(".is-revision-preview")) {
      throw new Error("The editor changed while preparing the printout. Try again.");
    }
    renderPrintout(snapshot);
    document.body.dataset.printingManuscript = "true";
    dialog.close();
    window.print();
  } catch (error) {
    if (!controller.signal.aborted) {
      clearPrintout();
      status.textContent = error instanceof SyntaxError ? "Could not prepare the printout." : error.message;
    }
  } finally {
    pending = null;
    submit.disabled = false;
  }
});
