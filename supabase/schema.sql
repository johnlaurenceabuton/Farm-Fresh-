create extension if not exists pgcrypto;

create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null,
    full_name text not null default '',
    phone text not null default '',
    address text not null default '',
    role text not null default 'customer' check (role in ('customer', 'seller', 'admin')),
    created_at timestamptz not null default now()
);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.profiles (id, email, full_name, phone, address)
    values (
        new.id,
        coalesce(new.email, ''),
        coalesce(new.raw_user_meta_data ->> 'full_name', ''),
        coalesce(new.raw_user_meta_data ->> 'phone', ''),
        coalesce(new.raw_user_meta_data ->> 'address', '')
    )
    on conflict (id) do update
    set email = excluded.email;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created_farm_fresh on auth.users;
create trigger on_auth_user_created_farm_fresh
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

insert into public.profiles (id, email, full_name, phone, address)
select
    id,
    coalesce(email, ''),
    coalesce(raw_user_meta_data ->> 'full_name', ''),
    coalesce(raw_user_meta_data ->> 'phone', ''),
    coalesce(raw_user_meta_data ->> 'address', '')
from auth.users
on conflict (id) do update
set email = excluded.email;

create or replace function public.prevent_client_role_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is not null and new.role is distinct from old.role then
        raise exception 'Profile roles can only be changed from the Supabase SQL editor';
    end if;
    return new;
end;
$$;

drop trigger if exists profiles_prevent_client_role_change on public.profiles;
create trigger profiles_prevent_client_role_change
before update of role on public.profiles
for each row execute function public.prevent_client_role_change();

create table if not exists public.products (
    id text primary key,
    name text not null,
    type text not null,
    stock_per_unit integer not null default 0 check (stock_per_unit >= 0),
    stock_kg integer not null default 0 check (stock_kg >= 0),
    price_per_kg numeric(12, 2) not null default 0 check (price_per_kg >= 0),
    image text not null default '',
    updated_at timestamptz not null default now()
);

create table if not exists public.reservation_dates (
    available_on date primary key
);

create table if not exists public.payment_qrs (
    method text primary key check (method in ('gcash', 'maya', 'bank')),
    image_data text not null,
    updated_at timestamptz not null default now()
);

create table if not exists public.orders (
    id text primary key,
    user_id uuid not null references auth.users (id),
    customer jsonb not null,
    order_type text not null check (order_type in ('reserve', 'pickup', 'delivery')),
    payment_method text not null check (payment_method in ('gcash', 'maya', 'bank', 'cashier')),
    payment_status text not null,
    payment_reference text not null default '',
    reservation_date date,
    items jsonb not null,
    total_quantity integer not null check (total_quantity > 0),
    total_amount numeric(12, 2) not null check (total_amount >= 0),
    status text not null default 'Pending'
        check (status in ('Pending', 'Preparing', 'Ready', 'Delivered', 'Completed', 'Cancelled')),
    delivery_receipt jsonb,
    customer_received_at timestamptz,
    delivered_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists orders_user_created_idx on public.orders (user_id, created_at desc);
create index if not exists orders_created_idx on public.orders (created_at desc);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.reservation_dates enable row level security;
alter table public.payment_qrs enable row level security;
alter table public.orders enable row level security;

create or replace function public.is_farm_fresh_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = (select auth.uid()) and role = 'admin'
    );
$$;

drop policy if exists "Profiles visible to owner and admins" on public.profiles;
create policy "Profiles visible to owner and admins" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or public.is_farm_fresh_admin());

drop policy if exists "Customers update own contact details" on public.profiles;
create policy "Customers update own contact details" on public.profiles
for update to authenticated
using (id = (select auth.uid()) or public.is_farm_fresh_admin())
with check (id = (select auth.uid()) or public.is_farm_fresh_admin());

drop policy if exists "Products are public" on public.products;
create policy "Products are public" on public.products
for select to anon, authenticated using (true);

drop policy if exists "Admins manage products" on public.products;
create policy "Admins manage products" on public.products
for all to authenticated
using (public.is_farm_fresh_admin())
with check (public.is_farm_fresh_admin());

drop policy if exists "Reservation dates are public" on public.reservation_dates;
create policy "Reservation dates are public" on public.reservation_dates
for select to anon, authenticated using (true);

drop policy if exists "Admins manage reservation dates" on public.reservation_dates;
create policy "Admins manage reservation dates" on public.reservation_dates
for all to authenticated
using (public.is_farm_fresh_admin())
with check (public.is_farm_fresh_admin());

drop policy if exists "Payment QR codes are public" on public.payment_qrs;
create policy "Payment QR codes are public" on public.payment_qrs
for select to anon, authenticated using (true);

drop policy if exists "Admins manage payment QR codes" on public.payment_qrs;
create policy "Admins manage payment QR codes" on public.payment_qrs
for all to authenticated
using (public.is_farm_fresh_admin())
with check (public.is_farm_fresh_admin());

