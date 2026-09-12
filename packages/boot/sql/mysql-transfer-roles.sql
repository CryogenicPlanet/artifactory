-- Optional operator-only supplement for offline whole-board transfer safety copies.
-- Run after mysql-roles.sql and mysql-scratch-roles.sql; never use mysql --force.
SET @check_transfer_grants = IF(@@global.partial_revokes = 0, 'DO 0', 'PARTIAL_REVOKES_MUST_BE_OFF');
PREPARE comms_check_transfer_grants FROM @check_transfer_grants;
EXECUTE comms_check_transfer_grants;
DEALLOCATE PREPARE comms_check_transfer_grants;

-- Boot must delegate SELECT to a disposable dumper of its own database.
-- GRANT OPTION applies to the entire database privilege level: this permits
-- delegation of ALL rights boot already holds here, not only SELECT.
-- Runtime dump provisioning grants the disposable account SELECT only.
GRANT SELECT ON `comms\_boot`.* TO 'comms_boot'@'%' WITH GRANT OPTION;
