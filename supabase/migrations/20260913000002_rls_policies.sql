-- Row-level security.
--
-- RLS denies everything unless a policy allows it. The publishable key is
-- public, so these policies are the only thing standing between an anonymous
-- visitor and the data.

alter table stores             enable row level security;
alter table profiles           enable row level security;
alter table product_drafts     enable row level security;
alter table orders             enable row level security;
alter table stock_reservations enable row level security;

-- Also apply to the table owner, so a mistake cannot silently bypass RLS.
alter table stores             force row level security;
alter table profiles           force row level security;
alter table product_drafts     force row level security;
alter table orders             force row level security;
alter table stock_reservations force row level security;

-- --------------------------------------------------------------- stores
-- Store names are shown on the public storefront.
create policy stores_read_all on stores
  for select using (true);

create policy stores_admin_write on stores
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------- profiles
create policy profiles_read_own on profiles
  for select to authenticated
  using (id = auth.uid() or is_admin());

-- Column-level restrictions (role, store_id) are enforced by the
-- guard_profile_update trigger; RLS only decides which rows are visible.
create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid() or is_admin())
  with check (id = auth.uid() or is_admin());

create policy profiles_admin_insert on profiles
  for insert to authenticated
  with check (is_admin());

create policy profiles_admin_delete on profiles
  for delete to authenticated
  using (is_admin());

-- -------------------------------------------------------- product_drafts
-- Drafts are never public: they are invisible to shoppers until an admin
-- approves them and the site is redeployed with the baked catalog.
create policy drafts_read_own_store on product_drafts
  for select to authenticated
  using (is_admin() or (auth_role() = 'store_owner' and store_id = auth_store_id()));

create policy drafts_insert_own_store on product_drafts
  for insert to authenticated
  with check (
    is_admin() or (
      auth_role() = 'store_owner'
      and store_id = auth_store_id()
      and submitted_by = auth.uid()
      and status = 'pending'      -- cannot self-approve
    )
  );

create policy drafts_update_own_pending on product_drafts
  for update to authenticated
  using (
    is_admin() or (
      auth_role() = 'store_owner'
      and store_id = auth_store_id()
      and status = 'pending'      -- an approved draft is frozen
    )
  )
  with check (
    is_admin() or (
      auth_role() = 'store_owner'
      and store_id = auth_store_id()
      and status = 'pending'
    )
  );

create policy drafts_delete_own_pending on product_drafts
  for delete to authenticated
  using (
    is_admin() or (
      auth_role() = 'store_owner'
      and store_id = auth_store_id()
      and status = 'pending'
    )
  );

-- --------------------------------------------------------------- orders
create policy orders_read_own on orders
  for select to authenticated
  using (
    user_id = auth.uid()
    or is_admin()
    or (auth_role() = 'store_owner' and store_id = auth_store_id())
  );

-- A customer may create an order only for themselves, only in the initial
-- status, and only with reconciliation fields left empty.
create policy orders_insert_own on orders
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'awaiting_payment'
    and matched_txn_ref is null
    and matched_at is null
    and decline_reason is null
    and receipt_archived_at is null
    and archived_at is null
  );

-- Which rows may be updated. WHICH COLUMNS is enforced by the
-- guard_order_customer_update trigger, since RLS cannot compare old vs new.
create policy orders_update_scoped on orders
  for update to authenticated
  using (
    is_admin()
    or (user_id = auth.uid() and status in ('awaiting_payment', 'payment_submitted'))
    or (auth_role() = 'store_owner' and store_id = auth_store_id() and status = 'confirmed')
  )
  with check (
    is_admin()
    or user_id = auth.uid()
    or (auth_role() = 'store_owner' and store_id = auth_store_id())
  );

create policy orders_admin_delete on orders
  for delete to authenticated
  using (is_admin());

-- --------------------------------------------------- stock_reservations
-- Readable by anyone: the product page subtracts this from the static total.
create policy stock_read_all on stock_reservations
  for select using (true);

-- No client write policy at all. Writes happen only through the
-- security-definer reserve/release functions below.
create policy stock_admin_write on stock_reservations
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ------------------------------------------------------------ functions
-- Reserve stock atomically at checkout. Runs as owner so it can write
-- stock_reservations without granting clients direct write access.
create or replace function reserve_stock(p_sku text, p_qty integer, p_total integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_reserved integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_qty <= 0 then
    raise exception 'quantity must be positive';
  end if;

  -- Lock the row so concurrent checkouts cannot both pass the check.
  insert into stock_reservations (sku, reserved) values (p_sku, 0)
    on conflict (sku) do nothing;

  select reserved into current_reserved
    from stock_reservations where sku = p_sku for update;

  if current_reserved + p_qty > p_total then
    return false;
  end if;

  update stock_reservations
     set reserved = reserved + p_qty, updated_at = now()
   where sku = p_sku;

  return true;
end;
$$;

create or replace function release_stock(p_sku text, p_qty integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  update stock_reservations
     set reserved = greatest(reserved - p_qty, 0), updated_at = now()
   where sku = p_sku;
end;
$$;

revoke all on function reserve_stock(text, integer, integer) from public, anon;
revoke all on function release_stock(text, integer)          from public, anon;
grant execute on function reserve_stock(text, integer, integer) to authenticated;
grant execute on function release_stock(text, integer)          to authenticated;
