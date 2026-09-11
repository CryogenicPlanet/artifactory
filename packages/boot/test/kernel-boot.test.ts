import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";
import { readKernelBootId, validateKernelBootId } from "../src/kernel-boot.ts";

const valid = "12345678-1234-4234-8234-123456789abc";

describe("kernel boot identity", () => {
	it("reads the fixed Linux proc file and accepts its canonical UUID and final newline", async () => {
		for (const content of [valid, `${valid}\n`]) {
			const requested: string[] = [];
			const fs = FileSystem.makeNoop({
				readFileString: (path) => {
					requested.push(path);
					return Effect.succeed(content);
				},
			});
			expect(
				await Effect.runPromise(readKernelBootId("linux").pipe(Effect.provideService(FileSystem.FileSystem, fs))),
			).toBe(valid);
			expect(requested).toEqual(["/proc/sys/kernel/random/boot_id"]);
		}
	});

	it("has no identity on other platforms and does not read a substituted file", async () => {
		const fs = FileSystem.makeNoop({ readFileString: () => Effect.die("Unexpected filesystem read") });
		expect(
			await Effect.runPromise(readKernelBootId("darwin").pipe(Effect.provideService(FileSystem.FileSystem, fs))),
		).toBeNull();
	});

	it("treats a missing or failed proc read as unavailable evidence", async () => {
		const fs = FileSystem.makeNoop({});
		expect(
			await Effect.runPromise(readKernelBootId("linux").pipe(Effect.provideService(FileSystem.FileSystem, fs))),
		).toBeNull();
	});

	it("rejects malformed, empty, noncanonical and nil values", async () => {
		for (const content of [
			"",
			"garbage",
			"00000000-0000-0000-0000-000000000000",
			valid.toUpperCase(),
			` ${valid}`,
			`${valid}\n\n`,
			`${valid}\r\n`,
			`${valid}\ntrailing`,
		]) {
			const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(content) });
			expect(validateKernelBootId(content)).toBeNull();
			expect(
				await Effect.runPromise(readKernelBootId("linux").pipe(Effect.provideService(FileSystem.FileSystem, fs))),
			).toBeNull();
		}
	});
});
