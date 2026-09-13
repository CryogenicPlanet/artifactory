-- Operator-only, fresh names, Oracle MySQL 8.4. Do not use mysql --force or --verbose.
-- Prepend a protected file setting @boot_password and @app_password (see README).
-- These escaped database grants require partial_revokes=OFF (MySQL default).
SET @check_grants = IF(@@global.partial_revokes = 0, 'DO 0', 'PARTIAL_REVOKES_MUST_BE_OFF');
PREPARE comms_check_grants FROM @check_grants;
EXECUTE comms_check_grants;
DEALLOCATE PREPARE comms_check_grants;
-- Validate BOTH secrets before creating anything. Invalid input makes PREPARE fail.
SET @valid_passwords = COALESCE(
  REGEXP_LIKE(@boot_password, '^[0-9a-f]{64}$', 'c') AND
  REGEXP_LIKE(@app_password, '^[0-9a-f]{64}$', 'c') AND
  BINARY @boot_password <> BINARY @app_password, FALSE);
SET @create_boot = IF(@valid_passwords,
  CONCAT('CREATE USER ''comms_boot''@''%'' IDENTIFIED BY ''', @boot_password, ''''),
  'INVALID_PASSWORD_INPUT');
PREPARE comms_create_user FROM @create_boot;
EXECUTE comms_create_user;
DEALLOCATE PREPARE comms_create_user;
SET @create_app = CONCAT('CREATE USER ''comms_app''@''%'' IDENTIFIED BY ''', @app_password, '''');
PREPARE comms_create_user FROM @create_app;
EXECUTE comms_create_user;
DEALLOCATE PREPARE comms_create_user;
SET @boot_password = NULL, @app_password = NULL, @create_boot = NULL, @create_app = NULL;

CREATE DATABASE comms_boot CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
CREATE DATABASE comms_app CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
GRANT ALL PRIVILEGES ON `comms\_boot`.* TO 'comms_boot'@'%';
GRANT ALL PRIVILEGES ON `comms\_app`.* TO 'comms_app'@'%';
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE, REFERENCES,
      CREATE VIEW, SHOW VIEW, TRIGGER
  ON `comms\_app`.* TO 'comms_boot'@'%';
-- No PROCESS, SUPER, GRANT OPTION, CREATE USER, or persistent-app scratch grants.
