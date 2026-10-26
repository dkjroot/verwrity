/* First-session writing regressions: paid findings, formatting, saving and place. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    const setText = text => page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text } }));
    }, text);
    const read = () => page.evaluate(() => window.verwrityEditor.getText());
    const menu = selector => page.locator(selector).evaluate(element => { element.open = true; });
    let calls = 0;
    await page.route("**/scene/*/text-analysis/cliche", async route => {
      calls += 1;
      const text = route.request().postDataJSON().scene_text;
      const annotations = [...text.matchAll(/Cold as ice/gu)].map((match, index) => {
        const start = Array.from(text.slice(0, match.index)).length;
        return { id: `finding-${index}`, start, end: start + 11, quote: match[0], explanation: `Review ${index + 1}.` };
      });
      await route.fulfill({ json: { scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: "cliche", annotations } });
    });
    await setText("😀 Before.\n\nCold as ice.\n\nCold as ice.\n\nThe quik fox.");
    await menu("details.analysis-menu");
    const row = page.locator('[data-text-analysis="cliche"]');
    await row.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelectorAll(".verwrity-text-analysis-cliche").length === 2);
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.insertText("🦊 Extra.\n\n");
    assert.equal(await page.locator(".verwrity-text-analysis-cliche").count(), 2, "an insertion before findings preserves both");
    await page.evaluate(() => {
      const editor = window.verwrityEditor, text = editor.getText();
      const start = Array.from(text.slice(0, text.indexOf("Cold as ice"))).length;
      editor.selectSourceRange(start, start + 11);
      editor.focus();
    });
    await page.keyboard.insertText("Very cold");
    assert.equal(await page.locator(".verwrity-text-analysis-cliche").count(), 1, "only the corrected finding disappears");
    assert.equal(calls, 1, "editing does not invoke a paid analysis");
    await menu("details.analysis-menu");
    await row.locator("[data-toggle-text-analysis]").click();
    await row.locator("[data-toggle-text-analysis]").click();
    assert.equal(calls, 1, "showing a retained analysis does not invoke a model");
    await menu('[data-text-analysis="cliche"] [data-text-analysis-findings]');
    await row.locator("[data-text-analysis-findings] button").click();
    const selected = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    assert.equal(selected.quote, "Cold as ice");
    assert.equal(selected.start, Array.from((await read()).split("Cold as ice")[0]).length, "navigation follows the remaining exact occurrence after Unicode and paragraph edits");
    await page.evaluate(() => {
      const editor = window.verwrityEditor, text = editor.getText();
      const start = Array.from(text.slice(0, text.indexOf("quik"))).length;
      editor.setAnnotationOptions("spelling", { enabled: true });
      editor.setAnnotations([{ id: "spelling", start, end: start + 4, word: "quik", suggestions: ["quick"] }]);
    });
    await page.locator(".verwrity-spelling-error").click();
    assert.equal(await page.locator(".project-words-dialog").count(), 0);
    assert.equal(await page.locator(".ProseMirror").evaluate(element => element.contains(document.activeElement)), true);
    await page.evaluate(() => { const e = window.verwrityEditor, r = e.getSelectedRange(); e.focus(); });
    await page.keyboard.press("Control+Home");
    await page.keyboard.insertText("Prefix ");
    await page.evaluate(() => {
      window.verwrityEditor.setAnnotationOptions("spelling", { enabled: false });
      window.verwrityEditor.setAnnotationOptions("spelling", { enabled: true });
    });
    assert.equal(await page.locator(".verwrity-spelling-error").textContent(), "quik", "spelling style toggles keep mapped positions");

    const formatSource = "Fresh.\n\n\tRunning.\n\n    Also running.\n\nFresh section.";
    await setText(formatSource);
    await menu(".editing-menu");
    assert.equal(await page.locator('p[data-paragraph-kind="running"]').count(), 2);
    await menu(".view-menu");
    const sectionMarkers = page.locator("[data-section-markers]");
    assert.equal(await sectionMarkers.isChecked(), false, "section glyphs are optional and initially hidden");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 0);
    const paragraphGeometry = () => page.locator(".ProseMirror p").evaluateAll(paragraphs => paragraphs.map(p => {
      const rect = p.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    }));
    const beforeMarkers = await paragraphGeometry();
    await sectionMarkers.check();
    assert.deepEqual(await page.locator("p.verwrity-section-start").allTextContents(), ["Fresh.", "Fresh section."]);
    assert.deepEqual(await paragraphGeometry(), beforeMarkers, "margin glyphs do not change paragraph geometry");
    assert.equal(await read(), formatSource, "section glyphs do not add source characters");
    assert.equal(await page.locator(".ProseMirror").evaluate(element => element.textContent.includes("*")), false,
      "glyphs are absent from selectable manuscript text");
    const glyphStyle = await page.locator("p.verwrity-section-start").first().evaluate(p => {
      const style = getComputedStyle(p, "::before");
      return { content: style.content, opacity: Number(style.opacity), position: style.position, pointerEvents: style.pointerEvents };
    });
    assert(glyphStyle.content.includes("*"), "fresh sections have an asterisk glyph");
    assert(glyphStyle.opacity > 0 && glyphStyle.opacity < 1, "glyphs are dimmed");
    assert.equal(glyphStyle.position, "absolute");
    assert.equal(glyphStyle.pointerEvents, "none", "glyphs cannot capture caret clicks");
    await page.locator("[data-paragraph-indentation]").uncheck();
    assert.equal(await page.locator(".verwrity-hidden-indent").count(), 2);
    assert.equal(await page.locator("p.verwrity-section-start").count(), 2, "hiding indentation preserves section feedback");
    assert.equal(await read(), formatSource, "hiding indentation does not change canonical prose");
    await page.locator("[data-paragraph-indentation]").check();
    assert.equal(await page.locator(".verwrity-hidden-indent").count(), 0);
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(9, 16));
    await menu(".editing-menu");
    await page.locator('[data-mark-paragraph="section"]').click();
    assert.equal(await page.locator('p[data-paragraph-kind="running"]').count(), 1);
    assert.equal(await page.locator("p.verwrity-section-start").count(), 3, "explicit fresh-section marks update the glyph");
    await page.keyboard.press("Control+z");
    assert.equal(await read(), formatSource, "paragraph-kind changes are undoable source edits");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 2, "undo restores the original classification");
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(0, 5));
    await menu(".editing-menu");
    await menu(".editing-menu");
    await page.locator('[data-mark-paragraph="running"]').click();
    assert.equal(await page.locator("p.verwrity-section-start").count(), 1, "explicit running marks remove the glyph");
    await page.keyboard.press("Control+z");
    assert.equal(await read(), formatSource);
    await page.locator('.ProseMirror p').first().click({ position: { x: 1, y: 8 } });
    try { await page.waitForFunction(() => !window.verwrityEditor.getSelectedRange() && window.verwrityEditor.getCaretOffset() === 0); }
    catch (error) { console.error('Paragraph caret:', await page.evaluate(() => ({ caret: window.verwrityEditor.getCaretOffset(), selected: window.verwrityEditor.getSelectedRange(), active: document.activeElement.outerHTML.slice(0, 200), dom: [getSelection()?.anchorNode?.textContent, getSelection()?.anchorOffset, getSelection()?.focusOffset], hidden: document.hidden, text: window.verwrityEditor.getText() }))); throw error; }
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelectorAll('p.verwrity-section-start').length === 1);
    assert.equal(await page.locator("p.verwrity-section-start").count(), 1, "typed indentation updates inferred sections");
    await page.keyboard.press("Backspace");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 2, "deleting indentation restores the section glyph");
    assert.equal(await read(), formatSource);
    await menu(".view-menu");
    await sectionMarkers.uncheck();
    assert.equal(await page.locator("p.verwrity-section-start").count(), 0);
    await sectionMarkers.check();
    await setText("Fresh.\n\n\n\n\t\n\n    ");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 1, "empty and whitespace-only paragraphs have no glyph");
    await setText(Array.from({ length: 24 }, (_, index) => `Section ${index}. ${"The river is quiet in the evening. ".repeat(18)}`).join("\n\n"));
    await menu(".view-menu");
    await page.locator("[data-view-mode]").selectOption("pages");
    await page.waitForFunction(() => {
      const pm = document.querySelector(".ProseMirror"), breaks = [...pm.querySelectorAll(".breaker")];
      return breaks.length && pm.lastElementChild.getBoundingClientRect().bottom <= breaks.at(-1).getBoundingClientRect().bottom + 1;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const firstLines = await page.locator("p.verwrity-section-start").evaluateAll(paragraphs => paragraphs.map(p => {
      const text = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
      const rect = range.getBoundingClientRect();
      return { top: rect.top, left: rect.left, paragraphTop: p.getBoundingClientRect().top };
    }));
    assert(firstLines.some(line => line.top - line.paragraphTop > 50), "fixture includes a first line pushed past a page spacer");
    // Pseudo-elements have no DOM rectangle; inspect their rendered boxes so a
    // glyph cannot drift into a page gap while its paragraph text moves on.
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "p.verwrity-section-start" });
    for (const [index, nodeId] of nodeIds.entries()) {
      const { node } = await cdp.send("DOM.describeNode", { nodeId });
      const pseudo = node.pseudoElements.find(element => element.pseudoType === "before");
      const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: pseudo.backendNodeId });
      assert(Math.abs(model.border[1] - firstLines[index].top) < 10,
        `section glyph stays beside the first line across page breaks: ${JSON.stringify({ index, markerTop: model.border[1], line: firstLines[index] })}`);
      assert(model.border[2] < firstLines[index].left, "section glyph stays in the left margin");
    }
    await cdp.detach();
    await page.locator("[data-view-mode]").selectOption("continuous");
    await setText("");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.type("A running paragraph.");
    assert.equal(await read(), "\tA running paragraph.", "Tab at the paragraph start inserts source indentation");
    await menu(".editing-menu");
    const spacingSource = "Hello.  Next.\n\n\tRunning.  Again.\n\nMr. Smith. Last.";
    await setText(spacingSource);
    await page.locator("[data-sentence-spacing]").selectOption("1");
    await page.locator("[data-apply-sentence-spacing]").click();
    assert.equal(await read(), "Hello. Next.\n\n\tRunning. Again.\n\nMr. Smith. Last.");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+z");
    assert.equal(await read(), spacingSource, "spacing conversion is one undoable action");
    await menu(".editing-menu");
    await page.locator("[data-sentence-spacing]").selectOption("2");
    await setText("");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.type("Hello. Next.");
    assert.equal(await read(), "Hello.  Next.", "two-space mode applies while typing");
    await menu(".editing-menu");
    await page.locator("[data-sentence-spacing]").selectOption("1");
    await setText("");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.type("Hello.  Next.");
    assert.equal(await read(), "Hello. Next.", "one-space mode tolerates the author's two-space typing habit");

    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.querySelector("[data-save-project]").dataset.state === "saved");
    await page.keyboard.type(" More.");
    assert.equal(await page.locator("[data-save-project]").first().getAttribute("data-state"), "unsaved");
    await page.locator("[data-save-project]").first().click();
    await page.waitForFunction(() => document.querySelector("[data-save-project]").dataset.state === "saved");
    assert.equal(await read(), "Hello. Next. More.", "saving keeps the editor and its buffer mounted");
    let releaseSave, namedFetched;
    const namedReady = new Promise(resolve => { namedFetched = resolve; });
    await page.route("**/project/library-save", async route => {
      const response = await route.fetch();
      namedFetched();
      await new Promise(resolve => { releaseSave = resolve; });
      await route.fulfill({ response });
    });
    await page.keyboard.press("Control+s");
    await namedReady;
    await page.locator(".ProseMirror").focus();
    await page.keyboard.type(" Later.");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    releaseSave();
    await page.waitForFunction(() => !document.querySelector("[data-save-project]").disabled);
    assert.equal(await page.locator("[data-save-project]").first().getAttribute("data-state"), "unsaved",
      "an older named-save response cannot mark newer edits saved");
    await page.unroute("**/project/library-save");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.type(" Still writing.");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true,
      "an older named-save response cannot replace the newer draft hash");
    const longText = Array.from({ length: 70 }, (_, i) => `Paragraph ${i}. ${"The river is quiet. ".repeat(10)}`).join("\n\n");
    await setText(longText);
    await page.evaluate(() => window.verwritySaveActiveScene());
    await page.evaluate(() => {
      window.verwrityEditor.selectSourceRange(500, 510);
      const viewport = document.querySelector("[data-editor-viewport]");
      viewport.scrollTop = 1800;
    });
    const top = await page.locator("[data-editor-viewport]").evaluate(element => element.scrollTop);
    await page.locator("[data-storyboard-link]").click();
    await page.waitForURL("**/storyboard*");
    await page.locator("[data-board-return]").click();
    await page.waitForFunction(() => document.querySelector("[data-editor-viewport]")?.scrollTop > 1000);
    assert(Math.abs(await page.locator("[data-editor-viewport]").evaluate(element => element.scrollTop) - top) < 20);
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).start, 500);
    if (await page.locator("#wiki-panel").evaluate(element => element.hidden)) await page.locator('[data-panel-toggle="wiki"]').click();
    await page.locator("[data-wiki-search]").fill("Characters");
    const characterPage = page.locator(".wiki-link[data-wiki-page-id]").getByText("Characters", { exact: true });
    const characterId = await characterPage.getAttribute("data-wiki-page-id");
    await characterPage.click();
    await page.locator("[data-wiki-search]").fill("");
    await page.locator(".wiki-current-page").getByRole("button", { name: "Edit page", exact: true }).click();
    await page.locator(".wiki-page-editor textarea[name=body]").fill("Human wiki edit from the observations regression.");
    await Promise.all([
      page.waitForURL(next => next.searchParams.get("wiki_page") === characterId),
      page.locator(".wiki-page-editor").getByRole("button", { name: "Save page", exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector(".wiki-page-body")?.textContent.includes("Human wiki edit from the observations regression."));
    await page.waitForFunction(() => document.querySelector("[data-editor-viewport]")?.scrollTop > 1000);
    assert(Math.abs(await page.locator("[data-editor-viewport]").evaluate(element => element.scrollTop) - top) < 20,
      "saving a wiki page restores the manuscript reading position");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.querySelector("[data-save-project]").dataset.state === "saved");
    await page.locator("[data-file-operations]").click();
    await page.locator("#file-dialog form[action$='/project/new'] button").click();
    await page.locator("[data-app-dialog-input]").fill("Observation test");
    await page.locator("[data-app-dialog-accept]").click();
    await page.waitForFunction(() => document.querySelector(".project-name").textContent === "Observation test");
    await page.waitForFunction(() => window.verwrityEditor && document.querySelector('[data-save-project]').dataset.state === 'saved');
    assert.equal(await page.locator(".scene-row").count(), 1);
    assert.equal(await page.locator(".scene-row .scene").textContent(), "Scene 1");
    assert.equal(await page.locator("[data-save-project]").first().getAttribute("data-state"), "saved");
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
    assert.equal(await read(), "");
    await page.locator(".ProseMirror").focus();
    await page.keyboard.type("New project prose.");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => document.querySelector("[data-save-project]").dataset.state === "saved");
    await page.reload();
    await page.waitForFunction(() => window.verwrityEditor?.getText() === "New project prose.");
    assert.equal(await page.locator("[data-section-markers]").isChecked(), true, "section-marker preference survives reload and project changes");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 1);
    assert.equal(await page.locator("[data-save-project]").first().getAttribute("data-state"), "saved", "named save state survives reload");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("PASS: observations: retained exact findings, caret spelling, compound boundaries, paragraph types, spacing/undo, project saving, position restoration and named Scene 1.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
