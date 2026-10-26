/* Focused browser checks for menus, native spellcheck policy, and annotations. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    let lastGridPost = "";
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.url().endsWith("/storyboard/grid/save")) lastGridPost = request.postData() || "";
    });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    const resetSpelling = await page.request.post(`${url}/preferences/annotations/spelling`, { data: { enabled: false } });
    assert.equal(resetSpelling.status(), 200, "Start the smoke scenario with spelling turned off");
    const dismissStartDialog = () => page.evaluate(() => {
      const dialog = document.querySelector("#start-dialog");
      if (dialog && dialog.open) dialog.close();
    });
    await page.goto(url);
    await dismissStartDialog();
    const writingModeIndicator = page.locator("[data-writing-mode-indicator]");
    assert.equal(await writingModeIndicator.innerText(), "Normal mode", "Normal mode is clearly identified on entry");
    assert.equal(await writingModeIndicator.getAttribute("data-mode"), "normal");

    await page.locator('[data-panel-toggle="wiki"]').click();
    const originalDraft = await page.evaluate(() => window.verwrityEditor.getText());
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+A");
    await page.locator(".focus-menu > summary").click();
    const typewriterToggle = page.locator("[data-typewriter-toggle]");
    await typewriterToggle.click();
    assert.equal(await typewriterToggle.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', 'Typewriter Mode starts maximized');
    await page.locator('.writing-restore-controls > summary').click();
    await page.locator('[data-restore-editor]').click();
    assert.equal(await writingModeIndicator.innerText(), "Typewriter mode", "The indicator updates when Typewriter Mode starts");
    assert.equal(await writingModeIndicator.getAttribute("data-mode"), "typewriter");
    assert.equal(await page.locator("[data-workspace]").getAttribute("data-typewriter-mode"), "true");
    assert.equal(await page.locator("#storyboard-panel").isVisible(), false, "Typewriter Mode starts with the storyboard hidden");
    assert.equal(await page.locator("#wiki-panel").isVisible(), false, "Typewriter Mode starts with the wiki hidden");
    assert.equal(await page.locator(".text-overview").isVisible(), false, "Typewriter Mode hides the text map navigation");
    const caretMovementToggle = page.locator("[data-caret-movement-toggle]");
    assert.equal(await caretMovementToggle.isVisible(), true, "Typewriter Mode exposes a direct caret movement control");
    await caretMovementToggle.click();
    assert.equal(await caretMovementToggle.getAttribute("aria-pressed"), "true", "Caret movement can be temporarily unlocked");
    await page.locator(".ProseMirror p").first().click({ position: { x: 10, y: 10 } });
    await page.keyboard.type("Q");
    const unlockedText = await page.evaluate(() => window.verwrityEditor.getText());
    assert(unlockedText.indexOf("Q") >= 0 && unlockedText.indexOf("Q") < originalDraft.length, "Unlocked caret movement allows a click to reposition editing");
    await page.keyboard.press("Control+z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalDraft);
    await page.keyboard.press("Control+End");
    await caretMovementToggle.click();
    assert.equal(await caretMovementToggle.getAttribute("aria-pressed"), "false", "Caret movement can be locked again without exiting Focus");
    await page.keyboard.type("X");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("Y");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${originalDraft}XY`, "Typewriter Mode keeps typing at the insertion point despite arrow keys");
    await page.locator(".ProseMirror").click({ position: { x: 8, y: 8 } });
    await page.keyboard.type("Z");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${originalDraft}XYZ`, "Mouse clicks cannot move the Typewriter Mode caret");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalDraft, "Backspace remains available for correcting recent typing");
    await page.locator('[data-panel-toggle="storyboard"]').click();
    assert.equal(await page.locator("#storyboard-panel").isVisible(), true);
    assert.equal(await page.locator("[data-workspace]").getAttribute("data-typewriter-mode"), "true", "Opening a panel leaves Typewriter Mode enabled");
    assert.equal(await page.locator(".scene-controls").first().isVisible(), false, "Scene structure controls stay out of reach while drafting");
    await page.locator('[data-panel-toggle="wiki"]').click();
    await page.waitForFunction(() => document.querySelector("[data-save-status]")?.dataset.state === "saved");
    await page.reload();
    await dismissStartDialog();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    assert.equal(await page.locator("[data-typewriter-toggle]").getAttribute("aria-pressed"), "true", "Typewriter Mode persists across workspace reloads");
    assert.equal(await writingModeIndicator.innerText(), "Typewriter mode", "The mode indicator matches the restored mode after reload");
    assert.equal(await page.locator("#storyboard-panel").isVisible(), true, "Panel visibility remains independent of Typewriter Mode");
    assert.equal(await page.locator("#wiki-panel").isVisible(), true, "Wiki visibility remains independent of Typewriter Mode");
    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard");
    await page.locator('[data-board-view-switch="grid"]').click();
    await page.waitForURL("**/storyboard?view=grid");
    assert.equal(await page.locator('input[name^="scene_title_"]').first().getAttribute("readonly"), "", "Scene titles stay read-only while Typewriter Mode is active");
    assert.equal(await page.locator("[data-typewriter-board-notice]").isVisible(), true);
    await page.locator("[data-board-return]").click();
    await page.waitForURL(new URL("/", url).href);
    await dismissStartDialog();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.locator("[data-focus-toggle]").click();
    assert.equal(await typewriterToggle.getAttribute("aria-pressed"), "false");
    assert.equal(await writingModeIndicator.innerText(), "Normal mode", "The indicator returns to Normal mode when Focus exits");
    assert.equal(await page.locator("#storyboard-panel").isVisible(), true, "Exiting Typewriter Mode restores the prior storyboard visibility");
    assert.equal(await page.locator("#wiki-panel").isVisible(), false, "Exiting Typewriter Mode restores the prior hidden wiki state");
    await page.locator("[data-focus-toggle]").click();
    await typewriterToggle.click();
    assert.equal(await page.locator("[data-workspace]").getAttribute("data-typewriter-mode"), "true");
    assert.equal(await page.locator("#storyboard-panel").isVisible(), true, "Typewriter Mode remembers its own storyboard visibility");
    assert.equal(await page.locator("#wiki-panel").isVisible(), true, "Typewriter Mode remembers its own wiki visibility");
    await page.locator("[data-focus-toggle]").click();
    assert.equal(await typewriterToggle.getAttribute("aria-pressed"), "false", "Clicking Focus exits without opening its menu");
    assert.equal(await page.locator("#wiki-panel").isVisible(), false, "Repeated Focus exits keep restoring the normal layout");
    await page.locator('[data-panel-toggle="wiki"]').click();
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("A");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("B");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${originalDraft}BA`, "Turning Typewriter Mode off restores normal caret navigation");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalDraft);

    assert.equal(await page.locator(".wiki-page-list").getAttribute("hidden"), "", "Wiki titles stay tucked away until search");
    await page.fill("#wiki-search", "project");
    await page.waitForFunction(() => !document.querySelector(".wiki-page-list")?.hidden);
    assert(await page.locator(".wiki-page-list .wiki-link").count() > 0, "Wiki search reveals matching titles");
    await page.fill("#wiki-search", "");
    await page.waitForFunction(() => document.querySelector(".wiki-page-list")?.hidden);

    await page.fill("#wiki-search", "Characters");
    await page.waitForFunction(() => !document.querySelector(".wiki-page-list")?.hidden);
    const characterLink = page.locator(".wiki-page-list .wiki-link").filter({ hasText: "Characters" }).first();
    const characterId = await characterLink.getAttribute("data-wiki-page-id");
    const originalCharacterBody = JSON.parse(await page.locator(`template[data-wiki-page="${characterId}"]`).getAttribute("data-body-json"));
    await characterLink.click();
    await page.locator(".wiki-current-page").getByRole("button", { name: "Edit page" }).click();
    const wikiBodyEditor = page.locator(".wiki-page-editor textarea[name='body']");
    await wikiBodyEditor.fill("# Rendering\n\n**bold** *italic* `code`\n- [[Characters|wiki link]]\n> quote\n[source](javascript:alert(1))");
    await page.locator(".wiki-page-editor").getByRole("button", { name: "Preview" }).click();
    const wikiPreview = page.locator(".wiki-preview");
    assert.equal(await wikiPreview.locator("h2").textContent(), "Rendering", "Wiki headings render with the expected level");
    assert.equal(await wikiPreview.locator("strong").textContent(), "bold");
    assert.equal(await wikiPreview.locator("em").textContent(), "italic");
    assert.equal(await wikiPreview.locator("code").textContent(), "code");
    assert.equal(await wikiPreview.locator("[data-wiki-page-id]").textContent(), "wiki link", "Wiki links resolve through the page renderer");
    assert.equal(await wikiPreview.locator("blockquote").textContent(), "quote");
    assert.equal(await wikiPreview.locator("a[href^='javascript:']").count(), 0, "Unsafe URL protocols never become links");
    assert((await wikiPreview.innerText()).includes("[source](javascript:alert(1))"), "Rejected links remain visible as plain text");
    await page.locator(".wiki-page-editor").getByRole("button", { name: "Cancel" }).click();
    const formMenu = page.locator(".wiki-current-page .wiki-template-menu");
    await formMenu.locator(":scope > summary").click();
    assert.equal(await formMenu.getAttribute("open"), "", "Insert form opens its attached choice menu");
    await formMenu.getByRole("button", { name: "Character profile" }).click();
    const expandedCharacterBody = await wikiBodyEditor.inputValue();
    assert(expandedCharacterBody.startsWith(originalCharacterBody), "Inserting a wiki form preserves existing page content");
    assert(expandedCharacterBody.includes("## Theory of control"), "Character form includes a theory of control prompt");
    assert(expandedCharacterBody.includes("Birthplace:"), "Character form includes biographical prompts");
    await page.locator(".wiki-page-editor").getByRole("button", { name: "Save page" }).click();
    await page.waitForURL(`**/?wiki_page=${characterId}`);
    assert((await page.locator(".wiki-page-body").innerText()).includes("Theory of control"), "Inserted form is saved as human-authored wiki content");
    await page.fill("#wiki-search", "");
    await page.waitForFunction(() => document.querySelector(".wiki-page-list")?.hidden);

    await page.locator("[data-wiki-new]").click();
    await page.locator("#app-dialog-input").fill("Browser-created wiki page");
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.locator("#app-dialog").getByRole("button", { name: "Create page" }).click(),
    ]);
    assert.equal(await page.locator(".wiki-current-page h2").textContent(), "Browser-created wiki page");
    await page.fill("#wiki-search", "Project notes");
    const notesLink = page.locator(".wiki-page-list .wiki-link").filter({ hasText: "Project notes" }).first();
    await notesLink.click();
    await page.locator(".wiki-current-page").getByRole("button", { name: "Edit page" }).click();
    const notesBody = page.locator(".wiki-page-editor textarea[name='body']");
    const notesText = await notesBody.inputValue();
    await notesBody.evaluate((textarea) => textarea.setSelectionRange(textarea.value.length, textarea.value.length));
    await page.locator(".wiki-editor-tools").getByRole("button", { name: "Insert link…" }).click();
    await page.locator("#app-dialog-input").fill("Characters");
    await page.locator("#app-dialog").getByRole("button", { name: "Insert link" }).click();
    assert((await notesBody.inputValue()).startsWith(notesText));
    assert((await notesBody.inputValue()).endsWith("[[Characters]]"), "Wiki link prompt inserts at the saved text selection");
    await page.locator(".wiki-page-editor").getByRole("button", { name: "Cancel" }).click();
    await page.fill("#wiki-search", "");
    await page.waitForFunction(() => document.querySelector(".wiki-page-list")?.hidden);

    assert.equal(await page.locator(".ProseMirror").getAttribute("spellcheck"), "false");

    const viewMenu = page.locator("details.view-menu");
    await viewMenu.locator(":scope > summary").click();
    assert.equal(await viewMenu.getAttribute("open"), "");
    await page.locator(".panel-heading h2").click();
    assert.equal(await viewMenu.getAttribute("open"), null, "View menu closes outside itself");

    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("The quik fox recieve.");
    const analysisMenu = page.locator("details.analysis-menu");
    await analysisMenu.locator(":scope > summary").click();
    await analysisMenu.locator("[data-annotation-toggle='spelling']").click();
    await page.waitForFunction(() => document.querySelector("[data-analysis-status]")?.textContent.includes("possible"));
    assert.equal(await page.locator(".verwrity-spelling-error").count(), 2);
    assert((await page.locator(".verwrity-spelling-error").first().getAttribute("title")).includes("quick"));
    await page.locator(".panel-heading h2").click();
    assert.equal(await analysisMenu.getAttribute("open"), null, "Analysis menu closes outside itself");

    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard");
    assert.equal(await page.locator("[data-story-note]").count(), 3);
    await page.locator("[data-story-note]").first().locator("textarea").fill("A clue changes the plan.");
    await page.locator("[data-story-note]").nth(1).locator('[data-note-move="earlier"]').click();
    assert.equal(await page.locator(".story-note-summary").first().evaluate(element => getComputedStyle(element).colorScheme), "light");
    assert.equal(await page.locator(".story-note-summary").first().evaluate(element => getComputedStyle(element).scrollbarWidth), "thin");
    await page.locator("[data-story-note]").last().locator("[data-note-drag-handle]").dragTo(
      page.locator("[data-story-note]").first(),
      { targetPosition: { x: 5, y: 12 } },
    );
    assert.equal(
      await page.locator("[data-story-note]").first().locator("h3").textContent(),
      "Aftermath",
    );
    await page.locator("[data-board-save]").click();
    await page.waitForURL(new URL("/", url).href);
    await dismissStartDialog();
    assert.equal(await page.locator(".scene-row .scene").first().textContent(), "Aftermath");
    assert.equal(await page.locator('.scene-row .scene[title="A clue changes the plan."]').count(), 1);

    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard");
    await page.fill("#new-scene-title", "Browser-added scene");
    await page.fill("#new-scene-summary", "Created from the board.");
    await page.locator(".story-note-add").click();
    await page.waitForURL("**/storyboard");
    assert.equal(await page.locator("[data-story-note]").count(), 4, "Adding a scene stays on the board");
    assert.equal(await page.locator("[data-story-note]").last().locator("h3").textContent(), "Browser-added scene");
    await page.locator("[data-story-note]").last().locator("[data-note-delete]").click();
    await page.locator("#app-dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await page.waitForURL(new URL("/", url).href);
    await dismissStartDialog();
    assert.equal(await page.locator(".scene-row .scene").filter({ hasText: "Browser-added scene" }).count(), 0);
    assert.equal(await page.locator(".historical-scenes").getByText("Browser-added scene").count(), 1);

    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard");
    await page.locator('[data-board-view-switch="grid"]').click();
    await page.waitForURL("**/storyboard?view=grid");
    assert.equal(await page.locator(".storyboard-grid tbody tr").count(), 3);
    assert.equal(await page.locator(".storyboard-grid thead th").first().evaluate(element => getComputedStyle(element).position), "sticky");
    assert.equal(await page.locator(".storyboard-grid tbody th").first().evaluate(element => getComputedStyle(element).position), "sticky");
    await page.fill("#new-column-title", "Alice and Bob");
    await page.locator(".grid-add-column button").click();
    await page.waitForURL("**/storyboard?view=grid");
    await page.locator(".storyboard-grid tbody tr").first().locator('input[name^="scene_title_"]').fill("Aftermath in the grid");
    await page.locator(".storyboard-grid tbody tr").first().locator('textarea[name^="scene_summary_"]').fill("A revised description.");
    await page.locator(".storyboard-grid tbody tr").first().locator("td").nth(1).locator("textarea").fill("They make peace.");
    await page.locator("[data-grid-save]").click();
    await page.waitForURL(new URL("/", url).href);
    await dismissStartDialog();
    assert.equal(await page.locator(".scene-row .scene").first().textContent(), "Aftermath in the grid");
    assert.equal(await page.locator('.scene-row .scene[title="A revised description."]').count(), 1);

    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard");
    await page.locator('[data-board-view-switch="grid"]').click();
    await page.waitForURL("**/storyboard?view=grid");
    assert.equal(await page.locator(".storyboard-grid tbody tr").first().locator("td").nth(1).locator("textarea").inputValue(), "They make peace.");
    await page.locator("[data-delete-column]").click();
    await page.locator("#app-dialog").getByRole("button", { name: "Delete column" }).click();
    await page.waitForURL("**/storyboard?view=grid");
    assert.equal(await page.locator(".grid-custom-column").count(), 0, lastGridPost);
    await page.locator("[data-board-return]").click();
    await page.waitForURL(new URL("/", url).href);

    assert.deepEqual(errors, []);
    console.log("PASS: storyboard notes and grid views, columns, cells, reorder, descriptions, add/delete, and analysis smoke checks");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
