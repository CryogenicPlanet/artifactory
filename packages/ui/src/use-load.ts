import { RegistryContext, useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { Effect, Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useState } from "react";
import { BoardError } from "./board-api.ts";

// Atom descriptions hold no results; visibility listeners live in the mounted registry.
const visible = Atom.make((get) => {
	const changed = () => get.setSelf(document.visibilityState === "visible");
	document.addEventListener("visibilitychange", changed);
	get.addFinalizer(() => document.removeEventListener("visibilitychange", changed));
	return document.visibilityState === "visible";
});

/** The mounted registry owns read results, refresh and cancellation; forms own their drafts. */
export function useLoad<A>(
	request: Effect.Effect<A, BoardError> | Atom.Atom<AsyncResult.AsyncResult<A, BoardError>>,
	poll = false,
) {
	const registry = useContext(RegistryContext);
	const [atoms] = useState(() => {
		const input = Atom.make({ request, poll });
		const read = Atom.make((get) => {
			const current = get(input).request;
			return (Atom.isAtom(current) ? get.result(current, { suspendOnWaiting: true }) : current).pipe(
				Effect.catchDefect(() =>
					Effect.fail(new BoardError({ status: 0, message: "This view could not load. Try refreshing." })),
				),
			);
		});
		const refreshed = Atom.withRefresh(read, "10 seconds");
		const result = Atom.writable(
			(get) => {
				const state = get(read);
				// Start the interval only after completion: a queued read must not be canceled by polling.
				return !state.waiting && get(input).poll && get(visible) ? get(refreshed) : state;
			},
			(context, change: (previous: A | undefined) => A | undefined) => {
				const previous = context.get(result);
				const value = change(Option.getOrUndefined(AsyncResult.value(previous)));
				if (value !== undefined) context.setSelf(AsyncResult.map(previous, () => value));
			},
			(refresh) => {
				const current = registry.get(input).request;
				if (Atom.isAtom(current)) refresh(current);
				else refresh(read);
			},
		);
		return { input, result };
	});
	useEffect(() => {
		registry.set(atoms.input, { request, poll });
	}, [registry, atoms, request, poll]);
	const state = useAtomValue(atoms.result);
	const reload = useAtomRefresh(atoms.result);
	const update = useCallback(
		(change: (previous: A | undefined) => A | undefined) => registry.set(atoms.result, change),
		[registry, atoms],
	);
	return {
		value: Option.getOrUndefined(AsyncResult.value(state)),
		error: Option.getOrNull(AsyncResult.error(state)),
		loading: state.waiting,
		reload,
		update,
	};
}
