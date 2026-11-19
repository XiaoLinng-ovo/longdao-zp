-- Each existing row remains an independent product until explicitly merged.
CREATE TABLE public.payment_catalog_products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 current_version_id uuid REFERENCES public.payment_products(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
 archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.payment_products
 ADD COLUMN catalog_id uuid REFERENCES public.payment_catalog_products(id),
 ADD COLUMN version_number integer NOT NULL DEFAULT 1 CHECK(version_number>0),
 ADD COLUMN version_reason text NOT NULL DEFAULT '历史商品初始化',
 ADD COLUMN source_version_id uuid REFERENCES public.payment_products(id) ON DELETE SET NULL;
INSERT INTO public.payment_catalog_products(id,current_version_id,created_at)
 SELECT id,id,created_at FROM public.payment_products;
UPDATE public.payment_products SET catalog_id=id;
ALTER TABLE public.payment_products ALTER COLUMN catalog_id SET NOT NULL;
ALTER TABLE public.payment_products ADD CONSTRAINT payment_product_version_unique UNIQUE(catalog_id,version_number) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX payment_product_one_active ON public.payment_products(catalog_id) WHERE active;
CREATE INDEX payment_product_history ON public.payment_products(catalog_id,version_number DESC);

-- Retain compatibility with existing insertion paths while the API is rolled out.
CREATE FUNCTION public.initialize_payment_product_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.catalog_id IS NULL THEN
   INSERT INTO public.payment_catalog_products(id,current_version_id) VALUES(NEW.id,NEW.id);
   NEW.catalog_id:=NEW.id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER initialize_payment_product_catalog BEFORE INSERT ON public.payment_products
 FOR EACH ROW EXECUTE FUNCTION public.initialize_payment_product_catalog();

-- Check final transaction state so publication and merge can switch versions atomically.
CREATE FUNCTION public.check_payment_catalog_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.payment_catalog_products c JOIN public.payment_products p ON p.id=c.current_version_id
           WHERE p.catalog_id<>c.id OR c.archived)
 OR EXISTS(SELECT 1 FROM public.payment_products p JOIN public.payment_catalog_products c ON c.id=p.catalog_id
           WHERE p.active AND (c.archived OR c.current_version_id IS DISTINCT FROM p.id)) THEN
   RAISE EXCEPTION 'Only the current product version can be sold';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER payment_catalog_current AFTER INSERT OR UPDATE ON public.payment_catalog_products
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_catalog_current();
CREATE CONSTRAINT TRIGGER payment_product_current AFTER INSERT OR UPDATE ON public.payment_products
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_payment_catalog_current();
CREATE TABLE public.payment_product_operations (
 actor_id uuid NOT NULL REFERENCES public.users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 product_id uuid NOT NULL REFERENCES public.payment_products(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_id)
);
