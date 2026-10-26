const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const core = fs.readFileSync('verwrity/web/static/speed-reader-core.js', 'utf8');
  const { readingGroups, timing, ReaderPlayback } = await import(`data:text/javascript;base64,${Buffer.from(core).toString('base64')}`);
  const scenes = [{ id: 'a', text: 'First, scene.' }, { id: 'b', text: '😀 One two three!\n\n“Four?” five.\n\n\n\nSix.' }, { id: 'c', text: '' }, { id: 'd', text: 'Last scene.' }];
  assert.deepEqual(readingGroups(scenes, 'b', 4, 'caret', 'scene', 3), ['One two three!', '“Four?” five.', 'Six.']);
  assert.deepEqual(readingGroups(scenes, 'b', 0, 'scene', 'scene', 3), ['😀 One two', 'three!', '“Four?” five.', 'Six.']);
  assert.deepEqual(readingGroups(scenes, 'b', 0, 'manuscript', 'scene', 20), ['First, scene.', '😀 One two three!', '“Four?” five.', 'Six.']);
  for (const start of ['caret', 'scene', 'manuscript']) for (const end of ['scene', 'manuscript']) {
    const result = readingGroups(scenes, 'b', 4, start, end, 3);
    assert.equal(result.includes('First, scene.'), start === 'manuscript');
    assert.equal(result.includes('Last scene.'), end === 'manuscript');
  }
  assert.deepEqual(readingGroups(scenes, 'b', 4, 'caret', 'manuscript', 20), ['One two three!', '“Four?” five.', 'Six.', 'Last scene.']);
  assert.deepEqual(readingGroups(scenes, 'missing', 0, 'scene', 'scene', 1), []);
  assert.deepEqual(readingGroups([{id:'a', text:'one two'}], 'a', 7, 'caret', 'scene', 1), []);
  assert.deepEqual(timing(1, 240, 2, 500), { interval: 250, period: 125, visible: 125 });
  assert.equal(timing(3, 720, 1, 50).interval, 250);
  const p = new ReaderPlayback(['first', 'second'], timing(1, 240, 2, 50));
  assert.equal(p.frame(0), 'first'); assert.equal(p.running, false);
  p.play();
  for (const [at, expected] of [[0,'first'],[49,'first'],[50,''],[124,''],[125,'first'],[174,'first'],[175,''],[249,''],[250,'second']]) assert.equal(p.frame(at), expected, `flash at ${at}`);
  p.pause(); assert.equal(p.frame(300), 'second');
  p.play(); assert.equal(p.frame(1000), 'second'); assert.equal(p.frame(1250), ''); assert(p.finished);
  const late = new ReaderPlayback(['a','b','c'], timing(1,240,1,50));
  late.play(); late.frame(0); assert.equal(late.frame(5000), 'b'); assert.equal(late.index, 1);
  const continuous = new ReaderPlayback(['a','b'], timing(1,240,1,250));
  continuous.play(); for (const at of [0,50,125,249]) assert.equal(continuous.frame(at), 'a');
  assert.equal(continuous.frame(250), 'b');
  const triple = new ReaderPlayback(['a','b'], timing(1,240,3,30));
  triple.play();
  for (const [at, expected] of [[0,'a'],[30,''],[84,'a'],[114,''],[167,'a'],[197,''],[250,'b']]) assert.equal(triple.frame(at), expected);
  console.log('Speed reader grouping and deterministic timing passed');

  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated, 'Requires isolated test server');
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.waitForFunction(() => window.verwrityEditor);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.evaluate(() => {
      window.verwrityEditor.setText('😀 One two three!\n\n“Four?” five.\n\nSix.');
      window.verwrityEditor.focus();
    });
    // Separate fixture replacement from the author's edit in ProseMirror's
    // normal history grouping window, then verify exactly that edit survives.
    await page.waitForTimeout(550);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Z');
    await page.evaluate(() => window.verwrityEditor.selectSourceRange(4, 5));
    const before = await page.evaluate(() => ({ text: verwrityEditor.getText(), caret: verwrityEditor.getCaretOffset(), range: verwrityEditor.getSelectedRange(), layout: localStorage.getItem('verwrity-workspace-layout-v1') }));
    const open = async () => {
      await page.locator('.toolbar [data-speed-reader-open]').click();
      await page.waitForFunction(() => document.querySelector('#speed-reader').open && document.querySelector('[data-reader-status]').textContent.startsWith('Paused'), null, { timeout: 5000 }).catch(async error => {
        throw new Error(`${error.message}: ${await page.locator('[data-reader-status]').textContent()}; ${errors.join('; ')}`);
      });
    };
    await open();
    assert.equal(await page.locator('[data-reader-words]').textContent(), 'One', JSON.stringify(await page.evaluate(() => ({ open: document.querySelector('#speed-reader').open, status: document.querySelector('[data-reader-status]').textContent, caret: verwrityEditor.getCaretOffset() }))) + errors.join(';'));
    await page.locator('[data-reader-size]').fill('3');
    assert.equal(await page.locator('[data-reader-words]').textContent(), 'One two three!');
    await page.locator('[data-reader-wpm]').fill('720');
    await page.locator('[data-reader-repeats]').fill('2');
    assert.equal(await page.locator('[data-reader-visible]').getAttribute('max'), '125');
    assert.equal(await page.locator('[data-reader-visible]').inputValue(), '125');
    await page.locator('[data-reader-visible]').fill('500');
    assert.equal(await page.locator('[data-reader-visible]').inputValue(), '125');
    await page.locator('[data-reader-visible]').fill('50');
    assert.match(await page.locator('[data-reader-timing]').textContent(), /720 WPM · 250.0 ms/);
    await page.locator('[data-reader-font]').selectOption('monospace');
    await page.locator('[data-reader-font-size]').fill('80');
    assert.equal(await page.locator('[data-reader-words]').evaluate(el => getComputedStyle(el).fontSize), '80px');
    await page.locator('[data-reader-play]').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[data-reader-play]').textContent === 'Pause');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('[data-reader-play]').textContent(), 'Play');
    assert.notEqual(await page.locator('[data-reader-words]').textContent(), '');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#speed-reader').evaluate(el => el.open), false);
    const after = await page.evaluate(() => ({ text: verwrityEditor.getText(), caret: verwrityEditor.getCaretOffset(), range: verwrityEditor.getSelectedRange(), layout: localStorage.getItem('verwrity-workspace-layout-v1') }));
    assert.deepEqual(after, before, 'Reading preserves text, caret, selection and layout');
    await open();
    await page.locator('[data-reader-start]').selectOption('scene');
    assert.equal(await page.locator('[data-reader-words]').textContent(), '😀 One two');
    await page.locator('[data-reader-restart]').click();
    await page.locator('[data-reader-play]').click();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('[data-reader-play]').textContent(), 'Play');
    await page.setViewportSize({ width: 900, height: 600 });
    await page.locator('[data-reader-size]').fill('20');
    await page.locator('[data-reader-font-size]').fill('160');
    const bounds = await page.evaluate(() => {
      const word = document.querySelector('[data-reader-words]').getBoundingClientRect();
      const bar = document.querySelector('.speed-reader-bar').getBoundingClientRect();
      return { bottom: word.bottom, barTop: bar.top, centre: (word.top + word.bottom) / 2, height: innerHeight };
    });
    assert(bounds.bottom < bounds.barTop, 'Large word groups remain above controls');
    assert(Math.abs(bounds.centre - bounds.height / 2) < 2, 'Words stay centred in screen');
    await page.screenshot({ path: require('node:path').join(require('node:os').tmpdir(), 'speed-reader.png') });
    await page.locator('[data-reader-exit]').click();
    await page.evaluate(() => window.verwrityEditor.focus());
    await page.locator('.ProseMirror').focus();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), '😀 One two three!\n\n“Four?” five.\n\nSix.', 'Reading preserves the real editing undo stack');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.layout-menu > summary').click();
    await page.locator('[data-hide-toolbar]').click();
    await page.locator('.writing-restore-controls > summary').click();
    await page.locator('[data-show-toolbar]').click();
    await page.locator('.toolbar [data-speed-reader-open]').click();
    await page.waitForFunction(() => document.querySelector('[data-reader-status]').textContent.startsWith('Paused'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.toolbar [data-speed-reader-open]'));
    assert.equal(await page.locator('.toolbar [data-speed-reader-open]').evaluate(el => el === document.activeElement), true, 'Exit returns keyboard focus to the reader control');
    assert.equal(await page.locator('.toolbar').isVisible(), true, 'Reading preserves the restored toolbar state');
    // A pending snapshot must not reopen or populate the reader after exit.
    await page.route('**/speed-reader/snapshot?*', async route => { await new Promise(r => setTimeout(r, 150)); await route.continue(); });
    await page.locator('.toolbar [data-speed-reader-open]').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#speed-reader').evaluate(el => el.open), false);
    assert.deepEqual(errors, []);
    console.log('Speed reader browser safety and controls passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
