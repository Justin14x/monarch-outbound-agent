-- Align the single prospect record with the finalized logo -> Stitch -> outreach
-- workflow and provision one private bucket for generated/downloaded assets.

drop index if exists public.prospects_workflow_status_created_at_idx;
drop index if exists public.prospects_stitch_status_idx;

alter table public.prospects
  rename column logo_url to original_logo_url;

alter table public.prospects
  drop column industry,
  drop column city,
  drop column state,
  drop column services,
  drop column booking_url,
  drop column business_description,
  drop column primary_color,
  drop column secondary_color,
  drop column research_data,
  add column transparent_logo_url text,
  add column logo_source_url text,
  add column logo_status text;

alter table public.prospects
  alter column workflow_status drop default,
  alter column workflow_status type text using workflow_status::text,
  alter column workflow_status set default 'IMPORTED',
  alter column stitch_status drop default,
  alter column stitch_status type text using stitch_status::text,
  alter column stitch_status drop not null,
  alter column app_image_urls drop default,
  alter column app_image_urls drop not null;

update public.prospects
set stitch_status = null
where stitch_status = 'NOT_STARTED';

drop type public.prospect_workflow_status;
drop type public.prospect_stitch_status;

alter table public.prospects
  add constraint prospects_workflow_status_allowed
    check (workflow_status in (
      'IMPORTED',
      'LOGO_SEARCHING',
      'LOGO_FOUND',
      'LOGO_NOT_FOUND',
      'LOGO_PROCESSING',
      'LOGO_READY',
      'STITCH_PENDING',
      'STITCH_GENERATING',
      'STITCH_COMPLETE',
      'STITCH_FAILED',
      'EMAIL_SEARCHING',
      'EMAIL_FOUND',
      'EMAIL_NOT_FOUND',
      'EMAIL_GENERATED',
      'DRAFT_CREATED',
      'READY_FOR_REVIEW',
      'APPROVED',
      'SENT',
      'FAILED'
    )),
  add constraint prospects_logo_status_allowed
    check (logo_status is null or logo_status in (
      'PENDING',
      'SEARCHING',
      'FOUND',
      'NOT_FOUND',
      'PROCESSING',
      'READY',
      'FAILED'
    )),
  add constraint prospects_stitch_status_allowed
    check (stitch_status is null or stitch_status in (
      'PENDING',
      'GENERATING',
      'COMPLETE',
      'FAILED'
    ));

create index prospects_workflow_status_created_at_idx
  on public.prospects (workflow_status, created_at);

create index prospects_stitch_status_idx
  on public.prospects (stitch_status)
  where stitch_status is not null;

comment on column public.prospects.original_logo_url is
  'Canonical prospect-assets object path for the downloaded official logo.';

comment on column public.prospects.transparent_logo_url is
  'Canonical prospect-assets object path for the transparent PNG logo.';

comment on column public.prospects.logo_source_url is
  'Exact public website URL from which the official logo was downloaded.';

comment on column public.prospects.app_image_urls is
  'Array of canonical prospect-assets object paths for Stitch output images.';

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'prospect-assets',
  'prospect-assets',
  false,
  15728640,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/svg+xml',
    'image/gif'
  ]::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
