-- Run after schema.sql on projects that already have the original Farm Fresh schema.
-- Run seller_preapproval.sql after this file to enable pre-account applications.
create extension if not exists pgcrypto;

alter table public.profiles
    drop constraint if exists profiles_role_check;
alter table public.profiles
    add constraint profiles_role_check check (role in ('customer', 'seller', 'admin'));

alter table public.products
    add column if not exists seller_id uuid references public.profiles (id) on delete set null,
    add column if not exists farm_name text not null default 'Farm Fresh';

alter table public.orders
    add column if not exists seller_id uuid references public.profiles (id) on delete set null;

create table if not exists public.seller_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.profiles (id) on delete cascade,
    farm_name text not null check (length(trim(farm_name)) between 2 and 100),
    farm_description text not null default '' check (length(farm_description) <= 1000),
    certificate_path text not null unique,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    review_notes text not null default '',
    reviewed_by uuid references public.profiles (id),
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists seller_applications_user_created_idx
    on public.seller_applications (user_id, created_at desc);
create index if not exists products_seller_name_idx
    on public.products (seller_id, name);
create index if not exists orders_seller_created_idx
    on public.orders (seller_id, created_at desc);

alter table public.seller_applications enable row level security;

create or replace function public.is_farm_fresh_seller()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'seller'
    );
$$;

create or replace function public.prevent_client_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is not null
       and coalesce(auth.role(), '') <> 'service_role'
       and new.role is distinct from old.role
       and not public.is_farm_fresh_admin() then
        raise exception 'Only the owner can change account roles';
    end if;
    return new;
end;
$$;

drop policy if exists "Sellers manage own products" on public.products;
create policy "Sellers manage own products" on public.products
for all to authenticated
using (seller_id = (select auth.uid()) and public.is_farm_fresh_seller())
with check (seller_id = (select auth.uid()) and public.is_farm_fresh_seller());

drop policy if exists "Customers see own orders and admins see all" on public.orders;
drop policy if exists "Customers sellers and admins read authorized orders" on public.orders;
drop policy if exists "Customers and sellers read orders; admins read receipts" on public.orders;
create policy "Customers and sellers read orders; admins read receipts" on public.orders
for select to authenticated
using (
    (
        user_id = (select auth.uid())
        and not public.is_farm_fresh_admin()
    )
    or (seller_id = (select auth.uid()) and public.is_farm_fresh_seller())
    or (public.is_farm_fresh_admin() and delivery_receipt is not null)
);

drop policy if exists "Users read own or admin reads seller applications" on public.seller_applications;
create policy "Users read own or admin reads seller applications" on public.seller_applications
for select to authenticated
using (user_id = (select auth.uid()) or public.is_farm_fresh_admin());

drop policy if exists "Customers submit seller applications" on public.seller_applications;
drop policy if exists "Admins review seller applications" on public.seller_applications;

revoke all on public.seller_applications from anon, authenticated;
grant select on public.seller_applications to authenticated;
grant all on public.seller_applications to service_role;
grant insert, update, delete on public.products to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'farmer-certificates',
    'farmer-certificates',
    false,
    8388608,
    array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Applicants upload own farmer certificate" on storage.objects;

drop policy if exists "Applicants and owner read farmer certificates" on storage.objects;
create policy "Applicants and owner read farmer certificates" on storage.objects
for select to authenticated
using (
    bucket_id = 'farmer-certificates'
    and (
        split_part(name, '/', 1) = (select auth.uid())::text
        or public.is_farm_fresh_admin()
    )
);

drop policy if exists "Owner removes unsubmitted farmer certificates" on storage.objects;
create policy "Owner removes unsubmitted farmer certificates" on storage.objects
for delete to authenticated
using (
    bucket_id = 'farmer-certificates'
    and split_part(name, '/', 1) = (select auth.uid())::text
    and not exists (
        select 1 from public.seller_applications
        where certificate_path = name
    )
);

