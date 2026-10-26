// Physical dimensions at 96 CSS pixels/inch. Zoom scales paper, margins and type together.
const PAPER_SIZES = {
  a4: { pageWidth: 794, pageHeight: 1123, marginTop: 76, marginBottom: 76, marginLeft: 76, marginRight: 76 },
  letter: { pageWidth: 816, pageHeight: 1056, marginTop: 76, marginBottom: 76, marginLeft: 76, marginRight: 76 },
  "six-nine": { pageWidth: 576, pageHeight: 864, marginTop: 72, marginBottom: 72, marginLeft: 58, marginRight: 58 },
  "five-five-eight-five": { pageWidth: 528, pageHeight: 816, marginTop: 68, marginBottom: 68, marginLeft: 53, marginRight: 53 },
};
const DEFAULT_VIEW = { mode: "continuous", size: "a4", layout: "single", fit: "width" };
const DEFAULT_MANUSCRIPT = { font_family: "sans-serif", font_size: 16, text_color: "auto", background_color: "auto" };

function colorControlValue(key, value) {
  if (value !== "auto") return value;
  const variable = key === "text_color" ? "--text" : "--surface";
  const color = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000";
}

function loadPreferences() {
  const preferences = { ...DEFAULT_VIEW };
  try {
    const saved = JSON.parse(localStorage.getItem("verwrity-writing-view"));
    const allowed = { mode: ["continuous", "pages"], size: Object.keys(PAPER_SIZES), layout: ["single", "spread"], fit: ["width", "height"] };
    for (const key of Object.keys(allowed)) {
      if (allowed[key].includes(saved?.[key])) preferences[key] = saved[key];
    }
  } catch (_) { /* Preferences are optional; the editor must work without storage. */ }
  return preferences;
}

