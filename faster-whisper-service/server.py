from __future__ import annotations

import asyncio
import gc
import logging
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path

# Configure numerical libraries before CTranslate2/NumPy are imported. Model
# cpu_threads alone does not constrain every library's thread-local workspace.
_cpu_threads = str(max(1, int(os.getenv("FASTER_WHISPER_CPU_THREADS", "2"))))
os.environ.setdefault("OMP_NUM_THREADS", _cpu_threads)
os.environ.setdefault("MKL_NUM_THREADS", _cpu_threads)

from fastapi import FastAPI, HTTPException, Request

app = FastAPI(title="SmartRecruit faster-whisper Service", version="1.0.0")
logger = logging.getLogger("uvicorn.error")
inference_lock = threading.Lock()
model_lock = threading.Lock()
model = None
model_error: str | None = None
idle_timeout_seconds = max(0, float(os.getenv("FASTER_WHISPER_IDLE_SECONDS", "60")))
idle_timer: threading.Timer | None = None
last_inference_at = 0.0


def _unload_idle_model() -> None:
    global model
    if not inference_lock.acquire(blocking=False):
        return
    try:
        # A cancelled timer may already have started. Never unload a model used
        # by an active request or a more recent completed request.
        if time.monotonic() - last_inference_at < idle_timeout_seconds:
            return
        with model_lock:
            if model is not None:
                model = None
                gc.collect()
                logger.info("Unloaded idle faster-whisper model")
    finally:
        inference_lock.release()


def _schedule_model_unload() -> None:
    global idle_timer, last_inference_at
    last_inference_at = time.monotonic()
    if idle_timer is not None:
        idle_timer.cancel()
    if idle_timeout_seconds > 0 and model is not None:
        idle_timer = threading.Timer(idle_timeout_seconds, _unload_idle_model)
        idle_timer.daemon = True
        idle_timer.start()


def _model_config() -> tuple[str, str, str, str]:
    name = os.getenv("FASTER_WHISPER_MODEL", "base")
    device = os.getenv("FASTER_WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "auto")
    language = os.getenv("FASTER_WHISPER_LANGUAGE", "zh")
    return name, device, compute_type, language


def _build_model():
    from faster_whisper import WhisperModel

    name, configured_device, configured_compute, _ = _model_config()
    device = configured_device
    compute_type = configured_compute
    if device == "auto":
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    logger.info("Loading faster-whisper model %s on %s (%s)", name, device, compute_type)
    return WhisperModel(
        name,
        device=device,
        compute_type=compute_type,
        cpu_threads=max(1, int(os.getenv("FASTER_WHISPER_CPU_THREADS", "2"))),
        num_workers=1,
    )


def get_model():
    global model, model_error
    if model is not None:
        return model
    with model_lock:
        if model is not None:
            return model
        try:
            model = _build_model()
            model_error = None
            return model
        except Exception as error:
            model_error = str(error)
            logger.exception("faster-whisper model initialization failed")
            raise


def authorize(request: Request) -> None:
    expected_token = os.getenv("FASTER_WHISPER_TOKEN", "").strip()
    if not expected_token:
        return
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token or not secrets.compare_digest(token.encode("utf-8"), expected_token.encode("utf-8")):
        raise HTTPException(401, "invalid faster-whisper token")


def transcribe_payload(payload: bytes, content_type: str | None) -> dict[str, object]:
    if not payload:
        raise HTTPException(400, "empty audio payload")
    if not inference_lock.acquire(blocking=False):
        raise HTTPException(429, "faster-whisper is busy; retry after the current chunk finishes")
    temporary_path: str | None = None
    try:
        suffix = ".webm"
        normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
        if normalized_content_type == "audio/ogg":
            suffix = ".ogg"
        elif normalized_content_type in {"audio/wav", "audio/x-wav"}:
            suffix = ".wav"
        elif normalized_content_type == "audio/mpeg":
            suffix = ".mp3"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(payload)
            temporary_path = handle.name

        _, _, _, language = _model_config()
        segments, _ = get_model().transcribe(
            temporary_path,
            language=language or None,
            vad_filter=True,
            beam_size=max(1, int(os.getenv("FASTER_WHISPER_BEAM_SIZE", "1"))),
            condition_on_previous_text=False,
        )
        rows = []
        for index, segment in enumerate(segments):
            text = str(segment.text).strip()
            if not text:
                continue
            rows.append({
                "id": f"speaker_0:{int(segment.start * 1000)}:{index}",
                "speakerId": "speaker_0",
                "text": text,
                "startMs": max(0, int(segment.start * 1000)),
                "endMs": max(0, int(segment.end * 1000)),
                "speakerVerified": False,
                "speakerMixed": True,
            })
        return {"segments": rows, "provider": "faster-whisper"}
    finally:
        if temporary_path:
            try:
                Path(temporary_path).unlink(missing_ok=True)
            except OSError:
                logger.warning("Unable to remove temporary audio file: %s", temporary_path)
        try:
            _schedule_model_unload()
        finally:
            inference_lock.release()


@app.get("/health")
def health(request: Request) -> dict[str, object]:
    authorize(request)
    name, device, compute_type, language = _model_config()
    return {
        "status": "ok",
        "service": "faster-whisper",
        "model": name,
        "device": device,
        "computeType": compute_type,
        "language": language,
        "modelLoaded": model is not None,
        "modelError": model_error,
    }


@app.post("/transcribe")
async def transcribe(request: Request) -> dict[str, object]:
    authorize(request)
    payload = await request.body()
    return await asyncio.to_thread(transcribe_payload, payload, request.headers.get("content-type"))
