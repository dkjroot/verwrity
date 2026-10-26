/* AI model settings keep local defaults and save remote consent once. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

function silentWav() {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2 * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.addInitScript(() => {
      window.__sceneAudioStartTimes = [];
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (this.matches("[data-scene-audio]")) window.__sceneAudioStartTimes.push(this.currentTime);
        return originalPlay.call(this);
      };
    });
    await page.goto(url);
    assert.equal(await page.locator("[data-scene-audio-status]").isVisible(), false, "preparation banner is hidden on page load");
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.locator(".settings-menu > summary").click();
    await page.locator("[data-ai-models-open]").click();
    await page.waitForFunction(() => document.querySelector('[data-ai-settings-status]').textContent === "");
    const dialog = page.locator("#ai-models-dialog");
    assert.equal(await dialog.isVisible(), true);
    assert.deepEqual(await dialog.locator("[data-ai-tab]").allTextContents(), ["Text-to-speech", "Speech-to-text", "LLM", "OCR"]);
    await dialog.locator('[data-ai-tab="stt"]').click();
    assert.match(await dialog.locator('[data-stt-disclosure]').innerText(), /speech recognition stays local/);
    await dialog.locator('[data-ai-tab="tts"]').click();
    await dialog.locator("[data-ai-provider]").selectOption("google_cloud_tts");
    assert.equal(await dialog.locator("[data-ai-remote-fields]").isVisible(), true);
    await dialog.locator('[name="google_api_key"]').fill("test-api-key");
    await dialog.locator('[data-ai-tts-form] [name="remote_consent"]').uncheck();
    await dialog.locator('[data-ai-tts-form] button[type="submit"]').click();
    await page.waitForFunction(() => /Acknowledge/.test(document.querySelector("[data-ai-settings-status]")?.textContent || ""));
    await dialog.locator('[data-ai-tts-form] [name="remote_consent"]').check();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/ai/models/tts") && response.status() === 200),
      dialog.locator('[data-ai-tts-form] button[type="submit"]').click(),
    ]);
    const persisted = await page.request.get(`${url}/ai/models`).then(response => response.json());
    assert.equal(persisted.settings.tts.provider, "google_cloud_tts");
    assert.equal(persisted.settings.tts.remote_consent, true);
    assert.equal(persisted.settings.tts.google_api_key, "", "secret key is never returned to the browser");
    assert.equal(persisted.settings.tts.google_api_key_configured, true);

    await dialog.locator("[data-ai-provider]").selectOption("edge_tts");
    assert.match(await dialog.locator("[data-provider-disclosure]").innerText(), /LLM answers when Read completed answers aloud is enabled/);
    assert.equal(await dialog.locator('[name="google_api_key"]').isVisible(), false);
    assert.equal(await dialog.locator('[data-ai-tts-form] [name="remote_consent"]').isChecked(), false, "consent does not carry to a different remote provider");
    await dialog.locator('[data-ai-tts-form] [name="remote_consent"]').check();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/ai/models/tts") && response.status() === 200),
      dialog.locator('[data-ai-tts-form] button[type="submit"]').click(),
    ]);
    const edgeSettings = await page.request.get(`${url}/ai/models`).then(response => response.json());
    assert.equal(edgeSettings.settings.tts.provider, "edge_tts");
    assert.equal(edgeSettings.settings.tts.remote_consent, true);

    await dialog.locator("[data-ai-models-close]").click();
    let readRequests = 0;
    let releaseGeneration;
    let markRequestStarted;
    const requestStarted = new Promise(resolve => { markRequestStarted = resolve; });
    await page.route("**/read-aloud", async route => {
      readRequests += 1;
      markRequestStarted();
      await new Promise(resolve => { releaseGeneration = resolve; });
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
    });
    const readResponse = page.waitForResponse(response => response.url().includes("/read-aloud"));
    await page.locator("[data-read-scene]").click();
    const processing = page.locator("[data-scene-audio-status]");
    await processing.waitFor({ state: "visible" });
    assert.match(await processing.innerText(), /Preparing scene audio/);
    await requestStarted;
    releaseGeneration();
    await readResponse;
    assert.equal(readRequests, 1, "saved consent lets read-aloud proceed without a per-use dialog");
    assert.equal(await page.locator("#remote-read-dialog").count(), 0);
    await page.locator("[data-scene-audio-playback]").waitFor({ state: "visible" });
    await page.waitForFunction(() => window.__sceneAudioStartTimes.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__sceneAudioStartTimes), [0], "new audio playback starts after seeking to its beginning");
    await processing.waitFor({ state: "hidden" });
    assert.equal(await processing.isVisible(), false, "preparation banner hides once playback is ready");
    await page.locator("[data-clear-scene-audio]").click();
    assert.equal(await page.locator("[data-scene-audio-playback]").isVisible(), false);
    assert.equal(await page.locator("[data-scene-audio]").getAttribute("src"), null);

    await page.locator(".settings-menu > summary").click();
    await page.locator("[data-ai-models-open]").click();
    await page.waitForFunction(() => document.querySelector('[data-ai-settings-status]').textContent === "");
    await dialog.locator('[data-ai-tab="llm"]').click();
    const llm = dialog.locator("[data-ai-llm-form]");
    await llm.locator('[name="endpoint"]').fill("localhost:8081");
    await llm.locator('[name="model"]').focus();
    await llm.locator('[name="model"]').fill("local-test-model");
    await llm.locator('[name="token"]').fill("");
    assert.equal(await llm.locator('[name="remote_consent"]').isVisible(), false, "loopback endpoints do not show online consent");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/ai/models/llm") && response.status() === 200),
      llm.locator('button[type="submit"]').click(),
    ]);
    const llmSettings = await page.request.get(`${url}/ai/models`).then(response => response.json());
    assert.equal(llmSettings.settings.llm.endpoint, "http://localhost:8081/v1");
    assert.equal(llmSettings.settings.llm.token, "", "LLM tokens are never returned to the browser");

    await dialog.locator("[data-ai-models-close]").click();
    const editor = page.locator("[data-rich-editor]");
    const sceneId = await editor.getAttribute("data-scene-id");
    const passage = (await editor.getAttribute("data-initial-text")).slice(0, 24);
    const otherSceneId = await page.locator(".scene-row[data-scene-id]").nth(1).getAttribute("data-scene-id");
    const otherPrefix = "A lantern 🕯️ waited.\n\n";
    const otherPassage = "Mara found the lantern.\nIts light was blue.";
    const otherText = otherPrefix + otherPassage;
    await page.request.post(`${url}/scene/${otherSceneId}/text`, { form: { scene_text: "An older revision without the quoted passage." } });
    const oldRevision = await page.request.post(`${url}/scene/${otherSceneId}/revisions/record`).then(response => response.json());
    await page.request.post(`${url}/scene/${otherSceneId}/text`, { form: { scene_text: otherText } });
    const otherStart = Array.from(otherPrefix).length;
    await page.evaluate(({ sceneId, passage, otherSceneId, otherPassage, otherStart }) => {
      const originalFetch = window.fetch.bind(window);
      window.__questionStreamStarted = false;
      window.__releaseQuestionStream = null;
      window.fetch = (input, options) => {
        if (!String(input).endsWith("/ai/ask/stream")) return originalFetch(input, options);
        window.__questionStreamStarted = true;
        const encoder = new TextEncoder();
        const encode = event => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encode({ type: "status", context_characters: 12000, estimated_context_tokens: 3000, scene_count: 4, wiki_count: 2 }));
            window.setTimeout(() => controller.enqueue(encode({ type: "delta", text: "A test answer " })), 1300);
            window.__releaseQuestionStream = () => {
              controller.enqueue(encode({ type: "delta", text: "from the configured local model." }));
              controller.enqueue(encode({ type: "result", result: { answer: "A test answer from the configured local model.", evidence: [
                { source_type: "scene", source_id: sceneId, title: "Opening", quote: passage, start: 0, end: passage.length },
                { source_type: "scene", source_id: otherSceneId, title: "Another scene", quote: otherPassage, start: otherStart, end: otherStart + Array.from(otherPassage).length },
              ] } }));
              controller.close();
            };
          },
        });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      };
    }, { sceneId, passage, otherSceneId, otherPassage, otherStart });
    const questionDock = page.locator("[data-project-question-dock]");
    assert.equal(await questionDock.isVisible(), true, "project Q&A is always available below the manuscript");
    await page.request.post(`${url}/ai/models/tts`, { data: {
      provider: "kokoro_local", model_path: "/tmp/test-kokoro.onnx", voices_path: "/tmp/test-voices.bin",
    } });
    await questionDock.locator(".project-question-options > summary").click();
    await page.waitForFunction(() => !document.querySelector('[name="read_aloud"]')?.disabled);
    await questionDock.locator(".project-question-options > summary").click();
    await page.request.post(`${url}/ai/models/tts`, { data: {
      provider: "edge_tts", remote_consent: true,
    } });
    await questionDock.locator(".project-question-options > summary").click();
    await page.waitForFunction(() => !document.querySelector('[name="read_aloud"]')?.disabled);
    assert.equal(await questionDock.locator('[name="include_wiki"]').isVisible(), true, "context controls pop up from the dock");
    assert.equal(await questionDock.locator('[name="include_wiki"]').evaluate(input => getComputedStyle(input.parentElement).display), "flex", "the wiki option keeps its checkbox beside the label");
    await page.waitForFunction(() => !document.querySelector('[name="read_aloud"]')?.disabled);
    assert.equal(await questionDock.locator('[name="read_aloud"]').isEnabled(), true, "a configured and consented TTS provider enables answer reading");
    await questionDock.locator('[name="read_aloud"]').check();
    await questionDock.locator('[name="question"]').fill("Ask a freeform project question");
    let spokenAnswerText = "";
    await page.route("**/ai/read-answer", async route => {
      spokenAnswerText = route.request().postDataJSON().text;
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() });
    });
    await questionDock.locator('button[type="submit"]').click();
    await page.waitForFunction(() => window.__questionStreamStarted);
    assert.equal(await questionDock.getByRole('button', { name: 'Clear AI conversation' }).isEnabled(), false, "Clear waits until the active answer finishes");
    const progress = page.locator("[data-project-question-progress]");
    await progress.waitFor({ state: "visible" });
    await page.waitForFunction(() => /Waiting for the model’s first answer text · 00:01/.test(document.querySelector("[data-project-question-progress-message]")?.textContent || ""));
    assert.match(await progress.locator("[data-project-question-progress-message]").innerText(), /about 3,000 tokens, estimated/);
    await questionDock.locator(".project-question-answer-text").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".project-question-answer-text")?.textContent === "A test answer ");
    assert.match(await progress.locator("[data-project-question-progress-message]").innerText(), /Receiving answer · 14 characters/);
    assert.equal(await editor.locator(".ProseMirror").getAttribute("contenteditable"), "true", "the manuscript remains editable while the model works");
    await questionDock.getByRole("button", { name: "Hide answer" }).click();
    assert.equal(await questionDock.locator("[data-project-question-answer]").isVisible(), false, "the in-progress response can be hidden");
    await progress.locator("[data-dismiss-project-question-progress]").click();
    assert.equal(await progress.isVisible(), false, "the progress banner can be dismissed while the request continues");
    await page.evaluate(() => window.__releaseQuestionStream());
    await page.waitForResponse(response => response.url().endsWith("/ai/read-answer") && response.status() === 200);
    await page.locator("[data-scene-audio-playback]").waitFor({ state: "visible" });
    assert.equal(spokenAnswerText, "A test answer from the configured local model.", "TTS receives the final answer only after streaming is complete");
    await questionDock.getByRole("button", { name: "Show answer" }).click();
    assert.equal(await questionDock.locator("[data-project-question-answer]").isVisible(), true, "a hidden response can be shown again");
    await page.locator("[data-project-question-answer]").getByText("A test answer from the configured local model.").waitFor();
    assert.equal(await questionDock.getByRole("button", { name: "Go to passage" }).count(), 2);
    const originalText = await page.evaluate(() => window.verwrityEditor.getText());
    await page.evaluate(() => { window.__passageNavigationMarker = true; });
    await page.locator('.editor-viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
    await questionDock.getByRole("button", { name: "Go to passage" }).first().click();
    await page.waitForFunction(() => window.verwrityEditor?.getSelectedRange()?.start === 0);
    assert.equal(await page.evaluate(() => window.__passageNavigationMarker), true, "same-scene evidence does not reload the page");
    assert.equal(await page.locator(".verwrity-ai-passage").innerText(), passage, "the exact cited words are visibly highlighted");
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.editor-viewport').getBoundingClientRect();
      const highlight = document.querySelector('.verwrity-ai-passage').getBoundingClientRect();
      return highlight.top >= viewport.top && highlight.bottom <= viewport.bottom;
    });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalText, "highlighting never changes the canonical text");
    const highlightToggle = page.getByRole('button', { name: 'AI passage highlighting' });
    await questionDock.getByRole('button', { name: 'Hide answer' }).click();
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), passage, "hiding the answer preserves the passage highlight");
    assert.equal(await highlightToggle.isVisible(), true, "the highlight control is available with the answer hidden");
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    assert.equal(await highlightToggle.isVisible(), false, "Typewriter Mode hides the AI highlight control");
    await page.locator('.writing-restore-controls > summary').click();
    await page.locator('[data-exit-focus]').click();
    assert.equal(await highlightToggle.isVisible(), true, "leaving focus restores the highlight control");
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), passage, "focus changes retain the matched passage");
    await highlightToggle.click();
    assert.equal(await highlightToggle.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.verwrity-ai-passage').count(), 0, "the toggle hides the highlight");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getSelectedRange()), null, "switching off also collapses the passage selection");
    assert.equal(await page.evaluate(() => document.getSelection().toString()), "", "no native browser highlight remains");
    await highlightToggle.click();
    assert.equal(await highlightToggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), passage, "turning it back on restores the same passage");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalText, "toggling never modifies manuscript text");
    await highlightToggle.click();
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(0, 1));
    await page.evaluate(() => {
      window.verwrityEditor.focus();
      window.__keyboardReadyAt = Date.now() + 225;
    });
    // ProseMirror restores a selection collapsed to document start within
    // 200 ms of focus. Wait beyond that guard and Tiptap's deferred focus.
    await page.waitForFunction(() => Date.now() >= window.__keyboardReadyAt
      && document.getSelection().toString() === 'P');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.verwrityEditor.getSelectedRange() === null);
    await page.keyboard.type('Prefix ');
    assert.equal(await page.locator('.verwrity-ai-passage').count(), 0, "editing keeps hidden highlighting disabled");
    await highlightToggle.click();
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), passage, "hidden ranges track edits before being shown again");
    await questionDock.getByRole('button', { name: 'Show answer' }).click();

    // Editing before the quote invalidates its old offsets; locate its exact text again.
    await page.evaluate(() => {
      window.verwrityEditor.setText("New prefix 🕯️.\n\n" + window.verwrityEditor.getText());
      window.dispatchEvent(new CustomEvent("verwrity-editor-change"));
    });
    await questionDock.getByRole("button", { name: "Go to passage" }).first().click();
    await page.waitForFunction(() => document.querySelector('[data-project-question-status]').textContent.includes('highlighted'));
    assert.equal(await page.locator(".verwrity-ai-passage").innerText(), passage, "stale offsets relocate to the evidence after edits and Unicode");
    await questionDock.getByRole("button", { name: "Hide answer" }).click();
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    assert.equal(await questionDock.getByRole("button", { name: "Show answer" }).isVisible(), true, "hidden transcript state survives reload");
    await questionDock.getByRole("button", { name: "Show answer" }).click();
    assert.equal(await questionDock.locator(".project-question-answer-text").innerText(), "A test answer from the configured local model.");
    await Promise.all([
      page.waitForURL(`${url}/?ai_start=${otherStart}&ai_end=${otherStart + Array.from(otherPassage).length}`),
      questionDock.getByRole("button", { name: "Go to passage" }).nth(1).click(),
    ]);
    await page.waitForFunction(id => window.verwrityEditor?.sceneId === id, otherSceneId);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.locator(".verwrity-ai-passage").first().waitFor({ state: "visible" });
    assert.equal(await highlightToggle.getAttribute('aria-pressed'), 'true', "cross-scene passage navigation enables the toggle");
    for (let attempt = 0; attempt < 2; attempt++) {
      await highlightToggle.click();
      assert.equal(await page.locator('.verwrity-ai-passage').count(), 0, "one click removes all fragments of a multiline highlight");
      assert.equal(await page.evaluate(() => document.getSelection().toString()), "", "multiline selection cannot leave another colour behind");
      await highlightToggle.click();
      assert.equal(await page.locator('.verwrity-ai-passage').allTextContents().then(parts => parts.join('')), otherPassage.replace('\n', ''), "one click restores every fragment");
    }
    assert.equal(await page.locator(".verwrity-ai-passage").allTextContents().then(parts => parts.join("")), otherPassage.replace("\n", ""), "multiline citation highlights the target words");
    assert.equal(await questionDock.locator(".project-question-answer-text").innerText(), "A test answer from the configured local model.", "answer survives navigation to a different scene");
    assert.equal(await questionDock.getByRole("button", { name: "Go to passage" }).count(), 2, "restored citations remain actionable");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), otherText, "cross-scene highlighting preserves source text");
    await page.locator(".versions-menu").evaluate(element => { element.open = true; });
    await page.locator("[data-scene-revision-select]").selectOption(oldRevision.revision.id);
    await page.waitForFunction(() => window.verwrityEditor.getText() === "An older revision without the quoted passage.");
    await questionDock.getByRole("button", { name: "Go to passage" }).nth(1).click();
    await page.waitForFunction(() => window.verwrityEditor.getSelectedRange()?.quote === "Mara found the lantern.\nIts light was blue.");
    assert.equal(await page.locator("[data-scene-revision-select]").inputValue(), "head", "citations navigate to the current head from revision preview");
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    const revisionHistory = await page.locator('[data-revision-list]').textContent().then(JSON.parse);
    assert.equal(revisionHistory[0].text, "An older revision without the quoted passage.", "navigation preserves historical revisions");
    await page.evaluate(() => {
      window.verwrityEditor.setText("The passage has been removed.");
      window.dispatchEvent(new CustomEvent("verwrity-editor-change"));
    });
    await questionDock.getByRole("button", { name: "Go to passage" }).nth(1).click();
    await page.waitForFunction(() => document.querySelector('[data-project-question-status]').textContent.includes('passage has changed'));
    assert.equal(await page.locator(".verwrity-ai-passage").count(), 0, "removed evidence never highlights unrelated text");
    assert.equal(await highlightToggle.isVisible(), false, "there is no toggle for a removed passage");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "The passage has been removed.");
    await page.locator("[data-focus-toggle]").click();
    await page.locator("[data-typewriter-toggle]").click();
    assert.equal(await questionDock.isVisible(), false, "Typewriter Mode hides the AI conversation");
    await page.evaluate(() => { document.querySelector('[data-project-question-progress]').hidden = false; });
    assert.equal(await progress.isVisible(), false, "AI progress cannot distract in Typewriter Mode");
    await page.locator('.writing-restore-controls > summary').click();
    await page.locator("[data-exit-focus]").click();
    assert.equal(await questionDock.isVisible(), true, "leaving Typewriter Mode restores the conversation");
    assert.equal(await questionDock.locator(".project-question-answer-text").innerText(), "A test answer from the configured local model.");
    await questionDock.getByRole('button', { name: 'Clear AI conversation' }).click();
    assert.equal(await questionDock.locator('.project-question-turn').count(), 0, "Clear removes answers and citations");
    await page.reload();
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    assert.equal(await questionDock.locator('.project-question-turn').count(), 0, "cleared conversation does not return after reload");
    let freshHistory;
    await page.route('**/ai/ask/stream', async route => {
      freshHistory = route.request().postDataJSON().history;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'result', result: { answer: 'Fresh answer', evidence: [] } })}\n\n` });
    });
    await questionDock.locator('[name="question"]').fill('Start a fresh conversation');
    await questionDock.locator('[data-project-question-submit]').click();
    await questionDock.getByText('Fresh answer', { exact: true }).waitFor();
    assert.deepEqual(freshHistory, [], "clearing excludes previous answers from the next model request");
    await page.request.post(`${url}/project/new`, { form: { project_title: "Different project" } });
    await page.goto(url);
    assert.equal(await questionDock.locator(".project-question-answer-text").count(), 0, "conversation is scoped to its project");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
