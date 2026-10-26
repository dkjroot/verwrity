"""Hosted OCR tests use synthetic images and mocked HTTP; no paid requests."""
from io import BytesIO
from unittest.mock import patch, Mock
from urllib.error import HTTPError
import json
import unittest

from verwrity.ai.ocr import OCRRequest, OCRRegistry, OCRError, checked_settings
from verwrity.ai.ocr_remote import exchange, NoRedirect, azure_operation, require_remote_consent, MAX_RESPONSE
from tests import test_ocr as base


def configuration(provider="mistral", endpoint=None):
    values = {"provider": provider, "token": "synthetic-private-key"}
    if provider == "azure": values["endpoint"] = "https://fixture.cognitiveservices.azure.com"
    if endpoint: values["endpoint"] = endpoint
    result = checked_settings(values)
    result.update(token_endpoint=result["endpoint"], token_provider=provider, remote_consent_endpoint=result["endpoint"])
    return result


@unittest.skipUnless(base.Image, "Install Pillow for synthetic OCR pages")
class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.page = OCRRequest("synthetic-page", base.read_image(base.image_bytes()))

    def test_mistral_posts_one_inline_image_and_returns_raw_markdown(self):
        saved = configuration()
        with patch("verwrity.ai.ocr_remote.exchange", return_value=(200, {}, {"pages": [{"markdown": "Original **type**.\n"}]})) as call:
            result = OCRRegistry().get("mistral").recognize(self.page, saved)
        endpoint, headers, payload = call.call_args.args
        self.assertEqual(endpoint, saved["endpoint"])
        self.assertEqual(headers["Authorization"], "Bearer synthetic-private-key")
        self.assertTrue(payload["document"]["image_url"].startswith("data:image/jpeg;base64,"))
        self.assertFalse(payload["include_image_base64"])
        self.assertEqual(result.text, "Original **type**.\n")
        self.assertTrue(any("Markdown" in warning for warning in result.warnings))

    def test_google_uses_document_detection_and_key_header_not_url(self):
        saved = configuration("google")
        with patch("verwrity.ai.ocr_remote.exchange", return_value=(200, {}, {"responses": [{"fullTextAnnotation": {"text": "Handwritten test.\n"}}]})) as call:
            result = OCRRegistry().get("google").recognize(self.page, saved)
        endpoint, headers, payload = call.call_args.args
        self.assertNotIn(saved["token"], endpoint)
        self.assertEqual(headers["X-Goog-Api-Key"], saved["token"])
        self.assertEqual(payload["requests"][0]["features"], [{"type": "DOCUMENT_TEXT_DETECTION"}])
        self.assertEqual(result.text, "Handwritten test.\n")

    def test_azure_submits_once_then_polls_same_endpoint(self):
        saved = configuration("azure")
        operation = saved["endpoint"] + "/documentintelligence/documentModels/prebuilt-read/analyzeResults/fixture?api-version=2024-11-30"
        responses = [(202, {"Operation-Location": operation}, {}), (200, {}, {"status": "running"}),
            (200, {}, {"status": "succeeded", "analyzeResult": {"content": "Paper text."}})]
        with patch("verwrity.ai.ocr_remote.exchange", side_effect=responses) as call, patch("verwrity.ai.ocr_remote.time.sleep"):
            result = OCRRegistry().get("azure").recognize(self.page, saved)
        self.assertEqual(result.text, "Paper text.")
        self.assertIn("base64Source", call.call_args_list[0].args[2])
        self.assertEqual([c.kwargs.get("method", "POST") for c in call.call_args_list], ["POST", "GET", "GET"])

    def test_missing_consent_or_wrong_key_association_never_contacts_provider(self):
        for change in ({"remote_consent_endpoint": ""}, {"token_endpoint": "https://another.test"}, {"token_provider": "azure"}, {"token": ""}):
            with self.subTest(change=change), patch("verwrity.ai.ocr_remote.exchange") as call:
                with self.assertRaises(OCRError): OCRRegistry().get("mistral").recognize(self.page, {**configuration(), **change})
                call.assert_not_called()

    def test_azure_never_follows_foreign_operation_location(self):
        for url in ("https://other.test/documentintelligence/documentModels/prebuilt-read/analyzeResults/1", "http://fixture.cognitiveservices.azure.com/x", "https://fixture.cognitiveservices.azure.com/unrelated"):
            with self.subTest(url=url), patch("verwrity.ai.ocr_remote.exchange", return_value=(202, {"Operation-Location": url}, {})) as call:
                with self.assertRaises(OCRError): OCRRegistry().get("azure").recognize(self.page, configuration("azure"))
                self.assertEqual(call.call_count, 1)

    def test_malformed_embedded_error_and_oversized_text_are_safe_failures(self):
        for provider, value in (("mistral", {"pages": []}), ("mistral", {"pages": [{"markdown": "x" * 20001}]}),
                ("google", {"responses": [{"error": {"message": "secret manuscript"}}]})):
            with self.subTest(provider=provider), patch("verwrity.ai.ocr_remote.exchange", return_value=(200, {}, value)):
                with self.assertRaises(OCRError) as error: OCRRegistry().get(provider).recognize(self.page, configuration(provider))
                self.assertNotIn("secret manuscript", str(error.exception))


