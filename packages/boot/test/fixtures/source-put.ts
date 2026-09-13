import { baseVersionHeader } from "@comms/protocol/headers";
/** Ordinary fixture edits read once and submit that token; no retry hides a competing write. */
export async function sourcePut(
	input: string,
	init: RequestInit,
	fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch,
) {
	const url = new URL(input);
	const readUrl = new URL(url);
	readUrl.search = "";
	const current = await fetcher(readUrl.href, {
		...(init.headers === undefined ? {} : { headers: init.headers }),
		...(init.signal === undefined ? {} : { signal: init.signal }),
	});
	const token = current.status === 404 ? "null" : current.headers.get(baseVersionHeader);
	await current.body?.cancel();
	if ((current.status !== 200 && current.status !== 404) || !token)
		throw new Error(`Cannot read source base: HTTP ${current.status} at ${readUrl.pathname}`);
	url.searchParams.set("baseVersion", token);
	return fetcher(url.href, { ...init, method: "PUT" });
}
