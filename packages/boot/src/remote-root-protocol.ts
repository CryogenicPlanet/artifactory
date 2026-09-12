import { TransferDumpReference } from "./transfer-dump-authority.ts";
import { Cause, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { StoreError } from "@comms/storage/store";

/** Private immutable-process authority. Never forward this configuration to editable code. */
export const RemoteRootConfiguration = Schema.Struct({
	url: Schema.String.pipe(
		Schema.check(
			Schema.makeFilter(
				(value) => /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) && Number(value.split(":")[2]) <= 65535,
			),
		),
	),
	secret: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
	attempt: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});

export const RemoteRootSession = Schema.Struct({
	engine: Schema.Literals(["pg", "mysql"]),
	server: Schema.String,
	database: Schema.String,
	username: Schema.String,
	connectionId: Schema.String,
	tag: Schema.String,
});

export const RemoteRootRequest = Schema.Union([
	Schema.Struct({
		action: Schema.Literal("register"),
		session: RemoteRootSession,
		operation: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({ action: Schema.Literal("open-operation") }),
	Schema.Struct({ action: Schema.Literal("close-operation"), operation: Schema.String }),
	Schema.Struct({
		action: Schema.Literal("reserve-owner"),
		store: Schema.String,
		attempt: Schema.String,
		scope: Schema.Literals(["database", "account"]),
		transferDump: Schema.optionalKey(TransferDumpReference),
	}),
	Schema.Struct({ action: Schema.Literal("admit-owner"), attempt: Schema.String }),
	Schema.Struct({
		action: Schema.Literal("assert-principal-closed"),
		store: Schema.String,
		transferDump: Schema.optionalKey(TransferDumpReference),
	}),
]);

/** Admission must precede owner-file creation, inspector connections and native spawning. */
export const admitRemoteOwner = (config: { readonly guardian: typeof RemoteRootConfiguration.Type }, attempt: string) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client.execute(
			HttpClientRequest.post(`${config.guardian.url}/root`).pipe(
				HttpClientRequest.setHeader("x-comms-guardian-secret", config.guardian.secret),
				HttpClientRequest.bodyJsonUnsafe({ action: "admit-owner", attempt }),
			),
		);
		if (response.status !== 204) return yield* new StoreError({ code: "store_descriptor_mismatch" });
	}).pipe(
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
		Effect.timeout("5 seconds"),
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.fail(new StoreError({ code: "store_descriptor_mismatch" })),
		),
	);
