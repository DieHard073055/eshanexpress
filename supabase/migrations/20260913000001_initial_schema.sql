-- EshanExpress initial schema.
--
-- The publishable key ships in the client bundle, so RLS is the entire
-- security model. Every table below enables RLS and denies by default;
-- access exists only where a policy grants it.

-- ---------------------------------------------------------------- types
create type user_role as enum ('customer', 'store_owner', 'admin');

create type order_status as enum (
  'awaiting_payment',
  'payment_submitted',
  'confirmed',
  'declined',
  'fulfilled',
  'cancelled'
);

create type draft_status as enum ('pending', 'approved', 'rejected');

-- --------------------------------------------------------------- stores
create table stores (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  name       text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- profiles
create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       user_role not null default 'customer',
  store_id   uuid references stores(id) on delete set null,
  created_at timestamptz not null default now()
);

create index profiles_store_id_idx on profiles(store_id) where store_id is not null;

-- Role helpers.
--
-- security definer + a fixed search_path is required: a policy on `profiles`
-- that queries `profiles` would recurse infinitely. These run as the owner,
-- bypassing RLS on the lookup only.
create or replace function auth_role()
returns user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

create or replace function auth_store_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select store_id from profiles where id = auth.uid();
$$;

-- Every new auth user gets a customer profile. Roles are assigned by an
-- admin afterwards; nobody can self-elevate at signup.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into profiles (id, role) values (new.id, 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- -------------------------------------------------------- product_drafts
create table product_drafts (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id) on delete cascade,
  submitted_by uuid not null references auth.users(id) on delete cascade,
  payload      jsonb not null,
  status       draft_status not null default 'pending',
  review_note  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index product_drafts_store_status_idx on product_drafts(store_id, status);

-- --------------------------------------------------------------- orders
create table orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text unique not null,
  user_id              uuid not null references auth.users(id) on delete cascade,
  store_id             uuid not null references stores(id) on delete restrict,
  items                jsonb not null,
  total_cents          integer not null check (total_cents >= 0),
  status               order_status not null default 'awaiting_payment',
  payment_reference    text,
  receipt_path         text,
  receipt_uploaded_at  timestamptz,
  matched_txn_ref      text,
  matched_at           timestamptz,
  decline_reason       text,
  receipt_archived_at  timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index orders_user_idx          on orders(user_id, created_at desc);
create index orders_store_idx         on orders(store_id, created_at desc);
create index orders_status_idx        on orders(status) where archived_at is null;
-- Supports the workbench: unarchived receipts awaiting reconciliation.
create index orders_reconcile_idx     on orders(receipt_uploaded_at)
  where status = 'payment_submitted' and archived_at is null;

-- --------------------------------------------------- stock_reservations
create table stock_reservations (
  sku        text primary key,
  reserved   integer not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------- triggers
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger orders_touch
  before update on orders
  for each row execute function touch_updated_at();

create trigger product_drafts_touch
  before update on product_drafts
  for each row execute function touch_updated_at();

-- A customer may edit only their payment reference and receipt, and only
-- while the order is unpaid. Enforced here rather than in RLS because a
-- WITH CHECK expression cannot compare against the pre-update row.
create or replace function guard_order_customer_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if is_admin() then
    return new;
  end if;

  -- Store owners may only move their own orders confirmed -> fulfilled,
  -- changing nothing else.
  if auth_role() = 'store_owner' and old.store_id = auth_store_id() then
    if old.status = 'confirmed'
       and new.status = 'fulfilled'
       and new.id                 =           old.id
       and new.order_number       =           old.order_number
       and new.user_id            =           old.user_id
       and new.store_id           =           old.store_id
       and new.items              =           old.items
       and new.total_cents        =           old.total_cents
       and new.payment_reference    is not distinct from old.payment_reference
       and new.receipt_path         is not distinct from old.receipt_path
       and new.matched_txn_ref      is not distinct from old.matched_txn_ref
       and new.decline_reason       is not distinct from old.decline_reason
       and new.receipt_archived_at  is not distinct from old.receipt_archived_at
       and new.archived_at          is not distinct from old.archived_at
    then
      return new;
    end if;
    raise exception 'store owners may only mark confirmed orders fulfilled';
  end if;

  -- Customer path.
  if old.user_id <> auth.uid() then
    raise exception 'not your order';
  end if;

  if old.status not in ('awaiting_payment', 'payment_submitted') then
    raise exception 'order can no longer be modified';
  end if;

  if new.status not in ('awaiting_payment', 'payment_submitted', 'cancelled') then
    raise exception 'customers cannot set status %', new.status;
  end if;

  -- Immutable fields for a customer.
  if new.id <> old.id
     or new.order_number  <> old.order_number
     or new.user_id       <> old.user_id
     or new.store_id      <> old.store_id
     or new.items         <> old.items
     or new.total_cents   <> old.total_cents
     or new.matched_txn_ref     is distinct from old.matched_txn_ref
     or new.matched_at          is distinct from old.matched_at
     or new.decline_reason      is distinct from old.decline_reason
     or new.receipt_archived_at is distinct from old.receipt_archived_at
     or new.archived_at         is distinct from old.archived_at
  then
    raise exception 'field is not customer-editable';
  end if;

  return new;
end;
$$;

create trigger orders_guard_update
  before update on orders
  for each row execute function guard_order_customer_update();

-- Prevent self-elevation: only an admin may change role or store_id.
create or replace function guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if is_admin() then
    return new;
  end if;
  if new.role <> old.role or new.store_id is distinct from old.store_id then
    raise exception 'role and store assignment are admin-only';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_update
  before update on profiles
  for each row execute function guard_profile_update();
