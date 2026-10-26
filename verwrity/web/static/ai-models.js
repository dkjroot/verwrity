"use strict";

const modelsDialog = document.querySelector("#ai-models-dialog");
const modelsForm = document.querySelector("[data-ai-tts-form]");
const settingsStatus = document.querySelector("[data-ai-settings-status]");
const llmForm = document.querySelector("[data-ai-llm-form]");
const llmStatus = document.querySelector("[data-llm-settings-status]");
const llmStandards = new Map();
const providerSelect = document.querySelector("[data-ai-provider]");
const localFields = document.querySelector("[data-ai-local-fields]");
const remoteFields = document.querySelector("[data-ai-remote-fields]");
const googleKeyFields = document.querySelector("[data-google-key-fields]");
const googleVoiceFields = document.querySelector("[data-google-voice-fields]");
const edgeFields = document.querySelector("[data-edge-fields]");
const providerDisclosure = document.querySelector("[data-provider-disclosure]");
const providerConsentLabel = document.querySelector("[data-provider-consent-label]");
const downloadOffer = document.querySelector("[data-kokoro-download-offer]");
const downloadStatus = document.querySelector("[data-kokoro-download-status]");
const readButton = document.querySelector("[data-read-scene]");
const audioPlayer = document.querySelector("[data-scene-audio]");
const audioPlayback = document.querySelector("[data-scene-audio-playback]");
const audioProcessingStatus = document.querySelector("[data-scene-audio-status]");
const audioProcessingMessage = document.querySelector("[data-scene-audio-message]");
let kokoroReady = false;
let downloadOfferDismissed = false;
let audioUrl = null;
let audioContext = null;
let audioMediaSource = null;

async function activateAudioOutput() {
  if (!(window.AudioContext || window.webkitAudioContext)) return Promise.resolve(null);
  try {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioContextClass();
    }
    await audioContext.resume();
    if (audioContext.state !== "running") return null;
    if (!audioMediaSource) {
      audioMediaSource = audioContext.createMediaElementSource(audioPlayer);
      const startupDelay = audioContext.createDelay(0.3);
      startupDelay.delayTime.value = 0.25;
      audioMediaSource.connect(startupDelay).connect(audioContext.destination);
    }
    return audioContext;
  } catch (error) {
    console.warn("Audio output buffering is unavailable in this browser.", error);
    return Promise.resolve(null);
  }
}

async function warmAudioOutput(context) {
  if (!context) return;
  const oscillator = context.createOscillator();
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  oscillator.connect(silentGain).connect(context.destination);
  oscillator.start();
  await new Promise(resolve => window.setTimeout(resolve, 250));
  oscillator.stop();
}

function waitForAudioReady(player) {
  if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Audio took too long to load.")), 20000);
    const finish = (error) => {
      window.clearTimeout(timeout);
      player.removeEventListener("canplay", onCanPlay);
      player.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onCanPlay = () => finish();
    const onError = () => finish(new Error("The generated audio could not be loaded."));
    player.addEventListener("canplay", onCanPlay, { once: true });
    player.addEventListener("error", onError, { once: true });
    if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) finish();
  });
}

function clearSceneAudio() {
  audioPlayer.pause();
  audioPlayer.removeAttribute("src");
  audioPlayer.load();
  audioPlayback.hidden = true;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = null;
}

window.verwrityPlayAudioBlob = async (blob) => {
  const audioOutputPromise = activateAudioOutput();
  const previousUrl = audioUrl;
  audioUrl = URL.createObjectURL(blob);
  audioPlayer.pause();
  audioPlayer.src = audioUrl;
  audioPlayer.load();
  audioPlayback.hidden = false;
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  try {
    await waitForAudioReady(audioPlayer);
    audioPlayer.currentTime = 0;
    await warmAudioOutput(await audioOutputPromise);
    await audioPlayer.play();
    return true;
  } catch (_) {
    return false;
  }
};

document.querySelector("[data-clear-scene-audio]")?.addEventListener("click", clearSceneAudio);

