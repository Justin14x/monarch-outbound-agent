-- Sheet column E is the sole response status. Abort rather than discard a real reply.
do $$
begin
  if exists (
    select 1 from public.prospects
    where reply_status <> 'NO_RESPONSE'
       or gmail_reply_message_id is not null
       or replied_at is not null
  ) then
    raise exception 'Cannot remove reply columns while a recorded reply exists';
  end if;
end;
$$;

alter table public.prospects
  drop column reply_status,
  drop column gmail_reply_message_id,
  drop column replied_at;
