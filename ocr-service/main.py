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
)


def ocr_image(path: str) -> str:
    result = pipeline.predict(path)
    chunks: list[str] = []
    for page in result:
        data = page.json if hasattr(page, "json") else page
        if isinstance(data, dict):
            for item in data.get("rec_texts", []):
                if isinstance(item, str) and item.strip():
                    chunks.append(item.strip())
            if not chunks and isinstance(data.get("text"), str):
                chunks.append(data["text"].strip())
    return "\n".join(chunks).strip()


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
