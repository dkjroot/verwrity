/* Synthetic captures and mocked OCR only; no author files or model calls. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    await page.route("**/ai/ocr", async route => {
      const response = await route.fetch(), value = await response.json();
      value.settings.ocr.readiness = { configured: true, tested: true, message: "Synthetic provider" };
      await route.fulfill({ json: value });
    });
    page.on("pageerror", e => errors.push(e.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/ai/models/llm`, { data: { endpoint: "localhost:8080", model: "synthetic" } });
    let calls = 0, cleanups = 0, delay = false, release;
    await page.route("**/ai/ocr/recognize", async route => {
      calls++; const request = route.request().postDataJSON(); assert(request.configuration); assert(request.image);
      if (delay) await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { page_id: request.page_id, text: `Page ${calls}: Literal <tag> &amp; words.`, model: "synthetic", warnings: [] } }).catch(() => {});
    });
    await page.route("**/ai/ocr/cleanup", async route => {
      cleanups++; const request = route.request().postDataJSON(); assert(!request.image); assert(!request.previous);
      await route.fulfill({ json: { text: request.text.replace("words", "wording"), edits: [{ start: request.text.indexOf("words"), end: request.text.indexOf("words") + 5, before: "words", after: "wording" }] } });
    });
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelectorAll("dialog[open]").forEach(d => d.close()); window.verwrityEditor.setText("Before after"); window.verwrityEditor.selectSourceRange(5, 6); });
    const open = async () => {
      await page.evaluate(() => document.querySelector("[data-ocr-open]").click());
      await page.locator("#ocr-import-dialog").waitFor({ state: "visible" });
    };
    const accept = async () => { await page.locator("#app-dialog[open]").waitFor(); await page.locator("[data-app-dialog-accept]").click(); };
    const idle = async () => page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    const select = async i => page.locator(".ocr-page button").nth(i).click();
    const dataURL = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 300; c.height = 400; const ctx = c.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 300, 400); ctx.fillStyle = "black"; ctx.fillText("Synthetic manuscript page", 20, 80); return c.toDataURL("image/png").split(",")[1]; });
    const image = name => ({ name, mimeType: "image/png", buffer: Buffer.from(dataURL, "base64") });
    await open();
    await page.locator("[data-ocr-auto-duplicates]").uncheck();
    await page.locator("[data-ocr-files]").setInputFiles([image("one.png"), image("repeat.png"), image("three.png")]);
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 3); await idle();
    assert.equal(calls, 0, "import never starts OCR");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after");
    await page.locator(".ocr-page input").nth(1).uncheck();
    await page.locator("[data-ocr-up]").click();
    assert.match(await page.locator(".ocr-page").nth(1).textContent(), /three.png/);
    await page.locator("[data-ocr-placement]").selectOption("after");
    await page.locator("[data-ocr-files]").setInputFiles(image("missing.png"));
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 4); await idle();
    assert.match(await page.locator(".ocr-page").nth(2).textContent(), /missing.png/);
    await page.locator("[data-ocr-run]").click(); await idle(); assert.equal(calls, 3);
    await page.locator("[data-ocr-clean-all]").click(); await idle(); assert.equal(cleanups, 3);
    await select(0); await page.locator("[data-ocr-raw-choice]").click();
    await select(1); await page.locator("[data-ocr-review]").fill("Author edited page.");
    await page.locator("[data-ocr-approve-all]").click(); await accept();
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page small")[0].textContent.includes("✓"));
    assert.equal(await page.locator("[data-ocr-review]").inputValue(), "Author edited page.", "bulk approval preserves author edits");
    await page.locator("[data-ocr-insert]").click(); await accept();
    await page.waitForFunction(() => !document.querySelector("#ocr-import-dialog").open);
    const inserted = await page.evaluate(() => window.verwrityEditor.getText());
    assert(inserted.startsWith("Before Page 1:"), "insertion uses the captured caret");
    assert(inserted.includes("Literal <tag> &amp; words."), "raw choice remains literal and independent of correction");
    assert(inserted.includes("Author edited page.")); assert(!inserted.includes("Page 4"));
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Before after", "insertion is one undoable edit");
    await open(); assert.equal(await page.locator("[data-ocr-insert]").isDisabled(), true, "receipts prevent duplicate insertion even after Undo");
    await page.locator("[data-ocr-hide]").first().click(); await page.reload();
    await page.waitForFunction(() => window.verwrityEditor); await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
    await open(); assert.equal(await page.locator(".ocr-page").count(), 4); assert.equal(calls, 3, "reopening recovery starts no calls");
    await page.locator("[data-ocr-placement]").selectOption("end");
    await page.locator("[data-ocr-files]").setInputFiles(image("later.png")); await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 5); await idle();
    await page.locator("[data-ocr-run]").click(); await idle(); assert.equal(calls, 4, "later still import processes only the new page");
    await page.locator("[data-ocr-raw-choice]").click();
    await page.locator("[data-ocr-hide]").first().click();
    await page.evaluate(() => window.verwrityEditor.setText("Changed after capture."));
    await open(); await page.locator("[data-ocr-hide]").first().click();
    await page.evaluate(() => window.verwrityEditor.setText("Changed AGAIN after capture."));
    // Re-show without recapturing to exercise the actual stale editor target.
    await page.evaluate(() => document.querySelector("#ocr-import-dialog").showModal());
    await page.locator("[data-ocr-insert]").click(); await accept();
    await page.waitForFunction(() => document.querySelector("[data-ocr-status]").textContent.includes("captured manuscript changed"));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Changed AGAIN after capture.");
    assert.equal(await page.locator("[data-ocr-insert]").isEnabled(), true, "stale failure releases prepared receipts");
    // Cancellation discards late OCR, preserves source and requires explicit retry.
    await page.locator("[data-ocr-files]").setInputFiles(image("cancel.png")); await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 6); await idle();
    delay = true; await page.locator("[data-ocr-run]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-page-status]").textContent.includes("Recognizing"));
    await page.locator("[data-ocr-cancel]").click(); delay = false; if (release) release(); await idle();
    assert.equal(await page.locator("[data-ocr-raw]").inputValue(), "");
    await page.locator("[data-ocr-run]").click(); await idle(); assert((await page.locator("[data-ocr-raw]").inputValue()).includes("Literal"));
    // Streaming capture inventory, alternate frames and uncertain duplicates.
    const jpeg = await page.locator("[data-ocr-image]").getAttribute("src");
    await page.route("**/ai/ocr/import", async route => {
      if (route.request().headers()["x-verwrity-media"] !== "video") return route.continue();
      const b64 = jpeg.split(",")[1];
      await route.fulfill({ contentType: "application/x-ndjson", body: [
        { progress: 1 }, { id: "11111111-1111-4111-8111-111111111111", timestamp: 1, uncertain: true, variants: [{ image: b64, timestamp: 1 }, { image: b64, timestamp: 1.25 }] }, { done: true },
      ].map(JSON.stringify).join("\n") + "\n" });
    });
    await page.locator("[data-ocr-files]").setInputFiles({ name: "synthetic.mp4", mimeType: "video/mp4", buffer: Buffer.from("synthetic mocked stream") });
    await page.locator("[data-ocr-extract]").click();
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 7); await idle();
    assert.equal(await page.locator("[data-ocr-variant] option").count(), 2);
    await page.locator("[data-ocr-variant]").selectOption("1");
    await page.getByText("Crop / straighten", { exact: true }).click();
    await page.locator("[data-ocr-left]").fill("10"); await page.locator("[data-ocr-adjust]").click(); await idle();
    assert.equal(await page.locator("[data-ocr-left]").inputValue(), "10");
    await page.locator("[data-ocr-zoom]").selectOption("200");
    assert.equal(await page.locator("[data-ocr-image]").evaluate(image => parseFloat(image.style.width)),
      await page.locator("[data-ocr-image]").evaluate(image => image.naturalWidth * 2), "zoom uses source pixel size");
    const download = page.waitForEvent("download");
    await page.locator("[data-ocr-source]").click(); assert.match((await download).suggestedFilename(), /capture-/);
    await page.locator("[data-ocr-zoom]").selectOption("fit");
    await page.setViewportSize({ width: 760, height: 600 });
    assert(await page.locator("[data-ocr-import]").isVisible());
    await page.screenshot({ path: "node_modules/.verwrity-test-temp/ocr-review.png" });
    // Another tab's newer buffer must never be overwritten by this tab.
    await page.evaluate(async () => {
      const storage = await import("/static/ocr-storage.js");
      const projectId = document.querySelector("[data-workspace]").dataset.projectId;
      const buffer = (await storage.buffers()).find(b => b.projectId === projectId);
      await storage.saveBuffer({ ...buffer, otherTabMarker: true }, buffer.version);
    });
    await page.locator("[data-ocr-review]").fill("Pending review edit");
    await page.waitForFunction(() => document.querySelector("[data-ocr-status]").textContent.includes("Another tab changed"));
    assert.equal(await page.locator("[data-ocr-insert]").isDisabled(), true);
    assert.equal(await page.evaluate(async () => { const s = await import("/static/ocr-storage.js"); return (await s.buffers())[0].otherTabMarker; }), true);
    assert.deepEqual(errors, [], "no browser exceptions");
    console.log("PASS: OCR image/video inventory, ordering, missing still, corrections, approvals, literal insertion/Undo, receipts, recovery, stale targets, cancellation and crop preview.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
