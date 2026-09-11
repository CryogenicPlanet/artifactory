import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { errorSchemas } from "./errors.ts";
/** rc113's HttpApi decoder ignores excess keys and Bun request.text has no byte limit.
 * Validate the declared wire schemas strictly and bound the body before .handle decodes it.
 */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
	"comms/server/RequestValidation",
	{ error: errorSchemas },
) {}
