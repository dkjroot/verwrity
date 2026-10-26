/* Explicit contextual wording suggestions share the Q&A provider and dock. */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    const dock = page.locator("[data-project-question-dock]");
    const input = dock.locator('[name="question"]');
    const action = page.locator("[data-suggest-alternatives]");
    const capture = page.locator("[data-selection-question-context]");
    const quote = "rather heavy";
    const text = `Before this. It felt ${quote} before. 😀 It seems ${quote} today! Afterwards. Last sentence.`;
    const start = Array.from(text.slice(0, text.lastIndexOf(quote))).length;
    const end = start + quote.length;
    const payloads = [];
    let holdNext = false, releaseModel;
    let modelOpened;
    const modelReady = new Promise(resolve => { modelOpened = resolve; });
    await page.route("**/ai/ask/stream", async route => {
      const payload = route.request().postDataJSON(); payloads.push(payload);
      if (holdNext) {
        holdNext = false;
        await new Promise(resolve => { releaseModel = resolve; modelOpened(); });
      }
      const selected = payload.selected_context;
      await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "result", result: {
        answer: "Optional alternatives: quite weighty; a little ponderous; rather cumbersome.",
        evidence: [{ source_type: "scene", source_id: selected.scene_id, title: "Opening",
          quote: selected.quote, start: selected.start, end: selected.end }],
      } })}\n\n` }).catch(() => {}); // Cancellation can close the intercepted request.
    });
    const setText = value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new Event("verwrity-editor-change"));
    }, value);
    const read = () => page.evaluate(() => window.verwrityEditor.getText());
    const idle = () => page.waitForFunction(() => document.querySelector("[data-project-question-dock]").dataset.busy === "false");
    const openSelection = async (from = start, to = end) => {
      await page.evaluate(({ from, to }) => {
        window.verwrityEditor.selectSourceRange(from, to); window.verwrityEditor.focus();
      }, { from, to });
      await page.locator(".ProseMirror").dispatchEvent("contextmenu", { clientX: 0, clientY: 0 });
      await action.waitFor({ state: "visible" });
    };
    await setText(text);
    await input.fill("Keep this unfinished question");
    await openSelection(0, 12); await capture.click();
    const originalPreview = await dock.locator("[data-selected-question-preview]").textContent();
    await openSelection();
    assert.equal(await action.isEnabled(), true);
    assert.equal(await capture.isVisible(), true, "the existing context action remains alongside the shortcut");
    assert.equal(payloads.length, 0, "opening the word menu never asks an LLM");
    await action.click(); await idle();
    assert.equal(payloads.length, 1, "one shortcut click makes one explicit request");
    assert.deepEqual(payloads[0], { request_kind: "alternatives", context_mode: "selection", selected_context: {
      scene_id: await page.evaluate(() => window.verwrityEditor.sceneId),
      project_id: await page.locator("[data-workspace]").getAttribute("data-project-id"),
      start, end, quote, source_hash: createHash("sha256").update(text).digest("hex"),
    } }, "server selects the neighbouring sentences; browser sends only the exact target and saved hash");
    assert.match(await dock.locator(".project-question-answer-text").last().textContent(), /Optional alternatives/);
    assert.equal(await input.inputValue(), "Keep this unfinished question");
    assert.equal(await dock.locator("[data-selected-question-preview]").textContent(), originalPreview,
      "the shortcut does not replace the author's captured Q&A context");
    assert.equal(await read(), text, "suggestions never replace prose");
    await dock.getByRole("button", { name: "Go to passage", exact: true }).click();
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).start, start);

    await page.evaluate(() => { window.__savedQuestionSave = window.verwritySaveActiveScene; window.verwritySaveActiveScene = async () => false; });
    await openSelection(); await action.click(); await idle();
    assert.equal(payloads.length, 1, "failed saves do not start a provider call");
    assert.match(await dock.locator("[data-project-question-status]").textContent(), /could not be saved/);
    await page.evaluate(() => { window.verwritySaveActiveScene = () => new Promise(resolve => { window.__releaseWordingSave = resolve; }); });
    await openSelection(); await action.click();
    await page.waitForFunction(() => Boolean(window.__releaseWordingSave));
    await setText(text + " Changed during save.");
    await page.evaluate(() => { window.verwritySaveActiveScene = window.__savedQuestionSave; window.__releaseWordingSave(true); });
    await idle();
    assert.equal(payloads.length, 1, "edits during saving reject the captured target");
    assert.match(await dock.locator("[data-project-question-status]").textContent(), /selected passage changed/);

    await setText(text); holdNext = true;
    await openSelection(); await action.click();
    await page.waitForFunction(() => document.querySelector("[data-project-question-dock]").dataset.busy === "true");
    await modelReady;
    assert.equal(payloads.length, 2);
    await openSelection();
    assert.equal(await action.isEnabled(), false, "another shortcut cannot overlap the current request");
    await dock.locator("[data-cancel-project-question]").click(); releaseModel(); await idle();
    assert.match(await dock.locator("[data-project-question-status]").textContent(), /Cancelled/);
    assert.equal(await input.inputValue(), "Keep this unfinished question");
    assert.equal(await read(), text);

    await page.evaluate(text => window.verwrityEditor.setText(text, [], false), text);
    await openSelection();
    assert.equal(await action.isEnabled(), false, "read-only revisions cannot supply a current target");
    await page.keyboard.press("Escape");
    await setText(text);
    await page.locator(".ProseMirror").focus(); await page.keyboard.press("Control+Home"); await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+F10");
    assert.equal(await action.isEnabled(), true, "a word lookup can request alternatives for the caret word");
    await page.keyboard.press("Escape");
    await setText("x".repeat(4001)); await openSelection(0, 4001);
    assert.equal(await action.isEnabled(), false, "oversized selections do not start an expensive wording request");
    assert.equal(payloads.length, 2);
    assert.deepEqual(errors, []);
    console.log("PASS: explicit wording shortcut, exact request, unchanged prose/question/context, save guards, cancellation, busy/read-only/no-selection and size limits.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
