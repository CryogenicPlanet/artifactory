import type { Crypto, FileSystem, Layer, Path, Schema } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi";
import type { Etag } from "effect/unstable/http";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import type { Topics } from "../ext/core/topics.ts";
import type { Pages } from "../ext/core/pages.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { BootChannel, KernelError } from "./boot-channel.ts";
import type { ExtensionCapabilities } from "../ext/core/capabilities.ts";
import type { makeExtensionMigrate } from "./extension-migrations.ts";
import type { Effect } from "effect";
import type { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";
import type { SqlClient } from "effect/unstable/sql";
import type { Messages } from "../ext/core/messages.ts";
import type { Publication } from "./publication.ts";
import type { Identity } from "./identity.ts";
import type { EventRecord } from "@comms/protocol/events";

import type { ExtensionData } from "./extension-data.ts";
import type { ExtensionEffects } from "./extension-effects.ts";
import type { Work } from "./extension-work.ts";

export interface RequestContext extends Identity, ExtensionData, ExtensionCapabilities {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Effect.Effect<
		{ readonly published_through: number },
		Effect.Error<Publication["Service"]["fence"]>
	>;
	readonly params: Readonly<Record<string, string | undefined>>;
	readonly query: Readonly<Record<string, string | ReadonlyArray<string>>>;
}
export type RequestServices =
	| HttpServerRequest.HttpServerRequest
	| HttpServerRequest.ParsedSearchParams
	| HttpRouter.RouteContext;
export type Hook = () => Work<void> | void;
export interface BackgroundContext extends ExtensionData, ExtensionCapabilities {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Effect.Effect<
		{ readonly published_through: number },
		Effect.Error<Publication["Service"]["fence"]>
	>;
}
export interface CronContext extends BackgroundContext {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Effect.Effect<
		{ readonly published_through: number },
		Effect.Error<Publication["Service"]["fence"]>
	>;
	readonly scheduledAt: number;
}
export interface EventContext extends ExtensionData, ExtensionCapabilities {
	readonly db: SqlClient.SqlClient;
	readonly publicationFence: Effect.Effect<
		{ readonly published_through: number },
		Effect.Error<Publication["Service"]["fence"]>
	>;
	readonly event: typeof EventRecord.Type;
}
export type EventHandler = (payload: Schema.Json, context: EventContext) => Work<void> | void;
type OnArguments =
	| [
			event: "start",
			handler: (event: { readonly reason: "live" | "rehearsal" }, context: BackgroundContext) => Work<void> | void,
	  ]
	| [event: "shutdown", handler: Hook]
	| [event: `${string}.${string}` | "*", handler: EventHandler];
export type ExtensionServices =
	| Publication
	| Messages
	| Topics
	| Pages
	| Lifecycle
	| BootChannel
	| SqlClient.SqlClient
	| Crypto.Crypto
	| FileSystem.FileSystem
	| Path.Path
	| HttpPlatform
	| Etag.Generator;
export interface Api {
	readonly effects: ExtensionEffects;
	readonly context: (scope: "read" | "write" | "fs") => Effect.Effect<RequestContext, KernelError, RequestServices>;
	readonly mount: <Id extends string, Groups extends HttpApiGroup.Constraint, E>(
		definition: HttpApi.HttpApi<Id, Groups>,
		handlers: Layer.Layer<
			HttpApiGroup.ToService<Id, Groups>,
			E,
			ExtensionServices | HttpRouter.Request<"Requires", ExtensionServices>
		>,
	) => void;
	readonly migrate: Effect.Success<ReturnType<typeof makeExtensionMigrate>>;
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
