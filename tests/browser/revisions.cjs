/* Focused scene revision workflow and page-leave warning check. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Mara found the silver key.\n\nShe hid it under the floorboards.");
    await page.waitForFunction(() => document.querySelector("[data-save-status]")?.dataset.state === "saved");
    const original = await page.evaluate(() => window.verwrityEditor.getText());

    await page.locator(".versions-menu > summary").click();
    await page.locator("[data-record-scene-revision]").click();
    await page.locator("[data-scene-revision-select] option").filter({ hasText: "Revision 1" }).waitFor({ state: "attached" });
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Mara found a brass key.\n\nShe gave it to Eli.");
    await page.waitForFunction(() => document.querySelector("[data-save-status]")?.dataset.state === "saved");
    const editedHead = await page.evaluate(() => window.verwrityEditor.getText());

    await page.locator(".versions-menu > summary").click();
    await page.locator("[data-scene-revision-select]").selectOption({ label: "Revision 1" });
    await page.waitForFunction(text => window.verwrityEditor?.getText() === text, original);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original);
    assert.equal(await editor.getAttribute("contenteditable"), "false", "Recorded revisions are read-only when viewed");
    await page.locator("[data-scene-diff-left]").selectOption({ label: "Revision 1" });
    await page.locator("[data-scene-diff-right]").selectOption("head");
    await page.locator("[data-compare-scene-revisions]").click();
    await page.locator("#scene-diff-dialog").waitFor({ state: "visible", timeout: 5000 });
    assert(await page.locator(".scene-diff-line.removed").count() > 0);
    assert(await page.locator(".scene-diff-line.added").count() > 0);
    await page.locator('[data-diff-wrap]').check();
    assert.equal(await page.locator('.scene-diff-pane').first().evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap');
    await page.locator('[data-diff-wrap]').uncheck();
    assert.equal(await page.locator('.scene-diff-pane').first().evaluate(el => getComputedStyle(el).whiteSpace), 'pre');
    await page.locator("[data-close-scene-diff]").click();

    await page.locator(".versions-menu > summary").click();
    await page.locator("[data-restore-scene-revision]").click();
    await page.locator("[data-app-dialog-accept]").click();
    await page.locator("[data-scene-revision-select] option").filter({ hasText: "Revision 2" }).waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original);
    assert.equal(await page.locator("[data-scene-revision-select] option").filter({ hasText: "Revision 2" }).count(), 1);
    await page.locator(".versions-menu > summary").click();
    await page.locator("[data-scene-revision-select]").selectOption({ label: "Revision 2" });
    await page.waitForFunction(text => window.verwrityEditor?.getText() === text, editedHead);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), editedHead, "The pre-restore head remains available as a revision");

    const leaveWarning = await page.evaluate(() => {
      window.verwrityMarkProjectChanged();
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(leaveWarning, true, "Unsaved named-project changes trigger a leave warning");
    assert.deepEqual(errors, [], "Revision actions do not raise browser errors");
    console.log("PASS: scene revisions can be recorded, viewed, compared, and restored into a new head.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
