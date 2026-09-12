import { Effect, Schema } from "effect";

const Pair = Schema.Struct({
	engine: Schema.Literals(["sqlite", "pg", "mysql"]),
	/** Canonical endpoint without credentials; null for SQLite. */
	endpoint: Schema.NullOr(Schema.String),
	boot: Schema.String,
	app: Schema.String,
});

/** Constructed by the offline ownership adapter from its actual opened stores.
 * Paths and endpoints are canonical, and data_directory is the held volume. */
export const TransferBinding = Schema.Struct({
	version: Schema.Literal(1),
	transfer_id: Schema.String,
	data_directory: Schema.String,
	source: Pair,
	target: Pair,
	/** The app identity is mirrored in boot.app_store_id; there is no separate boot UUID. */
	store_id: Schema.String,
	manifest: Schema.String,
});
export type TransferBinding = typeof TransferBinding.Type;

export const TransferPhase = Schema.Literals([
	"incomplete",
	"verified",
	"source_boot_retired",
	"source_app_retired",
	"complete",
]);
export type TransferPhase = typeof TransferPhase.Type;
export const TransferJournal = Schema.Struct({ binding: TransferBinding, phase: TransferPhase });
export type TransferJournal = typeof TransferJournal.Type;

export class TransferRejected extends Schema.TaggedError<TransferRejected>()("TransferRejected", {
	code: Schema.Literals([
		"transfer_binding_invalid",
		"transfer_journal_conflict",
		"transfer_identity_mismatch",
		"transfer_source_retired",
		"transfer_target_retired",
		"transfer_verification_failed",
		"transfer_recovery_pending",
	]),
}) {
	get message() {
		return this.code;
	}
}

/** Rebuild field order before encoding: object insertion order is not identity. */
export const bindingText = (binding: TransferBinding) => {
	const pair = (value: TransferBinding["source"]) => ({
		engine: value.engine,
		endpoint: value.endpoint,
		boot: value.boot,
		app: value.app,
	});
	return JSON.stringify({
		version: binding.version,
		transfer_id: binding.transfer_id,
		data_directory: binding.data_directory,
		source: pair(binding.source),
		target: pair(binding.target),
		store_id: binding.store_id,
		manifest: binding.manifest,
	});
};

export const validateTransferBinding = (input: TransferBinding) =>
	Effect.gen(function* () {
		const binding = yield* Schema.decodeUnknownEffect(TransferBinding)(input).pipe(
			Effect.mapError(() => new TransferRejected({ code: "transfer_binding_invalid" })),
		);
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		const path = (value: string) =>
			value.startsWith("/") &&
			value !== "/" &&
			!/[\\\x00-\x1f\x7f]/.test(value) &&
			value
				.slice(1)
				.split("/")
				.every((part) => part !== "" && part !== "." && part !== "..");
		const validPair = (value: TransferBinding["source"]) => {
			if (value.boot === value.app) return false;
			if (value.engine === "sqlite") return value.endpoint === null && path(value.boot) && path(value.app);
			return (
				value.endpoint !== null &&
				/^[a-z0-9.[\]:-]+$/.test(value.endpoint) &&
				[value.boot, value.app].every((name) => name.length > 0 && !/[\/\\\x00-\x1f\x7f]/.test(name))
			);
		};
		const overlapping =
			binding.source.engine === binding.target.engine &&
			binding.source.endpoint === binding.target.endpoint &&
			[binding.source.boot, binding.source.app].some(
				(name) => name === binding.target.boot || name === binding.target.app,
			);
		if (
			!uuid.test(binding.transfer_id) ||
			!uuid.test(binding.store_id) ||
			!path(binding.data_directory) ||
			!/^[0-9a-f]{64}$/.test(binding.manifest) ||
			!validPair(binding.source) ||
			!validPair(binding.target) ||
			overlapping
		)
			return yield* new TransferRejected({ code: "transfer_binding_invalid" });
		return binding;
	});
