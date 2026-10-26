/* Find and replace highlights manuscript text and current scene rows, then changes only heads. */
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
    const sceneIds = await page.locator(".scene-row").evaluateAll(rows => rows.map(row => row.dataset.sceneId));
    await page.evaluate(async ([first, second, historical]) => {
      await fetch(`/scene/${first}/text`, { method: "POST", body: new URLSearchParams({ scene_text: "Mara previous." }) });
      await fetch(`/scene/${first}/revisions/record`, { method: "POST" });
      await fetch(`/scene/${first}/text`, { method: "POST", body: new URLSearchParams({ scene_text: "Mara sees Mara." }) });
      await fetch(`/scene/${second}/text`, { method: "POST", body: new URLSearchParams({ scene_text: "MARA waits." }) });
      await fetch(`/scene/${historical}/remove`, { method: "POST" });
    }, sceneIds);
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));

    await page.locator(".versions-menu").evaluate(element => { element.open = true; });
    await page.locator("[data-scene-revision-select]").selectOption({ label: "Revision 1" });
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Mara previous.");
    await page.locator('.tiptap').click();
    await page.evaluate(() => {
      window.findShortcutPrevented = false;
      document.addEventListener('keydown', event => {
        if (event.ctrlKey && event.key.toLowerCase() === 'f') window.findShortcutPrevented = event.defaultPrevented;
      });
    });
    await page.keyboard.press("Control+f");
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Mara sees Mara.");
    const query = page.locator("[data-find-query]");
    assert.equal(await query.evaluate(element => document.activeElement === element), true, "Ctrl+F opens find and focuses the query");
    assert(await page.evaluate(() => window.findShortcutPrevented), 'Ctrl+F suppresses native browser Find from inside the manuscript');
    await query.fill("mara");
    await page.locator("[data-find-scope]").selectOption("project");
    await page.waitForFunction(() => document.querySelector("[data-find-count]")?.textContent === "3 matches");
    assert.equal(await page.locator(".verwrity-search-match").count(), 2, "active scene matches are highlighted in the manuscript");
    assert.equal(await page.locator(".scene-row.has-search-match").count(), 2, "matching current scenes are marked in the storyboard");

    await page.locator('[data-find-run]').click();
    await page.locator('[data-find-next]').click();
    await page.waitForFunction(() => document.querySelector('[data-find-count]').textContent === '2 of 3 matches');
    await page.locator('[data-find-replacement]').fill('Nia');
    await page.locator('[data-find-replace]').click();
    await page.waitForFunction(() => window.verwrityEditor.getText() === 'Mara sees Nia.');
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).quote, 'Mara', 'Replace selects the next remaining match');
    await page.waitForFunction(() => document.querySelector('[data-find-count]').textContent === '1 of 2 matches');

    await Promise.all([
      page.waitForNavigation(),
      page.locator(`.scene-row[data-scene-id="${sceneIds[1]}"] .scene`).click(),
    ]);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "MARA waits.");
    assert.equal(await page.locator("[data-find-bar]").isVisible(), true, "project search stays open after switching scenes");
    assert.equal(await page.locator("[data-find-query]").inputValue(), "mara", "the search query survives scene navigation");
    await page.waitForFunction(() => document.querySelector("[data-find-count]")?.textContent === "2 matches");
    assert.equal(await page.locator(".verwrity-search-match").count(), 1, "the newly active scene keeps its text highlight");
    await page.locator("[data-find-case-sensitive]").check();
    await page.waitForFunction(() => document.querySelector("[data-find-count]")?.textContent === "0 matches");
    assert.equal(await page.locator(".verwrity-search-match").count(), 0, "case-sensitive search excludes differently cased text");
    await page.locator("[data-find-case-sensitive]").uncheck();
    await page.waitForFunction(() => document.querySelector("[data-find-count]")?.textContent === "2 matches");

    await page.locator("[data-find-replacement]").fill("Nia");
    await page.locator('[data-find-replace]').click();
    await page.waitForFunction(() => window.verwrityEditor.getText() === 'Nia waits.');
    await page.waitForFunction(() => document.querySelector('[data-find-count]').textContent === '1 match');
    assert.equal(await page.locator('.scene-row.has-search-match').count(), 1, 'Single Replace changes this scene instead of the earlier project match');
    await page.locator("[data-find-replace-all]").click();
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Nia waits.");
    await page.waitForFunction(() => document.querySelector("[data-find-count]")?.textContent === "0 matches");
    assert.equal(await page.locator(".historical-scenes a").count(), 1, "the removed scene stays outside search results");

    await Promise.all([
      page.waitForNavigation(),
      page.locator(`.scene-row[data-scene-id="${sceneIds[0]}"] .scene`).click(),
    ]);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Nia sees Nia.");
    assert.equal(await page.locator("[data-find-bar]").isVisible(), true, "search stays open when returning to another scene");

    await page.locator("[data-close-find]").click();
    await page.locator("[data-open-find]").click();
    assert.equal(await page.locator("[data-find-query]").inputValue(), "mara", "reopening Find restores the previous query");
    await page.locator("[data-find-query]").fill("");
    assert.equal(await page.locator(".verwrity-search-match").count(), 0, "clearing the query clears text highlights");
    assert.equal(await page.locator(".scene-row.has-search-match").count(), 0, "clearing the query clears scene highlights");
    await page.locator("[data-close-find]").click();
    assert.equal(await page.locator("[data-find-bar]").isVisible(), false);
    await page.locator(".versions-menu").evaluate(element => { element.open = true; });
    await page.locator("[data-scene-revision-select]").selectOption("head");
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Nia sees Nia.");
    await page.locator("[data-scene-revision-select]").selectOption({ label: "Revision 1" });
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "Mara previous.");
    assert.deepEqual(errors, [], "find and replace produces no browser errors");
    console.log("PASS: find and replace opens with Ctrl+F, marks current scenes, replaces project heads, and clears highlights.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
