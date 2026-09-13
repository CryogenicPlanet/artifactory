# Measure native database copy and reload

This opt-in tool measures dedicated, disposable test resources. It never changes runtime budgets. Do not point it at a running personal board or production database.

## Native dump/load

Provision two empty databases on the same local PostgreSQL or Oracle MySQL server. Names must start `comms_benchmark_`. Give the test credentials schema creation, native dump and native load rights, including MySQL `LOCK TABLES`. PostgreSQL source and target should use the same owner. Put each connection in a `0600` JSON file with `engine` (`pg` or `mysql`), `host`, `port`, `database`, `username`, and `password`. Host must be `localhost` or `127.0.0.1`.

Use the native client binaries matching the server version. Then, from the repository root:

```sh
COMMS_DISPOSABLE_BENCHMARK=1 bun scripts/native-database-benchmark.ts copy \
  /private/source.json /private/target.json /private/report.json
```

Default: **10,000 rows × 1,024 body bytes**, seeded in batches of 100. Optional trailing arguments set row count and body bytes, for example `100000 1024`. Payloads are deterministic SHA-256-derived ASCII, varied per row; this avoids a single repeated padding string compressing unrealistically well. It still represents a synthetic single-table workload, not a full board with indexes, events, source history, blobs and extensions.

The report records server/client versions, host architecture, exact payload size, seed time, native dump time, native load time, artifact bytes, source/target database allocation, and full payload verification. It calls the existing `dumpRemote` and `loadRemote` implementations. Dump time includes artifact synchronization; load time ends when the native client finishes. These measurements exclude schema provisioning, boot guardians, app health, logical cross-engine conversion and traffic downtime. PostgreSQL size includes database catalogs; MySQL allocation statistics are approximate and may lag. Do not directly compare those allocation numbers as equivalent physical storage measurements.

Existing tables refuse the run. Databases and artifacts are retained, including on failure, for inspection. Use newly provisioned targets for another run; remove only resources that you allocated for this benchmark. Reports use exclusive creation and are never overwritten. Credentials and underlying database error bodies are not printed.

## Four concurrent HTTP writers during reload

Start a **dedicated** loopback board using fresh database pairs and the setup/authentication steps in the [native board harness](native-board-acceptance.ts). Run traffic mode before the harness shuts the board down; an ordinary completed harness run does not leave a server running. Provide its localhost origin and private state file containing `cookie`:

```sh
COMMS_DISPOSABLE_BENCHMARK=1 bun scripts/native-database-benchmark.ts traffic \
  http://localhost:18080 /private/state.json /private/traffic-report.json 100
```

For a standalone run, put the dedicated board's `DATABASE_URL`, `BOOT_DATABASE_URL`, `DATABASE_TLS=false`, `DATA_DIR`, `PUBLIC_ORIGIN=http://localhost:18080`, `RP_ID=localhost`, `HOST=127.0.0.1` and `PORT=18080` in a private shell environment file. Use the operator provisioning scripts for the fresh boot/app role pair. Never reuse a personal board's file. In a shell with `umask 077`, load that file with `set -a; . /private/benchmark.env; set +a`, then:

```sh
bun run --filter @comms/server stage:runtime
bun packages/server/src/main.ts > /private/board.log 2>&1 &
board_pid=$!
```

Wait for `/setup` to respond successfully. Copy the setup code from the protected log into `/private/setup-code` without publishing the log or code. The existing HTTP helper performs the real passkey ceremony and verifies writes, native backup and restore:

```sh
COMMS_TEST_ORIGIN=http://localhost:18080 COMMS_SETUP_CODE_FILE=/private/setup-code \
  bun scripts/remote-board-http.ts prepare http://localhost:18080 /private/state.json
```

