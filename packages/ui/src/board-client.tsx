import { Api } from "@comms/protocol";
import { RegistryContext, useAtomMount } from "@effect/atom-react";
import { Clock, Effect, type Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Atom, AtomHttpApi, AtomRegistry, type AsyncResult } from "effect/unstable/reactivity";
import { createContext, useContext, useState, type ReactNode } from "react";
import { boardFailure, type PendingMessage } from "./board-api.ts";
import { getEditLock } from "./extension-api.ts";
import { liveEvents } from "./live-events.ts";

const makeClient = (registry: AtomRegistry.AtomRegistry) => {
	// Service constructors contain query-family caches: create them once per provider, never globally.
	class Client extends AtomHttpApi.Service<Client>()("comms/browser/Client", {
		api: Api,
		httpClient: FetchHttpClient.layer,
		baseUrl: window.location.origin,
		runtime: Atom.context(),
		transformResponse: (effect) => effect.pipe(Effect.timeout("15 seconds")),
	}) {}
	const create = Client.mutation("conversation", "create", { responseMode: "decoded-only" });
	const meta = Client.mutation("topicManagement", "meta", { responseMode: "decoded-only" });
	const run = <Input, A, E>(atom: Atom.AtomResultFn<Input, A, E>, input: NoInfer<Input>) =>
		Effect.gen(function* () {
			yield* Effect.sync(() => registry.set(atom, input));
			return yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
		}).pipe(Effect.catchCause((cause) => Effect.fail(boardFailure(cause))));
	return {
		live: Client.runtime.atom(liveEvents),
		extensions: Client.query("ext", "list", { reactivityKeys: ["extensions"] }),
		lock: Client.runtime.factory.withReactivity(["extensions"])(
			Atom.make((get) =>
				getEditLock.pipe(
					Effect.tap((lock) =>
						Effect.gen(function* () {
							if (lock === null || lock.cutover_in_flight) return;
							// Expiry is observed on reads; the atom scope cancels this one-shot refresh on disposal.
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.sleep(Math.max(1, lock.expires - now + 1)).pipe(
								Effect.andThen(Effect.sync(() => get.refreshSelf())),
								Effect.forkScoped,
							);
						}),
					),
				),
			),
		),
		me: Atom.mapResult(
			Client.query("profiles", "me", { query: {}, reactivityKeys: ["identity"] }),
			(response) => response.body,
		),
		topic: (path: string, archived: boolean, mark: boolean) =>
			path
				? Client.query("topics", "detail", {
						params: { path },
						query: { archived: archived ? "1" : "0", mark: mark ? "1" : "0" },
						reactivityKeys: ["board"],
					})
				: Client.query("topics", "root", {
						query: { archived: archived ? "1" : "0", mark: mark ? "1" : "0" },
						reactivityKeys: ["board"],
					}),
		messages: (
			query: {
				readonly since: number;
				readonly limit?: number;
				readonly topic?: string;
				readonly recursive?: "1";
				readonly mark?: "0";
				readonly q?: string;
				readonly tag?: string;
				readonly agent?: string;
			},
			live = false,
		) => Client.query("conversation", "messages", { query, ...(live ? { reactivityKeys: ["board"] } : {}) }),
		sendMessage: (message: PendingMessage) =>
			run(create, {
				payload: { topic: message.topic, body: message.body },
				headers: { "idempotency-key": message.key },
				reactivityKeys: ["board"],
			}),
		// rc113 client types require narrowing the untagged payload union at the call site.
		saveTopic: (path: string, payload: { readonly meta: Schema.JsonObject } | { readonly archived: boolean }) =>
			"meta" in payload
				? run(meta, { params: { path }, payload, query: {}, headers: {}, reactivityKeys: ["board"] })
				: run(meta, { params: { path }, payload, query: {}, headers: {}, reactivityKeys: ["board"] }),
		read: <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
			AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
				Effect.catchCause((cause) => Effect.fail(boardFailure(cause))),
			),
	};
};
const ClientContext = createContext<ReturnType<typeof makeClient> | null>(null);
export function BoardClientProvider({ children }: { readonly children: ReactNode }) {
	const registry = useContext(RegistryContext);
	const [client] = useState(() => makeClient(registry));
	useAtomMount(client.live);
	return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}
export function useBoardClient() {
	const client = useContext(ClientContext);
	if (client === null) throw new Error("BoardClientProvider is required");
	return client;
}
