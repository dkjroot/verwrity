import { Extension } from "@tiptap/core";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export const annotationPluginKey = new PluginKey("verwrityAnnotations");
export const textAnalysisPluginKey = new PluginKey("verwrityTextAnalyses");
export const wikiLinkPluginKey = new PluginKey("verwrityWikiLinks");
export const commentPluginKey = new PluginKey("verwrityComments");
export const dialoguePluginKey = new PluginKey("verwrityDialogue");
export const searchPluginKey = new PluginKey("verwritySearch");
export const passageHighlightPluginKey = new PluginKey("verwrityAIPassageHighlight");

export const AnnotationTooltipExtension = Extension.create({
  name: "verwrityAnnotationTooltips",

  addProseMirrorPlugins() {
    let previousDoc, previousSets = [], previousDecorations = DecorationSet.empty;
    return [new Plugin({
      props: { decorations: (state) => {
        const sets = [
          annotationPluginKey.getState(state)?.decorations,
          textAnalysisPluginKey.getState(state)?.decorations,
          wikiLinkPluginKey.getState(state)?.decorations,
          commentPluginKey.getState(state)?.decorations,
          dialoguePluginKey.getState(state)?.decorations,
        ];
        if (state.doc === previousDoc && sets.every((set, index) => set === previousSets[index])) return previousDecorations;
        previousDoc = state.doc;
        previousSets = sets;
        previousDecorations = combinedAnnotationDecorations(state.doc, sets.flatMap(set => set?.find() || []));
        return previousDecorations;
      } },
    })];
  },
});

function combinedAnnotationDecorations(doc, annotations) {
  // Keep each feature's state independent, but render their tooltips together:
  // ProseMirror keeps only one title when decorations overlap. Split every
  // layer at shared boundaries so even nested spans retain all local feedback.
  const boundaries = new Map();
  annotations.forEach((decoration, order) => {
    const annotation = { decoration, order };
    for (const [position, kind] of [[decoration.from, "starts"], [decoration.to, "ends"]]) {
      if (!boundaries.has(position)) boundaries.set(position, { starts: [], ends: [] });
      boundaries.get(position)[kind].push(annotation);
    }
  });
  const positions = [...boundaries.keys()].sort((a, b) => a - b);
  const active = new Set(), decorations = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const from = positions[index], to = positions[index + 1];
    const boundary = boundaries.get(from);
    boundary.ends.forEach(annotation => active.delete(annotation));
    boundary.starts.forEach(annotation => active.add(annotation));
    const feedback = [...active].sort((a, b) => a.order - b.order);
    const title = feedback.map(({ decoration }) => decoration.type.attrs.title).filter(Boolean).join("\n\n");
    // Tiptap renders the original feature plugins in reverse extension order.
    // Retain their attribute/colour precedence while combining tooltip text.
    for (const { decoration } of [...feedback].reverse()) {
      decorations.push(Decoration.inline(from, to, { ...decoration.type.attrs, title }, decoration.spec));
    }
  }
  return DecorationSet.create(doc, decorations);
}

function sourceTextAndPositions(doc) {
  let text = "";
  const positions = [];
  let blockIndex = 0;
  doc.forEach((block, blockOffset) => {
    if (blockIndex > 0) text += "\n\n";
    blockIndex += 1;
    block.descendants((node, relativePosition) => {
      // descendants() positions are relative to the block's content, so add
      // the block's opening token to match ProseMirror document positions.
      const documentPosition = blockOffset + 1 + relativePosition;
      if (node.isText) {
        for (let index = 0; index < node.text.length; index += 1) {
          positions[text.length + index] = documentPosition + index;
        }
        text += node.text;
        positions[text.length] = documentPosition + node.text.length;
      } else if (node.type.name === "hardBreak") {
        positions[text.length] = documentPosition;
        text += "\n";
        positions[text.length] = documentPosition + node.nodeSize;
      }
    });
  });
  return { text, positions };
}

