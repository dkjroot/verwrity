/* Synthetic long-session audio only; never capture the author's microphone. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await browserContext.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/ai/models/stt`, { data: { provider: "openai_compatible", endpoint: "localhost:8080", model: "test-whisper" } });
    await page.request.post(`${url}/ai/models/llm`, { data: { standard: "openai_compatible", endpoint: "localhost:8080", model: "test-cleanup" } });
    await page.addInitScript(() => {
      window.__draftStopped = 0;
      window.__draftMicrophones = 0;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        window.__draftMicrophones++;
        if (window.__delayDraftMicrophone) await new Promise(resolve => { window.__releaseDraftMicrophone = resolve; });
        const track = new EventTarget(); track.stop = () => { window.__draftStopped++; };
        return { getTracks: () => [track] };
      } });
      window.AudioContext = class {
        constructor() { this.sampleRate = 8000; this.state = "running"; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
        async resume() { this.state = "running"; }
        async close() { this.state = "closed"; }
      };
      window.AudioWorkletNode = class {
        constructor() {
          window.__draftNode = this;
          this.port = { postMessage: value => { if (value === "flush") queueMicrotask(() => this.port.onmessage({ data: "flushed" })); } };
        }
        connect() {} disconnect() {}
      };
      window.__draftFeed = (seconds, amplitude = .02) => {
        for (let remaining = Math.round(seconds * 8000); remaining > 0;) {
          const length = Math.min(4096, remaining); remaining -= length;
          window.__draftNode.port.onmessage({ data: new Float32Array(length).fill(amplitude) });
        }
      };
    });
    let uploads = 0, cleanups = 0, slow = false, fail = false, speech = "i met elrin", noChanges = false, skippedEdits = 0;
    let releaseUpload, releaseCleanup, delayCleanup = false, failCleanupOnce = false;
    const cleanupTexts = [];
    await page.route("**/ai/transcribe", async route => {
      uploads++;
      const bytes = route.request().postDataBuffer();
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
      assert.equal(bytes.readUInt32LE(40), bytes.length - 44, "each chunk has its own complete WAV header");
      assert.equal(bytes.readUInt16LE(22), 1);
      assert(route.request().headers()["x-verwrity-stt-configuration"]);
      if (slow) await new Promise(resolve => { releaseUpload = resolve; });
      await route.fulfill(fail ? { status: 502, json: { error: "Synthetic provider failure" } } : { json: { text: speech } }).catch(() => {});
    });
    await page.route("**/ai/dictate-draft/cleanup", async route => {
      cleanups++;
      const data = route.request().postDataJSON();
      assert.equal("previous" in data, false, "cleanup never sends preceding sections");
      cleanupTexts.push(data.text);
      if (delayCleanup) await new Promise(resolve => { releaseCleanup = resolve; });
      if (failCleanupOnce) {
        failCleanupOnce = false;
        await route.fulfill({ status: 502, json: { error: "Synthetic provider unavailable; raw unchanged." } }).catch(() => {});
        return;
      }
      await route.fulfill({ json: noChanges ? { text: data.text, edits: [] } : { text: "I met Elryn.", skipped_edits: skippedEdits, edits: [
        { start: 0, end: 1, before: "i", after: "I", category: "capitalisation" },
        { start: 6, end: 11, before: "elrin", after: "Elryn", category: "vocabulary" },
        { start: 11, end: 11, before: "", after: ".", category: "punctuation" },
      ] } }).catch(() => {});
    });
    let vocabularyCalls = 0;
    await page.route("**/ai/dictate-draft/vocabulary", async route => {
      vocabularyCalls++;
      assert(route.request().postDataJSON().source_hash);
      await route.fulfill({ json: { terms: [{ term: "Mirewood", scene_id: "synthetic-source", start: 0, quote: "Mirewood stood beyond the hill." }] } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { window.verwrityEditor.setText("Before after"); window.verwrityEditor.selectSourceRange(5, 6); });
    const open = async (rawOnly = true) => {
      await page.evaluate(() => document.querySelector("[data-draft-open]").click());
      await page.locator("#dictate-draft-dialog").waitFor({ state: "visible" });
      if (rawOnly) await page.locator("[data-draft-cleanup]").uncheck();
    };
    const click = async name => {
      const control = page.locator(`[data-draft-${name}]`);
      await control.evaluate(el => { const details = el.closest("details"); if (details) details.open = true; });
      await control.click();
    };
    const feed = (seconds, amplitude) => page.evaluate(([s, a]) => window.__draftFeed(s, a), [seconds, amplitude ?? .02]);
    const status = value => page.waitForFunction(value => document.querySelector("[data-draft-status]").textContent.startsWith(value), value);
    const saved = () => page.waitForFunction(async () => Boolean((await (await import("/static/draft-storage.js")).loadDraft(document.querySelector("[data-workspace]").dataset.projectId))?.storageVersion));
    await page.evaluate(() => {
      window.__draftBulkControl = document.querySelector("[data-draft-cleanup-all]");
      window.__draftBulkParent = window.__draftBulkControl.parentElement;
      window.__draftBulkControl.remove();
    });
    await open(false);
    assert(await page.locator("#dictate-draft-dialog").isVisible(), "a cached earlier template without the bulk button can still open");
    assert(await page.locator("[data-draft-cleanup]").isChecked(), "configured cleanup defaults on without starting a model call");
    assert.equal(cleanups, 0);
    await page.locator("[data-draft-cleanup]").uncheck();
    await page.locator("[data-draft-hide]").first().click();
    await open(false);
    assert.equal(await page.locator("[data-draft-cleanup]").isChecked(), false, "reopening in the same tab retains the author's raw-only choice");
    await page.evaluate(() => window.__draftBulkParent.append(window.__draftBulkControl));
    assert(await page.locator("[data-draft-cleanup-all]").isVisible(), "bulk cleanup is visible before recording");
    await page.locator("[data-draft-hide]").first().click(); await open(false);
    await page.waitForFunction(() => document.querySelector("[data-draft-cleanup-all]").disabled);
    assert(await page.locator("[data-draft-cleanup-all]").isDisabled(), "bulk cleanup waits for eligible transcripts");
    assert.match(await page.locator("[data-draft-providers]").textContent(), /test-whisper/);
    assert.equal(await page.locator("[data-draft-consent-label]").isVisible(), false, "loopback cleanup does not show remote consent controls");
    await click("start"); await status("recording");
    slow = true;
    await feed(3); await click("boundary");
    await page.waitForFunction(() => document.querySelector('[data-draft-chunks] [data-state="working"]'));
    assert.equal(await page.locator("[data-draft-chunks] button").first().getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("[data-draft-chunks] .draft-progress-spinner").evaluate(el => getComputedStyle(el).animationName), "draft-progress-spin");
    assert.equal(await page.locator("[data-draft-chunks] .draft-review-choice").count(), 0);
    slow = false; releaseUpload();
    await page.waitForFunction(() => document.querySelector("[data-draft-raw]").value === "i met elrin");
    await page.waitForFunction(() => document.querySelector('[data-draft-chunks] [data-state="ready"]'));
    assert.equal(cleanups, 0, "raw-only mode never calls LLM");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after");
    await feed(8, .001); // Quiet reading/page-turn boundary retains all samples.
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button").length === 2);
    await click("pause"); await status("paused");
    assert.equal(await page.evaluate(() => window.__draftStopped), 1);
    await click("resume"); await status("recording");
    await feed(46); // Maximum-duration fallback, plus an independently retained tail.
    await click("finish"); await status("finished");
    assert(uploads >= 4);
    assert.equal(await page.evaluate(() => window.__draftStopped), 2);
    // Review edits survive cleanup completing later, server failure and reload.
    const vocab = page.locator("[data-draft-vocabulary]");
    assert.equal(await vocab.evaluate(el => el.readOnly), false);
    await vocab.fill("Elryn, Ilmar, Mirewood");
    assert.equal(vocabularyCalls, 0, "session vocabulary never requests model discovery");
    delayCleanup = true;
    skippedEdits = 1;
    await click("reclean");
    await page.waitForFunction(() => document.querySelector("[data-draft-chunk-status]").textContent.includes("Chunk"));
    for (let i = 0; i < 100 && !releaseCleanup; i++) await page.waitForTimeout(50);
    assert(releaseCleanup, await page.locator("[data-draft-chunk-status]").textContent() + " / " + await page.locator("[data-draft-error]").textContent());
    assert.equal(await page.locator("[data-draft-chunk-status] .draft-progress-spinner").count(), 1);
    await page.locator("[data-draft-review]").fill("My reviewed words 😀 & <literal>.");
    releaseCleanup(); delayCleanup = false;
    await page.waitForFunction(() => document.querySelector("[data-draft-chunk-status]").textContent.includes("discarded"));
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "My reviewed words 😀 & <literal>.");
    await click("reclean");
    await page.locator("[data-draft-use-cleaned]").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector("[data-draft-use-cleaned]").disabled);
    assert.equal(await page.locator("[data-draft-cleaned] mark").count(), 3, "all validated changes are highlighted");
    assert.equal(await page.locator("[data-draft-cleaned]").textContent(), "I met Elryn.");
    assert.match(await page.locator("[data-draft-cleanup-note]").textContent(), /Some other suggestions could not be used/);
    assert.equal(await page.locator("[data-draft-changes]").count(), 0,
      "highlights provide the comparison without a duplicate textual change list");
    skippedEdits = 0;
    const alignment = await page.evaluate(() => {
      const raw = document.querySelector("[data-draft-raw]").getBoundingClientRect();
      const clean = document.querySelector("[data-draft-cleaned]").getBoundingClientRect();
      return { top: Math.abs(raw.top - clean.top), bottom: Math.abs(raw.bottom - clean.bottom) };
    });
    assert(alignment.top <= 1 && alignment.bottom <= 1, "raw and proposed cleanup boxes align at both edges");
    await page.locator("[data-draft-cleaned]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: "node_modules/.cache/verwrity-tests/draft-review-ready.png" });
    await click("use-cleaned");
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button")[1].getAttribute("aria-current") === "true");
    assert.match(await page.locator("[data-draft-chunks] button").first().textContent(), /Cleanup selected/);
    await page.locator("[data-draft-chunks] button").first().click();
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "I met Elryn.");
    await page.locator("[data-draft-review]").fill("It's literal &#39; & <text> 😀.\n\nNext paragraph.");
    assert.match(await page.locator("[data-draft-chunks] button").first().textContent(), /Cleanup selected · edited/);
    await page.locator("[data-draft-chunks] button").nth(1).click();
    await click("use-raw");
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button")[2].getAttribute("aria-current") === "true");
    assert.match(await page.locator("[data-draft-chunks] button").nth(1).textContent(), /Raw selected/);
    noChanges = true; await click("reclean");
    await page.waitForFunction(() => !document.querySelector("[data-draft-use-cleaned]").disabled);
    assert.equal(await page.locator("[data-draft-cleaned]").textContent(), "i met elrin", "no suggestions copies raw into cleanup view");
    assert.equal(await page.locator("[data-draft-cleaned] mark").count(), 0);
    assert.match(await page.locator("[data-draft-cleanup-note]").textContent(), /Model had no notes/);
    await click("use-cleaned");
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button")[3].getAttribute("aria-current") === "true");
    assert.match(await page.locator("[data-draft-insert]").textContent(), /3 approved sections/);
    assert.match(await page.locator("[data-draft-approved-summary]").textContent(), /1 pending/);
    noChanges = false;
    await saved();
    await click("insert");
    assert(await page.locator("[data-app-dialog-checkbox]").isChecked(), "Clear recordings defaults on");
    assert.match(await page.locator("#app-dialog").textContent(), /including unapproved sections/);
    await page.screenshot({ path: "node_modules/.cache/verwrity-tests/draft-insert-confirmation.png" });
    await page.locator("[data-app-dialog-cancel]").click();
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 4, "cancel never clears the buffer");
    // A source switch invalidates capture even when the plain text is equal.
    await page.evaluate(() => window.verwrityEditor.setText("Before after"));
    await click("insert"); await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => /captured scene/.test(document.querySelector("[data-draft-error]").textContent));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 4, "failed insertion never clears the buffer even when checked");
    await page.locator("[data-draft-hide]").first().click();
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(5, 6));
    await open(); await click("insert");
    await page.locator("[data-app-dialog-checkbox]").uncheck();
    await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => window.verwrityEditor.getText().includes("It's literal"));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before It's literal &#39; & <text> 😀.\n\nNext paragraph.\n\ni met elrin\n\ni met elrin after", "one insert includes every approved choice, preserving repeated passages and recording order");
    await page.locator("#dictate-draft-dialog").waitFor({ state: "hidden" });
    await page.locator(".ProseMirror").focus(); await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after");
    await open();
    await page.locator("[data-draft-chunks] button").first().click();
    const beforeReload = uploads;
    await page.reload();
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await open();
    await page.locator("[data-draft-chunks] button").first().click();
    assert.equal(uploads, beforeReload, "reopen does not restart provider calls");
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "It's literal &#39; & <text> 😀.\n\nNext paragraph.");
    assert.equal(await page.locator("[data-draft-insert]").isDisabled(), true, "inserted chunks cannot be inserted twice by recovery");
    assert.match(await page.locator("[data-draft-chunks] button").first().textContent(), /Cleanup selected · edited/, "edited choice survives recovery");
    assert.match(await page.locator("[data-draft-chunks] button").nth(1).textContent(), /Raw selected/, "review choice survives reload");
    assert.equal(await page.evaluate(() => window.__draftMicrophones), 0, "recovery does not open microphone");
    // Explicit failed-stage retries retain independently playable pending audio.
    await click("resume"); await status("recording");
    fail = true; await feed(2); await click("boundary");
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("1 unresolved"));
    await click("pause");
    const uploadsBeforeRecovery = uploads;
    await saved(); await page.reload();
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await open();
    assert.equal(uploads, uploadsBeforeRecovery, "failed audio recovery never retries automatically");
    await page.locator("[data-draft-chunks] button").last().click();
    assert.equal(await page.locator("[data-draft-retry]").isEnabled(), true);
    const failedUploads = uploads;
    const cleanupsBeforeSilence = cleanups;
    fail = false; speech = ""; await click("retry");
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0/6 retained audio"));
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 4, "empty trailing speech is omitted from review");
    assert.equal(uploads, failedUploads + 1);
    assert.equal(cleanups, cleanupsBeforeSilence, "silence is not sent for invented cleanup");
    // Slow providers apply backpressure instead of unbounded memory growth.
    slow = true; speech = "Queued speech.";
    await click("resume"); await status("recording");
    for (let i = 0; i < 5; i++) { await feed(1); await click("boundary"); }
    await status("paused");
    assert.match(await page.locator("[data-draft-error]").textContent(), /falling behind/);
    assert.match(await page.locator("[data-draft-status]").textContent(), /[56]\/6 retained audio/);
    slow = false; releaseUpload();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0/6 retained audio"));
    // Cancelling an upload retains audio; an old response cannot resurrect it.
    slow = true; await click("resume"); await status("recording");
    const beforeCancellation = uploads;
    await feed(1); await click("boundary");
    for (let i = 0; i < 100 && uploads === beforeCancellation; i++) await page.waitForTimeout(20);
    await click("cancel"); slow = false; releaseUpload();
    await page.locator("[data-draft-chunks] button").last().click();
    assert.match(await page.locator("[data-draft-chunk-status]").textContent(), /cancelled/);
    assert(await page.locator("[data-draft-retry]").isEnabled());
    await click("retry");
    await page.waitForFunction(() => document.querySelector("[data-draft-raw]").value === "Queued speech.");
    const lastChunkId = await page.locator("[data-draft-chunks] button").last().getAttribute("data-draft-chunk-id");
    await click("use-raw");
    await page.waitForFunction(id => document.querySelector('[data-draft-chunks] button[aria-current="true"]').dataset.draftChunkId === id, lastChunkId);
    assert.equal(await page.locator("[data-draft-combined]").count(), 0, "combined editing was removed from the dictation dialog");
    // Durable recovery checks include optimistic concurrency and quota failure.
    const storage = await page.evaluate(async () => {
      const { saveDraft, loadDraft, deleteDraft } = await import("/static/draft-storage.js");
      const id = crypto.randomUUID();
      const buffer = { projectId: id, id, chunks: [], vocabulary: "chosen", combined: "review", storageVersion: 0 };
      const version = await saveDraft(buffer, 0);
      let conflict = false, limited = false;
      try { await saveDraft({ ...buffer, combined: "stale overwrite" }, 0); } catch { conflict = true; }
      const audio = new Blob(Array(129).fill(new Blob([new Uint8Array(1024 * 1024)])));
      try { await saveDraft({ ...buffer, chunks: [{ audio }] }, version); } catch { limited = true; }
      const retained = await loadDraft(id);
      await deleteDraft(id, version);
      return { conflict, limited, review: retained.combined };
    });
    assert.deepEqual(storage, { conflict: true, limited: true, review: "review" });
    // Test algorithmic PCM continuity over >5 min, WAV validity and quiet splits.
    const audioChecks = await page.evaluate(async () => {
      const { Chunker } = await import("/static/draft-recording.js");
      const chunks = [];
      const chunker = new Chunker(1000, chunk => chunks.push(chunk));
      for (let i = 0; i < 3600; i++) chunker.push(new Float32Array(100).fill(.1));
      chunker.flush();
      const lengths = await Promise.all(chunks.map(async chunk => (await chunk.audio.arrayBuffer()).byteLength - 44));
      return { total: lengths.reduce((a, b) => a + b, 0), chunks: chunks.length,
        overlap: chunks.some(chunk => chunk.overlap), max: Math.max(...chunks.map(chunk => chunk.duration)), end: chunks.at(-1).end };
    });
    assert.equal(audioChecks.total, 360000 * 2, "every sample retained once across a six-minute synthetic session");
    assert.equal(audioChecks.end, 360);
    assert.equal(audioChecks.overlap, false);
    assert(audioChecks.max < 45.2 && audioChecks.chunks >= 8);
    const preview = await page.evaluate(async () => {
      const { showCleanupChanges } = await import("/static/draft-review.js");
      const root = document.createElement("div");
      showCleanupChanges(root, { raw: "😀 a & <literal>..", cleaned: "😀 A & <literal>.", edits: [
        { start: 2, end: 3, before: "a", after: "A", category: "capitalisation" },
        { start: 16, end: 17, before: ".", after: "", category: "punctuation" },
      ] });
      return { changed: root.querySelector("mark").textContent, deleted: root.querySelector(".draft-deletion-marker").title,
        htmlElements: root.querySelectorAll("literal,script,img").length, text: root.textContent };
    });
    assert.equal(preview.changed, "A", "Unicode code-point offsets drive highlights");
    assert.equal(preview.deleted, '"." → ""');
    const dialoguePreview = await page.evaluate(async () => {
      const { showCleanupChanges } = await import("/static/draft-review.js");
      const root = document.createElement("div");
      showCleanupChanges(root, { raw: "😀 wait here", cleaned: '😀 "Wait here."', edits: [
        { start: 2, end: 2, before: "", after: '"' },
        { start: 2, end: 3, before: "w", after: "W" },
        { start: 11, end: 11, before: "", after: '."' },
      ] });
      return { text: root.textContent, marks: [...root.querySelectorAll("mark")].map(mark => mark.textContent) };
    });
    assert.deepEqual(dialoguePreview, { text: '😀 "Wait here."', marks: ['"', "W", '."'] },
      "separate opening/case/closing edits highlight correctly at Unicode and shared boundaries");
    assert.equal(preview.htmlElements, 0, "preview renders markup-like dictation as literal text");
    await page.waitForFunction(async () => {
      const { loadDraft } = await import("/static/draft-storage.js");
      return Boolean(await loadDraft(document.querySelector("[data-workspace]").dataset.projectId));
    });
    const uploadsBeforeSceneSwitch = uploads;
    await page.locator("[data-draft-hide]").first().click();
    await Promise.all([page.waitForNavigation(), page.locator(".scene-row .scene").nth(1).click()]);
    await page.waitForFunction(() => window.verwrityEditor);
    const destinationText = await page.evaluate(() => window.verwrityEditor.getText());
    await open();
    assert.equal(uploads, uploadsBeforeSceneSwitch, "scene navigation cannot restart an old session's requests");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), destinationText, "recovery cannot insert into a different scene automatically");
    const controls = await page.locator("[data-draft-pause]").evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const header = document.querySelector(".draft-dialog .file-dialog-heading").getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, header: header.bottom, height: innerHeight };
    });
    assert(controls.top >= controls.header && controls.bottom < controls.height, "recording controls remain visible while recovery/review is scrolled");
    await page.screenshot({ path: "node_modules/.cache/verwrity-tests/dictate-draft.png" });
    // Fresh-start clearing is visible and works even while capture, STT and
    // cleanup are active. Delayed old results cannot enter the new session.
    const previousChunkCount = await page.locator("[data-draft-chunks] button").count();
    const chosenVocabulary = await page.locator("[data-draft-vocabulary]").inputValue();
    assert.equal(await page.locator("[data-draft-buffers]").count(), 0);
    await click("new"); await page.locator("[data-app-dialog-cancel]").click();
    assert.equal(await page.locator("[data-draft-chunks] button").count(), previousChunkCount);
    await page.locator("[data-draft-chunks] button").first().click();
    delayCleanup = true;
    const cleanupsBeforeClear = cleanups;
    await click("reclean");
    for (let i = 0; i < 100 && cleanups === cleanupsBeforeClear; i++) await page.waitForTimeout(20);
    assert(cleanups > cleanupsBeforeClear);
    slow = true; const uploadsBeforeClear = uploads;
    await click("resume"); await status("recording"); await feed(1); await click("boundary");
    for (let i = 0; i < 100 && uploads === uploadsBeforeClear; i++) await page.waitForTimeout(20);
    assert(uploads > uploadsBeforeClear);
    await feed(1);
    const stoppedBeforeClear = await page.evaluate(() => window.__draftStopped);
    const oldUpload = releaseUpload, oldCleanup = releaseCleanup;
    assert(await page.locator("[data-draft-new]").isEnabled());
    await click("new"); await page.locator("[data-app-dialog-accept]").click();
    await status("idle");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 0);
    assert.equal(await page.locator("[data-draft-raw]").inputValue(), "");
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "");
    assert.equal(await page.locator("[data-draft-buffer-list]").count(), 0, "local-buffer exports are absent from the dialog");
    assert.equal(await page.locator("[data-draft-vocabulary]").inputValue(), chosenVocabulary);
    assert.equal(await page.evaluate(() => window.__draftStopped), stoppedBeforeClear + 1);
    const recoveredFresh = await page.evaluate(async () => {
      const { loadDraft } = await import("/static/draft-storage.js");
      const value = await loadDraft(document.querySelector("[data-workspace]").dataset.projectId);
      return { chunks: value.chunks.length, elapsed: value.elapsed, combined: value.combined };
    });
    assert.deepEqual(recoveredFresh, { chunks: 0, elapsed: 0, combined: "" });
    slow = false; delayCleanup = false; oldUpload(); oldCleanup();
    speech = "Fresh dictation.";
    await click("start"); await status("recording"); await feed(1); await click("finish"); await status("finished");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 1);
    assert.equal(await page.locator("[data-draft-raw]").inputValue(), "Fresh dictation.");
    assert.equal(await page.locator("[data-draft-chunks] .draft-review-choice").count(), 0);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), destinationText, "fresh start never changes manuscript text");
    await page.evaluate(() => { window.__delayDraftMicrophone = true; });
    await click("resume"); await status("opening");
    const stoppedBeforePermission = await page.evaluate(() => window.__draftStopped);
    await click("new"); await page.locator("[data-app-dialog-accept]").click(); await status("idle");
    await page.evaluate(() => { window.__delayDraftMicrophone = false; window.__releaseDraftMicrophone(); });
    await page.waitForFunction(count => window.__draftStopped === count + 1, stoppedBeforePermission);
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 0, "late microphone permission cannot restart a cleared recording");
    await status("idle");
    // Batch cleanup is explicit and serial, and skips ready/approved sections.
    // Only confirmed empty edge sections are omitted; internal gaps stay visible.
    noChanges = true; speech = "";
    const transcribed = () => page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0/6 retained audio"));
    await click("start"); await status("recording");
    const section = async text => {
      speech = text;
      await feed(1); await click("boundary"); await transcribed();
    };
    await section("");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 0, "leading no-speech sections are omitted");
    await section("First section.");
    await click("reclean");
    await page.waitForFunction(() => document.querySelector("[data-draft-use-cleaned]").disabled === false);
    await section("Keep my choice.");
    await page.locator("[data-draft-chunks] button").last().click();
    await click("use-raw");
    await page.locator("[data-draft-review]").fill("Kept manual correction.");
    await section(""); await section("Third section."); await section("Fourth section.");
    speech = ""; await feed(1); await click("finish"); await status("finished");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 5);
    assert.equal(await page.locator("[data-draft-chunks] button").filter({ hasText: "No speech recognized" }).count(), 1, "internal empty sections remain visible");
    assert.equal(await page.locator("[data-draft-export]").count(), 0, "export/recovery controls were removed from the dialog");
    assert.match(await page.locator("[data-draft-cleanup-all]").textContent(), /\(2\)/);
    const beforeBatch = cleanups;
    const beforeBatchTexts = cleanupTexts.length;
    delayCleanup = true; failCleanupOnce = true; await click("cleanup-all");
    await page.waitForFunction(() => document.querySelector("[data-draft-chunks]").textContent.includes("Preparing cleanup"));
    assert.equal(cleanups, beforeBatch + 1, "only one model request runs at a time");
    assert.equal(await page.locator("[data-draft-chunks] button").filter({ hasText: "Cleanup queued" }).count(), 1);
    assert(await page.locator("[data-draft-cleanup-all]").isDisabled(), "double-clicking cannot queue duplicate paid work");
    delayCleanup = false; releaseCleanup();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0 cleanup pending"));
    assert.equal(cleanups, beforeBatch + 2, "ready, approved and empty sections are skipped");
    assert.deepEqual(cleanupTexts.slice(beforeBatchTexts), ["Third section.", "Fourth section."], "each queued request contains exactly its own section");
    assert.equal(await page.locator("[data-draft-chunks] button").filter({ hasText: "Cleanup failed" }).count(), 1, "a rejection retains raw and lets the batch continue");
    assert.match(await page.locator("[data-draft-cleanup-all]").textContent(), /\(1\)/);
    await click("cleanup-all");
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0 cleanup pending"));
    assert.equal(cleanups, beforeBatch + 3, "a rejected section retries only after another explicit click");
    assert.equal(await page.locator("[data-draft-chunks] button").filter({ hasText: "Cleanup ready" }).count(), 3);
    await page.locator("[data-draft-chunks] button").nth(1).click();
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "Kept manual correction.");
    assert.match(await page.locator("[data-draft-chunk-status]").textContent(), /Raw selected · edited/);
    assert(await page.locator("[data-draft-cleanup-all]").isDisabled());
    await page.locator("[data-draft-chunks] button").first().click();
    await click("reclean");
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.includes("0 cleanup pending"));
    assert.equal(cleanups, beforeBatch + 4, "individual explicit reruns remain available");
    await page.locator("[data-draft-cleanup]").check();
    await click("resume"); await status("recording");
    speech = "Automatic cleanup section."; await feed(1); await click("finish"); await status("finished");
    assert.equal(cleanups, beforeBatch + 5, "opt-in automatic cleanup handles new sections");
    await saved(); await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await open();
    assert.equal(cleanups, beforeBatch + 5, "recovery never restarts cleanup calls");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 7, "previous trailing silence becomes an internal gap after resuming");
    assert.match(await page.locator("[data-draft-chunks] button").first().textContent(), /^1\. /);
    // Combined and ordinary insertions both offer the default-on reset. The
    // unchecked path above retains text/choices and insertion receipts on reload.
    const vocabularyBeforeInsertion = await page.locator("[data-draft-vocabulary]").inputValue();
    await click("insert");
    assert(await page.locator("[data-app-dialog-checkbox]").isChecked());
    await page.locator("[data-app-dialog-accept]").click();
    await page.locator("#dictate-draft-dialog").waitFor({ state: "hidden" });
    assert((await page.evaluate(() => window.verwrityEditor.getText())).includes("Kept manual correction."));
    await open(); await status("idle");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 0);
    assert.equal(await page.locator("[data-draft-vocabulary]").inputValue(), vocabularyBeforeInsertion);
    assert(await page.locator("[data-draft-start]").isEnabled());
    const clearedAfterInsertion = await page.evaluate(async () => {
      const { loadDraft } = await import("/static/draft-storage.js");
      const value = await loadDraft(document.querySelector("[data-workspace]").dataset.projectId);
      return { chunks: value.chunks.length, elapsed: value.elapsed, combined: value.combined };
    });
    assert.deepEqual(clearedAfterInsertion, { chunks: 0, elapsed: 0, combined: "" });
    speech = "The next dictation.";
    await click("start"); await status("recording"); await feed(1); await click("finish"); await status("finished");
    await click("use-raw"); await click("insert");
    assert(await page.locator("[data-app-dialog-checkbox]").isChecked());
    await page.locator("[data-app-dialog-accept]").click();
    await page.locator("#dictate-draft-dialog").waitFor({ state: "hidden" });
    assert((await page.evaluate(() => window.verwrityEditor.getText())).includes("The next dictation."));
    await open(); await status("idle");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 0, "ordinary insertion also prepares a fresh dictation");
    speech = "Saved even when clearing fails.";
    await click("start"); await status("recording"); await feed(1); await click("finish"); await status("finished");
    await click("use-raw"); await click("insert");
    await page.evaluate(() => {
      window.__draftOriginalDelete = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (key) {
        if (this.name === "sessions") { this.transaction.abort(); return; }
        return window.__draftOriginalDelete.call(this, key);
      };
    });
    await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => document.querySelector("[data-draft-error]").textContent.startsWith("Your text was inserted, but clearing recordings did not finish."));
    assert((await page.evaluate(() => window.verwrityEditor.getText())).includes("Saved even when clearing fails."));
    assert(await page.locator("[data-draft-insert]").isDisabled(), "a failed reset cannot offer duplicate insertion");
    const retainedReceipt = await page.evaluate(async () => {
      IDBObjectStore.prototype.delete = window.__draftOriginalDelete;
      const { loadDraft } = await import("/static/draft-storage.js");
      return (await loadDraft(document.querySelector("[data-workspace]").dataset.projectId)).chunks[0].inserted;
    });
    assert.equal(retainedReceipt, "confirmed", "clear failure retains the successful insertion receipt");
    await click("new");
    assert.equal(await page.locator("[data-app-dialog-checkbox]").isVisible(), false, "other confirmations do not inherit the insertion checkbox");
    await page.locator("[data-app-dialog-cancel]").click();
    await page.route("**/ai/dictate-draft", async route => {
      const response = await route.fetch();
      const data = await response.json(); delete data.cleanup_protocol;
      await route.fulfill({ response, json: data });
    });
    await page.locator("[data-draft-hide]").first().click(); await open();
    assert.match(await page.locator("[data-draft-providers]").textContent(), /Restart Verwrity/);
    assert(await page.locator("[data-draft-cleanup]").isDisabled(), "older backends cannot restart incompatible cleanup calls");
    assert(await page.locator("[data-draft-resume]").isEnabled(), "raw-only dictation remains available with an older backend");
    assert.equal(await page.locator("[data-draft-chunks] button").count(), 1, "version mismatch retains the existing dictation");
    await page.unroute("**/ai/dictate-draft");
    // Older no-notes results can be retried in bulk after upgrading, but loading
    // recovery must never make calls or overwrite an already approved choice.
    await page.evaluate(async () => {
      const { loadDraft, saveDraft } = await import("/static/draft-storage.js");
      const buffer = await loadDraft(document.querySelector("[data-workspace]").dataset.projectId);
      const old = { stage: "raw", cleanup: "ready", raw: "i met elrin", cleaned: "i met elrin",
        edits: [], review: "", reviewVersion: 0, duration: 1, start: 0, end: 1 };
      const longText = "A much longer transcript section with enough words to require scrolling. ".repeat(90);
      buffer.chunks = [{ ...old, id: crypto.randomUUID() },
        { ...old, id: crypto.randomUUID(), raw: longText, cleaned: longText,
          reviewChoice: "raw", review: "My approved words.", reviewEdited: true }];
      await saveDraft(buffer, buffer.storageVersion);
    });
    noChanges = false;
    const beforeUpgradeReview = cleanups;
    await page.reload();
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await open();
    assert.equal(cleanups, beforeUpgradeReview, "upgrading never reruns cleanup automatically");
    assert.match(await page.locator("[data-draft-cleanup-all]").textContent(), /\(1\)/);
    await click("cleanup-all");
    await page.waitForFunction(() => document.querySelector("[data-draft-cleaned]").textContent === "I met Elryn.");
    assert.equal(cleanups, beforeUpgradeReview + 1, "bulk rerun includes old unapproved no-notes results only");
    assert(await page.locator("[data-draft-cleanup-all]").isDisabled(), "a current completed review is skipped");
    await page.locator("[data-draft-chunks] button").nth(1).click();
    assert.equal(await page.locator("[data-draft-review]").inputValue(), "My approved words.");
    await page.locator("[data-draft-chunks] button").first().click();
    await page.locator("[data-draft-use-cleaned]").scrollIntoViewIfNeeded();
    const reviewBounds = () => page.evaluate(() => {
      const bounds = name => {
        const rect = document.querySelector(`[data-draft-${name}]`).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return { raw: bounds("use-raw"), cleanup: bounds("use-cleaned"), transcript: bounds("raw"),
        preview: bounds("cleaned"), reviewed: bounds("review") };
    });
    const shortBounds = await reviewBounds();
    await click("use-cleaned");
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button")[1].getAttribute("aria-current") === "true");
    const longBounds = await reviewBounds();
    assert.deepEqual(longBounds, shortBounds, "auto-advance to a much longer section keeps both choice buttons and text boxes in exactly the same places");
    assert.equal(longBounds.raw.y, longBounds.cleanup.y, "raw and cleanup choices remain side by side");
    assert(longBounds.transcript.height >= 256, "comparison boxes have generous reading space");
    const scrollChecks = await page.evaluate(() => {
      const raw = document.querySelector("[data-draft-raw]");
      const clean = document.querySelector("[data-draft-cleaned]");
      raw.scrollTop = raw.scrollHeight; clean.scrollTop = clean.scrollHeight;
      return { raw: raw.scrollTop > 0, clean: clean.scrollTop > 0 };
    });
    assert.deepEqual(scrollChecks, { raw: true, clean: true }, "long content scrolls inside both fixed text boxes");
    await page.screenshot({ path: "node_modules/.cache/verwrity-tests/draft-fixed-review.png" });
    await page.setViewportSize({ width: 600, height: 900 });
    await page.locator("[data-draft-chunks] button").first().evaluate(button => button.click());
    await page.locator("[data-draft-use-cleaned]").scrollIntoViewIfNeeded();
    const mobileShort = await reviewBounds();
    await click("use-cleaned");
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button")[1].getAttribute("aria-current") === "true");
    assert.deepEqual(await reviewBounds(), mobileShort, "stacked narrow-screen content also keeps approval controls stationary");
    assert.equal(await page.locator("[data-draft-cleaned]").evaluate(el => el.scrollTop), 0,
      "each newly selected section starts reading at the top of its text box");
    assert.deepEqual(errors, []);
    console.log("Dictate draft: recording boundaries, independent WAV, long sessions, backpressure, raw/review, stale cleanup, insertion/undo, failure/retry and recovery passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
