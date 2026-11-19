# FunASR-Only Interview Transcription

Effective 2026-10-20, interview audio chunks use FunASR only, matching the
existing FunASR real-time WebSocket recognizer. The API no longer calls
faster-whisper when FunASR is unavailable, unconfigured, or returns invalid data.
Existing FASTER_WHISPER_* settings cannot enable chunk-transcription fallback.

FunASR errors continue through the existing upload error/retry and streaming
checkpoint recovery logic. This change does not alter audio storage, speaker
verification, transcript reconciliation, or existing interview records.

The legacy faster-whisper service, its optional startup configuration and health
probe remain on disk for compatibility; they are not used for interview audio
transcription. Earlier README fallback instructions are superseded by this policy.

Restart the API after deploying this source change. No ASR service restart is
required.