function setProviderFields() {
  const provider = providerSelect.value;
  const local = provider === "kokoro_local";
  const google = provider === "google_cloud_tts";
  localFields.hidden = !local;
  remoteFields.hidden = local;
  googleKeyFields.hidden = !google;
  googleVoiceFields.hidden = !google;
  edgeFields.hidden = provider !== "edge_tts";
  providerDisclosure.dataset.processingLocation = local ? "local" : "remote";
  providerDisclosure.textContent = local ? "This model runs on your computer, so text-to-speech stays local."
    : `Your current settings send text over the internet to ${google ? "Google" : "Microsoft"} when you use text-to-speech. This includes LLM answers when Read completed answers aloud is enabled.`;
  providerConsentLabel.textContent = google
    ? "I understand that Google receives the scene or completed LLM answer text that I choose to read aloud. This choice is saved in AI Models."
    : "I understand that Microsoft receives the scene or completed LLM answer text that I choose to read aloud. This choice is saved in AI Models.";
  const hasManualPaths = Boolean(modelsForm.elements.namedItem("model_path").value || modelsForm.elements.namedItem("voices_path").value);
  downloadOffer.hidden = !local;
}

function fillForm(settings) {
  const tts = settings.tts;
  for (const name of ["provider", "voice", "device", "model_path", "voices_path", "google_voice", "edge_voice", "speed"]) {
    const input = modelsForm.elements.namedItem(name);
    if (input && tts[name] !== undefined) input.value = String(tts[name]);
  }
  modelsForm.elements.namedItem("remote_consent").checked = Boolean(tts.remote_consent);
  modelsForm.elements.namedItem("google_api_key").placeholder = tts.google_api_key_configured ? "Saved key; enter a new value to replace" : "Google Cloud API key";
  document.querySelector("[data-ai-speed-value]").textContent = Number(tts.speed).toFixed(1);
  kokoroReady = Boolean(tts.kokoro_model_ready);
  setProviderFields();
}

function isLocalEndpoint(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  } catch (_) { return false; }
}

function updateLLMDisclosure() {
  const endpoint = llmForm.elements.namedItem("endpoint").value.trim();
  const local = isLocalEndpoint(endpoint);
  document.querySelector("[data-llm-consent-row]").hidden = local;
  const disclosure = document.querySelector("[data-llm-disclosure]");
  disclosure.dataset.processingLocation = local ? "local" : "remote";
  disclosure.textContent = local ? "This address points to your own computer, so requests stay local."
    : "Your current settings send the text selected for questions, reviews and manuscript tasks over the internet to this provider.";
  document.querySelector("[data-llm-consent-label]").textContent = "I understand that questions and manuscript tasks send project text to this online endpoint. This choice is saved in AI Models.";
}

function fillLLM(settings) {
  for (const name of ["standard", "endpoint", "model"]) {
    llmForm.elements.namedItem(name).value = settings.llm[name] || "";
  }
  llmForm.elements.namedItem("token").value = "";
  llmForm.elements.namedItem("token").placeholder = settings.llm.token_configured
    ? "Saved token; enter a new value to replace" : "No token needed for many local servers";
  llmForm.elements.namedItem("forget_token").checked = false;
  llmForm.elements.namedItem("remote_consent").checked = Boolean(settings.llm.remote_consent);
  updateLLMDisclosure();
}

function settingsValues() {
  const data = new FormData(modelsForm);
  const values = {
    provider: data.get("provider"), voice: data.get("voice"), device: data.get("device"),
    model_path: data.get("model_path"), voices_path: data.get("voices_path"),
    google_voice: data.get("google_voice"), edge_voice: data.get("edge_voice"), speed: Number(data.get("speed")),
  };
  if (providerSelect.selectedOptions[0].dataset.remote === "true") values.remote_consent = data.get("remote_consent") === "on";
  const key = String(data.get("google_api_key") || "").trim();
  if (providerSelect.value === "google_cloud_tts" && (key || data.get("forget_google_api_key") === "on")) values.google_api_key = key;
  return values;
}

async function saveSettings() {
  const response = await fetch("/ai/models/tts", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsValues()),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not save settings");
  fillForm({ tts: result });
  window.dispatchEvent(new Event("verwrity-voice-values-changed"));
  modelsForm.elements.namedItem("google_api_key").value = "";
  modelsForm.elements.namedItem("forget_google_api_key").checked = false;
  return result;
}

