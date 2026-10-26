"use strict";

import { needsCitationWarning } from "./wiki-rendering.js";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The wiki request failed.");
  return data;
}

export function post(url, data, signal) {
  return jsonRequest(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data), signal });
}

export function visibleAnnotations(page) {
  return (page.annotations || []).filter(a => a.kind === "ai_text"
    || (a.status === "open" && a.source_hash === page.source_hash));
}

export function wikiAIControls(page, onUpdate) {
  const host = document.createElement("details"); host.className = "wiki-ai-controls";
  const heading = document.createElement("summary"); heading.textContent = "AI · Populate / update";
  const description = document.createElement("p");
  description.textContent = "Read the current manuscript to fill this page. AI can add separate paragraphs anywhere and update blue text, including passages you hand over for maintenance. Your protected words stay unchanged and can receive review suggestions.";
  const label = document.createElement("label"); label.textContent = "Page purpose · what should this page cover?";
  const purpose = document.createElement("textarea"); purpose.rows = 3; purpose.maxLength = 2000;
  purpose.id = `wiki-view-purpose-${page.id}`; label.htmlFor = purpose.id;
  purpose.value = page.purpose || ""; purpose.dataset.wikiPurpose = "";
  purpose.placeholder = "For example: Mara's background, appearance, relationships and what she knows.";
  label.append(purpose);
  const actions = document.createElement("div"); actions.className = "wiki-page-actions";
  const suggest = document.createElement("button"); suggest.type = "button"; suggest.textContent = "Suggest purpose (AI)";
  const populate = document.createElement("button"); populate.type = "button";
  populate.textContent = page.body.trim() ? "Update from manuscript (AI)" : "Populate from manuscript (AI)";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.hidden = true;
  const status = document.createElement("p"); status.className = "wiki-ai-status"; status.setAttribute("role", "status");
  let controller;
  async function run(action) {
    if (action === "populate" && !purpose.value.trim()) {
      status.textContent = "Describe the page's purpose or ask for a suggestion first."; purpose.focus(); return;
    }
    controller = new AbortController(); const signal = controller.signal;
    suggest.disabled = populate.disabled = purpose.disabled = true; cancel.hidden = false;
    status.textContent = "Saving the current scene, then reading the manuscript…";
    try {
      if (await window.verwritySaveActiveScene?.() === false) throw new Error("Save the current scene successfully before reviewing the wiki.");
      if (signal.aborted || !host.isConnected) return;
      const result = await post(`/ai/wiki/${page.id}`, { action, purpose: purpose.value, page_hash: page.page_hash }, signal);
      if (signal.aborted || !host.isConnected) return;
      if (action === "suggest") {
        purpose.value = result.purpose;
        status.textContent = "Suggested purpose. Edit it as needed, then populate or update the page.";
      } else {
        status.textContent = "Checking the page and manuscript before saving…";
        const updated = await post(`/wiki/page/${page.id}/ai/apply`, { proposal: result.proposal }, signal);
        if (signal.aborted || !host.isConnected) return;
        if (updated.page_hash !== page.page_hash) window.verwrityMarkProjectChanged?.();
        onUpdate(updated, result.summary);
      }
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = error.message;
    } finally {
      suggest.disabled = populate.disabled = purpose.disabled = false; cancel.hidden = true;
    }
  }
  suggest.addEventListener("click", () => run("suggest")); populate.addEventListener("click", () => run("populate"));
  cancel.addEventListener("click", () => {
    controller?.abort(); status.textContent = "Cancelled. The provider may finish its request; its result will be discarded.";
  });
  // Stop a detached control from committing a late proposal after wiki navigation.
  host.cancelRequest = () => {
    if (controller && !controller.signal.aborted) {
      controller.abort(); status.textContent = "The manuscript or page view changed. Run the wiki review again when ready.";
    }
  };
  label.prepend(suggest); actions.append(populate, cancel); host.append(heading, description, label, actions, status);
  return host;
}

