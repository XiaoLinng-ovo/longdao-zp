from __future__ import annotations

import logging
import os
import tempfile
import threading
import time
from pathlib import Path

# Keep PaddleX model files on an ASCII path; Paddle native inference can fail on Chinese Windows paths.
os.environ.setdefault('PADDLE_PDX_CACHE_HOME', r'D:\work\paddlex-cache')
os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')

import pypdfium2 as pdfium
from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PPStructureV3
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="SmartRecruit PP-StructureV3 OCR", version="1.0.0")
logger = logging.getLogger("uvicorn.error")
inference_lock = threading.Lock()
pipeline = PPStructureV3(
    text_detection_model_name=os.getenv("PADDLE_TEXT_DETECTION_MODEL", "PP-OCRv5_mobile_det"),
    text_recognition_model_name=os.getenv("PADDLE_TEXT_RECOGNITION_MODEL", "PP-OCRv5_mobile_rec"),
    use_doc_orientation_classify=True,
    use_doc_unwarping=False,
    use_textline_orientation=True,
    # Resume text still goes through OCR, without loading formula/table models.
    use_table_recognition=False,
    use_formula_recognition=False,
    use_chart_recognition=False,
    use_region_detection=False,
    text_det_limit_side_len=1280,
    text_det_limit_type="max",
    text_recognition_batch_size=8,
    cpu_threads=max(1, int(os.getenv("PADDLE_CPU_THREADS", "2"))),
    # paddlepaddle 3.3.1 在 CPU + oneDNN 下有 PIR 执行器 bug（ConvertPirAttribute2RuntimeAttribute），
    # 默认禁用 mkldnn 绕过；设 PADDLE_ENABLE_MKLDNN=1 可在 paddle 修复后重新启用加速。
    enable_mkldnn=os.getenv("PADDLE_ENABLE_MKLDNN", "0") != "0",
)


def ocr_image(path: str) -> str:
    result = pipeline.predict(path)
    chunks: list[str] = []
    for page in result:
        page_chunks: list[str] = []
        data = page.json if hasattr(page, "json") else page
        if not isinstance(data, dict):
            continue
        # PP-StructureV3 返回 {"res": {"parsing_res_list": [{"block_label": ..., "block_content": ...}, ...]}}
        res = data.get("res", data)
        if isinstance(res, dict):
            for block in res.get("parsing_res_list", []):
                if isinstance(block, dict):
                    content = block.get("block_content")
                    if isinstance(content, str) and content.strip():
                        page_chunks.append(content.strip())
            if not page_chunks:
                ocr_res = res.get("overall_ocr_res")
                if isinstance(ocr_res, dict):
                    for item in ocr_res.get("rec_texts", []):
                        if isinstance(item, str) and item.strip():
                            page_chunks.append(item.strip())
        chunks.extend(page_chunks)
    return "\n\n".join(chunks).strip()


def ocr_pdf(payload: bytes) -> str:
    document = pdfium.PdfDocument(payload)
    chunks: list[str] = []
    try:
        with tempfile.TemporaryDirectory() as directory:
            for index in range(len(document)):
                page = document[index]
                try:
                    bitmap = page.render(scale=2.0)
                    try:
                        image_path = Path(directory) / f"page-{index + 1}.png"
                        bitmap.to_pil().save(image_path)
                    finally:
                        bitmap.close()
                finally:
                    page.close()
                text = ocr_image(str(image_path))
                if text:
                    chunks.append(text)
    finally:
        document.close()
    return "\n\n".join(chunks).strip()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "PP-StructureV3"}


@app.post("/ocr")
async def recognize(file: UploadFile = File(...)) -> dict[str, object]:
    payload = await file.read()
    if not payload:
        raise HTTPException(400, "empty file")
    filename = file.filename or "resume.bin"
    return await run_in_threadpool(recognize_payload, payload, filename, file.content_type)


def recognize_payload(payload: bytes, filename: str, content_type: str | None) -> dict[str, object]:
    if not inference_lock.acquire(blocking=False):
        raise HTTPException(429, "OCR is busy; retry after the current document finishes")
    started = time.monotonic()
    logger.info("OCR document started (%d bytes)", len(payload))
    suffix = Path(filename).suffix.lower()
    try:
        if suffix == ".pdf" or content_type == "application/pdf":
            text = ocr_pdf(payload)
        else:
            temporary_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix=suffix or ".bin", delete=False) as handle:
                    temporary_path = handle.name
                    handle.write(payload)
                    handle.flush()
                text = ocr_image(temporary_path)
            finally:
                if temporary_path:
                    try:
                        os.unlink(temporary_path)
                    except FileNotFoundError:
                        pass
    except Exception as exc:
        logger.exception("OCR document failed")
        raise HTTPException(422, f"OCR failed: {exc}") from exc
    finally:
        inference_lock.release()
        logger.info("OCR document finished in %.2fs", time.monotonic() - started)
    if not text:
        raise HTTPException(422, "OCR produced no text")
    return {"text": text, "engine": "PP-StructureV3", "filename": filename}
