CREATE TABLE interview_audio_transcription_jobs (
  object_key text PRIMARY KEY REFERENCES interview_audio_recordings(object_key) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES interview_live_sessions(id) ON DELETE CASCADE,
  audio_source text CHECK (audio_source IN ('microphone','meeting')),
  checkpoint jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed')),
  attempts integer NOT NULL DEFAULT 0,
  claim uuid,
  error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interview_audio_transcription_queue ON interview_audio_transcription_jobs(available_at, updated_at)
  WHERE status <> 'completed';
CREATE INDEX interview_audio_transcription_session ON interview_audio_transcription_jobs(session_id, audio_source)
  WHERE status <> 'completed';
