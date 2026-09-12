# Move a board to another database engine

Offline transfer moves both stores between SQLite, PostgreSQL and Oracle MySQL while retaining the board’s identities, messages, source and pages. It is a maintenance operation: stop the board, verify the destination, transfer, then start with the destination configuration.

**Availability:** the image CLI is implemented, but complete six-direction and filesystem crash-recovery acceptance is still in progress. Runtime and native backup/restore evidence does not establish complete transfer acceptance. Treat these as draft operator instructions until the [build plan](build-plan.md) records that acceptance.

## Prepare the board and destination

1. Upgrade the source image through normal startup so its boot migration history includes protocol 20. Update and reload the installed app so the selected frozen generation supports the destination engine and exports `initializeTransferApp` from `kernel/transfer-app-initialize.ts`. Updating an image alone never overwrites installed source. See [source compatibility](../packages/server/docs/README.md#offline-transfer-source-compatibility).
2. Finish edits, publication and recovery work, then stop the board. Transfer refuses pending journals and unresolved writers; it does not clear them to force progress. Keep the complete data volume, including source, pages, saved generations and backups.
3. Provision an **empty pair** of destination databases and the required separate roles using the [operator guide](../packages/boot/sql/README.md). Source and destination use different engines; each pair uses one engine. The destination is not another initialized board. Remote destinations need the prescribed temporary-principal and inspection privileges too. A MySQL source additionally needs the [transfer grant supplement](../packages/boot/sql/mysql-transfer-roles.sql) after the ordinary and scratch-role scripts; it permits boot to delegate its database-level privileges, while the disposable dump role receives SELECT only.
4. Prepare a separate disposable pair for check mode. Never point a check at production or at the destination pair reserved for the actual transfer. Keep its diagnostics afterward; a check result is not eligible for activation.

Use the supported Linux image entrypoint with the same source data volume mounted at exactly `/data`; the CLI currently refuses another `DATA_DIR`. It holds `/data/.comms-lifetime.lock` until connections and workers close. Do not bypass it with a direct Bun launch or delete that lock file. Remote closure additionally requires the original guardian/inspector evidence; an idle-looking database or dead PID is insufficient.

## Write the private configuration

The public command is `store-transfer --config /run/secrets/transfer.json`. Its only argument containing deployment information is the config path. Never put password URLs in arguments, shell history, source files or diagnostic messages.

Create the file through your secret manager or a private editor. It must be a regular root-owned file with mode `0600`, at a canonical absolute path without symlinks. Parent directories must be root-owned and not group/world writable. Mount it read-only into the image. The wrapper opens it before dropping privileges; the CLI closes the inherited secret input before starting workers.

Example shape for a SQLite-to-PostgreSQL transfer; the hostnames and credentials below are placeholders:

```json
{
  "version": 1,
  "transfer_id": "11111111-1111-4111-8111-111111111111",
  "mode": "transfer",
  "source": {
    "boot": "file:/data/boot.db",
    "app": "file:/data/store/comms.db"
  },
  "target": {
    "boot": "postgres://boot_user:REPLACE@db.example:5432/board_boot",
    "app": "postgres://app_user:REPLACE@db.example:5432/board_app"
  },
  "tls": true
}
```

Generate a fresh lowercase UUID for each new attempt. Use `mysql://` for MySQL. Percent-encode credential/database-name characters; URL query options and fragments are rejected. Verified TLS should remain enabled for remote connections. The source app descriptor supplies credentials and an initial location; transfer reads the authoritative selected database from source boot state, including a previous restore’s selected database.

On a Linux Docker host, keep `check.json` and `transfer.json` under a root-owned private directory such as `/etc/comms-transfer`. Create them with your secret manager or `sudoedit`, then verify ownership and mode without printing their contents:

```sh
sudo chown root:root /etc/comms-transfer/check.json /etc/comms-transfer/transfer.json
sudo chmod 0700 /etc/comms-transfer
sudo chmod 0600 /etc/comms-transfer/check.json /etc/comms-transfer/transfer.json
```

Use an image built from the reviewed transfer checkout. The commands below assume the source container is `comms`, its data volume is `comms`, and both database endpoints are reachable on `comms-network`; substitute your existing names. The root-owned file mount must retain its numeric ownership inside the container. Docker Desktop file sharing may not preserve it; provision the secret inside a root-owned Docker volume instead, as the [disposable acceptance script](../scripts/transfer-acceptance.sh) does. Do not relax the permission checks.

## Check before transferring

Use a separate config with `"mode": "check"`, its own transfer ID and the disposable destination pair. Check mode initializes scratch schemas from the selected frozen source, compares migration histories and inventories, and validates source values against the destination representation. It performs no business-data copy and never retires the source or makes the scratch target bootable.

SQLite scratch app files belong under `/data/rehearsals/transfer-check-<id>/comms.db`; the private scratch boot file belongs under `/data/transfers/<id>/scratch/boot.db`. Set those exact transfer-ID-bound paths explicitly in the check config; the CLI does not derive them from a real destination descriptor. It prepares their directory permissions. They are distinct from the real SQLite destination paths `/data/boot.db` and `/data/store/comms.db`. Retain scratch diagnostics after refusal; do not rename scratch files into live paths.

Quiesce agents before stopping the source, then run the check with its separate config:

```sh
docker stop --time 30 comms
docker run --name comms-transfer-check --network comms-network \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
  --volume comms:/data \
  --mount type=bind,src=/etc/comms-transfer/check.json,dst=/run/transfer.json,readonly \
  comms:local store-transfer --config /run/transfer.json
```

A successful command exits zero and returns JSON containing the transfer ID, `status: "checked"`, public source/target locations and a manifest hash. It never prints credential URLs. For another check, use fresh scratch stores and a new ID/container name. You can restart the unchanged source after a completed check; stop it again before transfer. Neither a stopped container nor a passing check replaces the CLI's closure verification.

A successful check is evidence about that source, target schema and configuration. It does not authorize reusing the scratch pair for transfer, nor prove a later changed source is still compatible.

## Complete the transfer

Run transfer mode against the empty destination pair using the command above with container name `comms-transfer-run` and mount source `/etc/comms-transfer/transfer.json`. Keep the destination path `/run/transfer.json` and the CLI arguments unchanged. In that file set `"mode": "transfer"`, a different ID and the real destination pair; do not reuse the check target.

```sh
docker run --name comms-transfer-run --network comms-network \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add SETPCAP \
  --volume comms:/data \
  --mount type=bind,src=/etc/comms-transfer/transfer.json,dst=/run/transfer.json,readonly \
  comms:local store-transfer --config /run/transfer.json
```

The workflow retains safety backups, proves source writer closure, initializes the target from the selected frozen source, validates every selected table before copying, and independently verifies copied values and sequence state. Native safety-artifact restore has separate PostgreSQL/MySQL verification; that does not substitute for complete transfer acceptance.

Authority changes only after verification: source boot is retired, source app is retired, then the target completion state is recorded. All clients and keepers must close and the filesystem receipt must be durable before target activation. SQL `complete` alone is not permission to start the destination.

Require exit zero and `status: "complete"` for the expected transfer ID and public source/target locations. After a verified completion, keep the same data volume and start the board with the destination’s paired database configuration. Source files and pages remain on that volume. Do not start the retired source as a second board, erase retirement markers or fabricate backup identity provenance. Changing browser origin is separate and still needs correct passkey origin configuration.

Existing backup catalogue rows retain their source engine; their files stay on the volume in that native format. They cannot be restored directly into the new engine. Keep the source safety artifacts and take a new ordinary backup after the target is healthy.

Passkeys, sessions and token records transfer, but downtime does not extend credential expiry or refresh replay windows. Quiesce agents first. An agent retrying a lost refresh response after the grace window may have its token family revoked and need enrollment again; do not weaken replay protection to avoid that outcome.

## If it stops or refuses

Preserve the config, data volume, journals, receipts and diagnostics. Do not clear a marker or unresolved owner record to make startup pass. Inspect `docker logs comms-transfer-run` (or the check container) for bounded stage/code diagnostics. The private journal is `/data/transfers/<id>/journal.json`; retain that directory and the safety artifacts. A matching completed filesystem receipt allows the exact same transfer configuration/ID to report completion again without reopening the old source. An incomplete receipt still requires independent verification and closure before activation; preserve the original configuration for that recovery.

An interrupted business-data copy can leave populated target tables. The copier does not delete those rows or append blindly on retry. The operator must explicitly replace that incomplete destination with a fresh empty pair and use a new transfer ID. Preserve the failed target for diagnosis first. If source retirement has already begun, follow the recorded recovery state; do not start over with unrelated targets or revive the source by hand.

## Schema compatibility

Custom tables are included, not silently dropped. Target migrations must reproduce a compatible schema and matching migration identities/checksums. The current plan requires stable non-null integer, text or binary keys, representable values, compatible nullability and equivalent supported scalar defaults. Foreign-key columns and actions must match; cycles, deferrable constraints, unsupported match policies and `SET DEFAULT` refuse transfer. Executable defaults and unknown generated expressions are not assumed equivalent.

Core `messages.tags`, `messages.meta` and `topics.meta` use reviewed semantic JSON comparison; formatting and object-key order may change across engines. Other encoded events, receipts and previous images remain byte-exact text. Unapproved native JSON, decimal/temporal/custom types, unsupported integer representations, keyless tables and unsupported views, triggers or other executable objects refuse preflight. Recognized migration-owned search projections are regenerated rather than copied as ordinary data. Dialect-specific extension checksums may differ only when the selected frozen declaration proves both the source and target hashes and every recorded migration matches. Missing declarations, altered source history or an unmatched receipt refuse transfer; names alone are insufficient.

A refusal identifies work to make the source migrations portable. It is not permission to omit a custom table, weaken checksum checks or truncate values. Rehearse and reload the source change normally, then perform a new check against fresh scratch stores.
