create table if not exists public.delivery_notifications (
    id uuid primary key default gen_random_uuid(),
    recipient_id uuid not null references public.profiles (id) on delete cascade,
    order_id text not null references public.orders (id) on delete cascade,
    receipt_id text not null,
    message text not null,
    created_at timestamptz not null default now(),
    read_at timestamptz,
    unique (recipient_id, order_id, receipt_id)
);

create index if not exists delivery_notifications_recipient_created_idx
    on public.delivery_notifications (recipient_id, created_at desc);

create table if not exists public.delivery_receipt_email_runs (
    order_id text not null references public.orders (id) on delete cascade,
    receipt_id text not null,
    status text not null check (status in ('sending', 'sent', 'failed')),
    recipient_count integer not null default 0 check (recipient_count >= 0),
    updated_at timestamptz not null default now(),
    primary key (order_id, receipt_id)
);

create table if not exists public.order_notification_email_runs (
    order_id text not null references public.orders (id) on delete cascade,
    event_type text not null check (event_type in ('delivery_receipt', 'customer_cancellation')),
    event_key text not null,
    status text not null check (status in ('sending', 'sent', 'failed')),
    recipient_count integer not null default 0 check (recipient_count >= 0),
    updated_at timestamptz not null default now(),
    primary key (order_id, event_type, event_key)
);

alter table public.delivery_receipt_email_runs enable row level security;
revoke all on public.delivery_receipt_email_runs from anon, authenticated;
grant all on public.delivery_receipt_email_runs to service_role;

alter table public.order_notification_email_runs enable row level security;
revoke all on public.order_notification_email_runs from anon, authenticated;
grant all on public.order_notification_email_runs to service_role;

alter table public.delivery_notifications enable row level security;

drop policy if exists "Users read own delivery notifications" on public.delivery_notifications;
create policy "Users read own delivery notifications" on public.delivery_notifications
for select to authenticated
using (recipient_id = (select auth.uid()));

drop policy if exists "Users mark own delivery notifications read" on public.delivery_notifications;
create policy "Users mark own delivery notifications read" on public.delivery_notifications
for update to authenticated
using (recipient_id = (select auth.uid()))
with check (recipient_id = (select auth.uid()));

revoke all on public.delivery_notifications from anon, authenticated;
grant select on public.delivery_notifications to authenticated;
grant update (read_at) on public.delivery_notifications to authenticated;

create or replace function public.create_delivery_receipt_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_receipt_id text;
    v_recipient_id uuid;
begin
    if new.status <> 'Delivered'
       or old.status = 'Delivered'
       or new.delivery_receipt is null then
        return new;
    end if;

    v_receipt_id := nullif(new.delivery_receipt ->> 'receiptId', '');
    if v_receipt_id is null then
        raise exception 'Delivered order must have a receipt ID';
    end if;

    for v_recipient_id in
        select id
        from public.profiles
        where id in (new.user_id, new.seller_id)
           or role = 'admin'
    loop
        insert into public.delivery_notifications (
            recipient_id,
            order_id,
            receipt_id,
            message
        ) values (
            v_recipient_id,
            new.id,
            v_receipt_id,
            'Delivery receipt ' || v_receipt_id || ' for transaction ' || new.id || ' is ready.'
        )
        on conflict (recipient_id, order_id, receipt_id) do nothing;
    end loop;

    return new;
end;
$$;

drop trigger if exists create_delivery_receipt_notifications on public.orders;
create trigger create_delivery_receipt_notifications
after update of status, delivery_receipt on public.orders
for each row execute function public.create_delivery_receipt_notifications();

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'delivery_notifications'
    ) then
        alter publication supabase_realtime add table public.delivery_notifications;
    end if;
end;
$$;
