-- Store decoration: banner, logo, blurb (release plan §2).
--
-- Owners edit these three columns on their OWN store from the portal; the
-- values are baked into the static catalog at build time. RLS decides which
-- rows, the trigger below decides which columns.

alter table stores
  add column banner_path text,
  add column logo_path   text,
  add column blurb       text;

-- Which rows: only the caller's own store, and only for store owners.
-- stores_read_all / stores_admin_write from the initial migration are
-- deliberately untouched.
create policy stores_owner_update on stores
  for update to authenticated
  using (auth_role() = 'store_owner' and id = (select auth_store_id()))
  with check (auth_role() = 'store_owner' and id = (select auth_store_id()));

-- Which columns: anything outside decoration is admin-only. Modelled on
-- guard_profile_update; null-safe comparisons so a first-time set
-- (null -> value) is allowed.
create or replace function guard_store_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if is_admin() then
    return new;
  end if;
  if new.id <> old.id
     or new.slug       <> old.slug
     or new.name       <> old.name
     or new.created_at is distinct from old.created_at
  then
    raise exception 'only banner, logo and blurb are owner-editable';
  end if;
  return new;
end;
$$;

create trigger stores_guard_owner_update
  before update on stores
  for each row execute function guard_store_owner_update();

revoke all on function guard_store_owner_update() from public, anon, authenticated;

-- ------------------------------------------------------- store-assets bucket
-- Public storefront images (store pages, and soon the home strip). Public
-- read — a signed URL on every card would be pointless and slow. Writes are
-- scoped to the owning store's folder (first path segment = store id) or
-- admin, mirroring draft-images. Paths are stable per store
-- ({store_id}/banner.webp, {store_id}/logo.webp) so replacing an image
-- overwrites instead of accumulating against the 1 GB free-tier cap.
insert into storage.buckets (id, name, public)
  values ('store-assets', 'store-assets', true)
  on conflict (id) do nothing;

-- The objects table already has RLS from the other buckets; force it too so
-- the table owner cannot silently bypass policies either.
alter table storage.objects enable row level security;
alter table storage.objects force row level security;

create policy store_assets_read on storage.objects
  for select
  using (bucket_id = 'store-assets');

create policy store_assets_insert_scoped on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'store-assets'
    and (is_admin()
         or (storage.foldername(name))[1] = (select auth_store_id())::text)
  );

create policy store_assets_update_scoped on storage.objects
  for update to authenticated
  using (
    bucket_id = 'store-assets'
    and (is_admin()
         or (storage.foldername(name))[1] = (select auth_store_id())::text)
  )
  with check (
    bucket_id = 'store-assets'
    and (is_admin()
         or (storage.foldername(name))[1] = (select auth_store_id())::text)
  );

create policy store_assets_delete_scoped on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'store-assets'
    and (is_admin()
         or (storage.foldername(name))[1] = (select auth_store_id())::text)
  );
