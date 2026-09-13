# Operator database setup

Follow [Run with PostgreSQL or MySQL](../../../docs/remote-databases.md) for the current role, database and grant statements. Run them once as the database operator before starting chirp.

Boot does not create databases or logins, orchestrate dumps, or restore remote stores. Do not grant runtime role-management privileges for old scratch-database workflows. Provider snapshots and restore replace those workflows; the guide records the resulting recovery limits.
