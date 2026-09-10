import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { startServer } from "./start.ts";

startServer.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
