alter table public.orders
    add column if not exists cancelled_by text,
    add column if not exists cancellation_reason text,
    add column if not exists cancellation_reason_other text,
    add column if not exists cancelled_at timestamptz;

create or replace function public.cancel_farm_fresh_customer_order(
    p_order_id text,
    p_reason text,
    p_other_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_order public.orders%rowtype;
    v_item jsonb;
    v_other_reason text := nullif(trim(p_other_reason), '');
begin
    if auth.uid() is null then
        raise exception 'Sign in before cancelling an order';
    end if;
    if p_reason is null
       or p_reason not in ('ordered_by_mistake', 'no_longer_needed', 'timing_issue', 'payment_issue', 'other') then
        raise exception 'Choose a valid cancellation reason';
    end if;
    if p_reason = 'other' and (v_other_reason is null or length(v_other_reason) not between 5 and 500) then
        raise exception 'Other cancellation reason must be between 5 and 500 characters';
    end if;

    select * into v_order
    from public.orders
    where id = p_order_id and user_id = auth.uid()
    for update;
    if not found then
        raise exception 'Order not found for this customer';
    end if;
    if v_order.status not in ('Pending', 'Preparing', 'Ready') then
        raise exception 'Only orders that are not yet delivered or cancelled can be cancelled';
    end if;

    for v_item in select value from jsonb_array_elements(v_order.items)
    loop
        update public.products
        set stock_kg = stock_kg + (v_item ->> 'quantity')::integer,
            updated_at = now()
        where id = v_item ->> 'cropId';
    end loop;

    update public.orders
    set status = 'Cancelled',
        cancelled_by = 'customer',
        cancellation_reason = p_reason,
        cancellation_reason_other = case when p_reason = 'other' then v_other_reason else null end,
        cancelled_at = now()
    where id = p_order_id;
end;
$$;

revoke all on function public.cancel_farm_fresh_customer_order(text, text, text) from public;
grant execute on function public.cancel_farm_fresh_customer_order(text, text, text) to authenticated;

create or replace function public.create_delivery_receipt_notifications()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_event_key text;
    v_message text;
    v_recipient_id uuid;
begin
    if new.status = 'Delivered'
       and old.status <> 'Delivered'
       and new.delivery_receipt is not null then
        v_event_key := nullif(new.delivery_receipt ->> 'receiptId', '');
        if v_event_key is null then
            raise exception 'Delivered order must have a receipt ID';
        end if;
        v_message := 'Delivery receipt ' || v_event_key || ' for transaction ' || new.id || ' is ready.';
    elsif new.status = 'Cancelled'
       and old.status <> 'Cancelled'
       and new.cancelled_by = 'customer' then
        v_event_key := 'CANCEL-' || new.id;
        v_message := 'Customer cancelled transaction ' || new.id || '. Reason: '
            || case new.cancellation_reason
                when 'ordered_by_mistake' then 'Ordered by mistake'
                when 'no_longer_needed' then 'No longer needed'
                when 'timing_issue' then 'Delivery or pickup timing does not work'
                when 'payment_issue' then 'Payment issue'
                when 'other' then 'Other: ' || coalesce(new.cancellation_reason_other, '')
                else 'Not provided'
            end || '.'
            || case when new.payment_status = 'Paid'
                then ' Payment is marked Paid and needs an owner refund review.'
                else ''
            end;
    else
        return new;
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
            v_event_key,
            v_message
        )
        on conflict (recipient_id, order_id, receipt_id) do nothing;
    end loop;

    return new;
end;
$$;

drop trigger if exists create_delivery_receipt_notifications on public.orders;
create trigger create_delivery_receipt_notifications
after update of status, delivery_receipt, cancelled_by on public.orders
for each row execute function public.create_delivery_receipt_notifications();
