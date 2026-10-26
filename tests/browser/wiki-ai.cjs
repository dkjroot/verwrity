/* End-to-end wiki generation uses a local fake LLM and real save/provenance routes. */
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  let mode = "populate", calls = 0;
  const llm = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const prompt = JSON.parse(body).messages.at(-1).content; calls++;
    const sceneId = /<scene id="([^"]+)"/.exec(prompt)[1];
    const pageData = JSON.parse(prompt.split("PAGE JSON:\n")[1].split("\nCURRENT MANUSCRIPT:")[0]);
    const evidence = [{ source_type: "scene", source_id: sceneId, quote: "Mara has blue eyes." }];
    let result = { summary: "Added supported appearance details.", insertions: [], updates: [], suggestions: [] };
    if (prompt.includes('JSON {"purpose"')) result = { purpose: "Mara's appearance, home and background" };
    else if (mode === "refresh") {
      result.updates = [{ id: pageData.ai_passages.find(a => a.quote.includes("Blue eyes")).id, text: "- Eyes: blue; home: by the river.", evidence }];
      result.suggestions = [{ quote: "Human secret.", explanation: "Consider adding what Mara knows about the river.", evidence }];
    } else if (mode === "paragraphs") {
      result.insertions = [{ after: "", text: "First AI paragraph.\n\nSame AI paragraph.\n\nSame AI paragraph.", evidence }];
    } else if (mode === "paragraph-refresh") {
      result.updates = [{ id: pageData.ai_passages.find(a => a.quote === "Same AI paragraph.").id,
        text: "Updated AI paragraph.", evidence }];
      result.suggestions = [{ quote: "Adopted AI paragraph.", explanation: "Consider adding the river detail here.", evidence }];
    } else if (mode === "delegated-refresh") {
      result.updates = [{ id: pageData.ai_passages.find(a => a.origin === "human_delegated").id,
        text: "Maintained note from manuscript.", evidence }];
    } else if (mode === 'repair-delegated') {
      result.summary = "Populated Mara Vale's wiki page with details.";
      result.updates = prompt.includes('CORRECTION:')
        ? [{ id: 'A1', text: 'Background: Mara lives by the river.', evidence: [{ quote: 'Mara lives by the river.' }] },
           { id: 'A2', text: 'Appearance: Mara has blue eyes.', evidence: [{ quote: 'Mara has blue eyes.' }] }]
        : [{ id: 'A1', text: 'Background: Mara lives by the river.', evidence: [] },
           { id: 'A2', text: 'Appearance: Mara has blue eyes.', evidence: [] }];
    } else if (mode === 'always-invalid') {
      result.summary = 'Populated everything successfully!';
      result.updates = [{ id: 'A1', text: 'Unsupported replacement.', evidence: [] }];
    } else if (mode === 'protected-additions') {
      assert.equal(pageData.ai_passages.length, 0, 'New paragraphs need no replacement permission');
      result.insertions = [{ after_id: 'P1', text: 'AI detail: Mara has blue eyes.', evidence }];
    } else result.insertions = [{ after: pageData.body ? "Human secret." : "", text: "\n\n## Appearance\n- Blue eyes.\n", evidence }];
    if (mode === "slow") await new Promise(resolve => setTimeout(resolve, 1300));
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
    await page.locator(".ProseMirror").click(); await page.keyboard.press("Control+A");
    await page.keyboard.type("Mara has blue eyes. Mara lives by the river.");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    const settings = await page.request.post(`${url}/ai/models/llm`, { data: { standard: "openai_compatible",
      endpoint: `http://127.0.0.1:${llm.address().port}/v1`, model: "wiki-test" } });
    assert.equal(settings.status(), 200);
    const created = await page.request.post(`${url}/wiki/page/create`, { form: { title: "Mara" } });
    await page.goto(created.url());
    const pageId = new URL(page.url()).searchParams.get("wiki_page");
    const sceneText = await page.locator(".ProseMirror").innerText();
    const current = page.locator("[data-wiki-current-page]");
    await current.getByRole("button", { name: "Edit page", exact: true }).click();
    await page.locator("[data-wiki-page-editor] textarea[name='body']").fill("Human secret.");
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Save page", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".wiki-page-body")?.textContent === "Human secret.");
    const controls = page.locator(".wiki-ai-controls");
    await controls.locator("summary").click();
    await controls.getByRole("button", { name: "Suggest purpose (AI)", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-wiki-purpose]")?.value.includes("Mara's appearance"));
    assert.equal(await current.locator(".wiki-page-body").textContent(), "Human secret.");
    await controls.getByRole("button", { name: "Update from manuscript (AI)", exact: true }).click();
    await current.locator(".wiki-ai-text").first().waitFor();
    assert.equal(await current.locator(".wiki-citation-warning").count(), 0, "Evidence-backed sections have no missing-citation warning");
    let data = await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json();
    assert(data.body.startsWith("Human secret.")); assert.equal(data.annotations[0].kind, "ai_text");
    assert.equal(await current.locator(".wiki-page-body h3 .wiki-ai-text").textContent(), "Appearance");
    assert.equal(await current.locator(".wiki-page-body li .wiki-ai-text").textContent(), "Blue eyes.");
    assert.equal(await page.locator(".ProseMirror").innerText(), sceneText, "Wiki AI leaves manuscript unchanged");

    mode = "refresh"; await controls.locator("summary").click();
    await controls.getByRole("button", { name: "Update from manuscript (AI)", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".wiki-page-body")?.textContent.includes("home: by the river"));
    assert.equal(await current.locator(".wiki-ai-suggestion").textContent(), "Human secret.");
    assert.notEqual(await current.locator(".wiki-ai-text").first().evaluate(el => getComputedStyle(el).color),
      await current.locator(".wiki-ai-suggestion").evaluate(el => getComputedStyle(el).color));
    if (process.env.VERWRITY_WIKI_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_WIKI_SCREENSHOT });
    await current.locator(".wiki-ai-review details").filter({ hasText: "Review:" }).locator("summary").click();
    await current.getByRole("button", { name: "Dismiss suggestion", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".wiki-ai-suggestion"));
    await page.reload();
    assert(await current.locator(".wiki-ai-text").count() > 0, "AI authorship survives reload");
    assert.equal(await current.locator(".wiki-ai-suggestion").count(), 0, "Dismissal survives reload");
    await current.locator(".wiki-block-source").first().click();
    await page.locator("dialog[aria-label=\"AI source\"]").getByRole("button", { name: "Go to passage", exact: true }).first().click();
    await page.locator(".verwrity-ai-passage").first().waitFor();

    const beforeCancel = (await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json()).body;
    mode = "slow"; const beforeCalls = calls;
    await controls.locator("summary").click();
    await controls.getByRole("button", { name: "Update from manuscript (AI)", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".wiki-ai-controls button")?.disabled === true);
    while (calls === beforeCalls) await new Promise(resolve => setTimeout(resolve, 20));
    await controls.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(1600);
    assert.equal((await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json()).body, beforeCancel);

    await current.getByRole("button", { name: "Edit page", exact: true }).click();
    const editor = page.locator("[data-wiki-page-editor] textarea[name='body']");
    await editor.evaluate(el => { const start = el.value.indexOf("blue"); el.focus(); el.setSelectionRange(start, start + 4); });
    await page.keyboard.insertText("green");
    await page.route(`**/wiki/page/${pageId}/save`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Save failed; retry." }) }));
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Save page", exact: true }).click();
    await page.getByRole("button", { name: "OK", exact: true }).click();
    assert((await editor.inputValue()).includes("Eyes: green"), "Failed save preserves browser edits");
    await page.unroute(`**/wiki/page/${pageId}/save`);
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Save page", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".wiki-page-body")?.textContent.includes("Eyes: green"));
    assert.equal(await current.locator(".wiki-ai-block").count(), 1, "Only the edited AI list item is adopted; its AI heading remains");
    data = await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json();
    const revisionId = data.revisions.at(-1).id;
    const restored = await page.request.post(`${url}/wiki/page/${pageId}/restore/${revisionId}`);
    await page.goto(restored.url());
    assert(await current.locator(".wiki-ai-text").count() > 0, "Restoring a wiki revision restores authorship");
    assert.equal(await page.locator(".ProseMirror").innerText(), sceneText);
    mode = "slow";
    const beforeEditCalls = calls;
    const finalBody = (await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json()).body;
    await controls.locator("summary").click();
    await controls.getByRole("button", { name: "Update from manuscript (AI)", exact: true }).click();
    while (calls === beforeEditCalls) await new Promise(resolve => setTimeout(resolve, 20));
    await page.locator(".ProseMirror").click(); await page.keyboard.press("End"); await page.keyboard.type(" Human edit.");
    await page.waitForTimeout(1500);
    assert.equal((await (await page.request.get(`${url}/wiki/page/${pageId}/data`)).json()).body, finalBody,
      "Unsaved manuscript edits cancel in-flight wiki generation");
    assert((await controls.locator(".wiki-ai-status").textContent()).includes("changed"));
    const formattedOwnership = await page.evaluate(async () => {
      const { renderWikiBody } = await import("/static/wiki-rendering.js");
      const host = document.createElement("div");
      const body = "😀 **Human AI**\n\n[[AI|AI]]";
      const first = Array.from(body.slice(0, body.indexOf("AI"))).length;
      const last = Array.from(body.slice(0, body.lastIndexOf("AI"))).length;
      renderWikiBody(host, body, [{ id: "ai", title: "AI", aliases: [] }],
        [{ kind: "ai_text", start: first, end: first + 2 }, { kind: "ai_text", start: last, end: last + 2 }]);
      return { text: host.textContent, ai: [...host.querySelectorAll(".wiki-ai-text")].map(el => el.textContent),
        human: host.querySelector("strong").firstChild.textContent };
    });
    assert.deepEqual(formattedOwnership.ai, ["AI", "AI"]);
    assert.equal(formattedOwnership.human, "Human ", "Mixed formatting preserves human text colour and Unicode offsets");

    mode = "paragraphs";
    const paragraphPage = await page.request.post(`${url}/wiki/page/create`, { form: { title: "Paragraph authorship" } });
    await page.goto(paragraphPage.url());
    const paragraphId = new URL(page.url()).searchParams.get("wiki_page");
    await controls.locator("summary").click();
    assert.equal(await controls.getByRole("button", { name: "AI Models", exact: true }).count(), 0);
    await controls.locator("[data-wiki-purpose]").fill("A paragraph test");
    await controls.getByRole("button", { name: "Populate from manuscript (AI)", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".wiki-page-body .wiki-ai-block").length === 3);
    const originalBlocks = (await (await page.request.get(`${url}/wiki/page/${paragraphId}/data`)).json()).annotations;
    await current.getByRole("button", { name: "Edit page", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".wiki-source-ai-box").length === 3);
    await editor.evaluate(el => { const start = el.value.indexOf("Same"); el.focus(); el.setSelectionRange(start, start); });
    await page.keyboard.insertText("Human 😀 note.\n\n");
    await page.waitForFunction(() => document.querySelectorAll(".wiki-source-ai-box").length === 3);
    await editor.evaluate(el => { const start = el.value.indexOf("Same"); el.focus(); el.setSelectionRange(start, start + 4); });
    await page.keyboard.insertText("Adopted");
    await page.waitForFunction(() => document.querySelectorAll(".wiki-source-ai-box").length === 2);
    const legend = page.locator('[data-wiki-page-editor] .wiki-authorship-legend');
    assert(await page.locator('.wiki-editor-tools').evaluate(el => el.scrollWidth <= el.clientWidth + 1),
      'Maintenance controls fit inside the wiki column without horizontal overflow');
    await legend.getByText('Human / adopted · protected', { exact: true }).waitFor({ state: 'visible' });
    await legend.getByText('AI-maintained · may be updated', { exact: true }).waitFor({ state: 'visible' });
    for (const theme of ['light', 'dark']) {
      const ownershipDisplay = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const mirror = document.querySelector('.wiki-authorship-mirror');
        const human = [...mirror.querySelectorAll('.wiki-human-text')].find(el => el.textContent.includes('Human 😀 note.'));
        const ai = mirror.querySelector('.wiki-ai-text');
        const textarea = document.querySelector('[data-wiki-page-editor] textarea[name="body"]');
        const label = document.querySelector('.wiki-source-ai-box .wiki-ai-label');
        return { human: human.textContent, humanColour: getComputedStyle(human).color,
          aiColour: getComputedStyle(ai).color, nativeColour: getComputedStyle(textarea).color,
          label: label.textContent, border: getComputedStyle(label.parentElement).borderTopStyle };
      }, theme);
      assert(ownershipDisplay.human.includes('Adopted AI paragraph.'), `${theme}: adopted text visibly uses human ownership`);
      assert.notEqual(ownershipDisplay.humanColour, ownershipDisplay.aiColour, `${theme}: human and AI source colours differ`);
      assert.equal(ownershipDisplay.nativeColour, 'rgba(0, 0, 0, 0)', `${theme}: native textarea does not obscure ownership colours`);
      assert.equal(ownershipDisplay.label, 'AI text');
      assert.equal(ownershipDisplay.border, 'dotted');
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Preview", exact: true }).click();
    assert.equal(await page.locator(".wiki-preview .wiki-ai-block").count(), 2);
    assert((await page.locator(".wiki-preview").innerText()).includes("Human 😀 note."));
    await editor.scrollIntoViewIfNeeded();
    if (process.env.VERWRITY_WIKI_EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_WIKI_EDITOR_SCREENSHOT });
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Save page", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".wiki-page-body .wiki-ai-block").length === 2);
    const mixed = await (await page.request.get(`${url}/wiki/page/${paragraphId}/data`)).json();
    assert.deepEqual(mixed.annotations.map(a => a.id), [originalBlocks[0].id, originalBlocks[2].id]);
    assert(mixed.body.includes("Human 😀 note.\n\nAdopted AI paragraph."));
    mode = "paragraph-refresh";
    await controls.locator("summary").click();
    await controls.getByRole("button", { name: "Update from manuscript (AI)", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".wiki-page-body")?.textContent.includes("Updated AI paragraph."));
    assert((await current.locator(".wiki-page-body").innerText()).includes("Human 😀 note."));
    assert.equal(await current.locator(".wiki-ai-suggestion").textContent(), "Adopted AI paragraph.");
    assert.equal(await current.locator(".wiki-ai-block").count(), 2);
    await page.reload();
    assert.equal(await current.locator(".wiki-ai-block").count(), 2, "Mixed paragraph authorship survives reload");
    await current.getByRole('button', { name: 'Edit page', exact: true }).click();
    const tools = page.locator('[data-wiki-page-editor]');
    await editor.evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+z');
    assert((await editor.inputValue()).endsWith('Updated AI paragraph.'), 'AI-end paragraph insertion retains native undo');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('My human ending.');
    await page.waitForFunction(() => document.querySelectorAll('.wiki-source-ai-box').length === 2);
    assert((await editor.inputValue()).endsWith('Updated AI paragraph.\n\nMy human ending.'), 'Return at an AI block end creates a separate human paragraph');
    await tools.getByRole('button', { name: 'Add human paragraph', exact: true }).click();
    await page.keyboard.insertText('Another human paragraph.');
    assert((await editor.inputValue()).endsWith('My human ending.\n\nAnother human paragraph.'), 'Human paragraph control works at page end');
    const beforeDelegation = await editor.inputValue(), beforeDelegationCalls = calls;
    await editor.evaluate(el => { const start = el.value.indexOf('Human 😀 note.'); el.focus(); el.setSelectionRange(start, start + 'Human 😀 note.'.length); });
    await tools.getByRole('button', { name: 'Mark as AI maintained', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wiki-source-ai-box').length === 3);
    await page.locator('.wiki-source-ai-box').getByText('AI maintained', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), beforeDelegation, 'Granting maintenance permission never changes prose');
    await tools.getByRole('button', { name: 'Mark as human owned / protected', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wiki-source-ai-box').length === 2);
    await tools.getByRole('button', { name: 'Mark as AI maintained', exact: true }).click();
    await tools.getByRole('button', { name: 'Save page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('Another human paragraph.'));
    const delegated = await (await page.request.get(`${url}/wiki/page/${paragraphId}/data`)).json();
    const handover = delegated.annotations.find(a => a.origin === 'human_delegated');
    assert.equal(handover.quote, 'Human 😀 note.');
    assert.deepEqual(handover.evidence, []); assert.equal(handover.model, '');
    assert.equal(calls, beforeDelegationCalls, 'Changing update permission makes no model request');
    assert.equal(delegated.body, beforeDelegation);
    await current.getByRole('button', { name: 'AI permission', exact: true }).first().click();
    await page.locator('dialog[aria-label="AI permission"]').getByText('Human-written · AI updates allowed').waitFor();
    await page.locator('[aria-label="Close AI source"]').click();
    mode = 'delegated-refresh';
    await controls.locator('summary').click();
    await controls.getByRole('button', { name: 'Update from manuscript (AI)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('Maintained note from manuscript.'));
    const maintained = await (await page.request.get(`${url}/wiki/page/${paragraphId}/data`)).json();
    assert.equal(maintained.body, beforeDelegation.replace('Human 😀 note.', 'Maintained note from manuscript.'));
    assert.equal(maintained.annotations.find(a => a.quote === 'Maintained note from manuscript.').origin, 'ai_generated');

    const protectedPage = await page.request.post(`${url}/wiki/page/create`, { form: { title: 'Protected paragraphs' } });
    await page.goto(protectedPage.url());
    const protectedId = new URL(page.url()).searchParams.get('wiki_page');
    await current.getByRole('button', { name: 'Edit page', exact: true }).click();
    await editor.fill('Human background.\n\nHuman appearance.');
    await tools.getByRole('button', { name: 'Save page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('Human appearance.'));
    const manuscriptBeforeAddition = await page.locator('.ProseMirror').innerText();
    mode = 'protected-additions';
    await controls.locator('summary').click();
    await controls.locator('[data-wiki-purpose]').fill('Background and appearance');
    await controls.getByRole('button', { name: 'Update from manuscript (AI)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('AI detail: Mara has blue eyes.'));
    const protectedData = await (await page.request.get(`${url}/wiki/page/${protectedId}/data`)).json();
    assert.equal(protectedData.body, 'Human background.\n\nAI detail: Mara has blue eyes.\n\nHuman appearance.');
    assert.equal(protectedData.annotations.length, 1);
    assert.equal(protectedData.annotations[0].quote, 'AI detail: Mara has blue eyes.');
    assert.equal(await current.locator('.wiki-ai-block').count(), 1, 'Only the inserted paragraph has AI ownership');
    assert.equal(await page.locator('.ProseMirror').innerText(), manuscriptBeforeAddition, 'Wiki additions leave manuscript unchanged');

    const allHumanPage = await page.request.post(`${url}/wiki/page/create`, { form: { title: 'Full human draft' } });
    await page.goto(allHumanPage.url());
    const allHumanId = new URL(page.url()).searchParams.get('wiki_page');
    await current.getByRole('button', { name: 'Edit page', exact: true }).click();
    await editor.fill('Draft background.\n\nDraft appearance.');
    await editor.focus(); await page.keyboard.press('Control+A');
    await tools.getByRole('button', { name: 'Mark as AI maintained', exact: true }).click();
    await tools.getByRole('button', { name: 'Save page', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.wiki-page-body .wiki-ai-block').length === 2);
    const draftData = await (await page.request.get(`${url}/wiki/page/${allHumanId}/data`)).json();
    assert(draftData.annotations.every(a => a.origin === 'human_delegated'), 'The entire human page was explicitly delegated');
    mode = 'repair-delegated';
    const callsBeforeRepair = calls;
    await controls.locator('summary').click();
    await controls.locator('[data-wiki-purpose]').fill('Background and appearance');
    await controls.getByRole('button', { name: 'Update from manuscript (AI)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('Background: Mara lives by the river.'));
    assert.equal(calls, callsBeforeRepair + 2, 'An entirely rejected response receives one correction attempt');
    const repairedData = await (await page.request.get(`${url}/wiki/page/${allHumanId}/data`)).json();
    assert.equal(repairedData.body, 'Background: Mara lives by the river.\n\nAppearance: Mara has blue eyes.');
    assert(repairedData.annotations.every(a => a.origin === 'ai_generated' && a.evidence.length > 0));
    assert((await current.locator(':scope > .wiki-ai-status').textContent()).includes('2 updated'), 'Success reflects accepted changes');
    mode = 'always-invalid';
    const callsBeforeFailure = calls;
    await controls.locator('summary').click();
    await controls.getByRole('button', { name: 'Update from manuscript (AI)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-wiki-current-page] > .wiki-ai-status')?.textContent.includes('automatic correction did not produce'));
    assert.equal(calls, callsBeforeFailure + 2, 'Failed correction stops after two provider calls');
    const failedData = await (await page.request.get(`${url}/wiki/page/${allHumanId}/data`)).json();
    assert.deepEqual(failedData, repairedData, 'Rejected responses change neither page content nor provenance/history');
    const failureMessage = await current.locator(':scope > .wiki-ai-status').textContent();
    assert(failureMessage.includes('No page text or review suggestions were changed.'));
    assert(failureMessage.includes('no exact, unambiguous supporting quote'));
    assert(!failureMessage.includes('Populated everything'), 'An LLM success claim never replaces validation results');

    const legacyArchive = await (await page.request.get(`${url}/__browser_test__/wiki_legacy_archive`)).body();
    const imported = await page.request.post(`${url}/project/open`, { multipart: {
      project_file: { name: 'legacy.verwrity.zip', mimeType: 'application/zip', buffer: legacyArchive } } });
    assert.equal(imported.status(), 200);
    await page.goto(url);
    await page.locator('[data-wiki-search]').fill('Legacy AI');
    await page.locator('.wiki-page-list .wiki-link').getByText('Legacy AI', { exact: true }).click();
    await page.locator('[data-wiki-search]').fill('');
    const legacyId = await page.locator('.wiki-link[aria-current="true"]').getAttribute('data-wiki-page-id');
    const legacyData = await (await page.request.get(`${url}/wiki/page/${legacyId}/data`)).json();
    assert(legacyData.body.includes('\r\n'), 'Legacy fixture contains real Windows line endings');
    assert.equal(legacyData.annotations.length, 2, 'Old combined AI range migrates into stable paragraphs');
    await current.getByRole('button', { name: 'Edit page', exact: true }).click();
    const legacyEdit = JSON.parse(await page.locator('[name="authorship_edits"]').inputValue());
    assert.deepEqual(legacyEdit[0], { kind: 'normalize_newlines' }, 'Exact source survives HTML and normalizes explicitly in the editor');
    await tools.getByRole('button', { name: 'Add human paragraph', exact: true }).click();
    await page.keyboard.insertText('A human addition to an old entry.');
    await tools.getByRole('button', { name: 'Save page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('A human addition to an old entry.'));
    const savedLegacy = await (await page.request.get(`${url}/wiki/page/${legacyId}/data`)).json();
    assert.deepEqual(savedLegacy.annotations.map(a => a.id), legacyData.annotations.map(a => a.id));
    assert.equal(savedLegacy.body, legacyData.body.replace(/\r\n/g, '\n') + '\n\nA human addition to an old entry.');
    await page.locator('[data-wiki-search]').fill('Legacy human');
    await page.locator('.wiki-page-list .wiki-link').getByText('Legacy human', { exact: true }).click();
    await page.locator('[data-wiki-search]').fill('');
    const legacyHumanId = await page.locator('.wiki-link[aria-current="true"]').getAttribute('data-wiki-page-id');
    await current.getByRole('button', { name: 'Edit page', exact: true }).click();
    await Promise.all([
      page.waitForURL(next => next.searchParams.get('wiki_page') === legacyHumanId),
      tools.getByRole('button', { name: 'Save page', exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent === 'Human first.Human second.');
    const sourceGeometry = await page.evaluate(async () => {
      const { attachWikiAuthorship } = await import("/static/wiki-authorship.js");
      const form = document.createElement("form"); form.className = "wiki-page-editor wiki-authorship-qa";
      Object.assign(form.style, { position: "fixed", top: "100px", left: "100px", width: "350px", zIndex: "999" });
      const textarea = document.createElement("textarea"); textarea.rows = 5;
      const first = "😀 Long AI paragraph with wrapped lines. ".repeat(45), second = "Second AI paragraph.";
      const body = `${first}\n\n${second}`; textarea.value = body; form.append(textarea); document.body.append(form);
      const record = (start, quote) => ({ kind: "ai_text", start, end: start + Array.from(quote).length, quote });
      const tracker = attachWikiAuthorship(textarea, { body, annotations: [record(0, first), record(Array.from(first).length + 2, second)] }, form);
      const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      tracker.refresh(); await frames();
      const wide = form.querySelector(".wiki-source-ai-box").getBoundingClientRect().height;
      textarea.scrollTop = textarea.clientHeight * 2; textarea.dispatchEvent(new Event('scroll')); await frames();
      const source = form.querySelector('.wiki-block-source');
      const bounds = source.getBoundingClientRect(), area = textarea.getBoundingClientRect();
      const sourceVisible = bounds.top >= area.top && bounds.bottom <= area.bottom
        && bounds.right <= area.left + textarea.clientWidth
        && document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) === source;
      if (sourceVisible) {
        source.click();
        document.querySelector('dialog[aria-label="AI source"] button[aria-label="Close AI source"]').click();
      }
      textarea.scrollTop = textarea.scrollHeight; textarea.dispatchEvent(new Event("scroll")); await frames();
      const scroll = textarea.scrollTop, transform = form.querySelector(".wiki-authorship-mirror").style.transform;
      form.style.width = "220px"; await frames(); await frames();
      const narrow = form.querySelector(".wiki-source-ai-box").getBoundingClientRect().height;
      const nativeValue = textarea.value;
      textarea.scrollTop = textarea.clientHeight * 2; textarea.dispatchEvent(new Event('scroll')); await frames();
      window.wikiSourceQACleanup = () => { tracker.destroy(); form.remove(); };
      return { wide, narrow, scroll, transform, sourceVisible, unchanged: nativeValue === body };
    });
    assert(sourceGeometry.scroll > 0, "Long AI paragraphs retain native textarea scrolling");
    assert(sourceGeometry.sourceVisible, 'AI source remains visible and clickable while scrolling inside a long AI paragraph');
    assert(sourceGeometry.transform.includes(`-${sourceGeometry.scroll}px`), "Source colours and labels scroll with the caret's native text");
    assert(sourceGeometry.narrow > sourceGeometry.wide, "AI outlines reflow when the wiki editor becomes narrower");
    assert(sourceGeometry.unchanged, "Source display and resize never mutate wiki text");
    await fs.mkdir('agent_docs/ui-review-followup', { recursive: true });
    await page.screenshot({ path: 'agent_docs/ui-review-followup/wiki-source-scrolled.png' });
    await page.evaluate(() => { window.wikiSourceQACleanup(); delete window.wikiSourceQACleanup; });
    assert.deepEqual(errors, []);
    console.log("PASS: wiki generation/refresh, protected paragraph insertion, delegated refresh/correction, truthful failures, paragraph adoption/Return, AI maintenance/revocation, legacy CRLF migration, source labels/themes, scrolling/reflow, cancellation, save retry and revisions.");
  } finally {
    await browser.close(); await new Promise(resolve => llm.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