class TransportTests(unittest.TestCase):
    def test_insecure_credentials_and_query_endpoints_rejected(self):
        for value in ("http://example.test/ocr", "https://user:key@example.test/ocr", "https://example.test/ocr?key=secret", "https://example.test/#fragment", "https://example.test/\nocr"):
            with self.subTest(value=value), self.assertRaises(OCRError): configuration(endpoint=value)

    def test_redirects_errors_and_oversized_responses_do_not_leak_content(self):
        for code in (302, 401, 403, 429, 500):
            with patch("verwrity.ai.ocr_remote.build_opener") as opener:
                opener.return_value.open.side_effect = HTTPError("https://fixture.test", code, "secret", {}, BytesIO(b"secret manuscript"))
                with self.assertRaises(OCRError) as error: exchange("https://fixture.test", {"Authorization": "secret"}, {})
                self.assertNotIn("secret", str(error.exception))
                self.assertIsInstance(opener.call_args.args[0], NoRedirect)
                self.assertIsNone(opener.call_args.args[0].redirect_request(None, None, 302, "", {}, "https://other.test"))
                self.assertEqual(opener.return_value.open.call_count, 1)
        with patch("verwrity.ai.ocr_remote.build_opener") as opener:
            opener.return_value.open.return_value.__enter__.return_value.read.return_value = b"x" * (MAX_RESPONSE + 1)
            with self.assertRaises(OCRError): exchange("https://fixture.test", {}, {})


@unittest.skipUnless(base.Image, "Install Pillow for route tests")
class HostedRouteTests(unittest.TestCase):
    setUp = base.RouteTests.setUp

    def save_hosted(self):
        return self.client.post("/ai/models/ocr", json={"provider": "mistral", "token": "synthetic-private-key", "remote_consent": True})

    def test_secret_redaction_endpoint_consent_and_optional_sample(self):
        saved = self.save_hosted()
        self.assertEqual(saved.status_code, 200)
        value = saved.json
        self.assertTrue(value["readiness"]["configured"])
        self.assertFalse(value["readiness"]["tested"], "sample test is optional")
        self.assertEqual(value["token"], "")
        self.assertNotIn("synthetic-private-key", json.dumps(self.client.get("/ai/ocr").json))
        payload = {**self.data, "configuration": value["configuration"]}
        with patch("verwrity.ai.ocr_remote.exchange", return_value=(200, {}, {"pages": [{"markdown": "Source prose."}]})) as call:
            self.assertEqual(self.client.post("/ai/ocr/recognize", json=payload).status_code, 403)
            call.assert_not_called()
            response = self.client.post("/ai/ocr/recognize", json={**payload, "consent_endpoint": value["endpoint"]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json["text"], "Source prose.")
        self.assertEqual(next(iter(self.app.config["PROJECT_STORES"].values())).get().scenes[0].text, "Canonical prose remains untouched.")

    def test_endpoint_change_clears_key_and_consent_and_forget_revokes_readiness(self):
        self.save_hosted()
        preserved = self.client.post("/ai/models/ocr", json={"provider": "mistral", "token": ""}).json
        self.assertTrue(preserved["token_configured"])
        changed = self.client.post("/ai/models/ocr", json={"provider": "mistral", "endpoint": "https://other.test/ocr"}).json
        self.assertFalse(changed["token_configured"])
        self.assertFalse(changed["remote_consent"])
        self.assertFalse(changed["readiness"]["configured"])
        self.save_hosted()
        forgotten = self.client.post("/ai/models/ocr", json={"provider": "mistral", "forget_token": True}).json
        self.assertFalse(forgotten["readiness"]["configured"])

    def test_cloud_providers_need_no_native_runtime_or_download(self):
        self.save_hosted()
        with patch("verwrity.ai.ocr_models.importlib.util.find_spec", side_effect=AssertionError("No Torch lookup")):
            response = self.client.get("/ai/models/ocr")
            self.assertTrue(response.json["readiness"]["configured"])
        response = self.client.post("/ai/models/ocr/download", json={"configuration": response.json["configuration"]})
        self.assertEqual(response.status_code, 400)
