import { Context, Effect, FileSystem, Layer } from "effect";

/** Only the kernel's canonical random UUID is evidence of a kernel lifetime. */
export const validateKernelBootId = (value: string | null): string | null =>
	value !== null &&
	value.length === 36 &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
		? value
		: null;

/** Unsupported or unreadable kernel identity never substitutes a process-generated identifier. */
export const readKernelBootId = (platform: string) =>
	Effect.gen(function* () {
		if (platform !== "linux") return null;
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(
			Effect.map((value) => validateKernelBootId(value.endsWith("\n") ? value.slice(0, -1) : value)),
			Effect.orElseSucceed(() => null),
		);
	});

export class KernelBoot extends Context.Service<KernelBoot, { readonly id: string | null }>()(
	"comms/boot/KernelBoot",
) {}
export const layer = Layer.effect(KernelBoot, readKernelBootId(process.platform).pipe(Effect.map((id) => ({ id }))));
