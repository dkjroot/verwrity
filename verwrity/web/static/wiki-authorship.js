"use strict";

import { wikiSourceButton } from "./wiki-evidence.js";
import { wikiAILabel } from "./wiki-rendering.js";

// Mirror the domain's block boundaries; the server replays all author edits.
export function wikiBlocks(text) {
  const blocks = []; let paragraph = null, offset = 0;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const raw of lines) {
    const line = raw.replace(/\r?\n$/, ""), end = offset + line.length;
    if (!line.trim() || /^\s*(?:#{1,3}\s|[-*]\s|\d+\.\s|>|---+$)/.test(line)) {
      if (paragraph) { blocks.push(paragraph); paragraph = null; }
      if (line.trim()) blocks.push([offset, end]);
    } else paragraph = [paragraph ? paragraph[0] : offset, end];
    offset += raw.length;
  }
  if (paragraph) blocks.push(paragraph);
  return blocks;
}

function adoptEditedBlocks(old, next, records, start, end) {
  const oldBlocks = wikiBlocks(old), newBlocks = wikiBlocks(next);
  const delta = next.length - old.length;
  return records.flatMap(a => {
    if (a.kind !== "ai_text") return [];
    const block = oldBlocks.find(([left, right]) => left <= a.start && a.end <= right);
    if (!block) return [];
    const [left, right] = block;
    if ((start < right && end > left) || (start === end && left < start && start < right)) return [];
    const shift = end <= left ? delta : 0;
    if (!newBlocks.some(([l, r]) => l === left + shift && r === right + shift)) return [];
    return [{ ...a, start: a.start + shift, end: a.end + shift }];
  });
}