Now run traffic mode above. Afterwards, send `kill -TERM "$board_pid"`, wait for that exact process to exit, and run `bun packages/boot/test/fixtures/remote-owner-inventory.ts "$DATA_DIR" recover` to verify closed database ownership. Retain the private data and report for inspection; a failed ownership check is not permission to remove journals. These steps intentionally do not expose the test board beyond loopback.

The tool takes the edit lock, stages a unique no-op extension and starts four serial writer loops before requesting an actual reload. Each loop continues until both its minimum count and the reload are complete, with a shared three-minute deadline for starting new requests. In-flight requests can extend total elapsed time beyond it; the report records each writer’s count and the command fails if any minimum is unmet. It records the server's `freeze_ms` separately from HTTP latency, counts every refused mutation, and queries each acknowledged sequence after reload and compares its ID, sequence and body. Refusals are measurements, not an automatic failure: the report counts HTTP status, error code and retriable flag without storing response bodies. The command still fails if an acknowledged write is missing or a writer minimum is unmet. The extension, edit lock and benchmark topic are retained in this disposable board; shut down and remove only that board's own resources afterwards.

Four outstanding HTTP producers do not prove that four database transactions hold locks simultaneously. An HTTP workload still cannot substantiate the design's worst-case drain budget. Use the database-observed lock-wait acceptance tests for concurrency guarantees. Successful message reads prove post-reload visibility, not process-restart or physical-power-loss durability.

The HTTP mode is separate from copy-mode results. Native copy success is not evidence that HTTP mode ran. Record each report independently.

## Transfer downtime and budgets

Full offline transfer downtime must be measured around the actual Linux CLI operation and subsequent successful startup, with both source and destination dataset sizes recorded. This local benchmark reports `transfer_downtime_ms: null`; adding dump and load time is not a substitute. Keep the board unavailable interval, app readiness time and agent re-enrollment/grace-window effects separate.

Run multiple samples under a stated machine/load condition before choosing `REHEARSAL_COPY_BUDGET`, scratch limits or freeze defaults. A modest local sample establishes a reproducible baseline, not a capacity guarantee for a managed database or 100,000-message board.

## Local baseline, 12 September 2026

One sample on macOS arm64 with Bun `1.4.0-canary.1+4924862cf`, PostgreSQL/client 18.6 and Oracle MySQL/client 8.4.11. Another native acceptance lane could run concurrently; this was not an idle-machine capacity test. Runtime checkout: `1b883b6`.

| Native copy, 10,000 × 1,024 bytes |       PostgreSQL |            MySQL |
| --------------------------------- | ---------------: | ---------------: |
| Dump                              |         292.8 ms |          65.5 ms |
| Load                              |         176.9 ms |         337.5 ms |
| Artifact                          |  5,883,947 bytes | 10,341,264 bytes |
| Source database allocation        | 19,961,535 bytes | 12,075,008 bytes |
| Target database allocation        | 20,444,863 bytes | 12,075,008 bytes |

Every copied ID and body matched. MySQL allocation was sampled after `ANALYZE TABLE`, outside the copy timing.

| Four HTTP writers, small `writer:index` message bodies |     PostgreSQL |      MySQL |
| ------------------------------------------------------ | -------------: | ---------: |
| Acknowledged and verified after reload                 |          2,296 |      2,167 |
| Refused mutations                                      | 1,063 HTTP 503 |          0 |
| Reported freeze                                        |         828 ms |     895 ms |
| Mutation latency p95                                   |        75.5 ms |    96.5 ms |
| Mutation latency maximum                               |     1,013.1 ms | 1,080.5 ms |

Both dedicated boards passed real passkey setup, messages and native backup/restore before traffic. PostgreSQL traffic resumed its retained board after fixing the benchmark's read route, so that board also contained earlier probe messages. The original PostgreSQL report did not collect refusal codes/retriable flags; its 503s cannot be classified from that report. That original command exited nonzero after saving the fully verified report because the earlier benchmark rejected any refusal; the current tool records refusals as measurements. MySQL ran on a fresh pair and also passed the harness's subsequent restart/authentication check. All acknowledged traffic messages were checked before shutdown; the restart check covers the harness's baseline data, not every traffic message. These are small-message reload measurements, separate from the 10,240,000-byte (9.77 MiB) synthetic native-copy dataset. Full cross-engine transfer downtime remains unmeasured here.

