/* Explicit manuscript-selection context for arbitrary questions; no automatic AI. */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    const quote = "The same 😀 sentence.\nAnother line.";
    const text = `Before this.\n\n${quote}\n\nBetween passages.\n\n${quote}\n\nAfter this.`;
    const start = Array.from(text.slice(0, text.lastIndexOf(quote))).length;
    const end = start + Array.from(quote).length;
    const dock = page.locator("[data-project-question-dock]");
    const input = dock.locator('[name="question"]');
    const action = page.locator("[data-selection-question-context]");
    const preview = dock.locator("[data-selected-question-preview]");
    const ask = dock.locator("[data-project-question-submit]");
    const payloads = [];
    await page.route("**/ai/ask/stream", async route => {
      const payload = route.request().postDataJSON();
      payloads.push(payload);
      const selected = payload.selected_context;
      await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "result", result: {
        answer: "A controlled answer about the passage.", evidence: selected ? [{ source_type: "scene", source_id: selected.scene_id,
          title: "Opening", quote: selected.quote, start: selected.start, end: selected.end }] : [],
      } })}\n\n` });
    });
    const setText = value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new Event("verwrity-editor-change"));
    }, value);
    const idle = () => page.waitForFunction(() => document.querySelector("[data-project-question-dock]").dataset.busy === "false");
    const openSelection = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(({ start, end }) => {
        window.verwrityEditor.selectSourceRange(start, end);
        window.verwrityEditor.focus();
      }, { start, end });
      await page.waitForFunction(() => {
        const selection = window.getSelection();
        return selection?.rangeCount && !selection.isCollapsed
          && document.querySelector(".ProseMirror").contains(selection.anchorNode)
          && selection.getRangeAt(0).getClientRects().length;
      });
      const point = await page.evaluate(() => {
        const rect = window.getSelection().getRangeAt(0).getClientRects()[0];
        return { x: rect.left + 8, y: rect.top + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y, { button: "right" });
      await action.waitFor({ state: "visible" });
    };
    const capture = async () => { await openSelection(); await action.click(); };
    await setText(text);
    await dock.locator(".project-question-options > summary").click();
    await dock.locator('[name="before_percent"]').fill("25");
    await dock.locator('[name="after_percent"]').fill("65");
    await dock.locator(".project-question-options > summary").click();
    await input.fill("An earlier question about the project");
    await ask.click(); await idle();
    assert.equal(payloads.length, 1);
    await input.fill("Keep my unfinished question");
    await capture();
    assert.equal(payloads.length, 1, "capturing context never invokes a model");
    assert.equal(await preview.textContent(), quote, "the preview preserves exact Unicode and line breaks");
    assert.equal(await input.inputValue(), "Keep my unfinished question");
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    await ask.click(); await idle();
    const selectedPayload = payloads.at(-1);
    assert.deepEqual(selectedPayload, { question: "Keep my unfinished question", context_mode: "selection", selected_context: {
      scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), project_id: await page.locator("[data-workspace]").getAttribute("data-project-id"),
      start, end, quote, source_hash: createHash("sha256").update(text).digest("hex"),
    } }, "selected context excludes project ranges, wiki and prior conversation");
    await dock.getByRole("button", { name: "Go to passage", exact: true }).click();
    const range = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    assert.equal(range.start, start, "citation navigation returns to the selected repeated occurrence");
    assert.equal(range.quote, quote);
    await dock.locator(".project-question-options > summary").click();
    await dock.locator('[name="context_mode"]').selectOption("project");
    assert.equal(await dock.locator("[data-project-context-range]").isVisible(), true);
    assert.equal(await dock.locator('[name="before_percent"]').inputValue(), "25");
    assert.equal(await dock.locator('[name="after_percent"]').inputValue(), "65");
    await dock.locator('[name="context_mode"]').selectOption("selection");
    assert.equal(await preview.textContent(), quote);
    await dock.locator(".project-question-options > summary").click();
    await page.locator(".ProseMirror").focus();
    await page.keyboard.press("Control+End"); await page.keyboard.insertText(" Edited.");
    assert.equal(await ask.isEnabled(), false, "an edit invalidates captured context without expanding to the whole project");
    assert.match(await preview.textContent(), /Select a passage again/);
    assert.equal(payloads.length, 2);
    await dock.locator("[data-clear-question-context]").click();
    assert.equal(await ask.isEnabled(), true);
    assert.equal(await dock.locator("[data-selected-question-context]").isVisible(), false);

    await setText(text); await capture(); await input.fill("Question while saving");
    await page.evaluate(() => {
      const original = window.verwritySaveActiveScene;
      let first = true;
      window.verwritySaveActiveScene = () => first ? (first = false, new Promise(resolve => {
        window.__releaseContextSave = () => { window.verwritySaveActiveScene = original; resolve(true); };
      })) : original();
    });
    await ask.click();
    await page.waitForFunction(() => Boolean(window.__releaseContextSave));
    await setText(text + " Changed during save.");
    await page.evaluate(() => window.__releaseContextSave()); await idle();
    assert.equal(payloads.length, 2, "a source edit while saving cannot send stale selected context");
    assert.match(await dock.locator("[data-project-question-status]").textContent(), /selected passage changed/);
    await dock.locator("[data-clear-question-context]").click();

    await setText(text);
    await page.evaluate(() => document.querySelector("[data-standard-focus-toggle]").click());
    assert.equal(await dock.isVisible(), false);
    await capture();
    assert.equal(await dock.isVisible(), true, "choosing Ask context exits focus using the existing layout controls");
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => document.querySelector("[data-maximize-editor]").click());
    assert.equal(await dock.isVisible(), false);
    await capture();
    assert.equal(await dock.isVisible(), true, "a maximized editor restores access to the question dock");
    await page.evaluate(text => window.verwrityEditor.setText(text, [], false), text);
    await page.evaluate(({ start, end }) => window.verwrityEditor.selectSourceRange(start, end), { start, end });
    await page.locator(".ProseMirror").dispatchEvent("contextmenu", { clientX: 0, clientY: 0 });
    await action.waitFor({ state: "visible" });
    assert.equal(await action.isEnabled(), false, "historical/read-only text cannot become current-source context");
    await page.keyboard.press("Escape");
    await page.evaluate(text => window.verwrityEditor.setText(text), text);
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+Home"); await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+F10");
    assert.equal(await action.isEnabled(), true, "word lookup uses the caret word as context");
    await page.keyboard.press("Escape");
    await capture();
    await page.evaluate(() => window.verwritySaveActiveScene());
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(await dock.locator('[name="context_mode"]').inputValue(), "project", "selected context is transient, never restored onto a different source");
    assert.equal(await dock.locator("[data-selected-question-context]").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("PASS: right-click selected Q&A context, exact preview/citations, source invalidation, save races, focus restoration, scope reset and no automatic model calls.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
