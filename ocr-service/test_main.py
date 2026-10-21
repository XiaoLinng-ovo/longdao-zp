import importlib.util
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException, UploadFile
from io import BytesIO


constructor = MagicMock(return_value=MagicMock())
spec = importlib.util.spec_from_file_location("resume_ocr_under_test", Path(__file__).with_name("main.py"))
ocr = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"paddleocr": types.SimpleNamespace(PPStructureV3=constructor)}):
    spec.loader.exec_module(ocr)


class OcrTests(unittest.TestCase):
    def test_resume_pipeline_keeps_layout_without_loading_unused_models(self):
        options = constructor.call_args.kwargs
        for key in ("use_table_recognition", "use_formula_recognition", "use_doc_unwarping", "use_region_detection"):
            self.assertFalse(options[key])
        self.assertGreaterEqual(options["cpu_threads"], 1)
        self.assertEqual(options["text_det_limit_type"], "max")

    def test_parsing_blocks_and_plain_ocr_fallback(self):
        with patch.object(ocr.pipeline, "predict", return_value=[{"res": {"parsing_res_list": [{"block_content": "Resume body"}]}}]):
            self.assertEqual(ocr.ocr_image("unused.png"), "Resume body")
        with patch.object(ocr.pipeline, "predict", return_value=[{"res": {"overall_ocr_res": {"rec_texts": ["Text fallback"]}}}]):
            self.assertEqual(ocr.ocr_image("unused.png"), "Text fallback")

    def test_each_result_uses_its_own_fallback_without_losing_later_blocks(self):
        results = [
            {"res": {"parsing_res_list": [{"block_content": "First project"}]}},
            {"res": {"overall_ocr_res": {"rec_texts": ["Second project", "Education"]}}},
            {"res": {"parsing_res_list": [{"block_content": "Skills"}], "overall_ocr_res": {"rec_texts": ["Skills duplicate"]}}},
        ]
        with patch.object(ocr.pipeline, "predict", return_value=results):
            self.assertEqual(ocr.ocr_image("unused.png"), "First project\n\nSecond project\n\nEducation\n\nSkills")

    def test_pdf_resources_close_even_when_inference_fails(self):
        document, page, bitmap = MagicMock(), MagicMock(), MagicMock()
        document.__len__.return_value = 1
        document.__getitem__.return_value = page
        page.render.return_value = bitmap
        with patch.object(ocr.pdfium, "PdfDocument", return_value=document), patch.object(ocr, "ocr_image", side_effect=ValueError("failed")):
            with self.assertRaises(ValueError):
                ocr.ocr_pdf(b"pdf")
        bitmap.close.assert_called_once()
        page.close.assert_called_once()
        document.close.assert_called_once()

    def test_busy_empty_and_failed_documents_never_return_success(self):
        ocr.inference_lock.acquire()
        try:
            with self.assertRaises(HTTPException) as busy:
                ocr.recognize_payload(b"png", "scan.png", "image/png")
            self.assertEqual(busy.exception.status_code, 429)
        finally:
            ocr.inference_lock.release()
        for outcome in ("", ValueError("failure")):
            with patch.object(ocr, "ocr_image", **({"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome})):
                with self.assertRaises(HTTPException) as error:
                    ocr.recognize_payload(b"png", "scan.png", "image/png")
                self.assertEqual(error.exception.status_code, 422)
                self.assertFalse(ocr.inference_lock.locked())


class AsyncOcrTests(unittest.IsolatedAsyncioTestCase):
    async def test_inference_does_not_execute_on_event_loop(self):
        event_loop_thread = threading.get_ident()
        inference_threads = []

        def recognize(_path):
            inference_threads.append(threading.get_ident())
            return "Resume text"

        with patch.object(ocr, "ocr_image", side_effect=recognize):
            result = await ocr.recognize(UploadFile(BytesIO(b"png"), filename="scan.png"))
        self.assertEqual(result["text"], "Resume text")
        self.assertNotEqual(inference_threads, [event_loop_thread])


if __name__ == "__main__":
    unittest.main()
