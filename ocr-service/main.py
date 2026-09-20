from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path

import pypdfium2 as pdfium
from fastapi import FastAPI, File, HTTPException, UploadFile
from paddleocr import PPStructureV3

app = FastAPI(title="SmartRecruit PP-StructureV3 OCR", version="1.0.0")
pipeline = PPStructureV3(
    lang=os.getenv("PADDLEOCR_LANG", "ch"),
    use_doc_orientation_classify=True,
    use_doc_unwarping=True,
    use_textline_orientation=True,
    # paddlepaddle 3.3.1 在 CPU + oneDNN 下有 PIR 执行器 bug（ConvertPirAttribute2RuntimeAttribute），
    # 默认禁用 mkldnn 绕过；设 PADDLE_ENABLE_MKLDNN=1 可在 paddle 修复后重新启用加速。
    enable_mkldnn=os.getenv("PADDLE_ENABLE_MKLDNN", "0") != "0",
)


def ocr_image(path: str) -> str:
    result = pipeline.predict(path)
    chunks: list[str] = []
    for page in result:
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
                        chunks.append(content.strip())
            if not chunks:
                ocr_res = res.get("overall_ocr_res")
                if isinstance(ocr_res, dict):
                    for item in ocr_res.get("rec_texts", []):
                        if isinstance(item, str) and item.strip():
                            chunks.append(item.strip())
    return "\n\n".join(chunks).strip()


def ocr_pdf(payload: bytes) -> str:
    document = pdfium.PdfDocument(payload)
    chunks: list[str] = []
    with tempfile.TemporaryDirectory() as directory:
        for index in range(len(document)):
            page = document[index]
            bitmap = page.render(scale=2.0)
            image_path = Path(directory) / f"page-{index + 1}.png"
            bitmap.to_pil().save(image_path)
            text = ocr_image(str(image_path))
            if text:
                chunks.append(text)
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
    suffix = Path(filename).suffix.lower()
    try:
        if suffix == ".pdf" or file.content_type == "application/pdf":
            text = ocr_pdf(payload)
        else:
            with tempfile.NamedTemporaryFile(suffix=suffix or ".bin") as handle:
                handle.write(payload)
                handle.flush()
                text = ocr_image(handle.name)
    except Exception as exc:
        raise HTTPException(422, f"OCR failed: {exc}") from exc
    if not text:
        raise HTTPException(422, "OCR produced no text")
    return {"text": text, "engine": "PP-StructureV3", "filename": filename}
