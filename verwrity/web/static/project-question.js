"use strict";

const dock = document.querySelector("[data-project-question-dock]");
const form = document.querySelector("[data-project-question-form]");
if (dock && form) {
  const transcript = dock.querySelector("[data-project-question-answer]");
  const status = dock.querySelector("[data-project-question-status]");
  const submit = dock.querySelector("[data-project-question-submit]");
  const hideAnswer = dock.querySelector("[data-collapse-project-question]");
  const clearAnswer = dock.querySelector("[data-clear-project-question]");
  const cancel = dock.querySelector("[data-cancel-project-question]");
  const taskMenu = document.querySelector(".project-question-tasks");
  const taskButtons = [...document.querySelectorAll("[data-manuscript-task]")];
  let requestController = null;
  const progress = document.querySelector("[data-project-question-progress]");
  const progressMessage = document.querySelector("[data-project-question-progress-message]");
  const progressTitle = document.querySelector("[data-project-question-progress-title]");
  const readAloud = form.elements.namedItem("read_aloud");
  const readAloudHelp = dock.querySelector("[data-read-aloud-help]");
  let history = [];
  let progressDismissed = false;
  let readAloudRemote = false;
  let modelStartedAt = 0;
  let lastStreamedAt = 0;
  let streamedCharacterCount = 0;
  let modelHasStreamedText = false;
  let modelActivityTimer = null;
  let contextSummary = "";
  const conversationKey = `verwrity-project-questions:${document.querySelector('[data-workspace]')?.dataset.projectId}`;
  const contextMode = form.elements.namedItem("context_mode");
  const selectionPanel = dock.querySelector("[data-selected-question-context]");
  const selectionPreview = dock.querySelector("[data-selected-question-preview]");
  const selectionLabel = dock.querySelector("[data-selected-question-label]");
  const selectionAction = document.querySelector("[data-selection-question-context]");
  const alternativesAction = document.querySelector("[data-suggest-alternatives]");
  let selectedPassage = null;
  let menuTarget = null;

  function reflectContext() {
    const selected = contextMode.value === "selection";
    const busy = dock.dataset.busy === "true" || requestController !== null;
    selectionPanel.hidden = !selected;
    dock.querySelector("[data-project-context-range]").hidden = selected;
    contextMode.querySelector('[value="selection"]').disabled = !selectedPassage;
    selectionPreview.textContent = selectedPassage?.quote || "Select a passage again, or use project context.";
    selectionLabel.textContent = selectedPassage ? "Selected passage only" : "Selected passage changed";
    submit.disabled = busy || (selected && !selectedPassage);
    contextMode.disabled = busy;
    dock.querySelector("[data-clear-question-context]").disabled = busy;
    selectionAction.disabled = busy || !menuTarget?.range?.quote?.trim() || !menuTarget.canReplace
      || !menuTarget.isCurrent() || Array.from(menuTarget.range.quote).length > 100000
      || document.querySelector('[data-workspace]')?.dataset.typewriterMode === "true";
    alternativesAction.disabled = selectionAction.disabled || !menuTarget.range.quote.trim()
      || Array.from(menuTarget.range.quote).length > 4000;
  }
  window.addEventListener("verwrity-context-opened", event => { menuTarget = event.detail; reflectContext(); });
  function captureMenuPassage() {
    const editor = window.verwrityEditor;
    return { ...menuTarget.range, scene_id: editor.sceneId,
      project_id: document.querySelector('[data-workspace]').dataset.projectId, sourceText: editor.getText() };
  }
  function revealQuestionDock() {
    document.querySelector("[data-wiki-selection-menu]").hidden = true;
    dock.querySelector(".project-question-options").open = false;
    // Reveal the existing dock through normal layout controls, preserving each
    // writing mode's remembered preferences.
    if (document.querySelector('[data-workspace]').dataset.focusMode === "focus") document.querySelector("[data-exit-focus]")?.click();
    if (document.body.dataset.editorMaximized === "true") document.querySelector("[data-restore-editor]")?.click();
  }
  selectionAction.addEventListener("click", () => {
    if (selectionAction.disabled || !menuTarget?.isCurrent()) return;
    selectedPassage = captureMenuPassage();
    contextMode.value = "selection";
    revealQuestionDock();
    reflectContext();
    status.textContent = "Passage selected. Type your question and press Ask.";
    form.elements.namedItem("question").focus({ preventScroll: true });
  });
  alternativesAction.addEventListener("click", () => {
    if (alternativesAction.disabled || !menuTarget?.isCurrent()) return;
    const selection = captureMenuPassage();
    revealQuestionDock();
    runQuestion(null, selection);
  });
  dock.querySelector("[data-clear-question-context]").addEventListener("click", () => {
    selectedPassage = null;
    contextMode.value = "project";
    reflectContext();
    status.textContent = "Using your project context settings.";
  });
  contextMode.addEventListener("change", reflectContext);
  function invalidateSelectedContext() {
    if (!selectedPassage) return;
    selectedPassage = null;
    menuTarget = null;
    reflectContext();
  }
  window.addEventListener("verwrity-editor-change", invalidateSelectedContext);
  window.addEventListener("verwrity-editor-source-changed", invalidateSelectedContext);
  reflectContext();

  function rememberConversation() {
    // Tab-scoped, project-scoped UI state; answers never enter the project archive.
    try {
      sessionStorage.setItem(conversationKey, JSON.stringify({ turns: history.slice(-8), hidden: transcript.hidden }));
    } catch (_) { /* Questions remain usable when storage is unavailable. */ }
  }

  function createTurn(question) {
    const turn = document.createElement("article");
    turn.className = "project-question-turn";
    const asked = document.createElement("h4");
    asked.textContent = question;
    const answer = document.createElement("p");
    answer.className = "project-question-answer-text";
    turn.append(asked, answer);
    transcript.append(turn);
    clearAnswer.disabled = dock.dataset.busy === "true";
    return { turn, answer };
  }

  async function refreshReadAloudAvailability() {
    try {
      const response = await fetch("/ai/models", { credentials: "same-origin" });
      if (!response.ok) throw new Error("settings unavailable");
      const { settings } = await response.json();
      const tts = settings.tts;
      const available = tts.provider === "kokoro_local"
        ? Boolean(tts.kokoro_model_ready || (tts.model_path && tts.voices_path))
        : Boolean(tts.remote_consent && (tts.provider !== "google_cloud_tts" || tts.google_api_key_configured));
      readAloudRemote = available && tts.provider !== "kokoro_local";
      readAloud.disabled = !available;
      if (readAloudHelp) readAloudHelp.textContent = available
        ? (tts.provider === "kokoro_local" ? "Uses your configured local TTS model." : "This sends the completed answer to your configured online TTS provider.")
        : "Configure a ready TTS provider in AI Models to enable.";
    } catch (_) {
      readAloudRemote = false;
      readAloud.disabled = true;
      if (readAloudHelp) readAloudHelp.textContent = "TTS settings could not be loaded.";
    }
  }

  async function readAnswerAloud(text) {
    if (document.querySelector('[data-workspace]')?.dataset.typewriterMode === "true") return;
    if (!readAloud.checked || readAloud.disabled || !text.trim()) return;
    progressTitle.textContent = "Preparing answer audio";
    progressMessage.textContent = readAloudRemote
      ? "Sending the completed answer to your online TTS provider…"
      : "Generating speech locally…";
    progressDismissed = false;
    progress.hidden = false;
    try {
      const response = await fetch("/ai/read-answer", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Could not read the answer aloud.");
      }
      const played = await window.verwrityPlayAudioBlob(await response.blob());
      progressMessage.textContent = played ? "Reading the completed answer aloud…" : "Answer audio is ready in the playback controls.";
      status.textContent = played ? "Reading the completed answer aloud." : "Answer audio is ready. Use the playback controls to listen.";
    } catch (error) {
      status.textContent = `Answer received, but speech could not be prepared: ${error.message}`;
    } finally {
      progress.hidden = true;
      progressTitle.textContent = "Asking about the project";
    }
  }

  for (const [name, target] of [["before_percent", "[data-before-value]"], ["after_percent", "[data-after-value]"]]) {
    const input = form.elements.namedItem(name);
    input.addEventListener("input", () => { dock.querySelector(target).value = `${input.value}%`; });
  }
  form.elements.namedItem("question").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  document.querySelector("[data-dismiss-project-question-progress]")?.addEventListener("click", () => {
    progressDismissed = true;
    progress.hidden = true;
  });
  hideAnswer?.addEventListener("click", () => {
    transcript.hidden = !transcript.hidden;
    hideAnswer.textContent = transcript.hidden ? "Show answer" : "Hide answer";
    hideAnswer.setAttribute("aria-label", hideAnswer.textContent);
    hideAnswer.setAttribute("aria-expanded", String(!transcript.hidden));
    rememberConversation();
  });
  clearAnswer.addEventListener("click", () => {
    if (dock.dataset.busy === "true") return;
    history = [];
    transcript.replaceChildren();
    transcript.hidden = true;
    hideAnswer.hidden = true;
    clearAnswer.disabled = true;
    status.textContent = "Conversation cleared.";
    try { sessionStorage.removeItem(conversationKey); } catch (_) { /* Storage is optional. */ }
  });

  dock.querySelector(".project-question-options")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) refreshReadAloudAvailability();
  });
  taskButtons.forEach(button => button.addEventListener("click", () => runQuestion(button)));
  cancel.addEventListener("click", () => requestController?.abort());
  document.addEventListener("click", event => {
    if (!taskMenu.contains(event.target)) taskMenu.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") taskMenu.open = false;
  });

  function showProgress(message) {
    progressMessage.textContent = message;
    if (!progressDismissed) progress.hidden = false;
    status.textContent = "The model is working. You can keep editing.";
    dock.dataset.busy = "true";
  }

  function endProgress(message) {
    progress.hidden = true;
    dock.dataset.busy = "false";
    status.textContent = message;
    progressDismissed = false;
  }

  function formatElapsed(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function updateModelProgress() {
    const now = Date.now();
    const elapsed = formatElapsed(now - modelStartedAt);
    if (!modelHasStreamedText) {
      const waiting = now - modelStartedAt >= 120000
        ? `No answer text yet after ${elapsed}. The model may be processing context or stalled; Verwrity cannot see its internal progress.`
        : `Waiting for the model’s first answer text · ${elapsed}.`;
      progressMessage.textContent = [waiting, contextSummary].filter(Boolean).join(" ");
    } else {
      const quietFor = formatElapsed(now - lastStreamedAt);
      progressMessage.textContent = now - lastStreamedAt >= 30000
        ? `No new answer text for ${quietFor}; ${streamedCharacterCount.toLocaleString()} characters received. The model may be thinking or stalled; internal progress is unavailable.`
        : `Receiving answer · ${streamedCharacterCount.toLocaleString()} characters · ${elapsed} elapsed`;
    }
  }

  function startModelProgress() {
    modelStartedAt = Date.now();
    streamedCharacterCount = 0;
    modelHasStreamedText = false;
    contextSummary = "";
    updateModelProgress();
    modelActivityTimer = window.setInterval(updateModelProgress, 1000);
  }

  function stopModelProgress() {
    if (modelActivityTimer !== null) window.clearInterval(modelActivityTimer);
    modelActivityTimer = null;
  }

  function appendEvidence(turn, evidenceList) {
    const sources = document.createElement("div");
    sources.className = "project-question-sources";
    const heading = document.createElement("h4");
    heading.textContent = "Relevant passages";
    sources.append(heading);
    for (const evidence of evidenceList || []) {
      const card = document.createElement("blockquote");
      const label = document.createElement("strong");
      label.textContent = `${evidence.source_type === "scene" ? "Scene" : "Wiki"}: ${evidence.title}`;
      const quote = document.createElement("p");
      quote.textContent = `“${evidence.quote}”`;
      card.append(label, quote);
      if (evidence.source_type === "scene") {
        const jump = document.createElement("form");
        jump.method = "post";
        jump.action = `/scene/select/${encodeURIComponent(evidence.source_id)}`;
        for (const [name, value] of [["ai_start", evidence.start], ["ai_end", evidence.end], ["ai_quote", evidence.quote]]) {
          const input = document.createElement("input");
          input.type = "hidden"; input.name = name; input.value = String(value); jump.append(input);
        }
        const button = document.createElement("button");
        button.type = "submit"; button.textContent = "Go to passage";
        jump.addEventListener("submit", async (event) => {
          event.preventDefault();
          button.disabled = true;
          try {
            if (window.verwrityShowSceneHead && !(await window.verwrityShowSceneHead())) return;
            if (window.verwritySaveActiveScene && !(await window.verwritySaveActiveScene())) {
              status.textContent = "The draft could not be saved. Please retry before navigating.";
              return;
            }
            rememberConversation();
            if (window.verwrityEditor?.sceneId === evidence.source_id) {
              if (!window.verwrityEditor.highlightSourceQuote(evidence.quote, evidence.start, evidence.end)) {
                status.textContent = "This passage has changed since the answer. Ask again to refresh its evidence.";
                return;
              }
              status.textContent = "Relevant passage highlighted in the manuscript.";
            } else {
              if (await window.verwrityWiki?.prepareSceneNavigation() === false) return;
              window.verwrityAllowUnload?.();
              jump.submit();
            }
          } catch (error) {
            status.textContent = `Could not navigate to the passage: ${error.message}`;
          } finally { button.disabled = false; }
        });
        jump.append(button); card.append(jump);
      } else {
        const open = document.createElement("button");
        open.type = "button"; open.textContent = "Open wiki page";
        open.addEventListener("click", () => window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", { detail: evidence.source_id })));
        card.append(open);
      }
      sources.append(card);
    }
    if (!evidenceList?.length) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "No exact source passage was returned for this answer.";
      sources.append(none);
    }
    turn.append(sources);
  }

  try {
    const saved = JSON.parse(sessionStorage.getItem(conversationKey) || "null");
    for (const item of saved?.turns || []) {
      if (typeof item.question !== "string" || typeof item.answer !== "string" || !Array.isArray(item.evidence)) continue;
      history.push(item);
      const { turn, answer } = createTurn(item.question);
      answer.textContent = item.answer;
      appendEvidence(turn, item.evidence);
    }
    if (history.length) {
      transcript.hidden = Boolean(saved.hidden);
      hideAnswer.hidden = false;
      hideAnswer.textContent = transcript.hidden ? "Show answer" : "Hide answer";
      hideAnswer.setAttribute("aria-label", hideAnswer.textContent);
      hideAnswer.setAttribute("aria-expanded", String(!transcript.hidden));
    }
  } catch (_) { /* Discard malformed or unavailable tab state. */ }

  async function consumeEvents(response, answerNode, turn) {
    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "The question could not be answered.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "", answer = "", finalResult = null;
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const chunks = pending.split("\n\n");
      pending = chunks.pop();
      for (const chunk of chunks) {
        const line = chunk.split("\n").find(item => item.startsWith("data:"));
        if (!line) continue;
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === "status") {
          const estimate = event.estimated_context_tokens.toLocaleString();
          const characters = event.context_characters.toLocaleString();
          contextSummary = `Context: ${characters} characters across ${event.scene_count} scenes and ${event.wiki_count} wiki pages (about ${estimate} tokens, estimated).`;
          updateModelProgress();
        } else if (event.type === "delta") {
          answer += event.text;
          modelHasStreamedText = true;
          streamedCharacterCount += event.text.length;
          lastStreamedAt = Date.now();
          updateModelProgress();
          answerNode.textContent = answer;
          transcript.scrollTop = transcript.scrollHeight;
        } else if (event.type === "result") finalResult = event.result;
        else if (event.type === "error") throw new Error(event.error || "The question could not be answered.");
      }
      if (done) break;
    }
    if (!finalResult) throw new Error("The model connection ended before a complete answer arrived.");
    answerNode.textContent = finalResult.answer;
    appendEvidence(turn, finalResult.evidence);
    return finalResult;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runQuestion();
  });

  async function runQuestion(taskButton = null, alternativeSelection = null) {
    if (document.querySelector('[data-workspace]')?.dataset.typewriterMode === "true") return;
    const taskId = taskButton?.dataset.manuscriptTask;
    const selectedWords = alternativeSelection ? Array.from(alternativeSelection.quote) : [];
    const question = alternativeSelection
      ? `Suggest alternatives for “${selectedWords.slice(0, 120).join("")}${selectedWords.length > 120 ? "…" : ""}”`
      : taskId ? `${taskButton.dataset.taskName} — whole manuscript`
      : String(form.elements.namedItem("question").value || "").trim();
    if (!question || dock.dataset.busy === "true" || requestController !== null) return;
    const selection = alternativeSelection || (!taskId && contextMode.value === "selection" ? selectedPassage : null);
    if (!taskId && contextMode.value === "selection" && !selection) return;
    dock.querySelector(".project-question-options").open = false;
    taskMenu.open = false;
    submit.disabled = true;
    taskButtons.forEach(button => { button.disabled = true; });
    requestController = new AbortController();
    const signal = requestController.signal;
    cancel.hidden = false;
    progressTitle.textContent = alternativeSelection ? "Suggesting alternative wording"
      : taskId ? `${taskButton.dataset.taskName} — whole manuscript` : "Asking about the project";
    showProgress("Saving the current draft…");
    reflectContext();
    const { turn, answer } = createTurn(question);
    transcript.hidden = false;
    hideAnswer.hidden = false;
    hideAnswer.textContent = "Hide answer";
    hideAnswer.setAttribute("aria-label", "Hide answer");
    hideAnswer.setAttribute("aria-expanded", "true");
    try {
      if (window.verwritySaveActiveScene && !(await window.verwritySaveActiveScene())) {
        throw new Error("The current draft could not be saved, so the question was not sent.");
      }
      signal.throwIfAborted();
      if (selection && ((!alternativeSelection && selection !== selectedPassage)
          || selection.sourceText !== window.verwrityEditor?.getText()
          || selection.scene_id !== window.verwrityEditor?.sceneId
          || selection.project_id !== document.querySelector('[data-workspace]').dataset.projectId)) {
        throw new Error("The selected passage changed. Select it again before asking.");
      }
      const data = new FormData(form);
      progressMessage.textContent = "Connecting to the model…";
      startModelProgress();
      const request = fetch("/ai/ask/stream", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(taskId ? { task_id: taskId } : selection ? {
          ...(alternativeSelection ? { request_kind: "alternatives" } : { question }),
          context_mode: "selection", selected_context: {
            project_id: selection.project_id, scene_id: selection.scene_id,
            start: selection.start, end: selection.end, quote: selection.quote,
            source_hash: window.verwritySceneHash(),
          },
        } : {
          question, before_percent: Number(data.get("before_percent")),
          after_percent: Number(data.get("after_percent")), include_wiki: data.get("include_wiki") === "on",
          history: history.slice(-8).map(({ question, answer }) => ({ question, answer })),
        }),
      });
      const response = await request;
      const result = await consumeEvents(response, answer, turn);
      signal.throwIfAborted();
      history.push({ question, answer: result.answer, evidence: result.evidence });
      rememberConversation();
      if (!taskId && !alternativeSelection) form.elements.namedItem("question").value = "";
      endProgress(alternativeSelection ? "Optional wording suggestions received. Your manuscript is unchanged."
        : taskId ? "Manuscript review received. These are AI observations; compare the cited passages."
        : "Answer received. Check the cited passages against your project.");
      cancel.hidden = true;
      await readAnswerAloud(result.answer);
    } catch (error) {
      const message = signal.aborted ? "Cancelled in this tab. The provider may finish an already-started request." : error.message;
      answer.textContent = message;
      answer.classList.add("project-question-error");
      endProgress(message);
    } finally {
      stopModelProgress();
      submit.disabled = false;
      taskButtons.forEach(button => { button.disabled = false; });
      requestController = null;
      cancel.hidden = true;
      clearAnswer.disabled = !transcript.childElementCount;
      reflectContext();
      transcript.scrollTop = transcript.scrollHeight;
    }
  }
}
