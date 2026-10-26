/* Shared explicit reruns and user-scoped LLM decoration styles. */
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
      data: { name: "Imagery", prompt: "Review imagery", color: "#8b5cf6" },
    })).json()).id;
    const disabled = (await (await page.request.post(`${url}/text-analyses`, {
      data: { name: "Dialogue", prompt: "Review dialogue" },
    })).json()).id;
    const calls = { cliche: 0, [custom]: 0, [disabled]: 0, spelling: 0 };
    let held = false, failCliche = false, pending = [];
    await page.route("**/scene/*/spell-check", async route => {
      calls.spelling += 1;
      if (held) await new Promise(resolve => pending.push({ id: "spelling", resolve }));
      await route.fulfill({ json: { annotations: [] } });
    });
    await page.route("**/scene/*/text-analysis/*", async route => {
      const id = route.request().url().split("/").pop();
      calls[id] += 1;
      const text = route.request().postDataJSON().scene_text;
      if (held) await new Promise(resolve => pending.push({ id, resolve }));
      const quote = id === "cliche" ? "cold as ice" : "heart skipped a beat";
      const start = Array.from(text.slice(0, text.indexOf(quote))).length;
      const failure = failCliche && id === "cliche";
      await route.fulfill({ status: failure ? 502 : 200, json: failure ? { error: "Synthetic failure" } : {
        scene_id: await page.evaluate(() => window.verwrityEditor.sceneId), analysis_id: id,
        annotations: [{ id: `finding-${id}`, start, end: start + quote.length, quote, explanation: "Stock description" }],
      } });
    });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    const text = "😀 Her heart skipped a beat. It was cold as ice.";
    const setText = async value => page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, value);
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(menu => menu.open))) await menu.locator(":scope > summary").click();
    };
    const row = id => page.locator(`[data-text-analysis="${id}"]`);
    const toggle = id => row(id).locator("[data-toggle-text-analysis]").click();
    const rerun = page.locator("[data-rerun-analysis]");
    const banner = page.locator("[data-text-analysis-progress]");
    const idle = () => page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy
      && !document.querySelector("[data-rerun-analysis]").disabled);
    await setText(text);
    assert.equal(await banner.isVisible(), false, "progress starts hidden");
    assert.deepEqual(Object.values(calls), [0, 0, 0, 0], "restoring settings and editing never invokes models");
    await openMenu();
    await toggle("cliche");
    await toggle(custom);
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().stale);
    await page.locator('[data-annotation-toggle="spelling"]').click();
    await rerun.waitFor({ state: "hidden" });
    assert.deepEqual(calls, { cliche: 1, [custom]: 1, [disabled]: 0, spelling: 1 });

    // Hold every request: all enabled analyses must start before any completes.
    await page.keyboard.press("Escape");
    await setText(`${text} Edited.`);
    await rerun.waitFor({ state: "visible" });
    held = true;
    await rerun.click();
    assert.equal(await banner.isVisible(), true, "shared rerun immediately shows the banner outside the menu");
    assert.equal(await banner.locator(".scene-audio-spinner").isVisible(), true);
    assert.equal(await banner.locator(".scene-audio-spinner").evaluate(element => getComputedStyle(element).animationName), "scene-audio-spin");
    await page.waitForFunction(() => document.querySelectorAll('[data-cancel-text-analysis]:not([hidden])').length === 2);
    while (pending.length < 3) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, { cliche: 2, [custom]: 2, [disabled]: 0, spelling: 2 }, "shared rerun starts spelling and all enabled models concurrently");
    assert.equal(await rerun.isEnabled(), false);
    await rerun.dispatchEvent("click");
    assert.deepEqual(calls, { cliche: 2, [custom]: 2, [disabled]: 0, spelling: 2 }, "repeat clicks cannot duplicate in-flight work");
    const spelling = pending.find(item => item.id === "spelling");
    pending.splice(0).filter(item => item.id !== "spelling").forEach(item => item.resolve());
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    assert.equal(await banner.isVisible(), true, "banner stays until spelling also finishes");
    assert.match(await banner.innerText(), /Running enabled analyses/);
    held = false;
    spelling.resolve();
    await rerun.waitFor({ state: "hidden" });
    await banner.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${text} Edited.`);
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 2);

    // A stale LLM-only scene still offers the shared action.
    await openMenu();
    await page.locator('[data-annotation-toggle="spelling"]').click();
    await toggle(custom);
    await page.keyboard.press("Escape");
    await setText(`${text} Another edit.`);
    await rerun.waitFor({ state: "visible" });
    await rerun.click();
    await rerun.waitFor({ state: "hidden" });
    assert.deepEqual(calls, { cliche: 3, [custom]: 2, [disabled]: 0, spelling: 2 }, "disabled spelling and detectors are skipped");

    // Failure in one detector does not stop another, and keeps retry available.
    await openMenu();
    await toggle(custom);
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    await page.keyboard.press("Escape");
    await setText(`${text} Failure check.`);
    failCliche = true;
    await rerun.click();
    await idle();
    assert.equal(await banner.isVisible(), false, "failed checks release the spinner after all checks settle");
    assert.equal(await rerun.isVisible(), true);
    assert.equal(await page.locator(`.verwrity-text-analysis-${custom}`).count(), 1);
    assert.equal(await page.locator(".verwrity-text-analysis-cliche").count(), 0);
    failCliche = false;
    await rerun.click();
    await rerun.waitFor({ state: "hidden" });

    // Spelling-only shared reruns also have visible feedback.
    await openMenu();
    await toggle("cliche");
    await toggle(custom);
    await page.locator('[data-annotation-toggle="spelling"]').click();
    await page.waitForFunction(() => !document.querySelector("[data-rerun-analysis]").disabled);
    await page.keyboard.press("Escape");
    await setText(`${text} Failure check.` + " Spelling check.");
    held = true;
    await rerun.click();
    await banner.waitFor({ state: "visible" });
    while (!pending.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pending[0].id, "spelling");
    assert.equal(await banner.locator(".scene-audio-spinner").isVisible(), true);
    held = false;
    pending.splice(0).forEach(item => item.resolve());
    await banner.waitFor({ state: "hidden" });
    await openMenu();
    await page.locator('[data-annotation-toggle="spelling"]').click();
    await toggle("cliche");
    await toggle(custom);
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().stale);

    // Appearance changes repaint verified findings, without another model call.
    const beforeStyle = { ...calls };
    await openMenu();
    for (const [id, styles] of [["cliche", ["underline", "squiggly", "double", "highlight"]], [custom, ["squiggly"]]]) {
      await row(id).locator(".text-analysis-style-picker > summary").click();
      for (const style of styles) {
        const saved = page.waitForResponse(response => response.url().endsWith(`/text-analyses/${id}`)
          && response.request().method() === "PATCH");
        await row(id).locator("[data-text-analysis-style]").selectOption(style);
        assert.equal((await saved).status(), 200);
        assert.equal(await page.locator(`.verwrity-text-analysis-${id}.verwrity-annotation-${style}`).count(), 1);
      }
      const bounds = await row(id).locator(".annotation-picker-content").evaluate(element => {
        const rect = element.getBoundingClientRect();
        const menu = element.closest(".annotation-settings").getBoundingClientRect();
        return rect.left >= menu.left && rect.right <= menu.right;
      });
      assert(bounds, "style picker stays within compact dropdown");
      await row(id).locator(".text-analysis-style-picker > summary").click();
    }
    assert.deepEqual(calls, beforeStyle);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), `${text} Failure check. Spelling check.`, "reruns and styles never rewrite source");
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.equal(await row(custom).locator("[data-text-analysis-style]").inputValue(), "squiggly");
    assert.deepEqual(calls, beforeStyle, "reloading styles does not auto-run LLM checks");
    await page.request.post(`${url}/project/new`);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.equal(await row(custom).locator("[data-text-analysis-style]").inputValue(), "squiggly");
    assert.deepEqual(calls, beforeStyle, "styles belong to the user across projects");
    assert.deepEqual(errors, []);
    console.log("PASS: concurrent shared reruns, disabled checks, duplicate guards, failure isolation, and persistent LLM styles without source changes");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