function codePointOffsets(text) {
  const offsets = [0];
  for (const character of text) offsets.push(offsets[offsets.length - 1] + character.length);
  return offsets;
}

function positionsForAnnotation(source, codePointToUtf16, annotation) {
  // Server offsets are Python Unicode code points; ProseMirror positions count UTF-16 units.
  const start = codePointToUtf16[annotation.start];
  const end = codePointToUtf16[annotation.end];
  if (start === undefined || end === undefined) return null;
  const from = source.positions[start];
  const to = source.positions[end];
  return from === undefined || to === undefined ? null : { from, to };
}

export function sourceOffsetsForPositions(doc, from, to) {
  const source = sourceTextAndPositions(doc);
  const startUtf16 = source.positions.indexOf(from);
  const endUtf16 = source.positions.indexOf(to);
  if (startUtf16 < 0 || endUtf16 < startUtf16) return null;
  const offsets = codePointOffsets(source.text);
  const start = offsets.indexOf(startUtf16);
  const end = offsets.indexOf(endUtf16);
  return start < 0 || end < start ? null : {
    start,
    end,
    quote: source.text.slice(startUtf16, endUtf16),
  };
}

export function sourceOffsetForCaret(doc, position) {
  // Empty paragraphs have no text-node position in the range adapter. Count
  // their canonical separators explicitly so splitting poetry loses no lines.
  let offset = 0, found = null;
  doc.forEach((block, blockOffset, index) => {
    if (index) offset += 2;
    if (position >= blockOffset + 1 && position <= blockOffset + block.nodeSize - 1) {
      const inside = Math.max(0, Math.min(block.content.size, position - blockOffset - 1));
      found = offset + Array.from(block.textBetween(0, inside, "", "\n")).length;
    }
    offset += Array.from(block.textBetween(0, block.content.size, "", "\n")).length;
  });
  return found;
}

export function positionsForSourceRange(doc, start, end) {
  const source = sourceTextAndPositions(doc);
  const offsets = codePointOffsets(source.text);
  const fromIndex = offsets[start];
  const toIndex = offsets[end];
  if (fromIndex === undefined || toIndex === undefined || end <= start) return null;
  const from = source.positions[fromIndex];
  const to = source.positions[toIndex];
  return from === undefined || to === undefined ? null : { from, to };
}

export function commentsForEditor(doc, commentState) {
  if (!commentState) return [];
  return commentState.items.map((comment) => {
    if (comment.detached) return { ...comment, start: null, end: null };
    const offsets = sourceOffsetsForPositions(doc, comment.from, comment.to);
    return offsets
      ? { ...comment, start: offsets.start, end: offsets.end, quote: offsets.quote }
      : { ...comment, start: null, end: null, detached: true };
  });
}

function commentDecorations(doc, items, enabled, style, color) {
  if (!enabled) return DecorationSet.empty;
  const decorations = [];
  for (const comment of items) {
    if (comment.detached) continue;
    if (!Number.isInteger(comment.from) || !Number.isInteger(comment.to) || comment.from >= comment.to) continue;
    decorations.push(Decoration.inline(comment.from, comment.to, {
      class: `verwrity-comment verwrity-annotation verwrity-annotation-${style}${comment.resolved ? " verwrity-comment-resolved" : ""}`,
      style: `--annotation-color: ${color}`,
      "data-verwrity-comment-id": comment.id,
      title: `${comment.quote}\n${comment.body}`,
      tabindex: "0",
    }, { inclusiveStart: false, inclusiveEnd: false }));
  }
  return DecorationSet.create(doc, decorations);
}

function dialogueDecorations(doc, items, enabled, style, color) {
  if (!enabled) return DecorationSet.empty;
  return DecorationSet.create(doc, items.filter(item => !item.detached && item.from < item.to).map(item =>
    Decoration.inline(item.from, item.to, { class: `verwrity-dialogue verwrity-annotation verwrity-annotation-${style}`,
      style: `--annotation-color: ${color}`, "data-dialogue-id": item.id,
      title: `Speaker: ${item.speaker_name || "Unknown"}` }, { inclusiveStart: false, inclusiveEnd: false })));
}

