import { RegistryContext, useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { Effect, Option } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { boardFailure } from "./board-api.ts";

/** The mounted registry owns read results, refresh and cancellation; forms own their drafts. */
export function useLoad<A, E>(request: Effect.Effect<A, E> | Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
	const registry = useContext(RegistryContext);
	const [atoms] = useState(() => {
		const input = Atom.make({ request });
		const read = Atom.make((get) => {
			const current = get(input).request;
			return (Atom.isAtom(current) ? get.result(current, { suspendOnWaiting: true }) : current).pipe(
				Effect.catchCause((cause) => Effect.fail(boardFailure(cause))),
			);
		});
		const result = Atom.writable(
			(get) => get(read),
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
		registry.set(atoms.input, { request });
	}, [registry, atoms, request]);
	const state = useAtomValue(atoms.result);
	const reload = useAtomRefresh(atoms.result);
	const update = useCallback(
		(change: (previous: A | undefined) => A | undefined) => registry.set(atoms.result, change),
		[registry, atoms],
	);
	const fresh = Option.getOrUndefined(AsyncResult.value(state));
	/* Stale-while-revalidate: keep the last loaded value so navigation never flashes a skeleton. */
	const stale = useRef<A | undefined>(undefined);
	useEffect(() => {
		if (fresh !== undefined) stale.current = fresh;
	}, [fresh]);
	return {
		value: fresh ?? stale.current,
		error: Option.getOrNull(AsyncResult.error(state)),
		loading: state.waiting,
		reload,
		update,
	};
}
