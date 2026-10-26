/* Every overlapping annotation contributes to the native tooltip, without editing prose. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.request.post(`${url}/preferences/annotations/spelling`, { data: { enabled: false } });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));

    const text = "😀 The quik fox.\n\nAnother quik fox.";
    const configure = async (mode = "exact", wikiHighlight = false) => page.evaluate(({ text, mode, wikiHighlight }) => {
      const editor = window.verwrityEditor;
      editor.setText(text);
      editor.setAnnotationOptions("spelling", { enabled: true, color: "#ef4444", style: "squiggly" });
      editor.setAnnotationOptions("comments", { enabled: true });
      editor.setAnnotationOptions("wiki_links", { enabled: wikiHighlight });
      const offset = quote => Array.from(text.slice(0, text.indexOf(quote))).length;
      const range = quote => ({ start: offset(quote), end: offset(quote) + Array.from(quote).length, quote });
      editor.setAnnotations([{ id: "spelling-quik", ...range("quik"), word: "quik", suggestions: ["quick"] }]);
      editor.setWikiPages([{ id: "wiki-quik", title: "Quick creature", aliases: [mode === "exact" ? "quik" : "quik fox"] }]);
      const quote = mode === "exact" ? "quik" : mode === "nested" ? "The quik fox." : "ik fox";
      editor.setComments([{ id: "comment-quik", ...range(quote), body: "Check the creature name.", resolved: false }]);
      editor.setTextAnalysis("usage", { enabled: true, name: "Usage Detector", color: "#0891b2", style: "highlight",
        items: [{ id: "usage-quik", ...range("quik"), explanation: "Check this word's meaning." }] });
      editor.setTextAnalysis("custom", { enabled: true, name: "Custom review", color: "#8b5cf6", style: "underline",
        items: [{ id: "custom-quik", ...range("quik"), explanation: "Check the intended voice." }] });
    }, { text, mode, wikiHighlight });
    const fragments = async () => page.locator(".ProseMirror").evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const result = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        result.push({ text: node.textContent, title: node.parentElement.closest("[title]")?.title || "" });
      }
      return result;
    });
    const titleFor = async quote => (await fragments()).find(fragment => fragment.text === quote)?.title;
    const allFeedback = title => {
      assert.match(title, /quik: Suggestions: quick/);
      assert.match(title, /Open wiki page: Quick creature/);
      assert.match(title, /Check the creature name/);
      assert.match(title, /Usage Detector: Check this word's meaning/);
      assert.match(title, /Custom review: Check the intended voice/);
    };

    await configure();
    allFeedback(await titleFor("quik"));
    assert.equal(await page.locator(".verwrity-spelling-error").getAttribute("data-verwrity-spelling-word"), "quik",
      "the whole spelling word survives alongside wiki, comments and analyses");
    assert.equal(await page.locator(".verwrity-spelling-error").evaluate(element =>
      getComputedStyle(element).getPropertyValue("--annotation-color").trim()), "#ef4444",
      "combining tooltips preserves the original annotation colour precedence");
    assert.equal(await page.locator(".verwrity-comment").getAttribute("data-verwrity-comment-id"), "comment-quik");
    const lastLink = page.locator(".verwrity-wiki-link").last();
    assert.equal(await lastLink.getAttribute("title"), "Open wiki page: Quick creature", "feedback does not leak into repeated text");
    await configure("exact", true);
    allFeedback(await titleFor("quik"));
    await configure();
    allFeedback(await titleFor("quik"));

    await configure("nested");
    allFeedback(await titleFor("quik"));
    assert.equal(await titleFor("The "), "The quik fox.\nCheck the creature name.");
    assert.doesNotMatch(await titleFor(" fox"), /Suggestions:|Usage Detector|Custom review/, "nested feedback ends at its own boundary");

    await configure("partial");
    allFeedback(await titleFor("ik"));
    assert.doesNotMatch(await titleFor("qu"), /Check the creature name/, "partial comment starts inside the word");
    assert.doesNotMatch(await titleFor(" fox"), /Suggestions:|Usage Detector|Custom review/);
    await page.evaluate(() => window.verwrityEditor.setWikiPages([]));
    await page.locator(".verwrity-spelling-error").filter({ hasText: /^ik$/ }).click();
    assert.equal(await page.locator('.project-words-dialog').count(), 0,
      "ordinary spelling clicks leave the author in the manuscript");
    await page.locator(".verwrity-spelling-error").filter({ hasText: /^ik$/ }).click({ button: "right" });
    await page.locator('[data-word-dictionary]').click();
    await page.locator(".project-words-dialog").waitFor();
    await page.locator("[data-words-close]").click();

    await configure();
    await page.evaluate(() => window.verwrityEditor.setAnnotationOptions("spelling", { enabled: false }));
    assert.doesNotMatch(await titleFor("quik"), /Suggestions:/);
    for (const feedback of [/Open wiki page:/, /Usage Detector:/, /Custom review:/, /Check the creature name/]) {
      assert.match(await titleFor("quik"), feedback);
    }
    await page.evaluate(() => window.verwrityEditor.setAnnotationOptions("comments", { enabled: false }));
    assert.doesNotMatch(await titleFor("quik"), /Check the creature name/);
    await page.evaluate(() => window.verwrityEditor.setTextAnalysis("usage", { enabled: false }));
    assert.doesNotMatch(await titleFor("quik"), /Usage Detector:/);
    assert.match(await titleFor("quik"), /Custom review:/);
    await page.evaluate(() => {
      window.verwrityEditor.setTextAnalysis("custom", { enabled: false });
      window.verwrityEditor.setWikiPages([]);
    });
    assert((await fragments()).every(fragment => !fragment.title), "clearing the last annotations removes their tooltips");
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text, "annotation operations preserve exact prose");
    assert.deepEqual(errors, []);
    console.log("PASS: spelling, wiki, comment and analysis tooltips combine across exact, nested and partial overlaps.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
