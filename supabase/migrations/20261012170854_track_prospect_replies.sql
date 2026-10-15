-- Keep reply state in the existing prospects record; the Google Sheet mirrors it.
alter table public.prospects
  add column reply_status text not null default 'NO_RESPONSE',
  add column gmail_reply_message_id text,
  add column replied_at timestamptz,
  add constraint prospects_reply_status_allowed
    check (reply_status in ('NO_RESPONSE', 'RESPONDED')),
  add constraint prospects_gmail_reply_message_id_key
    unique (gmail_reply_message_id);

comment on column public.prospects.reply_status is
  'Response state for the sent outreach email, mirrored to the lead sheet.';
comment on column public.prospects.gmail_reply_message_id is
  'First matching incoming Gmail message ID in the sent outreach thread.';
comment on column public.prospects.replied_at is
  'Gmail timestamp of the first matching reply.';
