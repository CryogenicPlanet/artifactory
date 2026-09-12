-- Optional operator-only supplement for PostgreSQL DbOps scratch principals.
-- CREATEROLE cannot be restricted to comms_* names; use a dedicated database server.
-- CREATEDB is already granted by postgres-roles.sql. Never grant these to comms_app.
\set ON_ERROR_STOP on
ALTER ROLE comms_boot CREATEROLE;
