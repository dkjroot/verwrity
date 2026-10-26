const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    const errors = [];
    const lookups = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().endsWith("/thesaurus")) lookups.push(request.postDataJSON()); });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(lookups.length, 0, "No lookup on load");
    const prose = "😀 Happy, happy!\n\nA quiet river.";
    await page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text } }));
    }, prose);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose, "Start with exact canonical paragraph boundaries");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.evaluate(() => {
      const text = window.verwrityEditor.getText();
      const start = Array.from(text.slice(0, text.indexOf("quiet"))).length;
      window.verwrityEditor.setComments([{ id: crypto.randomUUID(), start, end: start + 5, quote: "quiet", original_quote: "quiet", body: "Keep this note", resolved: false }]);
    });
    const menu = page.locator("[data-wiki-selection-menu]");
    const status = menu.locator("[data-thesaurus-status]");
    // A real right-click, without a selection, must target the exact occurrence
    // after an astral character rather than another identical word.
    async function rightClickWord(needle, occurrence = 0) {
      const point = await page.evaluate(({ needle, occurrence }) => {
        const root = document.querySelector(".ProseMirror");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node, seen = 0;
        while (node = walker.nextNode()) {
          let offset = -1;
          while ((offset = node.textContent.indexOf(needle, offset + 1)) >= 0) {
            if (seen++ !== occurrence) continue;
            const range = document.createRange();
            range.setStart(node, offset + 1); range.setEnd(node, offset + 2);
            const rect = range.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
        throw new Error("Word not found");
      }, { needle, occurrence });
      await page.mouse.click(point.x, point.y, { button: "right" });
      await page.waitForFunction(() => document.querySelector("[data-thesaurus-results]")?.querySelector("button"));
      assert.equal(await menu.locator("details[open]").count(), 0, "Every sense starts closed on each lookup");
    }
    await rightClickWord("Happy");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose, "Lookup is read-only");
    assert.equal(lookups.at(-1).word, "Happy");
    assert(await menu.locator("details").count() > 1, "Distinct senses retained");
    assert(await menu.locator("[data-relation='antonym']").count() > 0, "Antonyms labelled separately");
    assert(await menu.locator("[data-add-comment]").isEnabled());
    assert(await menu.locator("[data-create-wiki]").isEnabled());
    const bounds = await menu.boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1100 && bounds.y + bounds.height <= 650);
    if (process.env.VERWRITY_THESAURUS_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_THESAURUS_SCREENSHOT });
    await menu.locator("details > summary").nth(1).click();
    assert.equal(await menu.locator("details[open]").count(), 1, "Only the author-selected sense opens");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose, "Opening a sense preserves prose");
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/thesaurus") && response.status() === 200),
      menu.locator(".thesaurus-lookup button").click(),
    ]);
    await page.waitForFunction(() => document.querySelectorAll("[data-thesaurus-results] details").length > 1);
    assert.equal(await menu.locator("details[open]").count(), 0, "Looking up again resets every sense to closed");
    await menu.locator("details > summary").nth(1).click();
    const alternative = menu.locator("details[open] [data-thesaurus-term]:not(:disabled)").first();
    const replacement = await alternative.textContent();
    await alternative.click();
    const replaced = prose.replace("Happy", replacement[0].toUpperCase() + replacement.slice(1));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), replaced, "Only the captured occurrence changes");
    const note = await page.evaluate(() => window.verwrityEditor.getComments()[0]);
    assert.equal(note.body, "Keep this note");
    assert.equal(note.quote, "quiet");
    assert.equal(note.start, Array.from(replaced.slice(0, replaced.indexOf("quiet"))).length, "Other comment anchors map through the replacement");
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose, "Replacement has a separate undo step");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getComments()[0].quote), "quiet");
    await page.keyboard.press("Control+y");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), replaced, "Redo restores replacement");
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);

    await rightClickWord("happy");
    await menu.locator("#thesaurus-word").fill("zzunfindablewordzz");
    await menu.locator(".thesaurus-lookup button").click();
    await status.filter({ hasText: "No entry found" }).waitFor();
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose);
    await page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false);

    await page.evaluate(() => window.verwrityEditor.setText(window.verwrityEditor.getText(), [], false));
    await rightClickWord("Happy");
    await menu.locator("details > summary").first().click();
    assert(await menu.locator("details[open] [data-thesaurus-term]").first().isDisabled(), "Read-only lookup cannot replace");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.verwrityEditor.setText(window.verwrityEditor.getText()); window.verwrityEditor.setTypewriterMode(true); });
    await rightClickWord("happy");
    await menu.locator("details > summary").first().click();
    assert(await menu.locator("details[open] [data-thesaurus-term]").first().isDisabled(), "Typewriter lock preserved");
    await page.keyboard.press("Escape");
    // Escape restores editor focus on the next frame; let it finish before
    // opening the keyboard menu so it cannot steal the lookup field's focus.
    await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
    await page.evaluate(() => { window.verwrityEditor.setTypewriterMode(false); window.verwrityEditor.selectSourceRange(2, 7); });
    await page.evaluate(() => document.querySelector("[data-rich-editor]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await menu.locator("#thesaurus-word").waitFor({ state: "visible" });
    assert.equal(await menu.locator("#thesaurus-word").inputValue(), "Happy", "Keyboard context lookup uses selection");
    assert(await menu.locator("#thesaurus-word").evaluate(el => el === document.activeElement));
    await page.keyboard.press("Escape");

    await page.route("**/thesaurus", route => route.fulfill({ status: 503, json: { error: "The local thesaurus file could not be read." } }));
    await page.evaluate(() => document.querySelector("[data-rich-editor]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await status.filter({ hasText: "could not be read" }).waitFor();
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), prose, "Failed lookup preserves prose");
    await page.keyboard.press("Escape");
    await page.unroute("**/thesaurus");

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route("**/thesaurus", async route => { await gate; try { await route.fulfill({ json: { word: "happy", senses: [{ part_of_speech: "adj", terms: [{ text: "late", relation: "synonym" }] }] } }); } catch (_) {} });
    await page.evaluate(() => document.querySelector("[data-rich-editor]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1070, clientY: 620 })));
    await status.filter({ hasText: "Looking up" }).waitFor();
    await page.evaluate(() => { window.oldThesaurusTarget = window.verwrityEditor.getContextTarget(0, 0); });
    await page.evaluate(() => window.verwrityEditor.setText("Changed while looking up."));
    release();
    assert.equal(await menu.isVisible(), false, "Source switch closes pending lookup");
    await page.unroute("**/thesaurus");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), "Changed while looking up.");
    assert.equal(await page.evaluate(() => window.oldThesaurusTarget.replace("stale")), false, "The captured action itself rejects a stale document");
    assert.deepEqual(errors, []);
    console.log("PASS: offline thesaurus targets words, labels senses, preserves author control, undo, read-only and stale-response safety.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
