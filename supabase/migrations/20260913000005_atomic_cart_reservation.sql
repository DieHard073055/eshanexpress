-- Reserve a whole cart atomically.
--
-- Reserving line by line from the client strands partial reservations when a
-- later line fails. This reserves everything in one transaction and rolls the
-- lot back on any failure. Verified: a two-line cart whose second line
-- exceeds stock leaves zero reservations behind.
--
-- p_items: [{"sku":"EX-1001","qty":2}, ...]
create or replace function reserve_cart(p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_item jsonb; v_sku text; v_qty integer;
  v_total integer; v_max integer; v_reserved integer; v_available integer;
  v_failures jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items must be a non-empty array' using errcode='22023';
  end if;

  -- Deterministic lock order avoids deadlocks between concurrent carts.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'sku' loop
    v_sku := v_item->>'sku';
    v_qty := (v_item->>'qty')::integer;
    if v_sku is null or v_qty is null or v_qty <= 0 then
      raise exception 'each item needs a sku and a positive qty' using errcode='22023';
    end if;

    select total, max_per_order into v_total, v_max from product_stock where sku = v_sku;
    if v_total is null then
      v_failures := v_failures || jsonb_build_object('sku', v_sku, 'reason', 'unknown_sku');
      continue;
    end if;
    if v_max is not null and v_qty > v_max then
      v_failures := v_failures || jsonb_build_object('sku', v_sku,
        'reason', 'exceeds_max_per_order', 'max_per_order', v_max);
      continue;
    end if;

    insert into stock_reservations (sku, reserved) values (v_sku, 0) on conflict (sku) do nothing;
    select reserved into v_reserved from stock_reservations where sku = v_sku for update;
    v_available := v_total - v_reserved;

    if v_qty > v_available then
      v_failures := v_failures || jsonb_build_object('sku', v_sku,
        'reason', 'insufficient_stock', 'available', greatest(v_available,0), 'requested', v_qty);
      continue;
    end if;

    update stock_reservations set reserved = reserved + v_qty, updated_at = now() where sku = v_sku;
  end loop;

  -- All or nothing.
  if jsonb_array_length(v_failures) > 0 then
    raise exception 'RESERVE_FAILED:%', v_failures::text using errcode = 'P0002';
  end if;

  return jsonb_build_object('ok', true);
exception
  when sqlstate 'P0002' then
    return jsonb_build_object('ok', false,
      'failures', substring(sqlerrm from 'RESERVE_FAILED:(.*)$')::jsonb);
end; $$;

create or replace function release_cart(p_items jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_item jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    update stock_reservations
       set reserved = greatest(reserved - (v_item->>'qty')::integer, 0), updated_at = now()
     where sku = v_item->>'sku';
  end loop;
end; $$;

revoke all on function reserve_cart(jsonb)  from public, anon;
revoke all on function release_cart(jsonb)  from public, anon;
grant execute on function reserve_cart(jsonb) to authenticated;
grant execute on function release_cart(jsonb) to authenticated;
