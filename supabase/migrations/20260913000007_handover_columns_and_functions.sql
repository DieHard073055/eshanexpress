create extension if not exists pgcrypto;

alter table orders
  add column if not exists handover_code_hash  text,
  add column if not exists handover_attempts   integer not null default 0,
  add column if not exists handover_locked     boolean not null default false,
  add column if not exists fulfilled_at        timestamptz,
  add column if not exists completed_at        timestamptz,
  add column if not exists completed_by        uuid references auth.users(id),
  add column if not exists completion_override_reason text;

comment on column orders.handover_code_hash is
  'bcrypt hash of the handover code. Never store the code itself: store owners
   can read this row via RLS and would otherwise self-complete orders.';

-- NOTE: pgcrypto lives in the `extensions` schema. These functions pin
-- search_path to `public, pg_temp`, so crypt()/gen_salt() MUST be schema-
-- qualified or every call fails with "function gen_salt(unknown) does not
-- exist" and the hash is silently left NULL.
--
-- The guard trigger also has to let these through: they run security definer
-- but with the CALLER's auth.uid(), so without the transaction-local flag the
-- trigger sees a customer editing a confirmed order and refuses.

create or replace function issue_handover_code(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';  -- no 0/O/1/I
  v_order orders%rowtype; v_code text := ''; i integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_order.user_id <> auth.uid() and not is_admin() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_order.status in ('completed','cancelled','declined') then
    return jsonb_build_object('ok', false, 'reason', 'order_closed');
  end if;

  for i in 1..6 loop
    v_code := v_code || substr(alphabet, 1 + (floor(random() * 32))::int, 1);
  end loop;
  if length(v_code) <> 6 then
    raise exception 'code generation failed (% chars)', length(v_code);
  end if;

  perform set_config('eshanexpress.handover_op', '1', true);
  update orders
     set handover_code_hash = extensions.crypt(v_code, extensions.gen_salt('bf')),
         handover_attempts = 0, handover_locked = false
   where id = p_order_id;
  perform set_config('eshanexpress.handover_op', '0', true);

  return jsonb_build_object('ok', true, 'code', v_code);  -- returned ONCE
end; $$;

create or replace function complete_with_code(p_order_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_order orders%rowtype; v_ok boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not (is_admin() or (auth_role() = 'store_owner' and v_order.store_id = auth_store_id())) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_order.status not in ('ready_for_pickup','shipped') then
    return jsonb_build_object('ok', false, 'reason', 'not_ready', 'status', v_order.status);
  end if;
  if v_order.handover_locked then return jsonb_build_object('ok', false, 'reason', 'locked'); end if;
  if v_order.handover_code_hash is null then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;

  v_ok := v_order.handover_code_hash
          = extensions.crypt(upper(trim(p_code)), v_order.handover_code_hash);

  perform set_config('eshanexpress.handover_op', '1', true);
  if not v_ok then
    update orders set handover_attempts = handover_attempts + 1,
                      handover_locked = (handover_attempts + 1 >= 5)
     where id = p_order_id;
    perform set_config('eshanexpress.handover_op', '0', true);
    return jsonb_build_object('ok', false, 'reason', 'wrong_code',
      'attempts_left', greatest(5 - (v_order.handover_attempts + 1), 0),
      'locked', (v_order.handover_attempts + 1 >= 5));
  end if;

  update orders set status = 'completed', completed_at = now(), completed_by = auth.uid()
   where id = p_order_id;
  perform set_config('eshanexpress.handover_op', '0', true);
  return jsonb_build_object('ok', true);
end; $$;

create or replace function admin_force_complete(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_reason is null or length(trim(p_reason)) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;
  perform set_config('eshanexpress.handover_op', '1', true);
  update orders set status = 'completed', completed_at = now(), completed_by = auth.uid(),
                    completion_override_reason = trim(p_reason)
   where id = p_order_id and status in ('ready_for_pickup','shipped');
  perform set_config('eshanexpress.handover_op', '0', true);
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_ready'); end if;
  return jsonb_build_object('ok', true);
end; $$;

revoke all on function issue_handover_code(uuid)        from public, anon;
revoke all on function complete_with_code(uuid, text)   from public, anon;
revoke all on function admin_force_complete(uuid, text) from public, anon;
grant execute on function issue_handover_code(uuid)        to authenticated;
grant execute on function complete_with_code(uuid, text)   to authenticated;
grant execute on function admin_force_complete(uuid, text) to authenticated;
