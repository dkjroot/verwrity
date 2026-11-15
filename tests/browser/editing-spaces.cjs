/* Pasted Unicode spacing and dialogue follow the same indentation rules. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
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
    const viewMenu = page.locator(".view-menu");
    await viewMenu.evaluate(el => { el.open = true; });
    await page.locator("[data-view-mode]").selectOption("pages");
    const pagedSource = Array.from({ length: 96 }, (_, i) =>
      ["\t", "    ", "\u2003", ""][i % 4] + `Start ${i} ${"some words ".repeat(i % 11)}`
    ).join("\n\n");
    const typedIndent = "Start 36 ";
    await setText(pagedSource.replace(`\t${typedIndent}`, typedIndent));
    await page.waitForFunction(() => document.querySelectorAll(".rm-page-break").length > 2);
    const offset = pagedSource.indexOf(typedIndent) - 1;
    await page.locator(".ProseMirror").focus();
    await page.evaluate(start => window.verwrityEditor.selectSourceRange(start, start + 1), offset);
    await page.evaluate(() => document.getSelection().collapseToStart());
    await page.waitForFunction(start => window.verwrityEditor.getCaretOffset() === start
      && !window.verwrityEditor.getSelectedRange(), offset);
    await page.keyboard.press("Tab");
    assert.equal(await read(), pagedSource, "Tab inserts the indent at the start of the paragraph");
    const splitIndents = await page.locator('p[data-paragraph-kind="running"]').evaluateAll(paragraphs =>
      paragraphs.flatMap(paragraph => {
        const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
        const first = text.data.indexOf("S");
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, first);
        const indentation = range.getBoundingClientRect();
        range.setStart(text, first);
        range.setEnd(text, first + 1);
        const letter = range.getBoundingClientRect();
        return Math.abs(indentation.top - letter.top) > 1 ? [paragraph.textContent.trim()] : [];
      })
    );
    assert.deepEqual(splitIndents, [], "page breaks keep the indent on the same line as the start of the paragraph");
    assert.equal(await read(), pagedSource, "pagination preserves the typed indentation");
    await page.locator("[data-view-mode]").selectOption("continuous");
    const paragraphs = [
      '\u00a0 \u00a0 Narration with\u00a0a non-breaking space.',
      '\u00a0 \u00a0 "The sign says residents only," said the child.',
      '\u2003“Leave that to me,” said the parent.',
      '\u202f\t‘Very well.’',
      'Fresh narration.\nA soft line break\u2009stays here.',
      '"Fresh dialogue." Cold as ice.',
    ];
    const source = paragraphs.join("\n\n");
    await setText(source);
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
    await page.keyboard.press("ControlOrMeta+z");
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
    await page.keyboard.press("ControlOrMeta+z");
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
    await page.keyboard.press("ControlOrMeta+z");
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
    console.log("PASS: page-top and Unicode indentation, section marks, hiding, normalization, undo, plain/HTML paste and save/reload.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
