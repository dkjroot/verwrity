/* Enabled analysis preferences survive scene navigation without model calls. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/preferences/annotations/spelling`, { data: { enabled: false } });
    const custom = (await (await page.request.post(`${url}/text-analyses`, {
      data: { name: "Clarity", prompt: "Review clarity." },
    })).json()).id;
    const enabled = ["grammar", "thesaurus", custom];
    const calls = { spelling: 0, cliche: 0, usage: 0, grammar: 0, thesaurus: 0, [custom]: 0 };
    await page.route("**/scene/*/spell-check", async route => {
      calls.spelling += 1;
      await route.fulfill({ json: { annotations: [] } });
    });
    await page.route("**/scene/*/text-analysis/*", async route => {
      const path = new URL(route.request().url()).pathname.split("/");
      const id = path.at(-1);
      calls[id] += 1;
      const quote = route.request().postDataJSON().scene_text.match(/\S+/u)[0];
      await route.fulfill({ json: { scene_id: path[2], analysis_id: id,
        annotations: [{ id: `finding-${id}`, start: 0, end: Array.from(quote).length, quote, explanation: "Synthetic observation." }],
      } });
    });
    // Make persistence slower than a rapid switch so navigation must flush it.
    await page.route("**/text-analyses/*", async route => {
      if (route.request().method() === "PATCH") await new Promise(resolve => setTimeout(resolve, 200));
      await route.continue();
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const sceneIds = await page.locator(".scene-row[data-scene-id]").evaluateAll(rows => rows.map(row => row.dataset.sceneId));
    assert(sceneIds.length >= 2);
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(element => element.open))) await menu.locator(":scope > summary").click();
    };
    const row = id => page.locator(`[data-text-analysis="${id}"]`);
    const idle = () => page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    const navigate = async sceneId => {
      await Promise.all([page.waitForNavigation(), page.locator(`.scene-row[data-scene-id="${sceneId}"] .scene`).click()]);
      await page.waitForFunction(sceneId => window.verwrityEditor?.sceneId === sceneId, sceneId);
      await page.evaluate(() => document.querySelector("#start-dialog")?.close());
      await openMenu();
      await page.waitForFunction(() => document.querySelector('[data-annotation-toggle="spelling"]').getAttribute("aria-pressed") === "true");
    };
    await openMenu();
    await page.locator('[data-annotation-toggle="spelling"]').click();
    for (const id of enabled) await row(id).locator("[data-toggle-text-analysis]").click();
    await idle();
    const original = await page.evaluate(() => window.verwrityEditor.getText());
    const beforeSwitch = { ...calls };
    await navigate(sceneIds[1]);
    assert.deepEqual(calls, beforeSwitch, "scene navigation restores switches without running any checks");
    for (const id of enabled) {
      assert.equal(await row(id).locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "true");
      assert.match(await row(id).locator("[data-text-analysis-status]").innerText(), /stale/);
    }
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0, "previous scene findings never follow navigation");
    assert.equal(await page.locator('[data-analysis-stale-status]').isVisible(), true);
    assert.equal(await page.locator('[data-rerun-analysis]').isEnabled(), true);
    const otherText = await page.evaluate(() => window.verwrityEditor.getText());
    await page.keyboard.press("Escape");
    await page.locator('[data-rerun-analysis]').click();
    await idle();
    await page.locator('[data-rerun-analysis]').waitFor({ state: "hidden" });
    for (const id of [...enabled, "spelling"]) assert.equal(calls[id], beforeSwitch[id] + 1);
    assert.equal(calls.cliche, 0);
    assert.equal(calls.usage, 0);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), otherText);
    await openMenu();
    await row("grammar").locator("[data-toggle-text-analysis]").click();
    const beforeReturn = { ...calls };
    await navigate(sceneIds[0]);
    assert.deepEqual(calls, beforeReturn);
    assert.equal(await row("grammar").locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "false");
    for (const id of ["thesaurus", custom]) assert.equal(await row(id).locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original, "switches never alter either scene");
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.deepEqual(calls, beforeReturn, "reload also restores stale preferences without calls");
    assert.equal(await row("thesaurus").locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "true");
    assert.equal(await row("grammar").locator("[data-toggle-text-analysis]").getAttribute("aria-pressed"), "false");
    assert.deepEqual(errors, []);
    console.log("PASS: built-in/custom/spelling switches across scenes and reload, explicit reruns, disabled checks, preference flush, and manuscript safety");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
