import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";
import { BoardError } from "./board-api.ts";

type LoadState<A> = {
	readonly value: A | undefined;
	readonly error: BoardError | null;
	readonly loading: boolean;
};

/** One mounted read owns its request, refresh loop and cancellation. Keep requests stable with useMemo. */
export function useLoad<A>(request: Effect.Effect<A, BoardError>, poll = false) {
	const [state, setState] = useState<LoadState<A>>({ value: undefined, error: null, loading: true });
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		setState((previous) => ({ ...previous, loading: true }));
		const load = request.pipe(
			Effect.catchDefect(() =>
				Effect.fail(new BoardError({ status: 0, message: "This view could not load. Try refreshing." })),
			),
			Effect.match({
				onSuccess: (value) => setState({ value, error: null, loading: false }),
				onFailure: (error) => setState((previous) => ({ ...previous, error, loading: false })),
			}),
		);
		const run = Effect.gen(function* () {
			yield* load;
			while (poll) {
				yield* Effect.sleep("10 seconds");
				if (document.visibilityState === "visible") yield* load;
			}
		});
		void Effect.runPromise(run, { signal: controller.signal }).catch(() => {});
		return () => controller.abort();
	}, [request, poll, revision]);
	const reload = useCallback(() => {
		setState((previous) => ({ ...previous, loading: true }));
		setRevision((previous) => previous + 1);
	}, []);
	const update = useCallback((change: (previous: A | undefined) => A | undefined) => {
		setState((previous) => ({ ...previous, value: change(previous.value) }));
	}, []);
	return { ...state, reload, update };
}
