/* Built-in usage review and complete feedback on overlapping LLM ranges. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/preferences/annotations/spelling`, { data: { enabled: false } });
    const custom = (await (await page.request.post(`${url}/text-analyses`, {
      data: { name: "Precision review", prompt: "Review semantic precision." },
    })).json()).id;
    const calls = { cliche: 0, usage: 0, [custom]: 0 };
    let mode = "nested";
    await page.route("**/scene/*/text-analysis/*", async route => {
      const id = route.request().url().split("/").pop();
      calls[id] += 1;
      const text = route.request().postDataJSON().scene_text;
      const quote = mode === "exact" ? "inflammable" : id === "cliche"
        ? "The cloth was inflammable, so it would not burn." : mode === "partial"
          ? id === "usage" ? "inflammable, so" : "so it would"
          : id === "usage" ? "inflammable" : "cloth was inflammable";
      const start = Array.from(text.slice(0, text.indexOf(quote))).length;
      await route.fulfill({ json: {
        scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: id,
        annotations: [{ id: `finding-${id}`, start, end: start + quote.length, quote,
          explanation: id === "usage" ? "Inflammable means able to catch fire; this sentence suggests the opposite."
            : id === "cliche" ? "Synthetic cliché feedback." : "Synthetic precision feedback." }],
      } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const text = "😀 The cloth was inflammable, so it would not burn.\n\nThe inflammable cloth was kept away from flames.";
    await page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text } }));
    }, text);
    const row = id => page.locator(`[data-text-analysis="${id}"]`);
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(element => element.open))) await menu.locator(":scope > summary").click();
    };
    const run = async id => {
      await openMenu();
      await row(id).locator("[data-run-text-analysis]").click();
      await page.waitForFunction(id => document.querySelector(`[data-text-analysis="${id}"] [data-text-analysis-status]`).textContent.includes("1 passage")
        && document.querySelector(`[data-text-analysis="${id}"] [data-cancel-text-analysis]`).hidden, id);
    };
    const titles = async () => page.locator(".verwrity-text-analysis").evaluateAll(elements => elements.map(element => ({ text: element.textContent, title: element.title })));
    const find = async quote => (await titles()).find(item => item.text === quote)?.title;
    const assertAllFeedback = title => {
      assert.match(title, /Cliché Detector: Synthetic cliché feedback/);
      assert.match(title, /Usage Detector: Inflammable means able to catch fire/);
      assert.match(title, /Precision review: Synthetic precision feedback/);
    };
    assert.deepEqual(Object.values(calls), [0, 0, 0]);
    await openMenu();
    assert.equal(await row("usage").locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "false");
    const definitions = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions;
    const defaultUsage = definitions.find(item => item.id === "usage");
    assert.notEqual(defaultUsage.color, definitions.find(item => item.id === "cliche").color);
    await run("usage");
    assert.deepEqual(await page.locator(".verwrity-text-analysis-usage").allTextContents(), ["inflammable"]);
    await row("usage").locator("[data-text-analysis-findings] > summary").click();
    assert.match(await row("usage").locator("[data-text-analysis-findings]").innerText(), /means able to catch fire/);
    await run("cliche");
    await run(custom);
    assertAllFeedback(await find("inflammable"));
    assert.equal(await find("The "), "Cliché Detector: Synthetic cliché feedback.", "nested-only feedback does not leak outside its range");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);

    mode = "partial";
    await run("usage");
    await run(custom);
    assertAllFeedback(await find("so"));
    assert.doesNotMatch(await find("inflammable, "), /Precision review/, "partial overlap feedback is confined to the intersection");
    assert.doesNotMatch(await find(" it would"), /Usage Detector/);
    await row(custom).locator("[data-toggle-text-analysis]").click();
    assert((await titles()).every(item => !item.title.includes("Precision review")), "hiding a detector removes only its feedback");
    await row(custom).locator("[data-toggle-text-analysis]").click();
    assertAllFeedback(await find("so"));

    mode = "exact";
    for (const id of ["cliche", "usage", custom]) await run(id);
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 1, "identical ranges use one highlight with three explanations");
    assertAllFeedback(await find("inflammable"));
    await row("usage").locator(".text-analysis-options > summary").click();
    await row("usage").locator("[data-clear-text-analysis]").click();
    assert.doesNotMatch(await find("inflammable"), /Usage Detector/);
    assert.match(await find("inflammable"), /Cliché Detector/);
    const beforeRerun = { ...calls };
    await page.keyboard.press("Escape");
    await page.locator("[data-rerun-analysis]").click();
    await page.locator("[data-text-analysis-progress]").waitFor({ state: "hidden" });
    assertAllFeedback(await find("inflammable"));
    for (const id of ["cliche", "usage", custom]) assert.equal(calls[id], beforeRerun[id] + 1, "shared rerun includes the new built-in");

    await openMenu();
    await row("usage").locator(".text-analysis-style-picker > summary").click();
    const savedStyle = page.waitForResponse(response => response.url().endsWith("/text-analyses/usage") && response.request().method() === "PATCH");
    await row("usage").locator("[data-text-analysis-style]").selectOption("double");
    assert.equal((await savedStyle).status(), 200);
    assertAllFeedback(await find("inflammable"));
    await row("usage").locator(".text-analysis-style-picker > summary").click();
    await row("usage").locator(".text-analysis-options > summary").click();
    await row("usage").locator("[data-edit-text-analysis]").click();
    const form = page.locator("[data-text-analysis-form]");
    assert.equal(await form.locator('[name="name"]').isEnabled(), false);
    await form.locator('[name="prompt"]').fill("Review only clear dictionary-meaning clashes.");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    const saved = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions.find(item => item.id === "usage");
    assert.equal(saved.prompt_overridden, true);
    assert.equal(saved.style, "double");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text, "annotations and settings never rewrite source");
    const beforeReload = { ...calls };
    await page.request.post(`${url}/project/new`);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.equal(await row("usage").locator("[data-text-analysis-style]").inputValue(), "double");
    assert.deepEqual(calls, beforeReload, "new built-in preferences never trigger automatic runs");
    await row("usage").locator(".text-analysis-options > summary").click();
    await row("usage").locator("[data-restore-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="usage"] [data-restore-text-analysis]').disabled);
    const restored = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions.find(item => item.id === "usage");
    assert.equal(restored.prompt, defaultUsage.prompt);
    assert.equal(restored.style, "double");
    assert.deepEqual(errors, []);
    console.log("PASS: Usage Detector, independent preferences and reruns, exact/nested/partial overlap feedback, and manuscript safety");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
