import { agentHeader } from "@comms/protocol/headers";
import { Console, Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { publicRoute } from "../../src/proxy.ts";

const response = await Effect.runPromise(
	publicRoute.pipe(
		Effect.provideService(
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(
				new Request("http://localhost/.well-known/agent.json", {
					headers: { authorization: "Bearer invalid", [agentHeader]: "forged", "x-boot-secret": "private" },
				}),
			),
		),
	),
);
if (!response) throw new Error("Missing recovery manifest");
const web = HttpServerResponse.toWeb(response);
Effect.runSync(
	Console.log(
		JSON.stringify({ status: web.status, headers: Object.fromEntries(web.headers), manifest: await web.json() }),
	),
);