export class WritingView {
  constructor(editor, panel) {
    this.editor = editor;
    this.panel = panel;
    this.viewport = panel.querySelector("[data-editor-viewport]");
    this.stage = panel.querySelector("[data-editor-stage]");
    this.overviewMap = panel.querySelector("[data-text-overview-map]");
    this.overviewCount = panel.querySelector("[data-text-overview-count]");
    this.overviewViewport = document.createElement("span");
    this.overviewViewport.className = "text-overview-viewport";
    this.overviewMap.append(this.overviewViewport);
    this.spreadNumbers = document.createElement("div");
    this.spreadNumbers.className = "spread-page-numbers";
    this.stage.append(this.spreadNumbers);
    this.preferences = loadPreferences();
    this.manuscriptSettings = { ...DEFAULT_MANUSCRIPT };
    this.manuscriptSettingsChanged = false;
    this.manuscriptSaveQueue = Promise.resolve();
    this.controls = {
      mode: panel.querySelector("select[data-view-mode]"),
      size: panel.querySelector("select[data-page-size]"),
      layout: panel.querySelector("select[data-page-layout]"),
    };
    this.listeners = new AbortController();
    const options = { signal: this.listeners.signal };
    this.manuscriptControls = Object.fromEntries(
      Object.keys(DEFAULT_MANUSCRIPT).map((key) => [key, panel.querySelector(`[data-manuscript-setting="${key}"]`)]),
    );
    for (const [key, control] of Object.entries(this.manuscriptControls)) {
      control.addEventListener("change", () => {
        this.manuscriptSettingsChanged = true;
        this.manuscriptSettings[key] = key === "font_size" ? Number(control.value) : control.value;
        this.apply();
        this.saveManuscriptSetting(key);
      }, options);
      control.value = key.includes("color") ? colorControlValue(key, this.manuscriptSettings[key]) : String(this.manuscriptSettings[key]);
    }
    fetch("/preferences/manuscript", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not load manuscript preferences")))
      .then((settings) => {
        if (editor.isDestroyed || this.manuscriptSettingsChanged) return;
        this.manuscriptSettings = { ...DEFAULT_MANUSCRIPT, ...settings };
        for (const [key, control] of Object.entries(this.manuscriptControls)) {
          control.value = key.includes("color") ? colorControlValue(key, this.manuscriptSettings[key]) : String(this.manuscriptSettings[key]);
        }
        this.apply();
      })
      .catch(() => {});
    // Wrapped columns keep native selection, keyboard movement and scrolling in
    // one document. Older engines retain the working single-page presentation.
    const supportsSpreads = CSS.supports("column-height", "1px") && CSS.supports("column-wrap", "wrap");
    if (!supportsSpreads) {
      this.controls.layout.querySelector('option[value="spread"]').disabled = true;
      this.preferences.layout = "single";
      panel.querySelector("[data-spread-unavailable]").hidden = false;
    }
    this.fitButtons = [...panel.querySelectorAll("button[data-fit-view]")];
    for (const [key, control] of Object.entries(this.controls)) {
      control.value = this.preferences[key];
      control.addEventListener("change", () => {
        this.preferences[key] = control.value;
        this.apply();
      }, options);
    }
    for (const button of this.fitButtons) {
      button.addEventListener("click", () => {
        this.preferences.fit = button.dataset.fitView;
        this.apply();
      }, options);
    }
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(this.viewport);
    this.themeObserver = new MutationObserver(() => {
      for (const [key, control] of Object.entries(this.manuscriptControls)) {
        if (key.includes("color") && this.manuscriptSettings[key] === "auto") control.value = colorControlValue(key, "auto");
      }
      this.schedule();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    this.editor.on("update", () => this.scheduleOverview());
    this.overviewMap.addEventListener("click", (event) => this.navigateOverview(event));
    this.updateOverview();
    this.viewport.addEventListener("scroll", () => this.updateOverviewViewport(), { signal: options.signal });
    this.apply();
    document.fonts.ready.then(() => { if (!editor.isDestroyed) this.schedule(); });
  }

  updateOverview() {
    if (!this.overviewMap || this.editor.isDestroyed) return;
    const paragraphs = [...this.editor.view.dom.querySelectorAll("p")];
    this.overviewMap.replaceChildren();
    let lineCount = 0;
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const lines = this.renderedLines(paragraph);
      for (const [lineIndex, line] of lines.entries()) {
        const bar = document.createElement("span");
        bar.className = "text-overview-line";
        bar.dataset.paragraphIndex = String(paragraphIndex);
        bar.dataset.lineIndex = String(lineIndex);
        bar.style.width = `${Math.max(8, Math.min(100, line.width))}%`;
        bar.title = `Paragraph ${paragraphIndex + 1}, line ${lineIndex + 1}`;
        this.overviewMap.append(bar);
        lineCount += 1;
      }
      const gap = document.createElement("span");
      gap.className = "text-overview-gap";
      this.overviewMap.append(gap);
    }
    this.overviewCount.textContent = `${lineCount} lines · ${paragraphs.length} ${paragraphs.length === 1 ? "paragraph" : "paragraphs"}`;
    this.overviewMap.append(this.overviewViewport);
    this.updateOverviewViewport();
    cancelAnimationFrame(this.pageNumberFrame);
    this.pageNumberFrame = requestAnimationFrame(() => this.updatePageNumbers());
  }

  renderedLines(paragraph) {
    const stageRect = this.stage.getBoundingClientRect();
    const paragraphWidth = paragraph.getBoundingClientRect().width;
    const columnWidth = parseFloat(this.stage.style.getPropertyValue("--column-width")) || paragraphWidth || 1;
    const columnGap = parseFloat(this.stage.style.getPropertyValue("--column-gap")) || 0;
    const spread = this.stage.dataset.layout === "spread";
    const lines = [];
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const column = spread ? Math.max(0, Math.floor((rect.left - stageRect.left) / (columnWidth + columnGap))) : 0;
        const existing = lines.find((line) => line.column === column && Math.abs(line.top - rect.top) < 2);
        if (existing) {
          existing.left = Math.min(existing.left, rect.left);
          existing.right = Math.max(existing.right, rect.right);
        } else {
          lines.push({ column, top: rect.top, left: rect.left, right: rect.right });
        }
      }
    }
    if (!lines.length) return [{ width: 8, column: 0, top: 0 }];
    return lines.map((line) => ({
      width: Math.max(8, Math.min(100, ((line.right - line.left) / columnWidth) * 100)),
      column: line.column,
      top: line.top,
    }));
  }

