export const profileHref = (agent: string) => `/@${encodeURIComponent(agent)}`;
export const profilePath = () => {
	try {
		const path = decodeURIComponent(window.location.pathname);
		return /^\/@[a-z0-9][a-z0-9._-]{0,63}$/.test(path) ? path.slice(2) : null;
	} catch {
		return null;
	}
};
