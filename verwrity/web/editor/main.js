import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { PaginationPlus } from "tiptap-pagination-plus";
import { WritingView } from "./writing-view";
import { writingPosition } from "./writing-position";
import { EditingFormat, editingFormatControls } from "./editing-format";
import { contextTarget } from "./thesaurus";
import {
  AnnotationExtension, AnnotationTooltipExtension, annotationPluginKey, CommentExtension, commentPluginKey, commentsForEditor,
  TextAnalysisExtension, textAnalysisPluginKey, DialogueExtension, dialoguePluginKey,
  PassageHighlightExtension, passageHighlightPluginKey, positionsForSourceRange,
  SearchExtension, searchPluginKey, sourceOffsetsForPositions, sourceOffsetForCaret, WikiLinkExtension, wikiLinkPluginKey,
} from "./annotations";

const root = document.querySelector("[data-rich-editor]");
const sceneId = root?.dataset.sceneId;
root?.addEventListener("click", (event) => {
  const link = event.target.closest?.(".verwrity-wiki-link[data-wiki-page-id]");
  if (link) window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", { detail: link.dataset.wikiPageId }));
});
const initialText = root?.dataset.initialText || "";
const passageToggle = document.querySelector("[data-toggle-ai-highlight]");
function updatePassageToggle(instance) {
  if (!passageToggle) return;
  const state = passageHighlightPluginKey.getState(instance.state);
  passageToggle.hidden = !state?.decorations.find().length;
  passageToggle.setAttribute("aria-pressed", String(Boolean(state?.enabled)));
  passageToggle.title = state?.enabled ? "Hide AI passage highlighting" : "Show AI passage highlighting";
}
const wikiPages = [...document.querySelectorAll("[data-wiki-page-id]")].map((element) => ({
  id: element.dataset.wikiPageId,
  title: element.textContent.trim(),
  aliases: [],
}));
document.querySelectorAll("template[data-wiki-page]").forEach((template) => {
  const page = wikiPages.find((candidate) => candidate.id === template.dataset.wikiPage);
  if (page) page.aliases = (template.dataset.aliases || "").split(",").map((value) => value.trim()).filter(Boolean);
});
let writingView;
let initialComments = [];
try { initialComments = JSON.parse(root?.dataset.initialComments || "[]"); } catch (_) { initialComments = []; }
let annotationOptions = {
  spelling: { enabled: false, style: "squiggly", color: "#ef4444" },
  wiki_links: { enabled: false, style: "underline", color: "#4f8fba" },
  comments: { enabled: false, style: "underline", color: "#8b72c7" },
  dialogue: { enabled: false, style: "underline", color: "#0d9488" },
};
let typewriterMode = document.querySelector("[data-workspace]")?.dataset.typewriterMode === "true";
let caretMovementEnabled = false;
let dictationSourceGeneration = 0;

const cursorMovementKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Delete"]);
function handleTypewriterKeyDown(_view, event) {
  if (!typewriterMode || caretMovementEnabled) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const undoOrSelectionShortcut = (event.ctrlKey || event.metaKey) && ["a", "z", "y"].includes(key);
  if (!cursorMovementKeys.has(event.key) && !undoOrSelectionShortcut) return false;
  event.preventDefault();
  return true;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function textToHtml(text) {
  if (!text) return "<p></p>";
  // Keep every paragraph boundary, including empty paragraphs. A run of blank
  // lines is manuscript content (important for poetry and scripts), not a
  // formatting detail to normalize away.
  return text.replaceAll("\r\n", "\n").split("\n\n")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`).join("");
}

const editor = new Editor({
  editable: Boolean(sceneId),
  parseOptions: { preserveWhitespace: "full" },
  onTransaction: ({ editor: instance, transaction }) => {
    if (transaction.docChanged) dictationSourceGeneration++;
    updatePassageToggle(instance);
  },
  element: root,
  extensions: [
    StarterKit.configure({
      bold: false,
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      orderedList: false,
      strike: false,
    }),
    PaginationPlus.configure({
      enabled: false,
      contentMarginTop: 0,
      contentMarginBottom: 0,
      // This is display-only pagination supplied by the current paper layout.
      // It never enters the ProseMirror document or the saved manuscript.
      footerRight: "{page} / <span class=\"verwrity-page-word-count\" title=\"Words on this page\"></span> / <span class=\"verwrity-scene-word-count\" title=\"Words in this scene\"></span>",
    }),
    AnnotationExtension,
    EditingFormat,
    TextAnalysisExtension,
    WikiLinkExtension,
    CommentExtension,
    DialogueExtension,
    AnnotationTooltipExtension,
    SearchExtension,
    PassageHighlightExtension,
  ],
  content: textToHtml(initialText),
  editorProps: {
    handleScrollToSelection: () => writingView?.scrollToSelection() || false,
    handleKeyDown: handleTypewriterKeyDown,
    handleClick: () => typewriterMode && !caretMovementEnabled,
    handleDOMEvents: {
      mousedown: (view, event) => {
        if (!typewriterMode || caretMovementEnabled) return false;
        event.preventDefault();
        view.focus();
        return true;
      },
    },
    attributes: {
      class: "tiptap-content",
      role: "textbox",
      "aria-label": "Manuscript editor",
      "aria-multiline": "true",
      // Browser dictionaries cannot use Verwrity's project/user dictionary.
      // Keep spelling annotations owned by the server-side analysis layer.
      spellcheck: "false",
    },
  },
  onCreate: () => {
    // The pagination extension installs its styles on create; configure afterwards.
    writingView = new WritingView(editor, root.closest(".manuscript"));
    editor.view.dispatch(editor.state.tr.setMeta(wikiLinkPluginKey, { items: wikiPages, ...annotationOptions.wiki_links }));
    editor.view.dispatch(editor.state.tr.setMeta(commentPluginKey, { items: initialComments, ...annotationOptions.comments }));
    const passageStart = Number(root.dataset.aiPassageStart);
    const passageEnd = Number(root.dataset.aiPassageEnd);
    const hasPassage = Number.isInteger(passageStart) && Number.isInteger(passageEnd) && passageEnd > passageStart;
    const position = writingPosition(editor, writingView.viewport,
      document.querySelector("[data-workspace]")?.dataset.projectId, sceneId);
    const restored = !hasPassage && !typewriterMode && position.restore();
    if (!restored && !document.querySelector("#start-dialog[open], [data-recovery-dialog][open]")) editor.commands.focus(typewriterMode ? "end" : "start");
    if (hasPassage) {
      const range = positionsForSourceRange(editor.state.doc, passageStart, passageEnd);
      if (range) {
        editor.view.dispatch(editor.state.tr.setMeta(passageHighlightPluginKey, { start: passageStart, end: passageEnd }));
        editor.commands.setTextSelection(range);
        editor.commands.scrollIntoView();
      }
    }
    window.dispatchEvent(new CustomEvent("verwrity-editor-ready"));
  },
});

passageToggle?.addEventListener("click", () => {
  const state = passageHighlightPluginKey.getState(editor.state);
  if (state.enabled) {
    // Passage navigation also selects text. Remove that separate browser
    // highlight so switching decorations off removes every visible layer.
    editor.commands.setTextSelection(editor.state.selection.to);
    const selection = document.getSelection();
    if (selection?.anchorNode && editor.view.dom.contains(selection.anchorNode)) selection.removeAllRanges();
  }
  editor.view.dispatch(editor.state.tr.setMeta(passageHighlightPluginKey, { enabled: !state.enabled }));
});

function getText() {
  return editor.getText({ blockSeparator: "\n\n" });
}

function setAnnotations(annotations) {
  editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, { items: annotations || [], ...annotationOptions.spelling }));
}

function setWikiPages(pages) {
  editor.view.dispatch(editor.state.tr.setMeta(wikiLinkPluginKey, { items: pages || [], ...annotationOptions.wiki_links }));
}

function renderSpellingAnnotations() {
  editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, annotationOptions.spelling));
}

function setComments(comments, resetHistory = false) {
  editor.view.dispatch(editor.state.tr.setMeta(commentPluginKey, {
    items: comments || [], ...annotationOptions.comments, resetHistory,
  }));
  window.dispatchEvent(new Event("verwrity-comments-changed"));
}

function setAnnotationOptions(feature, options) {
  if (!(feature in annotationOptions)) return;
  annotationOptions[feature] = { ...annotationOptions[feature], ...options };
  if (feature === "spelling") renderSpellingAnnotations();
  else if (feature === "wiki_links") editor.view.dispatch(editor.state.tr.setMeta(wikiLinkPluginKey, { items: wikiPages, ...annotationOptions.wiki_links }));
  else if (feature === "dialogue") editor.view.dispatch(editor.state.tr.setMeta(dialoguePluginKey, annotationOptions.dialogue));
  else editor.view.dispatch(editor.state.tr.setMeta(commentPluginKey, annotationOptions.comments));
}

window.verwrityEditor = {
  getText,
  getContextTarget: (x, y) => contextTarget(editor, root, x, y,
    () => editor.isEditable && (!typewriterMode || caretMovementEnabled)),
  captureDictationTarget: () => {
    if (!editor.isEditable || !sceneId) return null;
    const doc = editor.state.doc;
    const generation = dictationSourceGeneration;
    const position = editor.state.selection.to;
    return {
      insert: (text) => {
        // Reject stale targets instead of replacing text edited while STT ran.
        if (!editor.isEditable || generation !== dictationSourceGeneration || !doc.eq(editor.state.doc) || !root.isConnected) return false;
        const before = doc.textBetween(Math.max(0, position - 1), position);
        const after = doc.textBetween(position, Math.min(doc.content.size, position + 1));
        const value = (/\S/u.test(before) ? " " : "") + text.replace(/\r\n?/gu, "\n") + (/\S/u.test(after) ? " " : "");
        const inlineContent = paragraph => Fragment.from(paragraph.split("\n").flatMap((line, index) => [
          ...(index ? [editor.schema.nodes.hardBreak.create()] : []),
          ...(line ? [editor.schema.text(line)] : []),
        ]));
        // Transcripts are literal text, never HTML. Open paragraph edges merge
        // with prose at the caret without adding unrequested paragraph breaks.
        const content = value.includes("\n\n")
          ? new Slice(Fragment.from(value.split("\n\n").map(paragraph =>
            editor.schema.nodes.paragraph.create(null, inlineContent(paragraph)))), 1, 1)
          : new Slice(inlineContent(value), 0, 0);
        const tr = closeHistory(editor.state.tr).replaceRange(position, position, content);
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(position, 1)), -1)).scrollIntoView();
        editor.view.dispatch(tr);
        editor.view.focus();
        return true;
      },
    };
  },
  setText: (text, comments = [], editable = true, dialogue = []) => {
    dictationSourceGeneration++;
    editor.commands.setContent(textToHtml(text), { emitUpdate: false, parseOptions: { preserveWhitespace: "full" } });
    setAnnotations([]);
    editor.setEditable(Boolean(editable), false);
    setComments(comments, true);
    editor.view.dispatch(editor.state.tr.setMeta(dialoguePluginKey, { items: dialogue, resetHistory: true }));
    window.dispatchEvent(new Event("verwrity-editor-source-changed"));
  },
  getCaretOffset: () => {
    const { from } = editor.state.selection;
    return sourceOffsetForCaret(editor.state.doc, from);
  },
  isEditable: () => editor.isEditable && (!typewriterMode || caretMovementEnabled),
  getDialogue: () => commentsForEditor(editor.state.doc, dialoguePluginKey.getState(editor.state)),
  setDialogue: (items, resetHistory = false) => editor.view.dispatch(editor.state.tr.setMeta(dialoguePluginKey, { items, resetHistory, ...annotationOptions.dialogue })),
  getSelectedRange: () => {
    const { from, to, empty } = editor.state.selection;
    return empty ? null : sourceOffsetsForPositions(editor.state.doc, from, to);
  },
  getComments: () => commentsForEditor(editor.state.doc, commentPluginKey.getState(editor.state)),
  setComments,
  setSearch: (query, caseSensitive = false) => editor.view.dispatch(editor.state.tr.setMeta(searchPluginKey, {
    query: query || "", caseSensitive: Boolean(caseSensitive),
  })),
  selectSourceRange: (start, end) => {
    const range = positionsForSourceRange(editor.state.doc, start, end);
    if (!range) return false;
    editor.commands.setTextSelection(range);
    editor.commands.scrollIntoView();
    return true;
  },
  highlightSourceRange: (start, end) => {
    const range = positionsForSourceRange(editor.state.doc, start, end);
    if (!range) return false;
    editor.view.dispatch(editor.state.tr.setMeta(passageHighlightPluginKey, { start, end }));
    editor.commands.setTextSelection(range);
    editor.commands.focus();
    editor.commands.scrollIntoView();
    return true;
  },
  clearPassageHighlight: () => editor.view.dispatch(editor.state.tr.setMeta(passageHighlightPluginKey, { clear: true })),
  highlightSourceQuote: (rawQuote, originalStart, originalEnd) => {
    window.verwrityEditor.clearPassageHighlight();
    const text = getText();
    const quote = rawQuote.replace(/\r\n?/g, "\n");
    if (!quote) return false;
    // Evidence offsets count Python code points; DOM/editor strings count UTF-16.
    const characters = Array.from(text);
    const original = characters.slice(originalStart, originalEnd).join("");
    const offset = original === quote
      ? characters.slice(0, originalStart).join("").length : text.indexOf(quote);
    if (offset < 0) return false;
    const start = Array.from(text.slice(0, offset)).length;
    return window.verwrityEditor.highlightSourceRange(start, start + Array.from(quote).length);
  },
  focus: () => editor.commands.focus(),
  captureViewPosition: () => {
    const viewport = writingView?.viewport;
    if (!viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    const point = editor.view.posAtCoords({ left: bounds.left + 16, top: bounds.top + 12 });
    return { pos: point?.pos, offset: point ? editor.view.coordsAtPos(point.pos).top - bounds.top : 0,
      top: viewport.scrollTop, left: viewport.scrollLeft };
  },
  restoreViewPosition: saved => {
    const viewport = writingView?.viewport;
    if (!viewport || !saved) return;
    viewport.scrollTop = Number.isFinite(saved.pos) && saved.pos <= editor.state.doc.content.size
      ? viewport.scrollTop + editor.view.coordsAtPos(saved.pos).top - viewport.getBoundingClientRect().top - saved.offset : saved.top;
    viewport.scrollLeft = saved.left;
  },
  setTypewriterMode: (enabled) => {
    typewriterMode = Boolean(enabled);
    caretMovementEnabled = false;
    if (typewriterMode && !editor.state.selection.empty) editor.commands.setTextSelection(editor.state.selection.to);
    editor.view.dom.focus({ preventScroll: true });
  },
  setCaretMovementEnabled: (enabled) => {
    caretMovementEnabled = typewriterMode && Boolean(enabled);
    editor.view.focus();
  },
  setAnnotations,
  setTextAnalysis: (id, options) => editor.view.dispatch(editor.state.tr.setMeta(textAnalysisPluginKey, { id, ...options })),
  getTextAnalysis: id => textAnalysisPluginKey.getState(editor.state)?.layers[id]?.items || [],
  setWikiPages,
  setAnnotationOptions,
  destroy: () => { writingView?.destroy(); editor.destroy(); },
  sceneId,
};

editor.on("update", () => {
  window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: getText() } }));
});

editingFormatControls(editor, () => window.verwrityEditor.isEditable());

try { window.verwrityEditor.setDialogue(JSON.parse(root?.dataset.initialDialogue || "[]").map(item => ({ ...item, speaker_name: wikiPages.find(page => page.id === item.speaker_id)?.title || "Unknown" })), true); } catch (_) { /* Invalid boot data is ignored. */ }
