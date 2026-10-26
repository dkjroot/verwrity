/* Local collection and persistence with synthetic OCR/LLM responses only. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    const scene = await page.locator("[data-rich-editor]").getAttribute("data-scene-id");
    const manuscript = "Qelvar crossed the valley. Qelvra waited.";
    assert.equal((await page.request.post(`${url}/scene/${scene}/text`, { form: { scene_text: manuscript } })).status(), 204);
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()); window.verwrityDialog.confirm = async () => true; });
    await page.locator(".settings-menu summary").click();
    await page.locator(".settings-menu [data-open-project-words]").click();
    const dialog = page.locator(".project-words-dialog");
    await dialog.waitFor(); await page.locator("[data-words-scan]").click();
    await page.locator('[data-word="Qelvar"]').waitFor();
    assert(!await page.locator('[data-word="Qelvra"]').isChecked());
    await page.locator('[data-word="Qelvar"]').check();
    await page.locator("[data-words-wiki]").click();
    await page.waitForFunction(() => document.querySelector("[data-words-status]").textContent === "Word lists saved.");
    assert.equal(await page.locator('[data-word="Qelvar"]').count(), 0, "accepted candidates disappear");
    const state = await (await page.request.get(`${url}/project/words`)).json();
    assert(state.words.includes("Qelvar")); assert(!state.words.includes("Qelvra"));
    assert(state.wiki_names.includes("Qelvar"));
    assert.equal(await page.locator('[data-wiki-page-list] button').filter({ hasText: /^Qelvar$/ }).count(), 1, "new blank page is available without reloading or leaving the editor");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), manuscript);
    await page.screenshot({ path: "node_modules/.verwrity-test-temp/project-words.png", fullPage: true });
    await page.locator("[data-words-close]").click();
    const spelling = await (await page.request.post(`${url}/scene/${scene}/spell-check`, { form: { scene_text: manuscript } })).json();
    assert(!spelling.annotations.some(item => item.word === "Qelvar"));
    assert(spelling.annotations.some(item => item.word === "Qelvra"));
    await page.evaluate(() => document.querySelector("[data-draft-open]").click());
    await page.locator("#dictate-draft-dialog").waitFor();
    assert.equal(await page.locator("[data-draft-vocabulary]").inputValue(), "", "saved words are implicit; this field is for session extras");
    await page.locator("[data-draft-vocabulary]").fill("Raventh, moonwyrm");
    await page.evaluate(() => document.querySelector("#dictate-draft-dialog").close());
    await page.request.post(`${url}/ai/models/llm`, { data: { standard: "openai_compatible", endpoint: "localhost:8080", model: "fixture" } });
    await page.route("**/ai/ocr", async route => {
      const response = await route.fetch(), value = await response.json();
      value.settings.ocr.readiness = { configured: true, tested: false, message: "Synthetic local OCR" };
      await route.fulfill({ json: value });
    });
    let recognitions = 0, corrections = 0;
    await page.route("**/ai/ocr/recognize", async route => {
      recognitions++; const data = route.request().postDataJSON();
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ result: { page_id: data.page_id, text: "QeIvar met Raventh.", model: "fixture", warnings: [] } }) + "\n" });
    });
    await page.route("**/ai/ocr/cleanup", async route => {
      corrections++; const data = route.request().postDataJSON();
      assert(data.terms.includes("Qelvar")); assert(!data.terms.includes("QeIvar")); assert(!data.terms.includes("Qelvra"));
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ result: { text: "Qelvar met Raventh.", edits: [] } }) + "\n" });
    });
    await page.evaluate(() => document.querySelector("[data-ocr-open]").click());
    await page.locator("#ocr-import-dialog").waitFor();
    const image = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 800; return canvas.toDataURL("image/png").split(",")[1]; });
    await page.locator("[data-ocr-files]").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 1 && document.querySelector("[data-ocr-cancel]").disabled);
    await page.locator("[data-ocr-run]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled && document.querySelector("[data-ocr-raw]").value.includes("QeIvar"));
    await page.locator("[data-ocr-vocabulary]").fill("Raventh");
    await page.locator("[data-ocr-clean-all]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled && document.querySelector("[data-ocr-cleaned]").textContent.includes("Qelvar met"));
    assert.equal(await page.locator("[data-ocr-vocabulary]").evaluate(el => el.readOnly), false);
    await page.locator("[data-ocr-vocabulary]").fill("Raventh, moonwyrm");
    await page.locator("[data-ocr-clean-all]").click();
    await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled);
    assert.equal(corrections, 2, "changed vocabulary permits explicit re-review of ready unapproved pages");
    assert.equal(recognitions, 1, "word review and LLM reruns do not repeat OCR");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), manuscript);
    assert.deepEqual(errors, []);
    console.log("PASS: shared Project words, local manuscript/OCR candidates, grouping, deliberate selection, spelling acceptance, blank wiki pages, dictation reuse, OCR vocabulary correction/rerun and prose safety.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
