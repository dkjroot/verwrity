/* Real signed proposal/apply flow through a controlled local model HTTP server. */
const assert = require("node:assert/strict");
const http = require("node:http");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const prompts = [];
  let calls = 0, completedCalls = 0, answer, release, held = false;
  const provider = http.createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); assert(body.messages.some(message => message.content.includes("dialogue")));
    prompts.push(body.messages.map(message => message.content).join("\n"));
    calls += 1;
    if (held) await new Promise(resolve => { release = resolve; });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    completedCalls += 1;
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    const configured = await page.request.post(`${url}/ai/models/llm`, { data: {
      standard: "openai_compatible", endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: "synthetic-test-model",
    } });
    assert.equal(configured.status(), 200);
    const text = '😀 “Hello.”\n\n“Hello.” End.';
    await page.evaluate(text => { window.verwrityEditor.setText(text); window.dispatchEvent(new CustomEvent("verwrity-editor-change")); }, text);
    // Leave this editor buffer unsaved: Run must capture it through the usual save guards.
    await page.request.post(`${url}/wiki/page/create`, { form: { title: "Tagged speaker" } });
    let pageChoices = (await (await page.request.get(`${url}/dialogue/characters`)).json()).pages;
    const tagged = pageChoices.find(item => item.title === "Tagged speaker");
    await page.request.post(`${url}/wiki/page/${tagged.id}/save`, { form: { title: tagged.title, tags: "Character", body: "Human biography" } });
    pageChoices = (await (await page.request.get(`${url}/dialogue/characters`)).json()).pages;
    const untagged = pageChoices.find(item => item.title === "Project notes");
    const untaggedBefore = await (await page.request.get(`${url}/wiki/page/${untagged.id}/data`)).json();
    const sceneTools = async () => {
      const menu = page.locator("details.editor-menu").filter({ has: page.locator("[data-split-scene]") });
      if (!(await menu.evaluate(node => node.open))) await menu.locator(":scope > summary").click();
    };
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(2, 10));
    await sceneTools(); await page.locator(".editor-menu [data-assign-speaker]").click();
    const manual = page.locator("#speaker-dialog");
    const filter = manual.getByRole("button", { name: "Character pages only", exact: true });
    await filter.waitFor();
    assert.equal(await filter.getAttribute("aria-pressed"), "true");
    assert.equal(await filter.getAttribute("class"), "annotation-toggle");
    await page.screenshot({ path: ".test-runtime/speaker-filter.png" });
    const style = await filter.evaluate(node => ({ width: getComputedStyle(node, "::after").width, height: getComputedStyle(node, "::after").height }));
    assert.deepEqual(style, { width: "32px", height: "18px" }, "reuse the established switch geometry");
    const options = () => manual.locator("select option").evaluateAll(nodes => nodes.map(node => node.value));
    assert((await options()).includes(tagged.id)); assert(!(await options()).includes(untagged.id));
    await filter.focus(); await page.keyboard.press("Space");
    assert.equal(await filter.getAttribute("aria-pressed"), "false");
    await manual.locator("select").selectOption(untagged.id);
    await filter.focus(); await page.keyboard.press("Enter");
    assert.equal(await manual.locator("select").inputValue(), untagged.id, "filtering preserves the author selection");
    assert.match(await manual.locator("select option:checked").textContent(), /outside filter/);
    await manual.locator("[type=submit]").click(); await manual.waitFor({ state: "hidden" });
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(2, 10));
    await sceneTools(); await page.locator(".editor-menu [data-assign-speaker]").click();
    await manual.waitFor();
    assert.equal(await filter.getAttribute("aria-pressed"), "true", "filter defaults on when reopening");
    assert.equal(await manual.locator("select").inputValue(), untagged.id, "untagged confirmed speakers remain selected");
    await manual.locator("[data-close-tool]").click();
    const untaggedAfter = await (await page.request.get(`${url}/wiki/page/${untagged.id}/data`)).json();
    // source_hash describes the changing manuscript, not this wiki page's content.
    const { source_hash: beforeSource, ...beforePage } = untaggedBefore;
    const { source_hash: afterSource, ...afterPage } = untaggedAfter;
    assert.deepEqual(afterPage, beforePage, "speaker association never retags or changes wiki content");
    // Change the editor after manual attribution; extraction must save this current buffer.
    await page.locator(".ProseMirror").focus(); await page.keyboard.press("Control+End"); await page.keyboard.type(" Added current scene context.");
    const currentText = await page.evaluate(() => window.verwrityEditor.getText());
    const tools = async () => {
      const menu = page.locator("details.editor-menu").filter({ has: page.locator("[data-extract-dialogue]") });
      if (!(await menu.evaluate(node => node.open))) await menu.locator(":scope > summary").click();
    };
    assert.equal(calls, 0);
    assert.equal(await page.locator("details.analysis-menu [data-extract-dialogue]").count(), 1, "extraction is discoverable within Analysis");
    assert.equal(await page.locator("[data-dialogue-analysis-status]").textContent(), "", "no redundant extraction description before running");
    answer = { dialogue: [{ quote: "“Hello.”", occurrence: 2, speaker_id: null, suggested_name: "Sol", uncertainty: "The speaker is implied by turn-taking." },
                          { quote: "Missing source", occurrence: 1 }] };
    await tools(); await page.screenshot({ path: ".test-runtime/dialogue-analysis.png" }); await page.locator("[data-extract-dialogue]").click();
    await page.waitForFunction(() => document.querySelector("[data-accept-dialogue]").hidden === false);
    assert.equal((await page.evaluate(() => window.verwrityEditor.getDialogue())).length, 1, "extraction does not apply suggestions");
    assert(prompts[0].includes("Added current scene context."), "Run captures the active editor buffer");
    assert(!prompts[0].includes("Write the discovery scene here."), "extraction stays scoped to this scene");
    const review = page.locator("[data-dialogue-list] .dialogue-record");
    assert.equal(await review.count(), 1);
    assert.match(await review.innerText(), /implied by turn-taking/);
    const reviewFilter = review.getByRole("button", { name: "Character pages only", exact: true });
    assert.equal(await reviewFilter.getAttribute("aria-pressed"), "true");
    assert.equal(await review.locator(`option[value="${untagged.id}"]`).count(), 0);
    await reviewFilter.click(); await review.locator("select").selectOption(untagged.id); await reviewFilter.click();
    assert.equal(await review.locator("select").inputValue(), untagged.id);
    await review.locator("select").selectOption("create");
    assert.equal(await review.locator(`option[value="${untagged.id}"]`).count(), 0, "an unselected untagged page leaves the filtered choices");
    await review.locator('input[aria-label="New character wiki name"]').fill("Sol");
    await review.locator('[type="checkbox"]').check();
    await page.locator("[data-accept-dialogue]").click();
    await page.waitForFunction(() => window.verwrityEditor.getDialogue().length === 2);
    await page.waitForFunction(() => document.querySelector("#dialogue-title").textContent === "Scene dialogue" && document.querySelectorAll("[data-dialogue-list] .dialogue-record").length === 2);
    const record = (await page.evaluate(() => window.verwrityEditor.getDialogue())).find(item => item.origin === "ai-suggested-author-confirmed");
    assert.equal(record.origin, "ai-suggested-author-confirmed"); assert.equal(record.start, 12);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), currentText);
    await page.locator("#dialogue-dialog [data-close-tool]").click();
    await tools(); await page.locator("[data-dialogue-analysis] .text-analysis-options > summary").click(); await page.locator("[data-review-dialogue-analysis]").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-dialogue-list] .dialogue-record").length === 2);
    assert.equal(await page.locator("[data-dialogue-list] .dialogue-record").count(), 2);
    assert.equal(calls, 1, "Review speakers reads assignments without running a model");
    await page.locator("#dialogue-dialog [data-close-tool]").click();
    await page.evaluate(id => window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", { detail: id })), record.speaker_id);
    await page.locator("[data-wiki-current-page] button").filter({ hasText: /^Dialogue$/ }).click();
    answer = { observations: [{ dialogue_id: record.id, quote: "Hello", explanation: "A short greeting; context may explain this restraint." },
                              { dialogue_id: record.id, quote: "Invented", explanation: "Unverified" }] };
    await page.locator("[data-evaluate-dialogue]").click();
    await page.locator("[data-dialogue-observations]").getByText(/context may explain/).waitFor();
    assert.equal(await page.locator("[data-dialogue-observations] section").count(), 1);
    assert.equal(calls, 2);
    await page.screenshot({ path: ".test-runtime/dialogue-evaluation.png" });
    await page.locator("[data-dialogue-observations] button").click();
    await page.waitForFunction(() => window.verwrityEditor.getSelectedRange()?.quote === "Hello");
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).quote, "Hello");
    // Explicit Cancel stops waiting without applying or displaying a late proposal.
    held = true; release = null; answer = { dialogue: [] };
    await tools(); await page.locator("[data-extract-dialogue]").click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await page.locator("[data-dialogue-analysis]").getAttribute("aria-busy"), "true");
    assert.equal(await page.locator("[data-extract-dialogue]").isDisabled(), true);
    await page.locator("#dialogue-dialog [data-cancel-dialogue-analysis]").click();
    assert.equal(await page.locator("[data-dialogue-analysis]").getAttribute("aria-busy"), "false");
    release(); held = false;
    while (completedCalls < 3) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await page.locator("[data-accept-dialogue]").isVisible(), false);
    await page.locator("#dialogue-dialog [data-close-tool]").click();
    // A late extraction cannot repopulate a review after source edits.
    held = true; release = null; answer = { dialogue: [{ quote: "“Hello.”", occurrence: 1, speaker_id: null, uncertainty: "Uncertain" }] };
    await tools(); await page.locator("[data-extract-dialogue]").click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("verwrity-editor-change")));
    release(); held = false;
    await page.waitForFunction(() => document.querySelector("[data-dialogue-status]").textContent.includes("Sources changed"));
    assert.equal(await page.locator("[data-accept-dialogue]").isVisible(), false);
    assert.equal(await page.locator("[data-dialogue-list] .dialogue-record").count(), 0);
    assert.equal((await page.evaluate(() => window.verwrityEditor.getDialogue())).length, 2);
    await page.locator("#dialogue-dialog [data-close-tool]").click();
    const versions = page.locator("[data-scene-revision-select]");
    const checkpoint = await versions.locator('option').evaluateAll(nodes => nodes.find(node => node.value !== "head").value);
    const versionsMenu = page.locator("details.versions-menu");
    if (!(await versionsMenu.evaluate(node => node.open))) await versionsMenu.locator(":scope > summary").click();
    await versions.selectOption(checkpoint);
    await page.waitForFunction(() => !window.verwrityEditor.isEditable());
    const beforePreviewRun = calls;
    await tools(); await page.locator("[data-extract-dialogue]").click();
    await page.locator("#app-dialog").waitFor();
    assert.match(await page.locator("[data-app-dialog-message]").textContent(), /editable current scene head/);
    assert.equal(calls, beforePreviewRun, "a historical preview cannot invoke extraction");
    await page.locator("[data-app-dialog-accept]").click();
    assert.deepEqual(errors, []);
    console.log("PASS: explicit local-model extraction, exact repeated quote, corrected new speaker, Analysis run/review/cancel, shared character-filter switches, signed acceptance, voice evaluation, and late-response discard");
  } finally { await browser.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
