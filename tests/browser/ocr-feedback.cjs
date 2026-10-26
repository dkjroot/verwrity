/* Synthetic configuration and page fixtures only; no native model/download calls. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }), errors = [];
    const loading = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on('requestfailed', request => loading.push([request.url(), request.failure()?.errorText]));
    page.on('console', message => { if (message.type() === 'error') loading.push(message.text()); });
    await page.request.post(`${url}/__browser_test__/reset`);
    let valid = false, calls = 0, cleanCalls = 0, release;
    await page.route("**/ai/ocr", async route => {
      const r = await route.fetch(), value = await r.json();
      value.settings.ocr.readiness = { configured: valid, tested: valid, message: "Synthetic configuration is missing" };
      value.settings.llm.model = "synthetic-cleanup";
      value.settings.llm.endpoint = "http://127.0.0.1:9999/v1";
      await route.fulfill({ json: value });
    });
    const state = { provider: "olmocr", model_path: "C:/managed/olmocr2", device: "cpu", configuration: "fixture",
      download_directory: "C:/managed/olmocr2", readiness: { configured: true, tested: false, torch_version: "synthetic", message: "Run the sample test." } };
    await page.route("**/ai/models/ocr", async route => route.fulfill({ json: state }));
    await page.route("**/ai/models/ocr/test", route => route.fulfill({ contentType: "application/x-ndjson", body: [
      { stage: "Loading model weights", elapsed: 1, tokens: 0 },
      { stage: "Recognizing page", elapsed: 2, tokens: 8 },
      { result: { matched: true, expected: "Verwrity OCR test.", text: "Verwrity OCR test.", elapsed: 3 } },
    ].map(JSON.stringify).join("\n") + "\n" }));
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelectorAll("dialog[open]").forEach(d => d.close()); window.verwrityEditor.setText("Original manuscript."); });
    const open = async () => { await page.evaluate(() => document.querySelector("[data-ocr-open]").click()); await page.locator("#ocr-import-dialog").waitFor(); };
    await open();
    assert.equal(await page.locator("[data-ocr-duplicate-threshold]").inputValue(), "75");
    assert(await page.locator("[data-ocr-clear]").isVisible(), "start fresh is visible without opening recovery controls");
    assert.equal(await page.locator("[data-ocr-zoom]").inputValue(), "height");
    assert(await page.locator("[data-ocr-config-notice]").isVisible());
    assert(await page.locator("[data-ocr-run]").isDisabled());
    await page.locator("#ocr-import-dialog [data-ocr-hide]").first().click();
    await page.locator(".settings-menu > summary").click();
    await page.locator("[data-ai-models-open]").click();
    await page.locator("[data-ai-tab=ocr]").click();
    await page.locator('[data-ai-panel="ocr"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-ai-ocr-form] [name="model_path"]').value === "C:/managed/olmocr2");
    assert.equal(await page.locator('[data-ai-ocr-form] [name="device"]').inputValue(), "cpu");
    await page.locator("[data-ocr-model-test]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-model-status]").textContent.includes("sample passed"));
    valid = true; await page.locator("[data-ai-models-close]").click(); await open(); await page.locator("#ocr-import-dialog").waitFor();
    assert(await page.locator("[data-ocr-config-notice]").isHidden());
    const fixture = async (name, text) => ({ name, mimeType: "image/png", buffer: Buffer.from(await page.evaluate(text => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 800; const ctx = c.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, 640, 800); ctx.fillStyle = "black"; ctx.font = "24px monospace";
      for (let y = 40; y < 740; y += text.startsWith("First") ? 45 : 72) ctx.fillText(text, 35, y);
      return c.toDataURL("image/png").split(",")[1];
    }, text), "base64") });
    const a = await fixture("first.png", "First page has its own wording.");
    const b = await fixture("different.png", "Different paragraphs on another page.");
    await page.locator("[data-ocr-files]").setInputFiles([a, { ...a, name: "repeat.png" }, b]);
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 3 && document.querySelector("[data-ocr-cancel]").disabled);
    assert(await page.locator(".ocr-page input").nth(0).isChecked());
    assert(!await page.locator(".ocr-page input").nth(1).isChecked(), "identical page is auto-unchecked");
    assert(await page.locator(".ocr-page input").nth(2).isChecked(), "different text stays selected");
    assert.match(await page.locator(".ocr-page").nth(1).textContent(), /100.0%.*Auto-unchecked/);
    await page.locator("[data-ocr-show-unchecked]").uncheck();
    assert.equal(await page.locator(".ocr-page:visible").count(), 2, "hide unchecked is a view filter");
    await page.locator("[data-ocr-show-unchecked]").check();
    assert.equal(await page.locator(".ocr-page:visible").count(), 3, "reveal retains every excluded capture");
    await page.locator(".ocr-page input").nth(1).check();
    await page.locator("[data-ocr-duplicates]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    assert(await page.locator(".ocr-page input").nth(1).isChecked(), "manual choice is preserved");
    assert(!/Auto-unchecked/.test(await page.locator(".ocr-page").nth(1).textContent()), "manual override clears the automatic-selection label");
    await page.locator(".ocr-page input").nth(1).uncheck();
    await page.locator(".ocr-page input").nth(0).check();
    await page.locator("[data-ocr-page-rotation]").selectOption("90");
    await page.locator("[data-ocr-rotate-page]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    await page.waitForFunction(() => { const image = document.querySelector("[data-ocr-image]"); return image.naturalWidth === 800 && image.naturalHeight === 640; });
    const fit = await page.locator("[data-ocr-image]").evaluate(image => ({ image: image.getBoundingClientRect().height, container: image.parentElement.clientHeight }));
    assert(Math.abs(fit.image - fit.container) <= 1, "portrait preview defaults to fit height");
    await page.locator('details').filter({ has: page.locator('[data-ocr-profile-edge]') }).locator('summary').click();
    await page.locator("[data-ocr-profile-edge]").fill("512");
    await page.locator("[data-ocr-profile-contrast]").fill("1.3");
    await page.locator("[data-ocr-profile-mode]").selectOption("gray");
    await page.locator("[data-ocr-profile-preview]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled && document.querySelector("[data-ocr-image]").naturalWidth === 512);
    assert.match(await page.locator("[data-ocr-profile-status]").textContent(), /Preview only/);
    await page.locator("[data-ocr-profile-all]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-status]").textContent.includes("profile applied on 3"));
    await page.route("**/ai/ocr/cleanup", async route => {
      cleanCalls++;
      if (cleanCalls === 1) return route.fulfill({ status: 502, json: { error: "Synthetic temporary cleanup failure" } });
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ result: { text: "Synthetic recognised page.", edits: [] } }) + "\n" });
    });
    await page.locator("[data-ocr-review-during]").check();
    await page.route("**/ai/ocr/recognize", async route => {
      calls++; const request = route.request().postDataJSON();
      assert.equal(request.adjustment.profile.longest_edge, 512, "OCR uses the applied profile");
      if (calls === 1) await new Promise(resolve => { release = resolve; });
      await route.fulfill({ contentType: "application/x-ndjson", body: [
        { stage: "Loading model weights", elapsed: 10, tokens: 0 }, { stage: "Recognizing page", elapsed: 20, tokens: 16 },
        { result: { page_id: request.page_id, text: "Synthetic recognised page.", model: "fixture", warnings: [] } },
      ].map(JSON.stringify).join("\n") + "\n" });
    });
    await page.locator("[data-ocr-run]").click();
    await page.locator("[data-ocr-job-progress]").waitFor({ state: "visible" });
    assert.match(await page.locator("[data-ocr-job-stage]").textContent(), /page 1 of 2/);
    assert.equal(await page.locator('.ocr-page[data-ocr-state="working"]').count(), 1);
    await page.waitForTimeout(1100);
    assert.match(await page.locator("[data-ocr-job-time]").textContent(), /1s elapsed/);
    assert.equal(await page.locator("[data-ocr-save]").count(), 0, "recovery controls were removed from the dialog");
    await page.screenshot({ path: "node_modules/.verwrity-test-temp/ocr-active-progress.png" });
    release(); await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    assert.equal(calls, 2); assert.equal(await page.locator('.ocr-page[data-ocr-state="complete"]').count(), 2);
    assert.equal(cleanCalls, 2, "one run performs OCR then optional LLM cleanup for every selected page");
    assert.equal(await page.locator('.ocr-page').filter({ hasText: "✓ Correction completed" }).count(), 1, "cleanup failure retains raw OCR and allows the next page");
    await page.locator("[data-ocr-run]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    assert.equal(calls, 2, "retrying combined processing does not repeat successful OCR");
    assert.equal(cleanCalls, 3, "retry handles just the missing correction");
    assert.equal(await page.locator('.ocr-page').filter({ hasText: "✓ Correction completed" }).count(), 2);
    assert.match(await page.locator(".ocr-page").first().textContent(), /✓ OCR completed/);
    const geometry = await page.evaluate(() => {
      const a = document.querySelector("[data-ocr-raw]").getBoundingClientRect(), b = document.querySelector("[data-ocr-cleaned]").getBoundingClientRect();
      return { top: Math.abs(a.top - b.top), height: Math.abs(a.height - b.height) };
    });
    assert(geometry.top < 1 && geometry.height < 1, "raw and correction boxes align and have fixed equal height");
    await page.locator("[data-ocr-show-unchecked]").uncheck();
    await page.locator(".ocr-page:visible button").first().click();
    await page.locator("[data-ocr-next]").click();
    assert.match(await page.locator("[data-ocr-comparison-status]").textContent(), /Viewing capture 2.*checked capture 1/);
    assert.equal(await page.locator(".ocr-page:visible").count(), 2, "comparison does not reveal excluded thumbnails");
    assert(await page.locator("[data-ocr-keep-capture]").isEnabled());
    await page.locator("[data-ocr-keep-capture]").click();
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page input")[1].checked);
    await page.locator("[data-ocr-previous]").click();
    assert.equal(await page.locator("[data-ocr-raw]").inputValue(), "Synthetic recognised page.", "replacing a checked capture retains its earlier OCR");
    await page.locator("[data-ocr-keep-capture]").click();
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page input")[0].checked);
    assert.equal(calls, 2, "neighbour inspection and replacement do not call OCR");
    await page.screenshot({ path: "node_modules/.verwrity-test-temp/ocr-feedback.png", fullPage: true });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Original manuscript.", "OCR and profiles leave manuscript unchanged");
    await page.locator("[data-ocr-show-unchecked]").uncheck();
    await page.waitForTimeout(350);
    await page.reload();
    try { await page.waitForFunction(() => window.verwrityEditor); }
    catch (error) { console.error('OCR reload:', errors, loading, page.url(), await page.locator('[data-rich-editor]').count(), (await page.locator('body').innerText()).slice(-800)); throw error; }
    await open();
    assert.equal(await page.locator("[data-ocr-profile-edge]").inputValue(), "512", "page profile survives recovery");
    assert(await page.locator("[data-ocr-review-during]").isChecked());
    assert(!await page.locator("[data-ocr-show-unchecked]").isChecked());
    assert.equal(calls, 2, "reopening does not restart OCR or cleanup");
    const manuscriptBeforeClear = await page.evaluate(() => window.verwrityEditor.getText());
    await page.locator("[data-ocr-duplicate-threshold]").fill("93");
    await page.locator("[data-ocr-duplicate-threshold]").dispatchEvent("change");
    await page.locator("[data-ocr-video-rotation]").selectOption("180");
    await page.locator("[data-ocr-placement]").selectOption("after");
    await page.evaluate(() => { window.verwrityDialog.confirm = async () => false; });
    await page.locator("[data-ocr-clear]").click();
    assert.equal(await page.locator(".ocr-page").count(), 3, "declining clear preserves captures");
    await page.evaluate(() => { window.verwrityDialog.confirm = async () => true; });
    await page.locator("[data-ocr-clear]").click();
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 0);
    assert.equal(await page.locator("[data-ocr-raw]").inputValue(), "");
    assert.equal(await page.locator("[data-ocr-review]").inputValue(), "");
    assert.equal(await page.locator("[data-ocr-duplicate-threshold]").inputValue(), "75");
    assert.equal(await page.locator("[data-ocr-video-rotation]").inputValue(), "0");
    assert.equal(await page.locator("[data-ocr-placement]").inputValue(), "end");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), manuscriptBeforeClear, "clearing OCR leaves the current manuscript unchanged");
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor); await open();
    assert.equal(await page.locator(".ocr-page").count(), 0, "cleared review does not return from browser recovery");
    assert.equal(await page.locator("[data-ocr-duplicate-threshold]").inputValue(), "75");
    await page.locator("[data-ocr-files]").setInputFiles(a);
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 1 && document.querySelector("[data-ocr-cancel]").disabled);
    assert.equal(await page.locator("[data-ocr-raw]").inputValue(), "", "the same image can be reimported for a fresh test");
    await page.locator('details').filter({ has: page.locator('[data-ocr-profile-edge]') }).locator('summary').click();
    await page.locator("[data-ocr-profile-edge]").fill("512");
    await page.locator("[data-ocr-profile-all]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-status]").textContent.includes("profile applied on 1"));
    await page.route("**/ai/ocr/import", async route => {
      const response = await route.fetch(), value = await response.json();
      value.sharpness = 999999; await route.fulfill({ json: value });
    });
    await page.locator("[data-ocr-files]").setInputFiles({ ...a, name: "sharper-repeat.png" });
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 2 && document.querySelector("[data-ocr-cancel]").disabled);
    assert(!await page.locator(".ocr-page input").nth(0).isChecked(), "earlier blurrier duplicate is retained but unchecked");
    assert(await page.locator(".ocr-page input").nth(1).isChecked(), "later sharper similar capture wins");
    await page.waitForFunction(() => document.querySelector("[data-ocr-image]").naturalHeight === 800);
    assert.equal(await page.locator("[data-ocr-profile-edge]").inputValue(), "1288", "batch profiles apply to existing pages only");
    await page.locator("[data-ocr-profile-reset]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled && document.querySelector("[data-ocr-image]").naturalHeight === 800);
    assert.equal(await page.locator("[data-ocr-profile-stop]").count(), 0);
    await page.locator("[data-ocr-show-unchecked]").uncheck();
    assert.equal(await page.locator(".ocr-page:visible").count(), 1);
    assert.deepEqual(errors, []);
    console.log("PASS: OCR configuration, similarity/manual overrides, sharper repeats, hide unchecked, rotations, fit height, reversible image profiles/recovery, combined OCR/LLM review and failure retry, progress, aligned review, clear and reimport.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
