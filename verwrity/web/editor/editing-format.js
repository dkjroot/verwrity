import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";

const key = new PluginKey("verwrityEditingFormat");
const storageKey = "verwrity-editing-format";
let preferences = { sentenceSpaces: "typed", indentation: true, sectionMarkers: false };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (["typed", "1", "2"].includes(saved?.sentenceSpaces)) preferences.sentenceSpaces = saved.sentenceSpaces;
  if (typeof saved?.indentation === "boolean") preferences.indentation = saved.indentation;
  if (typeof saved?.sectionMarkers === "boolean") preferences.sectionMarkers = saved.sectionMarkers;
} catch (_) { /* Optional browser preferences. */ }

function paragraphIndentation(text) {
  // Imported typography can use non-breaking, em or other horizontal spaces.
  // Newlines remain line boundaries, never indentation to remove.
  return /^[\t\p{Zs}]+/u.exec(text)?.[0] || "";
}

function ordinarySpaces(text) {
  return text.replace(/\p{Zs}/gu, " ");
}

function normalizePastedSpaces(slice) {
  function normalizeFragment(fragment) {
    const nodes = [];
    fragment.forEach(node => {
      nodes.push(node.isText ? node.type.schema.text(ordinarySpaces(node.text), node.marks)
        : node.isLeaf ? node : node.copy(normalizeFragment(node.content)));
    });
    return Fragment.fromArray(nodes);
  }
  // Covers rich HTML clipboard content as well as plain-text paste, without
  // flattening paragraphs, line breaks, tabs or repeated indentation spaces.
  return new Slice(normalizeFragment(slice.content), slice.openStart, slice.openEnd);
}

function paragraphDecorations(doc) {
  const decorations = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== "paragraph") return;
    const leading = paragraphIndentation(block.textContent);
    decorations.push(Decoration.node(offset, offset + block.nodeSize, {
      "data-paragraph-kind": leading ? "running" : "section",
      // A CSS glyph cannot become manuscript text, copied prose or an undo step.
      class: preferences.sectionMarkers && !leading && block.textContent.trim() ? "verwrity-section-start" : "",
    }));
    if (leading && !preferences.indentation) decorations.push(Decoration.inline(offset + 1, offset + 1 + leading.length, {
      class: "verwrity-hidden-indent",
    }));
  });
  return DecorationSet.create(doc, decorations);
}

