/* Independent scene analysis layers, stale responses, author control, settings. */
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
    let calls = 0;
    page.on("request", request => { if (request.url().includes("/text-analysis/")) calls += 1; });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    assert.equal(calls, 0, "opening the workspace never invokes an LLM analysis");
    const text = "😀 Her heart skipped\na beat.\n\nCold as ice, then cold as ice.\n\nThe quik fox.";
    await page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text } }));
    }, text);
    const openMenu = async () => {
      const menu = page.locator("details.analysis-menu");
      if (!(await menu.evaluate(menu => menu.open))) await menu.locator(":scope > summary").click();
    };
    await openMenu();
    const openOptions = async row => {
      const options = row.locator(".text-analysis-options");
      const identity = await row.getAttribute("data-text-analysis");
      for (const other of await page.locator(".text-analysis-options[open]").all()) {
        const otherId = await other.evaluate(element => element.closest("[data-text-analysis]").dataset.textAnalysis);
        if (otherId !== identity) await other.locator(":scope > summary").click();
      }
      if (!(await options.evaluate(options => options.open))) await options.locator(":scope > summary").click();
    };
    const menuWidth = await page.locator(".annotation-settings").evaluate(element => element.getBoundingClientRect().width);
    assert(menuWidth <= 340, "analysis dropdown remains compact");
    const spacing = await page.locator('[data-annotation-controls="spelling"]').evaluate(row => {
      const toggle = row.querySelector("button").getBoundingClientRect();
      const style = row.querySelector(".annotation-picker").getBoundingClientRect();
      const color = row.querySelector(".annotation-color").getBoundingClientRect();
      return [style.left - toggle.right, color.left - style.right];
    });
    assert(spacing.every(gap => gap >= 0 && gap <= 6), "spelling controls stay together instead of stretching across the dropdown");
    const cliche = page.locator('[data-text-analysis="cliche"]');
    assert.equal(await cliche.locator(".annotation-toggle").getAttribute("aria-pressed"), "false");
    assert.equal(await cliche.locator("[data-text-analysis-status]").isVisible(), false);
    await cliche.locator("[data-toggle-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="cliche"] [data-text-analysis-status]').textContent.includes("AI Models"));
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0, "missing consent has no highlights");

    const form = page.locator("[data-text-analysis-form]");
    await page.locator(".custom-text-analysis > summary").click();
    await form.locator('[name="name"]').fill("Imagery review");
    await form.locator('[name="prompt"]').fill("Look for generic imagery; explain the concern.");
    await form.locator('[name="color"]').evaluate(input => { input.value = "#8b5cf6"; });
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    const definitions = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions;
    const customId = definitions.find(item => item.name === "Imagery review").id;
    const custom = page.locator(`[data-text-analysis="${customId}"]`);
    const sceneId = await page.evaluate(() => window.verwrityEditor.sceneId);
    const result = (id, quote, second = false) => {
      const index = second ? text.lastIndexOf(quote) : text.indexOf(quote);
      const start = Array.from(text.slice(0, index)).length;
      return { scene_id: sceneId, analysis_id: id, discarded_findings: 0,
        annotations: [{ id: `finding-${id}`, start, end: start + Array.from(quote).length,
          quote, explanation: 'Stock phrase <script>window.bad = true</script>', provenance: "ai-derived" }] };
    };
    let pending = [];
    let mode = "normal";
    await page.route("**/scene/*/text-analysis/*", async route => {
      assert.equal(route.request().postDataJSON().scene_text, mode === "normal" ? text : await page.evaluate(() => window.verwrityEditor.getText()));
      const id = route.request().url().split("/").pop();
      if (mode === "held") await new Promise(resolve => pending.push(resolve));
      try {
        await route.fulfill({ json: mode === "error" ? { error: "Synthetic model failure. Try again." }
          : mode === "empty" ? { scene_id: sceneId, analysis_id: id, annotations: [], discarded_findings: 1 }
          : result(id, mode === "multiline" ? "heart skipped\na beat" : "cold as ice", mode !== "multiline"), status: mode === "error" ? 502 : 200 });
      } catch (error) { if (!/closed|handled|cancel/i.test(error.message)) throw error; }
    });

    await cliche.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="cliche"] [data-text-analysis-status]').textContent.includes("1 passage"));
    assert.deepEqual(await page.locator('.verwrity-text-analysis-cliche').allTextContents(), ["cold as ice"]);
    await cliche.locator("[data-text-analysis-findings] > summary").click();
    assert.match(await cliche.locator("[data-text-analysis-findings]").innerText(), /Stock phrase <script>/);
    assert.equal(await page.evaluate(() => window.bad), undefined, "model explanations render as text");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text);
    await cliche.locator("[data-text-analysis-findings] button").click();
    const selected = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    assert.equal(selected.start, Array.from(text.slice(0, text.lastIndexOf("cold as ice"))).length, "highlights and navigation use the second occurrence after emoji");
    await openMenu();
    mode = "multiline";
    await cliche.locator("[data-run-text-analysis]").click();
    // ProseMirror splits an inline decoration around the hard-break node.
    await page.waitForFunction(() => [...document.querySelectorAll(".verwrity-text-analysis-cliche")].map(span => span.textContent).join("") === "heart skippeda beat");
    await cliche.locator("[data-text-analysis-findings] button").click();
    assert.equal((await page.evaluate(() => window.verwrityEditor.getSelectedRange())).quote, "heart skipped\na beat", "multiline ranges map through hard breaks");
    await openMenu();
    mode = "normal";
    await cliche.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector(".verwrity-text-analysis-cliche")?.textContent === "cold as ice");

    await custom.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(id => document.querySelector(`[data-text-analysis="${id}"] [data-text-analysis-status]`).textContent.includes("1 passage"), customId);
    assert.equal(await page.locator('.verwrity-text-analysis-cliche').count(), 1);
    assert.equal(await page.locator(`.verwrity-text-analysis-${customId}`).count(), 1, "overlapping layers coexist");
    await cliche.locator("[data-toggle-text-analysis]").click();
    assert.equal(await page.locator('.verwrity-text-analysis-cliche').count(), 0);
    assert.equal(await page.locator(`.verwrity-text-analysis-${customId}`).count(), 1);
    await cliche.locator("[data-toggle-text-analysis]").click();
    assert.equal(await page.locator('.verwrity-text-analysis-cliche').count(), 1);
    await cliche.locator("[data-text-analysis-color]").evaluate(input => {
      input.value = "#123456"; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForResponse(response => response.url().endsWith("/text-analyses/cliche") && response.request().method() === "PATCH");
    await custom.locator("[data-toggle-text-analysis]").click();
    assert.match(await page.locator('.verwrity-text-analysis-cliche').getAttribute("style"), /#123456/);
    await custom.locator("[data-toggle-text-analysis]").click();

    await page.locator('[data-annotation-toggle="spelling"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".verwrity-spelling-error").length > 0);
    assert.equal(await page.locator('.verwrity-text-analysis-cliche').count(), 1, "spelling does not replace LLM layers");
    await openOptions(cliche);
    await cliche.locator("[data-clear-text-analysis]").click();
    assert.equal(await page.locator('.verwrity-text-analysis-cliche').count(), 0);
    assert.equal(await page.locator(`.verwrity-text-analysis-${customId}`).count(), 1);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text, "hide and clear cannot mutate source");

    // Run two detectors concurrently, then edit before either returns.
    mode = "held";
    await cliche.locator("[data-run-text-analysis]").click();
    await custom.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelectorAll('[data-cancel-text-analysis]:not([hidden])').length === 2);
    assert.equal(await page.locator("[data-text-analysis-progress]").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-text-analysis-progress]").isVisible(), true, "long-running status remains visible outside the menu");
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" changed");
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0, "edits immediately clear findings");
    while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 20));
    pending.splice(0).forEach(resolve => resolve());
    await page.waitForFunction(id => ["cliche", id].every(identity => document.querySelector(`[data-text-analysis="${identity}"] [data-text-analysis-status]`).textContent.includes("Text changed"))
      && [...document.querySelectorAll('[data-cancel-text-analysis]')].every(button => button.hidden), customId);
    assert.equal(await page.locator("[data-text-analysis-progress]").isVisible(), false);
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0, "late responses do not reappear");

    await openMenu();
    await cliche.locator("[data-run-text-analysis]").click();
    await cliche.locator("[data-cancel-text-analysis]").click();
    assert.match(await cliche.locator("[data-text-analysis-status]").innerText(), /Cancelled/);
    pending.splice(0).forEach(resolve => resolve());
    mode = "error";
    await cliche.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="cliche"] [data-text-analysis-status]').textContent.includes("Synthetic model failure"));
    mode = "empty";
    await cliche.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelector('[data-text-analysis="cliche"] [data-text-analysis-status]').textContent.includes("No passages flagged"));
    assert.match(await cliche.locator("[data-text-analysis-status]").innerText(), /1 unverified/);
    assert.equal(await cliche.locator("[data-text-analysis-findings]").isVisible(), false);

    // A revision/source swap invalidates layers even with emitUpdate disabled.
    await page.evaluate(text => window.verwrityEditor.setText(text), text);
    mode = "normal";
    await cliche.locator("[data-run-text-analysis]").click();
    await page.waitForFunction(() => document.querySelectorAll(".verwrity-text-analysis").length === 1);
    await page.evaluate(() => window.verwrityEditor.setText("A historical revision.", [], false));
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0);
    assert.match(await cliche.locator("[data-text-analysis-status]").innerText(), /stale/);

    await openOptions(custom);
    await custom.locator("[data-edit-text-analysis]").click();
    await form.locator('[name="prompt"]').fill("Look for vague descriptions.");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    const edited = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions.find(item => item.id === customId);
    assert.equal(edited.prompt, "Look for vague descriptions.");
    await form.locator('[name="name"]').fill("Dialogue review");
    await form.locator('[name="prompt"]').fill("Look for unnatural exposition in dialogue.");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    await openOptions(cliche);
    assert.equal(await cliche.locator("[data-restore-text-analysis]").isEnabled(), false);
    await cliche.locator("[data-edit-text-analysis]").click();
    const defaultPrompt = await form.locator('[name="prompt"]').inputValue();
    assert.equal(await form.locator('[name="name"]').isEnabled(), false, "canned names remain stable while their prompts are editable");
    assert.equal(await page.locator("[data-text-analysis-prompt-note]").isVisible(), true);
    const personalPrompt = "Look for worn metaphors while allowing deliberately familiar dialogue.";
    await form.locator('[name="prompt"]').fill(personalPrompt);
    assert.equal(await form.locator("[data-restore-text-analysis-form]").isEnabled(), true, "unsaved built-in prompt edits can also be restored");
    await form.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("saved"));
    const savedDefinitions = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions;
    assert.equal(savedDefinitions[0].prompt, personalPrompt);
    assert.equal(savedDefinitions[0].prompt_overridden, true);
    const secondId = savedDefinitions.find(item => item.name === "Dialogue review").id;
    assert.equal(await page.locator("[data-text-analysis] .annotation-toggle").count(), 7, "five built-ins and each custom analysis get their own switch");
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await openMenu();
    assert.equal(await cliche.locator("[data-text-analysis-color]").inputValue(), "#123456");
    assert.equal(await custom.locator("[data-run-text-analysis]").count(), 1, "custom button survives reload");
    assert.equal(await page.locator(`[data-text-analysis="${secondId}"] [data-toggle-text-analysis]`).count(), 1);
    assert.equal(await page.locator(".verwrity-text-analysis").count(), 0, "observations remain transient");
    const callsBeforeProjectChange = calls;
    await page.request.post(`${url}/project/new`);
    await page.reload();
    await openMenu();
    assert.equal(await page.locator("[data-text-analysis] .annotation-toggle").count(), 7, "all built-ins and both user-defined buttons survive switching projects");
    assert.deepEqual((await (await page.request.get(`${url}/text-analyses`)).json()).definitions, savedDefinitions);
    assert.equal(calls, callsBeforeProjectChange, "switching projects never reruns an LLM analysis");
    await openOptions(cliche);
    assert.equal(await cliche.locator("[data-restore-text-analysis]").isEnabled(), true);
    await cliche.locator("[data-edit-text-analysis]").click();
    assert.equal(await form.locator('[name="prompt"]').inputValue(), personalPrompt);
    await form.locator("[data-restore-text-analysis-form]").click();
    await page.waitForFunction(() => document.querySelector("[data-text-analysis-form-status]").textContent.includes("Default prompt restored"));
    assert.equal(await form.locator('[name="prompt"]').inputValue(), defaultPrompt);
    const restoredDefinition = (await (await page.request.get(`${url}/text-analyses`)).json()).definitions[0];
    assert.equal(restoredDefinition.prompt_overridden, false);
    assert.equal(restoredDefinition.color, "#123456", "restoring the prompt preserves colour preferences");
    await openOptions(cliche);
    assert.equal(await cliche.locator("[data-restore-text-analysis]").isEnabled(), false);
    await openOptions(custom);
    await custom.locator("[data-delete-text-analysis]").click();
    await custom.waitFor({ state: "detached" });
    assert.equal((await (await page.request.get(`${url}/text-analyses`)).json()).definitions.length, 6, "deleting one custom analysis preserves the other and all built-ins");
    assert.deepEqual(errors, []);
    console.log("PASS: compact analysis controls, independent layers, safe results, multiple user prompts across projects, and canned prompt overrides/restoration");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
