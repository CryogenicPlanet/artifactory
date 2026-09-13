export const reserved = (path: string) => {
	const route = path.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
	return (
		[
			"/_boot",
			"/_kernel",
			"/api/fs",
			"/api/lock",
			"/api/reload",
			"/api/revert",
			"/api/generations",
			"/api/tokens",
			"/auth",
			"/approve",
			"/setup",
		].some((prefix) => route === prefix || route.startsWith(prefix + "/")) ||
		[
			"/health",
			"/api",
			"/api/ext",
			"/init",
			"/init.md",
			"/quickstart",
			"/quickstart.md",
			"/.well-known/agent.json",
		].includes(route)
	);
};
export const requestPath = (url: string) => {
	try {
		const path = url.startsWith("/") ? url : new URL(url).pathname;
		return decodeURI(path.split(/[?;#]/, 1)[0] ?? "/");
	} catch {
		return null;
	}
};
export const pattern = (route: string) => route.replace(/:[A-Za-z_]\w*/g, ":parameter");
// OpenAPI treats a terminal wildcard and a named segment as the same templated path shape.
export const templatePattern = (route: string) => pattern(route).replace(/\/\*$/, "/:parameter");
export const validateRoute = (method: string, route: string, description: string, scope: string) => {
	if (!route.startsWith("/") || !description.trim()) throw new Error("Extensions require described absolute paths.");
	const segments = route.slice(1).split("/");
	const names = segments.filter((segment) => segment.startsWith(":"));
	if (
		new Set(names).size !== names.length ||
		segments.some((segment, index) =>
			segment.startsWith(":")
				? !/^:[A-Za-z_]\w*$/.test(segment)
				: segment === "*"
					? index !== segments.length - 1
					: /[:*?;#%\\]/.test(segment),
		)
	)
		throw new Error("Use static paths, named :parameters, and an optional terminal /* wildcard.");
	if (!["read", "write", "fs"].includes(scope)) throw new Error("Invalid extension scope.");
	if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method))
		throw new Error("Invalid extension method.");
	if (reserved(route)) throw new Error("Reserved boot or kernel route.");
};
