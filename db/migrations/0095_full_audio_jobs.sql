CREATE TABLE public.full_audio_transcription_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  interview_id uuid NOT NULL,
  session_id uuid NOT NULL,
  schema_name text NOT NULL CHECK (schema_name='public' OR schema_name ~ '^company_[0-9a-f]{32}$'),
  storage_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('all','microphone','meeting','legacy')),
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','unknown')),
  progress integer NOT NULL DEFAULT 0,
  text text NOT NULL DEFAULT '',
  next_chunk integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  inference_pending boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_claimed_at timestamptz,
  UNIQUE (organization_id,storage_key)
);
CREATE INDEX full_audio_tasks_pending ON public.full_audio_transcription_tasks(status,created_at);
