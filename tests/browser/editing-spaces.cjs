/* Pasted Unicode spacing and dialogue follow the same indentation rules. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    const editMenu = () => page.locator(".editing-menu").evaluate(element => { element.open = true; });
    const read = () => page.evaluate(() => window.verwrityEditor.getText());
    const setText = text => page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new Event("verwrity-editor-change"));
    }, text);
    const paragraphs = [
      '\u00a0 \u00a0 Narration with\u00a0a non-breaking space.',
      '\u00a0 \u00a0 "The sign says residents only," said the child.',
      '\u2003“Leave that to me,” said the parent.',
      '\u202f\t‘Very well.’',
      'Fresh narration.\nA soft line break\u2009stays here.',
      '"Fresh dialogue." Cold as ice.',
    ];
    const source = paragraphs.join("\n\n");
    await setText(source); await page.locator(".view-menu").evaluate(el => { el.open = true; });
    await page.locator("[data-section-markers]").check();
    assert.equal(await page.locator('p[data-paragraph-kind="running"]').count(), 4,
      "Unicode indentation identifies running narration and straight/curly-quoted dialogue alike");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 2);
    await page.locator("[data-paragraph-indentation]").uncheck();
    assert.equal(await page.locator(".verwrity-hidden-indent").count(), 4);
    const hiddenIndents = await page.locator(".verwrity-hidden-indent").evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, width: node.getBoundingClientRect().width, fontSize: getComputedStyle(node).fontSize,
    })));
    assert(hiddenIndents.every(indent => indent.width < .1),
      `hidden Unicode indentation consumes no visible width: ${JSON.stringify(hiddenIndents)}`);
    assert.equal(await read(), source, "loading and display preferences preserve the original manuscript");
    const dialogueStart = source.indexOf('"The sign');
    await page.evaluate(start => window.verwrityEditor.selectSourceRange(start, start + 8), dialogueStart);
    await editMenu();
    await page.locator('[data-mark-paragraph="section"]').click();
    assert.equal(await read(), paragraphs.map((p, i) => i === 1 ? p.replace(/^[\t\p{Zs}]+/u, "") : p).join("\n\n"),
      "marking dialogue fresh removes every leading typographic space and no other text");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 3);
    await page.keyboard.press("Control+z");
    assert.equal(await read(), source, "undo restores the exact original spacing");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 2);
    await page.evaluate(() => {
      const editor = window.verwrityEditor, text = editor.getText(), start = text.indexOf("Cold as ice");
      editor.setTextAnalysis("cliche", { enabled: true, name: "Cliché Detector", items: [
        { id: "untouched", start, end: start + 11, quote: "Cold as ice", explanation: "Synthetic review." },
      ] });
    });
    await editMenu(); await page.locator("[data-normalize-spaces]").click();
    const normalized = source.replace(/\p{Zs}/gu, " ");
    assert.equal(await read(), normalized, "cleanup converts every horizontal space one for one, retaining tabs and hard/paragraph breaks");
    assert.equal(await page.locator(".verwrity-text-analysis-cliche").textContent(), "Cold as ice",
      "normalization maps untouched analysis findings instead of replacing the whole document");
    await editMenu(); await page.locator("[data-normalize-spaces]").click();
    assert.match(await page.locator("[data-editing-format-status]").textContent(), /^0 typographic spaces/);
    await page.keyboard.press("Control+z");
    assert.equal(await read(), source, "normalization is one undo action; a no-op cleanup does not consume undo");

    const paste = async (plain, html) => {
      // Load a clean empty fixture so undo cannot group the test-only setText
      // setup with the real paste transaction.
      await setText("");
      assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
      await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
      await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
      await page.locator(".ProseMirror").focus();
      await page.evaluate(({ plain, html }) => {
        const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", plain);
        if (html) clipboardData.setData("text/html", html);
        document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
      }, { plain, html });
    };
    const plain = '\u00a0\t"Plain\u2003words."\n\nNarration\u202fcontinues.';
    await paste(plain);
    assert.equal(await read(), plain.replace(/\p{Zs}/gu, " "), "plain-text paste normalizes unusual spaces without collapsing indentation");
    await page.keyboard.press("Control+z");
    assert.equal(await read(), "", "paste normalization stays within normal paste undo");
    await paste('Rich clipboard fallback.', '<p>&nbsp; “Rich&nbsp;dialogue.”</p><p>Next&#x2003;line.<br>Soft&#x202f;break.</p>');
    assert.equal(await read(), '  “Rich dialogue.”\n\nNext line.\nSoft break.', "rich HTML paste also normalizes spaces while retaining paragraph and soft line breaks");
    assert.equal(await page.locator("p.verwrity-section-start").count(), 1, "pasted indented dialogue has no false section marker");
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    const pasted = await read();
    await page.reload(); await page.waitForFunction(() => window.verwrityEditor);
    assert.equal(await read(), pasted, "normalized source survives save/reload");
    await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close()));
    const readonly = '\u00a0"Historical dialogue."';
    await page.evaluate(text => window.verwrityEditor.setText(text, [], false), readonly);
    await editMenu(); await page.locator("[data-normalize-spaces]").click();
    assert.equal(await read(), readonly, "cleanup cannot edit a historical/read-only document");
    assert.deepEqual(errors, []);
    console.log("PASS: Unicode dialogue/narration indentation, section marks, hiding, explicit normalization, undo, retained findings, plain/HTML paste and save/reload safety.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
