create table public.prospects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  business_name text not null,
  website text,
  industry text,
  city text,
  state text,

  contact_name text,
  contact_email text,

  app_status text not null default 'not_started',
  qualification_status text not null default 'unreviewed',

  logo_url text,
  brand_colors jsonb not null default '[]'::jsonb,
  services jsonb not null default '[]'::jsonb,
  booking_url text,
  business_summary text,

  app_template text,
  visual_url text,

  email_subject text,
  email_body text,

  campaign text,
  status text not null default 'new',

  sent_at timestamptz,
  reply_status text not null default 'none',
  reply_text text,

  followup_count integer not null default 0 check (followup_count >= 0),
  next_followup_at timestamptz,

  meeting_booked boolean not null default false,
  customer_won boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint prospects_brand_colors_is_array
    check (jsonb_typeof(brand_colors) = 'array'),
  constraint prospects_services_is_array
    check (jsonb_typeof(services) = 'array')
);

comment on table public.prospects is
  'Owner-scoped prospect records that form the memory of the outbound system.';

create index prospects_owner_id_idx on public.prospects (owner_id);
create index prospects_owner_status_idx on public.prospects (owner_id, status);
create index prospects_next_followup_idx
  on public.prospects (owner_id, next_followup_at)
  where next_followup_at is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create trigger prospects_set_updated_at
before update on public.prospects
for each row
execute function public.set_updated_at();

alter table public.prospects enable row level security;

revoke all on table public.prospects from anon;
grant select, insert, update, delete on table public.prospects to authenticated;

create policy "Users can read their own prospects"
on public.prospects
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "Users can create their own prospects"
on public.prospects
for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy "Users can update their own prospects"
on public.prospects
for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "Users can delete their own prospects"
on public.prospects
for delete
to authenticated
using ((select auth.uid()) = owner_id);
