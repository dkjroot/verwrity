const form = document.querySelector("[data-ai-stt-form]");
const status = document.querySelector("[data-stt-settings-status]");
let defaultDownloadDirectory = "";
let savedTokenEndpoint = "";
const presets = {
  local: { endpoint: "http://localhost:8080/v1", model: "whisper-1" },
  openai: { endpoint: "https://api.openai.com/v1", model: "whisper-1" },
  groq: { endpoint: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
};

function localEndpoint(value) {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    const host = url.hostname.toLowerCase();
    return ["localhost", "[::1]"].includes(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch (_) { return false; }
}

function normalizedEndpoint(value) {
  return value.trim().replace(/\/+$/, "");
}

function keyRequirement() {
  let service = "";
  try { service = { "api.groq.com": "Groq", "api.openai.com": "OpenAI" }[new URL(form.elements.endpoint.value.trim()).hostname] || ""; }
  catch (_) { /* Invalid URLs are checked by the server when saving. */ }
  const offline = form.elements.provider.value === "faster_whisper";
  const saved = savedTokenEndpoint === normalizedEndpoint(form.elements.endpoint.value) && !form.elements.forget_token.checked;
  form.elements.token.required = !offline && Boolean(service) && !saved && !form.elements.forget_token.checked;
  form.elements.token.placeholder = saved ? "Saved key; enter a new value to replace" : "API key / token";
  const label = form.querySelector("[data-stt-token-label]");
  if (label) label.textContent = service ? "API key (required)" : "API key / token (if required by your server)";
  let help = form.querySelector("[data-stt-token-help]");
  if (!help) {
    help = document.createElement("p");
    help.className = "muted"; help.id = "stt-token-help"; help.dataset.sttTokenHelp = "";
    form.elements.token.closest("label").after(help);
    form.elements.token.setAttribute("aria-describedby", help.id);
  }
  help.textContent = service === "Groq"
    ? "Groq requires an API key even on its free tier. Create one in the Groq console and enter it here."
    : service === "OpenAI" ? "OpenAI requires an API key and paid API access."
    : "Local and custom servers may work without a key. Check the server's authentication requirements.";
  if (form.elements.forget_token.checked) help.textContent += " Saving will remove the stored key. Add a key again before using a service that requires one.";
  else if (saved) help.textContent += " A key is already saved for this endpoint.";
}

function disclosure() {
  if (!form) return;
  const offline = form.elements.provider.value === "faster_whisper";
  const local = localEndpoint(form.elements.endpoint.value.trim());
  document.querySelector("[data-stt-local-fields]").hidden = !offline;
  document.querySelector("[data-stt-api-fields]").hidden = offline;
  document.querySelector("[data-stt-consent-row]").hidden = offline || local;
  const notice = document.querySelector("[data-stt-disclosure]");
  notice.dataset.processingLocation = offline || local ? "local" : "remote";
  notice.textContent = offline ? "This model runs on your computer, so speech recognition stays local."
    : local ? "This address points to your own computer, so your recorded audio stays local."
    : "Your current settings send your recorded audio over the internet to this provider.";
  keyRequirement();
}

function fill(value) {
  defaultDownloadDirectory = value.download_directory || "";
  for (const name of ["provider", "model_path", "device", "compute_type", "language", "shortcut", "endpoint", "model"]) {
    form.elements.namedItem(name).value = value[name] ?? "";
  }
  form.elements.model_path.value = value.model_path || defaultDownloadDirectory;
  let folderHelp = form.querySelector("[data-stt-model-folder-help]");
  if (!folderHelp) {
    // Older dialog markup can remain open while a newer script is served.
    folderHelp = document.createElement("p");
    folderHelp.className = "muted";
    folderHelp.id = "stt-model-folder-help";
    folderHelp.dataset.sttModelFolderHelp = "";
    form.elements.model_path.closest("label").after(folderHelp);
    form.elements.model_path.setAttribute("aria-describedby", folderHelp.id);
  }
  folderHelp.textContent = value.model_path
    ? `This is your configured model folder. New model downloads go to ${defaultDownloadDirectory}.`
    : "This is the default download location. After downloading, this box shows the installed model folder. You can also enter a folder containing model files you already have.";
  form.elements.token.value = "";
  savedTokenEndpoint = value.token_configured ? normalizedEndpoint(value.endpoint) : "";
  form.elements.forget_token.checked = false;
  form.elements.remote_consent.checked = Boolean(value.remote_consent);
  document.querySelector("[data-stt-preset]").value = Object.keys(presets).find(key => presets[key].endpoint === value.endpoint) || "custom";
  disclosure();
  window.dispatchEvent(new CustomEvent("verwrity-stt-settings", { detail: value }));
}

window.addEventListener("verwrity-ai-settings", event => {
  if (!form) return;
  form.elements.provider.replaceChildren(...event.detail.capabilities.speech_to_text.providers.map(provider => {
    const option = document.createElement("option"); option.value = provider.id; option.textContent = provider.name; return option;
  }));
  fill(event.detail.settings.stt);
  status.textContent = "";
});

form?.elements.forget_token.addEventListener("change", keyRequirement);

for (const name of ["provider", "endpoint"]) {
  form?.elements.namedItem(name)?.addEventListener(name === "endpoint" ? "input" : "change", () => {
    form.elements.remote_consent.checked = false;
    disclosure();
  });
}
document.querySelector("[data-stt-preset]")?.addEventListener("change", event => {
  const preset = presets[event.target.value];
  if (preset) {
    form.elements.endpoint.value = preset.endpoint;
    form.elements.model.value = preset.model;
    form.elements.token.value = "";
    form.elements.remote_consent.checked = false;
    disclosure();
  }
});

async function save() {
  const data = new FormData(form);
  const values = Object.fromEntries(["provider", "model_path", "device", "compute_type", "language", "shortcut", "endpoint", "model", "token"].map(key => [key, String(data.get(key) || "")]));
  // The cache destination is displayed before a model exists; it is not a
  // configured inference folder until Download supplies the model snapshot.
  if (values.model_path.trim() === defaultDownloadDirectory) values.model_path = "";
  values.forget_token = form.elements.forget_token.checked;
  values.remote_consent = form.elements.provider.value !== "faster_whisper" && !localEndpoint(values.endpoint) && form.elements.remote_consent.checked;
  const response = await fetch("/ai/models/stt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not save speech-to-text settings.");
  fill(result);
}

form?.addEventListener("submit", async event => {
  event.preventDefault();
  status.textContent = "Saving speech-to-text settings…";
  try { await save(); status.textContent = "Speech-to-text settings saved."; }
  catch (error) { status.textContent = error.message; }
});

document.querySelector("[data-stt-download]")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await save();
    status.textContent = "Downloading Whisper model files from Hugging Face… This may take several minutes.";
    const response = await fetch("/ai/models/stt/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: document.querySelector("[data-stt-download-model]").value, accept_download: true }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not download the Whisper model.");
    fill(result);
    status.textContent = "Whisper model downloaded. Local dictation is ready.";
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});

if (form) {
  const language = form.elements.language;
  const codes = { en: "English", de: "German", fr: "French", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", uk: "Ukrainian", ru: "Russian", ar: "Arabic", hi: "Hindi", zh: "Chinese", ja: "Japanese", ko: "Korean", cy: "Welsh", ga: "Irish", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", tr: "Turkish", el: "Greek", he: "Hebrew" };
  for (const [value, name] of Object.entries(codes)) language.add(new Option(`${name} (${value})`, value));
  window.addEventListener("verwrity-stt-settings", event => {
    const code = event.detail.language || "";
    if (![...language.options].some(option => option.value === code)) language.add(new Option(code, code));
    language.value = code;
  });
}

if (form) form.saveConfiguration = save;
