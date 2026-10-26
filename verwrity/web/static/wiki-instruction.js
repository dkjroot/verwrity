import { post } from "./wiki-ai.js";

// This control owns only request state; the server owns permissions and edits.
export function wikiInstruction(page, saveSnapshot, onUpdate) {
  const host = document.createElement("details"); host.className = "wiki-ai-controls wiki-instruction";
  const heading = document.createElement("summary"); heading.textContent = "Instruct the LLM";
  const description = document.createElement("p");
  description.textContent = '“Run instruction” saves your current page and scene edits first.';
  const label = document.createElement("label"); label.textContent = "Instruction";
  const input = document.createElement("textarea"); input.rows = 3; input.maxLength = 8000;
  input.dataset.dictationInput = "wiki-instruction"; input.dataset.wikiInstruction = "";
  input.placeholder = "Tidy the grammar and formatting, expand the background, or carry out the task notes on this page…";
  label.append(input);
  const contextLabel = document.createElement("label"); contextLabel.textContent = "AI context";
  const scope = document.createElement("select"); scope.name = "instruction_scope";
  for (const [value, text] of [["page", "Wiki page only"], ["scene", "Wiki page + current scene"],
    ["range", "Wiki page + current scene and surrounding scenes"], ["manuscript", "Wiki page + whole manuscript"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = text; scope.append(option);
  }
  contextLabel.append(scope);
  const ranges = document.createElement("div"); ranges.hidden = true;
  const sliders = ["Earlier manuscript", "Later manuscript"].map(text => {
    const label = document.createElement("label"); label.textContent = text;
    const value = document.createElement("output"); value.textContent = "0%";
    const slider = document.createElement("input"); slider.type = "range"; slider.min = 0; slider.max = 100; slider.step = 5; slider.value = 0;
    slider.addEventListener("input", () => { value.textContent = `${slider.value}%`; });
    label.append(value, slider); ranges.append(label); return slider;
  });
  scope.addEventListener("change", () => { ranges.hidden = scope.value !== "range"; });
  const actions = document.createElement("div"); actions.className = "wiki-page-actions";
  const run = document.createElement("button"); run.type = "button"; run.textContent = "Run instruction";
  const mic = document.createElement("button"); mic.type = "button"; mic.className = "dictation-button";
  mic.dataset.dictationTarget = "wiki-instruction"; mic.textContent = "🎙";
  mic.setAttribute("aria-label", "Start wiki instruction dictation");
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel instruction"; cancel.hidden = true;
  const status = document.createElement("p"); status.className = "wiki-ai-status"; status.setAttribute("role", "status");
  let controller;
  host.cancelRequest = () => {
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    status.textContent = "Instruction cancelled. Saved edits remain; the provider result will be discarded.";
  };
  cancel.addEventListener("click", host.cancelRequest);
  run.addEventListener("click", async () => {
    if (!input.value.trim()) { status.textContent = "Write or dictate an instruction first."; input.focus(); return; }
    const instruction = input.value;
    const request = { action: "instruct", instruction, scope: scope.value,
      before_percent: Number(sliders[0].value), after_percent: Number(sliders[1].value) };
    controller = new AbortController(); const signal = controller.signal;
    run.disabled = input.disabled = scope.disabled = mic.disabled = true; cancel.hidden = false;
    status.textContent = "Saving edits before requesting the instruction…";
    try {
      await saveSnapshot(signal);
      if (signal.aborted || !host.isConnected) return;
      status.textContent = "Carrying out the instruction…";
      const result = await post(`/ai/wiki/${page.id}`, { ...request, page_hash: page.page_hash }, signal);
      if (signal.aborted || !host.isConnected) return;
      status.textContent = "Checking permissions before saving…";
      const updated = await post(`/wiki/page/${page.id}/ai/apply`, { proposal: result.proposal }, signal);
      if (signal.aborted || !host.isConnected) return;
      window.verwrityMarkProjectChanged?.(); onUpdate(updated, result.summary, instruction, request);
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = error.message;
    } finally {
      controller = null;
      run.disabled = input.disabled = scope.disabled = mic.disabled = false; cancel.hidden = true;
    }
  });
  host.restore = (instruction, request) => {
    input.value = instruction || "";
    if (request) {
      scope.value = request.scope; sliders[0].value = request.before_percent; sliders[1].value = request.after_percent;
      sliders.forEach(slider => slider.dispatchEvent(new Event("input")));
      ranges.hidden = scope.value !== "range";
    }
    host.open = true;
  };
  host.snapshot = () => ({ instruction: input.value, request: { scope: scope.value,
    before_percent: Number(sliders[0].value), after_percent: Number(sliders[1].value) } });
  label.append(mic); actions.append(run, cancel); host.append(heading, description, label, contextLabel, ranges, actions, status);
  return host;
}
