/* Whole-manuscript tasks share Q&A evidence navigation, but own their scope. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(() => window.verwrityEditor);
    const dock = page.locator('[data-project-question-dock]');
    const input = dock.locator('[name="question"]');
    const tasks = dock.getByLabel('Manuscript analysis tasks');
    const task = dock.getByRole('button', { name: 'Narrative voice consistency', exact: true });
    let calls = 0, payload;
    const sceneId = await page.evaluate(() => window.verwrityEditor.sceneId);
    const otherSceneId = await page.locator('.scene-row[data-scene-id]').nth(1).getAttribute('data-scene-id');
    const otherText = 'Rain hammered the glass like a warning.';
    await page.request.post(`${url}/scene/${otherSceneId}/text`, { form: { scene_text: otherText } });
    const text = 'The rain tapped softly on the windows.';
    await page.evaluate(text => {
      window.verwrityEditor.setText(text);
      window.dispatchEvent(new CustomEvent('verwrity-editor-change'));
    }, text);
    await input.fill('Keep this unfinished question');
    await page.route('**/ai/ask/stream', async route => {
      calls++;
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ type: 'result', result: {
          answer: 'A measured narrative voice. Review this passage in context.',
          evidence: [
            { source_type: 'scene', source_id: sceneId, title: 'Opening', quote: text, start: 0, end: text.length },
            { source_type: 'scene', source_id: otherSceneId, title: 'Later scene', quote: otherText, start: 0, end: otherText.length },
          ],
        } })}\n\n`,
      });
    });
    await tasks.click();
    assert.equal(calls, 0, 'opening the menu never runs analysis');
    await page.keyboard.press('Escape');
    assert.equal(await task.isVisible(), false, 'Escape closes the task menu');
    await dock.locator('.project-question-options > summary').click();
    await dock.locator('[name="before_percent"]').fill('0');
    await dock.locator('[name="after_percent"]').fill('0');
    await dock.locator('.project-question-options > summary').click();
    await tasks.click();
    await task.click();
    await dock.getByText('A measured narrative voice. Review this passage in context.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-project-question-dock]').dataset.busy === 'false');
    assert.deepEqual(payload, { task_id: 'narrative_voice' }, 'task prompt and scope are selected by the server');
    assert.equal(await input.inputValue(), 'Keep this unfinished question', 'task does not consume a typed question');
    assert.equal(await dock.locator('[name="before_percent"]').inputValue(), '0', 'Q&A context preference is preserved');
    assert.match(await dock.locator('.project-question-turn h4').first().innerText(), /Narrative voice consistency.*whole manuscript/);
    await dock.getByRole('button', { name: 'Go to passage' }).first().click();
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), text);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), text, 'review and citation leave manuscript unchanged');
    await Promise.all([
      page.waitForURL(`${url}/?ai_start=0&ai_end=${otherText.length}`),
      dock.getByRole('button', { name: 'Go to passage' }).nth(1).click(),
    ]);
    await page.evaluate(() => document.querySelector('#start-dialog')?.close());
    await page.waitForFunction(id => window.verwrityEditor?.sceneId === id, otherSceneId);
    assert.equal(await page.locator('.verwrity-ai-passage').innerText(), otherText);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), otherText, 'cross-scene review navigation preserves text');
    assert.match(await dock.locator('.project-question-turn h4').first().innerText(), /whole manuscript/);
    await page.unroute('**/ai/ask/stream');
    await page.route('**/ai/ask/stream', async route => {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ type: 'result', result: { answer: 'Follow-up to the voice review', evidence: [] } })}\n\n`,
      });
    });
    await input.fill('Explain the possible shift');
    await dock.locator('[data-project-question-submit]').click();
    await dock.getByText('Follow-up to the voice review', { exact: true }).waitFor();
    assert.equal(payload.history.length, 1, 'review is available to ordinary Q&A follow-ups');
    assert.match(payload.history[0].question, /Narrative voice consistency.*whole manuscript/);
    await dock.getByRole('button', { name: 'Clear AI conversation' }).click();

    // Delay the model response to exercise busy-state gating and cancellation.
    await page.unroute('**/ai/ask/stream');
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    await page.route('**/ai/ask/stream', async route => {
      calls++;
      await blocked;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ type: 'result', result: { answer: 'Late review', evidence: [] } })}\n\n`,
      }).catch(() => {});
    });
    await tasks.click();
    const requestStarted = page.waitForRequest(request => request.url().endsWith('/ai/ask/stream'));
    await task.click();
    await requestStarted;
    await tasks.click();
    assert.equal(await task.isEnabled(), false, 'busy review prevents duplicate task runs');
    await dock.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dock.getByText('Cancelled in this tab. The provider may finish an already-started request.', { exact: true }).first().waitFor();
    release();
    await page.waitForFunction(() => document.querySelector('[data-project-question-dock]').dataset.busy === 'false');
    assert.equal(await dock.getByText('Late review', { exact: true }).count(), 0, 'cancelled response cannot become a review');
    assert.equal(await dock.locator('[data-manuscript-task="narrative_voice"]').isEnabled(), true, 'task becomes available again after cancellation');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), otherText);
    console.log('Manuscript task menu, scope, evidence, persistence and cancellation passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
