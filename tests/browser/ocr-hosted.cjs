/* Real settings/capture routes, synthetic credentials and intercepted recognition. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.request.post(`${url}/__browser_test__/reset`);
    let calls = 0, sampleTests = 0;
    await page.route("**/ai/models/ocr/test", route => { sampleTests++; return route.abort(); });
    await page.route("**/ai/ocr/recognize", async route => {
      calls++; const data = route.request().postDataJSON();
      assert(data.consent_endpoint.startsWith("https://"));
      await route.fulfill({ contentType: "application/x-ndjson", body: JSON.stringify({ result: {
        page_id: data.page_id, text: "Synthetic online transcription.", model: "synthetic", warnings: [] } }) + "\n" });
    });
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => { document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()); window.verwrityDialog.confirm = async () => true; });
    await page.locator(".settings-menu > summary").click();
    await page.locator("[data-ai-models-open]").click();
    await page.locator('[data-ai-tab="ocr"]').click();
    const form = page.locator("[data-ai-ocr-form]");
    for (const provider of ["mistral", "azure", "google"]) {
      if (provider !== "mistral") {
        await page.locator("#ocr-import-dialog [data-ocr-hide]").first().click();
        await page.locator(".settings-menu > summary").click();
        await page.locator("[data-ai-models-open]").click();
        await form.waitFor({ state: "visible" });
      }
      await form.locator('[name="provider"]').selectOption(provider);
      assert(await page.locator("[data-ocr-model-local]").isHidden());
      assert(await page.locator("[data-ocr-model-online]").isVisible());
      assert.match(await page.locator("[data-ocr-model-online]").textContent(), /outside Verwrity's control/);
      if (provider === "azure") {
        await form.locator('[name="endpoint"]').fill("https://synthetic.cognitiveservices.azure.com");
        await form.locator('[name="endpoint"]').dispatchEvent("change");
      }
      await form.locator('[name="token"]').fill("synthetic-key-for-" + provider);
      await form.locator('[name="remote_consent"]').check();
      const saving = page.waitForResponse(response => response.url().endsWith("/ai/models/ocr") && response.request().method() === "POST");
      await form.locator('[type="submit"]').click();
      assert.equal((await saving).status(), 200);
      await page.waitForFunction(() => document.querySelector("[data-ocr-model-status]").textContent.includes("OCR settings saved"));
      const saved = await (await page.request.get(`${url}/ai/models/ocr`)).json();
      assert.equal(saved.provider, provider);
      assert(saved.readiness.configured);
      assert.equal(saved.readiness.tested, false, "a passing sample is not required");
      assert.equal(saved.token, "");
      assert(!JSON.stringify(saved).includes("synthetic-key-for-"));
      await page.locator("[data-ai-models-close]").click();
      await page.evaluate(() => document.querySelector("[data-ocr-open]").click());
      await page.locator("#ocr-import-dialog").waitFor({ state: "visible" });
      assert(await page.locator("[data-ocr-config-notice]").isHidden(), "no missing-test warning blocks valid configuration");
      assert(await page.locator("[data-ocr-online-notice]").isVisible());
      if (provider === "mistral") {
        const image = await page.evaluate(() => {
          const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 800;
          const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 600, 800);
          context.fillStyle = "black"; context.fillText("Synthetic test page", 50, 50);
          return canvas.toDataURL("image/png").split(",")[1];
        });
        await page.locator("[data-ocr-files]").setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
        await page.waitForFunction(() => document.querySelectorAll(".ocr-page").length === 1 && document.querySelector("[data-ocr-cancel]").disabled);
      }
      assert(!await page.locator("[data-ocr-image-consent]").isChecked(), "each reopened import requires image consent");
      assert(await page.locator("[data-ocr-retry]").isDisabled());
      await page.locator("[data-ocr-image-consent]").check();
      assert(await page.locator("[data-ocr-retry]").isEnabled());
      await page.locator(provider === "mistral" ? "[data-ocr-run]" : "[data-ocr-retry]").click();
      await page.waitForFunction(() => document.querySelector("[data-ocr-cancel]").disabled && document.querySelector("[data-ocr-raw]").value === "Synthetic online transcription.");
    }
    assert.equal(calls, 3); assert.equal(sampleTests, 0);
    assert.deepEqual(errors, []);
    await page.evaluate(() => { document.querySelector("#ocr-import-dialog .ocr-body").scrollTop = 0; });
    await page.screenshot({ path: "node_modules/.verwrity-test-temp/ocr-hosted.png", fullPage: true });
    console.log("PASS: Mistral/Azure/Google setup, private keys, no local weights, optional sample testing, explicit image consent and page processing.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
