/* Grammar reports use the shared view-only detector controls. */
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
    let calls = 0, hold = false, release;
    await page.route("**/scene/*/text-analysis/grammar", async route => {
      calls += 1;
      const text = route.request().postDataJSON().scene_text;
      if (hold) await new Promise(resolve => { release = resolve; });
      const quote = "The keys is";
      const start = Array.from(text.slice(0, text.indexOf(quote))).length;
      await route.fulfill({ json: {
        scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: "grammar",
        annotations: [{ id: "grammar-finding", start, end: start + quote.length, quote,
          explanation: "The plural subject keys disagrees with the singular verb is.", severity: "concern" }],
      } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const text = '😀 The keys is missing.\n\n"Ain’t no keys here," she said.';
    const setText = value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, value);
    const row = page.locator('[data-text-analysis="grammar"]');
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(element => element.open))) await menu.locator(":scope > summary").click();
    };
    const idle = () => page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    const definitions = async () => (await (await page.request.get(`${url}/text-analyses`)).json()).definitions;
    const defaultGrammar = (await definitions()).find(item => item.id === "grammar");
    await setText(text);
    await openMenu();
    assert.equal(calls, 0, "page load and editing do not invoke grammar review");
    assert.equal(await row.locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "false");
    await row.locator("[data-toggle-text-analysis]").click();
    await idle();
    assert.deepEqual(await page.locator(".verwrity-text-analysis-grammar").allTextContents(), ["The keys is"]);
    assert.match(await page.locator(".verwrity-text-analysis-grammar").getAttribute("title"), /Grammar Checker: The plural subject/);
    await row.locator("[data-text-analysis-findings] > summary").click();
    assert.match(await row.locator("[data-text-analysis-findings]").innerText(), /singular verb is/);
    await row.locator("[data-text-analysis-findings] button").click();
    const selected = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    assert.equal(selected.quote, "The keys is");
    assert.equal(selected.start, Array.from(text.slice(0, text.indexOf("The keys is"))).length);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    await openMenu();
    await row.locator("[data-toggle-text-analysis]").click();
    assert.equal(await page.locator(".verwrity-text-analysis-grammar").count(), 0);
    await row.locator("[data-toggle-text-analysis]").click();
    assert.equal(calls, 1, "showing a completed layer reuses its findings");
    await page.keyboard.press("Escape");
    await setText(`${text} Another sentence.`);
    await page.locator("[data-rerun-analysis]").click();
    await idle();
    assert.equal(calls, 2, "shared rerun includes an enabled Grammar Checker");
    assert.equal(await page.locator(".verwrity-text-analysis-grammar").count(), 1);

    // An edit during generation must discard the late report.
    await openMenu();
    hold = true;
    const pendingRequest = page.waitForRequest("**/scene/*/text-analysis/grammar");
    await row.locator("[data-run-text-analysis]").click();
    await pendingRequest;
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    await setText(`${text} Changed during review.`);
    hold = false;
    release();
    await idle();
    assert.equal(await page.locator(".verwrity-text-analysis-grammar").count(), 0, "late results never highlight changed prose");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${text} Changed during review.`);

    await openMenu();
    await row.locator(".text-analysis-options > summary").click();
    await row.locator("[data-edit-text-analysis]").click();
    const form = page.locator("[data-text-analysis-form]");
    assert.equal(await form.locator('[name="name"]').isEnabled(), false);
    await form.locator('[name="prompt"]').fill("Review grammatical errors in dialogue.");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    assert.equal((await definitions()).find(item => item.id === "grammar").prompt_overridden, true);
    const beforeReload = calls;
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.equal(calls, beforeReload, "restoring the built-in settings never auto-runs review");
    await row.locator(".text-analysis-options > summary").click();
    await row.locator("[data-restore-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="grammar"] [data-restore-text-analysis]').disabled);
    assert.equal((await definitions()).find(item => item.id === "grammar").prompt, defaultGrammar.prompt);
    assert.deepEqual(errors, []);
    console.log("PASS: Grammar Checker reports, exact highlights, toggles, shared reruns, stale responses, prompt restoration, and manuscript safety");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