function replacement(old, next, hint) {
  if (hint) {
    let { start, end, type } = hint;
    const delta = next.length - old.length;
    if (start === end && delta < 0 && type?.startsWith("delete")) {
      if (type.endsWith("Backward")) start += delta;
      else if (type.endsWith("Forward")) end -= delta;
    }
    const inserted = next.length - (old.length - (end - start));
    if (0 <= start && start <= end && end <= old.length && inserted >= 0
        && next.slice(0, start) === old.slice(0, start)
        && next.slice(start + inserted) === old.slice(end)) {
      return { start, end, text: next.slice(start, start + inserted) };
    }
  }
  let start = 0, suffix = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  // Do not bisect an emoji when a programmatic input replaces a surrogate pair.
  if (start && /[\uD800-\uDBFF]/.test(old[start - 1])) start--;
  while (suffix < old.length - start && suffix < next.length - start
         && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  if (suffix && /[\uDC00-\uDFFF]/.test(old[old.length - suffix])) suffix--;
  return { start, end: old.length - suffix, text: next.slice(start, next.length - suffix) };
}

export function attachWikiAuthorship(textarea, page, form) {
  const wrapper = document.createElement("div"); wrapper.className = "wiki-authorship-editor";
  textarea.before(wrapper); wrapper.append(textarea);
  const mirror = document.createElement("div"); mirror.className = "wiki-authorship-mirror";
  const outlines = document.createElement("div"); outlines.className = "wiki-authorship-outlines";
  const viewport = document.createElement("div"); viewport.className = "wiki-authorship-viewport";
  viewport.setAttribute("aria-hidden", "true"); viewport.append(mirror, outlines); wrapper.prepend(viewport);
  const sources = document.createElement("div"); sources.className = "wiki-source-actions"; wrapper.append(sources);
  const editsInput = document.createElement("input"); editsInput.type = "hidden";
  editsInput.name = "authorship_edits"; form.append(editsInput);
  let previous = textarea.value, hint = null, frame;
  const original = page.body;
  const normalized = original.replace(/\r\n?/g, "\n");
  const chars = Array.from(original);
  let records = (page.annotations || []).map(a => ({ ...a,
    start: chars.slice(0, a.start).join("").replace(/\r\n?/g, "\n").length,
    end: chars.slice(0, a.end).join("").replace(/\r\n?/g, "\n").length,
    quote: a.quote.replace(/\r\n?/g, "\n") }));
  const edits = original === normalized ? [] : [{ kind: "normalize_newlines" }];
  editsInput.value = JSON.stringify(edits);
  function sync() {
    const next = textarea.value;
    if (next !== previous) {
      const edit = replacement(previous, next, hint);
      edits.push({ start: Array.from(previous.slice(0, edit.start)).length,
        end: Array.from(previous.slice(0, edit.end)).length, text: edit.text });
      records = adoptEditedBlocks(previous, next, records, edit.start, edit.end);
      previous = next; editsInput.value = JSON.stringify(edits);
    }
    hint = null;
    cancelAnimationFrame(frame); frame = requestAnimationFrame(paint);
  }
  function annotations() {
    return records.map(a => ({ ...a, start: Array.from(previous.slice(0, a.start)).length,
      end: Array.from(previous.slice(0, a.end)).length }));
  }
  function snapshot() {
    sync(); return { body: previous, edits: [...edits], annotations: annotations() };
  }
  function restore(value) {
    previous = textarea.value = value.body; hint = null;
    edits.splice(0, edits.length, ...value.edits); editsInput.value = JSON.stringify(edits);
    const chars = Array.from(previous);
    records = value.annotations.map(record => ({ ...record,
      start: chars.slice(0, record.start).join('').length, end: chars.slice(0, record.end).join('').length }));
    cancelAnimationFrame(frame); frame = requestAnimationFrame(paint);
  }
  function reset(savedPage) {
    // Rebase the edit log after an explicit save without replacing the textarea
    // or discarding its native undo history.
    previous = textarea.value; hint = null; edits.splice(0); editsInput.value = "[]";
    const chars = Array.from(savedPage.body);
    records = savedPage.annotations.map(a => ({ ...a,
      start: chars.slice(0, a.start).join("").length,
      end: chars.slice(0, a.end).join("").length }));
    cancelAnimationFrame(frame); frame = requestAnimationFrame(paint);
  }
  function setMaintenance(enabled) {
    sync();
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    if (start === end || !previous.slice(start, end).trim()) return false;
    const id = crypto.randomUUID();
    edits.push({ kind: "ai_maintenance", start: Array.from(previous.slice(0, start)).length,
      end: Array.from(previous.slice(0, end)).length, enabled, id });
    let next = [];
    for (const a of records) {
      if (a.start >= end || a.end <= start || (enabled && a.kind === "ai_text")) next.push(a);
      else if (a.kind === "ai_text") {
        if (a.start < start) next.push({ ...a, end: start, quote: previous.slice(a.start, start) });
        if (a.end > end) next.push({ ...a, id: crypto.randomUUID(), start: end, quote: previous.slice(end, a.end) });
      }
    }
    if (enabled) {
      for (const [left, right] of wikiBlocks(previous)) {
        let cursor = Math.max(left, start); const limit = Math.min(right, end);
        const owned = next.filter(a => a.kind === "ai_text" && a.start < limit && a.end > cursor)
          .sort((a, b) => a.start - b.start);
        for (const a of [...owned, { start: limit, end: limit }]) {
          const boundary = Math.min(a.start, limit);
          if (cursor < boundary && previous.slice(cursor, boundary).trim()) next.push({ kind: "ai_text",
            id: crypto.randomUUID(), start: cursor, end: boundary, quote: previous.slice(cursor, boundary), origin: "human_delegated" });
          cursor = Math.max(cursor, a.end);
        }
      }
    }
    records = next; editsInput.value = JSON.stringify(edits);
    textarea.focus(); textarea.setSelectionRange(start, end);
    textarea.dispatchEvent(new CustomEvent("verwrity-wiki-ownership-change", { bubbles: true }));
    cancelAnimationFrame(frame); frame = requestAnimationFrame(paint);
    return true;
  }
  function insertParagraph(position = textarea.value.length) {
    sync();
    const prefix = previous.slice(0, position);
    const separator = !prefix ? "" : prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
    if (previous.length + separator.length > textarea.maxLength && textarea.maxLength >= 0) return false;
    textarea.focus(); textarea.setSelectionRange(position, position);
    if (separator) {
      hint = { start: position, end: position, type: "insertText" };
      // Native insertion keeps textarea undo; setRangeText is the browser fallback.
      if (!document.execCommand("insertText", false, separator)) {
        textarea.setRangeText(separator, position, position, "end");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    textarea.setSelectionRange(position + separator.length, position + separator.length);
    textarea.dispatchEvent(new CustomEvent("verwrity-wiki-human-paragraph", { bubbles: true }));
    return true;
  }
  function paint() {
    if (!wrapper.isConnected) return;
    const style = getComputedStyle(textarea);
    for (const property of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
      "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "tabSize"]) {
      mirror.style[property] = style[property];
    }
    mirror.style.width = `${textarea.clientWidth}px`;
    viewport.style.width = `${textarea.clientWidth}px`; viewport.style.height = `${textarea.clientHeight}px`;
    sources.style.width = `${textarea.clientWidth}px`; sources.style.height = `${textarea.clientHeight}px`;
    mirror.replaceChildren(); outlines.replaceChildren(); sources.replaceChildren();
    let cursor = 0;
    const spans = [];
    function appendHuman(text, start) {
      if (!text) return;
      const suggestions = records.filter(a => a.kind === "suggestion" && a.status === "open"
        && a.source_hash === page.source_hash && a.start < start + text.length && a.end > start);
      const boundaries = [...new Set([start, start + text.length, ...suggestions.flatMap(a => [
        Math.max(start, a.start), Math.min(start + text.length, a.end)])])].sort((a, b) => a - b);
      for (let i = 1; i < boundaries.length; i++) {
        const left = boundaries[i - 1], right = boundaries[i];
        const findings = suggestions.filter(a => a.start < right && a.end > left);
        const span = document.createElement("span"); span.className = "wiki-human-text";
        if (findings.length) { span.classList.add("wiki-ai-suggestion"); span.title = findings.map(a => a.explanation).join("\n"); }
        span.textContent = previous.slice(left, right); mirror.append(span);
      }
    }
    for (const a of records.filter(a => a.kind === "ai_text").sort((a, b) => a.start - b.start)) {
      appendHuman(previous.slice(cursor, a.start), cursor);
      const span = document.createElement("span"); span.className = "wiki-ai-text";
      span.textContent = previous.slice(a.start, a.end); mirror.append(span); spans.push({ span, record: a }); cursor = a.end;
    }
    appendHuman(previous.slice(cursor), cursor);
    mirror.append(document.createTextNode("\u200b"));
    const origin = mirror.getBoundingClientRect();
    for (const { span, record } of spans) {
      const range = document.createRange(); range.selectNodeContents(span);
      const rects = [...range.getClientRects()];
      if (!rects.length) continue;
      const top = Math.min(...rects.map(r => r.top)) - origin.top;
      const bottom = Math.max(...rects.map(r => r.bottom)) - origin.top;
      const box = document.createElement("div"); box.className = "wiki-source-ai-box";
      box.style.top = `${top - 2}px`; box.style.height = `${bottom - top + 4}px`;
      box.append(wikiAILabel(record)); outlines.append(box);
      const source = wikiSourceButton(record); sources.append(source);
      // Keep the action within the visible portion of its AI block. The
      // clipping layer stays fixed while the text and outlines scroll.
      const actionTop = Math.max(2, top - 2 - textarea.scrollTop);
      source.style.top = `${actionTop}px`;
      source.hidden = actionTop + source.offsetHeight > Math.min(textarea.clientHeight, bottom + 2 - textarea.scrollTop);
    }
    const transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    mirror.style.transform = outlines.style.transform = transform;
  }
  textarea.addEventListener("beforeinput", event => {
    hint = { start: textarea.selectionStart, end: textarea.selectionEnd, type: event.inputType };
  });
  textarea.addEventListener("verwrity-textarea-before-edit", event => {
    hint = { ...event.detail, type: "insertText" };
  });
  textarea.addEventListener("input", sync);
  textarea.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
        || textarea.selectionStart !== textarea.selectionEnd) return;
    const position = textarea.selectionStart;
    if (records.some(a => a.kind === "ai_text" && a.end === position)
        && wikiBlocks(previous).some(([, right]) => right === position)) {
      event.preventDefault(); insertParagraph(position);
    }
  });
  textarea.addEventListener("scroll", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); });
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); });
  observer.observe(textarea);
  // The editor owns cleanup when switching to another page/history view.
  return { sync, reset, snapshot, restore, annotations, setMaintenance, insertParagraph, refresh: () => { frame = requestAnimationFrame(paint); },
    destroy: () => { observer.disconnect(); cancelAnimationFrame(frame); } };
}
