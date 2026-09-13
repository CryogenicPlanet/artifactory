-- Operator-only, fresh names, PostgreSQL 17+. Run with psql -X -f; never --echo-all.
-- Supply independent 64-hex-character secrets through the process environment.
\set ON_ERROR_STOP on
\getenv boot_password COMMS_BOOT_PASSWORD
\getenv app_password COMMS_APP_PASSWORD
SELECT :'boot_password' ~ '^[0-9a-f]{64}$'
   AND :'app_password' ~ '^[0-9a-f]{64}$'
   AND :'boot_password' <> :'app_password' AS passwords_valid \gset
\if :passwords_valid
\else
  DO $$ BEGIN
    RAISE EXCEPTION 'Two distinct 64-character lowercase hexadecimal passwords are required.';
  END $$;
\endif

CREATE ROLE comms_boot LOGIN PASSWORD :'boot_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE comms_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

CREATE DATABASE comms_boot OWNER comms_boot TEMPLATE template0 ENCODING 'UTF8';
CREATE DATABASE comms_app OWNER comms_boot TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE comms_boot FROM PUBLIC;
REVOKE ALL ON DATABASE comms_app FROM PUBLIC;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE comms_app TO comms_app;

\connect comms_boot
ALTER SCHEMA public OWNER TO comms_boot;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\connect comms_app
ALTER SCHEMA public OWNER TO comms_boot;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO comms_app;
-- Boot initialization grants app DML on protected tables once they exist.
-- The app can create its own tables and trusted extensions, but cannot own/drop public.
