import asyncio
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import HTTPException
from starlette.requests import Request
import server


def request(headers=()):
    return Request({"type": "http", "method": "GET", "path": "/health", "headers": headers})


class TranscriptionServiceTests(unittest.TestCase):
    def test_optional_token_protects_health_and_upload_before_body_is_read(self):
        with patch.dict(os.environ, {"FASTER_WHISPER_TOKEN": "test-token"}):
            with self.assertRaises(HTTPException) as error:
                server.health(request())
            self.assertEqual(error.exception.status_code, 401)
            with self.assertRaises(HTTPException) as error:
                asyncio.run(server.transcribe(request()))
            self.assertEqual(error.exception.status_code, 401)
            self.assertEqual(server.health(request([(b"authorization", b"Bearer test-token")]))["service"], "faster-whisper")
        with patch.dict(os.environ, {"FASTER_WHISPER_TOKEN": ""}):
            self.assertEqual(server.health(request())["status"], "ok")

    def test_long_segments_keep_full_text_timestamps_and_uncertain_speakers(self):
        source = "我负责招聘平台开发。" * 1000
        paths = []
        def transcribe(path, **kwargs):
            paths.append(path)
            self.assertTrue(Path(path).is_file())
            self.assertEqual(Path(path).suffix, ".webm")
            self.assertTrue(kwargs["vad_filter"])
            return iter([SimpleNamespace(text=source, start=0.0, end=301.5)]), None
        with patch.object(server, "get_model", return_value=SimpleNamespace(transcribe=transcribe)):
            result = server.transcribe_payload(b"fixture", "audio/webm;codecs=opus")
        segment = result["segments"][0]
        self.assertEqual(segment["text"], source)
        self.assertEqual(segment["endMs"], 301500)
        self.assertFalse(segment["speakerVerified"])
        self.assertTrue(segment["speakerMixed"])
        self.assertFalse(Path(paths[0]).exists())

    def test_model_failure_releases_lock_and_cleans_temporary_audio(self):
        paths = []
        def fail(path, **kwargs):
            paths.append(path)
            raise RuntimeError("decoder failed")
        with patch.object(server, "get_model", return_value=SimpleNamespace(transcribe=fail)):
            with self.assertRaisesRegex(RuntimeError, "decoder failed"):
                server.transcribe_payload(b"fixture", "audio/wav")
        self.assertFalse(Path(paths[0]).exists())
        self.assertFalse(server.inference_lock.locked())

    def test_idle_model_is_released_and_reloads_on_demand_but_not_during_inference(self):
        loaded = object()
        with patch.object(server, "model", loaded), patch.object(server, "last_inference_at", 100.0), patch.object(server, "idle_timeout_seconds", 60), patch.object(server.time, "monotonic", return_value=161):
            with server.inference_lock:
                server._unload_idle_model()
                self.assertIs(server.model, loaded)
            with patch.object(server.time, "monotonic", return_value=110):
                server._unload_idle_model()
                self.assertIs(server.model, loaded)
            server._unload_idle_model()
            self.assertIsNone(server.model)
            with patch.object(server, "_build_model", return_value=loaded) as build:
                self.assertIs(server.get_model(), loaded)
                build.assert_called_once()

    def test_empty_audio_and_parallel_requests_fail_without_loading_model(self):
        with patch.object(server, "get_model", Mock()) as model:
            with self.assertRaises(HTTPException) as error:
                server.transcribe_payload(b"", "audio/wav")
            self.assertEqual(error.exception.status_code, 400)
            with server.inference_lock:
                with self.assertRaises(HTTPException) as error:
                    server.transcribe_payload(b"fixture", "audio/wav")
                self.assertEqual(error.exception.status_code, 429)
            model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
