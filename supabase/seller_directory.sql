-- Run after seller_marketplace.sql to safely expose approved seller farm names.
create or replace function public.list_public_seller_farms()
returns table (seller_id uuid, farm_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select
        seller.id,
        coalesce(application.farm_name, product.farm_name)
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

notify pgrst, 'reload schema';
