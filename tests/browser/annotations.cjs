/* Focused spelling range and restored preference regression check. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const expected = ['faler', 'bundsk', 'solk', 'Folzen', 'rendak', 'beenik', 'Leavet'];
const markedWords = page => page.locator('.verwrity-spelling-error').allTextContents();

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    let spellingCalls = 0;
    page.on('request', request => { if (request.url().includes('/spell-check')) spellingCalls += 1; });
    await page.request.post(`${url}/__browser_test__/reset`);
    const resetSpelling = await page.request.post(`${url}/preferences/annotations/spelling`, { data: { enabled: false } });
    assert.equal(resetSpelling.status(), 200, 'Start from a known spelling preference');
    await page.goto(url);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());

    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('The faler was a bundsk solk.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Folzen rendak beenik and sorry. Leavet.');

    await page.locator('details.analysis-menu > summary').click();
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/preferences/annotations/spelling') && response.status() === 200),
      page.locator('[data-annotation-toggle="spelling"]').click(),
    ]);
    await page.waitForFunction(count => document.querySelectorAll('.verwrity-spelling-error').length === count, expected.length);
    assert.deepEqual(await markedWords(page), expected, 'spelling ranges match every word across blank paragraphs');

    await page.locator('.verwrity-spelling-error').first().click();
    assert.equal(await page.locator('.project-words-dialog').count(), 0, 'ordinary clicks keep the caret in the manuscript');
    await page.locator('.verwrity-spelling-error').first().click({ button: 'right' });
    await page.locator('[data-word-dictionary]').click();
    const dictionary = page.locator('.project-words-dialog');
    await dictionary.locator('[data-words-edit]').click();
    await dictionary.locator('[data-words-project]').fill(expected[0]);
    await dictionary.locator('[data-words-use]').click();
    await dictionary.waitFor({ state: 'hidden' });
    await page.locator('[data-rerun-analysis]').click();
    await page.waitForFunction(count => document.querySelectorAll('.verwrity-spelling-error').length === count, expected.length - 1);
    await page.locator('.settings-menu > summary').click(); await page.locator('[data-open-project-words]').click();
    await dictionary.locator('[data-words-edit]').click();
    await dictionary.locator('[data-words-project]').fill(''); await dictionary.locator('[data-words-use]').click(); await dictionary.waitFor({ state: 'hidden' });
    await page.locator('[data-rerun-analysis]').click();
    await page.waitForFunction(count => document.querySelectorAll('.verwrity-spelling-error').length === count, expected.length);

    const textMenu = page.locator('details.view-menu');
    await textMenu.locator(':scope > summary').click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/preferences/manuscript') && response.request().method() === 'POST' && response.status() === 200),
      page.locator('[data-manuscript-setting="font_family"]').selectOption('serif'),
    ]);
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/preferences/manuscript') && response.request().method() === 'POST' && response.status() === 200),
      page.locator('[data-manuscript-setting="font_size"]').selectOption('20'),
    ]);
    for (const [setting, color] of [['text_color', '#d9c7ff'], ['background_color', '#17142a']]) {
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/preferences/manuscript') && response.request().method() === 'POST' && response.status() === 200),
        page.locator(`[data-manuscript-setting="${setting}"]`).evaluate((input, value) => {
          input.value = value;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, color),
      ]);
    }
    assert.deepEqual(await page.locator('.ProseMirror').evaluate(editor => ({
      family: getComputedStyle(editor).fontFamily,
      size: getComputedStyle(editor).fontSize,
      color: getComputedStyle(editor).color,
      background: getComputedStyle(editor).backgroundColor,
    })), {
      family: 'serif', size: '20px', color: 'rgb(217, 199, 255)', background: 'rgb(23, 20, 42)',
    }, 'manuscript presentation preferences affect only the editor surface');

    const analysisMenu = page.locator('details.analysis-menu');
    await analysisMenu.locator(':scope > summary').click();
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/preferences/annotations/spelling') && response.request().method() === 'POST' && response.status() === 200),
      page.locator('[data-annotation-style="spelling"]').evaluate(select => {
        select.value = 'underline';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    ]);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/preferences/annotations/spelling') && response.request().method() === 'POST' && response.status() === 200),
      page.locator('[data-annotation-color="spelling"]').evaluate(input => {
        input.value = '#ff00ff';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    ]);
    const decorated = page.locator('.verwrity-spelling-error').first();
    assert.match(await decorated.evaluate(element => getComputedStyle(element).textDecorationColor), /rgb\(255, 0, 255\)/);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/preferences/annotations/spelling') && response.request().method() === 'POST' && response.status() === 200),
      page.locator('[data-annotation-style="spelling"]').evaluate(select => {
        select.value = 'highlight';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }),
    ]);
    await page.waitForFunction(() => {
      const marked = document.querySelector('.verwrity-spelling-error.verwrity-annotation-highlight');
      return marked && getComputedStyle(marked).backgroundColor !== 'rgba(0, 0, 0, 0)';
    });
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);

    const beforeReload = spellingCalls;
    await page.reload();
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => document.querySelector('[data-annotation-toggle="spelling"]').getAttribute('aria-pressed') === 'true');
    assert.equal(await page.locator('[data-annotation-toggle="spelling"]').getAttribute('aria-pressed'), 'true');
    assert.equal(spellingCalls, beforeReload, 'restoring enabled spelling never starts a check');
    assert.deepEqual(await markedWords(page), [], 'source findings are transient');
    assert.equal(await page.locator('[data-analysis-stale-status]').isVisible(), true);
    await page.locator('[data-rerun-analysis]').click();
    await page.waitForFunction(count => document.querySelectorAll('.verwrity-spelling-error').length === count, expected.length);
    assert.deepEqual(await markedWords(page), expected, 'explicit rerun checks the restored scene');
    assert.equal(await page.locator('.ProseMirror').evaluate(editor => getComputedStyle(editor).fontFamily), 'serif');
    assert.equal(await page.locator('.ProseMirror').evaluate(editor => getComputedStyle(editor).fontSize), '20px');
    assert.equal(await page.locator('.ProseMirror').evaluate(editor => getComputedStyle(editor).color), 'rgb(217, 199, 255)');
    assert.equal(await page.locator('.ProseMirror').evaluate(editor => getComputedStyle(editor).backgroundColor), 'rgb(23, 20, 42)');

    await page.route('**/scene/*/spell-check', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.reload();
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => document.querySelector('[data-annotation-toggle="spelling"]').getAttribute('aria-pressed') === 'true');
    await page.locator('[data-rerun-analysis]').click();
    await page.waitForFunction(() => document.querySelector('[data-analysis-status]')?.textContent === 'Spell check unavailable');
    assert.equal(await page.locator('[data-annotation-toggle="spelling"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-analysis-stale-status]').isVisible(), true);
    assert.equal(await page.locator('[data-rerun-analysis]').isVisible(), true);
    assert.equal(await page.locator('[data-rerun-analysis]').isEnabled(), true);

    await page.unroute('**/scene/*/spell-check');
    await page.locator('[data-rerun-analysis]').click();
    await page.waitForFunction(count => document.querySelectorAll('.verwrity-spelling-error').length === count, expected.length);
    assert.deepEqual(await markedWords(page), expected, 'rerun restores the exact ranges');

    const dialectProse = "😀 Colour and color, centre and center, favourite and favorite.\n\nNeurodivergent writers livestream. Zorvanna's recieve.";
    assert.equal((await page.request.post(`${url}/spelling-dictionary/project`, { data: { word: 'Zorvanna' } })).status(), 200);
    await page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent('verwrity-editor-change', { detail: { text } }));
    }, dialectProse);
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/spell-check') && response.status() === 200),
      page.locator('[data-rerun-analysis]').click(),
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.verwrity-spelling-error').length === 1);
    assert.deepEqual(await markedWords(page), ['recieve'], 'Supported dialects, modern vocabulary and author names remain valid');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), dialectProse, 'A dictionary update and check never alter prose');
    console.log('Spelling ranges, reload, retry, dialect coverage, modern vocabulary and author dictionaries passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
