import { type Cause, Context, type Effect, Layer, type Ref } from "effect";
import type { AppRecovery } from "./app-recovery.ts";
import type { AuthConfig } from "./auth.ts";
import type { BackupInventory } from "./backup-inventory.ts";
import type { DatabaseBackup } from "./database-backup.ts";
import type { DatabaseRestore } from "./database-restore.ts";
import type { Editing } from "./edit-http.ts";
import type { RequestEvents } from "./request-events.ts";
import type { SupervisedChild } from "./supervisor.ts";

export type RecoveryPhase =
	| { readonly _tag: "Recovering" }
	| { readonly _tag: "Ready" }
	| { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> }
	| { readonly _tag: "Stopping" };

/** Concrete listener dependencies; recovery controls readiness without withdrawing authentication. */
export class BootHttp extends Context.Service<
	BootHttp,
	{
		readonly child: SupervisedChild;
		readonly storeIdentity?: AppRecovery["Service"]["identityStatus"];
		readonly authConfig: AuthConfig;
		readonly editing: Omit<Editing, "writable">;
		readonly backups: BackupInventory;
		readonly captures: DatabaseBackup;
		readonly restores: DatabaseRestore;
		readonly requests: RequestEvents;
		readonly phase: Ref.Ref<RecoveryPhase>;
		readonly restart: Effect.Effect<void>;
	}
>()("comms/boot/BootHttp") {}
export const layer = (value: BootHttp["Service"]) => Layer.succeed(BootHttp, value);
