-- Server-side inventory authority.
--
-- reserve_stock() previously took the inventory total from the CLIENT, so a
-- crafted request could pass an inflated total and over-reserve. The database
-- now owns totals; they are synced from the static catalog at deploy time by
-- scripts/sync-stock.mjs.

create table product_stock (
  sku            text primary key,
  total          integer not null check (total >= 0),
  lead_time_days integer check (lead_time_days > 0),  -- null = stocked locally
  max_per_order  integer check (max_per_order > 0),
  updated_at     timestamptz not null default now()
);

alter table product_stock enable row level security;
alter table product_stock force row level security;

create policy product_stock_read_all on product_stock for select using (true);
create policy product_stock_admin_write on product_stock for all to authenticated
  using ((select is_admin())) with check ((select is_admin()));

create or replace view stock_availability
with (security_invoker = true) as
select ps.sku, ps.total,
       coalesce(sr.reserved, 0)                         as reserved,
       greatest(ps.total - coalesce(sr.reserved, 0), 0) as available,
       ps.lead_time_days, ps.max_per_order
from product_stock ps
left join stock_reservations sr on sr.sku = ps.sku;

grant select on stock_availability to anon, authenticated;

-- Replace the vulnerable signature; no client-supplied total.
drop function if exists reserve_stock(text, integer, integer);

create or replace function reserve_stock(p_sku text, p_qty integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_total integer; v_max integer; v_reserved integer; v_available integer;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive' using errcode='22023'; end if;

  select total, max_per_order into v_total, v_max from product_stock where sku = p_sku;
  if v_total is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_sku');
  end if;
  if v_max is not null and p_qty > v_max then
    return jsonb_build_object('ok', false, 'reason', 'exceeds_max_per_order', 'max_per_order', v_max);
  end if;

  insert into stock_reservations (sku, reserved) values (p_sku, 0) on conflict (sku) do nothing;
  select reserved into v_reserved from stock_reservations where sku = p_sku for update;
  v_available := v_total - v_reserved;

  if p_qty > v_available then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_stock',
                              'available', greatest(v_available, 0));
  end if;

  update stock_reservations set reserved = reserved + p_qty, updated_at = now() where sku = p_sku;
  return jsonb_build_object('ok', true, 'remaining', v_available - p_qty);
end; $$;

revoke all on function reserve_stock(text, integer) from public, anon;
grant execute on function reserve_stock(text, integer) to authenticated;
