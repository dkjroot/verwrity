/* Deterministic microphone lifecycle tests: never record the author's voice. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/ai/models/stt`, { data: { provider: "openai_compatible", endpoint: "localhost:8080", model: "test-whisper", shortcut: "F8" } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__tracksStopped = 0;
      window.__microphoneRequests = 0;
      window.__recordings = 0;
      window.__delayMicrophone = false;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        window.__microphoneRequests++;
        if (window.__delayMicrophone) await new Promise(resolve => { window.__releaseMicrophone = resolve; });
        return { getTracks: () => [{ stop: () => { window.__tracksStopped++; } }] };
      } });
      window.MediaRecorder = class extends EventTarget {
        static isTypeSupported() { return true; }
        constructor() { super(); this.state = "inactive"; this.mimeType = "audio/webm"; }
        start() { this.state = "recording"; window.__recordings++; }
        stop() {
          if (this.state !== "recording") return;
          this.state = "inactive";
          const data = new Event("dataavailable"); data.data = new Blob(["synthetic-audio"], { type: this.mimeType });
          this.dispatchEvent(data);
          queueMicrotask(() => this.dispatchEvent(new Event("stop")));
        }
      };
    });
    let text = "Dictated words.";
    let requests = 0;
    let release;
    let slow = false;
    await page.route("**/ai/transcribe", async route => {
      requests++;
      const body = route.request().postDataBuffer();
      assert(body.includes(Buffer.from("synthetic-audio")));
      if (slow) await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { text } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor?.captureDictationTarget);
    await page.locator(".settings-menu > summary").click();
    await page.locator("[data-ai-models-open]").click();
    await page.waitForFunction(() => document.querySelector("[data-ai-settings-status]").textContent === "");
    await page.locator('[data-ai-tab="stt"]').click();
    const settings = page.locator("[data-ai-stt-form]");
    const initialSTT = await page.request.get(`${url}/ai/models`).then(response => response.json());
    assert.equal(await settings.locator('[name="model_path"]').inputValue(), initialSTT.settings.stt.download_directory, "The empty model field displays the actual default download destination");
    assert.equal(await settings.locator('[name="shortcut"]').inputValue(), "F8");
    // An already-open workspace may have older HTML with newly served scripts.
    await page.evaluate(() => document.querySelector("[data-stt-model-folder-help]").remove());
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/ai/models/stt") && response.status() === 200),
      settings.locator('button[type="submit"]').click(),
    ]);
    await page.waitForFunction(() => document.querySelector("[data-stt-settings-status]").textContent !== "Saving speech-to-text settings…");
    assert.equal(await settings.locator("[data-stt-settings-status]").textContent(), "Speech-to-text settings saved.", "Missing optional helper markup cannot break settings updates");
    assert.equal(await settings.locator("[data-stt-model-folder-help]").count(), 1, "Restore the model-folder explanation for older pages");
    await settings.locator("[data-stt-preset]").selectOption("groq");
    assert.equal(await settings.locator('[name="remote_consent"]').isChecked(), false);
    assert.match(await settings.locator('[data-stt-token-help]').textContent(), /even on its free tier/);
    assert.match(await settings.locator('[data-stt-preset] option:checked').textContent(), /API key required/);
    assert.equal(await settings.locator('[name="token"]').evaluate(input => input.required), true);
    await settings.locator('button[type="submit"]').click();
    assert.equal(await settings.locator('[name="token"]').evaluate(input => input.validity.valueMissing), true, "Empty keys fail form validation before a request");
    await settings.locator('[name="token"]').fill("private-test-token");
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /Acknowledge/.test(document.querySelector("[data-stt-settings-status]").textContent));
    await settings.locator('[name="remote_consent"]').check();
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /settings saved/.test(document.querySelector("[data-stt-settings-status]").textContent));
    const saved = await page.request.get(`${url}/ai/models`).then(response => response.json());
    assert.equal(saved.settings.stt.token, "");
    assert.equal(saved.settings.stt.remote_consent, true);
    assert.equal(saved.settings.stt.token_required, true);
    assert.equal(await settings.locator('[name="token"]').inputValue(), "");
    assert.equal(await settings.locator('[name="token"]').evaluate(input => input.required), false, "Saved keys need not be re-entered");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/ai/models/stt") && response.status() === 200),
      settings.locator('button[type="submit"]').click(),
    ]);
    assert.equal(saved.settings.stt.model_path, "", "Showing the default destination does not configure an uninstalled model");
    await settings.locator('[name="endpoint"]').fill("https://another.example/v1");
    assert.equal(await settings.locator('[name="remote_consent"]').isChecked(), false);
    await settings.locator('[data-stt-preset]').selectOption("openai");
    assert.equal(await settings.locator('[name="token"]').evaluate(input => input.required), true, "A key saved for Groq cannot satisfy OpenAI's requirement");
    await settings.locator("[data-stt-preset]").selectOption("local");
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(() => /settings saved/.test(document.querySelector("[data-stt-settings-status]").textContent));
    await page.locator("[data-ai-models-close]").click();

    const mic = page.locator('[data-dictation-target="manuscript"]');
    await page.evaluate(() => { window.verwrityEditor.setText("Before after"); window.verwrityEditor.selectSourceRange(5, 6); });
    await mic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    assert.equal(await mic.getAttribute("aria-label"), "Stop dictation");
    await mic.click();
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before Dictated words. after", "Insert at original caret without deleting or introducing paragraphs");
    // Insertion focuses Tiptap on its next animation frame; the status banner
    // can disappear before keyboard events are routed back to the manuscript.
    await page.waitForFunction(() => document.querySelector('.ProseMirror') === document.activeElement);
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after", "Dictation is undoable");

    // Transcripts are plain text. HTML entities and markup-like phrases must
    // stay literal, while line breaks retain their canonical source shape.
    for (const dictated of [
      "the universe's most famous planet.",
      'He said "it\'s mine" & left <quietly> with the boy’s coat 😀.',
      "It's one line.\nThat's another & it's literal.",
      "Here's a line.\r\nThat's another.\r\n\r\nThat's a paragraph.",
      'It\'s one paragraph.\n\n"That\'s another," she said.\n\n\n\nThe end.',
      "Literal &#39; &amp; &apos; text stays literal.",
      '<img src="missing" onerror="window.__dictationExecuted=true"> & <script>window.__dictationExecuted=true</script>',
    ]) {
      text = dictated;
      await page.evaluate(() => { window.verwrityEditor.setText("Before after"); window.verwrityEditor.selectSourceRange(5, 6); });
      await mic.click();
      await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
      await mic.click();
      await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
      const canonical = dictated.replace(/\r\n?/g, "\n");
      assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `Before ${canonical} after`,
        "dictation inserts literal punctuation, entities and markup without corrupting prose");
      assert.equal(await page.evaluate(() => window.verwrityEditor.getCaretOffset()), Array.from(`Before ${canonical}`).length,
        "the caret stays immediately after the dictated passage, including Unicode and paragraph breaks");
      assert.equal(await page.locator(".ProseMirror img, .ProseMirror script").count(), 0);
      assert.equal(await page.evaluate(() => Boolean(window.__dictationExecuted)), false);
      await page.waitForFunction(() => document.querySelector(".ProseMirror") === document.activeElement);
      await page.keyboard.press("Control+z");
      assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after", "the entire literal transcript is one undo action");
    }
    const savedTranscript = 'The universe\'s "most famous" planet & its moons.';
    await page.evaluate(value => {
      window.verwrityEditor.setText("");
      window.verwrityEditor.captureDictationTarget().insert(value);
    }, savedTranscript);
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), savedTranscript, "literal dictated punctuation survives save/reload");
    await page.waitForLoadState('networkidle');
    text = "Dictated words.";

    const question = page.locator('[data-project-question-form] textarea[name="question"]');
    const questionMic = page.locator('[data-dictation-target="question"]');
    await question.fill("Ask ");
    await question.focus();
    await page.keyboard.down("F8");
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await page.waitForTimeout(260);
    await page.keyboard.up("F8");
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await question.inputValue(), "Ask Dictated words.", "Holding and releasing transcribes into question without submitting it");

    await question.fill(""); await question.focus();
    await page.keyboard.press("F8");
    await page.keyboard.press("F8");
    await page.waitForFunction(() => document.querySelector("[data-dictation-message]").textContent.includes("latched"));
    await page.waitForTimeout(450);
    assert.equal(await page.locator("[data-dictation-status]").isVisible(), true, "Double press stays latched after both releases");
    await page.keyboard.press("F8");
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await question.inputValue(), "Dictated words.");

    slow = true; text = "Late transcript.";
    await question.fill("Original question");
    await questionMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await questionMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "processing");
    await question.fill("Changed question");
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    release(); release = null;
    await page.locator("[data-dictation-review]").waitFor({ state: "visible" });
    assert.equal(await question.inputValue(), "Changed question");
    assert.equal(await page.locator("[data-dictation-transcript]").inputValue(), "Late transcript.");
    await question.focus();
    await page.locator("[data-dictation-insert]").click();
    assert.equal(await question.inputValue(), "Changed question Late transcript.");
    // Edits to canonical manuscript text must also leave delayed transcripts separate.
    text = "Late manuscript words.";
    await page.evaluate(() => window.verwrityEditor.setText("Original manuscript"));
    await mic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await mic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "processing");
    await page.evaluate(() => window.verwrityEditor.setText("Manually changed manuscript"));
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    release(); release = null;
    await page.locator("[data-dictation-review]").waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Manually changed manuscript");
    await page.locator("[data-dictation-dismiss]").click();
    await page.evaluate(() => window.verwrityEditor.setText("Read-only revision", [], false));
    const beforeReadOnly = await page.evaluate(() => window.__microphoneRequests);
    await mic.click();
    assert.equal(await page.evaluate(() => window.__microphoneRequests), beforeReadOnly, "Read-only revisions cannot start manuscript dictation");
    await page.evaluate(() => window.verwrityEditor.setText("Editable manuscript", [], true));
    slow = false; text = "Wiki words.";

    await page.evaluate(() => {
      const id = document.querySelector("[data-wiki-page]").dataset.wikiPage;
      window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", { detail: id }));
    });
    await page.getByRole("button", { name: "Edit page", exact: true }).click();
    const wiki = page.locator('[data-dictation-input="wiki"]');
    await wiki.fill("Wiki ");
    const wikiMic = page.locator('[data-dictation-target="wiki"]');
    await wikiMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await wikiMic.click();
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await wiki.inputValue(), "Wiki Wiki words.");

    await page.locator(".wiki-instruction summary").click();
    const instruction = page.locator('[data-dictation-input="wiki-instruction"]');
    await instruction.fill("Please "); text = "tidy this page.";
    const instructionMic = page.locator('[data-dictation-target="wiki-instruction"]');
    await instructionMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await instructionMic.click();
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await instruction.inputValue(), "Please tidy this page.");
    assert.equal(await wiki.inputValue(), "Wiki Wiki words.", "Instruction dictation never edits page content");
    await instruction.fill(""); await instruction.focus(); text = "Another instruction.";
    await page.keyboard.down("F8");
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await page.waitForTimeout(260); await page.keyboard.up("F8");
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(await instruction.inputValue(), "Another instruction.", "The usual shortcut works in the instruction box");

    // Reopening a different wiki form removes the original target node.
    slow = true; text = "Late wiki words.";
    await wikiMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await wikiMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "processing");
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Cancel edit", exact: true }).click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    release(); release = null;
    await page.locator("[data-dictation-review]").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-dictation-transcript]").inputValue(), "Late wiki words.");
    await page.locator("[data-dictation-dismiss]").click();
    slow = false;

    const beforeCancel = requests;
    await question.focus();
    await questionMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await page.keyboard.press("Escape");
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(requests, beforeCancel, "Escape discards recording without transcription");

    await questionMic.click();
    await page.waitForFunction(() => document.querySelector("[data-dictation-status]").dataset.phase === "recording");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(requests, beforeCancel, "Focus loss discards recording and closes microphone");

    await page.evaluate(() => { window.__delayMicrophone = true; });
    await question.focus();
    await page.keyboard.down("F8");
    await page.waitForFunction(() => Boolean(window.__releaseMicrophone));
    await page.waitForTimeout(260);
    await page.keyboard.up("F8");
    await page.evaluate(() => window.__releaseMicrophone());
    await page.locator("[data-dictation-status]").waitFor({ state: "hidden" });
    assert.equal(requests, beforeCancel + 1, "Release during pending permission still stops and transcribes");
    assert(await page.evaluate(() => window.__tracksStopped >= window.__recordings), "All captured streams stop");
    await page.request.post(`${url}/ai/models/stt`, { data: { provider: "openai_compatible", endpoint: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", token: "private-test-token", remote_consent: true } });
    const removed = await page.request.post(`${url}/ai/models/stt`, { data: { forget_token: true } });
    assert.equal(removed.status(), 200, "Users can remove saved secrets");
    const beforeKeyError = await page.evaluate(() => window.__microphoneRequests);
    await questionMic.click();
    await page.locator("#app-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("[data-app-dialog-message]").textContent(), /requires an API key/);
    assert.equal(await page.evaluate(() => window.__microphoneRequests), beforeKeyError, "Missing keys are detected before microphone capture");
    await page.locator("[data-app-dialog-accept]").click();
    await page.route("**/ai/models", async route => {
      const response = await route.fetch();
      const older = await response.json();
      delete older.capabilities.speech_to_text.audio_upload;
      await route.fulfill({ json: older });
    });
    const beforeStale = await page.evaluate(() => window.__microphoneRequests);
    await questionMic.click();
    await page.locator("#app-dialog").waitFor({ state: "visible" });
    assert.match(await page.locator("[data-app-dialog-message]").textContent(), /server is out of date/);
    assert.equal(await page.evaluate(() => window.__microphoneRequests), beforeStale, "Detect an outdated upload backend before recording audio");
    await page.locator("[data-app-dialog-accept]").click();
    assert.deepEqual(errors, []);
    console.log("PASS: STT consent/settings, manuscript/wiki/question/instruction targets, undo, hold, latch, cancel, delayed microphone, and stale transcript retention.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
