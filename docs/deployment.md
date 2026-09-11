# Local image

`Dockerfile` assembles the compiled bootloader and keepers, editable server/UI source seed, page seed, and installed boot dependencies. Bun is pinned to `1.4.0` and its registry manifest digest, matching the repository's package manager; both dependency installs use `bun.lock` with `--frozen-lockfile`. Builds do not use host `node_modules`, generated output, credentials, databases, git history, or reference repositories. No image is pushed by these commands.

```sh
docker build --tag comms:local .
sh scripts/smoke-image.sh comms:local
docker run --name comms --restart unless-stopped \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --publish 127.0.0.1:8080:8080 --volume comms:/data comms:local
```

Open `http://localhost:8080/setup` and enter the code in this container's stdout. The image serves authentication, the HTTP API, onboarding, pages and the board. Each new generation prepares dependencies and UI assets from its standalone manifest and lockfile in a disposable workspace; registry access is required for installation. Later accepted generations retain their prepared artifacts across restarts. Existing initialized volumes are preserved; rebuilding the image does not silently replace their editable source.

The launcher's `HOST` must support `0.0.0.0` for container port publication; local commands default to `127.0.0.1`. The image sets `HOST=0.0.0.0`, `PORT=8080`, and `DATA_DIR=/data`. If `PORT` changes, change the container-side published port too. For a hostname behind an HTTPS reverse proxy, set `RP_ID` to the hostname and `PUBLIC_ORIGIN` to the exact HTTPS origin, including any nonstandard port. SQLite is the implemented store; remote database environment variables are not implemented configuration.

Use a named volume for a new local instance. A bind mount must already be writable by UID/GID `1000:1000`; the container never recursively changes ownership of existing user data. Preserve the volume across image replacements. The first start copies the seed into it; later starts retain editable app/pages and saved generations. The immutable launcher stays at `/opt/comms`; package workspace exports point at compiled entries. New editable trees contain server.ts, package.json, bun.lock and ui/. Boot prepares dependencies/builds in disposable cache workspaces and copies completed dependencies and UI output into that generation’s `gen/<n>/` directory. There is no boot-owned content-addressed build cache or per-extension install. Declare extension dependencies in the root manifest and lock or ship bundled source. Existing `/data/prepared` artifacts are preserved for old saved snapshots that still reference them. Manifest/lock/UI edits use the existing staged edit and reload API. Existing legacy trees remain untouched; their good snapshots restart, but reload through the new launcher requires explicitly staging the standalone manifest and lockfile.

The smoke script creates only its own disposable container and volume, waits for app onboarding through the published host port, checks the keeper and page/UI seeds, verifies a nonroot UID and read-only image code, and checks page persistence after restart. It does not print setup codes. This is a packaging check, not the failure/concurrency/recovery test suite.

A local compiled-launcher browser smoke passed real passkey login, two message posts and narrow-screen layout. A historical good/bad/good source-reload smoke preserved all 51 acknowledged writes and delivered each matching message event once. The current app-owned SSE intentionally closes during replacement; clients reconnect with the last event ID. These checks exercised the local compiled stack, not a Linux image.

No Docker or Podman executable was available on the implementation host. The image build and Linux smoke remain unverified until run on a Docker host. The base-image manifest digest was verified against Docker Hub. This pins the base bytes and the lockfile pins package versions; application build output is not asserted to be byte-identical across platforms.

## Linux ownership boundary still required

This local image runs both boot and app as UID `1000`. Preparation commands and app children currently share this UID; package lifecycle scripts are disabled, but Vite configuration is editable executable code. Read-only image code protects the immutable runtime, but it does **not** isolate `boot.db`, saved snapshots, or backups from editable app code. It is not completion of SPEC §7.9 and must not be used as evidence for that guarantee.

The original §7.9 launch description cannot work literally: a process that permanently drops root cannot later switch to an unrelated app UID using ordinary `setpriv`. Keep the privilege transition in one immutable launcher/keeper boundary. A concrete implementation must:

- Keep the public HTTP boot process as `boot` without root capabilities. An immutable privileged spawn keeper accepts only a validated generation/attempt descriptor from its boot-owned channel and launches the app as `app`; it never evaluates editable code before dropping privileges. Preserve the current real-process ownership and positive closure-receipt contract. A generic setuid shell script or arbitrary-command RPC is not this boundary.
- Put boot SQL/WAL/shm, staging, receipts, and backups in boot-only directories. Put the live app SQL/WAL/shm together in a separate `app:comms` directory with setgid and group-write permissions; boot joins `comms`. The current flat `DATA_DIR/comms.db` layout needs an explicit migration and path contract, not just file chmod.
- Run dependency preparation and editable Vite configuration as a separate build UID with no boot/app-store group membership. The app UID itself could modify live comms.db before rehearsal. Keep this fixed operation inside the immutable keeper boundary, establish ordinary process-group closure, then copy and sync outputs as boot.
- Publish generation code and dependency trees as boot-owned, app-readable, never app-writable. Boot creates and syncs them before launch. Give app runtime scratch its own writable cache directory; app must not be able to replace parent directories of protected files.
- Separate a boot-only backup from each app-writable rehearsal database clone. A `0700` boot directory cannot also be the app's readable rehearsal path. Expose only that attempt's clone and snapshot through a dedicated directory; the privileged keeper must not grant blanket traversal of backups. Restore still requires positive closure before replacing any database.
- Verify actual Linux denied reads/writes as the app UID, successful SQLite WAL access by both intended roles, startup and good/bad/good reload, and boot/keeper crash recovery. Ownership assertions in a Dockerfile are insufficient.

This contract intentionally adds no permanent root HTTP service, recursive ownership repair, or new orchestration framework. The remaining implementation belongs with boot's storage and child-process lifecycle, followed by a real Linux integration test.

## Linux CI

`.github/workflows/linux.yml` runs on pull requests and pushes to `master`: frozen-lockfile installation, repository checks, all package builds, and the boot/server test suites with two workers. It uses Ubuntu 24.04, Node **22.22.3**, commit-pinned checkout/setup actions, and the published Bun **1.4.0** Linux x64 archive with a fixed SHA-256 checksum. The runtime revision is checked before dependency installation. Permissions are read-only; checkout does not retain credentials. There are no deployment, image publication, secrets, or browser UI test steps.

This deliberately verifies the Bun release declared by `package.json` and `Dockerfile`. The development host reports `bun --version` as `1.4.0` but `bun --revision` as `1.4.0-canary.1+4924862cf`; these are different builds. The published 1.4.0 release targets `34cbb9a40b4bd1bd767d134a7065e66c2432a676`. A versioned release for the old canary was not available, so CI does not download a moving canary or pretend to match it. Updating the runtime requires changing its pinned archive checksum and revision together.

A passing run supplies Linux application/process regression evidence. It does not verify the Docker image, separate boot/app/build users, filesystem ownership enforcement, a real machine reboot, or browser UI behavior. Those checks remain separate acceptance work. The workflow must run on GitHub before it can supply Linux evidence; local validation of its file is not a successful CI run.
