"use strict";

(() => {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

  // Subtle GPU-composited cursor sheen on glass surfaces (zero layout reads/writes in editor).
  const sheenSelector = ".toolbar, .story-note, .project-question-dock, .help-principles article, .help-guides article";
  let pendingEvent = null;
  let rafId = 0;

  function applySheen() {
    rafId = 0;
    const event = pendingEvent;
    pendingEvent = null;
    if (!event || reducedMotion?.matches) return;
    const target = event.target?.closest?.(sheenSelector);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    target.style.setProperty("--mx", `${Math.round(event.clientX - rect.left)}px`);
    target.style.setProperty("--my", `${Math.round(event.clientY - rect.top)}px`);
  }

  document.addEventListener("pointermove", (event) => {
    if (reducedMotion?.matches || event.pointerType === "touch") return;
    if (!event.target?.closest?.(sheenSelector)) return;
    pendingEvent = event;
    if (!rafId) rafId = requestAnimationFrame(applySheen);
  }, { passive: true });

  // Highlight active column resizer smoothly during pointer drag.
  document.querySelectorAll("[data-column-resizer]").forEach((resizer) => {
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      resizer.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      const end = () => {
        resizer.classList.remove("is-dragging");
        document.body.classList.remove("is-resizing");
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointerup", end, { passive: true });
      window.addEventListener("pointercancel", end, { passive: true });
    });
  });
})();
