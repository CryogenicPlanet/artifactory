import { Effect, Option } from "effect";
import { BootChannel } from "./kernel/boot-channel.ts";
import { HealthProbe } from "./kernel/health-probe.ts";

/** Read only known event types: the child channel itself can also see private request records. */
export const activity = (since: number, topic: string | null) =>
	Effect.gen(function* () {
		// The health transaction has synthetic, unpublished messages and must not read the live log.
		if (Option.isSome(yield* Effect.serviceOption(HealthProbe))) return { text: "", truncated: false };
		const boot = yield* BootChannel;
		const [messages, operations] = yield* Effect.all(
			[
				boot.events({
					since,
					limit: 21,
					types: ["message.created", "message.edited", "message.deleted"],
					...(topic ? { topic } : {}),
				}),
				boot.events({ since, limit: 21, types: ["generation.*", "ext.failed", "ext.error"] }),
			],
			{ concurrency: 2 },
		);
		let text = `\n## Since you were last here (#${since})\n\nFirst 20 matching events per section; separate log reads. Payloads omitted.\n`;
		for (const [label, page, types, subtree] of [
			["Message activity", messages, "message.created,message.edited,message.deleted", topic],
			["Shared operational activity", operations, "generation.*,ext.failed,ext.error", null],
		] as const) {
			text += `\n### ${label}\n`;
			const shown = page.items.slice(0, 20);
			for (const event of shown)
				text += `- #${event.seq} · ${event.type} · ${event.level} · generation ${event.generation}${event.topic ? ` · ${event.topic}` : ""}\n`;
			if (shown.length === 0) text += "No matching events.\n";
			if (page.items.length > 20) {
				const params = new URLSearchParams({
					since: String(shown.at(-1)?.seq ?? since),
					types,
					...(subtree ? { topic: subtree } : {}),
				});
				text += `More: /api/events?${params}\n`;
			}
		}
		return { text, truncated: messages.items.length > 20 || operations.items.length > 20 };
	});
