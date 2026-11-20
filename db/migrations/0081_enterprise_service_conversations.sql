-- Preserve existing ticket history while enabling shared conversations and private attachments.
ALTER TABLE public.enterprise_service_requests ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.enterprise_service_requests SET updated_at=COALESCE(resolved_at,created_at);
CREATE TABLE public.enterprise_service_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.enterprise_service_requests(id) ON DELETE CASCADE,
  author_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('member','administrator')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 2 AND 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX enterprise_service_messages_thread_idx ON public.enterprise_service_messages(request_id,created_at,id);
CREATE TABLE public.enterprise_service_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.enterprise_service_messages(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 180),
  mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','application/pdf','text/plain')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 2097152),
  size_bytes integer NOT NULL CHECK (size_bytes=octet_length(content))
);
CREATE INDEX enterprise_service_attachments_message_idx ON public.enterprise_service_attachments(message_id);
INSERT INTO public.enterprise_service_messages(request_id,author_id,author_kind,message,created_at)
  SELECT id,created_by,'member',message,created_at FROM public.enterprise_service_requests;
INSERT INTO public.enterprise_service_messages(request_id,author_id,author_kind,message,created_at)
  SELECT id,resolved_by,'administrator',response,GREATEST(resolved_at,created_at+interval '1 microsecond') FROM public.enterprise_service_requests WHERE response IS NOT NULL;
CREATE INDEX enterprise_service_requests_updated_idx ON public.enterprise_service_requests(updated_at DESC);
