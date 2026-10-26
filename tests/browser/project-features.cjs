/* Project choices persist without touching manuscript/wiki or revealing unfinished tools. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated, 'Use the isolated browser server');
    await page.request.post(`${url}/__browser_test__/reset`);
    const ready = async () => {
      await page.waitForFunction(() => window.verwrityEditor);
      await page.evaluate(() => { document.querySelector('#start-dialog')?.close(); document.querySelector('#recovery-dialog')?.close(); });
    };
    await page.goto(url);
    await ready();
    const original = await page.evaluate(() => window.verwrityEditor.getText());
    const dialog = page.getByRole('dialog', { name: 'Prototype features', exact: true });
    const mode = dialog.getByRole('checkbox', { name: 'Enable Fingal mode', exact: true });
    const map = dialog.getByRole('checkbox', { name: 'Map editor', exact: true });
    const characters = dialog.getByRole('checkbox', { name: 'Game character sheets', exact: true });
    const state = () => page.request.get(`${url}/project/features`).then(response => response.json());
    const open = async () => {
      await page.locator('.toolbar summary').filter({ hasText: /^Settings$/ }).click();
      await page.locator('.toolbar [data-open-project-features]').click();
      await page.waitForFunction(() => !document.querySelector('[data-save-project-features]').disabled);
    };
    const save = async () => {
      await dialog.getByRole('button', { name: 'Save features', exact: true }).click();
      await dialog.getByRole('status').filter({ hasText: /Features saved/ }).waitFor();
    };
    const close = () => dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await open();
    for (const field of [mode, map, characters]) assert.equal(await field.isChecked(), false);
    assert.match(await dialog.innerText(), /Turn on Fingal mode if you also want to import or export a Fingal story/);
    assert.doesNotMatch(await dialog.innerText(), /not available yet|import\/export planned/);
    await map.check();
    await mode.check();
    assert(await map.isChecked() && await map.isDisabled());
    assert(await characters.isChecked() && await characters.isDisabled());
    await mode.uncheck();
    assert(await map.isChecked());
    assert.equal(await characters.isChecked(), false);
    await save();
    assert.deepEqual((await state()).features, { fingal_mode: false, map_editor: true, character_editor: false });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original);
    await close();

    // Closing and Escape discard pending feature changes.
    await open();
    await characters.check();
    await page.keyboard.press('Escape');
    await open();
    assert.equal(await characters.isChecked(), false);
    await mode.check();
    await save();
    await close();
    await page.reload();
    await ready();
    await open();
    assert(await mode.isChecked());
    await mode.uncheck();
    assert(await map.isChecked());
    assert.equal(await characters.isChecked(), false);

    // A failed save retains choices for an explicit retry.
    await page.route('**/project/features', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test save failed; retry.' }) }) : route.continue());
    await characters.check();
    await dialog.getByRole('button', { name: 'Save features' }).click();
    await dialog.getByRole('status').filter({ hasText: /Test save failed/ }).waitFor();
    assert(await characters.isChecked());
    assert.equal((await state()).features.character_editor, false);
    await page.unroute('**/project/features');
    await save();
    await close();

    // Saving features preserves an actively edited buffer and its selection.
    await page.evaluate(() => {
      window.verwrityEditor.setText('Author buffer preserved through feature settings.');
      window.verwrityEditor.selectSourceRange(0, 6);
      window.dispatchEvent(new Event('verwrity-editor-change'));
    });
    const selection = await page.evaluate(() => window.verwrityEditor.getSelectedRange());
    await open();
    await map.uncheck();
    await save();
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), 'Author buffer preserved through feature settings.');
    assert.deepEqual(await page.evaluate(() => window.verwrityEditor.getSelectedRange()), selection);
    await close();

    // Settings remain reachable with hidden chrome and at short viewport heights.
    await page.locator('.toolbar summary').filter({ hasText: /^Layout$/ }).click();
    await page.getByRole('button', { name: 'Hide main toolbar', exact: true }).click();
    await page.locator('.writing-restore-controls summary').click();
    await page.locator('.writing-restore-controls [data-show-toolbar]').click();
    await open();
    await page.waitForFunction(() => !document.querySelector('[data-save-project-features]').disabled);
    await page.setViewportSize({ width: 1024, height: 600 });
    await dialog.getByRole('button', { name: 'Save features' }).scrollIntoViewIfNeeded();
    if (process.env.VERWRITY_FEATURE_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_FEATURE_SCREENSHOT });
    await close();
    await page.evaluate(() => document.querySelector('[data-restore-default-layout]').click());

    // A named archive retains settings; a new project starts with all features off.
    await page.evaluate(async () => {
      await window.verwritySaveActiveScene();
      const data = new FormData(); data.set('project_title', 'Feature choices');
      await fetch('/project/library-save', { method: 'POST', body: data });
      await fetch('/project/new', { method: 'POST' });
      window.verwrityAllowUnload();
    });
    await page.goto(url);
    await ready();
    assert.deepEqual((await state()).features, { fingal_mode: false, map_editor: false, character_editor: false });
    await page.evaluate(async () => {
      const data = new FormData(); data.set('project_filename', 'Feature choices.verwrity.zip');
      await fetch('/project/library-open', { method: 'POST', body: data });
      window.verwrityAllowUnload();
    });
    await page.goto(`${url}/storyboard`);
    await open();
    assert.equal(await map.isChecked(), false);
    assert(await characters.isChecked());
    await close();
    assert.equal(await page.getByRole('button', { name: 'Export Fingal story', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('Project feature settings passed: defaults, suite, cancellation, retry, buffer safety, layout, project/archive isolation.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
