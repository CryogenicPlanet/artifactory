# Logical transfer plans

`logicalTransferPlan` compares exhaustive source and target inventories after the target's migrations have run. It returns data `tables` and separate `ledgers`. The offline coordinator must compare every ledger before copying data; ledger timestamps are recreated, while migration IDs, names and extension checksums must match.

The plan retains literal keys, message data, encoded event/receipt text and blob columns. It omits only recognized migration-owned generated projections and remote surrogate IDs. Target nullability and retained identity columns guide the storage copy preflight. The copier must validate every source row against target types before writing, reset retained identity generators, and verify logical values afterward.

Pass `coreSearchObjects` to SQLite app inventory inspection and `coreJsonColumns` as its trusted JSON policy on every engine. The FTS definitions are checked exactly; only their documented shadow tables and SQLite's internal catalog/statistics tables are omitted. Native JSON uses semantic verification; encoded text stays byte-exact.

Unknown generated expressions, executable objects, keyless tables, unsupported key types, foreign-key cycles and incompatible schemas are refused. The first implementation also refuses differing extension migration checksums, including differences caused by dialect-specific SQL. Supporting those differences requires preserved migration-source identity evidence; matching migration names alone is insufficient.

These modules do not open connections, run migrations, copy rows, prove process closure, or change transfer authority. Settings markers, selected database names, writer epochs and source retirement remain the offline coordinator's responsibility. `sqliteEventsDefinition` is catalog-comparison metadata, never executable DDL.
