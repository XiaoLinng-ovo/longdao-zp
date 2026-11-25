-- Global control data: never import model settings from process environment.
CREATE TABLE public.platform_ai_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  base_url text NOT NULL DEFAULT '',
  api_key_ciphertext text,
  model text NOT NULL DEFAULT '',
  timeout_ms integer NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 1 AND 300000),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
