/* Metadata edits preserve prose and board drafts, and invalidate expensive reviews. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    const sceneId = await page.evaluate(() => window.verwrityEditor.sceneId);
    const originalText = await page.evaluate(() => window.verwrityEditor.getText());
    const dialog = page.getByRole('dialog', { name: 'Scene metadata', exact: true });
    const readMetadata = () => page.request.get(`${url}/scene/${sceneId}/metadata`).then(response => response.json());
    const openCard = async () => {
      await page.getByRole('button', { name: 'Scene metadata', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save metadata' }).waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('[data-save-scene-metadata]').disabled);
    };
    let llmCalls = 0;
    page.on('request', request => { if (/\/text-analysis\/|\/ai\/ask/.test(request.url())) llmCalls++; });
    await openCard();
    await dialog.getByLabel('Scene name', { exact: true }).fill("Mara's crossing");
    await dialog.getByLabel('Scene description', { exact: true }).fill('A new description from the scene card.');
    await dialog.getByLabel('Point-of-view character', { exact: true }).fill('Mara');
    await dialog.getByLabel('Narrator', { exact: true }).fill('Mara looking back');
    await dialog.getByLabel('Narrative perspective', { exact: true }).fill('First person with an invented frame');
    await dialog.getByLabel('Location', { exact: true }).fill('Greywater 🕯️');
    await dialog.getByLabel('Time period', { exact: true }).fill('Not applicable');
    await dialog.getByLabel('Story time / chronology', { exact: true }).fill('Day 3, before the voyage');
    await dialog.getByLabel('Voice and style notes', { exact: true }).fill('Deliberately colloquial, unlike Orin.');
    await dialog.getByRole('button', { name: 'Save metadata' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = (await readMetadata()).metadata;
    assert.equal(saved.pov_character, 'Mara');
    assert.equal(saved.time_period, 'Not applicable');
    assert.equal(saved.narrative_perspective, 'First person with an invented frame', 'POV suggestions do not constrain author input');
    assert.equal(saved.provenance, 'human-authored');
    const sceneRow = page.locator(`.scene-row[data-scene-id="${sceneId}"] button.scene`);
    assert.equal(await sceneRow.innerText(), "Mara's crossing", 'name updates immediately in the Scenes list');
    assert.equal(await sceneRow.getAttribute('title'), 'A new description from the scene card.', 'description updates immediately in the Scenes list');
    assert.equal(llmCalls, 0, 'metadata edits never run an LLM');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalText);
    await openCard();
    await dialog.getByLabel('Location', { exact: true }).fill('Discard this edit');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await readMetadata()).metadata.location, saved.location, 'Cancel leaves saved metadata intact');

    // A review based on old intent must be discarded even when the prose is unchanged.
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/text-analysis/cliche', async route => {
      await delayed;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        scene_id: sceneId, analysis_id: 'cliche', discarded_findings: 0,
        annotations: [{ id: 'old-intent', start: 0, end: 9, quote: originalText.slice(0, 9), explanation: 'Based on old metadata' }],
      }) });
    });
    await page.locator('details.analysis-menu > summary').click();
    const requestStarted = page.waitForRequest(request => request.url().endsWith('/text-analysis/cliche'));
    await page.locator('[data-text-analysis="cliche"] [data-toggle-text-analysis]').click();
    await requestStarted;
    await openCard();
    await dialog.getByLabel('Voice and style notes', { exact: true }).fill('A revised deliberate voice.');
    await dialog.getByRole('button', { name: 'Save metadata' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.match(await page.locator('[data-text-analysis="cliche"] [data-text-analysis-status]').textContent(), /Scene metadata changed/);
    release();
    await page.waitForFunction(() => !window.verwrityTextAnalyses.status().busy);
    assert.equal(await page.locator('.verwrity-text-analysis').count(), 0, 'late results from old metadata cannot highlight prose');
    assert.equal(llmCalls, 1, 'metadata change does not rerun a review');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalText);

    const boardLink = page.getByRole('link', { name: 'Go to Storyboard', exact: true });
    await boardLink.click();
    await page.waitForURL('**/storyboard');
    const note = page.locator(`[data-story-note][data-scene-id="${sceneId}"]`);
    assert.equal(await note.locator('h3').innerText(), "Mara's crossing");
    assert.equal(await note.locator('.story-note-summary').inputValue(), 'A new description from the scene card.');
    await note.locator('.story-note-summary').fill('An unsaved board description.');
    await note.locator('[data-open-scene-metadata]').click();
    await page.waitForFunction(() => !document.querySelector('[data-save-scene-metadata]').disabled);
    assert.equal(await dialog.getByLabel('Point-of-view character', { exact: true }).inputValue(), 'Mara');
    assert.equal(await dialog.getByLabel('Scene description', { exact: true }).inputValue(), 'An unsaved board description.', 'card opens with the board draft');
    await dialog.getByLabel('Scene name', { exact: true }).fill("Orin's crossing");
    await dialog.getByLabel('Scene description', { exact: true }).fill('A description edited in the Sticky notes card.');
    await dialog.getByLabel('Point-of-view character', { exact: true }).fill('Orin');
    await dialog.getByLabel('Location', { exact: true }).fill('The eastern window');
    await dialog.getByRole('button', { name: 'Save metadata' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.match(await note.locator('[data-scene-metadata-preview]').innerText(), /Orin · The eastern window/);
    assert.equal(await note.locator('h3').innerText(), "Orin's crossing", 'name updates immediately on the Sticky notes');
    assert.equal(await note.locator('.story-note-summary').inputValue(), 'A description edited in the Sticky notes card.');
    await page.getByRole('link', { name: 'Grid', exact: true }).click();
    await page.waitForURL('**/storyboard?view=grid');
    const gridRow = page.locator('.storyboard-grid tbody tr').filter({ has: page.locator(`[data-open-scene-metadata="${sceneId}"]`) });
    assert.equal(await gridRow.locator('input[name^="scene_title_"]').inputValue(), "Orin's crossing");
    assert.equal(await gridRow.locator('textarea[name^="scene_summary_"]').inputValue(), 'A description edited in the Sticky notes card.');
    await gridRow.locator('input[name^="scene_title_"]').fill('Unsaved grid name');
    await gridRow.locator('[data-open-scene-metadata]').click();
    await page.waitForFunction(() => !document.querySelector('[data-save-scene-metadata]').disabled);
    assert.equal(await dialog.getByLabel('Scene name', { exact: true }).inputValue(), 'Unsaved grid name');
    await dialog.getByLabel('Scene name', { exact: true }).fill('The renamed crossing');
    await dialog.getByRole('button', { name: 'Save metadata' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await gridRow.locator('input[name^="scene_title_"]').inputValue(), 'The renamed crossing');
    await page.getByRole('button', { name: 'Save and return to writing', exact: true }).click();
    await page.waitForURL(url + '/');
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    await openCard();
    assert.equal(await dialog.getByLabel('Point-of-view character', { exact: true }).inputValue(), 'Orin');
    assert.equal(await dialog.getByLabel('Location', { exact: true }).inputValue(), 'The eastern window');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), originalText);
    assert.equal(await sceneRow.innerText(), 'The renamed crossing');
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    await page.locator('.writing-restore-controls > summary').click();
    await page.locator('[data-restore-editor]').click();
    await openCard();
    assert.equal(await dialog.getByLabel('Scene name', { exact: true }).evaluate(input => input.readOnly), true, 'Typewriter Mode keeps scene names read-only in the card');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log('PASS: scene metadata cards, author input, board drafts, persistence, and stale review safety.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
