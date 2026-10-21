from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from speaker_diarization import attach_voiceprints

LOG_LEVEL = os.getenv("FUNASR_LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("funasr-service")

MODEL_NAME = os.getenv("FUNASR_MODEL", "paraformer-zh")
STREAMING_MODEL_NAME = os.getenv("FUNASR_STREAMING_MODEL", "paraformer-zh-streaming")
VAD_MODEL = os.getenv("FUNASR_VAD_MODEL", "fsmn-vad")
PUNC_MODEL = os.getenv("FUNASR_PUNC_MODEL", "ct-punc")
SPK_MODEL = os.getenv("FUNASR_SPK_MODEL", "cam++")
DEVICE = os.getenv("FUNASR_DEVICE", "cuda")
MAX_AUDIO_BYTES = int(os.getenv("FUNASR_MAX_AUDIO_BYTES", str(50 * 1024 * 1024)))
# Streaming sessions keep only a small pending PCM window and rotate finalized
# text every commit. Use a duration guard rather than the upload byte limit so a
# normal 5+ minute interview is not mistaken for one oversized file.
MAX_STREAM_SECONDS = int(os.getenv("FUNASR_MAX_STREAM_SECONDS", "14400"))
FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")

app = FastAPI(title="Local FunASR Service", version="1.0.0")

_model: Any | None = None
_model_error: str | None = None
_model_lock = threading.Lock()
_streaming_model: Any | None = None
_streaming_model_error: str | None = None
_streaming_model_lock = threading.Lock()
_streaming_generate_lock = threading.Lock()
_offline_generate_lock = threading.Lock()


def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _build_model() -> Any:
    from funasr import AutoModel

    requested_device = DEVICE.lower()
    device = requested_device
    if requested_device.startswith("cuda") and not _cuda_available():
        logger.warning("CUDA is not available; falling back to CPU")
        device = "cpu"

    kwargs: dict[str, Any] = {
        "model": MODEL_NAME,
        "vad_model": VAD_MODEL,
        "punc_model": PUNC_MODEL,
        "device": device,
        "disable_update": True,
    }
    if SPK_MODEL and os.getenv("FUNASR_ENABLE_SPEAKER", "1").lower() not in {"0", "false", "no"}:
        kwargs["spk_model"] = SPK_MODEL

    logger.info("Loading FunASR models: %s", ", ".join(f"{k}={v}" for k, v in kwargs.items()))
    try:
        model = AutoModel(**kwargs)
    except Exception:
        # Speaker model is optional. If CAM++ cannot be loaded, keep speech-to-text working
        # and return speaker_0 so the rest of the application remains usable.
        if "spk_model" not in kwargs:
            raise
        logger.exception("Speaker model failed to load; retrying without speaker diarization")
        kwargs.pop("spk_model", None)
        model = AutoModel(**kwargs)
    logger.info("FunASR model loaded on %s", device)
    return model


def _build_streaming_model() -> Any:
    from funasr import AutoModel

    requested_device = DEVICE.lower()
    device = requested_device
    if requested_device.startswith("cuda") and not _cuda_available():
        logger.warning("CUDA is not available; falling back to CPU for streaming ASR")
        device = "cpu"

    # Online Paraformer consumes successive 16 kHz PCM chunks and keeps encoder
    # state in a per-WebSocket cache. Do not attach offline VAD/punctuation/speaker
    # models here: they would turn this back into whole-file decoding.
    logger.info("Loading FunASR streaming model: %s on %s", STREAMING_MODEL_NAME, device)
    return AutoModel(model=STREAMING_MODEL_NAME, device=device, disable_update=True)


def get_streaming_model() -> Any:
    global _streaming_model, _streaming_model_error
    if _streaming_model is not None:
        return _streaming_model
    with _streaming_model_lock:
        if _streaming_model is not None:
            return _streaming_model
        try:
            _streaming_model = _build_streaming_model()
            _streaming_model_error = None
            return _streaming_model
        except Exception as exc:
            _streaming_model_error = f"{type(exc).__name__}: {exc}"
            logger.exception("FunASR streaming model loading failed")
            raise


def _generate_streaming_sync(audio: bytes, cache: dict[str, Any], is_final: bool) -> str:
    import numpy as np

    if not audio:
        return ""
    pcm = np.frombuffer(audio, dtype="<i2").astype(np.float32) / 32768.0
    model = get_streaming_model()
    # AutoModel keeps mutable runtime configuration internally; serialize calls
    # across sessions while keeping each session's actual decoder cache isolated.
    with _streaming_generate_lock:
        results = model.generate(
            input=pcm,
            cache=cache,
            is_final=is_final,
            chunk_size=[0, 10, 5],
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
    if isinstance(results, dict):
        results = [results]
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        return ""
    value = results[0].get("text", "")
    return value.strip() if isinstance(value, str) else ""


def get_model() -> Any:
    global _model, _model_error
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        try:
            _model = _build_model()
            _model_error = None
            return _model
        except Exception as exc:
            _model_error = f"{type(exc).__name__}: {exc}"
            logger.exception("FunASR model loading failed")
            raise


def _audio_suffix(content_type: str) -> str:
    content_type = content_type.lower()
    if "wav" in content_type or "wave" in content_type:
        return ".wav"
    if "mp3" in content_type:
        return ".mp3"
    if "ogg" in content_type:
        return ".ogg"
    if "mp4" in content_type or "m4a" in content_type:
        return ".m4a"
    return ".webm"


def _convert_to_wav(raw: bytes, content_type: str, directory: str) -> Path:
    source = Path(directory) / f"input{_audio_suffix(content_type)}"
    target = Path(directory) / "audio.wav"
    source.write_bytes(raw)
    command = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        str(target),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    except FileNotFoundError as exc:
        raise RuntimeError(f"ffmpeg not found: {FFMPEG}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("ffmpeg conversion timed out") from exc
    if completed.returncode != 0 or not target.exists():
        detail = (completed.stderr or completed.stdout or "unknown ffmpeg error").strip()
        raise RuntimeError(f"ffmpeg conversion failed: {detail[:1000]}")
    return target


def _wav_duration_ms(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
            return int(frames * 1000 / rate) if rate else 0
    except Exception:
        return 0


def _number(value: Any, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _to_ms(value: Any) -> int:
    number = _number(value)
    # Native FunASR timestamps are milliseconds, including values below 100.
    return int(max(0, number))


def _normalize_result(result: Any, duration_ms: int) -> list[dict[str, Any]]:
    if isinstance(result, dict):
        rows = result.get("sentence_info") or result.get("segments")
        if isinstance(rows, list):
            source_rows = rows
            # Some model versions return incomplete sentence_info despite a full
            # top-level transcript. Never silently throw away the missing words.
            full_text = _text(result.get("text"))
            joined = "".join(_text(row.get("text") or row.get("sentence")) for row in rows if isinstance(row, dict))
            normalize = lambda value: re.sub(r"[\W_]", "", value).casefold()
            if full_text and normalize(full_text) != normalize(joined):
                if isinstance(result.get('timestamp'), list) and result['timestamp']:
                    # Real word timing lets the acoustic pass recover turns.
                    source_rows = [{"text": full_text, "startMs": 0, "endMs": duration_ms,
                                    "timestamp": result['timestamp']}]
                else:
                    # Without word timestamps the incomplete sentence list cannot
                    # be aligned to the full text. Keep one complete unverified
                    # transcript instead of duplicating it over the old turns.
                    source_rows = [{"text": full_text, "startMs": 0, "endMs": duration_ms,
                                    "speakerVerified": False, "speakerMixed": True}]
        else:
            source_rows = [result]
    elif isinstance(result, list):
        return [segment for item in result for segment in _normalize_result(item, duration_ms)]
    else:
        source_rows = []

    segments: list[dict[str, Any]] = []
    for index, row in enumerate(source_rows):
        if not isinstance(row, dict):
            continue
        text = _text(row.get("text") or row.get("sentence") or row.get("value"))
        if not text:
            continue
        start = row.get("startMs", row.get("start", row.get("beg")))
        end = row.get("endMs", row.get("end", row.get("end_time")))
        timestamp = row.get("timestamp")
        if (start is None or end is None) and isinstance(timestamp, list) and timestamp:
            first = timestamp[0]
            last = timestamp[-1]
            if isinstance(first, (list, tuple)) and first:
                start = first[0]
            if isinstance(last, (list, tuple)) and last:
                end = last[-1]
        start_ms = _to_ms(start)
        end_ms = _to_ms(end)
        if end_ms <= start_ms:
            end_ms = max(start_ms + 1, duration_ms if duration_ms > start_ms else start_ms + 1)
        speaker = row.get("speakerId", row.get("spk", row.get("speaker", 0)))
        if isinstance(speaker, str) and speaker.startswith("speaker_"):
            speaker_id = speaker
        else:
            speaker_id = f"speaker_{speaker}"
        segments.append(
            {
                "id": f"{speaker_id}:{start_ms}:{index}",
                "spk": speaker,
                "speakerId": speaker_id,
                "sentence": text,
                "text": text,
                "start": start_ms,
                "end": end_ms,
                "startMs": start_ms,
                "endMs": end_ms,
                **({"timestamp": timestamp} if isinstance(timestamp, list) else {}),
                **({"speakerVerified": False, "speakerMixed": True} if row.get('speakerMixed') else {}),
            }
        )

    if not segments:
        return []
    return segments


def _transcribe_sync(wav_path: Path) -> list[dict[str, Any]]:
    model = get_model()
    # AutoModel mutates its runtime configuration, just like the streaming model.
    with _offline_generate_lock:
        result = model.generate(input=str(wav_path), batch_size_s=300)
        rows = _normalize_result(result, _wav_duration_ms(wav_path))
        try:
            rows = attach_voiceprints(model, wav_path, rows)
        except Exception:
            logger.exception("Acoustic turn alignment failed; keeping transcript unverified")
            rows = [{**row, "speakerVerified": False} for row in rows]
        # Word timing is only needed internally for acoustic alignment.
        return [{key: value for key, value in row.items() if key != "timestamp"} for row in rows]


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "funasr",
        "modelLoaded": _model is not None,
        "modelError": _model_error,
        "cudaAvailable": _cuda_available(),
        "model": MODEL_NAME,
        "streamingModel": STREAMING_MODEL_NAME,
        "streamingModelLoaded": _streaming_model is not None,
        "streamingModelError": _streaming_model_error,
        "device": DEVICE,
        "speakerModel": SPK_MODEL,
        "speakerModelLoaded": _model is not None and getattr(_model, "spk_model", None) is not None,
        "speakerDiarization": "acoustic_turns_with_session_voice_matching",
    }


@app.websocket("/stream")
async def stream_transcription(websocket: WebSocket) -> None:
    await websocket.accept()
    cache: dict[str, Any] = {}
    pending = bytearray()
    transcript = ""
    total_bytes = 0
    max_stream_bytes = max(1, MAX_STREAM_SECONDS) * 16000 * 2
    # Paraformer streaming's 10-frame encoder chunk is 600 ms at 60 ms/frame.
    chunk_bytes = 16000 * 2 * 0.6
    try:
        await websocket.send_json({"type": "status", "status": "loading"})
        await asyncio.to_thread(get_streaming_model)
        await websocket.send_json({"type": "status", "status": "ready", "heartbeat": True})
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            raw = message.get("bytes")
            if raw is not None:
                total_bytes += len(raw)
                if total_bytes > max_stream_bytes:
                    await websocket.send_json({"type": "error", "message": "Audio stream exceeds configured duration limit"})
                    await websocket.close(code=1009)
                    return
                pending.extend(raw)
                # Keep samples aligned to 16-bit PCM.
                flush_bytes = int(chunk_bytes) - (int(chunk_bytes) % 2)
                # Retain one encoder-sized frame so commit/end can send it with
                # is_final=True and flush look-ahead tokens and punctuation.
                while len(pending) > flush_bytes:
                    frame = bytes(pending[:flush_bytes])
                    del pending[:flush_bytes]
                    delta = await asyncio.to_thread(_generate_streaming_sync, frame, cache, False)
                    if delta:
                        transcript += delta
                        await websocket.send_json({"type": "partial", "text": transcript, "delta": delta})
                continue

            text = message.get("text")
            if text:
                try:
                    command = json.loads(text)
                except json.JSONDecodeError:
                    continue
                command_type = command.get("type")
                if command_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if command_type in {"commit", "end"}:
                    delta = await asyncio.to_thread(_generate_streaming_sync, bytes(pending), cache, True)
                    if delta:
                        transcript += delta
                    await websocket.send_json({"type": "final", "text": transcript, **({"commitId": command["commitId"]} if isinstance(command.get("commitId"), str) else {})})
                    pending.clear()
                    if command_type == "end":
                        await websocket.close(code=1000)
                        return
                    cache = {}
                    transcript = ""
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.exception("Streaming transcription failed")
        try:
            await websocket.send_json({"type": "error", "message": f"Streaming transcription failed: {exc}"})
            await websocket.close(code=1011)
        except Exception:
            pass


@app.post("/transcribe")
async def transcribe(request: Request) -> JSONResponse:
    content_type = request.headers.get("content-type", "audio/webm").split(";", 1)[0].strip()
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="Request body is empty")
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"Audio is larger than {MAX_AUDIO_BYTES} bytes")

    with tempfile.TemporaryDirectory(prefix="funasr-") as directory:
        try:
            wav_path = await asyncio.to_thread(_convert_to_wav, raw, content_type, directory)
            segments = await asyncio.to_thread(_transcribe_sync, wav_path)
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception("Transcription failed")
            raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc

    return JSONResponse({"segments": segments, "text": " ".join(item["text"] for item in segments)})


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled request error")
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("FUNASR_PORT", "10095")))
