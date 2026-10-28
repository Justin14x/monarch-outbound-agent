-- Preserve the in-flight Stitch project and returned screen resources before
-- image validation or Storage uploads. This does not replace approved assets.
alter table public.prospects
  add column stitch_attempt jsonb;

alter table public.prospects
  add constraint prospects_stitch_attempt_object
    check (stitch_attempt is null or jsonb_typeof(stitch_attempt) = 'object');

comment on column public.prospects.stitch_attempt is
  'Latest Stitch generation attempt: phase, project ID, returned screen IDs, timing, and failure details. Approved app_image_urls remain separate.';
