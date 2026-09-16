-- Store-owner applications (release plan §5).
--
-- A signed-in customer applies to sell; an admin reviews. Elevating a
-- customer to store_owner means creating a stores row and updating a
-- profile — deliberately manual SQL, not a web button — so this table only
-- records the application and the decision. Status reuses draft_status:
-- pending | approved | rejected.

create table store_applications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  store_name   text not null,
  contact      text not null,
  note         text,
  status       draft_status not null default 'pending',
  review_note  text,
  created_at   timestamptz not null default now()
);

create index store_applications_status_idx on store_applications(status);

alter table store_applications enable row level security;
alter table store_applications force row level security;

-- An applicant writes exactly their own row, and only as pending.
create policy applications_insert_own on store_applications
  for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending');

-- Applicants read their own row; admins read everything.
create policy applications_select_own_or_admin on store_applications
  for select to authenticated
  using (user_id = (select auth.uid()) or is_admin());

-- Only an admin may review (set status / review_note). There is deliberately
-- NO self-update policy: an applicant cannot flip their own row to approved.
create policy applications_admin_update on store_applications
  for update to authenticated
  using (is_admin()) with check (is_admin());

-- Admin delete exists so test runs and mistaken submissions can be cleared;
-- the decision trail matters only while a row is live.
create policy applications_admin_delete on store_applications
  for delete to authenticated
  using (is_admin());

-- One pending application per user. Rejected/approved rows stay for the
-- record; a new application becomes possible again after a decision.
create unique index store_applications_one_pending
  on store_applications(user_id) where status = 'pending';
