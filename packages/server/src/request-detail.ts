import type { ErrorDetail } from "@comms/protocol/errors";
import type { SchemaIssue } from "effect";

type Reason = "unexpected" | "missing" | "invalid";
interface Offender {
	readonly field: string;
	readonly reason: Reason;
}

/** The first key a decode failure points at, so one error code can still say what to fix. */
const offending = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey> = []): Offender | undefined => {
	const named = (reason: Reason) => (path.length === 0 ? undefined : { field: path.map(String).join("."), reason });
	switch (issue._tag) {
		case "Pointer":
			return offending(issue.issue, [...path, ...issue.path]);
		case "Filter":
		case "Encoding":
			return offending(issue.issue, path);
		case "Composite":
		case "AnyOf":
			// A union that reports no branch detail still points at the key it was reached through.
			return (
				issue.issues.reduce<Offender | undefined>((found, child) => found ?? offending(child, path), undefined) ??
				named("invalid")
			);
		case "UnexpectedKey":
			return named("unexpected");
		case "MissingKey":
			return named("missing");
		default:
			return named("invalid");
	}
};

/** Descend past wrappers that add neither a path segment nor a choice, to the node that branches. */
const unwrap = (issue: SchemaIssue.Issue): SchemaIssue.Issue => {
	switch (issue._tag) {
		case "Filter":
		case "Encoding":
			return unwrap(issue.issue);
		case "Pointer":
			return issue.path.length === 0 ? unwrap(issue.issue) : issue;
		case "Composite":
		case "AnyOf": {
			const only = issue.issues.length === 1 ? issue.issues[0] : undefined;
			return only === undefined ? issue : unwrap(only);
		}
		default:
			return issue;
	}
};

/** Every branch of a union refusing a key means the input mixed two request shapes. */
const mixedShapes = (root: SchemaIssue.Issue): ReadonlyArray<string> | undefined => {
	const issue = unwrap(root);
	if (issue._tag !== "AnyOf" || issue.issues.length < 2) return undefined;
	const offenders = issue.issues.map((branch) => offending(branch));
	if (offenders.some((found) => found === undefined || found.reason !== "unexpected")) return undefined;
	return [...new Set(offenders.flatMap((found) => (found === undefined ? [] : [found.field])))].sort();
};

const subject = {
	query: { noun: "query parameter", listed: "GET /api lists the query parameters this route accepts." },
	body: { noun: "field", listed: "GET /api lists the fields this route accepts." },
} as const;

/**
 * Turn a decode failure into a named field and a specific hint. The code itself does not change:
 * input_invalid and query_invalid stay as they are, and only gain something to act on.
 */
export const requestDetail = (
	kind: "query" | "body",
	issue: SchemaIssue.Issue,
	bound?: (field: string) => string | undefined,
): { readonly detail?: ErrorDetail } => {
	const { noun, listed } = subject[kind];
	const mixed = mixedShapes(issue);
	const found = offending(issue);
	if (mixed !== undefined && mixed.length > 1)
		return {
			detail: {
				field: mixed[0] ?? "",
				hint: `These ${noun}s belong to different request shapes: ${mixed.join(", ")}. Send the ${noun}s of exactly one. ${listed}`,
			},
		};
	if (found === undefined) return {};
	const hint =
		found.reason === "unexpected"
			? `This route has no ${noun} named ${found.field}. ${listed}`
			: found.reason === "missing"
				? `The ${found.field} ${noun} is required. ${listed}`
				: (bound?.(found.field) ?? `The ${found.field} ${noun} has the wrong type or value. ${listed}`);
	return { detail: { field: found.field, hint } };
};
