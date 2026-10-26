import { postProgress } from "./ocr-progress.js";
// Explicit tests use saved provider settings and synthetic text/user-chosen audio.
for (const kind of ["llm", "tts", "stt"]) {
  const form = document.querySelector(`[data-ai-${kind}-form]`); if (!form) continue;
  const panel = document.createElement("section"), note = document.createElement("p"), button = document.createElement("button"), status = document.createElement("p");
  button.type = "button"; button.dataset.aiConfigurationTest = kind;
  button.textContent = kind === "stt" ? "Test speech recognition" : `Test ${kind === "tts" ? "voice" : "LLM"}`;
  note.textContent = "Online tests send the sample to your provider. Charges may apply.";
  status.setAttribute("role", "status"); panel.className = "model-test"; panel.append(note, button, status); form.querySelector(".app-dialog-actions").before(panel);
  const input = document.createElement("input"); input.type = "file"; input.accept = "audio/*"; input.hidden = true;
  if (kind === "stt") {
    const custom = document.createElement("button"); custom.type = "button"; custom.textContent = "Test with my audio file"; custom.onclick = () => input.click(); panel.append(custom, input);
  }
  let audioUrl;
  async function test(file) {
    if (!form.reportValidity()) return;
    button.disabled = true; status.textContent = "Testing configuration…";
    try {
      await form.saveConfiguration();
      if (kind === "llm") {
        const result = await postProgress("/ai/models/llm/test", {}, { onProgress: e => { status.textContent = `${e.stage} · ${e.elapsed}s elapsed`; } });
        status.textContent = `${result.matched ? "✓ Test passed" : "Provider responded; inspect its reply"} (${result.model}): ${result.text}`;
      } else {
        if (kind === "stt" && (!file || file.size > 24 * 1024 * 1024)) throw new Error("Choose an audio file up to 24 MiB.");
        const r = await fetch(kind === "tts" ? "/ai/read-answer" : "/ai/transcribe", kind === "tts" ? {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Verwrity voice configuration test. The quick brown fox jumps over the lazy dog." }),
        } : { method: "POST", body: file, headers: { "Content-Type": file.type || "audio/wav" } });
        if (!r.ok) throw new Error((await r.json()).error || "Configuration test failed.");
        if (kind === "stt") status.textContent = `✓ Provider completed the test. Transcript: ${(await r.json()).text || "[No speech recognised]"}`;
        else {
          if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = URL.createObjectURL(await r.blob());
          const audio = document.createElement("audio"); audio.controls = true; audio.src = audioUrl;
          panel.querySelector("audio")?.remove(); panel.append(audio); status.textContent = "✓ Audio generated. Play it to check the saved voice.";
        }
      }
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  }
  button.addEventListener("click", async () => {
    if (kind !== "stt") return test();
    try {
      const response = await fetch("/static/speech-test.wav");
      if (!response.ok) throw new Error("Could not load the speech sample.");
      await test(await response.blob());
    } catch (error) { status.textContent = error.message; }
  });
  input.addEventListener("change", () => { const file = input.files[0]; input.value = ""; if (file) test(file); });
}
