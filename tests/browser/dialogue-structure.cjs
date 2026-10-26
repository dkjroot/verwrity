const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert.equal((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated, true);
    await page.request.post(`${url}/__browser_test__/reset`);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    const text = '😀 “Hello.”\n\n“Hello.” End.';
    const setText = value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, value);
    const tools = async () => {
      const menu = page.locator("details.editor-menu").filter({ has: page.locator("[data-review-dialogue]") });
      if (!(await menu.evaluate(node => node.open))) await menu.locator(":scope > summary").click();
    };
    await setText("😀 One.\n\n\n\nTwo.");
    await page.locator(".ProseMirror").focus();
    await page.evaluate(() => {
      const paragraph = document.querySelectorAll(".ProseMirror p")[1];
      const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(true);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.waitForFunction(() => window.verwrityEditor.getCaretOffset() === 8);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getCaretOffset()), 8, "empty paragraph caret includes both source separators");
    await setText(text); await page.evaluate(() => window.verwrityEditor.selectSourceRange(12, 20));
    await tools(); await page.locator(".editor-menu [data-assign-speaker]").click();
    const speaker = page.locator("#speaker-dialog");
    try { await speaker.waitFor({ state: "visible", timeout: 5000 }); } catch (error) { console.log(await page.evaluate(() => ({ editable: window.verwrityEditor.isEditable(), range: window.verwrityEditor.getSelectedRange(), dialogs: [...document.querySelectorAll("dialog[open]")].map(node => node.textContent) })), errors); throw error; }
    await speaker.locator("[data-speaker-select]").selectOption("create");
    await speaker.locator('input[aria-label="New character wiki name"]').fill("Mara");
    await speaker.locator("[type=submit]").click();
    await speaker.waitFor({ state: "hidden" });
    let records = await page.evaluate(() => window.verwrityEditor.getDialogue());
    assert.equal(records.length, 1); assert.equal(records[0].start, 12); assert.equal(records[0].quote, "“Hello.”");
    const identity = records[0].id, speakerId = records[0].speaker_id;
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    assert.equal(await page.locator("[data-wiki-page-list] button").filter({ hasText: /^Mara$/ }).count(), 1);
    const analysis = page.locator("details.analysis-menu");
    await analysis.locator(":scope > summary").click();
    if (await page.locator('[data-annotation-toggle="dialogue"]').getAttribute("aria-pressed") !== "true") await page.locator('[data-annotation-toggle="dialogue"]').click();
    await page.locator('[data-annotation-controls="dialogue"] .annotation-picker:not(.text-analysis-options) > summary').click();
    for (const style of ["squiggly", "double", "highlight", "underline"]) {
      await page.locator('[data-annotation-style="dialogue"]').selectOption(style);
      await page.waitForFunction(style => document.querySelector(".verwrity-dialogue")?.classList.contains(`verwrity-annotation-${style}`), style);
    }
    await page.locator('[data-annotation-color="dialogue"]').evaluate(node => { node.value = "#654321"; node.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector(".verwrity-dialogue")?.getAttribute("style").includes("#654321"));
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.verwritySaveActiveScene());
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelector("#start-dialog")?.close(); document.querySelector("#start-dialog")?.close(); document.querySelector("[data-recovery-dialog]")?.close(); });
    records = await page.evaluate(() => window.verwrityEditor.getDialogue());
    assert.equal(records[0].id, identity); assert.equal(records[0].speaker_id, speakerId);
    await page.waitForFunction(() => document.querySelector(".verwrity-dialogue")?.getAttribute("style").includes("#654321"));
    // Exact second occurrence detaches on deletion; undo restores that known anchor.
    await page.locator(".ProseMirror").focus();
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(12, 20));
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).quote, "“Hello.”");
    await page.keyboard.press("Backspace");
    assert.equal((await page.evaluate(() => window.verwrityEditor.getDialogue()))[0].detached, true, JSON.stringify(await page.evaluate(() => ({ text: window.verwrityEditor.getText(), range: window.verwrityEditor.getSelectedRange(), dialogue: window.verwrityEditor.getDialogue() }))));
    await page.keyboard.press("Control+z");
    records = await page.evaluate(() => window.verwrityEditor.getDialogue());
    assert.equal(records[0].detached, false); assert.equal(records[0].start, 12);
    await page.evaluate(() => window.verwritySaveActiveScene());
    await page.evaluate(id => window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", { detail: id })), speakerId);
    await page.locator("[data-wiki-current-page] button").filter({ hasText: /^Dialogue$/ }).click();
    await page.locator("#dialogue-dialog").waitFor({ state: "visible" });
    await page.locator("[data-dialogue-list] blockquote").first().waitFor();
    assert.match(await page.locator("[data-dialogue-list]").innerText(), /Hello/);
    await page.locator("[data-dialogue-list] button").filter({ hasText: "Go to source" }).click();
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).start, 12);
    // Failure preserves editor; a later successful split transfers stable anchors.
    await page.route("**/structure/split", route => route.fulfill({ status: 503, json: { error: "Synthetic disk failure" } }));
    await tools(); await page.locator("[data-split-scene]").click();
    await page.locator("#scene-structure-dialog").waitFor({ state: "visible" });
    await page.locator("[data-structure-form] [type=submit]").click();
    await page.waitForFunction(() => document.querySelector("[data-structure-error]").textContent.includes("disk failure"));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    await page.unroute("**/structure/split");
    const originalScene = await page.evaluate(() => window.verwrityEditor.sceneId);
    await Promise.all([page.waitForNavigation(), page.locator("[data-structure-form] [type=submit]").click()]);
    await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text.slice(13)); // UTF-16 index includes the emoji.
    records = await page.evaluate(() => window.verwrityEditor.getDialogue());
    assert.equal(records[0].id, identity); assert.equal(records[0].start, 0);
    assert.notEqual(await page.evaluate(() => window.verwrityEditor.sceneId), originalScene);
    await page.evaluate(() => { document.querySelector("#start-dialog")?.close(); document.querySelector("[data-recovery-dialog]")?.close(); });
    await page.evaluate(async id => {
      const form = new FormData(); await fetch(`/scene/select/${id}`, { method: "POST", body: form });
    }, originalScene);
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelector("#start-dialog")?.close(); document.querySelector("[data-recovery-dialog]")?.close(); });
    await tools(); await page.locator("[data-join-scenes]").click();
    const structure = page.locator("#scene-structure-dialog");
    await structure.waitFor({ state: "visible" });
    assert.match(await structure.locator("[data-structure-existing]").innerText(), /Later:/);
    await structure.locator('[name="title"]').fill("Reviewed joined scene");
    await structure.locator('[name="separator"]').selectOption("none");
    await Promise.all([page.waitForNavigation(), structure.locator("[type=submit]").click()]);
    await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(await page.evaluate(() => window.verwrityEditor.sceneId), originalScene);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    assert.equal((await page.evaluate(() => window.verwrityEditor.getDialogue()))[0].id, identity);
    await page.evaluate(() => { document.querySelector("#start-dialog")?.close(); document.querySelector("[data-recovery-dialog]")?.close(); });
    // Export uses a buffer snapshot; endpoint and download do not require saving it.
    await page.evaluate(() => window.verwrityEditor.setText('UNSAVED 😀\n\n“Écoute.”'));
    await tools();
    await page.locator(".editor-menu [data-export-manuscript]").click();
    const exportDialog = page.locator('#manuscript-export-dialog');
    assert(await exportDialog.locator('[name=include_scene_details]').isChecked());
    const downloadPromise = page.waitForEvent("download");
    await exportDialog.getByRole('button', { name: 'Download .txt', exact: true }).click();
    const download = await downloadPromise;
    const output = await fs.readFile(await download.path(), "utf8");
    assert.match(output, /Scene 1: Reviewed joined scene/); assert.match(output, /Description:/); assert.match(output, /UNSAVED 😀/);
    await page.locator('[data-file-operations]').click();
    await page.locator('#file-dialog [data-export-manuscript]').click();
    await exportDialog.locator('[name=include_scene_details]').uncheck();
    const proseDownload = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'Download .txt', exact: true }).click();
    assert.equal(await fs.readFile(await (await proseDownload).path(), 'utf8'), 'UNSAVED 😀\n\n“Écoute.”\n\nWrite the discovery scene here.\n\nWrite the aftermath here.');
    const current = await page.request.get(`${url}/scene/${originalScene}/dialogue`);
    assert.equal((await current.json()).dialogue[0].id, identity);
    assert.deepEqual(errors, []);
    console.log("PASS: speaker creation, stable dialogue, Unicode/repeated quote detach+undo, wiki source view, failed/successful split, join, and plain-text download");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
