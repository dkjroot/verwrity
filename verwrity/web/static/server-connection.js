"use strict";

// Observe transport failures centrally so every save path keeps its own error
// handling. Never retry a mutation here: its first request may have been saved.
(() => {
  const dialog = document.querySelector("#server-connection-dialog");
  if (!dialog) return;
  const transport = window.fetch.bind(window);
  const checkButton = dialog.querySelector("[data-check-server]");
  const status = dialog.querySelector("[data-server-status]");
  let unavailable = false;
  let pending;
  let timer;

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(check, unavailable ? 2000 : 5000);
  }

  function reflect(reachable) {
    const wasUnavailable = unavailable;
    unavailable = !reachable;
    if (unavailable) {
      if (!dialog.open) dialog.showModal();
      status.textContent = "Waiting for the server. Checking automatically…";
    } else if (wasUnavailable) {
      dialog.close();
      window.dispatchEvent(new Event("verwrity-server-restored"));
    }
  }

  function check() {
    if (pending) return pending;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    checkButton.disabled = true;
    if (unavailable) status.textContent = "Checking the server…";
    pending = (async () => {
      try {
        // This endpoint does not read/save a project or contact any AI provider.
        const response = await transport("/health", { cache: "no-store", credentials: "same-origin",
          redirect: "error", signal: controller.signal });
        const result = response.ok ? await response.json() : null;
        const reachable = result?.service === "verwrity" && result.status === "ok";
        reflect(reachable);
        return reachable;
      } catch (_) {
        reflect(false);
        return false;
      } finally {
        clearTimeout(timeout);
        pending = undefined;
        checkButton.disabled = false;
        schedule();
      }
    })();
    return pending;
  }

  window.verwrityServerConnection = { check, get unavailable() { return unavailable; } };
  window.fetch = async function (input, options) {
    try {
      return await transport(input, options);
    } catch (error) {
      const signal = options?.signal || (input instanceof Request ? input.signal : null);
      // Author cancellation and remote services are not evidence of a stopped
      // Verwrity server. Confirm same-origin failures with the dedicated probe.
      if (error.name !== "AbortError" && !signal?.aborted) {
        let local = false;
        try { local = new URL(input instanceof Request ? input.url : input, location.href).origin === location.origin; }
        catch (_) { /* Invalid requests retain their ordinary error. */ }
        if (local && !await check()) {
          const failure = new Error("Cannot reach the Verwrity server. Keep this tab open and restart the server; your edits are still here.");
          failure.serverUnavailable = true;
          throw failure;
        }
      }
      throw error;
    }
  };
  dialog.addEventListener("cancel", event => event.preventDefault());
  checkButton.addEventListener("click", check);
  // Prevent known outages from navigating away from browser buffers. Normal
  // save/navigation handlers also check before submitting native forms.
  document.addEventListener("submit", event => {
    if (unavailable && !dialog.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      check();
    }
  }, true);
  for (const event of ["online", "offline", "focus"]) window.addEventListener(event, check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  schedule();
})();