create or replace function public.review_farm_fresh_seller_application(
    p_application_id uuid,
    p_decision text,
    p_review_notes text default ''
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_application public.seller_applications%rowtype;
begin
    if not public.is_farm_fresh_admin() then
        raise exception 'Owner administrator access required';
    end if;
    if p_decision not in ('approved', 'rejected') then
        raise exception 'Choose approved or rejected';
    end if;
    if length(coalesce(p_review_notes, '')) > 1000 then
        raise exception 'Review notes are too long';
    end if;

    select * into v_application
    from public.seller_applications
    where id = p_application_id
    for update;
    if not found then raise exception 'Seller application not found'; end if;
    if v_application.status <> 'pending' then
        raise exception 'This seller application has already been reviewed';
    end if;

    update public.seller_applications
    set status = p_decision,
        review_notes = coalesce(p_review_notes, ''),
        reviewed_by = auth.uid(),
        reviewed_at = now()
    where id = p_application_id;

    if p_decision = 'approved' then
        update public.profiles
        set role = 'seller'
        where id = v_application.user_id
          and role = 'customer';
        if not found then
            raise exception 'Applicant is no longer an eligible customer';
        end if;
    end if;
end;
$$;

drop function if exists public.place_farm_fresh_order(text, text, text, date, text, jsonb);
create function public.place_farm_fresh_order(
    p_order_type text,
    p_payment_method text,
    p_payment_reference text,
    p_reservation_date date,
    p_delivery_address text,
    p_items jsonb
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_product public.products%rowtype;
    v_item jsonb;
    v_group record;
    v_items jsonb := '[]'::jsonb;
    v_quantity integer;
    v_order_quantity integer;
    v_order_amount numeric(12, 2);
    v_payment_status text;
    v_order_id text;
    v_order_ids text[] := array[]::text[];
    v_delivery_address text;
begin
    if v_user_id is null then raise exception 'Sign in before placing an order'; end if;
    if p_order_type not in ('reserve', 'pickup', 'delivery') then raise exception 'Invalid order type'; end if;
    if p_payment_method not in ('gcash', 'maya', 'bank', 'cashier') then raise exception 'Invalid payment method'; end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Select at least one product'; end if;
    if jsonb_array_length(p_items) > 30 then raise exception 'Too many order lines'; end if;
    if length(coalesce(p_payment_reference, '')) > 100 then raise exception 'Payment reference is too long'; end if;
    if length(coalesce(p_delivery_address, '')) > 500 then raise exception 'Delivery address is too long'; end if;

    select * into v_profile from public.profiles where id = v_user_id;
    if not found then raise exception 'Customer profile is not ready'; end if;

    if p_order_type = 'reserve' and (
        p_reservation_date is null or not exists (
            select 1 from public.reservation_dates where available_on = p_reservation_date
        )
    ) then raise exception 'Choose an available reservation date'; end if;

    if p_payment_method <> 'cashier' and not exists (
        select 1 from public.payment_qrs where method = p_payment_method
    ) then raise exception 'This online payment method is not configured'; end if;

    perform id
    from public.products
    where id in (
        select value ->> 'product_id'
        from jsonb_array_elements(p_items) as entries(value)
    )
    order by id
    for update;

    for v_item in select value from jsonb_array_elements(p_items)
    loop
        if (v_item ->> 'quantity') !~ '^[1-9][0-9]*$' then
            raise exception 'Invalid item quantity';
        end if;
        v_quantity := (v_item ->> 'quantity')::integer;
        if exists (
            select 1 from jsonb_array_elements(p_items) as entries(value)
            where value ->> 'product_id' = v_item ->> 'product_id'
            group by value ->> 'product_id'
            having count(*) > 1
        ) then raise exception 'Duplicate products are not allowed'; end if;

        select * into v_product
        from public.products
        where id = v_item ->> 'product_id';
        if not found then raise exception 'A selected product is no longer available'; end if;
        if v_product.stock_kg <= 15 then
            raise exception '% is no longer available for ordering', v_product.name;
        end if;
        if v_product.stock_kg < v_quantity then
            raise exception 'Not enough stock for % (available: % kg)', v_product.name, v_product.stock_kg;
        end if;

        update public.products
        set stock_kg = stock_kg - v_quantity, updated_at = now()
        where id = v_product.id;

        v_items := v_items || jsonb_build_array(jsonb_build_object(
            'cropId', v_product.id,
            'cropName', v_product.name,
            'farmName', v_product.farm_name,
            'sellerId', v_product.seller_id,
            'quantity', v_quantity,
            'pricePerKg', v_product.price_per_kg,
            'subtotal', round(v_product.price_per_kg * v_quantity, 2)
        ));
    end loop;

    v_payment_status := case when p_payment_method = 'cashier'
        then 'Due at cashier' else 'Awaiting verification' end;
    v_delivery_address := case when p_order_type = 'delivery'
        then coalesce(nullif(trim(p_delivery_address), ''), v_profile.address)
        else v_profile.address end;

    for v_group in
        select
            value ->> 'sellerId' as seller_id,
            jsonb_agg(value) as grouped_items,
            sum((value ->> 'quantity')::integer)::integer as total_quantity,
            sum((value ->> 'subtotal')::numeric)::numeric(12, 2) as total_amount
        from jsonb_array_elements(v_items) as entries(value)
        group by value ->> 'sellerId'
    loop
        v_order_id := 'TXN-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
        v_order_quantity := v_group.total_quantity;
        v_order_amount := v_group.total_amount;

        insert into public.orders (
            id, user_id, seller_id, customer, order_type, payment_method, payment_status,
            payment_reference, reservation_date, items, total_quantity, total_amount
        ) values (
            v_order_id,
            v_user_id,
            nullif(v_group.seller_id, '')::uuid,
            jsonb_build_object(
                'fullName', v_profile.full_name,
                'email', v_profile.email,
                'phone', v_profile.phone,
                'address', v_delivery_address
            ),
            p_order_type,
            p_payment_method,
            v_payment_status,
            coalesce(p_payment_reference, ''),
            case when p_order_type = 'reserve' then p_reservation_date else null end,
            v_group.grouped_items,
            v_order_quantity,
            v_order_amount
        );
        v_order_ids := array_append(v_order_ids, v_order_id);
    end loop;

    return v_order_ids;
end;
$$;

create or replace function public.set_farm_fresh_order_status(p_order_id text, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_order public.orders%rowtype;
    v_item jsonb;
begin
    if not public.is_farm_fresh_seller() then
        raise exception 'Approved seller access required';
    end if;
    if p_status not in ('Preparing', 'Ready', 'Delivered', 'Cancelled') then
        raise exception 'Invalid order status';
    end if;

    select * into v_order from public.orders where id = p_order_id for update;
    if not found then raise exception 'Order not found'; end if;
    if v_order.seller_id is distinct from auth.uid() then
        raise exception 'This order does not belong to your farm';
    end if;
    if v_order.status = p_status then return; end if;
    if v_order.status = 'Cancelled' and p_status <> 'Cancelled' then
        raise exception 'Cancelled orders cannot be reopened';
    end if;
    if (
        (v_order.status = 'Pending' and p_status not in ('Preparing', 'Cancelled'))
        or (v_order.status = 'Preparing' and p_status not in ('Ready', 'Cancelled'))
        or (v_order.status = 'Ready' and p_status not in ('Delivered', 'Cancelled'))
        or (v_order.status in ('Delivered', 'Completed') and p_status <> v_order.status)
    ) then
        raise exception 'Seller order status must follow the delivery workflow';
    end if;

    if p_status = 'Cancelled' and v_order.status <> 'Cancelled' then
        for v_item in select value from jsonb_array_elements(v_order.items)
        loop
            update public.products
            set stock_kg = stock_kg + (v_item ->> 'quantity')::integer,
                updated_at = now()
            where id = v_item ->> 'cropId';
        end loop;
    end if;

    update public.orders
    set status = p_status,
        delivered_at = case when p_status = 'Delivered' then now() else delivered_at end,
        delivery_receipt = case when p_status = 'Delivered' then jsonb_build_object(
            'receiptId', 'DLV-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
            'transactionId', v_order.id,
            'preparedBy', coalesce((select full_name from public.profiles where id = auth.uid()), 'Farm Fresh Owner'),
            'issuedAt', now(),
            'items', v_order.items,
            'totalQuantity', v_order.total_quantity,
            'totalAmount', v_order.total_amount,
            'paymentMethod', v_order.payment_method,
            'paymentStatus', v_order.payment_status,
            'paymentReference', v_order.payment_reference,
            'orderType', v_order.order_type,
            'reservationDate', coalesce(v_order.reservation_date::text, 'N/A'),
            'customer', v_order.customer
        ) else null end,
        customer_received_at = case when p_status = 'Delivered' then null else customer_received_at end
    where id = p_order_id;
end;
$$;

create or replace function public.update_farm_fresh_inventory(p_updates jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_item jsonb;
    v_product_id text;
    v_seller_id uuid;
    v_is_admin boolean := public.is_farm_fresh_admin();
begin
    if not v_is_admin and not public.is_farm_fresh_seller() then
        raise exception 'Seller or owner administrator access required';
    end if;
    if p_updates is null or jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 100 then
        raise exception 'Invalid inventory update';
    end if;

    for v_item in select value from jsonb_array_elements(p_updates)
    loop
        v_product_id := nullif(v_item ->> 'product_id', '');
        if v_product_id is null or not (v_item ? 'stock_kg' or v_item ? 'price_per_kg') then
            raise exception 'Inventory update is missing a product or changed value';
        end if;
        if v_item ? 'stock_kg' and (
            v_item ->> 'stock_kg' is null or (v_item ->> 'stock_kg') !~ '^(0|[1-9][0-9]*)$'
        ) then raise exception 'Stock must be a non-negative whole number'; end if;
        if v_item ? 'price_per_kg' and (
            v_item ->> 'price_per_kg' is null or (v_item ->> 'price_per_kg') !~ '^[0-9]+(\.[0-9]{1,2})?$'
        ) then raise exception 'Price must be a non-negative amount with up to two decimals'; end if;

        select seller_id into v_seller_id
        from public.products
        where id = v_product_id
        for update;
        if not found then raise exception 'Product % no longer exists', v_product_id; end if;
        if not v_is_admin and v_seller_id is distinct from auth.uid() then
            raise exception 'You can only change your own farm inventory';
        end if;

        update public.products
        set stock_kg = case when v_item ? 'stock_kg'
                then (v_item ->> 'stock_kg')::integer else stock_kg end,
            price_per_kg = case when v_item ? 'price_per_kg'
                then (v_item ->> 'price_per_kg')::numeric(12, 2) else price_per_kg end,
            updated_at = now()
        where id = v_product_id;
    end loop;
end;
$$;

revoke all on function public.review_farm_fresh_seller_application(uuid, text, text) from public;
revoke all on function public.place_farm_fresh_order(text, text, text, date, text, jsonb) from public;
revoke all on function public.set_farm_fresh_order_status(text, text) from public;
revoke all on function public.update_farm_fresh_inventory(jsonb) from public;
grant execute on function public.review_farm_fresh_seller_application(uuid, text, text) to authenticated;
grant execute on function public.place_farm_fresh_order(text, text, text, date, text, jsonb) to authenticated;
grant execute on function public.set_farm_fresh_order_status(text, text) to authenticated;
grant execute on function public.update_farm_fresh_inventory(jsonb) to authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'seller_applications'
    ) then
        alter publication supabase_realtime add table public.seller_applications;
    end if;
end;
$$;