export const EditingFormat = Extension.create({
  name: "verwrityEditingFormat",
  addProseMirrorPlugins() {
    return [new Plugin({
      key,
      state: {
        init: (_, state) => paragraphDecorations(state.doc),
        apply: (tr, previous) => tr.docChanged || tr.getMeta(key)
          ? paragraphDecorations(tr.doc) : previous,
      },
      props: {
        transformPasted: normalizePastedSpaces,
        decorations: state => key.getState(state),
        handleTextInput(view, from, to, text) {
          if (preferences.sentenceSpaces === "typed" || text !== " " || from !== to) return false;
          const before = view.state.doc.resolve(from).parent.textBetween(0, view.state.doc.resolve(from).parentOffset, "", "\n");
          if (/[.!?][”’"')\]]* +$/u.test(before)) return true;
          if (preferences.sentenceSpaces === "2" && /[.!?][”’"')\]]*$/u.test(before)) {
            view.dispatch(view.state.tr.insertText("  ", from, to));
            return true;
          }
          return false;
        },
      },
    })];
  },
});

export function editingFormatControls(editor, canEdit) {
  const spaces = document.querySelector("[data-sentence-spacing]");
  const indent = document.querySelector("[data-paragraph-indentation]");
  const markers = document.querySelector("[data-section-markers]");
  const status = document.querySelector("[data-editing-format-status]");
  if (!spaces || !indent) return;
  spaces.value = preferences.sentenceSpaces;
  indent.checked = preferences.indentation;
  if (markers) markers.checked = preferences.sectionMarkers;
  function savePreferences() {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch (_) { /* Optional. */ }
  }
  spaces.addEventListener("change", () => {
    preferences.sentenceSpaces = spaces.value;
    savePreferences();
    status.textContent = "Typing preference saved. Use Apply to change this scene's existing spaces.";
  });
  indent.addEventListener("change", () => {
    preferences.indentation = indent.checked;
    savePreferences();
    editor.view.dispatch(editor.state.tr.setMeta(key, true));
    status.textContent = indent.checked ? "Showing the paragraph indentation you typed." : "Indentation hidden. Paragraph types and source whitespace are preserved.";
  });
  markers?.addEventListener("change", () => {
    preferences.sectionMarkers = markers.checked;
    savePreferences();
    editor.view.dispatch(editor.state.tr.setMeta(key, true));
    status.textContent = markers.checked
      ? "A dim asterisk marks each non-empty fresh section. Running paragraphs have no marker."
      : "Section markers hidden.";
  });
  document.querySelector("[data-apply-sentence-spacing]")?.addEventListener("click", () => {
    if (!canEdit() || preferences.sentenceSpaces === "typed") return;
    let tr = closeHistory(editor.state.tr);
    const replacements = [];
    editor.state.doc.descendants((node, position) => {
      if (!node.isText) return;
      // Only horizontal sentence spaces are changed. Paragraph breaks, tabs,
      // indentation, decimal points and line endings stay untouched.
      const pattern = /[.!?][”’"')\]]*( +)(?=[\p{Lu}"“‘])/gu;
      for (const match of node.text.matchAll(pattern)) {
        const prefix = node.text.slice(0, match.index + 1);
        if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|etc)|\b\p{Lu})\.$/u.test(prefix)) continue;
        const end = position + match.index + match[0].length;
        const start = end - match[1].length;
        const value = " ".repeat(Number(preferences.sentenceSpaces));
        if (value !== match[1]) replacements.push({ start, end, value });
      }
    });
    for (const { start, end, value } of replacements.reverse()) tr.insertText(value, start, end);
    if (tr.docChanged) { editor.view.dispatch(tr); editor.view.dispatch(closeHistory(editor.state.tr)); }
    status.textContent = `${replacements.length} sentence spacing change${replacements.length === 1 ? "" : "s"}. Ctrl+Z undoes this action.`;
  });
  document.querySelector("[data-normalize-spaces]")?.addEventListener("click", () => {
    if (!canEdit()) return;
    const replacements = [];
    editor.state.doc.descendants((node, position) => {
      if (!node.isText) return;
      for (const match of node.text.matchAll(/\p{Zs}/gu)) {
        if (match[0] !== " ") replacements.push(position + match.index);
      }
    });
    let tr = closeHistory(editor.state.tr);
    for (const position of replacements.reverse()) tr.insertText(" ", position, position + 1);
    if (tr.docChanged) { editor.view.dispatch(tr); editor.view.dispatch(closeHistory(editor.state.tr)); }
    status.textContent = `${replacements.length} typographic space${replacements.length === 1 ? "" : "s"} converted to ordinary spaces. Ctrl+Z undoes this action.`;
    editor.view.focus();
  });
  for (const button of document.querySelectorAll("[data-mark-paragraph]")) button.addEventListener("click", () => {
    if (!canEdit()) return;
    const { $from } = editor.state.selection;
    const start = $from.start();
    const leading = paragraphIndentation($from.parent.textContent);
    const value = button.dataset.markParagraph === "running" ? "\t" : "";
    if (leading !== value) {
      editor.view.dispatch(closeHistory(editor.state.tr).insertText(value, start, start + leading.length));
      editor.view.dispatch(closeHistory(editor.state.tr));
    }
    status.textContent = value ? "Running paragraph: its source starts with a tab." : "Fresh section: no leading indentation.";
    editor.view.focus();
  });
  editor.view.dom.addEventListener("keydown", event => {
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && canEdit()) {
      const { $from, empty } = editor.state.selection;
      const prefix = $from.parent.textBetween(0, $from.parentOffset, "", "\n");
      if (empty && paragraphIndentation(prefix) === prefix) {
        event.preventDefault();
        editor.commands.insertContent("\t");
      }
    }
  });
}
