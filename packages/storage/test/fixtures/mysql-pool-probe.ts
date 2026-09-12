import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import { Effect } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

const result = await Effect.runPromise(
	MysqlClient.make({}).pipe(Effect.provide(Reactivity.layer), Effect.scoped, Effect.exit),
);
if (result._tag !== "Failure") throw new Error("Expected disposable connection failure");
