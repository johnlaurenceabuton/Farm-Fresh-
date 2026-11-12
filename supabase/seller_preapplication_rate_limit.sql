create table if not exists public.seller_preapplication_rate_limits (
    ip_hash text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
    window_started_at timestamptz not null default now(),
    request_count integer not null default 1 check (request_count between 1 and 6)
);

create index if not exists seller_preapplication_rate_limits_window_idx
    on public.seller_preapplication_rate_limits (window_started_at);

alter table public.seller_preapplication_rate_limits enable row level security;
revoke all on public.seller_preapplication_rate_limits from public, anon, authenticated;
grant all on public.seller_preapplication_rate_limits to service_role;

create or replace function public.consume_seller_preapplication_attempt(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz := now();
    v_request_count integer;
begin
    if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid rate-limit key';
    end if;

    insert into public.seller_preapplication_rate_limits as rate_limit (
        ip_hash, window_started_at, request_count
    ) values (
        p_ip_hash, v_now, 1
    )
    on conflict (ip_hash) do update
    set window_started_at = case
            when rate_limit.window_started_at <= v_now - interval '1 hour' then v_now
            else rate_limit.window_started_at
        end,
        request_count = case
            when rate_limit.window_started_at <= v_now - interval '1 hour' then 1
            else least(rate_limit.request_count + 1, 6)
        end
    returning request_count into v_request_count;

    delete from public.seller_preapplication_rate_limits
    where window_started_at < v_now - interval '24 hours';

    return v_request_count <= 5;
end;
$$;

revoke all on function public.consume_seller_preapplication_attempt(text) from public, anon, authenticated;
grant execute on function public.consume_seller_preapplication_attempt(text) to service_role;
