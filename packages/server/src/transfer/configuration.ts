import { databaseConfiguration } from "@comms/boot";
import { ConfigProvider, Effect, Schema } from "effect";
import { TransferRejected } from "@comms/storage/store-transfer-schema";

const Descriptors = Schema.Struct({ boot: Schema.String, app: Schema.String });
const Input = Schema.Struct({
	version: Schema.Literal(1),
	transfer_id: Schema.String,
	mode: Schema.Literals(["check", "transfer"]),
	source: Descriptors,
	target: Descriptors,
	tls: Schema.Boolean,
});
const invalid = () => new TransferRejected({ code: "transfer_binding_invalid" });

/** Private immutable-worker configuration only. Never forward to editable children. */
export const decodeTransferConfiguration = (encoded: string) =>
	Effect.gen(function* () {
		const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Input))(encoded).pipe(
			Effect.mapError(invalid),
		);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(input.transfer_id))
			return yield* invalid();
		const pair = (descriptors: typeof Descriptors.Type) =>
			databaseConfiguration("/unselected/boot.db", "/unselected/app.db").pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						DATABASE_URL: descriptors.app,
						BOOT_DATABASE_URL: descriptors.boot,
						DATABASE_TLS: input.tls,
					}),
				),
				Effect.mapError(invalid),
			);
		const source = yield* pair(input.source);
		const target = yield* pair(input.target);
		const engine = (configuration: typeof source) =>
			configuration._tag === "file" ? "sqlite" : configuration.bootConnection.engine;
		if (engine(source) === engine(target)) return yield* invalid();
		return { transferId: input.transfer_id, mode: input.mode, source, target };
	});
