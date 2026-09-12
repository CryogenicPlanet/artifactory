import { Schema } from "effect";
import { RemoteRootConfiguration } from "./remote-root-protocol.ts";

/** Immutable copy-worker input. Never pass these guardian capabilities to editable migrations. */
const Endpoint = Schema.Struct({ directory: Schema.String, guardian: RemoteRootConfiguration });
export const RemoteTransferConfiguration = Schema.Struct({
	transferId: Schema.String.pipe(
		Schema.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)),
	),
	source: Schema.NullOr(Endpoint),
	target: Schema.NullOr(Endpoint),
});