function anchoredExtension(name, key, strict = false) { return Extension.create({
  name,

  addProseMirrorPlugins() {
    return [new Plugin({
      key: key,
      state: {
        init: () => ({ items: [], enabled: false, style: "underline", color: "#8b72c7", decorations: DecorationSet.empty, anchorHistory: [] }),
        apply: (transaction, previous, oldState) => {
          const update = transaction.getMeta(key);
          let items = previous.items;
          let enabled = previous.enabled;
          let anchorHistory = previous.anchorHistory;
          if (update?.resetHistory) anchorHistory = [];
          if (update?.items) {
            const source = sourceTextAndPositions(transaction.doc);
            const offsets = codePointOffsets(source.text);
            items = update.items.map((comment) => {
              const positions = !comment.detached && positionsForAnnotation(source, offsets, comment);
              return { ...comment, original_quote: comment.original_quote || comment.quote,
                ...(positions || { from: null, to: null, detached: true }) };
            });
          } else if (transaction.docChanged && previous.items.length) {
            const known = [...anchorHistory].reverse().find(entry => entry.doc.eq(transaction.doc));
            items = previous.items.map((comment) => {
              const prior = known?.items.find(item => item.id === comment.id);
              if (prior) return { ...comment, from: prior.from, to: prior.to, detached: prior.detached,
                quote: prior.quote, restored: Boolean(comment.restored || (comment.detached && !prior.detached)) };
              if (comment.from === null || comment.to === null) return comment;
              const a = transaction.mapping.map(comment.from, comment.detached ? -1 : 1);
              const b = transaction.mapping.map(comment.to, comment.detached ? 1 : -1);
              const from = Math.min(a, b), to = Math.max(a, b);
              const offsets = sourceOffsetsForPositions(transaction.doc, from, to);
              // Preserve the note when its passage vanishes. A locally undone
              // deletion can recover its exact quote at the mapped location;
              // persisted detached comments require explicit reattachment.
              const detached = !offsets || from >= to || a > b
                || ((strict || comment.detached) && offsets.quote !== comment.quote);
              return { ...comment, from, to, detached,
                restored: Boolean(comment.restored || (comment.detached && !detached)),
                quote: detached ? comment.quote : offsets.quote };
            });
            // Immutable editor documents share their unchanged nodes. Keep
            // local anchor checkpoints so grouped undo can recover a deleted
            // range without searching for another occurrence of its quote.
            anchorHistory = [...anchorHistory, { doc: oldState.doc, items: previous.items }].slice(-1000);
          }
          if (!items.length) anchorHistory = [];
          if (typeof update?.enabled === "boolean") enabled = update.enabled;
          const style = update?.style ?? previous.style;
          const color = update?.color ?? previous.color;
          return { items, enabled, style, color, anchorHistory, decorations: strict ? dialogueDecorations(transaction.doc, items, enabled, style, color) : commentDecorations(transaction.doc, items, enabled, style, color) };
        },
      },
    })];
  },
}); }

export const CommentExtension = anchoredExtension("verwrityComments", commentPluginKey);
export const DialogueExtension = anchoredExtension("verwrityDialogue", dialoguePluginKey, true);

function searchDecorations(doc, query, caseSensitive = false) {
  if (!query) return DecorationSet.empty;
  const source = sourceTextAndPositions(doc);
  const flags = caseSensitive ? "gu" : "giu";
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const codePointToUtf16 = codePointOffsets(source.text);
  const utf16ToCodePoint = new Map(codePointToUtf16.map((offset, index) => [offset, index]));
  const decorations = [];
  for (const match of source.text.matchAll(pattern)) {
    const start = utf16ToCodePoint.get(match.index);
    const end = utf16ToCodePoint.get(match.index + match[0].length);
    const positions = positionsForAnnotation(source, codePointToUtf16, { start, end });
    if (positions) decorations.push(Decoration.inline(positions.from, positions.to, { class: "verwrity-search-match" }));
  }
  return DecorationSet.create(doc, decorations);
}

