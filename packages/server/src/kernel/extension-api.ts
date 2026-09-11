import type { Schema } from "effect";
import type { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import type { SqlClient } from "effect/unstable/sql";
import type { Messages, Identity } from "./messages.ts";
import type { EventRecord } from "./boot-channel.ts";
import type { ExtensionData } from "./extension-data.ts";
import type { Work } from "./extension-work.ts";

export interface RequestContext extends Identity, ExtensionData {
	readonly db: SqlClient.SqlClient;
	readonly publishedThrough: number;
	readonly publicationFence: Messages["Service"]["fence"];
	readonly params: Readonly<Record<string, string | undefined>>;
	readonly query: Readonly<Record<string, string | ReadonlyArray<string>>>;
}
export type RequestServices =
	| HttpServerRequest.HttpServerRequest
	| HttpServerRequest.ParsedSearchParams
	| HttpRouter.RouteContext;
export type Hook = () => Work<void> | void;
export interface CronContext extends ExtensionData {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Messages["Service"]["fence"];
	readonly scheduledAt: number;
}
export interface EventContext extends ExtensionData {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Messages["Service"]["fence"];
	readonly event: typeof EventRecord.Type;
}
export type EventHandler = (payload: Schema.Json, context: EventContext) => Work<void> | void;
type OnArguments =
	| [event: "start", handler: (event: { readonly reason: "live" }) => Work<void> | void]
	| [event: "shutdown", handler: Hook]
	| [event: `${string}.${string}` | "*", handler: EventHandler];
export interface Api {
	readonly page: (
		path: `/${string}`,
		handler: (context: RequestContext) => Work<Response | string, RequestServices> | Response | string,
	) => void;
	readonly cron: (expression: string, handler: (context: CronContext) => Work<void>) => void;
	readonly route: (
		method: HttpMethod,
		path: `/${string}`,
		options: {
			readonly description: string;
			readonly scope: "read" | "write" | "fs";
			readonly handler: (
				request: HttpServerRequest.HttpServerRequest,
				context: RequestContext,
			) => Work<Response, RequestServices>;
		},
	) => void;
	readonly on: (...args: OnArguments) => void;
}
