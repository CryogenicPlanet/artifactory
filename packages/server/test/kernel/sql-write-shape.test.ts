import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect } from "effect";
import { writeShape } from "../../src/kernel/sql-write.ts";
import { remoteWriteTarget } from "../../src/kernel/sql-write-remote-guard.ts";

it.effect("allows ordinary single-table remote DML and preserves PostgreSQL quoted identifiers", () =>
	Effect.gen(function* () {
		for (const [text, target] of [
			["UPDATE Messages SET body=$1", "messages"],
			['UPDATE "Messages" SET body=$1', "Messages"],
			["INSERT INTO messages(body) VALUES($1)", "messages"],
			["DELETE FROM messages WHERE id=$1", "messages"],
		] as const) {
			expect(yield* remoteWriteTarget(text, "pg")).toBe(target);
		}
		for (const sql of [
			"UPDATE public.messages SET body='x'",
			"UPDATE messages m SET body='x'",
			"UPDATE messages,other SET messages.body='x'",
			"DELETE messages FROM messages JOIN other",
			"INSERT INTO messages AS m VALUES(1)",
			"DROP TABLE messages",
			"WITH rows AS (DELETE FROM messages RETURNING *) SELECT * FROM rows",
		] as const) {
			expect((yield* remoteWriteTarget(sql, "pg").pipe(Effect.result))._tag).toBe("Failure");
		}
	}),
);

it.effect("protects the editable migration ledger from raw SQL writes", () =>
	Effect.gen(function* () {
		for (const sql of ["DELETE FROM migrations", "UPDATE migrations SET name='forgotten'", "DROP TABLE migrations"]) {
			expect((yield* writeShape({ sql }).pipe(Effect.result))._tag).toBe("Failure");
		}
	}),
);