async function loadSettings() {
  settingsStatus.textContent = "Loading settings…";
  downloadOfferDismissed = false;
  try {
    const response = await fetch("/ai/models", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load AI model settings");
    const result = await response.json();
    fillForm(result.settings);
    llmStandards.clear();
    for (const standard of result.capabilities.llm.providers) llmStandards.set(standard.id, standard);
    fillLLM(result.settings);
    window.dispatchEvent(new CustomEvent("verwrity-ai-settings", { detail: result }));
    settingsStatus.textContent = "";
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
}

llmForm?.elements.namedItem("standard")?.addEventListener("change", (event) => {
  const standard = llmStandards.get(event.target.value);
  if (standard) llmForm.elements.namedItem("endpoint").value = standard.default_endpoint;
  llmForm.elements.namedItem("remote_consent").checked = false;
  updateLLMDisclosure();
});
llmForm?.elements.namedItem("endpoint")?.addEventListener("input", () => {
  llmForm.elements.namedItem("remote_consent").checked = false;
  updateLLMDisclosure();
});
llmForm?.elements.namedItem("endpoint")?.addEventListener("blur", (event) => {
  const input = event.currentTarget;
  const value = input.value.trim();
  if (value && !/^https?:\/\//i.test(value) && isLocalEndpoint(`http://${value}`)) {
    input.value = `http://${value}`;
    updateLLMDisclosure();
  }
});
async function saveLLMSettings() {
  llmStatus.textContent = "Saving LLM settings…";
  const data = new FormData(llmForm);
  const values = {
    standard: data.get("standard"), endpoint: data.get("endpoint"), model: data.get("model"),
    remote_consent: isLocalEndpoint(String(data.get("endpoint"))) ? false : data.get("remote_consent") === "on",
    forget_token: data.get("forget_token") === "on",
  };
  const token = String(data.get("token") || "").trim();
  if (token) values.token = token;
  try {
    const response = await fetch("/ai/models/llm", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save LLM settings");
    fillLLM({ llm: result });
    llmForm.elements.namedItem("token").value = "";
    llmStatus.textContent = "LLM settings saved.";
  } catch (error) { llmStatus.textContent = error.message; throw error; }
}
llmForm?.addEventListener("submit", event => { event.preventDefault(); saveLLMSettings().catch(() => {}); });
if (llmForm) llmForm.saveConfiguration = saveLLMSettings;
if (modelsForm) modelsForm.saveConfiguration = saveSettings;

document.querySelector("[data-ai-models-open]")?.addEventListener("click", () => {
  modelsDialog?.showModal();
  loadSettings();
});
document.querySelector("[data-ai-models-close]")?.addEventListener("click", () => modelsDialog?.close());
modelsDialog?.addEventListener("click", (event) => { if (event.target === modelsDialog) modelsDialog.close(); });
providerSelect?.addEventListener("change", () => {
  modelsForm.elements.namedItem("remote_consent").checked = false;
  setProviderFields();
});
for (const name of ["model_path", "voices_path"]) {
  modelsForm?.elements.namedItem(name)?.addEventListener("input", setProviderFields);
}
modelsForm?.elements.namedItem("speed")?.addEventListener("input", (event) => {
  document.querySelector("[data-ai-speed-value]").textContent = Number(event.target.value).toFixed(1);
});
document.querySelectorAll("[data-ai-tab]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-ai-tab]").forEach((tab) => tab.setAttribute("aria-pressed", String(tab === button)));
  document.querySelectorAll("[data-ai-panel]").forEach((panel) => { panel.hidden = panel.dataset.aiPanel !== button.dataset.aiTab; });
}));

modelsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsStatus.textContent = "Saving settings…";
  try {
    await saveSettings();
    settingsStatus.textContent = "Text-to-speech settings saved.";
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
});

