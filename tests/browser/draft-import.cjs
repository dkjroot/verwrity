/* Synthetic files and mocked inference; conversion uses the real local decoder. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
function wav(seconds, rate = 16000) {
  const size = seconds * rate * 2, bytes = Buffer.alloc(44 + size);
  bytes.write("RIFF"); bytes.writeUInt32LE(36 + size, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(size, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(2400, i);
  return bytes;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/ai/models/stt`, { data: { provider: "openai_compatible", endpoint: "localhost:8080", model: "synthetic" } });
    await page.request.post(`${url}/ai/models/llm`, { data: { standard: "openai_compatible", endpoint: "localhost:8080", model: "synthetic" } });
    await page.addInitScript(() => {
      window.__microphones = 0;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => { window.__microphones++; throw new Error("No microphone during import"); } });
    });
    let uploads = 0, cleanups = 0, releaseSpeech;
    let holdSpeech = true;
    await page.route("**/ai/transcribe", async route => {
      const number = ++uploads;
      const bytes = route.request().postDataBuffer();
      assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
      assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
      assert(bytes.length <= 16000 * 46 * 2 + 44);
      if (holdSpeech) await new Promise(resolve => { releaseSpeech = resolve; });
      await route.fulfill({ json: { text: `i read section ${number}.` } }).catch(() => {});
    });
    await page.route("**/ai/dictate-draft/cleanup", async route => {
      cleanups++;
      const raw = route.request().postDataJSON().text;
      await route.fulfill({ json: { text: "I" + raw.slice(1), edits: [{ start: 0, end: 1, before: "i", after: "I" }] } });
    });
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => {
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      window.verwrityEditor.setText("Before after"); window.verwrityEditor.selectSourceRange(5, 6);
    });
    const open = async () => { await page.evaluate(() => document.querySelector("[data-draft-open]").click()); await page.locator("#dictate-draft-dialog").waitFor({ state: "visible" }); };
    const click = async name => { const control = page.locator(`[data-draft-${name}]`); await control.evaluate(el => { const details = el.closest("details"); if (details) details.open = true; }); await control.click(); };
    const upload = buffer => page.locator("[data-draft-audio-file]").setInputFiles({ name: "phone-note.wav", mimeType: "audio/wav", buffer });
    const retained = () => page.evaluate(async () => {
      const { loadDraft } = await import("/static/draft-storage.js");
      const draft = await loadDraft(document.querySelector("[data-workspace]").dataset.projectId);
      return { elapsed: draft.elapsed, chunks: draft.chunks.map(c => ({ source: c.source, start: c.start, end: c.end,
        audio: c.audio?.size || 0, stage: c.stage, review: c.review, choice: c.reviewChoice, edited: c.reviewEdited })) };
    });
    await open();
    assert(await page.locator("[data-draft-cleanup]").isChecked());
    const [picker] = await Promise.all([page.waitForEvent("filechooser"), click("import")]);
    await picker.setFiles({ name: "phone-note.wav", mimeType: "audio/wav", buffer: wav(92) });
    await page.waitForFunction(() => document.querySelectorAll("[data-draft-chunks] button").length === 3 ||
      document.querySelector("[data-draft-error]").textContent.includes("audio-import"));
    if ((await page.locator("[data-draft-error]").textContent()).includes("audio-import")) {
      assert.equal(uploads, 0, "a missing optional decoder must not start inference");
      assert.equal(await page.evaluate(() => window.__microphones), 0);
      assert.deepEqual(errors, []);
      console.log("SKIP: real import integration requires the audio-import extra; missing-decoder UI verified.");
      return;
    }
    for (let i = 0; i < 100 && !releaseSpeech; i++) await page.waitForTimeout(20);
    assert(releaseSpeech);
    assert(await page.locator("[data-draft-approve-all]").isDisabled(), "bulk approval waits for transcription/cleanup to finish");
    const saved = await retained();
    assert.equal(saved.elapsed, 92);
    assert.equal(saved.chunks.length, 3);
    assert(saved.chunks.every(c => c.source === "import" && c.audio > 44), "each independent WAV is saved before inference");
    assert.equal(saved.chunks.reduce((sum, c) => sum + c.audio - 44, 0), 92 * 16000 * 2, "all samples retained once");
    assert.equal(saved.chunks[0].start, 0);
    assert.equal(saved.chunks[0].end, saved.chunks[1].start);
    assert.equal(saved.chunks[1].end, saved.chunks[2].start);
    assert.equal(saved.chunks[2].end, 92);
    holdSpeech = false; releaseSpeech();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.startsWith("finished") && !document.querySelector("[data-draft-use-cleaned]").disabled);
    assert.equal(uploads, 3); assert.equal(cleanups, 3);
    await click("use-cleaned");
    await page.locator("[data-draft-chunks] button").first().click();
    await page.locator("[data-draft-review]").fill("My approved first section.");
    await page.locator("[data-draft-chunks] button").nth(1).click();
    await page.locator("[data-draft-review]").fill("My unapproved second-section edit.");
    await click("approve-all");
    let approvals = await retained();
    assert.deepEqual(approvals.chunks.map(chunk => chunk.review), [
      "My approved first section.", "My unapproved second-section edit.", "I read section 3."]);
    assert.deepEqual(approvals.chunks.map(chunk => chunk.choice), ["cleanup", "cleanup", "cleanup"]);
    assert(approvals.chunks[0].edited && approvals.chunks[1].edited, "bulk approval keeps approved and unapproved author edits");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after", "approval never inserts text");
    assert.equal(uploads, 3); assert.equal(cleanups, 3, "bulk approval makes no provider calls");
    await page.locator("[data-draft-cleanup]").uncheck();
    await upload(wav(2));
    await page.waitForFunction(() => document.querySelector("[data-draft-raw]").value === "i read section 4.");
    assert.equal(cleanups, 3, "raw-only import makes no LLM call");
    assert.equal((await retained()).elapsed, 94);
    await click("approve-all");
    approvals = await retained();
    assert.equal(approvals.chunks[3].choice, "raw", "raw-only sections are approved without needing cleanup");
    assert.equal(approvals.chunks[3].review, "i read section 4.");
    assert(await page.locator("[data-draft-approve-all]").isDisabled(), "already approved sections are skipped");
    await click("insert");
    await page.locator("[data-app-dialog-checkbox]").uncheck();
    await page.locator("[data-app-dialog-accept]").click();
    await page.locator("#dictate-draft-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()),
      "Before My approved first section.\n\nMy unapproved second-section edit.\n\nI read section 3.\n\ni read section 4. after");
    await page.locator(".ProseMirror").focus(); await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after");
    await open();
    assert(await page.locator("[data-draft-approve-all]").isDisabled(), "inserted receipts remain excluded from bulk approval");
    await upload(Buffer.from("corrupt private media"));
    await page.waitForFunction(() => /could not be decoded/.test(document.querySelector("[data-draft-error]").textContent));
    assert.equal((await retained()).chunks.length, 4);
    assert.equal(uploads, 4);
    // A recovery failure rejects the new section without damaging the prior
    // buffer or initiating transcription of unsaved imported audio.
    await page.evaluate(() => {
      window.__originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === "sessions" && value.chunks.length > 4) { this.transaction.abort(); return; }
        return window.__originalPut.call(this, value, ...args);
      };
    });
    await upload(wav(1));
    await page.waitForFunction(() => /Local recovery failed/.test(document.querySelector("[data-draft-error]").textContent));
    assert.equal(uploads, 4);
    assert.equal((await retained()).chunks.length, 4);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
    let releaseConversion;
    await page.route("**/ai/dictate-draft/audio", async route => {
      await new Promise(resolve => { releaseConversion = resolve; });
      await route.fulfill({ contentType: "audio/wav", body: wav(1) }).catch(() => {});
    });
    await upload(wav(1));
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.startsWith("importing"));
    assert(await page.locator("[data-draft-start]").isDisabled());
    assert(await page.locator("[data-draft-import]").isDisabled());
    assert(await page.locator("[data-draft-approve-all]").isDisabled());
    await click("new"); await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.startsWith("idle"));
    releaseConversion(); await page.waitForTimeout(100);
    assert.equal((await retained()).chunks.length, 0, "clearing cancels conversion; late response cannot restore imported chunks");
    assert.equal(uploads, 4);
    await page.unroute("**/ai/dictate-draft/audio");
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    await open();
    assert.equal(uploads, 4, "recovery never restarts import or inference");
    await page.locator("[data-draft-cleanup]").uncheck();
    // An interrupted stream keeps only its durably accepted prefix and clearly
    // warns that repeating the original file would duplicate that prefix.
    await page.route("**/ai/dictate-draft/audio", async route => {
      const prefix = { audio: wav(1).toString("base64"), start: 0, end: 1, quiet: false };
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify(prefix) + "\n" });
    });
    await upload(wav(1));
    await page.waitForFunction(() => /Import stopped after 0:01/.test(document.querySelector("[data-draft-import-status]").textContent));
    assert.equal((await retained()).chunks.length, 1);
    assert.match(await page.locator("[data-draft-import-status]").textContent(), /would repeat/);
    await page.unroute("**/ai/dictate-draft/audio");
    await click("new"); await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.startsWith("idle"));
    holdSpeech = true; releaseSpeech = undefined;
    await upload(wav(31 * 60, 1000));
    await page.waitForFunction(() => /Waiting for transcription/.test(document.querySelector("[data-draft-import-status]").textContent));
    const waiting = await retained();
    assert.equal(waiting.chunks.length, 5, "long imports pause stream consumption at five pending audio sections");
    assert(waiting.chunks.every(chunk => chunk.audio > 44));
    assert(await page.locator("[data-draft-import]").isDisabled());
    holdSpeech = false; releaseSpeech();
    await page.waitForFunction(() => document.querySelector("[data-draft-status]").textContent.startsWith("finished"), null, { timeout: 90000 });
    const long = await retained();
    assert.equal(long.elapsed, 31 * 60, "a recording longer than thirty minutes is imported in full");
    assert.equal(long.chunks.length, 42);
    assert(long.chunks.every(chunk => !chunk.audio && chunk.stage === "raw"));
    for (let index = 1; index < long.chunks.length; index++) assert.equal(long.chunks[index].start, long.chunks[index - 1].end);
    await click("approve-all");
    const bulkLong = await retained();
    assert.equal(bulkLong.chunks.filter(chunk => chunk.choice === "raw").length, 42,
      "one click approves the complete half-hour import");
    assert.match(await page.locator("[data-draft-insert]").textContent(), /42 approved sections/);
    assert.equal(await page.evaluate(() => window.__microphones), 0);
    assert.deepEqual(errors, []);
    console.log("PASS: streamed file conversion beyond thirty minutes, five-section backpressure, contiguous chunks, durable recovery, cleanup/raw choices, append, insertion/undo, corrupt/truncated input, storage failure, cancellation and no microphone.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