drop policy if exists "Customers see own orders and admins see all" on public.orders;
create policy "Customers see own orders and admins see all" on public.orders
for select to authenticated
using (user_id = (select auth.uid()) or public.is_farm_fresh_admin());

revoke all on public.profiles, public.products, public.reservation_dates,
    public.payment_qrs, public.orders from anon, authenticated;
grant select on public.products, public.reservation_dates, public.payment_qrs to anon, authenticated;
grant select on public.profiles, public.orders to authenticated;
grant insert, update, delete on public.products, public.reservation_dates,
    public.payment_qrs to authenticated;
grant update (full_name, phone, address) on public.profiles to authenticated;

insert into public.products (id, name, type, stock_per_unit, stock_kg, price_per_kg)
values
    ('potato', 'Potato', 'Root Crop', 100, 100, 45),
    ('carrot', 'Carrot', 'Root Crop', 100, 100, 50),
    ('radish', 'Radish', 'Root Crop', 100, 100, 40),
    ('beetroot', 'Beetroot', 'Root Crop', 100, 100, 55),
    ('cabbage', 'Cabbage', 'Vegetable', 50, 50, 35),
    ('pechay', 'Chinese Pechay', 'Vegetable', 50, 50, 30),
    ('lettuce', 'Iceberg Lettuce', 'Vegetable', 50, 50, 60),
    ('romaine-lettuce', 'Romaine Lettuce', 'Vegetable', 50, 50, 60),
    ('green-leaf-lettuce', 'Green Leaf Lettuce', 'Vegetable', 50, 50, 60),
    ('red-leaf-lettuce', 'Red Leaf Lettuce', 'Vegetable', 50, 50, 60)
on conflict (id) do nothing;

insert into public.reservation_dates (available_on)
values (current_date + 7), (current_date + 10), (current_date + 14)
on conflict do nothing;

create or replace function public.place_farm_fresh_order(
    p_order_type text,
    p_payment_method text,
    p_payment_reference text,
    p_reservation_date date,
    p_delivery_address text,
    p_items jsonb
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id uuid := auth.uid();
    v_profile public.profiles%rowtype;
    v_product public.products%rowtype;
    v_item jsonb;
    v_items jsonb := '[]'::jsonb;
    v_quantity integer;
    v_total_quantity integer := 0;
    v_total_amount numeric(12, 2) := 0;
    v_payment_status text;
    v_order_id text := 'TXN-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text
        || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
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
        where id = v_item ->> 'product_id'
        for update;
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
            'quantity', v_quantity,
            'pricePerKg', v_product.price_per_kg,
            'subtotal', round(v_product.price_per_kg * v_quantity, 2)
        ));
        v_total_quantity := v_total_quantity + v_quantity;
        v_total_amount := v_total_amount + round(v_product.price_per_kg * v_quantity, 2);
    end loop;

    v_payment_status := case when p_payment_method = 'cashier'
        then 'Due at cashier' else 'Awaiting verification' end;

    insert into public.orders (
        id, user_id, customer, order_type, payment_method, payment_status,
        payment_reference, reservation_date, items, total_quantity, total_amount
    ) values (
        v_order_id,
        v_user_id,
        jsonb_build_object(
            'fullName', v_profile.full_name,
            'email', v_profile.email,
            'phone', v_profile.phone,
            'address', case when p_order_type = 'delivery'
                then coalesce(nullif(trim(p_delivery_address), ''), v_profile.address)
                else v_profile.address end
        ),
        p_order_type,
        p_payment_method,
        v_payment_status,
        coalesce(p_payment_reference, ''),
        case when p_order_type = 'reserve' then p_reservation_date else null end,
        v_items,
        v_total_quantity,
        v_total_amount
    );
    return v_order_id;
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
    if not public.is_farm_fresh_admin() then raise exception 'Administrator access required'; end if;
    if p_status not in ('Pending', 'Preparing', 'Ready', 'Delivered', 'Completed', 'Cancelled') then
        raise exception 'Invalid order status';
    end if;
    select * into v_order from public.orders where id = p_order_id for update;
    if not found then raise exception 'Order not found'; end if;
    if v_order.status = 'Cancelled' and p_status <> 'Cancelled' then
        raise exception 'Cancelled orders cannot be reopened';
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
            'adminEmail', (select email from public.profiles where id = auth.uid()),
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

