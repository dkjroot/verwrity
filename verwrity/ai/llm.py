"""Small HTTP-based language-model client boundary.

Provider implementations are deliberately stateless: they receive all
configuration for one explicit request and never perform background work.
"""

from __future__ import annotations

import json
import ipaddress
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen


class LLMConfigurationError(ValueError):
    """The configured model endpoint or response is invalid."""


class LLMRequestError(RuntimeError):
    """A model request failed without exposing credentials or manuscript text."""


DEFAULT_ENDPOINTS = {
    "openai_compatible": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "google": "https://generativelanguage.googleapis.com/v1beta",
}


class ChatClient(Protocol):
    standard_id: str
    display_name: str
    default_endpoint: str

    def complete(self, endpoint: str, model: str, token: str, prompt: str) -> str: ...
    def stream(self, endpoint: str, model: str, token: str, prompt: str) -> Iterator[str]: ...


def _is_loopback(endpoint: str) -> bool:
    host = urlparse(endpoint).hostname
    if not host:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_endpoint(endpoint: str, standard_id: str) -> str:
    """Normalize common OpenAI-compatible loopback roots for local servers."""
    if not endpoint.lower().startswith(("http://", "https://")):
        candidate = "http://" + endpoint
        if _is_loopback(candidate):
            endpoint = candidate
    parsed = urlparse(endpoint)
    scheme = "http" if _is_loopback(endpoint) else parsed.scheme
    path = parsed.path
    if standard_id == "openai_compatible" and path in {"", "/"}:
        path = "/v1"
    return urlunparse(parsed._replace(scheme=scheme, path=path, params=""))


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class HTTPChatClient:
    """One HTTP implementation for OpenAI-compatible, Anthropic, and Gemini."""

    standard_id: str
    display_name: str
    default_endpoint: str

    def complete(self, endpoint: str, model: str, token: str, prompt: str) -> str:
        endpoint = normalize_endpoint(endpoint, self.standard_id)
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise LLMConfigurationError("Enter a valid HTTP or HTTPS model endpoint URL.")
        try:
            parsed.port
        except ValueError as error:
            raise LLMConfigurationError("Enter a valid model endpoint port.") from error
        if parsed.query or parsed.fragment:
            raise LLMConfigurationError("Enter a base endpoint URL without query parameters or fragments.")
        local = _is_loopback(endpoint)
        if parsed.scheme == "http" and not local:
            raise LLMConfigurationError("Non-local model endpoints must use HTTPS.")
        if not model.strip():
            raise LLMConfigurationError("Enter the model name required by your endpoint.")
        base = endpoint.rstrip("/")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.standard_id == "openai_compatible":
            url = f"{base}/chat/completions"
            body = {"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0.2}
            if token:
                headers["Authorization"] = f"Bearer {token}"
        elif self.standard_id == "anthropic":
            url = f"{base}/v1/messages"
            body = {"model": model, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}]}
            headers.update({"anthropic-version": "2023-06-01"})
            if token:
                headers["x-api-key"] = token
        elif self.standard_id == "google":
            url = f"{base}/models/{quote(model, safe='-._')}:generateContent"
            body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096}}
            if token:
                headers["x-goog-api-key"] = token
        else:
            raise LLMConfigurationError("Choose a supported LLM API standard.")
        request = Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            # Refuse redirects for local and remote endpoints alike: a redirect
            # must not silently send project context to a different host.
            response = build_opener(_NoRedirect).open(request, timeout=120)
            with response:
                raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise LLMRequestError("The model response was too large to display.")
            payload = json.loads(raw)
            if self.standard_id == "openai_compatible":
                content = payload["choices"][0]["message"]["content"]
            elif self.standard_id == "anthropic":
                content = "\n".join(item["text"] for item in payload["content"] if item.get("type") == "text")
            else:
                content = "\n".join(part["text"] for part in payload["candidates"][0]["content"]["parts"] if "text" in part)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as error:
            raise LLMRequestError("The selected model endpoint could not complete the question. Check its settings and try again.") from error
        if not isinstance(content, str) or not content.strip():
            raise LLMRequestError("The model endpoint returned no text response.")
        return content.strip()

    def stream(self, endpoint: str, model: str, token: str, prompt: str) -> Iterator[str]:
        """Yield text deltas from the selected API's server-sent event stream."""
        endpoint = normalize_endpoint(endpoint, self.standard_id)
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise LLMConfigurationError("Enter a valid HTTP or HTTPS model endpoint URL.")
        try:
            parsed.port
        except ValueError as error:
            raise LLMConfigurationError("Enter a valid model endpoint port.") from error
        if parsed.query or parsed.fragment:
            raise LLMConfigurationError("Enter a base endpoint URL without query parameters or fragments.")
        if parsed.scheme == "http" and not _is_loopback(endpoint):
            raise LLMConfigurationError("Non-local model endpoints must use HTTPS.")
        if not model.strip():
            raise LLMConfigurationError("Enter the model name required by your endpoint.")
        base = endpoint.rstrip("/")
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
        if self.standard_id == "openai_compatible":
            url = f"{base}/chat/completions"
            body = {"model": model, "messages": [{"role": "user", "content": prompt}], "temperature": 0.2, "stream": True}
            if token:
                headers["Authorization"] = f"Bearer {token}"
        elif self.standard_id == "anthropic":
            url = f"{base}/v1/messages"
            body = {"model": model, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}], "stream": True}
            headers["anthropic-version"] = "2023-06-01"
            if token:
                headers["x-api-key"] = token
        elif self.standard_id == "google":
            url = f"{base}/models/{quote(model, safe='-._')}:streamGenerateContent?alt=sse"
            body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096}}
            if token:
                headers["x-goog-api-key"] = token
        else:
            raise LLMConfigurationError("Choose a supported LLM API standard.")
        request = Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            response = build_opener(_NoRedirect).open(request, timeout=120)
            with response:
                event_data = []
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line:
                        if event_data:
                            delta = self._stream_delta("\n".join(event_data))
                            if delta:
                                yield delta
                            event_data = []
                    elif line.startswith("data:"):
                        event_data.append(line[5:].lstrip())
                if event_data:
                    delta = self._stream_delta("\n".join(event_data))
                    if delta:
                        yield delta
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, KeyError, IndexError, TypeError) as error:
            raise LLMRequestError("The selected model endpoint could not complete the question. Check its settings and try again.") from error

    def _stream_delta(self, data: str) -> str:
        if data == "[DONE]":
            return ""
        try:
            payload = json.loads(data)
            if self.standard_id == "openai_compatible":
                return str(payload.get("choices", [{}])[0].get("delta", {}).get("content") or "")
            if self.standard_id == "anthropic":
                delta = payload.get("delta", {})
                return str(delta.get("text") or "") if delta.get("type") == "text_delta" else ""
            return "".join(part.get("text", "") for candidate in payload.get("candidates", [])
                           for part in candidate.get("content", {}).get("parts", []) if isinstance(part.get("text"), str))
        except (ValueError, KeyError, IndexError, TypeError, AttributeError):
            return ""


