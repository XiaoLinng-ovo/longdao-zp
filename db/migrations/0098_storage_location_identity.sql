CREATE TABLE public.stored_object_locations (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  storage_kind text NOT NULL CHECK (storage_kind IN ('resume','interview')),
  storage_key text NOT NULL,
  location_id text NOT NULL CHECK (location_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,storage_kind,storage_key)
);
ALTER TABLE public.object_cleanup_tasks ADD COLUMN storage_location_id text
  CHECK (storage_location_id IS NULL OR storage_location_id ~ '^[0-9a-f]{64}$');

-- Historical objects deliberately remain unknown until their original location is verified.
CREATE FUNCTION public.bind_cleanup_storage_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_location_id IS NULL THEN
    SELECT location_id INTO NEW.storage_location_id FROM public.stored_object_locations
      WHERE organization_id=NEW.organization_id AND storage_kind=NEW.storage_kind AND storage_key=NEW.storage_key;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cleanup_storage_location BEFORE INSERT OR UPDATE ON public.object_cleanup_tasks
  FOR EACH ROW EXECUTE FUNCTION public.bind_cleanup_storage_location();
