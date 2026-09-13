-- Function exposure hardening.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, which
-- publishes every function in the `public` schema as a PostgREST RPC
-- endpoint. Trigger functions must never be reachable that way.

revoke all on function handle_new_user()             from public, anon, authenticated;
revoke all on function guard_order_customer_update() from public, anon, authenticated;
revoke all on function guard_profile_update()        from public, anon, authenticated;
revoke all on function touch_updated_at()            from public, anon, authenticated;

alter function touch_updated_at() set search_path = public, pg_temp;

-- Helper functions: revoke from anon, but authenticated MUST keep EXECUTE.
--
-- RLS policy expressions are evaluated as the CALLING role, not the table
-- owner. Revoking these from `authenticated` makes every policy that
-- references them fail with "permission denied for function is_admin",
-- which blocks all legitimate access. Verified by tests/rls.test.mjs.
--
-- Exposing them is safe: each takes no arguments and reads only the
-- caller's own row via auth.uid().
revoke all on function is_admin()      from public, anon;
revoke all on function auth_role()     from public, anon;
revoke all on function auth_store_id() from public, anon;

grant execute on function is_admin()      to authenticated;
grant execute on function auth_role()     to authenticated;
grant execute on function auth_store_id() to authenticated;

-- Checkout path: authenticated only, guarded internally.
revoke all on function reserve_stock(text, integer, integer) from public, anon;
revoke all on function release_stock(text, integer)          from public, anon;
grant execute on function reserve_stock(text, integer, integer) to authenticated;
grant execute on function release_stock(text, integer)          to authenticated;