create or replace function public.set_farm_fresh_payment_status(p_order_id text, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_farm_fresh_admin() then raise exception 'Administrator access required'; end if;
    if p_status not in ('Awaiting verification', 'Due at cashier', 'Payment submitted', 'Paid', 'Refunded') then
        raise exception 'Invalid payment status';
    end if;
    update public.orders set payment_status = p_status where id = p_order_id;
    if not found then raise exception 'Order not found'; end if;
end;
$$;

create or replace function public.confirm_farm_fresh_order_received(p_order_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then raise exception 'Sign in before confirming receipt'; end if;
    update public.orders
    set customer_received_at = now(), delivery_receipt = null
    where id = p_order_id
      and user_id = auth.uid()
      and status = 'Delivered'
      and delivery_receipt is not null;
    if not found then raise exception 'Delivered order receipt was not found'; end if;
end;
$$;

create or replace function public.replace_farm_fresh_reservation_dates(p_dates date[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_farm_fresh_admin() then raise exception 'Administrator access required'; end if;
    if coalesce(cardinality(p_dates), 0) < 2 or cardinality(p_dates) > 3 then
        raise exception 'Choose between 2 and 3 reservation dates';
    end if;
    if exists (
        select 1 from unnest(p_dates) as dates(value)
        where value < current_date + 7
    ) then raise exception 'Reservation dates must be at least one week from today'; end if;
    if cardinality(p_dates) <> (select count(distinct value) from unnest(p_dates) as dates(value)) then
        raise exception 'Reservation dates must be unique';
    end if;
    delete from public.reservation_dates;
    insert into public.reservation_dates (available_on)
    select distinct value from unnest(p_dates) as dates(value);
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
begin
    if not public.is_farm_fresh_admin() then raise exception 'Administrator access required'; end if;
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

        update public.products
        set stock_kg = case when v_item ? 'stock_kg'
                then (v_item ->> 'stock_kg')::integer else stock_kg end,
            price_per_kg = case when v_item ? 'price_per_kg'
                then (v_item ->> 'price_per_kg')::numeric(12, 2) else price_per_kg end,
            updated_at = now()
        where id = v_product_id;
        if not found then raise exception 'Product % no longer exists', v_product_id; end if;
    end loop;
end;
$$;

revoke all on function public.place_farm_fresh_order(text, text, text, date, text, jsonb) from public;
revoke all on function public.set_farm_fresh_order_status(text, text) from public;
revoke all on function public.set_farm_fresh_payment_status(text, text) from public;
revoke all on function public.confirm_farm_fresh_order_received(text) from public;
revoke all on function public.replace_farm_fresh_reservation_dates(date[]) from public;
revoke all on function public.update_farm_fresh_inventory(jsonb) from public;
grant execute on function public.place_farm_fresh_order(text, text, text, date, text, jsonb) to authenticated;
grant execute on function public.set_farm_fresh_order_status(text, text) to authenticated;
grant execute on function public.set_farm_fresh_payment_status(text, text) to authenticated;
grant execute on function public.confirm_farm_fresh_order_received(text) to authenticated;
grant execute on function public.replace_farm_fresh_reservation_dates(date[]) to authenticated;
grant execute on function public.update_farm_fresh_inventory(jsonb) to authenticated;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products'
    ) then
        alter publication supabase_realtime add table public.products;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
    ) then
        alter publication supabase_realtime add table public.orders;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'reservation_dates'
    ) then
        alter publication supabase_realtime add table public.reservation_dates;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payment_qrs'
    ) then
        alter publication supabase_realtime add table public.payment_qrs;
    end if;
end;
$$;

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

create table if not exists public.seller_preapplications (
    id uuid primary key default gen_random_uuid(),
    full_name text not null check (length(trim(full_name)) between 2 and 120),
    email text not null check (
        length(email) between 5 and 254
        and email = lower(email)
        and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ),
    phone text not null check (length(trim(phone)) between 5 and 40),
    address text not null check (length(trim(address)) between 3 and 300),
    farm_name text not null check (length(trim(farm_name)) between 2 and 100),
    farm_description text not null default '' check (length(farm_description) <= 1000),
    certificate_path text not null unique,
    status text not null default 'pending'
        check (status in ('pending', 'processing', 'approved', 'rejected')),
    review_notes text not null default '' check (length(review_notes) <= 1000),
    approved_user_id uuid references public.profiles (id) on delete set null,
    reviewed_by uuid references public.profiles (id) on delete set null,
    processing_started_at timestamptz,
    reviewed_at timestamptz,
    created_at timestamptz not null default now()
);

create unique index if not exists seller_preapplications_active_email_idx
    on public.seller_preapplications (email)
    where status in ('pending', 'processing');
create index if not exists seller_preapplications_created_idx
    on public.seller_preapplications (created_at desc);

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

revoke all on public.seller_applications, public.seller_preapplications from public, anon, authenticated;
grant select on public.seller_applications to authenticated;
grant all on public.seller_applications, public.seller_preapplications to service_role;

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

-- After the owner has signed up, promote that exact email from the SQL editor:
-- update public.profiles
-- set role = 'admin'
-- where email = lower('OWNER_EMAIL_HERE');