export const SearchExtension = Extension.create({
  name: "verwritySearch",

  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchPluginKey,
      state: {
        init: () => ({ query: "", caseSensitive: false, decorations: DecorationSet.empty }),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(searchPluginKey);
          const query = typeof update === "string" ? update : update?.query ?? previous.query;
          const caseSensitive = typeof update === "object" && update !== null
            ? Boolean(update.caseSensitive) : previous.caseSensitive;
          if (update !== undefined || transaction.docChanged) {
            return { query, caseSensitive, decorations: searchDecorations(transaction.doc, query, caseSensitive) };
          }
          return { query, caseSensitive, decorations: previous.decorations.map(transaction.mapping, transaction.doc) };
        },
      },
      props: { decorations: (state) => searchPluginKey.getState(state)?.decorations || DecorationSet.empty },
    })];
  },
});

export const PassageHighlightExtension = Extension.create({
  name: "verwrityAIPassageHighlight",

  addProseMirrorPlugins() {
    return [new Plugin({
      key: passageHighlightPluginKey,
      state: {
        init: () => ({ decorations: DecorationSet.empty, enabled: true }),
        apply: (transaction, previous) => {
          const range = transaction.getMeta(passageHighlightPluginKey);
          if (range?.clear) return { decorations: DecorationSet.empty, enabled: true };
          if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
            const positions = positionsForSourceRange(transaction.doc, range.start, range.end);
            const decorations = positions ? DecorationSet.create(transaction.doc, [Decoration.inline(
              positions.from, positions.to, { class: "verwrity-ai-passage" },
            )]) : DecorationSet.empty;
            return { decorations, enabled: true };
          }
          return {
            decorations: previous.decorations.map(transaction.mapping, transaction.doc),
            enabled: typeof range?.enabled === "boolean" ? range.enabled : previous.enabled,
          };
        },
      },
      props: { decorations: (state) => {
        const highlight = passageHighlightPluginKey.getState(state);
        return highlight?.enabled ? highlight.decorations : DecorationSet.empty;
      } },
    })];
  },
});

function decorationsFor(doc, { items: annotations = [], enabled = true, style = "squiggly", color = "#ef4444" } = {}) {
  if (!enabled) return DecorationSet.empty;
  const source = sourceTextAndPositions(doc);
  const codePointToUtf16 = codePointOffsets(source.text);
  const decorations = [];
  for (const annotation of annotations) {
    const positions = positionsForAnnotation(source, codePointToUtf16, annotation);
    if (!positions) continue;
    const suggestions = annotation.suggestions?.length
      ? `Suggestions: ${annotation.suggestions.join(", ")}`
      : "No suggestions available";
    decorations.push(Decoration.inline(positions.from, positions.to, {
      class: `verwrity-spelling-error verwrity-annotation verwrity-annotation-${style}`,
      style: `--annotation-color: ${color}`,
      "data-verwrity-annotation-id": annotation.id,
      "data-verwrity-spelling-word": annotation.word,
      title: `${annotation.word}: ${suggestions}`,
    }, { inclusiveStart: false, inclusiveEnd: false }));
  }
  return DecorationSet.create(doc, decorations);
}

export const AnnotationExtension = Extension.create({
  name: "verwrityAnnotations",

  addProseMirrorPlugins() {
    return [new Plugin({
      key: annotationPluginKey,
      state: {
        init: () => ({ items: [], enabled: false, style: "squiggly", color: "#ef4444", decorations: DecorationSet.empty }),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(annotationPluginKey);
          if (!transaction.docChanged && update === undefined) return previous;
          if (!previous.items.length && update === undefined) return previous;
          let layer = transaction.docChanged ? mapAnalysisLayer(transaction, previous) : previous;
          if (update !== undefined) {
            const options = Array.isArray(update) ? { items: update } : update;
            layer = { ...layer, ...options };
            if (options.items) layer.items = options.items.map(item => ({ ...item, quote: item.word }));
          }
          return { ...layer, decorations: decorationsFor(transaction.doc, layer) };
        },
      },
    })];
  },
});

