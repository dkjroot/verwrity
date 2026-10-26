// Saved-project labels and portable download filenames stay independent.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated);
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.click('[data-file-operations]');
    const title = 'A story.v';
    const filename = `${title}.verwrity.zip`;
    await page.fill('#project-title', title);
    await page.click('#save-project-form button[type="submit"]');
    await page.waitForFunction(value => document.querySelector('.project-name')?.textContent === value, title);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.click('[data-file-operations]');
    assert.equal(await page.locator('#project-library option').last().textContent(), title);
    assert.equal(await page.locator('#project-library option').last().getAttribute('value'), filename);
    const downloadPending = page.waitForEvent('download');
    await page.click('#export-project-form button[type="submit"]');
    const download = await downloadPending;
    assert.equal(download.suggestedFilename(), filename);
    await page.screenshot({ path: '.test-runtime/project-files.png' });

    console.log('PASS: saved-project menu shows clean titles; exports keep the full .verwrity.zip filename.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
