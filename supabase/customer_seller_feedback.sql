-- Run after seller_order_notifications.sql.

alter table public.delivery_notifications
    alter column order_id drop not null;

alter table public.profiles
    add column if not exists farm_location text not null default '';
grant update (farm_location) on public.profiles to authenticated;

drop function if exists public.list_public_seller_farms();
create function public.list_public_seller_farms()
returns table (seller_id uuid, farm_name text, farm_location text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        seller.id,
        coalesce(application.farm_name, product.farm_name),
        nullif(trim(seller.farm_location), '')
    from public.profiles as seller
    left join lateral (
        select seller_application.farm_name
        from public.seller_applications as seller_application
        where seller_application.user_id = seller.id
          and seller_application.status = 'approved'
        order by seller_application.reviewed_at desc nulls last,
                 seller_application.created_at desc
        limit 1
    ) as application on true
    left join lateral (
        select nullif(trim(listed_product.farm_name), '') as farm_name
        from public.products as listed_product
        where listed_product.seller_id = seller.id
          and nullif(trim(listed_product.farm_name), '') is not null
          and lower(trim(listed_product.farm_name)) <> 'farm fresh'
          and lower(trim(listed_product.farm_name)) <> lower(trim(seller.full_name))
        order by listed_product.updated_at desc, listed_product.name
        limit 1
    ) as product on true
    where seller.role = 'seller'
      and coalesce(application.farm_name, product.farm_name) is not null
    order by coalesce(application.farm_name, product.farm_name),
             seller.id;
$$;

revoke all on function public.list_public_seller_farms() from public;
grant execute on function public.list_public_seller_farms() to anon, authenticated;

create or replace function public.get_my_farm_order_contacts()
returns table (
    order_id text,
    seller_id uuid,
    farm_name text,
    farm_location text,
    seller_phone text,
    seller_email text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and role = 'customer'
    ) then
        raise exception 'Customer access required';
    end if;

    return query
    select
        customer_order.id,
        seller.id,
        coalesce(
            nullif(customer_order.items -> 0 ->> 'farmName', ''),
            application.farm_name,
            seller.full_name
        ),
        nullif(trim(seller.farm_location), ''),
        seller.phone,
        seller.email
    from public.orders as customer_order
    join public.profiles as seller
      on seller.id = customer_order.seller_id
     and seller.role = 'seller'
    left join lateral (
        select seller_application.farm_name
        from public.seller_applications as seller_application
        where seller_application.user_id = seller.id
          and seller_application.status = 'approved'
        order by seller_application.reviewed_at desc nulls last,
                 seller_application.created_at desc
        limit 1
    ) as application on true
    where customer_order.user_id = (select auth.uid());
end;
$$;

revoke all on function public.get_my_farm_order_contacts() from public, anon;
grant execute on function public.get_my_farm_order_contacts() to authenticated;

create table if not exists public.seller_reviews (
    id uuid primary key default gen_random_uuid(),
    seller_id uuid not null references public.profiles (id) on delete cascade,
    customer_id uuid not null references public.profiles (id) on delete cascade,
    order_id text not null unique references public.orders (id) on delete cascade,
    rating smallint not null check (rating between 1 and 5),
    review_text text not null check (length(trim(review_text)) between 5 and 1000),
    created_at timestamptz not null default now()
);

create index if not exists seller_reviews_seller_created_idx
    on public.seller_reviews (seller_id, created_at desc);

alter table public.seller_reviews enable row level security;
drop policy if exists "Customers read seller reviews" on public.seller_reviews;
create policy "Customers read seller reviews" on public.seller_reviews
for select to authenticated
using (true);

revoke all on public.seller_reviews from public, anon, authenticated;
grant select (seller_id, rating, review_text, created_at)
    on public.seller_reviews to authenticated;

create or replace function public.get_my_seller_review_order_ids()
returns table (order_id text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and role = 'customer'
    ) then
        raise exception 'Customer access required';
    end if;

    return query
    select review.order_id
    from public.seller_reviews as review
    where review.customer_id = (select auth.uid());
end;
$$;

revoke all on function public.get_my_seller_review_order_ids() from public, anon;
grant execute on function public.get_my_seller_review_order_ids() to authenticated;

create or replace function public.submit_farm_fresh_seller_review(
    p_order_id text,
    p_rating integer,
    p_review_text text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_seller_id uuid;
    v_review_id uuid;
    v_review_text text := trim(coalesce(p_review_text, ''));
begin
    if not exists (
        select 1
        from public.profiles
        where id = (select auth.uid())
          and role = 'customer'
    ) then
        raise exception 'Customer access required';
    end if;
    if p_rating is null or p_rating < 1 or p_rating > 5 then
        raise exception 'Choose a rating from 1 to 5 stars';
    end if;
    if length(v_review_text) < 5 or length(v_review_text) > 1000 then
        raise exception 'Feedback must be between 5 and 1000 characters';
    end if;

    select customer_order.seller_id
    into v_seller_id
    from public.orders as customer_order
    where customer_order.id = p_order_id
      and customer_order.user_id = (select auth.uid())
      and customer_order.status in ('Delivered', 'Completed')
      and customer_order.seller_id is not null;
    if not found then
        raise exception 'Only a delivered order from your account can be reviewed';
    end if;

    insert into public.seller_reviews (
        seller_id,
        customer_id,
        order_id,
        rating,
        review_text
    ) values (
        v_seller_id,
        (select auth.uid()),
        p_order_id,
        p_rating,
        v_review_text
    )
    on conflict (order_id) do nothing
    returning id into v_review_id;

    if v_review_id is null then
        raise exception 'This transaction has already been reviewed';
    end if;

    return v_review_id;
end;
$$;

revoke all on function public.submit_farm_fresh_seller_review(text, integer, text) from public, anon;
grant execute on function public.submit_farm_fresh_seller_review(text, integer, text) to authenticated;

create table if not exists public.seller_reports (
    id uuid primary key default gen_random_uuid(),
    seller_id uuid not null references public.profiles (id) on delete cascade,
    reporter_id uuid not null references public.profiles (id) on delete cascade,
    reporter_name text not null,
    reporter_email text not null,
    farm_name text not null,
    report_text text not null check (length(trim(report_text)) between 10 and 2000),
    status text not null default 'open' check (status in ('open', 'resolved')),
    resolved_by uuid references public.profiles (id) on delete set null,
    resolved_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists seller_reports_status_created_idx
    on public.seller_reports (status, created_at desc);

alter table public.seller_reports enable row level security;
drop policy if exists "Admins read seller reports" on public.seller_reports;
create policy "Admins read seller reports" on public.seller_reports
for select to authenticated
using (public.is_farm_fresh_admin());

revoke all on public.seller_reports from public, anon, authenticated;
grant select on public.seller_reports to authenticated;

create or replace function public.submit_farm_fresh_seller_report(
    p_seller_id uuid,
    p_report_text text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_reporter_name text;
    v_reporter_email text;
    v_farm_name text;
    v_report_id uuid;
    v_report_text text := trim(coalesce(p_report_text, ''));
    v_notification_count integer;
begin
    select profile.full_name, profile.email
    into v_reporter_name, v_reporter_email
    from public.profiles as profile
    where profile.id = (select auth.uid())
      and profile.role = 'customer';
    if not found then
        raise exception 'Customer access required';
    end if;
    if length(v_report_text) < 10 or length(v_report_text) > 2000 then
        raise exception 'Report details must be between 10 and 2000 characters';
    end if;

    select coalesce(application.farm_name, product.farm_name, seller.full_name)
    into v_farm_name
    from public.profiles as seller
    left join lateral (
        select seller_application.farm_name
        from public.seller_applications as seller_application
        where seller_application.user_id = seller.id
          and seller_application.status = 'approved'
        order by seller_application.reviewed_at desc nulls last,
                 seller_application.created_at desc
        limit 1
    ) as application on true
    left join lateral (
        select nullif(trim(listed_product.farm_name), '') as farm_name
        from public.products as listed_product
        where listed_product.seller_id = seller.id
          and nullif(trim(listed_product.farm_name), '') is not null
          and lower(trim(listed_product.farm_name)) <> 'farm fresh'
          and lower(trim(listed_product.farm_name)) <> lower(trim(seller.full_name))
        order by listed_product.updated_at desc, listed_product.name
        limit 1
    ) as product on true
    where seller.id = p_seller_id
      and seller.role = 'seller';
    if not found then
        raise exception 'This farm is no longer available';
    end if;

    insert into public.seller_reports (
        seller_id,
        reporter_id,
        reporter_name,
        reporter_email,
        farm_name,
        report_text
    ) values (
        p_seller_id,
        (select auth.uid()),
        coalesce(nullif(v_reporter_name, ''), 'Customer'),
        coalesce(v_reporter_email, ''),
        v_farm_name,
        v_report_text
    )
    returning id into v_report_id;

    insert into public.delivery_notifications (
        recipient_id,
        order_id,
        receipt_id,
        message
    )
    select
        admin_profile.id,
        null,
        'seller-report-' || v_report_id::text,
        'A customer submitted a report about ' || v_farm_name || '. Review it in the Admin Control Panel.'
    from public.profiles as admin_profile
    where admin_profile.role = 'admin';
    get diagnostics v_notification_count = row_count;

    if v_notification_count = 0 then
        raise exception 'No administrator account is configured to receive seller reports';
    end if;

    return v_report_id;
end;
$$;

revoke all on function public.submit_farm_fresh_seller_report(uuid, text) from public, anon;
grant execute on function public.submit_farm_fresh_seller_report(uuid, text) to authenticated;

create or replace function public.update_farm_fresh_seller_report_status(
    p_report_id uuid,
    p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_farm_fresh_admin() then
        raise exception 'Administrator access required';
    end if;
    if p_status is null or p_status not in ('open', 'resolved') then
        raise exception 'Invalid report status';
    end if;

    update public.seller_reports
    set status = p_status,
        resolved_by = case when p_status = 'resolved' then (select auth.uid()) else null end,
        resolved_at = case when p_status = 'resolved' then now() else null end
    where id = p_report_id;
    if not found then
        raise exception 'Seller report not found';
    end if;
end;
$$;

revoke all on function public.update_farm_fresh_seller_report_status(uuid, text) from public, anon;
grant execute on function public.update_farm_fresh_seller_report_status(uuid, text) to authenticated;

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'seller_reviews'
        ) then
            alter publication supabase_realtime add table public.seller_reviews;
        end if;
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'seller_reports'
        ) then
            alter publication supabase_realtime add table public.seller_reports;
        end if;
    end if;
end;
$$;

notify pgrst, 'reload schema';
