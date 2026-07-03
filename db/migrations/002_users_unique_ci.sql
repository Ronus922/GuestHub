-- Backstop uniqueness for guesthub.users (review finding): the Server Actions'
-- check-then-act duplicate queries can race; enforce case-insensitive uniqueness
-- at the DB so concurrent requests cannot create duplicate users.
-- (users already has UNIQUE(tenant_id, username) — case-sensitive; these indexes
--  add the case-insensitive guarantee the app-level checks promise.)

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_username_ci
  ON guesthub.users (tenant_id, lower(username));

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_email_ci
  ON guesthub.users (tenant_id, lower(email))
  WHERE email IS NOT NULL;
