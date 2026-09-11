import { Context, Effect, FileSystem, Layer, Path, Schema, type Ref, type Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pagePath } from "./public-paths.ts";
import { pageWriteAdmission } from "./page-write-admission.ts";
import type { Destination } from "./traffic.ts";

export class PublicPagesUnavailable extends Schema.TaggedError<PublicPagesUnavailable>()(
	"PublicPagesUnavailable",
	{},
) {}
const make = (
	directory: string,
	operationGate: Semaphore.Semaphore,
	channelGate: Semaphore.Semaphore,
	route: Ref.Ref<Destination | null>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const bootSql = yield* SqlClient.SqlClient;
		const withWrite = yield* pageWriteAdmission(operationGate, channelGate, route);
		const check = (pathname: string) =>
			Effect.gen(function* () {
				if (!pathname.startsWith("/p/") || /%2f|%5c/i.test(pathname)) return null;
				const name = yield* Effect.try(() => decodeURIComponent(pathname.slice(3).replace(/\/$/, ""))).pipe(
					Effect.orElseSucceed(() => ""),
				);
				if (!pagePath(name)) return null;
				const root = path.join(yield* fs.realPath(directory), "pages");
				const target = yield* Effect.gen(function* () {
					let target = root;
					for (const part of ["", ...name.split("/")]) {
						if (part) target = path.join(target, part);
						if ((yield* fs.realPath(target)) !== target) return null;
					}
					return yield* fs.stat(target);
				}).pipe(Effect.orElseSucceed(() => null));
				if (!target || (target.type !== "File" && target.type !== "Directory")) return null;
				const parent = target.type === "Directory" ? name : name.split("/").slice(0, -1).join("/");
				const grants = yield* bootSql`SELECT path FROM public_paths WHERE path=${parent}`;
				return grants.length === 1 ? encodeURIComponent(name) : null;
			}).pipe(
				Effect.timeout("1 second"),
				Effect.catchCause(() => Effect.fail(new PublicPagesUnavailable({}))),
			);
		return { check, withWrite };
	});
/** Anonymous admission reads only boot-owned published grants; unrelated app work never holds its read gate. */
export class PublicPages extends Context.Service<PublicPages, Effect.Success<ReturnType<typeof make>>>()(
	"comms/boot/PublicPages",
) {}
export const layer = (
	directory: string,
	operationGate: Semaphore.Semaphore,
	channelGate: Semaphore.Semaphore,
	route: Ref.Ref<Destination | null>,
) => Layer.effect(PublicPages, make(directory, operationGate, channelGate, route));
