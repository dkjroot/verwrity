/* Hints yield to wiki work and preserve dismissal across real navigations. */
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = process.env.VERWRITY_TEST_URL || "http://127.0.0.1:8765";
    assert.equal((await (await page.request.get(`${url}/__browser_test__`)).json()).isolated, true);
    await page.request.post(`${url}/__browser_test__/reset`);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("verwrity-workspace-tips-v1")) {
        sessionStorage.setItem("verwrity-workspace-tips-v1", JSON.stringify({ index: 0 }));
      }
    });
    const errors = [];
    const externalRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (new URL(request.url()).origin !== new URL(url).origin) externalRequests.push(request.url());
    });
    await page.goto(url);
    const card = page.locator("[data-workspace-tips]");
    const visible = () => card.waitFor({ state: "visible" });
    const hidden = () => card.waitFor({ state: "hidden" });
    await hidden();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    await visible();
    const sourceText = await page.evaluate(() => window.verwrityEditor.getText());
    const tipHelp = card.locator("[data-tip-help]");
    assert.equal(await tipHelp.getAttribute("href"), "/help#focus");
    assert.equal(await page.locator(".toolbar > .toolbar-link").last().innerText(), "Help");
    // Following a hint must save the active draft before opening its help topic.
    const draftText = `${sourceText}\nA help navigation draft.`;
    await page.route('**/scene/*/text', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.evaluate(value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
    }, draftText);
    await tipHelp.click();
    await page.waitForFunction(() => document.querySelector('[data-save-status]').dataset.state === 'error');
    assert.equal(page.url(), `${url}/`, 'A failed draft save blocks Help navigation');
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), draftText, 'Failed Help navigation retains the live draft');
    await page.unroute('**/scene/*/text');
    await Promise.all([page.waitForURL("**/help#focus"), tipHelp.click()]);
    assert.equal(await page.locator("#focus").evaluate(element => element === document.activeElement), true);
    const topics = page.locator(".help-contents");
    await topics.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await topics.evaluate(element => element.open), true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    assert.equal(await topics.evaluate(element => element.open), false);
    assert.equal(await topics.locator("summary").evaluate(element => element === document.activeElement), true);
    await topics.locator("summary").click();
    await topics.getByRole("link", { name: "Wiki", exact: true }).click();
    await page.waitForURL("**/help#wiki");
    assert.equal(await topics.evaluate(element => element.open), false);
    assert.ok(await page.locator("#wiki").evaluate(element => element.getBoundingClientRect().top >= document.querySelector(".help-contents").getBoundingClientRect().bottom), "The closed topic menu leaves the linked section visible");
    // Every guide stays reachable and readable as the Help inventory grows.
    const topicLinks = await topics.locator("nav a").evaluateAll(links => links.map(link => ({ href: link.getAttribute("href"), text: link.textContent })));
    assert.equal(topicLinks.length, 34);
    for (const id of ['dictation', 'dictate-draft', 'ocr-import', 'speed-reader', 'project-words']) {
      assert(topicLinks.some(topic => topic.href === `#${id}`), `${id} is directly reachable from Help`);
    }
    for (const [width, height] of [[1440, 1000], [390, 600], [320, 600]]) {
      await page.setViewportSize({ width, height });
      for (const topic of topicLinks) {
        await topics.locator("summary").click();
        await topics.getByRole("link", { name: topic.text, exact: true }).click();
        const target = page.locator(topic.href);
        assert.equal(await target.evaluate(element => element === document.activeElement), true, `${topic.href} receives focus at ${width}px`);
        const layout = await target.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, menuTop: document.querySelector('.help-contents').getBoundingClientRect().top,
            menuBottom: document.querySelector('.help-contents').getBoundingClientRect().bottom,
            toolbarBottom: document.querySelector('.help-toolbar').getBoundingClientRect().bottom,
            overflow: document.documentElement.scrollWidth - window.innerWidth, textOverflow: element.scrollWidth - element.clientWidth };
        });
        assert.ok(layout.top >= layout.menuBottom, `${topic.href} is below the closed topic menu at ${width}px`);
        assert.ok(layout.menuTop >= layout.toolbarBottom, `Help topics stay below the toolbar at ${width}px`);
        assert.equal(layout.overflow, 0, `Help fits ${width}px`);
        assert.equal(layout.textOverflow, 0, `${topic.href} text fits ${width}px`);
      }
      if (width === 390 && process.env.VERWRITY_HELP_MOBILE_SCREENSHOT) {
        await topics.locator("summary").click();
        await topics.getByRole("link", { name: "Getting started", exact: true }).click();
        await page.screenshot({ path: process.env.VERWRITY_HELP_MOBILE_SCREENSHOT });
      }
      await page.evaluate(async () => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const pinned = await page.locator('.help-toolbar').evaluate(toolbar => {
        const rect = toolbar.getBoundingClientRect();
        const link = toolbar.querySelector('a');
        const back = link.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, linkTop: back.top, linkBottom: back.bottom,
          height: innerHeight, scroll: scrollY,
          clickable: link.contains(document.elementFromPoint(back.x + back.width / 2, back.y + back.height / 2)) };
      });
      assert(pinned.scroll > height, `Help has scrolled well beyond its header at ${width}px`);
      assert.equal(pinned.top, 0, `Help toolbar stays at the top at ${width}px`);
      assert(pinned.linkTop >= 0 && pinned.linkBottom <= pinned.height && pinned.clickable,
        `Back to your story remains visible and clickable after scrolling at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await Promise.all([page.waitForURL(`${url}/`), page.locator("header").getByRole("link", { name: "Back to your story", exact: true }).click()]);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await page.waitForFunction(() => Boolean(window.verwrityEditor));
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), draftText, "Help navigation preserves unsaved manuscript edits");
    await page.evaluate(async value => {
      window.verwrityEditor.setText(value);
      window.dispatchEvent(new CustomEvent("verwrity-editor-change", { detail: { text: value } }));
      await window.verwritySaveActiveScene();
    }, sourceText);
    await visible();
    const bounds = await page.evaluate(() => {
      const panel = document.querySelector("[data-wiki-panel]");
      const wiki = document.querySelector("[data-wiki-content]").getBoundingClientRect();
      const tip = document.querySelector("[data-workspace-tips]").getBoundingClientRect();
      return { gap: tip.top - wiki.bottom, inside: tip.bottom <= panel.getBoundingClientRect().bottom,
        scroll: panel.scrollHeight - panel.clientHeight };
    });
    assert.ok(bounds.gap >= 24 && bounds.inside, `The card uses spare room: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.scroll, 0, "Hints never add wiki scrolling");
    if (process.env.VERWRITY_TIPS_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_TIPS_SCREENSHOT });

    // Laptop columns can fit a compact card just below the former 220px floor.
    // Still hide it when wrapping needs more height than the spare space allows.
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.evaluate(() => {
      document.querySelector('[data-workspace]').style.setProperty('--wiki-width', '420px');
      const panel = document.querySelector('[data-wiki-panel]');
      const content = panel.querySelector('[data-wiki-content]');
      content.style.minHeight = `${panel.clientHeight - 16 - content.offsetTop - 210}px`;
    });
    await visible();
    const compactBounds = await page.evaluate(() => {
      const panel = document.querySelector('[data-wiki-panel]');
      const wiki = panel.querySelector('[data-wiki-content]').getBoundingClientRect();
      const tip = panel.querySelector('[data-workspace-tips]');
      return { gap: tip.getBoundingClientRect().top - wiki.bottom,
        width: panel.clientWidth, scroll: panel.scrollHeight - panel.clientHeight,
        textOverflow: tip.scrollWidth - tip.clientWidth };
    });
    assert.equal(compactBounds.width, 420);
    if (process.env.VERWRITY_TIPS_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_TIPS_SCREENSHOT.replace(/\.png$/, '-compact.png') });
    assert(compactBounds.gap >= 24, `Compact cards retain clear space below wiki content: ${JSON.stringify(compactBounds)}`);
    assert.equal(compactBounds.scroll, 0, 'Compact cards add no wiki scrollbar');
    assert.equal(compactBounds.textOverflow, 0, 'Compact card content fits its width');
    await page.evaluate(() => document.querySelector('[data-workspace]').style.setProperty('--wiki-width', '320px'));
    await hidden();
    await page.evaluate(() => {
      document.querySelector('[data-workspace]').style.removeProperty('--wiki-width');
      document.querySelector('[data-wiki-content]').style.removeProperty('min-height');
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visible();

    const next = card.locator("[data-tip-next]");
    const deckSize = await page.locator("template[data-workspace-tip]").count();
    assert.equal(deckSize, 36);
    for (let index = 0; index < deckSize; index += 1) {
      await next.click();
      await visible();
      assert.equal(await card.evaluate(element => element.scrollWidth - element.clientWidth), 0, 'Every tip fits the wiki column');
      assert.equal(await page.locator('[data-wiki-panel]').evaluate(element => element.scrollHeight - element.clientHeight), 0, 'No tip adds wiki scrolling');
    }
    assert.equal(await tipHelp.getAttribute("href"), "/help#focus", 'Cycling the whole deck returns to the first tip');
    for (let index = 1; index <= 4; index += 1) {
      await next.click();
      await visible();
      assert.equal(await card.locator("[data-tip-kicker]").textContent(), index === 3 ? "Support the developer" : "Did you know?");
      if (index === 3) {
        for (const link of await card.locator(".workspace-support-links a").all()) {
          assert.ok((await link.getAttribute("href")).startsWith("https://"));
          assert.equal(await link.getAttribute("target"), "_blank");
          assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
        }
        if (process.env.VERWRITY_SUPPORT_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_SUPPORT_SCREENSHOT });
        assert.equal(await tipHelp.getAttribute("href"), "/help#support");
        assert.equal(await tipHelp.textContent(), "Ways to support");
        await Promise.all([page.waitForURL("**/help#support"), tipHelp.click()]);
        assert.equal(await page.locator("#support").evaluate(element => element === document.activeElement), true);
        assert.equal(await page.locator("#support h3").count(), 1);
        assert.equal(await page.locator("#support h3").textContent(), "Buy me a coffee");
        assert.equal(await page.locator("#support .help-guides article .help-support-links a").count(), 1,
          "The support link belongs inside its description card");
        assert.equal(await page.locator("#support .help-guides article .help-support-links a").getAttribute("href"), "https://buymeacoffee.com/dkjroot");
        assert.doesNotMatch(await page.locator("#support").textContent(), /Patreon|Kickstarter/);
        if (process.env.VERWRITY_HELP_SCREENSHOT) await page.screenshot({ path: process.env.VERWRITY_HELP_SCREENSHOT });
        await Promise.all([page.waitForURL(`${url}/`), page.locator("header").getByRole("link", { name: "Back to your story", exact: true }).click()]);
        await page.evaluate(() => document.querySelector("#start-dialog")?.close());
        await page.waitForFunction(() => Boolean(window.verwrityEditor));
        await visible();
        assert.equal(await tipHelp.getAttribute("href"), "/help#support", "Returning from help retains the current tip");
        assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), sourceText);
      }
    }

    // A real page can be read with hints, but its editor always takes precedence.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("verwrity-open-wiki-page", {
      detail: document.querySelector("template[data-wiki-page]").dataset.wikiPage,
    })));
    await visible();
    await page.getByRole("button", { name: "Edit page", exact: true }).click();
    await hidden();
    await page.locator("[data-wiki-page-editor]").getByRole("button", { name: "Cancel edit", exact: true }).click();
    await visible();
    await page.locator("[data-wiki-search]").focus();
    await hidden();
    await page.locator("[data-wiki-search]").fill("Characters");
    await page.locator("[data-wiki-search]").fill("");
    await page.locator("[data-wiki-search]").evaluate(element => element.blur());
    await visible();

    // Wiki growth, panel resizing, and viewport changes cannot be resisted by a card.
    await page.evaluate(() => {
      const pageBody = document.querySelector(".wiki-page-body");
      pageBody.dataset.original = pageBody.innerHTML;
      pageBody.textContent = "A long story note. ".repeat(300);
    });
    await hidden();
    await page.evaluate(() => {
      const pageBody = document.querySelector(".wiki-page-body");
      pageBody.innerHTML = pageBody.dataset.original;
      document.querySelector("[data-wiki-panel]").scrollTop = 0;
    });
    await visible();
    await page.setViewportSize({ width: 1440, height: 600 });
    await hidden();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visible();
    await page.setViewportSize({ width: 760, height: 1000 });
    await hidden();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await visible();
    await page.locator("[data-panel-toggle='wiki']").click();
    await hidden();
    await page.locator("[data-panel-toggle='wiki']").click();
    await visible();
    await page.evaluate(() => document.querySelector("#add-scene-dialog").showModal());
    await hidden();
    await page.evaluate(() => document.querySelector("#add-scene-dialog").close());
    await visible();
    assert.equal(await page.evaluate(() => window.verwrityEditor.getText()), sourceText, "Hints, rotation, and geometry never modify prose");

    await Promise.all([
      page.waitForNavigation(),
      page.getByRole("button", { name: "The discovery", exact: true }).click(),
    ]);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await visible();
    await card.locator("[data-tip-dismiss]").click();
    await hidden();
    await page.goBack();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await hidden();
    await page.goForward();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await hidden();
    await Promise.all([
      page.waitForNavigation(),
      page.getByRole("button", { name: "Opening", exact: true }).click(),
    ]);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await hidden();
    await page.goto(`${url}/storyboard`);
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await hidden();
    await page.reload();
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await visible();
    await card.locator("[data-tip-dismiss]").click();
    await page.goto(`${url}/help`);
    await page.reload();
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await visible();

    // Playwright's clock replaces Performance navigation entries. Install it only
    // after real reload checks, and navigate so the new card timers use the clock.
    await page.clock.install({ time: new Date("2026-10-02T12:00:00") });
    await page.goto(url);
    await page.evaluate(() => document.querySelector("#start-dialog")?.close());
    await visible();
    await card.locator("[data-tip-dismiss]").click();
    await hidden();
    await page.clock.setSystemTime(new Date("2026-10-03T12:00:00"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.runFor(50);
    await visible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    // Advancing a minute instantly can time out real HTTP requests before they
    // run. Settle reachability probes between steps shorter than their timeout.
    const advanceIdleClock = async duration => {
      await page.evaluate(() => window.verwrityServerConnection.check());
      while (duration > 0) {
        const step = Math.min(duration, 3000);
        await page.clock.runFor(step);
        await page.evaluate(() => window.verwrityServerConnection.check());
        duration -= step;
      }
    };
    const title = await card.locator("h3").innerText();
    await advanceIdleClock(60_100);
    assert.notEqual(await card.locator("h3").innerText(), title, "Visible idle cards rotate once a minute");
    await next.focus();
    const pausedTitle = await card.locator("h3").innerText();
    await advanceIdleClock(60_100);
    assert.equal(await card.locator("h3").innerText(), pausedTitle, "Rotation pauses while a card control has focus");
    assert.deepEqual(externalRequests, [], "Hints make no external requests");
    assert.deepEqual(errors, [], "No browser errors");
    console.log("PASS: wiki spare-space hints, relevant help/support topics, keyboard menu, draft-safe navigation, support frequency, editing/search, resizing, dismissal/navigation/reload, daily return, idle rotation, and manuscript safety.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
