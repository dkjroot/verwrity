/* Viewport sizing and writing modes must never change the author's text. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const screenshotRoot = process.env.VERWRITY_TEST_ARTIFACT_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'verwrity-layout-'));
fs.mkdirSync(screenshotRoot, { recursive: true });
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = process.env.VERWRITY_TEST_URL || 'http://127.0.0.1:8765';
    const marker = await page.request.get(`${url}/__browser_test__`);
    assert(marker.ok() && (await marker.json()).isolated, 'Use the isolated browser server');
    await page.request.post(`${url}/__browser_test__/reset`);
    const ready = async () => {
      await page.waitForFunction(() => window.verwrityEditor && document.querySelector('.editor-stage')?.style.getPropertyValue('--view-width'));
      await page.evaluate(() => document.querySelector('#start-dialog')?.close());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const fits = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await page.evaluate(() => {
        const viewport = document.querySelector('.editor-viewport');
        return {
          bodyHeight: document.documentElement.scrollHeight, bodyWidth: document.documentElement.scrollWidth,
          height: innerHeight, width: innerWidth,
          editorBottom: viewport.getBoundingClientRect().bottom,
          editorHeight: viewport.clientHeight,
          manuscriptScroll: document.querySelector('.manuscript').scrollHeight - document.querySelector('.manuscript').clientHeight,
        };
      });
      assert(bounds.bodyHeight <= bounds.height + 1, `No outer vertical scrolling: ${JSON.stringify(bounds)}`);
      assert(bounds.bodyWidth <= bounds.width + 1, `No outer horizontal scrolling: ${JSON.stringify(bounds)}`);
      assert(bounds.editorBottom <= bounds.height && bounds.editorHeight > 100, `Editor fits and remains usable: ${JSON.stringify(bounds)}`);
      assert(bounds.manuscriptScroll <= 1, 'The manuscript panel does not need a second scrollbar');
    };
    const layout = async selector => {
      await page.locator('.layout-menu > summary').click();
      await page.locator(selector).click();
    };
    const workspaceAction = async (selector, target = page) => {
      if (selector.includes('restore-default-layout')) {
        if (await target.locator('body').getAttribute('data-editor-maximized') === 'true') await workspaceAction('[data-restore-editor]', target);
        if (await target.locator('body').getAttribute('data-toolbar-hidden') === 'true') await workspaceAction('[data-show-toolbar]', target);
        await target.locator('.layout-menu > summary').click();
        await target.locator('.layout-menu [data-restore-default-layout]').click(); return;
      }
      if (await target.locator('.writing-restore-controls').getAttribute('open') === null) await target.locator('.writing-restore-controls > summary').click();
      await target.locator(selector).click();
    };
    await page.goto(url); await ready();
    const layoutState = () => page.evaluate(() => {
      const workspace = document.querySelector('[data-workspace]');
      return {
        mode: workspace.dataset.focusMode,
        typewriter: workspace.dataset.typewriterMode,
        maximized: document.body.dataset.editorMaximized,
        toolbar: document.body.dataset.toolbarHidden,
        controls: document.body.dataset.manuscriptControlsHidden,
        footer: document.body.dataset.footerHidden,
        panels: ['storyboard', 'wiki'].map(name => ({
          hidden: document.querySelector(`#${name}-panel`).hidden,
          width: document.querySelector(`#${name}-panel`).getBoundingClientRect().width,
          override: workspace.style.getPropertyValue(`--${name}-width`),
        })),
        caretUnlocked: document.querySelector('[data-caret-movement-toggle]').getAttribute('aria-pressed'),
      };
    });
    const defaultLayout = await layoutState();
    assert.equal(defaultLayout.mode, 'normal', 'Fresh installations start in Normal mode');
    assert.equal(defaultLayout.typewriter, 'false');
    for (const flag of ['maximized', 'toolbar', 'controls', 'footer', 'caretUnlocked']) {
      assert.equal(defaultLayout[flag], 'false', `Fresh default ${flag} remains disabled`);
    }
    assert(defaultLayout.panels.every(panel => !panel.hidden && !panel.override), 'Fresh defaults show both panels at responsive widths');
    const original = await page.evaluate(() => window.verwrityEditor.getText());
    for (const [width, height] of [[1920, 900], [1920, 720], [1366, 620], [1024, 500], [3840, 2160]]) {
      await page.setViewportSize({ width, height }); await fits();
      assert.equal(await page.locator('.footer').count(), 0, 'The slogan footer is removed');
      assert(await page.locator('#storyboard-panel').isVisible());
      assert(await page.locator('#wiki-panel').isVisible());
      assert.equal(await page.locator('[data-file-operations]').evaluate(button => button.closest('.toolbar') !== null), true);
      await page.screenshot({ path: path.join(screenshotRoot, `layout-${width}x${height}.png`) });
    }
    await page.setViewportSize({ width: 1920, height: 720 });
    await fits();
    const editorHeight = await page.locator('.editor-viewport').evaluate(viewport => viewport.clientHeight);
    assert.equal(await page.locator('[data-footer-toggle]').count(), 0, 'No footer toggle remains');
    await page.evaluate(() => {
      const notice = document.createElement('p');
      notice.className = 'notice'; notice.textContent = 'Layout test notification';
      document.body.prepend(notice);
      const list = document.querySelector('.storyboard ol');
      for (let i = 0; i < 40; i += 1) list.append(list.firstElementChild.cloneNode(true));
    });
    await fits();
    assert.equal(await page.locator('#storyboard-panel').evaluate(panel => panel.scrollHeight > panel.clientHeight), true, 'Long scene lists scroll inside the sidebar');
    await page.evaluate(() => { document.querySelector('.notice').remove(); });
    await page.locator('.view-menu > summary').click();
    await page.locator('[data-view-mode]').selectOption('pages');
    await page.locator('[data-page-layout]').selectOption('single');
    await page.locator('[data-fit-view="width"]').click();
    await page.locator('.view-menu > summary').click();
    await page.locator('[data-panel-toggle="wiki"]').click();
    await fits();
    const toolbarHeight = await page.locator('.toolbar').evaluate(toolbar => toolbar.getBoundingClientRect().height);
    const beforeHiddenToolbar = await page.locator('.editor-viewport').evaluate(viewport => viewport.clientHeight);
    await layout('[data-hide-toolbar]'); await fits();
    assert.equal(await page.locator('.editor-viewport').evaluate(viewport => viewport.clientHeight), beforeHiddenToolbar + toolbarHeight - 28, 'Hiding the toolbar reserves a small right-aligned Workspace control');
    const workspaceSummary = page.locator('.writing-restore-controls > summary');
    assert((await workspaceSummary.boundingBox()).width < 160, 'Restore access is a compact floating control');
    assert.equal(await page.locator('.writing-restore-controls').getAttribute('open'), null, 'The floating menu starts closed');
    await workspaceSummary.focus(); await page.keyboard.press('Enter');
    assert(await page.locator('[data-show-toolbar]').isVisible(), 'Keyboard access opens restore actions');
    await fits();
    assert.equal(await page.locator('.editor-viewport').evaluate(viewport => viewport.clientHeight), beforeHiddenToolbar + toolbarHeight - 28, 'Opening the floating menu reserves no additional layout space');
    await page.keyboard.press('Tab'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.writing-restore-controls').getAttribute('open'), null, 'Escape closes the floating menu');
    assert.equal(await workspaceSummary.evaluate(summary => document.activeElement === summary), true, 'Escape returns focus to the floating control');
    await workspaceSummary.click();
    await page.locator('.panel-heading h2').click();
    assert.equal(await page.locator('.writing-restore-controls').getAttribute('open'), null, 'Outside clicks close the floating menu');
    await page.screenshot({ path: path.join(screenshotRoot, 'layout-hidden-toolbar.png') });
    await workspaceSummary.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await fits();
    assert(await page.locator('.toolbar').isVisible(), 'Keyboard access can restore the toolbar');
    assert.equal(await page.locator('.editor-viewport').evaluate(viewport => viewport.clientHeight), beforeHiddenToolbar);
    await layout('[data-hide-manuscript-controls]');
    assert.equal(await page.locator('.editor-toolbar').isVisible(), false);
    assert(await page.locator('[data-save-status]').isVisible(), 'Saving feedback survives hidden controls');
    await layout('[data-hide-toolbar]'); await fits();
    assert.equal(await page.locator('.toolbar').isVisible(), false);
    await page.reload(); await ready(); await fits();
    assert.equal(await page.locator('.toolbar').isVisible(), false, 'Hidden bars persist');
    await workspaceAction('[data-show-toolbar]');
    await layout('[data-hide-manuscript-controls]');
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-standard-focus-toggle]').click(); await fits();
    assert.equal(await page.locator('.toolbar').isVisible(), false);
    assert.equal(await page.locator('.text-overview').isVisible(), false);
    assert.equal(await page.locator('.project-question-dock').isVisible(), false);
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-typewriter-mode'), 'false');
    await page.evaluate(() => { window.verwrityEditor.focus(); });
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('Focus test ');
    assert((await page.evaluate(() => window.verwrityEditor.getText())).startsWith('Focus test '), 'Standard focus allows normal caret navigation');
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original);
    await page.reload(); await ready(); await fits();
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-focus-mode'), 'focus');
    await workspaceAction('[data-restore-editor]'); await fits();
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-focus-mode'), 'focus', 'Restore keeps ordinary Focus Mode enabled');
    assert(await page.locator('.editor-toolbar').isVisible(), 'Restore reveals manuscript settings');
    assert.equal(await page.locator('#storyboard-panel').isVisible(), false);
    assert.equal(await page.locator('#wiki-panel').isVisible(), false);
    assert.equal(await page.locator('.text-overview').isVisible(), false);
    assert.equal(await page.locator('.project-question-dock').isVisible(), false);
    const activeColors = await page.evaluate(() => {
      const focus = getComputedStyle(document.querySelector('[data-focus-toggle]'));
      const fit = getComputedStyle(document.querySelector('[data-fit-view="width"]'));
      return { focus: focus.color, fit: fit.color, border: focus.borderTopColor };
    });
    assert.equal(activeColors.focus, activeColors.fit, 'Focus uses the existing active orange');
    assert.equal(activeColors.border, activeColors.fit);
    await page.locator('.view-menu').evaluate(el => { el.open = true; });
    const fontSize = page.locator('[data-manuscript-setting="font_size"]');
    const originalSize = await fontSize.inputValue();
    const originalRenderedSize = await page.locator('.ProseMirror').evaluate(editor => parseFloat(getComputedStyle(editor).fontSize));
    const changedSize = originalSize === '18' ? '20' : '18';
    await fontSize.selectOption(changedSize);
    assert.equal(await fontSize.inputValue(), changedSize, 'Text size can be changed in restored Focus Mode');
    await page.waitForFunction(size => parseFloat(getComputedStyle(document.querySelector('.ProseMirror')).fontSize) !== size, originalRenderedSize);
    await fontSize.selectOption(originalSize);
    await page.locator('.view-menu').evaluate(el => { el.open = false; });
    await page.screenshot({ path: path.join(screenshotRoot, 'layout-focus-restored.png') });
    await page.reload(); await ready(); await fits();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'false', 'Restored Focus Mode persists');
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-focus-mode'), 'focus');
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-standard-focus-toggle]').click();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'false', 'Ordinary Focus Mode also remembers its restored preference on reentry');
    assert.equal(await page.locator('#storyboard-panel').isVisible(), false);
    await layout('[data-maximize-editor]'); await fits();
    await workspaceAction('[data-exit-focus]'); await fits();
    assert.equal(await page.locator('[data-focus-toggle]').getAttribute('data-active'), 'false');
    assert(await page.locator('#storyboard-panel').isVisible(), 'Normal storyboard visibility restores');
    assert.equal(await page.locator('#wiki-panel').isVisible(), false, 'Normal hidden wiki restores');
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    await fits();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', 'Typewriter Mode defaults to maximized independently of normal layout');
    await page.reload(); await ready(); await fits();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', 'Typewriter maximization persists');
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-typewriter-mode'), 'true');
    await workspaceAction('[data-restore-editor]');
    await page.locator('[data-caret-movement-toggle]').click();
    assert.equal(await page.locator('[data-caret-movement-toggle]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-caret-movement-toggle]').click();
    await layout('[data-maximize-editor]');
    await workspaceAction('[data-exit-focus]');
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'false', 'Exiting maximized Typewriter Mode restores normal layout');
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', 'Exiting focus remembers Typewriter maximization');
    await workspaceAction('[data-restore-editor]');
    assert.equal(await page.locator('[data-workspace]').getAttribute('data-typewriter-mode'), 'true', 'Restore does not exit Typewriter Mode');
    assert.equal(await page.locator('[data-focus-toggle]').getAttribute('data-active'), 'true');
    await page.locator('[data-panel-toggle="storyboard"]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'false', 'Typewriter remembers restored layout on reentry');
    assert(await page.locator('#storyboard-panel').isVisible(), 'Typewriter panel choices survive leaving focus');
    assert.equal(await page.locator('#wiki-panel').isVisible(), false);
    await page.locator('[data-panel-toggle="storyboard"]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    assert.equal(await page.locator('#storyboard-panel').isVisible(), false, 'Typewriter also remembers hiding its panels');
    await layout('[data-maximize-editor]');
    await workspaceAction('[data-exit-focus]');
    await page.reload(); await ready();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', 'Typewriter maximize preference survives exiting and reload');
    await workspaceAction('[data-exit-focus]');
    await layout('[data-maximize-editor]');
    for (const [width, height] of [[1920, 600], [3840, 2160], [760, 600]]) {
      await page.setViewportSize({ width, height }); await fits();
      assert(await page.locator('.writing-restore-controls > summary').isVisible());
      await page.locator('.writing-restore-controls > summary').click();
      assert(await page.locator('[data-restore-editor]').isVisible());
      await page.keyboard.press('Escape');
      await page.screenshot({ path: path.join(screenshotRoot, `layout-maximized-${width}x${height}.png`) });
    }
    await workspaceAction('[data-restore-editor]');
    await page.setViewportSize({ width: 3840, height: 2160 }); await fits();
    assert(await page.locator('.editor-toolbar').isVisible());
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original, 'Layout changes preserve all manuscript text');

    // Reset every mode's live preferences, not just the saved active layout.
    await page.setViewportSize({ width: 1920, height: 900 });
    for (const name of ['storyboard', 'wiki']) {
      if (!(await page.locator(`#${name}-panel`).isVisible())) await page.locator(`[data-panel-toggle="${name}"]`).click();
      await page.locator(`[data-column-resizer="${name}"]`).focus();
      await page.keyboard.press('ArrowRight');
    }
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-standard-focus-toggle]').click();
    await workspaceAction('[data-restore-editor]');
    await page.locator('[data-panel-toggle="wiki"]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-focus-toggle]').click();
    await page.locator('[data-typewriter-toggle]').click();
    await workspaceAction('[data-restore-editor]');
    await page.locator('[data-panel-toggle="storyboard"]').click();
    await page.locator('[data-caret-movement-toggle]').click();
    await layout('[data-hide-manuscript-controls]');
    await layout('[data-hide-toolbar]');
    const unrelatedPreferences = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'verwrity-workspace-layout-v1')));
    await workspaceAction('[data-show-toolbar]');
    await page.locator('.layout-menu > summary').click();
    await page.locator('.layout-menu [data-restore-default-layout]').focus();
    await page.keyboard.press('Enter');
    await fits();
    assert.deepEqual(await layoutState(), defaultLayout, 'Reset restores the fresh workspace, widths, bars, panels, and caret state immediately');
    assert.equal(await page.evaluate(() => localStorage.getItem('verwrity-workspace-layout-v1')), null, 'Reset removes saved layout choices');
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'verwrity-workspace-layout-v1'))), unrelatedPreferences, 'Reset preserves view and other browser settings');
    assert.equal(await page.locator('.layout-menu > summary').evaluate(summary => document.activeElement === summary), true, 'Keyboard focus returns to the restored Layout menu');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original, 'Reset preserves manuscript prose');
    await page.reload(); await ready(); await fits();
    assert.deepEqual(await layoutState(), defaultLayout, 'Defaults remain restored after reload');
    for (const mode of ['standard-focus', 'typewriter']) {
      await page.locator('[data-focus-toggle]').click();
      await page.locator(`[data-${mode}-toggle]`).click();
      assert.equal(await page.locator('body').getAttribute('data-editor-maximized'), 'true', `${mode} forgets its restored preference and starts maximized again`);
      await workspaceAction('[data-restore-editor]');
      assert.equal(await page.locator('#storyboard-panel').isVisible(), false, `${mode} forgets its custom storyboard visibility`);
      assert.equal(await page.locator('#wiki-panel').isVisible(), false, `${mode} forgets its custom wiki visibility`);
      await page.locator('.layout-menu > summary').click();
      await page.locator('.layout-menu [data-restore-default-layout]').focus();
      await page.keyboard.press('Enter');
      await fits();
      assert.deepEqual(await layoutState(), defaultLayout, 'Layout menu resets an active focus mode without restoring old preferences');
    }
    await page.reload(); await ready();
    assert.deepEqual(await layoutState(), defaultLayout);
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), original);

    // A mouse drag and keyboard resizing must survive reload without consuming
    // the manuscript's minimum width or reviving pre-reset focus preferences.
    const sidebar = page.locator('#storyboard-panel');
    const beforeDrag = (await sidebar.boundingBox()).width;
    const splitter = await page.locator('[data-column-resizer="storyboard"]').boundingBox();
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 40);
    await page.mouse.down();
    await page.mouse.move(splitter.x + splitter.width / 2 + 48, splitter.y + 40, { steps: 4 });
    await page.mouse.up();
    assert(Math.abs((await sidebar.boundingBox()).width - beforeDrag - 48) <= 1, 'Dragging resizes the intended panel');
    await page.locator('[data-column-resizer="wiki"]').focus();
    const wikiBefore = (await page.locator('#wiki-panel').boundingBox()).width;
    await page.keyboard.press('ArrowLeft');
    assert(Math.abs((await page.locator('#wiki-panel').boundingBox()).width - wikiBefore - 16) <= 1, 'Keyboard resizing uses the right-hand panel direction');
    const resized = await layoutState();
    await page.reload(); await ready(); await fits();
    assert.deepEqual(await layoutState(), resized, 'Both custom widths persist after reload');
    for (let step = 0; step < 80; step += 1) await page.locator('[data-column-resizer="storyboard"]').press('ArrowRight');
    await fits();
    assert((await page.locator('.manuscript').boundingBox()).width >= 359, 'Resizing leaves space for the manuscript');
    await layout('.layout-menu [data-restore-default-layout]');
    await layout('[data-maximize-editor]');
    await workspaceAction('.writing-restore-controls [data-restore-default-layout]');
    await fits();
    assert.deepEqual(await layoutState(), defaultLayout, 'Reset also clears maximization in Normal mode');

    // Restoring from maximization on mobile must return to the stacked page,
    // where document scrolling is intentional and horizontal overflow is not.
    for (const [width, height] of [[760, 600], [390, 700]]) {
      await page.setViewportSize({ width, height });
      await layout('[data-maximize-editor]'); await fits();
      await workspaceAction('[data-restore-editor]');
      const stacked = await page.evaluate(() => {
        const panelNames = ['.manuscript', '#storyboard-panel', '#wiki-panel'];
        const panels = panelNames.map(name => {
          const box = document.querySelector(name).getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, width: box.width };
        });
        return { panels, width: document.querySelector('[data-workspace]').clientWidth,
          pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
          pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
      });
      assert(stacked.panels.every(panel => Math.abs(panel.width - stacked.width) <= 1), 'Mobile panels use the full available width');
      assert(stacked.panels[1].top >= stacked.panels[0].bottom && stacked.panels[2].top >= stacked.panels[1].bottom, 'Mobile restores manuscript, storyboard, and wiki as a stack');
      assert(stacked.pageWidth <= stacked.viewportWidth + 1, 'Restored mobile layout has no horizontal document scroll');
      assert(stacked.pageHeight > stacked.viewportHeight, 'The restored stack can scroll as an ordinary mobile page');
      assert.equal(await page.locator('[data-column-resizer="storyboard"]').isVisible(), false);
      assert.equal(await page.locator('[data-column-resizer="wiki"]').isVisible(), false);
    }
    await page.setViewportSize({ width: 1920, height: 900 }); await fits();

    // A hidden heading must not conceal a failed save or its retry action.
    // Reset while a draft is unsaved must preserve the live text as well.
    const saveRoute = '**/scene/*/text';
    let acceptSaves = false;
    await page.route(saveRoute, route => acceptSaves ? route.continue() : route.fulfill({ status: 503, body: 'Unavailable' }));
    for (const mode of ['normal', 'standard-focus', 'typewriter']) {
      if (mode === 'normal') {
        await layout('[data-hide-manuscript-controls]');
        await layout('[data-hide-toolbar]');
      } else {
        await page.locator('[data-focus-toggle]').click();
        await page.locator(`[data-${mode}-toggle]`).click();
      }
      acceptSaves = false;
      const draft = `${original}\nUnsaved ${mode} layout draft.`;
      const saved = await page.evaluate(async text => {
        window.verwrityEditor.setText(text);
        window.dispatchEvent(new CustomEvent('verwrity-editor-change'));
        return window.verwritySaveActiveScene();
      }, draft);
      assert.equal(saved, false);
      assert.equal(await page.locator('[data-save-status]').getAttribute('data-state'), 'error');
      assert(await page.locator('[data-save-status]').isVisible(), `${mode} exposes save failure feedback`);
      assert(await page.locator('[data-retry-save]').isVisible(), `${mode} exposes the retry action`);
      await fits();
      acceptSaves = true;
      await page.locator('[data-retry-save]').click();
      await page.waitForFunction(() => document.querySelector('[data-save-status]').dataset.state === 'saved');
      assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), draft, `${mode} retry works while its controls remain hidden`);
      let expectedDraft = draft;
      if (mode === 'typewriter') {
        expectedDraft += ' Still unsaved.';
        acceptSaves = false;
        assert.equal(await page.evaluate(async text => {
          window.verwrityEditor.setText(text);
          window.dispatchEvent(new CustomEvent('verwrity-editor-change'));
          return window.verwritySaveActiveScene();
        }, expectedDraft), false);
      }
      await workspaceAction('.writing-restore-controls [data-restore-default-layout]');
      assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), expectedDraft, 'Reset keeps live manuscript edits, including an unsaved draft');
      if (mode === 'typewriter') {
        await page.waitForFunction(() => document.querySelector('[data-save-status]').dataset.state === 'error');
        acceptSaves = true;
        await page.locator('[data-retry-save]').click();
        await page.waitForFunction(() => document.querySelector('[data-save-status]').dataset.state === 'saved');
      }
      await page.reload(); await ready(); await fits();
      assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), expectedDraft, 'Retry persists the draft through reload');
      await page.evaluate(async text => {
        window.verwrityEditor.setText(text);
        window.dispatchEvent(new CustomEvent('verwrity-editor-change'));
        await window.verwritySaveActiveScene();
      }, original);
    }
    await page.unroute(saveRoute);
    assert.deepEqual(errors, []);

    const legacyPage = await browser.newPage({ viewport: { width: 1920, height: 900 } });
    await legacyPage.addInitScript(() => localStorage.setItem('verwrity-workspace-layout-v1', JSON.stringify({
      typewriterMode: false, maximized: false,
      normalPanels: { storyboard: true, wiki: false },
      typewriterPanels: { storyboard: false, wiki: true },
    })));
    await legacyPage.goto(url);
    await legacyPage.waitForFunction(() => Boolean(window.verwrityEditor));
    await legacyPage.evaluate(() => document.querySelector('#start-dialog')?.close());
    if (await legacyPage.locator('[data-recovery-dialog]').isVisible()) {
      await legacyPage.locator('[data-recovery-dialog] button').filter({ hasText: 'Continue recovered draft' }).click();
      await legacyPage.waitForFunction(() => !document.querySelector('[data-recovery-dialog]'));
      await legacyPage.waitForFunction(() => Boolean(window.verwrityEditor));
    }
    await legacyPage.locator('[data-focus-toggle]').click();
    await legacyPage.locator('[data-typewriter-toggle]').click();
    assert.equal(await legacyPage.locator('body').getAttribute('data-editor-maximized'), 'true', 'Older layout settings gain the new Typewriter default');
    await workspaceAction('[data-restore-editor]', legacyPage);
    assert(await legacyPage.locator('#storyboard-panel').isVisible(), 'Older Typewriter panel preferences survive migration');
    assert.equal(await legacyPage.locator('#wiki-panel').isVisible(), false);
    await legacyPage.locator('[data-focus-toggle]').click();
    assert.equal(await legacyPage.locator('#storyboard-panel').isVisible(), false, 'Older normal panel preferences also survive');
    assert(await legacyPage.locator('#wiki-panel').isVisible());
    await legacyPage.close();
    console.log('PASS: viewport fit, footer/bars, focus/typewriter restoration, default reset, resizing/reload, stacked mobile, hidden save failure/retry, unsaved text safety, and 4K layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
