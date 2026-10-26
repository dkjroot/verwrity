"use strict";

(() => {
  const root = document.documentElement;
  const toggle = document.querySelector("[data-theme-toggle]");
  const icon = document.querySelector("[data-theme-icon]");
  const label = document.querySelector("[data-theme-label]");
  const stored = window.localStorage.getItem("verwrity-theme");

  function apply(theme) {
    const dark = theme === "dark";
    root.dataset.theme = dark ? "dark" : "light";
    if (toggle) toggle.setAttribute("aria-pressed", String(dark));
    if (icon) icon.textContent = dark ? "☀" : "☾";
    if (label) label.textContent = dark ? "Light mode" : "Dark mode";
  }

  apply(stored || "dark");
  toggle?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    window.localStorage.setItem("verwrity-theme", next);
    apply(next);
  });
})();
