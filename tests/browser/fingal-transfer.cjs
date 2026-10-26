/* Explicit file review, source provenance, no-prose worlds, wiki forms and feature revocation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8767';
    assert((await (await page.request.get(url + '/__browser_test__')).json()).isolated);
    await page.request.post(url + '/__browser_test__/reset');
    await page.goto(url);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => window.verwrityWiki && window.verwrityEditor);
    assert.equal(await page.locator('[data-fingal-import], [data-fingal-export], [data-new-world-item]').count(), 0);
    const oldId = await page.locator('[data-workspace]').getAttribute('data-project-id');
    async function enable(fingal, map = false, character = false) {
      const response = await page.request.get(url + '/project/features');
      const before = (await response.json()).features;
      const features = { fingal_mode: fingal, map_editor: map, character_editor: character };
      assert((await page.request.post(url + '/project/features', { headers: { 'X-Verwrity-Project-Id': await page.locator('[data-workspace]').getAttribute('data-project-id') }, data: { features, expected_features: before } })).ok());
      await page.evaluate(features => window.dispatchEvent(new CustomEvent('verwrity-project-features-changed', { detail: features })), features);
      await page.waitForFunction(fingal => window.verwrityWorld?.fingalEnabled === fingal, fingal);
    }
    await enable(true);
    await page.locator('[data-fingal-import]').waitFor({ state: 'attached' });
    await page.locator('[data-file-operations]').click();
    await page.locator('[data-fingal-export]').click();
    const review = page.locator('[data-fingal-review]');
    await review.getByRole('status').filter({ hasText: /Resolve/ }).waitFor();
    assert.match(await review.innerText(), /player template/);
    assert.equal(await review.locator('[data-fingal-accept]').isVisible(), false);
    await review.locator('[data-fingal-close]').click();
    const fixture = path.join(__dirname, '..', 'fixtures', 'fingal-format1.json');
    async function previewImport() {
      await page.locator('[data-file-operations]').click();
      await page.locator('#fingal-story-file').setInputFiles(fixture);
      await page.locator('[data-fingal-import]').getByRole('button', { name: 'Review import' }).click();
      await review.getByRole('status').filter({ hasText: 'Ready for your review.' }).waitFor();
    }
    await previewImport();
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-project-id'), oldId);
    await review.locator('[data-fingal-close]').click();
    // Import saves pending human wiki text and prose before switching projects.
    const oldPages = (await (await page.request.get(url + '/world/state')).json()).pages;
    await page.evaluate(id => window.verwrityWiki.open(id), oldPages[0].id);
    await page.locator('[data-wiki-current-page]').getByRole('button', { name: 'Edit page', exact: true }).click();
    await page.locator('[data-wiki-page-editor] textarea[name="body"]').fill('Keep this unsaved human background.');
    await page.evaluate(() => { window.verwrityEditor.setText('Keep this manuscript.'); window.dispatchEvent(new Event('verwrity-editor-change')); });
    await previewImport();
    await review.locator('[data-fingal-accept]').click();
    await page.waitForURL(/wiki_page=/);
    await page.waitForFunction(old => document.querySelector('[data-workspace]').dataset.projectId !== old && window.verwrityWorld?.fingalEnabled, oldId);
    const wiki = page.locator('[data-wiki-current-page]');
    await wiki.getByRole('heading', { name: 'Lantern Inn', exact: true }).waitFor();
    assert.match(await wiki.innerText(), /Imported Fingal record/);
    assert(await page.locator('.storyboard-empty').isVisible());
    await page.locator('.toolbar [data-open-world-map]').click();
    await page.locator('[data-world-map-grid]').getByRole('button', { name: 'Lantern Inn at 0.5, 0', exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Lantern Inn at 0.5, 0', exact: true }).isVisible());
    // Unedited round trip retains unknown fields, players, items and economy.
    await page.locator('[data-file-operations]').click();
    await page.locator('[data-fingal-export]').click();
    await review.locator('[data-fingal-accept]').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), review.locator('[data-fingal-accept]').click()]);
    const buffer = await fs.promises.readFile(await download.path());
    assert.deepEqual(JSON.parse(buffer), JSON.parse(fs.readFileSync(fixture)));
    await review.locator('[data-fingal-close]').click();
    const state = await (await page.request.get(url + '/world/state')).json();
    const item = state.pages.find(p => p.world.kind === 'item');
    await page.evaluate(id => window.verwrityWiki.open(id), item.id);
    await wiki.getByRole('button', { name: 'Edit item definition' }).click();
    const form = page.locator('[data-world-record-form]');
    await form.locator('[data-record-field="description"]').fill('An old brass key.');
    await form.getByRole('button', { name: 'Save item', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    assert.match(await wiki.innerText(), /Human changes: description/);
    await enable(false, true, true);
    assert.equal(await page.locator('[data-fingal-import], [data-fingal-export], [data-fingal-review], [data-new-world-item]').count(), 0);
    assert.equal(await wiki.getByRole('button', { name: 'Edit item definition' }).count(), 0);
    const final = await (await page.request.get(url + '/world/state')).json();
    assert(final.pages.find(p => p.id === item.id).world.item.description === 'An old brass key.');
    assert.deepEqual(errors, []);
    console.log('PASS: Fingal review/import/export, lossless round trip, retained wiki/prose buffers, decimal map cells, item forms, provenance and mode gates.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