document.querySelector("[data-kokoro-manual]")?.addEventListener("click", () => {
  downloadOfferDismissed = true;
  setProviderFields();
  modelsForm.elements.namedItem("model_path").focus();
  downloadStatus.textContent = "Enter paths to your Kokoro model and voice files, then save settings.";
});
document.querySelector("[data-kokoro-defer]")?.addEventListener("click", () => {
  downloadOfferDismissed = true;
  setProviderFields();
  downloadStatus.textContent = "No files were downloaded. You can choose Kokoro files later in AI Models.";
});
document.querySelector("[data-kokoro-download]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  downloadStatus.textContent = "Saving settings before download…";
  try {
    await saveSettings();
    downloadStatus.textContent = "Downloading and verifying about 338 MiB from GitHub…";
    const response = await fetch("/ai/models/tts/kokoro-download", { method: "POST", credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not download Kokoro files");
    fillForm({ tts: result });
  window.dispatchEvent(new Event("verwrity-voice-values-changed"));
    downloadStatus.textContent = "Kokoro files downloaded and verified.";
    settingsStatus.textContent = "Kokoro is ready to use.";
  } catch (error) {
    downloadStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

readButton?.addEventListener("click", async () => {
  const editorElement = document.querySelector("[data-rich-editor]");
  const sceneId = editorElement?.dataset.sceneId;
  const audioOutputPromise = activateAudioOutput();
  if (!sceneId || !(await window.verwritySaveActiveScene?.())) return;
  readButton.disabled = true;
  readButton.textContent = "Preparing audio…";
  audioProcessingStatus.hidden = false;
  audioProcessingMessage.textContent = "Checking provider settings…";
  try {
    const responseSettings = await fetch("/ai/models", { credentials: "same-origin" });
    if (!responseSettings.ok) throw new Error("Could not load AI model settings");
    const { settings } = await responseSettings.json();
    if (settings.tts.provider !== "kokoro_local" && !settings.tts.remote_consent) {
      window.verwrityDialog?.alert("Open AI Models and acknowledge the data disclosure for the selected remote provider first.", { title: "Remote text-to-speech is not configured" });
      return;
    }
    if (settings.tts.provider === "google_cloud_tts" && !settings.tts.google_api_key_configured) {
      window.verwrityDialog?.alert("Open AI Models and save a Google API key first.", { title: "Remote text-to-speech is not configured" });
      return;
    }
    audioProcessingMessage.textContent = "Generating speech for the current scene…";
    const response = await fetch(`/scene/${encodeURIComponent(sceneId)}/read-aloud`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Could not read this scene");
    }
    const blob = await response.blob();
    const previousUrl = audioUrl;
    audioUrl = URL.createObjectURL(blob);
    audioPlayer.pause();
    audioPlayer.src = audioUrl;
    audioPlayer.load();
    audioProcessingMessage.textContent = "Loading audio at the beginning…";
    await waitForAudioReady(audioPlayer);
    audioPlayer.currentTime = 0;
    audioPlayback.hidden = false;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    await warmAudioOutput(await audioOutputPromise);
    await audioPlayer.play();
  } catch (error) {
    window.verwrityDialog?.alert(error.message, { title: "Read scene" });
  } finally {
    audioProcessingStatus.hidden = true;
    readButton.disabled = false;
    readButton.textContent = "Read scene";
  }
});

const voicePresets = {
  voice: [["af_sarah", "Sarah · US · female"], ["af_heart", "Heart · US · female"], ["am_michael", "Michael · US · male"], ["bf_emma", "Emma · UK · female"], ["bm_george", "George · UK · male"]],
  google_voice: [["en-US-Standard-C", "US · female · Standard C"], ["en-US-Standard-D", "US · male · Standard D"], ["en-GB-Standard-A", "UK · female · Standard A"], ["en-GB-Standard-B", "UK · male · Standard B"]],
  edge_voice: [["en-US-AriaNeural", "Aria · US · female"], ["en-US-GuyNeural", "Guy · US · male"], ["en-GB-SoniaNeural", "Sonia · UK · female"], ["en-GB-RyanNeural", "Ryan · UK · male"]],
};
for (const [name, voices] of Object.entries(voicePresets)) {
  const input = modelsForm?.elements[name]; if (!input) continue;
  const label = document.createElement("label"); label.textContent = "Voice preset";
  const select = document.createElement("select"); select.dataset.voicePreset = name;
  select.add(new Option("Custom voice", ""));
  for (const [value, text] of voices) select.add(new Option(text, value));
  label.append(select); input.closest("label").before(label);
  const sync = () => { select.value = voices.some(([value]) => value === input.value) ? input.value : ""; };
  select.addEventListener("change", () => { if (select.value) { input.value = select.value; input.dispatchEvent(new Event("input", { bubbles: true })); } else input.focus(); });
  input.addEventListener("input", sync); window.addEventListener("verwrity-voice-values-changed", sync); window.addEventListener("verwrity-ai-settings", sync); sync();
}
