/* Run against `python -m tests.browser.serve`, which uses a temporary library. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const stage = document.querySelector('.editor-stage');
    if (stage.dataset.layout !== 'single') return true;
    const pm = stage.querySelector('.ProseMirror');
    const breaks = [...pm.querySelectorAll('.breaker')];
    return breaks.length && pm.lastElementChild.getBoundingClientRect().bottom <= breaks.at(-1).getBoundingClientRect().bottom + 1;
  }, null, { timeout: 5000 });
}

async function geometry(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector("[data-editor-viewport]");
    const stage = document.querySelector("[data-editor-stage]");
    const pm = document.querySelector(".ProseMirror");
    const style = getComputedStyle(viewport);
    const paperWidth = parseFloat(stage.style.getPropertyValue("--paper-width"));
    const paperHeight = parseFloat(stage.style.getPropertyValue("--paper-height"));
    return {
      width: viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: viewport.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      overflow: viewport.scrollWidth - viewport.clientWidth,
      stageWidth: stage.getBoundingClientRect().width,
      stageHeight: stage.getBoundingClientRect().height,
      paperWidth, paperHeight,
      paperGap: parseFloat(stage.style.getPropertyValue('--paper-gap')),
      paperBottom: parseFloat(stage.style.getPropertyValue('--paper-bottom')),
      pmWidth: pm.getBoundingClientRect().width,
      pmHeight: pm.getBoundingClientRect().height,
      stageScroll: stage.scrollLeft,
      viewportScroll: viewport.scrollTop,
      verticalOverflow: viewport.scrollHeight - viewport.clientHeight,
      pages: document.querySelectorAll(".rm-page-break").length,
      firstPageHeight: pm.querySelector('.rm-pagination-gap')?.getBoundingClientRect().top - pm.getBoundingClientRect().top,
      text: window.verwrityEditor.getText(),
    };
  });
}

async function spreadCells(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.editor-stage');
    const bounds = stage.getBoundingClientRect();
    const height = parseFloat(stage.style.getPropertyValue('--paper-height'));
    const width = parseFloat(stage.style.getPropertyValue('--paper-width'));
    const gap = parseFloat(stage.style.getPropertyValue('--paper-gap'));
    const margin = parseFloat(stage.style.getPropertyValue('--paper-top'));
    const lineHeight = parseFloat(stage.style.getPropertyValue('--editor-line-height'));
    const cells = new Map();
    for (const paragraph of stage.querySelectorAll('.ProseMirror p')) {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      for (const rect of range.getClientRects()) {
        if (rect.width < 20 || rect.height === 0) continue;
        const row = Math.floor((rect.top - bounds.top) / (height + gap));
        const column = Math.floor((rect.left - bounds.left) / (width + gap));
        // Use a line away from the page boundaries so arrow/Return tests have room.
        if (rect.top - bounds.top - row * (height + gap) < margin + 4 * lineHeight) continue;
        const key = `${row}:${column}`;
        if (!cells.has(key)) cells.set(key, {
          row,
          column,
          // Click well inside a text line. Clicking at the left edge can place
          // the caret at a paragraph boundary, making ArrowLeft legitimately
          // cross into the preceding page rather than testing page retention.
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      }
    }
    return [...cells.values()];
  });
}

async function clickSpreadCell(page, row, column) {
  // Finish the previous edit/undo's deferred caret scroll before measuring
  // the next click. Otherwise its old page can move underneath the mouse.
  await settle(page);
  const view = await geometry(page);
  await page.locator('.editor-viewport').evaluate((viewport, top) => { viewport.scrollTop = top; }, row * (view.paperHeight + view.paperGap));
  await settle(page);
  const cell = (await spreadCells(page)).find(cell => cell.row === row && cell.column === column);
  assert(cell, `Page ${row * 2 + column + 1} has editable text`);
  await page.mouse.click(cell.x, cell.y);
  assert.deepEqual(await caretCell(page), { row, column }, "the test click reaches the requested spread page");
}

async function caretCell(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('.editor-stage');
    const bounds = stage.getBoundingClientRect();
    const cursor = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const height = parseFloat(stage.style.getPropertyValue('--paper-height'));
    const width = parseFloat(stage.style.getPropertyValue('--paper-width'));
    const gap = parseFloat(stage.style.getPropertyValue('--paper-gap'));
    return { row: Math.floor((cursor.top - bounds.top) / (height + gap)), column: Math.floor((cursor.left - bounds.left) / (width + gap)) };
  });
}

async function assertWorkspaceUi(page, width) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const visibleComponents = [
    "#storyboard-panel", ".storyboard-heading", ".manuscript", ".panel-heading",
    ".editor-toolbar", ".editor-viewport", ".ProseMirror", ".text-overview",
    "[data-text-overview-map]", "#wiki-panel", ".wiki-heading", "[data-wiki-search]", "[data-save-status]",
  ];
  for (const selector of visibleComponents) {
    assert(await page.locator(selector).first().isVisible(), `${width}px workspace keeps ${selector} visible`);
  }
  assert.equal(await page.locator("details.editor-menu").count(), 6, `${width}px workspace keeps all editor, editing and revision menus mounted`);
  for (const selector of ["[data-view-mode]", "[data-page-size]", "[data-page-layout]", "[data-writing-count-status]", "[data-manuscript-setting='font_family']", "[data-manuscript-setting='font_size']", "[data-manuscript-setting='text_color']", "[data-manuscript-setting='background_color']", "[data-annotation-toggle='wiki_links']"]) {
    assert.equal(await page.locator(selector).count(), 1, `${width}px workspace keeps ${selector} available`);
  }
  const overview = await page.evaluate(() => ({
    width: document.querySelector("[data-text-overview]").getBoundingClientRect().width,
    height: document.querySelector("[data-text-overview]").getBoundingClientRect().height,
    lines: document.querySelectorAll(".text-overview-line").length,
  }));
  assert(overview.width > 0 && overview.height > 0 && overview.lines > 0, `${width}px text shape graph remains visible: ${JSON.stringify(overview)}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated, "Run against the isolated test server");
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector(".editor-stage")?.style.getPropertyValue("--view-width"));
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    // Exercise pagination, caret movement and text-map navigation with the
    // optional margin glyphs visible, including paragraphs spanning pages.
    await page.locator(".view-menu").evaluate(element => { element.open = true; });
    await page.locator("[data-section-markers]").check();
    await page.locator(".view-menu").evaluate(element => { element.open = false; });
    await page.locator("details.view-menu > summary").click();
    const original = (await geometry(page)).text;
    assert(original.length > 10000, "Use the synthetic multi-page browser-test manuscript");
    const overviewShape = await page.evaluate(() => ({
      paragraphs: document.querySelectorAll('.ProseMirror p').length,
      lines: document.querySelectorAll('.text-overview-line').length,
    }));
    assert(overviewShape.lines > overviewShape.paragraphs, `Text map should show wrapped lines: ${JSON.stringify(overviewShape)}`);
    const visibleOverviewLine = await page.evaluate(() => {
      const map = document.querySelector('.text-overview-map').getBoundingClientRect();
      const lines = [...document.querySelectorAll('.text-overview-line')];
      const index = lines.findLastIndex(line => {
        const rect = line.getBoundingClientRect();
        return rect.height > 0 && rect.top >= map.top && rect.bottom <= map.bottom;
      });
      return { index, paragraphIndex: Number(lines[index]?.dataset.paragraphIndex) };
    });
    assert(visibleOverviewLine.index >= 0, 'The text map has a visible passage marker');
    await page.evaluate(() => {
      window.__overviewClick = null;
      document.querySelector('.text-overview-map').addEventListener('click', event => {
        window.__overviewClick = { target: event.target.className, paragraphIndex: event.target.dataset.paragraphIndex };
      }, { capture: true, once: true });
    });
    const targetParagraph = await page.locator('.ProseMirror p').nth(visibleOverviewLine.paragraphIndex).innerText();
    await page.locator('.text-overview-line').nth(visibleOverviewLine.index).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
    const locatedParagraph = await page.evaluate(() => {
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
      return { text: element?.closest('p')?.textContent || '', node: anchor?.nodeName, element: element?.tagName,
        active: document.activeElement?.tagName, activeClass: document.activeElement?.className,
        scrollTop: document.querySelector('.editor-viewport').scrollTop };
    });
    assert.equal(locatedParagraph.text, targetParagraph, `Clicking the text-map marker locates its manuscript paragraph: ${JSON.stringify({ locatedParagraph, targetParagraph: visibleOverviewLine.paragraphIndex, click: await page.evaluate(() => window.__overviewClick) })}`);
    assert.equal((await geometry(page)).text, original, 'Text map navigation does not alter manuscript content');
    await page.locator('.editor-viewport').evaluate(viewport => { viewport.scrollTop = 0; });
    await settle(page);
    await page.locator("details.view-menu > summary").click();
    await assertWorkspaceUi(page, 1440);
    await page.setViewportSize({ width: 3840, height: 2160 });
    await assertWorkspaceUi(page, 3840);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.locator('[data-previous-spread], [data-next-spread]').count(), 0, 'Spreads use scrolling, not navigation buttons');

    let combinations = 0;
    for (const width of [1440, 900, 600]) {
      await page.setViewportSize({ width, height: 1000 });
      await assertWorkspaceUi(page, width);
      await page.selectOption("select[data-view-mode]", "pages");
      for (const layout of ["single", "spread"]) {
        await page.selectOption("select[data-page-layout]", layout);
        for (const [size, ratio] of Object.entries({ a4: 794 / 1123, letter: 816 / 1056, "six-nine": 2 / 3, "five-five-eight-five": 528 / 816 })) {
          await page.selectOption("select[data-page-size]", size);
          for (const fit of ["width", "height"]) {
            await page.click(`[data-fit-view="${fit}"]`);
            try { await settle(page); } catch (error) {
              const view = await geometry(page);
              console.error({ width, layout, size, fit, view: { ...view, text: view.text.length } });
              throw error;
            }
            const view = await geometry(page);
            assert(view.overflow <= 1, `${width}/${layout}/${size}/${fit}: horizontal overflow ${view.overflow}`);
            assert(view.stageWidth <= view.width, "Paper must stay inside the viewport");
            assert(Math.abs(view.paperWidth / view.paperHeight - ratio) < .001, "Paper aspect ratio");
            if (fit === "width") assert(Math.abs(view.stageWidth - view.width) <= 2, "Fit width fills usable width");
            if (fit === "height") assert(view.paperHeight <= view.height + 1, "Fit height shows a full page");
            if (layout === "single") {
              assert(Math.abs(view.pmWidth - view.paperWidth) < 1, "Editable paper has the chosen width");
              assert(view.pages > 2, "Long text flows across pages");
              assert(Math.abs(view.firstPageHeight - view.paperHeight) < 1, `Actual page boundary matches the selected paper height: ${JSON.stringify({ firstPageHeight: view.firstPageHeight, paperHeight: view.paperHeight, width, size, fit })}`);
              assert.deepEqual(
                (await page.locator('.rm-page-break .rm-page-footer .rm-page-number').allTextContents()).slice(0, 3).map(text => text.trim()),
                ['1', '2', '3'],
                'Single-page footers show sequential numbers',
              );
            } else {
              await page.waitForFunction(() => document.querySelectorAll('.spread-page-numbers span').length >= 6);
              const labels = await page.locator('.spread-page-numbers span').allTextContents();
              assert.deepEqual(labels.slice(0, 6).map(text => text.split('/')[0].trim()), ['1', '2', '3', '4', '5', '6'], 'Spread pages show sequential numbers');
              const labelPositions = await page.evaluate(() => {
                const stage = document.querySelector('.editor-stage');
                const stageRect = stage.getBoundingClientRect();
                return [...document.querySelectorAll('.spread-page-numbers span')].slice(0, 6).map(label => {
                  const rect = label.getBoundingClientRect();
                  return { x: rect.left + rect.width / 2 - stageRect.left, y: rect.top + rect.height / 2 - stageRect.top };
                });
              });
              for (let index = 0; index < labelPositions.length; index++) {
                const row = Math.floor(index / 2);
                const column = index % 2;
                assert(Math.abs(labelPositions[index].x - (column * (view.paperWidth + view.paperGap) + view.paperWidth / 2)) < 2, 'Number is centred on its spread page');
                assert(Math.abs(labelPositions[index].y - (row * (view.paperHeight + view.paperGap) + view.paperHeight - view.paperBottom / 2)) < 2, 'Number is in its page footer');
              }
              assert.equal(view.stageScroll, 0, 'No horizontal page navigation');
              assert(view.verticalOverflow > view.paperHeight, 'Later pairs extend downwards');
              const cells = await spreadCells(page);
              for (const row of [0, 1, 2]) {
                for (const column of [0, 1]) assert(cells.some(cell => cell.row === row && cell.column === column), `Text flows onto row ${row}, column ${column}`);
              }
              await page.locator('.editor-viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
              assert((await geometry(page)).viewportScroll > view.paperHeight, 'All later rows are reachable by scrolling');
              await page.locator('.editor-viewport').evaluate(viewport => { viewport.scrollTop = 0; });
            }
            assert.equal(view.text, original, "View settings must never alter manuscript content");
            combinations++;
          }
        }
      }
    }

    await page.locator("details.view-menu > summary").click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click("[data-theme-toggle]");
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    // Regression: typing, arrows and Return on pages 4–6 must not jump to an earlier pair.
    for (const [row, column] of [[1, 1], [2, 0], [2, 1]]) {
      await clickSpreadCell(page, row, column);
      const before = (await geometry(page)).text;
      await page.keyboard.type('LATER_PAGE ');
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Enter']) {
        await page.keyboard.press(key);
        await settle(page);
        assert.deepEqual(await caretCell(page), { row, column }, `${key} keeps the caret on the page being edited`);
      }
      await page.keyboard.type('AFTER_RETURN ');
      assert.deepEqual(await caretCell(page), { row, column }, 'Typing after Return stays on the same page');
      for (let undo = 0; undo < 4 && (await geometry(page)).text !== before; undo++) await page.keyboard.press('Control+z');
      assert.equal((await geometry(page)).text, before, 'Undo restores the page edits');
    }
    await clickSpreadCell(page, 1, 1);
    await page.keyboard.type("PAGE_EDIT ");
    const edited = await page.evaluate(() => window.verwrityEditor.getText());
    assert(edited.includes("PAGE_EDIT "), "Editing an overflow column updates the manuscript");
    await page.locator("details.view-menu > summary").click();
    await page.selectOption("select[data-view-mode]", "continuous");
    await settle(page);
    assert.equal(await page.locator('.spread-page-numbers span').count(), 0, 'Continuous view has no page labels');
    assert.equal((await geometry(page)).text, edited);
    assert.equal((await geometry(page)).overflow, 0);
    // View changes must not interrupt the editor's undo history.
    await page.evaluate(() => window.verwrityEditor.focus());
    await page.locator('.ProseMirror').focus();
    await settle(page);
    await page.keyboard.press("Control+z");
    assert.equal((await geometry(page)).text, original);

    // Test the last page and keyboard caret following on a short viewport.
    await page.setViewportSize({ width: 1440, height: 650 });
    await page.selectOption("select[data-view-mode]", "pages");
    await page.click('[data-fit-view="width"]');
    await page.evaluate(() => window.verwrityEditor.focus());
    await page.locator('.ProseMirror').focus();
    await settle(page);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" THE_END");
    await settle(page);
    assert((await geometry(page)).viewportScroll > 0, 'Caret scrolls vertically to the final spread');
    assert.equal((await geometry(page)).stageScroll, 0);
    assert((await geometry(page)).text.endsWith(" THE_END"));
    const caretVisible = await page.evaluate(() => {
      const selection = window.getSelection();
      const cursor = selection.getRangeAt(0).getBoundingClientRect();
      const viewport = document.querySelector('.editor-viewport').getBoundingClientRect();
      const vp = document.querySelector('.editor-viewport');
      return { visible: cursor.top >= viewport.top && cursor.bottom <= viewport.bottom, cursor: cursor.toJSON(), viewport: viewport.toJSON(), scrollTop: vp.scrollTop, scrollHeight: vp.scrollHeight, stage: document.querySelector('.editor-stage').getBoundingClientRect().toJSON(), pm: document.querySelector('.ProseMirror').getBoundingClientRect().toJSON() };
    });
    assert(caretVisible.visible, `Caret remains visible when paper is taller than the viewport: ${JSON.stringify(caretVisible)}`);
    const savedText = (await geometry(page)).text;
    const savedTitle = `Browser pagination regression ${Date.now()}`;
    await page.click('[data-file-operations]');
    await page.fill('#project-title', savedTitle);
    await page.click('#save-project-form button[type="submit"]');
    await page.waitForFunction(title => document.querySelector('.project-name')?.textContent === title, savedTitle);
    await page.waitForFunction(() => document.querySelector('.editor-stage')?.style.getPropertyValue('--view-width'));
    assert.equal((await geometry(page)).text, savedText, "Save/reload preserves edits made in spread view");
    assert.equal(await page.inputValue('select[data-page-layout]'), 'spread', 'Saved view preference survives navigation');
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.click('[data-file-operations]');
    await page.selectOption('#project-library', `${savedTitle}.verwrity.zip`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.click('#file-dialog form[action$="/library-open"] button'),
    ]);
    await page.waitForFunction(() => document.querySelector('.editor-stage')?.style.getPropertyValue('--view-width'));
    assert.equal((await geometry(page)).text, savedText, 'Opening the saved ZIP preserves spread edits');

    // Preferences survive reload; obsolete values recover to valid defaults.
    await page.addInitScript(() => localStorage.setItem("verwrity-writing-view", JSON.stringify({ mode: "pages", size: "obsolete", layout: "unknown", fit: "broken" })));
    page.on("dialog", dialog => dialog.accept());
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".editor-stage")?.style.getPropertyValue("--view-width"));
    assert.equal(await page.inputValue("select[data-page-size]"), "a4");
    assert.equal(await page.inputValue("select[data-page-layout]"), "single");
    assert.equal((await geometry(page)).text, savedText);

    // An empty scene still displays one editable sheet, without stale overflow.
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.click('[data-add-scene]');
    await page.fill('#scene-title', 'Empty scene');
    await page.click('#add-scene-dialog button[type="submit"]');
    await page.waitForFunction(() => window.verwrityEditor && window.verwrityEditor.getText() === '');
    await page.locator("details.view-menu > summary").click();
    await page.selectOption('select[data-view-mode]', 'pages');
    await page.selectOption('select[data-page-layout]', 'spread');
    await settle(page);
    assert(Math.abs((await geometry(page)).stageHeight - (await geometry(page)).paperHeight) < 1, 'Empty scene has one complete pair of sheets');
    assert.equal((await geometry(page)).overflow, 0);

    const fallback = await browser.newPage();
    fallback.on('pageerror', error => errors.push(error.message));
    await fallback.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === 'column-wrap' ? false : supports(...args);
      localStorage.setItem('verwrity-writing-view', JSON.stringify({ mode: 'pages', size: 'a4', layout: 'spread', fit: 'width' }));
    });
    await fallback.goto(url);
    await fallback.waitForFunction(() => document.querySelector('.editor-stage')?.style.getPropertyValue('--view-width'));
    await fallback.evaluate(() => document.querySelector('#start-dialog')?.close());
    await settle(fallback);
    assert.equal(await fallback.inputValue('select[data-page-layout]'), 'single');
    assert(await fallback.locator('option[value="spread"]').evaluate(option => option.disabled), 'Unsupported spread option is disabled');
    assert(await fallback.locator('[data-spread-unavailable]').isVisible());
    assert.equal((await geometry(fallback)).overflow, 0, 'Unsupported browsers retain usable vertical pagination');
    await fallback.close();
    assert.deepEqual(errors, [], "No browser exceptions");
    console.log(`PASS: ${combinations} view combinations; stacked spreads, typing/Return/arrows on pages 4–6, undo, caret scrolling, save/reload, empty scenes, themes, preferences, and browser fallback.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
