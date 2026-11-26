-- Historical mixed recordings deliberately keep NULL provenance.
ALTER TABLE interview_live_segments ADD COLUMN audio_source text
  CHECK (audio_source IN ('microphone', 'meeting'));
ALTER TABLE interview_audio_recordings ADD COLUMN audio_source text
  CHECK (audio_source IN ('microphone', 'meeting'));
ALTER TABLE interview_audio_recordings ADD COLUMN source_role text
  CHECK (source_role IN ('interviewer', 'candidate', 'unknown'));
ALTER TABLE interview_audio_recordings ADD COLUMN source_multiple_speakers boolean;
