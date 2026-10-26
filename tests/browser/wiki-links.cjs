/* Wiki names in the manuscript remain interactive with decoration off or on. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    const resetWikiLinks = await page.request.post(`${url}/preferences/annotations/wiki_links`, { data: { enabled: false } });
    assert.equal(resetWikiLinks.status(), 200, "Start from an unhighlighted wiki-link preference");
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.evaluate(() => {
      window.__wikiOpenEvents = 0;
      window.addEventListener("verwrity-open-wiki-page", () => { window.__wikiOpenEvents += 1; });
    });
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Characters");

    const link = page.locator(".verwrity-wiki-link");
    await link.waitFor();
    assert.equal(await page.locator("[data-annotation-toggle='wiki_links']").getAttribute("aria-pressed"), "false");
    await link.hover();
    assert.equal(await link.evaluate(element => getComputedStyle(element).cursor), "pointer");
    assert.equal(await link.evaluate(element => getComputedStyle(element).textDecorationLine), "underline");

    const wikiPanel = page.locator("#wiki-panel");
    const wikiToggle = page.locator("[data-panel-toggle='wiki']");
    await wikiToggle.click();
    assert.equal(await wikiPanel.isVisible(), false);
    await link.click();
    await page.waitForFunction(() => document.querySelector("#wiki-panel")?.hidden === false
      && document.querySelector(".wiki-current-page h2")?.textContent === "Characters");
    assert.equal(await page.evaluate(() => window.__wikiOpenEvents), 1, "An unhighlighted wiki link dispatches navigation");
    assert.equal(await wikiToggle.getAttribute("aria-pressed"), "true", "A manuscript wiki link reveals the destination panel");

    await wikiToggle.click();
    await page.locator("details.analysis-menu > summary").click();
    await Promise.all([
      page.waitForResponse(response => response.url().includes("/preferences/annotations/wiki_links") && response.status() === 200),
      page.locator("[data-annotation-toggle='wiki_links']").click(),
    ]);
    await page.locator("details.analysis-menu > summary").click();
    await page.waitForFunction(() => document.querySelector(".verwrity-wiki-link")?.classList.contains("verwrity-annotation-underline"));
    await page.locator(".verwrity-wiki-link").click();
    await page.waitForTimeout(500);
    const finalState = await page.evaluate(() => ({
      hidden: document.querySelector("#wiki-panel")?.hidden,
      title: document.querySelector(".wiki-current-page h2")?.textContent,
      events: window.__wikiOpenEvents,
    }));
    assert.equal(finalState.hidden, false, `Annotated wiki link reveals its panel: ${JSON.stringify(finalState)}`);
    assert.equal(finalState.title, "Characters", `Annotated wiki link opens its page: ${JSON.stringify(finalState)}`);
    assert.equal(finalState.events, 2, "A highlighted wiki link dispatches navigation");
    console.log("PASS: manuscript wiki links work with decoration off and on, and reveal a hidden destination panel.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
