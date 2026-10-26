/* A disconnected browser retains buffers; returning servers never reload/resubmit wiki saves. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    assert((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.waitForFunction(() => window.verwrityEditor && window.verwrityServerConnection);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    const edit = text => page.evaluate(value => {
      window.verwrityEditor.setText(value, [], true);
      window.dispatchEvent(new CustomEvent('verwrity-editor-change'));
    }, text);
    const modal = page.locator('#server-connection-dialog');
    const sceneId = await page.evaluate(() => window.verwrityEditor.sceneId);
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await context.setOffline(true);
    await edit('Unsaved manuscript 😀 during disconnection.');
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), false);
    await modal.waitFor({ state: 'visible' });
    assert((await modal.textContent()).includes('Keep it open'));
    assert.match(await page.locator('[data-save-status]').textContent(), /Server unavailable.*edits kept/);
    await page.keyboard.press('Escape');
    assert(await modal.isVisible(), 'Escape cannot hide an unresolved outage');
    assert.equal(await page.locator('#app-dialog').isVisible(), false, 'Only the actionable connection modal is shown');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), 'Unsaved manuscript 😀 during disconnection.');
    if (process.env.VERWRITY_SERVER_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_SERVER_SCREENSHOT });
    await context.setOffline(false);
    // No button or reload: the regular check dismisses the modal automatically.
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('[data-save-status]')?.dataset.state === 'saved');
    assert.equal(navigations, 0);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), 'Unsaved manuscript 😀 during disconnection.');

    // A failed request to one endpoint is not a server outage.
    await page.route(`**/scene/${sceneId}/text`, route => route.abort('failed'));
    await edit('Edit kept after an isolated save transport error.');
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), false);
    assert.equal(await modal.isVisible(), false, 'A successful health probe distinguishes an endpoint failure');
    await page.unroute(`**/scene/${sceneId}/text`);
    assert.equal(await page.evaluate(() => window.verwritySaveActiveScene()), true);
    await page.route('**/connection-test', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Disk write failed"}' }));
    assert.equal(await page.evaluate(async () => (await fetch('/connection-test')).status), 503);
    assert.equal(await modal.isVisible(), false, 'HTTP errors retain their own explanation');
    await page.unroute('**/connection-test');
    assert.equal(await page.evaluate(async () => {
      const controller = new AbortController(); controller.abort();
      try { await fetch('/health', { signal: controller.signal }); } catch (error) { return error.name; }
    }), 'AbortError');
    assert.equal(await modal.isVisible(), false, 'Author cancellation does not signal an outage');

    const created = await page.request.post(`${url}/wiki/page/create`, { form: { title: 'Connection test' } });
    await page.goto(created.url());
    const wikiId = new URL(page.url()).searchParams.get('wiki_page');
    await page.locator('[data-wiki-current-page]').getByRole('button', { name: 'Edit page', exact: true }).click();
    const form = page.locator('[data-wiki-page-editor]');
    const textarea = form.locator('textarea[name="body"]');
    const wikiText = 'Protected words.\n\nMaintained words 😀.';
    await textarea.fill(wikiText);
    await textarea.evaluate(el => { const start = el.value.indexOf('Maintained'); el.focus(); el.setSelectionRange(start, el.value.length); });
    await form.getByRole('button', { name: 'Mark as AI maintained', exact: true }).click();
    const authorshipLog = await form.locator('[name="authorship_edits"]').inputValue();
    await page.route(`**/wiki/page/${wikiId}/save`, async route => {
      await context.setOffline(true);
      await route.abort('failed');
    });
    await form.getByRole('button', { name: 'Save page', exact: true }).click();
    await modal.waitFor({ state: 'visible' });
    assert.equal(await textarea.inputValue(), wikiText);
    assert.equal(await form.locator('[name="authorship_edits"]').inputValue(), authorshipLog);
    assert.equal(await page.locator('#app-dialog').isVisible(), false);
    await page.getByRole('button', { name: 'Check now', exact: true }).click();
    assert(await modal.isVisible(), 'A manual check leaves the modal open while still offline');
    await page.unroute(`**/wiki/page/${wikiId}/save`);
    await context.setOffline(false);
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await textarea.inputValue(), wikiText);
    const beforeRetry = await (await page.request.get(`${url}/wiki/page/${wikiId}/data`)).json();
    assert.equal(beforeRetry.body, '', 'No automatic wiki mutation is replayed on reconnection');
    await form.getByRole('button', { name: 'Save page', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wiki-page-body')?.textContent.includes('Maintained words'));
    const saved = await (await page.request.get(`${url}/wiki/page/${wikiId}/data`)).json();
    assert.equal(saved.body, wikiText);
    assert.equal(saved.annotations.length, 1);
    assert.equal(saved.annotations[0].origin, 'human_delegated');
    assert.equal(saved.annotations[0].quote, 'Maintained words 😀.');

    // A stopped local server does not change the browser's internet status.
    // Periodic probes must detect it even without an offline event or a save.
    await page.route('**/health', route => route.abort('connectionrefused'));
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    await page.unroute('**/health');
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), 'Edit kept after an isolated save transport error.');
    await page.locator('[data-file-operations]').click();
    await page.locator('#project-title').fill('Connection recovery');
    await page.route('**/project/library-save', async route => {
      await context.setOffline(true);
      await route.abort('failed');
    });
    await page.locator('#save-project-form button[type="submit"]').click();
    await modal.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#app-dialog').isVisible(), false, 'Connection explanation takes precedence over named save errors');
    assert.equal(await page.locator('#project-title').inputValue(), 'Connection recovery');
    await page.unroute('**/project/library-save');
    await context.setOffline(false);
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await page.locator('#project-title').inputValue(), 'Connection recovery');
    const namedSave = page.waitForResponse(response => response.url().endsWith('/project/library-save') && response.status() === 200);
    await page.locator('#save-project-form button[type="submit"]').click();
    await namedSave;
    console.log('PASS: server outage modal, automatic checks/manual retry, Escape protection, no reload, manuscript retry, retained wiki text/permissions and named saves, and distinct endpoint errors/cancellation.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