// Follow the actual edit steps, never search for a similar quotation elsewhere.
// A changed finding is removed even if another copy of its quote still exists.
function analysisSource(doc) {
  const source = sourceTextAndPositions(doc);
  const offsets = codePointOffsets(source.text);
  const indices = new Map();
  offsets.forEach((offset, index) => {
    const position = source.positions[offset];
    if (position !== undefined && !indices.has(position)) indices.set(position, index);
  });
  return { ...source, offsets, indices };
}

function mapAnalysisLayer(transaction, layer, before = analysisSource(transaction.before), after = analysisSource(transaction.doc)) {
  const items = [];
  for (const item of layer.items || []) {
    const original = positionsForAnnotation(before, before.offsets, item);
    if (!original) continue;
    let { from, to } = original;
    let touched = false;
    for (const map of transaction.mapping.maps) {
      map.forEach((start, end) => {
        if (start === end ? start > from && start < to : start < to && end > from) touched = true;
      });
      from = map.map(from, 1);
      to = map.map(to, -1);
    }
    if (touched || from >= to) continue;
    const start = after.indices.get(from), end = after.indices.get(to);
    if (start === undefined || end === undefined) continue;
    const quote = after.text.slice(after.offsets[start], after.offsets[end]);
    if (quote === item.quote) items.push({ ...item, start, end });
  }
  return { ...layer, items };
}

export const TextAnalysisExtension = Extension.create({
  name: "verwrityTextAnalyses",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: textAnalysisPluginKey,
      state: {
        init: () => ({ layers: {}, decorations: DecorationSet.empty }),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(textAnalysisPluginKey);
          if (!update && transaction.docChanged && !Object.values(previous.layers).some(layer => layer.items?.length)) return previous;
          // Keep untouched evidence anchored through local edits. These are
          // still suggestions from the original run, not a new analysis.
          let layers = previous.layers;
          if (transaction.docChanged) {
            const before = analysisSource(transaction.before), after = analysisSource(transaction.doc);
            layers = Object.fromEntries(Object.entries(layers).map(([id, layer]) => [id, mapAnalysisLayer(transaction, layer, before, after)]));
          }
          if (update) layers = { ...layers, [update.id]: update };
          if (!update && !transaction.docChanged) return previous;
          const source = sourceTextAndPositions(transaction.doc);
          const offsets = codePointOffsets(source.text);
          const findings = [];
          for (const layer of Object.values(layers)) {
            if (!layer.enabled) continue;
            for (const item of layer.items || []) {
              if (source.text.slice(offsets[item.start], offsets[item.end]) !== item.quote) continue;
              const range = positionsForAnnotation(source, offsets, item);
              if (!range || range.from >= range.to) continue;
              findings.push({ ...range, layer, item, order: findings.length });
            }
          }
          return { layers, decorations: DecorationSet.create(transaction.doc, textAnalysisDecorations(findings)) };
        },
      },
    })];
  },
});

function textAnalysisDecorations(findings) {
  // ProseMirror merges overlapping attributes by keeping only one title.
  // Split at range boundaries so every tooltip contains exactly the feedback
  // for that portion of the text, including partial and nested overlaps.
  const boundaries = new Map();
  for (const finding of findings) {
    for (const [position, kind] of [[finding.from, "starts"], [finding.to, "ends"]]) {
      if (!boundaries.has(position)) boundaries.set(position, { starts: [], ends: [] });
      boundaries.get(position)[kind].push(finding);
    }
  }
  const positions = [...boundaries.keys()].sort((a, b) => a - b);
  const active = new Set();
  const decorations = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const from = positions[index], to = positions[index + 1];
    const boundary = boundaries.get(from);
    boundary.ends.forEach(finding => active.delete(finding));
    boundary.starts.forEach(finding => active.add(finding));
    if (!active.size) continue;
    const feedback = [...active].sort((a, b) => a.order - b.order);
    const last = feedback.at(-1);
    const classes = new Set(["verwrity-text-analysis", "verwrity-annotation"]);
    for (const { layer } of feedback) {
      classes.add(`verwrity-text-analysis-${layer.id}`);
      classes.add(`verwrity-annotation-${["highlight", "underline", "squiggly", "double"].includes(layer.style) ? layer.style : "highlight"}`);
    }
    decorations.push(Decoration.inline(from, to, {
      class: [...classes].join(" "),
      style: `--annotation-color: ${last.layer.color}`,
      "data-text-analysis-id": last.layer.id,
      "data-verwrity-annotation-id": last.item.id,
      title: feedback.map(({ layer, item }) => `${layer.name}: ${item.explanation}`).join("\n\n"),
    }, { inclusiveStart: false, inclusiveEnd: false }));
  }
  return decorations;
}

