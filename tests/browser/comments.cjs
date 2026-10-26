/* Exercise manuscript comment selection, TODO integration, persistence, and resolution. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    const resetComments = await page.request.post(`${url}/preferences/annotations/comments`, { data: { enabled: false } });
    assert.equal(resetComments.status(), 200, "Start with comment decorations disabled");
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated, "Run against the isolated test server");
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());

    await page.evaluate(() => {
      const editor = document.querySelector("[data-rich-editor]");
      const paragraph = editor.querySelector(".ProseMirror p");
      const text = paragraph.firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, "Paragraph 1".length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.waitForFunction(() => window.verwrityEditor.getSelectedRange()?.quote === "Paragraph 1");
    await page.evaluate(() => {
      const editor = document.querySelector("[data-rich-editor]");
      editor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 180 }));
    });
    const selectionMenu = page.locator("[data-wiki-selection-menu]");
    assert.equal(await selectionMenu.isVisible(), true, "Selecting manuscript text opens its action menu");
    await selectionMenu.locator("[data-add-comment]").click();
    assert.equal(await page.locator("#add-comment-dialog").evaluate(dialog => dialog.open), true,
      `The action menu opens the comment dialog (browser errors: ${errors.join("; ")})`);
    await page.locator("#manuscript-comment-body").fill("Check this beat.");
    await page.locator("#manuscript-comment-todo").check();
    const addedComment = page.waitForResponse(response => response.url().endsWith("/comments") && response.request().method() === "POST");
    await page.locator("[data-comment-form] button[type='submit']").click();
    const response = await addedComment;
    assert.equal(response.status(), 200, "Adding a selected-text comment succeeds");
    await page.waitForFunction(() => document.querySelector(".verwrity-comment"));
    assert.equal(await page.locator(".verwrity-comment").first().textContent(), "Paragraph 1");
    assert.equal(await page.locator(".wiki-current-page h2").textContent(), "TODO", "The optional task opens in the wiki");
    assert((await page.locator(".wiki-page-body").innerText()).includes("Check this beat."));

    const commentText = await page.evaluate(() => window.verwrityEditor.getText());
    const commentData = await page.evaluate(() => window.verwrityEditor.getComments());
    const analysisMenu = page.locator("details.analysis-menu");
    if (!(await analysisMenu.evaluate(element => element.open))) await analysisMenu.locator(":scope > summary").click();
    const controls = page.locator('[data-annotation-controls="comments"]');
    await controls.getByLabel('Comment highlight style', { exact: true }).click();
    for (const style of ["squiggly", "double", "underline", "highlight"]) {
      const saved = page.waitForResponse(response => response.url().endsWith("/preferences/annotations/comments") && response.request().method() === "POST");
      await controls.locator('[data-annotation-style="comments"]').selectOption(style);
      assert.equal((await saved).status(), 200);
      assert.equal(await page.locator(`.verwrity-comment.verwrity-annotation-${style}`).count(), 1);
      const computed = await page.locator('.verwrity-comment').evaluate(element => ({
        line: getComputedStyle(element).textDecorationStyle, background: getComputedStyle(element).backgroundColor,
      }));
      if (style === "highlight") assert.notEqual(computed.background, "rgba(0, 0, 0, 0)");
      else assert.equal(computed.line, { squiggly: "wavy", double: "double", underline: "solid" }[style]);
    }
    await controls.getByLabel('Comment highlight style', { exact: true }).click();
    const savedColor = page.waitForResponse(response => response.url().endsWith("/preferences/annotations/comments") && response.request().method() === "POST");
    await controls.locator('[data-annotation-color="comments"]').evaluate(input => {
      input.value = "#12ab34"; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal((await savedColor).status(), 200);
    assert.match(await page.locator('.verwrity-comment').getAttribute('style'), /#12ab34/);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), commentText);
    assert.deepEqual(await page.evaluate(() => window.verwrityEditor.getComments()), commentData, "appearance never changes note data or anchors");
    await analysisMenu.locator(":scope > summary").click();

    const commentMark = page.locator(".verwrity-comment").first();
    await commentMark.hover();
    const popover = page.locator("[data-comment-popover]");
    await page.waitForFunction(() => document.querySelector("[data-comment-popover]")?.hidden === false);
    assert.equal(await popover.locator("[data-comment-quote]").textContent(), "Paragraph 1");
    assert.equal(await popover.locator("[data-comment-body]").textContent(), "Check this beat.");
    await popover.locator("[data-comment-resolve]").click();
    await page.waitForFunction(() => document.querySelector(".verwrity-comment")?.classList.contains("verwrity-comment-resolved"));
    assert.equal(await popover.locator("[data-comment-resolve]").textContent(), "Reopen");

    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true, "The anchored comment can be saved with its scene");
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => document.querySelector(".verwrity-comment-resolved"));
    assert.equal(await page.locator('.verwrity-comment-resolved.verwrity-annotation-highlight').count(), 1, "resolution keeps the chosen style");
    assert.match(await page.locator('.verwrity-comment').getAttribute('style'), /#12ab34/, "comment colour survives reload");
    assert.equal(await page.locator(".verwrity-comment").first().getAttribute("title"), "Paragraph 1\nCheck this beat.", "Comment and resolved state recover after reload");

    const prefix = "Before 😀 ";
    await page.locator(".ProseMirror").focus();
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(0, 1));
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.insertText(prefix);
    await page.waitForFunction(expected => window.verwrityEditor.getComments()[0]?.start === expected, [...prefix].length);
    assert.equal(await page.locator(".verwrity-comment").first().textContent(), "Paragraph 1", "Unicode insertion before a note shifts its anchor");
    await page.evaluate(() => {
      const comment = window.verwrityEditor.getComments()[0];
      window.verwrityEditor.selectSourceRange(comment.start, comment.end);
    });
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => window.verwrityEditor.getComments()[0]?.detached === true);
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => window.verwrityEditor.getComments()[0]?.detached === false);
    assert.equal(await page.locator(".verwrity-comment").first().textContent(), "Paragraph 1", "Undo restores the mapped passage even after autosave detached it");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForFunction(() => window.verwrityEditor.getComments()[0]?.detached === true);
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.reload();
    await page.waitForFunction(() => window.verwrityEditor?.getComments()[0]?.detached === true);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    assert.equal(await page.evaluate(() => window.verwrityEditor.getComments()[0].original_quote), "Paragraph 1", "A deleted passage keeps its original quotation across reload");
    assert.equal(await page.locator(".verwrity-comment").count(), 0);
    const beforeReattachment = await page.evaluate(() => window.verwrityEditor.getText());
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(" extra");
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(0, 6));
    await page.locator("details.analysis-menu > summary").click();
    await page.getByLabel('Comments options', { exact: true }).click();
    await page.locator("[data-open-comments]").click();
    const review = page.locator("#scene-comments-dialog");
    assert.equal(await review.locator("article strong").textContent(), "Detached · resolved");
    assert.equal(await review.locator("blockquote").textContent(), "Paragraph 1");
    await review.locator("[data-comment-action='reattach']").click();
    await page.waitForFunction(() => window.verwrityEditor.getComments()[0]?.detached === false);
    await review.locator("[data-close-comments]").click();
    await page.locator("details.analysis-menu > summary").click();
    assert.equal(await page.locator(".verwrity-comment").first().textContent(), "Before", "Author-directed reattachment targets the selected passage");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getComments()[0].original_quote), "Paragraph 1");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), beforeReattachment, "Undo removes the later prose edit");
    assert.equal(await page.locator(".verwrity-comment").first().textContent(), "Before", "Undo preserves the author's new attachment rather than restoring an obsolete detached anchor");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);

    const persistedMark = page.locator(".verwrity-comment").first();
    await persistedMark.hover();
    await page.waitForFunction(() => document.querySelector("[data-comment-popover]")?.hidden === false);
    await page.locator("[data-comment-popover] [data-comment-delete]").click();
    await page.waitForFunction(() => !document.querySelector(".verwrity-comment"));
    await page.locator("details.analysis-menu > summary").click();
    const commentsToggle = page.locator("[data-annotation-toggle='comments']");
    if (await commentsToggle.getAttribute("aria-pressed") === "true") await commentsToggle.click();
    assert.deepEqual(errors, [], "Comment interactions produce no browser errors");
    console.log("PASS: manuscript comments can be added from selected text, sent to TODO, recovered, resolved, and deleted.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
