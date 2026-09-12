-- Optional operator-only supplement for MySQL DbOps ephemeral principals.
-- Run after mysql-roles.sql. No passwords; never use mysql --force.
-- CREATE USER is server-wide; it cannot be restricted to comms_t_* account names.
SET @check_grants = IF(@@global.partial_revokes = 0, 'DO 0', 'PARTIAL_REVOKES_MUST_BE_OFF');
PREPARE comms_check_grants FROM @check_grants;
EXECUTE comms_check_grants;
DEALLOCATE PREPARE comms_check_grants;

GRANT CREATE USER ON *.* TO 'comms_boot'@'%';
-- Source metadata preflight must see unsupported definers before any copy begins.
-- SELECT can be delegated to an ephemeral dump login; app credentials stay unchanged.
GRANT SELECT ON `comms\_app`.* TO 'comms_boot'@'%' WITH GRANT OPTION;
GRANT SHOW VIEW, TRIGGER, EVENT, EXECUTE ON `comms\_app`.* TO 'comms_boot'@'%';
-- MySQL GRANT OPTION applies to the whole database privilege level: boot can
-- delegate ALL source rights it holds, not only SELECT. See README before enabling.

-- Generated targets become future backup sources after restore, so catalog
-- visibility must match the original source before unsupported objects are checked.
-- Native dumps contain LOCK TABLES; boot delegates that right to the temporary
-- loader on its exact target database, not to the persistent app during handoff.
-- Only generated target families. Backslashes make each underscore literal.
-- '%' is the sole wildcard. Never grant these patterns to the persistent app login.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT, EXECUTE
  ON `comms\_rehearsal\_%`.* TO 'comms_boot'@'%' WITH GRANT OPTION;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES,
      CREATE TEMPORARY TABLES, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT, EXECUTE
  ON `comms\_app\_%`.* TO 'comms_boot'@'%' WITH GRANT OPTION;
-- No SUPER, PROCESS, SET_ANY_DEFINER, or ALLOW_NONEXISTENT_DEFINER.
