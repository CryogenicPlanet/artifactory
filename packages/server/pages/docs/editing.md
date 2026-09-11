# Edit and recover

The edit APIs are boot-owned and require `fs` scope. Read the current file in full before editing. Keep optional features in `app/ext/`; use the existing Effect services and avoid global mutable state.

## Stage and reload

1. `POST /api/lock {"note":"update extension"}` acquires the edit lock. `423` identifies the other holder and explains how to wait. The default lease is 15 minutes; holder writes renew it.
2. Read `GET /api/fs/app/<path>`. Runtime seeds use `app/server.ts` as the child entry.
3. `PUT /api/fs/app/<path>?reload=0` with the raw replacement stages it. Repeat for other files. Staging is invisible to the current app.
4. `POST /api/reload?check=1 {}` prepares dependencies and rehearses against a database copy without publishing the edit.
5. `POST /api/reload?release=1 {}` rehearses and reloads, releasing the lock on success. Read the returned outcome and stderr before continuing. Failed edits retain staging for repair.

Every JSON request needs `Content-Type: application/json`; every reload POST also needs its JSON body. File PUTs instead send the raw file bytes. For example:

```sh
curl -X POST "$HOST/api/reload?check=1" \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{}'
```

`POST /api/fs/edit` accepts `{path,edits:[{old_string,new_string}],baseVersion?}`. Read the raw source response’s `X-Comms-Base-Version` header for `baseVersion`; it is a content token, not a history id. An ambiguous or stale anchor is refused before staging. `DELETE /api/lock` discards uncommitted staging, as does expiry. Do not use release to preserve work you have not committed.

## Undo source

With an empty staging overlay and your edit lock, `POST /api/revert {"path":"app/ext/example.ts"}` undoes a file edit; `{ "batch": "<batch>" }` selects a batch. `GET /api/fs/app/<path>?history` lists retained versions.

`GET /api/generations` lists snapshots. `POST /api/revert {"generation":9}` restores retained whole-source content and dependencies through rehearsal/cutover while preserving the current database and pages. Old code can be incompatible with a newer schema; repair forward when rehearsal rejects it. Incomplete provenance or unretained history is refused rather than guessed.

After a lost response, reuse the same Idempotency-Key and selector with the same live identity. A completed keyed source undo replays its exact terminal outcome without creating another generation, running hooks or overwriting later edits. Terminal receipts remain for at least 30 days; pending outcomes and historical selection-only keys have different recovery rules. Without a key, every call is a new undo. See the [boot recovery contract](../../../boot/docs/README.md) for retention and uncertain-outcome details.

## Pages

`PUT /api/fs/pages/project/plan.md` publishes immediately without an app lock or reload. Its response includes `published:true` and a history `batch`. Read it at `/p/project/plan.md`, or add `?raw=1`. These boot-owned repair routes bypass app archive/deletion policy while enforcing authentication, safe paths and durable publication. A pending app reservation makes publication wait outside the operation/channel gates; cancellation while waiting creates no page journal. Conflicting durable recovery intents remain fail-closed. `/init` is `pages/init.md`; keep it short and link to detailed pages here.

## When the app fails

`GET /_boot` lists recovery routes. `GET /_boot/status` and `/api/generations` provide diagnostics with a human session or `fs` scope. Source edits use `/api/fs`, `/api/lock`, `/api/reload` and `/api/revert` even when the app cannot serve its own routes, subject to recovery guards that prevent mutation while database ownership is uncertain.

Restoring database contents is a human decision: `GET /_boot/db/backups`, then passkey-bound `POST /_boot/db/restore {"backup":"<id>"}`. It restores data using the current retained source. Never treat a source revert as a database rollback. A human can use passkey-bound `POST /_boot/revert {"generation":9,"withDb":true}` for combined source/database restore; its `generation.restore` proof binds the retained generation and backup. Ordinary human source revert can borrow another editor’s lock without consuming staging. Agents cannot authorize database restore with `fs` scope. See the [boot recovery contract](../../../boot/docs/README.md) for the separate proof ceremonies.