function plainDocumentText(doc) {
  let text = "";
  const blocks = [];
  doc.forEach((block, blockOffset) => {
    if (blocks.length) text += "\n\n";
    const start = text.length;
    block.descendants((node) => {
      if (node.isText) text += node.text;
      else if (node.type.name === "hardBreak") text += "\n";
    });
    blocks.push({ start, end: text.length, blockOffset });
  });
  return { text, blocks };
}

function positionsForWikiTitle(doc, start, end) {
  const { blocks } = plainDocumentText(doc);
  const positionAt = (offset) => {
    for (const block of blocks) {
      if (offset >= block.start && offset <= block.end) return block.blockOffset + 1 + offset - block.start;
    }
    return null;
  };
  const from = positionAt(start);
  const to = positionAt(end);
  return from === null || to === null ? null : { from, to };
}

function wikiDecorations(doc, { items: pages = [], enabled = true, style = "underline", color = "#4f8fba" } = {}) {
  const { text } = plainDocumentText(doc);
  const decorations = [];
  const names = new Map();
  for (const page of pages) {
    for (const name of [page.title, ...(page.aliases || [])]) {
      const trimmed = name?.trim();
      if (trimmed && !names.has(trimmed.toLocaleLowerCase())) names.set(trimmed.toLocaleLowerCase(), { name: trimmed, page });
    }
  }
  const alternatives = [...names.values()].sort((a, b) => b.name.length - a.name.length)
    .map(({ name }) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alternatives.length) return DecorationSet.empty;
  const pattern = new RegExp(`(?<!\\w)(${alternatives.join("|")})(?!\\w)`, "giu");
  for (const match of text.matchAll(pattern)) {
    const entry = names.get(match[0].toLocaleLowerCase());
    const positions = entry && positionsForWikiTitle(doc, match.index, match.index + match[0].length);
    if (entry && positions) {
      const attributes = {
        class: `verwrity-wiki-link${enabled ? ` verwrity-annotation-${style}` : ""}`,
        "data-wiki-page-id": entry.page.id,
        title: `Open wiki page: ${entry.page.title}`,
      };
      if (enabled) attributes.style = `--annotation-color: ${color}`;
      decorations.push(Decoration.inline(positions.from, positions.to, attributes, { inclusiveStart: false, inclusiveEnd: false }));
    }
  }
  return DecorationSet.create(doc, decorations);
}

export const WikiLinkExtension = Extension.create({
  name: "verwrityWikiLinks",

  addProseMirrorPlugins() {
    return [new Plugin({
      key: wikiLinkPluginKey,
      state: {
        init: () => ({ options: { items: [], enabled: false }, decorations: DecorationSet.empty }),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(wikiLinkPluginKey);
          const options = update === undefined
            ? previous.options
            : { ...previous.options, ...(Array.isArray(update) ? { items: update } : update) };
          if (update !== undefined || transaction.docChanged) {
            return { options, decorations: wikiDecorations(transaction.doc, options) };
          }
          return {
            options,
            decorations: previous.decorations.map(transaction.mapping, transaction.doc),
          };
        },
      },
    })];
  },
});
