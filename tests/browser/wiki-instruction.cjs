/* Real instruction/proposal/acceptance routes with a deterministic local LLM. */
const assert = require("node:assert/strict");
const http = require("node:http");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  let mode = "tidy", calls = 0, release = null, lastPrompt = "";
  const llm = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content; lastPrompt = prompt; calls++;
    const data = JSON.parse(prompt.split("PAGE JSON:\n")[1].split("\nCURRENT MANUSCRIPT:")[0]);
    let result = { updates: [], insertions: [], suggestions: [] };
    if (mode === "tidy") {
      const invalidEvidence = [{ quote: "This quotation is absent from the manuscript." }];
      result.updates = [{ id: data.ai_passages[0].ref, text: "AI rough notes.", evidence: invalidEvidence }];
      result.suggestions = [{ quote: "Human secrt.", replacement_text: "Human secret.", explanation: "Correct spelling.", evidence: invalidEvidence }];
    } else if (mode === "creative") {
      result.insertions = [{ after_id: data.paragraphs.at(-1).ref,
        text: `A new imaginary adventure ${calls}.`, evidence: [] }];
    } else if (mode === "slow") {
      result.updates = [{ id: data.ai_passages[0].ref, text: "Late AI replacement.", evidence: [] }];
      await new Promise(resolve => { release = resolve; });
    } else if (mode === "unsafe") {
      result.updates = [{ id: "P1", text: "Hijacked human section", evidence: [] }];
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => llm.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url); await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => !!window.verwrityEditor);
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.request.post(`${url}/ai/models/llm`, { data: { standard: "openai_compatible",
      endpoint: `http://127.0.0.1:${llm.address().port}/v1`, model: "instruction-test" } });
    const created = await page.request.post(`${url}/wiki/page/create`, { form: { title: "Instruction notes" } });
    await page.goto(created.url());
    const pageId = new URL(page.url()).searchParams.get("wiki_page");
    const readPage = async () => (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json();
    const current = page.locator("[data-wiki-current-page]");
    const editor = page.locator("[data-wiki-page-editor]");
    const input = editor.locator("textarea[name=body]");
    const control = editor.locator(".wiki-instruction");
    const instruction = control.locator("[data-wiki-instruction]");
    const run = control.getByRole("button", { name: "Run instruction", exact: true });
    await current.getByRole("button", { name: "Edit page", exact: true }).click();
    await input.fill("Human secrt.\n\nAI roug notes.");
    await input.evaluate(el => { el.focus(); el.setSelectionRange(el.value.indexOf("AI"), el.value.length); });
    await editor.getByRole("button", { name: "Mark as AI maintained", exact: true }).click();
    assert.equal(await editor.locator(".wiki-citation-warning").count(), 0, "Human delegation is not uncited AI generation");
    await control.locator("summary").click();
    await instruction.fill("Tidy the grammar and formatting.");
    const manuscript = await page.locator(".ProseMirror").innerText();
    await run.click();
    await page.waitForFunction(() => document.querySelector('[data-wiki-page-editor] textarea[name=body]')?.value.endsWith("AI rough notes."));
    assert(lastPrompt.includes("No manuscript context selected."));
    assert(lastPrompt.includes("Human secrt."), "The current unsaved page snapshot was sent");
    assert.equal(await input.inputValue(), "Human secrt.\n\nAI rough notes.");
    assert.equal(await instruction.inputValue(), "Tidy the grammar and formatting.");
    assert.equal(await editor.locator(".wiki-authorship-mirror .wiki-ai-suggestion").textContent(), "Human secrt.");
    let data = await readPage();
    assert.equal(data.annotations.filter(a => a.kind === "suggestion").length, 1);
    assert.equal(data.annotations.find(a => a.kind === "suggestion").replacement_text, "Human secret.");
    assert(data.annotations.every(a => a.evidence.length === 0), "Invalid citations are omitted, without blocking instruction content");
    await editor.locator(".wiki-source-ai-box .wiki-citation-warning").waitFor();
    assert.equal(await editor.locator(".wiki-source-ai-box .wiki-citation-warning").textContent(), "Warning: no citation");
    assert.match(await editor.locator(".wiki-ai-review summary").first().textContent(), /Warning: no citation/);
    await editor.getByRole("button", { name: "Preview", exact: true }).click();
    assert.equal(await editor.locator(".wiki-preview .wiki-citation-warning").textContent(), "Warning: no citation");
    assert.equal(await input.inputValue(), "Human secrt.\n\nAI rough notes.", "Warning labels never enter source text");
    assert.match(await editor.locator(".wiki-ai-status").last().textContent(), /2 unverified manuscript citations were omitted/);
    assert(!await editor.locator(".wiki-ai-status").last().textContent().then(text => text.includes("Proposed changes were skipped")));
    if (process.env.VERWRITY_WIKI_SCREENSHOT) await editor.locator(".wiki-authorship-editor").screenshot({ path: process.env.VERWRITY_WIKI_SCREENSHOT });
    await editor.locator(".wiki-ai-review details").filter({ hasText: "Review:" }).locator("summary").click();
    assert.equal(await editor.locator(".wiki-ai-review").getByText("Human secret.", { exact: true }).textContent(), "Human secret.");
    await editor.getByRole("button", { name: "Accept suggestion", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-wiki-page-editor] textarea[name=body]')?.value.startsWith("Human secret."));
    data = await readPage();
    assert.equal(data.annotations.filter(a => a.kind === "ai_text").length, 2);
    await page.waitForFunction(() => document.querySelectorAll(".wiki-source-ai-box .wiki-citation-warning").length === 2);
    assert.equal(data.revisions.at(-1).body, "Human secrt.\n\nAI rough notes.");
    assert.equal(await page.locator(".ProseMirror").innerText(), manuscript);

    await input.evaluate(el => { el.focus(); el.setSelectionRange(0, "Human secret.".length); });
    await editor.getByRole("button", { name: "Mark as human owned / protected", exact: true }).click();
    mode = "empty";
    await run.click();
    await run.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector(".wiki-instruction button")?.disabled);
    data = await readPage();
    assert.equal(data.annotations.length, 1, "Permission changes were saved before generation");
    assert.equal(data.annotations[0].quote, "AI rough notes.");
    await page.waitForFunction(() => document.querySelectorAll(".wiki-source-ai-box .wiki-citation-warning").length === 1);

    mode = "creative";
    await instruction.fill("Invent a completely new adventure, with no manuscript quote required.");
    for (const scope of ["page", "scene", "range", "manuscript"]) {
      const before = calls;
      await control.locator("select").selectOption(scope);
      if (scope === "range") { await control.locator('input[type=range]').first().fill("100"); }
      await run.click();
      await page.waitForFunction(() => !document.querySelector(".wiki-instruction button")?.disabled);
      assert.equal(calls, before + 1);
      if (scope !== "page") assert(lastPrompt.includes('<scene id="'), `${scope} sends manuscript context`);
      const scenes = (lastPrompt.match(/<scene id=/g) || []).length;
      if (scope === "scene") assert.equal(scenes, 1);
      if (scope === "manuscript") assert(scenes >= 3);
      assert.equal(await control.locator("select").inputValue(), scope);
      const creative = (await readPage()).annotations.find(a => a.quote === `A new imaginary adventure ${calls}.`);
      assert(creative, "Creative content is saved even with no supporting manuscript quotation");
      assert.equal(creative.evidence.length, 0);
      assert.equal(creative.origin, "ai_generated");
      assert.equal(creative.analysis_version, "wiki-instruct-v1");
      assert((await input.inputValue()).startsWith("Human secret."), "Human knowledge stays protected");
    }
    await control.locator("select").selectOption("page");
    const beforeCancel = (await readPage()).body;
    mode = "slow";
    await run.click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    await control.getByRole("button", { name: "Cancel instruction", exact: true }).click();
    release(); release = null;
    await page.waitForFunction(() => !document.querySelector(".wiki-instruction button")?.disabled);
    assert.equal((await readPage()).body, beforeCancel);

    await run.click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    await input.evaluate(el => {
      const start = el.value.length;
      el.dispatchEvent(new CustomEvent("verwrity-textarea-before-edit", { detail: { start, end: start } }));
      el.setRangeText("\n\nNew human buffer.", start, start, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    release(); release = null;
    await page.waitForFunction(() => !document.querySelector(".wiki-instruction button")?.disabled);
    assert.equal(await input.inputValue(), beforeCancel + "\n\nNew human buffer.");
    assert.equal((await readPage()).body, beforeCancel);

    mode = "unsafe";
    await run.click();
    await page.waitForFunction(() => !document.querySelector(".wiki-instruction button")?.disabled);
    assert.match(await control.locator(".wiki-ai-status").textContent(), /outside a recorded AI passage/);
    assert.equal((await readPage()).body, beforeCancel + "\n\nNew human buffer.");
    await editor.getByRole("button", { name: "Save page", exact: true }).click();
    await current.getByRole("button", { name: "Edit page", exact: true }).waitFor();
    await page.reload();
    data = await readPage();
    assert(data.annotations.some(a => a.quote === "AI rough notes."));
    assert.equal(await current.locator(".wiki-page-body .wiki-citation-warning").count(), data.annotations.filter(a => a.kind === "ai_text").length,
      "Uncited section warnings survive save and reload");
    assert(!data.body.includes("Warning: no citation"));
    const blockWarnings = await page.evaluate(async () => {
      const { renderWikiBody } = await import("/static/wiki-rendering.js");
      const body = "## Heading\n- Bullet\n\nHuman words with AI detail.";
      const sources = ["## Heading", "- Bullet", "AI detail."].map(quote => ({ kind: "ai_text", origin: "ai_generated",
        quote, start: body.indexOf(quote), end: body.indexOf(quote) + quote.length, evidence: [] }));
      const host = document.createElement("div"); renderWikiBody(host, body, [], sources);
      return { heading: host.querySelector("h3 .wiki-citation-warning")?.textContent,
        bullet: host.querySelector("li .wiki-citation-warning")?.textContent,
        partial: host.querySelector("p .wiki-citation-warning")?.textContent,
        humanMarkedAsAI: host.querySelector("p")?.classList.contains("wiki-ai-block") };
    });
    assert.deepEqual(blockWarnings, { heading: "Warning: no citation", bullet: "Warning: no citation",
      partial: "Warning: no citation", humanMarkedAsAI: false });
    assert.deepEqual(errors, []);
    console.log("PASS: wiki instruction snapshots/scopes, human suggestions/acceptance, reclaimed permissions, cancellation, buffers, and persistence.");
  } finally {
    release?.(); await browser.close(); await new Promise(resolve => llm.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
