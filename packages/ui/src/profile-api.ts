export const profileHref = (agent: string) => `/@${encodeURIComponent(agent)}`;
export const profileFromPath = (pathname: string) => {
	try {
		const decoded = decodeURIComponent(pathname);
		return /^\/@[a-z0-9][a-z0-9._-]{0,63}$/.test(decoded) ? decoded.slice(2) : null;
	} catch {
		return null;
	}
};