class LLMRegistry:
    """Registry for supported request formats, independent of model vendors."""

    def __init__(self, clients: list[ChatClient] | None = None) -> None:
        defaults = [
            HTTPChatClient("openai_compatible", "OpenAI-compatible", DEFAULT_ENDPOINTS["openai_compatible"]),
            HTTPChatClient("anthropic", "Anthropic Messages", DEFAULT_ENDPOINTS["anthropic"]),
            HTTPChatClient("google", "Google Gemini", DEFAULT_ENDPOINTS["google"]),
        ]
        self._clients = {client.standard_id: client for client in (clients if clients is not None else defaults)}

    def get(self, standard_id: str) -> ChatClient:
        try:
            return self._clients[standard_id]
        except KeyError as error:
            raise LLMConfigurationError("Choose a supported LLM API standard.") from error

    def choices(self) -> list[dict[str, str]]:
        return [{"id": item.standard_id, "name": item.display_name, "default_endpoint": item.default_endpoint}
                for item in self._clients.values()]


def parse_answer(raw: str) -> dict[str, object]:
    """Parse the explicit answer/evidence contract without trusting citations."""
    candidate = raw.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        result = json.loads(candidate)
    except ValueError as error:
        raise LLMRequestError("The model did not return the requested answer and evidence format. Try again or choose another model.") from error
    answer = result.get("answer") if isinstance(result, dict) else None
    evidence = result.get("evidence", []) if isinstance(result, dict) else None
    if not isinstance(answer, str) or not isinstance(evidence, list):
        raise LLMRequestError("The model returned an invalid answer and evidence response.")
    return {"answer": answer[:12000], "evidence": evidence[:12]}