export function wikiAIReview(page, onUpdate, beforeAction = async () => true) {
  const host = document.createElement("section"); host.className = "wiki-ai-review";
  const records = page.annotations || [];
  if (!records.length) return host;
  const legend = document.createElement("p"); legend.className = "wiki-authorship-legend";
  legend.textContent = "Blue: AI maintenance allowed. Normal text: protected human/adopted text. Underlined amber: AI review suggestion.";
  if (arguments.length < 3) host.append(legend);
  if (records.some(a => a.kind === "suggestion" && a.status === "open" && a.source_hash !== page.source_hash)) {
    const stale = document.createElement("p"); stale.textContent = "Review suggestions are out of date. Update from manuscript to review again."; host.append(stale);
  }
  for (const record of records.filter(a => a.kind === "suggestion" && a.status === "open" && a.source_hash === page.source_hash)) {
    const details = document.createElement("details");
    const title = document.createElement("summary"); title.textContent = record.kind === "ai_text"
      ? `${record.origin === "human_delegated" ? "AI maintenance permission" : "AI source"}: ${record.quote.trim().slice(0, 70)}` : `Review: ${record.quote.slice(0, 70)}`;
    if (needsCitationWarning(record)) title.textContent += " · Warning: no citation";
    details.append(title);
    if (record.explanation) { const p = document.createElement("p"); p.textContent = record.explanation; details.append(p); }
    const attribution = document.createElement("small");
    attribution.textContent = record.origin === "human_delegated"
      ? `Originally human-written; the author allowed AI updates · ${new Date(record.created_at).toLocaleString()}`
      : `${record.model} · ${new Date(record.created_at).toLocaleString()}${record.source_hash !== page.source_hash ? " · manuscript has changed since this extraction" : ""}`;
    details.append(attribution);
    if (record.analysis_version === "wiki-instruct-v1" && !record.evidence.length) {
      const context = document.createElement("small");
      context.textContent = " · Wiki instruction: editorial or creative work, without manuscript citations.";
      details.append(context);
    }
    for (const evidence of record.evidence) {
      const quote = document.createElement("blockquote"); quote.textContent = evidence.quote; details.append(quote);
      const jump = document.createElement("button"); jump.type = "button"; jump.textContent = "Go to passage";
      jump.addEventListener("click", async () => {
        if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
        if (await window.verwritySaveActiveScene?.() === false) return;
        if (window.verwrityEditor?.sceneId === evidence.scene_id) {
          if (!window.verwrityEditor.highlightSourceQuote(evidence.quote)) {
            await window.verwrityDialog?.alert("This source passage has changed. Update the wiki to refresh its evidence.");
          }
          return;
        }
        if (await window.verwrityWiki?.prepareSceneNavigation() === false) return;
        const form = document.createElement("form"); form.method = "POST"; form.action = `/scene/select/${evidence.scene_id}`;
        const input = document.createElement("input"); input.name = "ai_quote"; input.value = evidence.quote; form.append(input);
        document.body.append(form); window.verwrityAllowUnload?.(); form.submit();
      }); details.append(jump);
    }
    if (record.kind === "suggestion") {
      if (record.replacement_text !== null && record.replacement_text !== undefined) {
        const label = document.createElement("p"); label.textContent = "Proposed replacement · becomes AI text if accepted:";
        const replacement = document.createElement("blockquote"); replacement.textContent = record.replacement_text;
        const accept = document.createElement("button"); accept.type = "button"; accept.textContent = "Accept suggestion";
        accept.addEventListener("click", async () => {
          let release;
          accept.disabled = true;
          try {
            release = await beforeAction();
            if (!release) return;
            const result = await post(`/wiki/page/${page.id}/suggestion/${record.id}/accept`, { page_hash: page.page_hash });
            window.verwrityMarkProjectChanged?.(); if (host.isConnected) onUpdate(result);
          } catch (error) { await window.verwrityDialog?.alert(error.message); }
          finally { if (typeof release === "function") release(); accept.disabled = false; }
        });
        details.append(label, replacement, accept);
      }
      const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "Dismiss suggestion";
      dismiss.addEventListener("click", async () => {
        let release;
        dismiss.disabled = true;
        try {
          release = await beforeAction();
          if (!release) return;
          const result = await post(`/wiki/page/${page.id}/suggestion/${record.id}/dismiss`, { page_hash: page.page_hash });
          window.verwrityMarkProjectChanged?.(); if (host.isConnected) onUpdate(result);
        } catch (error) { await window.verwrityDialog?.alert(error.message); }
        finally { if (typeof release === "function") release(); dismiss.disabled = false; }
      }); details.append(dismiss);
    }
    host.append(details);
  }
  return host;
}
