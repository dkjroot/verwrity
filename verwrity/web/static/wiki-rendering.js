"use strict";
import { wikiSourceButton } from "./wiki-evidence.js";

export function needsCitationWarning(record) {
  return record.origin !== "human_delegated" && !(record.evidence || []).length
    && (record.kind === "ai_text" || (record.kind === "suggestion" && typeof record.replacement_text === "string"));
}

export function wikiAILabel(record, partial = false) {
  const label = document.createElement("span"); label.className = "wiki-ai-label";
  if (!partial) label.textContent = record.origin === "human_delegated" ? "AI maintained" : "AI text";
  if (needsCitationWarning(record)) {
    label.classList.add("wiki-uncited-label");
    if (!partial) label.append(document.createTextNode(" · "));
    const warning = document.createElement("span"); warning.className = "wiki-citation-warning";
    warning.textContent = "Warning: no citation";
    warning.title = "No verified manuscript citation. This AI-generated material is provisional.";
    label.append(warning);
  }
  return label;
}

export function matchesWikiPage(page, name) {
  const key = name.trim().toLocaleLowerCase();
  return page.title.toLocaleLowerCase() === key || page.aliases.some((alias) => alias.toLocaleLowerCase() === key);
}

function appendSource(parent, text, start, annotations) {
  const boundaries = new Set([start, start + text.length]);
  for (const a of annotations) {
    if (a.start < start + text.length && a.end > start) {
      boundaries.add(Math.max(start, a.start)); boundaries.add(Math.min(start + text.length, a.end));
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const left = points[i], right = points[i + 1];
    const active = annotations.filter(a => a.start < right && a.end > left);
    const node = document.createTextNode(text.slice(left - start, right - start));
    if (!active.length) { parent.append(node); continue; }
    const span = document.createElement("span");
    span.className = active.some(a => a.kind === "ai_text") ? "wiki-ai-text" : "wiki-ai-suggestion";
    span.title = active.map(a => a.kind === "ai_text"
      ? (a.origin === "human_delegated" ? "Human-written · AI maintenance allowed by the author" : "AI-written · provisional")
        + (needsCitationWarning(a) ? " · Warning: no citation" : "")
      : a.explanation).join("\n\n");
    span.append(node); parent.append(span);
  }
}

function appendInline(parent, text, pages, annotations = [], sourceStart = 0) {
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    appendSource(parent, text.slice(start, match.index), sourceStart + start, annotations);
    const appendTokenText = (host, value, tokenOffset) => appendSource(host, value,
      sourceStart + match.index + tokenOffset, annotations);
    if (match[1]) {
      const targetTitle = match[1].trim();
      const target = pages.find((page) => matchesWikiPage(page, targetTitle));
      const link = document.createElement("button");
      link.type = "button";
      if (target) {
        link.className = "wiki-inline-link";
        link.dataset.wikiPageId = target.id;
        const value = match[2] || match[1];
        appendTokenText(link, value.trim(), (match[2] ? match[0].indexOf("|") + 1 : 2) + value.indexOf(value.trim()));
      } else {
        link.className = "wiki-broken-link";
        link.dataset.wikiCreateTitle = targetTitle;
        appendTokenText(link, match[2] || targetTitle, match[2] ? match[0].indexOf("|") + 1 : 2 + match[1].indexOf(targetTitle));
        link.title = `Create a wiki page titled “${targetTitle}”`;
      }
      parent.append(link);
    } else if (match[3]) {
      const strong = document.createElement("strong");
      appendTokenText(strong, match[3], 2);
      parent.append(strong);
    } else if (match[4]) {
      const emphasis = document.createElement("em");
      appendTokenText(emphasis, match[4], 1);
      parent.append(emphasis);
    } else if (match[5]) {
      const code = document.createElement("code");
      appendTokenText(code, match[5], 1);
      parent.append(code);
    } else {
      let url;
      try { url = new URL(match[7], document.baseURI); } catch (_) { url = null; }
      if (url && ["http:", "https:"].includes(url.protocol)) {
        const anchor = document.createElement("a");
        anchor.href = url.href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        appendTokenText(anchor, match[6], 1);
        parent.append(anchor);
      } else {
        appendSource(parent, match[0], sourceStart + match.index, annotations);
      }
    }
    start = match.index + match[0].length;
  }
  appendSource(parent, text.slice(start), sourceStart + start, annotations);
}

export function renderWikiBody(host, body, pages, records = []) {
  host.replaceChildren();
  // Server offsets count Unicode code points; DOM strings count UTF-16 units.
  const offsets = [0];
  for (const char of body) offsets.push(offsets.at(-1) + char.length);
  const annotations = records.map(a => ({ ...a, start: offsets[a.start], end: offsets[a.end] }));
  function markOwnership(element, start, end) {
    const owned = annotations.find(a => a.kind === "ai_text" && a.start <= start && a.end >= end);
    const uncited = annotations.find(a => a.kind === "ai_text" && a.start < end && a.end > start && needsCitationWarning(a));
    if (owned) {
      element.classList.add("wiki-ai-block"); element.setAttribute("aria-label", "AI-maintained text");
      element.append(wikiAILabel(owned), wikiSourceButton(owned));
    } else if (uncited) {
      // A partial AI selection must not label the surrounding human words as AI.
      element.append(wikiAILabel(uncited, true));
    }
    if (uncited) element.classList.add("wiki-uncited-block");
  }
  function appendBlock(element, start, end) {
    markOwnership(element, start, end);
    host.append(element);
  }
  let paragraph = [];
  let listItems = [];
  let listType = "ul";
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const element = document.createElement("p");
    paragraph.forEach((line, index) => {
      if (index) element.append(document.createTextNode(" "));
      appendInline(element, line.text, pages, annotations, line.start);
    });
    appendBlock(element, paragraph[0].start, paragraph.at(-1).start + paragraph.at(-1).text.length);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const list = document.createElement(listType);
    for (const item of listItems) {
      const element = document.createElement("li");
      appendInline(element, item.text, pages, annotations, item.start);
      markOwnership(element, item.start, item.start + item.text.length);
      list.append(element);
    }
    host.append(list);
    listItems = [];
    listType = "ul";
  };
  let offset = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const lineOffset = offset; offset += rawLine.length + 1;
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const element = document.createElement(`h${heading[1].length + 1}`);
      appendInline(element, heading[2], pages, annotations, lineOffset + line.indexOf(heading[2], heading[1].length));
      appendBlock(element, lineOffset + line.indexOf(heading[2], heading[1].length), lineOffset + line.length);
    } else if (bullet || numbered) {
      const nextType = numbered ? "ol" : "ul";
      if (listItems.length && listType !== nextType) flushList();
      listType = nextType;
      flushParagraph();
      const text = (numbered || bullet)[1];
      listItems.push({ text, start: lineOffset + line.length - text.length });
    } else if (quote) {
      flushParagraph(); flushList();
      const element = document.createElement("blockquote");
      appendInline(element, quote[1], pages, annotations, lineOffset + line.length - quote[1].length);
      appendBlock(element, lineOffset + line.length - quote[1].length, lineOffset + line.length);
    } else if (/^---+$/.test(line.trim())) {
      flushParagraph(); flushList(); host.append(document.createElement("hr"));
    } else if (!line.trim()) {
      flushParagraph(); flushList();
    } else {
      flushList(); paragraph.push({ text: line.trim(), start: lineOffset + line.indexOf(line.trim()) });
    }
  }
  flushParagraph(); flushList();
}
