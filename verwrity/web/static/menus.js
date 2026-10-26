"use strict";

document.querySelectorAll(".notice:not(.error)").forEach((notice, index, notices) => {
  if (index < notices.length - 1) notice.remove();
  else setTimeout(() => notice.remove(), 4500);
});
document.querySelectorAll("[data-dismiss-notice]").forEach((button) => {
  button.addEventListener("click", () => button.closest(".notice")?.remove());
});

const fileDialog = document.querySelector("#file-dialog");
document.querySelector("[data-file-operations]")?.addEventListener("click", () => fileDialog?.showModal());
document.querySelector("[data-close-file-dialog]")?.addEventListener("click", () => fileDialog?.close());
fileDialog?.addEventListener("click", (event) => { if (event.target === fileDialog) fileDialog.close(); });

const dropdownMenus = () => [...document.querySelectorAll(".editor-menu, .focus-menu, .layout-menu, .settings-menu, .writing-restore-controls, .help-contents")];

const helpToolbar = document.querySelector(".help-toolbar");
const helpPage = document.querySelector(".help-page");
if (helpToolbar && helpPage) {
  // The header can wrap on small screens or with larger text. Keep topic
  // navigation and anchor targets clear of its actual height.
  const measureHelpToolbar = () => {
    helpPage.style.setProperty("--help-toolbar-height", `${helpToolbar.getBoundingClientRect().height}px`);
  };
  measureHelpToolbar();
  new ResizeObserver(measureHelpToolbar).observe(helpToolbar);
}
document.querySelector(".help-contents")?.addEventListener("click", (event) => {
  if (event.target.closest("a[href]")) event.currentTarget.open = false;
});
document.addEventListener("click", (event) => {
  dropdownMenus().forEach((menu) => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  dropdownMenus().forEach((menu) => {
    if (menu.open && menu.matches(".writing-restore-controls, .help-contents") && menu.contains(document.activeElement)) {
      // Closing the overlay must not leave keyboard focus in hidden actions.
      menu.querySelector("summary")?.focus();
    }
    menu.open = false;
  });
});
