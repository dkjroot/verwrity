const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    let calls = 0, release;
    await page.route("**/text-analysis/tense", async route => {
      calls += 1;
      const text = route.request().postDataJSON().scene_text;
      if (calls === 3) await new Promise(resolve => { release = resolve; });
      const start = Array.from(text.slice(0, text.indexOf("walks"))).length;
      await route.fulfill({ json: { scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: "tense", annotations: [{ id: "tense-finding", start, end: start + 5,
        quote: "walks", explanation: "The narration changes from past to present without an apparent timeframe change.", severity: "concern" }] } });
    });
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    const text = '😀 She waited. He walks in. “I am here,” he said.';
    const setText = value => page.evaluate(value => { window.verwrityEditor.setText(value); window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } })); }, value);
    await setText(text);
    const menu = page.locator("details.analysis-menu");
    const open = async () => { if (!(await menu.evaluate(node => node.open))) await menu.locator(":scope > summary").click(); };
    await open(); const row = page.locator('[data-text-analysis="tense"]');
    assert.equal(calls, 0);
    await row.locator("[data-toggle-text-analysis]").click();
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    assert.equal(await page.locator(".verwrity-text-analysis-tense").textContent(), "walks");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    await row.locator(".text-analysis-style-picker > summary").click();
    for (const style of ["underline", "squiggly", "highlight", "double"]) {
      await row.locator("[data-text-analysis-style]").selectOption(style);
      await page.waitForFunction(style => document.querySelector(".verwrity-text-analysis-tense")?.classList.contains(`verwrity-annotation-${style}`), style);
    }
    await row.locator("[data-text-analysis-color]").evaluate(node => { node.value = "#123456"; node.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector(".verwrity-text-analysis-tense")?.getAttribute("style").includes("#123456"));
    assert.equal(calls, 1, "appearance changes make no model call");
    await page.keyboard.press("Escape"); await setText(text + " Another sentence.");
    await page.locator("[data-rerun-analysis]").click();
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy); assert.equal(calls, 2);
    await open(); await row.locator("[data-run-text-analysis]").click();
    while (!release) await new Promise(resolve => setTimeout(resolve, 20));
    await setText(text + " Changed during review."); release();
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    assert.equal(await page.locator(".verwrity-text-analysis-tense").count(), 0);
    await page.evaluate(() => window.verwritySaveActiveScene());
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(calls, 3, "preference restoration makes no model call");
    await page.evaluate(() => { document.querySelector("#start-dialog")?.close(); document.querySelector("[data-recovery-dialog]")?.close(); });
    await open();
    assert.equal(await page.locator('[data-text-analysis="tense"] [data-toggle-text-analysis]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-text-analysis="tense"] [data-text-analysis-color]').inputValue(), "#123456");
    assert.equal(await page.locator('[data-text-analysis="tense"] [data-text-analysis-style]').inputValue(), "double");
    console.log("PASS: Tense Checker exact highlights, shared rerun, stale results, preference reload, and manuscript safety");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
