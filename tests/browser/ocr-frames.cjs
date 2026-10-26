/* Real browser video seeking; synthetic images and inventory, no model calls. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } }), errors = [];
    const loading = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => loading.push([request.url(), request.failure()?.errorText]));
    page.on('console', message => { if (message.type() === 'error') loading.push(message.text()); });
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url); await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
    const media = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 640;
      const ctx = canvas.getContext('2d'), stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => recorder.onstop = resolve);
      let frame = 0;
      function paint() { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 480, 640); ctx.fillStyle = 'black'; ctx.font = '26px serif'; for (let row = 0; row < 16; row++) ctx.fillText(`Manuscript ${frame} line ${row}`, 15, 40 + row * 34); frame++; }
      paint(); const image = canvas.toDataURL('image/jpeg').split(',')[1];
      const rotated = document.createElement('canvas'); rotated.width = 640; rotated.height = 480;
      const rotatedContext = rotated.getContext('2d'); rotatedContext.translate(640, 0); rotatedContext.rotate(Math.PI / 2); rotatedContext.drawImage(canvas, 0, 0);
      const image90 = rotated.toDataURL('image/jpeg').split(',')[1];
      const timer = setInterval(paint, 33); recorder.start();
      await new Promise(resolve => setTimeout(resolve, 2200)); recorder.stop(); await stopped;
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      const video = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' })); });
      return { video, image, image90 };
    });
    await page.route('**/ai/ocr/import', async route => {
      if (route.request().headers()['x-verwrity-media'] !== 'video') return route.continue();
      const packets = [0.5, 1.0, 1.5].map((timestamp, index) => ({ id: `00000000-0000-4000-8000-00000000000${index}`, timestamp, frame_step: 1 / 30,
        variants: [{ image: route.request().headers()['x-verwrity-rotation'] === '90' ? media.image90 : media.image, timestamp, sharpness: index }], uncertain: false }));
      await route.fulfill({ contentType: 'application/x-ndjson', body: [...packets, { done: true }].map(JSON.stringify).join('\n') + '\n' });
    });
    await page.evaluate(() => document.querySelector('[data-ocr-open]').click());
    await page.locator('[data-ocr-video-rotation]').selectOption('90');
    await page.locator('[data-ocr-auto-duplicates]').uncheck();
    await page.locator('[data-ocr-files]').setInputFiles({ name: 'nearby.webm', mimeType: 'video/webm', buffer: Buffer.from(media.video, 'base64') });
    try { await page.locator("[data-ocr-extract]").click({ timeout: 5000 }); }
    catch (error) { console.error('Video extraction:', errors, await page.locator('[data-ocr-status]').innerText()); throw error; }
    await page.waitForFunction(() => document.querySelectorAll('.ocr-page').length === 3 && document.querySelector('[data-ocr-cancel]').disabled && document.querySelector('[data-ocr-video]').videoWidth);
    await page.locator('[data-ocr-show-unchecked]').uncheck();
    await page.locator('[data-ocr-selected-previous]').click();
    assert.match(await page.locator('[data-ocr-comparison-status]').textContent(), /capture 2 of 3/);
    assert.equal(await page.locator('[data-ocr-page-rotation]').inputValue(), '90', 'import rotation appears on each capture');
    assert(await page.locator('[data-ocr-video-reselect]').isHidden(), 'reselect is hidden while the recording is available');
    await page.evaluate(() => { window.verwrityDialog.confirm = async () => true; });
    await page.locator('[data-ocr-video-rotation]').selectOption('180');
    await page.locator('[data-ocr-rotate-video]').click();
    await page.waitForFunction(() => document.querySelector('[data-ocr-cancel]').disabled && document.querySelector('[data-ocr-page-rotation]').value === '180');
    await page.locator('[data-ocr-selected-previous]').click();
    assert.equal(await page.locator('[data-ocr-page-rotation]').inputValue(), '180', 'global changes appear on other captures');
    await page.locator('[data-ocr-selected-next]').click();
    await page.locator('[data-ocr-video-rotation]').selectOption('90');
    await page.locator('[data-ocr-rotate-video]').click();
    await page.waitForFunction(() => document.querySelector('[data-ocr-cancel]').disabled && document.querySelector('[data-ocr-page-rotation]').value === '90');
    await page.locator('[data-ocr-page-rotation]').selectOption('270');
    await page.locator('[data-ocr-rotate-page]').click();
    await page.waitForFunction(() => document.querySelector('[data-ocr-cancel]').disabled);
    const rotationState = await page.evaluate(async () => (await (await import('/static/ocr-storage.js')).buffers())[0].pages[1]);
    assert.equal(rotationState.adjustment.rotation, -180, 'page orientation is absolute relative to the original recording, without double rotating imported pixels');
    const original = await page.locator('[data-ocr-image]').getAttribute('src');
    await page.locator('[data-ocr-frame-previous]').click();
    await page.waitForFunction(() => document.querySelector('[data-ocr-frame-status]').textContent.includes('Preview at') && document.querySelector('[data-ocr-cancel]').disabled);
    await page.waitForFunction(() => document.querySelector('[data-ocr-image]').naturalWidth === 640 && document.querySelector('[data-ocr-image]').naturalHeight === 480);
    assert.notEqual(await page.locator('[data-ocr-image]').getAttribute('src'), original);
    assert.equal(await page.locator('.ocr-page').count(), 3, 'preview does not add a capture');
    await page.locator('[data-ocr-frame-next]').click();
    await page.waitForFunction(() => document.querySelector('[data-ocr-frame-status]').textContent.includes('1.000s') && document.querySelector('[data-ocr-cancel]').disabled);
    await page.locator('[data-ocr-frame-keep]').click();
    await page.waitForFunction(() => document.querySelectorAll('.ocr-page').length === 4 && document.querySelector('[data-ocr-cancel]').disabled);
    assert.equal(await page.locator('.ocr-page:visible').count(), 3, 'old capture is retained unchecked');
    await page.locator('[data-ocr-selected-next]').click();
    assert.match(await page.locator('[data-ocr-comparison-status]').textContent(), /capture 4 of 4/);
    await page.reload();
    try { await page.waitForFunction(() => window.verwrityEditor); }
    catch (error) { console.error('Frame recovery reload:', errors, loading, await page.evaluate(() => ({ ready: document.readyState, editor: typeof window.verwrityEditor, root: !!document.querySelector('[data-rich-editor]'), bundle: performance.getEntriesByType('resource').filter(entry => entry.name.includes('editor.bundle')).map(entry => ({ url: entry.name, size: entry.decodedBodySize, duration: entry.duration })) }))); throw error; }
    await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); document.querySelector('[data-ocr-open]').click(); });
    await page.waitForFunction(() => document.querySelectorAll('.ocr-page').length === 4);
    assert(await page.locator('[data-ocr-frame-next]').isDisabled(), 'original video is required after reload');
    assert(await page.locator('[data-ocr-video-reselect]').isVisible(), 'reselect appears when recovery needs the original recording');
    await page.locator('[data-ocr-video-source]').setInputFiles({ name: 'nearby.webm', mimeType: 'video/webm', buffer: Buffer.from(media.video, 'base64') });
    await page.waitForFunction(() => !document.querySelector('[data-ocr-frame-next]').disabled);
    assert(await page.locator('[data-ocr-video-reselect]').isHidden(), 'reselect disappears after the recording is restored');
    assert.deepEqual(errors, []);
    console.log('PASS: nearby unsampled video frames, preview/keep, retained originals, selected-page navigation and explicit video reselect after recovery.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
