import { postProgress } from "./ocr-progress.js";
const form = document.querySelector("[data-ai-ocr-form]");
const $ = name => form.querySelector(`[data-ocr-model-${name}]`);
let saved, controller, active = false, edits = 0, dirty = false;
const presets = { mistral: ["https://api.mistral.ai/v1/ocr", "mistral-ocr-4-1"], azure: ["", "prebuilt-read"], google: ["https://vision.googleapis.com/v1/images:annotate", "DOCUMENT_TEXT_DETECTION"] };
function visibility() {
  const provider = form.elements.provider.value, online = Boolean(presets[provider]);
  $("local").hidden = online; $("online").hidden = !online;
  $("disclosure").dataset.processingLocation = online ? "remote" : "local";
  $("disclosure").textContent = online ? "Your current settings send page images over the internet to this provider."
    : "This model runs on your computer, so OCR stays local.";
  form.elements.model.readOnly = provider === "azure" || provider === "google";
  $("help").textContent = provider === "azure" ? "Create an Azure Document Intelligence resource and paste its resource endpoint and key. Read uses API version 2024-11-30." : provider === "google" ? "Enable Cloud Vision API and billing in your Google Cloud project; create an API key restricted to Cloud Vision API. This uses DOCUMENT_TEXT_DETECTION for printed text and handwriting." : "Create a Mistral API key with OCR access and billing. The default model is mistral-ocr-4-1. Each selected page is sent directly to the OCR endpoint.";
}
function fill(value) {
  dirty = false;
  saved = value;
  for (const key of ["provider", "model_path", "device", "endpoint", "model"]) form.elements[key].value = value[key] ?? "";
  form.elements.token.value = ""; form.elements.forget_token.checked = false;
  form.elements.remote_consent.checked = Boolean(value.remote_consent);
  $("key-status").textContent = value.token_configured ? "An API key is saved for this provider and endpoint." : "No API key saved for this provider and endpoint.";
  $("directory").textContent = `Managed download location: ${value.download_directory}. Existing downloads from the user guide's setup commands are found automatically.`;
  $("readiness").textContent = `${value.readiness.message}${value.remote ? "" : ` PyTorch: ${value.readiness.torch_version}. CPU recognition can take a long time.`}`;
  visibility();
}
async function load() {
  const snapshot = edits, r = await fetch("/ai/models/ocr");
  if (!r.ok) throw new Error("Could not load OCR settings.");
  const value = await r.json();
  // A late settings fetch must not replace a provider/key the author is editing.
  if (snapshot === edits) fill(value);
}
async function save() {
  const snapshot = ++edits;
  const response = await fetch("/ai/models/ocr", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...Object.fromEntries(["provider", "model_path", "device", "endpoint", "model", "token"].map(k => [k, form.elements[k].value])),
      remote_consent: form.elements.remote_consent.checked, forget_token: form.elements.forget_token.checked }) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error);
  saved = value; if (snapshot === edits) fill(value);
  window.dispatchEvent(new Event("verwrity-ocr-settings-changed"));
}
async function operate(kind) {
  if (active) return;
  if (kind === "download" && !await window.verwrityDialog.confirm(`Download ${form.elements.provider.value === "olmocr" ? "olmOCR 2 (about 17 GB)" : "PaddleOCR-VL-1.6 (about 2 GB)"} from Hugging Face into Verwrity's managed model directory? No manuscript or images are sent.`, { title: "Download OCR weights" })) return;
  active = true; controller = new AbortController();
  form.querySelectorAll("input,select,button").forEach(e => { e.disabled = true; }); $("cancel").disabled = false; $("cancel").hidden = false;
  $("result").textContent = "";
  try {
    await save();
    $("status").textContent = kind === "download" ? "Downloading model files…" : "Starting sample OCR test…";
    const result = await postProgress(`/ai/models/ocr/${kind}`, { configuration: saved.configuration }, {
      signal: controller.signal, onProgress: e => { $("status").textContent = `${e.stage} · ${Math.floor(e.elapsed)}s elapsed${e.tokens != null ? ` · ${e.tokens} generated tokens` : ""}.${saved.remote ? " Stop waiting cannot recall an online request already sent." : " CPU loading/recognition may take minutes; Cancel stops a local test."}`; },
    });
    if (kind === "download") { fill(result); $("status").textContent = "Download complete. The model folder is selected. You can try the sample test to check recognition, or start with your own pages."; }
    else {
      $("status").textContent = result.matched ? `✓ OCR sample passed in ${result.elapsed}s.` : `OCR ran in ${result.elapsed}s, but the sample text differs. Inspect the result before using this configuration.`;
      $("result").textContent = `Expected:\n${result.expected}\n\nRecognised:\n${result.text}`;
      await load();
    }
  } catch (error) { $("status").textContent = error.name === "AbortError" ? "Stopped waiting. The OCR worker is stopped; an online request or download already sent may still finish." : error.message; }
  finally { active = false; controller = null; form.querySelectorAll("input,select,button").forEach(e => { e.disabled = false; }); $("cancel").disabled = true; $("cancel").hidden = true; }
}
if (form) {
  form.addEventListener("input", () => { edits++; dirty = true; });
  form.addEventListener("change", () => { edits++; dirty = true; });
  window.addEventListener("verwrity-ai-settings", () => { if (!active && !dirty) load().catch(e => { $("status").textContent = e.message; }); });
  form.addEventListener("submit", e => { e.preventDefault(); save().then(() => { $("status").textContent = "OCR settings saved."; }).catch(error => { $("status").textContent = error.message; }); });
  $("test").addEventListener("click", () => operate("test"));
  $("download").addEventListener("click", () => operate("download"));
  $("cancel").addEventListener("click", () => controller?.abort());
  form.elements.provider.addEventListener("change", () => {
    const preset = presets[form.elements.provider.value] || ["", ""];
    form.elements.model_path.value = ""; form.elements.endpoint.value = preset[0]; form.elements.model.value = preset[1];
    form.elements.token.value = ""; form.elements.remote_consent.checked = false;
    $("key-status").textContent = "Save configuration to check for a key for this provider and endpoint.";
    visibility(); $("status").textContent = "Save your provider configuration.";
  });
  form.elements.endpoint.addEventListener("change", () => { form.elements.remote_consent.checked = false; form.elements.token.value = ""; $("key-status").textContent = "Endpoint changed: enter its API key and acknowledge online OCR before use."; });
}