  scheduleOverview() {
    cancelAnimationFrame(this.overviewFrame);
    this.overviewFrame = requestAnimationFrame(() => this.updateOverview());
  }

  updateOverviewViewport() {
    if (!this.overviewViewport || !this.overviewMap) return;
    const range = this.viewport.scrollHeight - this.viewport.clientHeight;
    const visible = Math.max(8, Math.min(100, this.viewport.clientHeight / Math.max(this.viewport.scrollHeight, 1) * 100));
    this.overviewViewport.style.height = `${visible}%`;
    this.overviewViewport.style.top = `${range ? (this.viewport.scrollTop / range) * (100 - visible) : 0}%`;
  }

  updatePageNumbers() {
    const wordCount = (text) => (text.match(/\S+/gu) || []).length;
    const sceneWordCount = wordCount(this.editor.getText({ blockSeparator: "\n\n" }));
    const counts = [];
    const footers = [...this.editor.view.dom.querySelectorAll(".rm-page-break .rm-page-footer")];
    const footerTops = footers.map((footer) => footer.getBoundingClientRect().top);
    const stageRect = this.stage.getBoundingClientRect();
    const paperHeight = parseFloat(this.stage.style.getPropertyValue("--paper-height")) || 1;
    const paperWidth = parseFloat(this.stage.style.getPropertyValue("--paper-width")) || 1;
    const gap = parseFloat(this.stage.style.getPropertyValue("--paper-gap")) || 0;
    const spread = this.stage.dataset.layout === "spread";
    const paragraphs = this.editor.view.dom.querySelectorAll("p");
    for (const paragraph of paragraphs) {
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const words = /\S+/gu;
        for (const match of node.textContent.matchAll(words)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const rect = range.getBoundingClientRect();
          if (!rect.height) continue;
          let pageIndex;
          if (spread) {
            const row = Math.max(0, Math.floor((rect.top - stageRect.top) / (paperHeight + gap)));
            const column = Math.max(0, Math.min(1, Math.floor((rect.left - stageRect.left) / (paperWidth + gap))));
            pageIndex = row * 2 + column;
          } else if (this.stage.dataset.layout === "single" && footers.length) {
            pageIndex = footerTops.filter((top) => top < rect.top).length;
          } else {
            const editorTop = this.editor.view.dom.getBoundingClientRect().top;
            pageIndex = Math.max(0, Math.floor((rect.top - editorTop) / (paperHeight + gap)));
          }
          counts[pageIndex] = (counts[pageIndex] || 0) + 1;
        }
      }
    }
    const countStatus = this.panel.querySelector("[data-writing-count-status]");
    if (countStatus) {
      const continuous = this.preferences.mode !== "pages";
      countStatus.textContent = continuous ? `1 / ${sceneWordCount}` : "";
      countStatus.title = continuous ? "Page number / words in this scene" : "";
    }
    if (this.stage.dataset.layout === "spread") {
      // The track includes the top and bottom margins of every complete paper
      // row. The ProseMirror element's scrollHeight does not, so it can count
      // the final row incorrectly when the text is close to a page boundary.
      const trackHeight = this.stage.querySelector("[data-editor-track]").getBoundingClientRect().height;
      const rows = Math.max(1, Math.round((trackHeight + gap) / (paperHeight + gap)));
      this.spreadNumbers.replaceChildren();
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < 2; column++) {
          const number = document.createElement("span");
          const pageIndex = row * 2 + column;
          const pageWords = counts[pageIndex] || 0;
          number.textContent = `${pageIndex + 1} / ${pageWords} / ${sceneWordCount}`;
          number.title = `Page ${pageIndex + 1} / ${pageWords} words on this page / ${sceneWordCount} words in this scene`;
          number.style.left = `${column * (paperWidth + gap) + paperWidth / 2}px`;
          number.style.top = `${row * (paperHeight + gap) + paperHeight - parseFloat(this.stage.style.getPropertyValue("--paper-bottom")) / 2}px`;
          this.spreadNumbers.append(number);
        }
      }
      return;
    }
    this.spreadNumbers.replaceChildren();
    if (this.stage.dataset.layout !== "single") return;
    this.editor.view.dom.querySelectorAll(".rm-page-break .rm-page-footer").forEach((footer, index) => {
      const number = footer.querySelector(".rm-page-number");
      if (number) number.textContent = String(index + 1);
      const pageCount = footer.querySelector(".verwrity-page-word-count");
      const sceneCount = footer.querySelector(".verwrity-scene-word-count");
      const pageWords = counts[index] || 0;
      if (pageCount) { pageCount.textContent = String(pageWords); pageCount.title = `Words on page ${index + 1}`; }
      if (sceneCount) { sceneCount.textContent = String(sceneWordCount); sceneCount.title = "Words in this scene"; }
    });
  }

  navigateOverview(event) {
    const lines = [...this.overviewMap.querySelectorAll(".text-overview-line")];
    const bounds = this.overviewMap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    const target = event.target.closest(".text-overview-line") || lines[Math.min(lines.length - 1, Math.floor(ratio * lines.length))];
    if (!target) return;
    const paragraphIndex = Number(target.dataset.paragraphIndex);
    const paragraphs = [...this.editor.view.dom.querySelectorAll("p")];
    const paragraph = paragraphs[paragraphIndex];
    if (!paragraph) return;
    const position = this.editor.view.posAtDOM(paragraph, 0);
    this.editor.commands.setTextSelection(position);
    this.editor.commands.focus();
    this.editor.view.dispatch(this.editor.state.tr.scrollIntoView());
  }

  schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.apply());
  }

  saveManuscriptSetting(key) {
    const value = { [key]: this.manuscriptSettings[key] };
    this.manuscriptSaveQueue = this.manuscriptSaveQueue.catch(() => {}).then(() => fetch("/preferences/manuscript", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    }));
  }

  apply() {
    const { mode, size, layout, fit } = this.preferences;
    const paged = mode === "pages";
    const spread = paged && layout === "spread";
    const previousLayout = this.stage.dataset.layout;
    this.stage.dataset.layout = !paged ? "continuous" : layout;
    this.controls.size.disabled = !paged;
    this.controls.layout.disabled = !paged;
    for (const button of this.fitButtons) {
      button.disabled = !paged;
      button.setAttribute("aria-pressed", String(button.dataset.fitView === fit));
    }

    const viewportStyle = getComputedStyle(this.viewport);
    // clientWidth excludes the reserved scrollbar. Subtract padding only once.
    const width = Math.max(1, this.viewport.clientWidth - parseFloat(viewportStyle.paddingLeft) - parseFloat(viewportStyle.paddingRight) - 1);
    const height = Math.max(1, this.viewport.clientHeight - parseFloat(viewportStyle.paddingTop) - parseFloat(viewportStyle.paddingBottom) - 1);
    const paper = PAPER_SIZES[size];
    const gap = 24;
    const naturalWidth = spread ? paper.pageWidth * 2 + gap : paper.pageWidth;
    const scale = !paged ? 1 : Math.min(width / naturalWidth, fit === "height" ? height / paper.pageHeight : Infinity);
    const dimensions = Object.fromEntries(Object.entries(paper).map(([key, value]) => [key, value * scale]));
    const style = this.stage.style;
    const variables = {
      "paper-width": dimensions.pageWidth,
      "paper-height": dimensions.pageHeight,
      "paper-gap": gap * scale,
      "paper-left": dimensions.marginLeft,
      "paper-top": dimensions.marginTop,
      "paper-bottom": dimensions.marginBottom,
      "column-width": dimensions.pageWidth - dimensions.marginLeft - dimensions.marginRight,
      "column-height": dimensions.pageHeight - dimensions.marginTop - dimensions.marginBottom,
      "column-gap": dimensions.marginLeft + dimensions.marginRight + gap * scale,
      "row-gap": dimensions.marginTop + dimensions.marginBottom + gap * scale,
      "view-width": paged ? naturalWidth * scale : width,
      "view-height": height,
      "editor-font-size": this.manuscriptSettings.font_size * scale,
      "editor-line-height": this.manuscriptSettings.font_size * 1.75 * scale,
    };
    for (const [name, value] of Object.entries(variables)) style.setProperty(`--${name}`, `${value}px`);
    style.setProperty("--manuscript-font-family", this.manuscriptSettings.font_family);
    style.setProperty("--manuscript-text-color", this.manuscriptSettings.text_color === "auto" ? "var(--text)" : this.manuscriptSettings.text_color);
    style.setProperty("--manuscript-background", this.manuscriptSettings.background_color === "auto" ? "var(--surface)" : this.manuscriptSettings.background_color);

    // Changing views is presentation only: one transaction updates the pagination
    // plugin's options without modifying manuscript nodes or creating undo entries.
    const chain = this.editor.chain()
      .updatePageSize(dimensions)
      .updatePageGap(gap * scale)
      .updateContentMargins({ top: 0, bottom: 0 })
      .updatePageBreakBackground(viewportStyle.backgroundColor);
    chain[paged && !spread ? "enablePagination" : "disablePagination"]().run();
    // The extension measures during a transaction, before the new paper geometry
    // has settled. Re-measure next frame so the final text is paginated immediately.
    cancelAnimationFrame(this.paginationFrame);
    cancelAnimationFrame(this.pageNumberFrame);
    if (paged) {
      this.paginationFrame = requestAnimationFrame(() => {
        if (!spread) this.editor.view.dispatch(this.editor.state.tr.setMeta("verwrity-layout", true));
        this.updateOverview();
        this.updatePageNumbers();
        this.updateOverviewViewport();
      });
    } else {
      this.updateOverview();
      this.updatePageNumbers();
      this.updateOverviewViewport();
    }
    if (previousLayout !== this.stage.dataset.layout) this.viewport.scrollTop = 0;
    try { localStorage.setItem("verwrity-writing-view", JSON.stringify(this.preferences)); } catch (_) { /* Optional. */ }
  }

  scrollToSelection() {
    if (this.stage.dataset.layout !== "spread") return false;
    this.scrollCaretIntoView();
    // Native column fragmentation can settle after ProseMirror's transaction.
    // Follow the resulting caret once more after layout, only for an explicit
    // editor scroll request; ordinary reading/scrolling never moves the viewport.
    cancelAnimationFrame(this.caretFrame);
    cancelAnimationFrame(this.overviewFrame);
    this.caretFrame = requestAnimationFrame(() => {
      if (this.editor.isFocused && this.stage.dataset.layout === "spread") this.scrollCaretIntoView();
    });
    return true;
  }

  scrollCaretIntoView() {
    const selection = document.getSelection();
    if (!selection?.focusNode || !this.editor.view.dom.contains(selection.focusNode)) return;
    // Measure the native caret in its column fragment. There is no page-index
    // calculation or selection-change listener that can pull a reader backwards.
    const range = document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    const cursor = range.getClientRects()[0] || this.editor.view.coordsAtPos(this.editor.state.selection.head);
    const viewport = this.viewport.getBoundingClientRect();
    if (cursor.top < viewport.top + 10) this.viewport.scrollTop += cursor.top - viewport.top - 10;
    else if (cursor.bottom > viewport.bottom - 10) this.viewport.scrollTop += cursor.bottom - viewport.bottom + 10;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.paginationFrame);
    cancelAnimationFrame(this.pageNumberFrame);
    cancelAnimationFrame(this.caretFrame);
    this.listeners.abort();
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
  }
}