## Larger local native-copy sample

One later sample used **100,000 rows × 1,024 body bytes** (102,400,000 payload bytes, 97.66 MiB) on macOS arm64 with Bun `1.4.0-canary.1+4924862cf`, PostgreSQL/client 18.6 and Oracle MySQL/client 8.4.11. This is the same synthetic single-table workload, not a 100,000-message board. Both reports verify every copied ID and body.

| Native copy, 100,000 × 1,024 bytes |        PostgreSQL |             MySQL |
| ---------------------------------- | ----------------: | ----------------: |
| Dump                               |       2,374.48 ms |         363.23 ms |
| Load                               |         845.65 ms |       1,363.83 ms |
| Dump plus load                     |       3,220.13 ms |       1,727.06 ms |
| Artifact                           |  58,858,167 bytes | 103,494,913 bytes |
| Source database allocation         | 127,325,887 bytes | 118,095,872 bytes |
| Target database allocation         | 127,342,271 bytes | 118,095,872 bytes |

The source reports are `/tmp/comms-benchmark-100k-pg.json` and `/tmp/comms-benchmark-100k-mysql.json` on the measurement host. They record `transfer_downtime_ms: null`. These times cover native dump/load only; they exclude provisioning, ownership, logical conversion, startup, health and traffic downtime. This single local sample does not establish a managed-server capacity or freeze budget, and no additional HTTP traffic result is implied. The earlier 10,000-row and HTTP samples above remain separate historical evidence.

## Guarded lease overhead and read budget

Run the opt-in lease diagnostic against a fresh, dedicated loopback database with
session metadata visibility. Use the same private connection-file shape and
`comms_benchmark_` naming rule as copy mode. The MySQL server must expose full
session connect attributes and use REPEATABLE READ; PostgreSQL must disable
prepared transactions. No schema or business data is created or changed.

```sh
COMMS_DISPOSABLE_BENCHMARK=1 bun scripts/remote-lease-benchmark.ts \
  /private/connection.json /private/lease-report.json
```

The diagnostic measures 200 raw pooled `SELECT 1` calls, the first registered
query, 200 warm guarded pooled calls, then 200 calls on one retained guarded
lease. It uses the real inspector and `remoteOwner` receipt implementation and
checks that the retained lease acquires exactly once. The report separates new
session receipt persistence from repeated-session acknowledgment, and retains
private ownership artifacts after closing the measured pool and inspector.
This is an in-process mechanism measurement: it excludes the guardian's IPC,
process scheduling, TLS and external network delay. A low raw baseline does not
prove that an unguarded client is safe for application use.

The steady-state acquisition path is:

1. Borrow a physical connection from the four-connection pool.
2. Execute one identity statement on that connection. MySQL checks its isolation
   and connect attribute in this same statement.
3. Send registration to the immutable guardian. Its inspector executes one
   identity statement on its pinned connection, inside that inspector instance's
   admission semaphore.
4. Acknowledge the matching ownership receipt before application SQL is allowed.

The semaphore is per inspector service instance, not process-global. A fresh
physical session requires a synced temporary receipt, rename and directory
sync. A matching session already in that owner's receipt is acknowledged without
rewriting or syncing the receipt. Every pooled acquisition still revalidates both
identities. Statements inside one transaction, stream or explicit reserved lease
share that acquisition; they do not repeat registration for each statement.
Consequently, “a fresh lease and durable write for every statement” overstates
the cost of pooled reuse and multi-statement transactions.

