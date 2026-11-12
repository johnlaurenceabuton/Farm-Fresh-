-- Run after schema.sql and seller_marketplace.sql.
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

alter table public.seller_preapplications enable row level security;
revoke all on public.seller_preapplications from public, anon, authenticated;
grant all on public.seller_preapplications to service_role;

drop policy if exists "Customers submit seller applications" on public.seller_applications;
revoke insert on public.seller_applications from authenticated;
grant all on public.seller_applications to service_role;
grant select (id, email, role, full_name, phone, address) on public.profiles to service_role;
grant update (role, full_name, phone, address) on public.profiles to service_role;
drop policy if exists "Applicants upload own farmer certificate" on storage.objects;
