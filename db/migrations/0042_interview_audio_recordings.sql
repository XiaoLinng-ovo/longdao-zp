-- Keep recordings independently of ASR results, including silence and failed recognition.
CREATE TABLE interview_audio_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  offset_ms bigint NOT NULL CHECK (offset_ms >= 0),
  end_ms bigint CHECK (end_ms >= offset_ms),
  byte_length bigint CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_audio_recordings_session_time ON interview_audio_recordings(session_id, offset_ms, id);

-- Expose historical files that were linked to saved transcript segments.
INSERT INTO interview_audio_recordings (session_id, object_key, content_type, offset_ms, end_ms)
SELECT session_id, audio_object_key,
  CASE lower(substring(audio_object_key from '[.]([^.]+)$'))
    WHEN 'webm' THEN 'audio/webm' WHEN 'ogg' THEN 'audio/ogg'
    WHEN 'wav' THEN 'audio/wav' WHEN 'mp3' THEN 'audio/mpeg'
    ELSE 'application/octet-stream' END,
  COALESCE(substring(audio_object_key from '/audio/([0-9]+)-')::bigint, min(start_ms)), max(end_ms)
FROM interview_live_segments WHERE audio_object_key IS NOT NULL
GROUP BY session_id, audio_object_key
ON CONFLICT (object_key) DO NOTHING;
