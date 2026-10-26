"""Explicit hosted OCR. Bounded responses, endpoint consent and no redirects."""
from io import BytesIO
import base64
import json
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from verwrity.ai.ocr import OCRError, OCRResult, MAX_TEXT

MAX_RESPONSE = 8 * 1024 * 1024


def checked_remote_endpoint(value, provider):
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) <= 32 for c in value) or "\\" in value:
        raise OCRError("Enter the online OCR HTTPS endpoint (Azure: your resource endpoint).")
    try:
        parsed = urlsplit(value)
        valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.port in (None, 443)
    except ValueError:
        valid = False
    if not valid:
        raise OCRError("Online OCR requires an HTTPS endpoint without credentials, query parameters or fragments.")
    if provider == "azure" and parsed.path not in ("", "/"):
        raise OCRError("For Azure, enter the resource endpoint only, without the API path.")
    return urlunsplit(("https", parsed.netloc.lower(), parsed.path.rstrip("/"), "", ""))


def require_remote_consent(settings):
    endpoint = checked_remote_endpoint(settings["endpoint"], settings["provider"])
    if settings.get("remote_consent_endpoint") != endpoint:
        raise OCRError("Acknowledge that online OCR sends manuscript images off your computer, outside Verwrity's control, to this exact endpoint.")
    if not settings.get("token") or settings.get("token_endpoint") != endpoint or settings.get("token_provider") != settings["provider"]:
        raise OCRError("Enter an API key for this OCR provider and endpoint in AI Models → OCR.")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exchange(url, headers, payload=None, method="POST"):
    """Never return provider error bodies: they can echo keys or manuscript data."""
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=data, headers={**headers, "Content-Type": "application/json", "Accept": "application/json"}, method=method)
    try:
        with build_opener(NoRedirect()).open(request, timeout=60) as response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise OCRError("Online OCR response exceeds the size limit. Source image is retained.")
            value = json.loads(raw) if raw else {}
            if not isinstance(value, dict):
                raise OCRError("Online OCR returned an invalid response. Source image is retained.")
            return response.status, response.headers, value
    except HTTPError as error:
        code = error.code
        error.close()
        detail = {401: "API key was rejected", 403: "access was denied; check the key, enabled API and billing",
            413: "image is too large", 429: "rate limit or quota was reached"}.get(code, "request was rejected")
        raise OCRError(f"Online OCR {detail} (HTTP {code}). No automatic retry was sent; source image is retained.") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise OCRError("Online OCR could not complete. Check endpoint, connection and billing. The provider may already have processed the page; retry explicitly.") from None


def azure_operation(location, endpoint):
    if not isinstance(location, str) or len(location) > 4096 or any(ord(c) <= 32 for c in location) or "\\" in location:
        raise OCRError("Azure returned an invalid operation address.")
    target, origin = urlsplit(location), urlsplit(endpoint)
    if (target.scheme != origin.scheme or target.netloc.lower() != origin.netloc.lower() or target.fragment or
            not target.path.startswith("/documentintelligence/documentModels/prebuilt-read/analyzeResults/")):
        raise OCRError("Azure returned an operation address outside the configured OCR endpoint. It was not contacted.")
    return location


class HostedOCR:
    def __init__(self, provider):
        self.id = provider

    def recognize(self, request, settings):
        require_remote_consent(settings)
        report = request.progress or (lambda *args: None)
        report("Sending selected page to online OCR", None)
        data = BytesIO()
        request.image.save(data, format="JPEG", quality=94)
        image = base64.b64encode(data.getvalue()).decode("ascii")
        endpoint, key = settings["endpoint"], settings["token"]
        if self.id == "mistral":
            _, _, value = exchange(endpoint, {"Authorization": "Bearer " + key}, {
                "model": settings["model"], "document": {"type": "image_url", "image_url": "data:image/jpeg;base64," + image},
                "include_image_base64": False})
            pages = value.get("pages")
            if not isinstance(pages, list) or len(pages) != 1 or not isinstance(pages[0], dict):
                raise OCRError("Online OCR did not return the requested single page.")
            text = pages[0].get("markdown")
        elif self.id == "google":
            _, _, value = exchange(endpoint, {"X-Goog-Api-Key": key}, {"requests": [{"image": {"content": image},
                "features": [{"type": "DOCUMENT_TEXT_DETECTION"}]}]})
            responses = value.get("responses")
            if not isinstance(responses, list) or len(responses) != 1 or not isinstance(responses[0], dict) or responses[0].get("error"):
                raise OCRError("Google OCR could not process this page. Check API access, billing and image limits; source retained.")
            annotation = responses[0].get("fullTextAnnotation", {})
            text = annotation.get("text", "") if isinstance(annotation, dict) else None
        else:
            url = endpoint + "/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30"
            headers = {"Ocp-Apim-Subscription-Key": key}
            status, response_headers, _ = exchange(url, headers, {"base64Source": image})
            if status != 202:
                raise OCRError("Azure OCR did not accept the page for analysis.")
            operation = azure_operation(response_headers.get("Operation-Location"), endpoint)
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                report("Waiting for Azure OCR result", None)
                time.sleep(1)
                _, _, value = exchange(operation, headers, method="GET")
                if value.get("status") == "succeeded":
                    result = value.get("analyzeResult")
                    text = result.get("content") if isinstance(result, dict) else None
                    break
                if value.get("status") not in ("running", "notStarted"):
                    raise OCRError("Azure OCR did not finish successfully. Source image is retained; retry explicitly.")
            else:
                raise OCRError("Azure OCR is still pending after three minutes. Stop waiting; it may finish remotely. Source image is retained.")
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise OCRError("Online OCR returned invalid or oversized page text. Source image is retained.")
        warnings = ["Online machine transcription: compare the result with the source page."]
        if self.id == "mistral":
            warnings.append("Mistral returns Markdown formatting; inspect it before insertion.")
        if not text.strip():
            warnings.append("No text recognised. This is not proof the page is blank.")
        return OCRResult(request.page_id, text, self.id + ":" + settings["model"], tuple(warnings))
