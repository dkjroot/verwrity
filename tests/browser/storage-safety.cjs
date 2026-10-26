/* Protect stale tab buffers and keep failed named saves in the editor. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const first = await context.newPage();
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    const marker = await first.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated);
    await first.request.post(`${url}/__browser_test__/reset`);
    await first.goto(url);
    await first.waitForFunction(() => window.verwrityEditor);
    await first.evaluate(() => document.querySelector("#start-dialog")?.close());
    const second = await context.newPage();
    await second.goto(url);
    await second.waitForFunction(() => window.verwrityEditor);
    await second.evaluate(() => document.querySelector("#start-dialog")?.close());
    const edit = (page, text) => page.evaluate(value => {
      window.verwrityEditor.setText(value, [], true);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, text);
    await edit(first, "Latest prose from the first tab.");
    assert.equal(await first.evaluate(() => window.verwritySaveActiveScene()), true);
    await edit(second, "Unsaved prose from the second tab.");
    const conflict = second.waitForResponse(response => response.url().endsWith("/text") && response.status() === 409);
    assert.equal(await second.evaluate(() => window.verwritySaveActiveScene()), false);
    await conflict;
    assert.equal(await second.evaluate(() => window.verwrityEditor.getText()), "Unsaved prose from the second tab.");
    assert.match(await second.locator("[data-save-status]").textContent(), /changed elsewhere.*edits kept/i);
    await first.reload();
    await first.waitForFunction(() => window.verwrityEditor?.getText() === "Latest prose from the first tab.");
    await first.evaluate(() => document.querySelector("#start-dialog")?.close());

    await edit(first, "Prose retained after a failed named save.");
    assert.equal(await first.evaluate(() => window.verwritySaveActiveScene()), true);
    await first.route("**/project/library-save", route => route.fulfill({
      status: 400, contentType: "application/json", body: JSON.stringify({ error: "Project exceeds the archive size limit" }),
    }));
    await first.locator("[data-file-operations]").click();
    const failed = first.waitForResponse(response => response.url().endsWith("/project/library-save") && response.status() === 400);
    await first.locator("#save-project-form button[type='submit']").click();
    await failed;
    await first.waitForFunction(() => document.querySelector("#app-dialog")?.open);
    assert.equal(await first.evaluate(() => window.verwrityEditor.getText()), "Prose retained after a failed named save.");
    assert.match(await first.locator("[data-app-dialog-message]").textContent(), /archive size limit/);
    assert.equal(await first.evaluate(() => sessionStorage.getItem("verwrity-project-needs-named-save")), "true");
    console.log("PASS: stale tabs preserve their buffers; failed named saves preserve prose and save reminders.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
