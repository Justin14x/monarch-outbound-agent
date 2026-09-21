-- Refine the initial multi-user prospect model into the private V1 agent record.
-- This is forward-only so the existing remote project is never reset.

create type public.prospect_workflow_status as enum (
  'IMPORTED',
  'RESEARCHING',
  'RESEARCHED',
  'EMAIL_FOUND',
  'EMAIL_NOT_FOUND',
  'STITCH_PENDING',
  'STITCH_GENERATING',
  'STITCH_COMPLETE',
  'STITCH_FAILED',
  'EMAIL_GENERATED',
  'DRAFT_CREATED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SENT',
  'FAILED'
);

create type public.prospect_stitch_status as enum (
  'NOT_STARTED',
  'PENDING',
  'GENERATING',
  'COMPLETE',
  'FAILED'
);

drop policy if exists "Users can read their own prospects" on public.prospects;
drop policy if exists "Users can create their own prospects" on public.prospects;
drop policy if exists "Users can update their own prospects" on public.prospects;
drop policy if exists "Users can delete their own prospects" on public.prospects;

drop index if exists public.prospects_owner_id_idx;
drop index if exists public.prospects_owner_status_idx;
drop index if exists public.prospects_next_followup_idx;

alter table public.prospects
  rename column business_summary to business_description;

alter table public.prospects
  drop column owner_id,
  drop column app_status,
  drop column qualification_status,
  drop column brand_colors,
  drop column app_template,
  drop column visual_url,
  drop column campaign,
  drop column status,
  drop column reply_status,
  drop column reply_text,
  drop column followup_count,
  drop column next_followup_at,
  drop column meeting_booked,
  drop column customer_won,
  add column normalized_domain text not null,
  add column email_source_url text,
  add column email_verified boolean not null default false,
  add column primary_color text,
  add column secondary_color text,
  add column research_data jsonb not null default '{}'::jsonb,
  add column stitch_prompt text,
  add column stitch_project_id text,
  add column stitch_status public.prospect_stitch_status not null default 'NOT_STARTED',
  add column app_image_urls jsonb not null default '[]'::jsonb,
  add column gmail_draft_id text,
  add column gmail_message_id text,
  add column workflow_status public.prospect_workflow_status not null default 'IMPORTED',
  add column error_message text,
  add column retry_count integer not null default 0;

alter table public.prospects
  alter column website set not null,
  add constraint prospects_business_name_not_blank
    check (length(btrim(business_name)) > 0),
  add constraint prospects_website_not_blank
    check (length(btrim(website)) > 0),
  add constraint prospects_normalized_domain_not_blank
    check (length(btrim(normalized_domain)) > 0),
  add constraint prospects_normalized_domain_is_normalized
    check (
      normalized_domain = lower(btrim(normalized_domain))
      and normalized_domain !~ '^(https?://)'
      and normalized_domain !~ '[[:space:]/]'
    ),
  add constraint prospects_normalized_domain_key unique (normalized_domain),
  add constraint prospects_verified_email_present
    check (not email_verified or contact_email is not null),
  add constraint prospects_research_data_is_object
    check (jsonb_typeof(research_data) = 'object'),
  add constraint prospects_app_image_urls_is_array
    check (jsonb_typeof(app_image_urls) = 'array'),
  add constraint prospects_retry_count_nonnegative
    check (retry_count >= 0),
  add constraint prospects_stitch_project_id_key unique (stitch_project_id),
  add constraint prospects_gmail_draft_id_key unique (gmail_draft_id),
  add constraint prospects_gmail_message_id_key unique (gmail_message_id);

create index prospects_workflow_status_created_at_idx
  on public.prospects (workflow_status, created_at);

create index prospects_stitch_status_idx
  on public.prospects (stitch_status)
  where stitch_status <> 'NOT_STARTED';

comment on table public.prospects is
  'System of record for every business processed by the Monarch outbound agent.';

comment on column public.prospects.normalized_domain is
  'Lowercase hostname without scheme, path, query string, fragment, or trailing slash.';

-- This is an internal server-only system. Keep the exposed public-schema table
-- inaccessible to public/authenticated clients; the backend secret key uses the
-- service_role database role and bypasses RLS.
alter table public.prospects enable row level security;
revoke all on table public.prospects from anon, authenticated;
grant select, insert, update, delete on table public.prospects to service_role;
