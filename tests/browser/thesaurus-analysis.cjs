/* Contextual alternatives remain report text and never edit manuscript prose. */
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
    const calls = { thesaurus: 0, cliche: 0 };
    const explanation = 'Nice is vague here. Alternatives: "inviting" for a welcoming impression; '
      + '"restful" if calm is intended. <script>window.badThesaurus = true</script>';
    await page.route("**/scene/*/text-analysis/*", async route => {
      const id = route.request().url().split("/").pop();
      calls[id] += 1;
      const text = route.request().postDataJSON().scene_text;
      const quote = id === "thesaurus" ? "nice" : "nice room";
      const start = Array.from(text.slice(0, text.lastIndexOf(quote))).length;
      await route.fulfill({ json: {
        scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: id,
        annotations: [{ id: `finding-${id}`, start, end: start + quote.length, quote,
          explanation: id === "thesaurus" ? explanation : "Synthetic cliché observation.", severity: "suggestion" }],
      } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const text = '😀 "It is nice," he said.\n\nShe admired the nice room.';
    const setText = value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, value);
    const row = id => page.locator(`[data-text-analysis="${id}"]`);
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(element => element.open))) await menu.locator(":scope > summary").click();
    };
    const idle = () => page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    const definitions = async () => (await (await page.request.get(`${url}/text-analyses`)).json()).definitions;
    const defaultPrompt = (await definitions()).find(item => item.id === "thesaurus").prompt;
    await setText(text);
    await openMenu();
    assert.deepEqual(calls, { thesaurus: 0, cliche: 0 });
    assert.equal(await row("thesaurus").locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "false");
    await row("thesaurus").locator("[data-toggle-text-analysis]").click();
    await idle();
    assert.deepEqual(await page.locator(".verwrity-text-analysis-thesaurus").allTextContents(), ["nice"]);
    assert.match(await page.locator(".verwrity-text-analysis-thesaurus").getAttribute("title"), /Super Thesaurus:.*inviting.*restful/);
    await row("thesaurus").locator("[data-text-analysis-findings] > summary").click();
    assert.match(await row("thesaurus").locator("[data-text-analysis-findings]").innerText(), /inviting.*restful.*<script>/);
    assert.equal(await page.evaluate(() => window.badThesaurus), undefined, "alternatives and explanations render as text");
    await row("thesaurus").locator("[data-text-analysis-findings] button").click();
    const selected = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    assert.equal(selected.quote, "nice");
    assert.equal(selected.start, Array.from(text.slice(0, text.lastIndexOf("nice"))).length);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text, "navigating a recommendation never applies it");

    await openMenu();
    await row("cliche").locator("[data-run-text-analysis]").click();
    await idle();
    let title = await page.locator(".verwrity-text-analysis-thesaurus").getAttribute("title");
    assert.match(title, /Super Thesaurus:.*inviting/);
    assert.match(title, /Cliché Detector: Synthetic/);
    await row("thesaurus").locator("[data-toggle-text-analysis]").click();
    assert.equal(await page.locator(".verwrity-text-analysis-thesaurus").count(), 0);
    assert.doesNotMatch(await page.locator(".verwrity-text-analysis-cliche").getAttribute("title"), /inviting/);
    await row("thesaurus").locator("[data-toggle-text-analysis]").click();
    assert.equal(calls.thesaurus, 1, "showing recommendations reuses the result");
    await page.keyboard.press("Escape");
    await setText(`${text} More text.`);
    assert.equal(await page.locator(".verwrity-text-analysis-thesaurus").count(), 0, "edits invalidate word suggestions");
    await page.locator("[data-rerun-analysis]").click();
    await idle();
    assert.deepEqual(calls, { thesaurus: 2, cliche: 2 }, "shared rerun includes Super Thesaurus");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${text} More text.`);

    await openMenu();
    await row("thesaurus").locator(".text-analysis-options > summary").click();
    await row("thesaurus").locator("[data-edit-text-analysis]").click();
    const form = page.locator("[data-text-analysis-form]");
    assert.equal(await form.locator('[name="name"]').isEnabled(), false);
    await form.locator('[name="prompt"]').fill("Recommend precise verbs that fit this scene's voice.");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    assert.equal((await definitions()).find(item => item.id === "thesaurus").prompt_overridden, true);
    const beforeReload = { ...calls };
    await page.request.post(`${url}/project/new`);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.deepEqual(calls, beforeReload, "project changes and reloading settings never invoke models");
    await row("thesaurus").locator(".text-analysis-options > summary").click();
    await row("thesaurus").locator("[data-restore-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="thesaurus"] [data-restore-text-analysis]').disabled);
    assert.equal((await definitions()).find(item => item.id === "thesaurus").prompt, defaultPrompt);
    assert.deepEqual(errors, []);
    console.log("PASS: Super Thesaurus alternatives, safe reports/tooltips, exact occurrence navigation, overlaps, reruns, prompt restoration, and unchanged prose");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
