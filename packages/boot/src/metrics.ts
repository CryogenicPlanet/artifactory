import { Effect, Metric } from "effect";
import { PrometheusMetrics } from "effect/unstable/observability";

/** One private registry per boot instance. Metrics never use Effect's process-shared default registry. */
export const metrics = Effect.gen(function* () {
	const registry: Metric.MetricRegistry = new Map();
	const requests = Metric.counter("comms_requests_total", {
		description: "HTTP requests received by the boot listener, including child calls and scrapes.",
		incremental: true,
	});
	const waits = Metric.counter("comms_lock_waits_total", {
		description: "Edit requests refused because another editor holds the lock or a cutover pins it.",
		incremental: true,
	});
	const queue = Metric.gauge("comms_freeze_queue_depth", {
		description: "App mutation requests currently waiting for the boot freeze to end.",
	});
	const swaps = Metric.histogram("comms_swap_duration_seconds", {
		description:
			"Reload time after source proposal preparation, including rehearsal and failure recovery; excludes check-only.",
		boundaries: [0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
	});
	const own = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(Metric.MetricRegistry, registry));
	yield* own(Effect.all([Metric.value(requests), Metric.value(waits), Metric.value(queue), Metric.value(swaps)]));
	return {
		request: own(Metric.update(requests, 1)),
		lockWait: own(Metric.update(waits, 1)),
		swap: (seconds: number) => own(Metric.update(swaps, seconds)),
		render: (queued: number) => own(Metric.update(queue, queued).pipe(Effect.andThen(PrometheusMetrics.format()))),
	};
});
export type BootMetrics = Effect.Success<typeof metrics>;
