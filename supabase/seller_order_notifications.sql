-- Run after customer_order_cancellation.sql.
-- Adds seller-only notifications for newly placed seller orders without
-- replacing the existing delivery and cancellation notification triggers.
create or replace function public.create_new_order_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_items text;
begin
    if new.seller_id is null then
        return new;
    end if;

    select string_agg(
        format('%s kg %s', item ->> 'quantity', item ->> 'cropName'),
        ', ' order by item ->> 'cropName'
    )
    into v_items
    from jsonb_array_elements(new.items) as entries(item);

    insert into public.delivery_notifications (
        recipient_id,
        order_id,
        receipt_id,
        message
    ) values (
        new.seller_id,
        new.id,
        'order_placed',
        'New order ' || new.id || ': ' || coalesce(v_items, 'new items ordered') || '.'
    )
    on conflict (recipient_id, order_id, receipt_id) do nothing;

    return new;
end;
$$;

drop trigger if exists create_new_order_notifications on public.orders;
create trigger create_new_order_notifications
after insert on public.orders
for each row execute function public.create_new_order_notifications();