For warm prepared statements, let `R` be database round-trip time, `I` guardian
IPC/scheduling time, `Q` the application statement count, `W` pool/admission/lock
wait, and `F` new-session receipt persistence (zero on already-recorded reuse).
An independent guarded query costs approximately `3R + I + W + F`: two serial
identity statements plus the query. A transaction adds identity only once, plus
its BEGIN, COMMIT, isolation prelude and body statements. These are SQL request
counts, not universal wire-packet counts; new connections, first prepared
statements, server work and transport negotiation add costs.

At runtime checkpoint `deea721`, an ordinary read with no pending topic move and
an initialized cached boot fence performs two app acquisitions: the outbox move
probe, then the pinned read transaction. Counting the existing writer/publication
checks, BEGIN/COMMIT and PostgreSQL's isolation prelude gives approximately
`(13 + Q)R + 2I + W + F` for PostgreSQL and `(12 + Q)R + 2I + W + F` for MySQL.
This explicitly includes both publication-check calls currently made by the
read snapshot and its fence callback. The cached fence normally avoids a boot
HTTP request; cold fence initialization, pending-move relay and background work
add separate costs. For illustration only, `Q=1` and an assumed `R=20ms` give
280ms/260ms of database round trips before waits, IPC and execution time. At
`R=100ms`, that component alone becomes 1.4s/1.3s. These assumed RTTs are not
measured managed-database acceptance results.

The read's three-second deadline starts at invocation, including admission
wait, acquisitions and statements. At four seconds, an operation that still
holds database ownership marks the writer unhealthy; returning a timeout never
proves the connection closed. The driver's five-second identity and registration
caps are individual safeguards, not five seconds of extra allowance beyond the
read deadline. Cleanup and positive ownership closure may take longer than a
response deadline. Quiesce waits for admitted read cleanup; it cannot just sum
query averages or release an unresolved lease. Cutover separately allows ten
seconds for freeze acknowledgment and traffic drain, with the existing keeper
and session-closure proofs still required. No deadline or ownership check is
changed by this benchmark.

### Local lease sample, 12 September 2026

One sequential sample per engine on macOS arm64, PostgreSQL 18.6 and Oracle
MySQL 8.4.11. The launcher used Node 22.22.3; the package worker used Bun 1.4.0.
The implementation is based on runtime `deea721`. Another acceptance lane could
run concurrently; this is not an idle-machine or managed-network capacity test.

| Milliseconds                                       | PostgreSQL mean / p95 | MySQL mean / p95 |
| -------------------------------------------------- | --------------------: | ---------------: |
| Raw pooled query, 200 calls                        |         0.090 / 0.140 |    0.107 / 0.215 |
| Warm guarded pooled query, 200 calls               |         0.269 / 0.566 |    0.299 / 0.602 |
| Query on retained guarded lease, 200 calls         |         0.026 / 0.046 |    0.032 / 0.051 |
| Repeated-session receipt acknowledgment, 201 calls |         0.036 / 0.078 |    0.035 / 0.073 |

The first registered query took 5.664ms on PostgreSQL and 3.413ms on MySQL;
its actual receipt persistence took 0.843ms and 0.999ms respectively. Those are
single observations, not distributions. Each engine completed 601 timed queries,
202 registration callbacks and exactly one durable physical-session record. The
200 retained-lease queries caused exactly one acquisition in total. Pool closure
and the inspector's registered-session absence check completed before the owner
receipt was closed. The private source reports are
`/tmp/comms-lease-cost-pg-report.json` and
`/tmp/comms-lease-cost-mysql-report.json` on the measurement host.

Warm guarded minus raw mean was approximately 0.179ms/0.192ms in this local
sample. The raw pooled baseline and retained-lease operation use different client
paths; their difference is not a pure network or persistence measurement. Real
child registration adds guardian IPC and process scheduling, which this fixture
does not simulate. These samples close the missing mechanism/cost accounting;
they do not establish full-board latency, concurrent admission throughput or a
worst-case freeze guarantee.
