/** Build once per owning scope from its configured passwords and rendered database URLs.
 * Apply to complete diagnostic text before storing or truncating it, never individual stream chunks. */
export const logRedactor = (configured: readonly string[]) => {
	const values = configured.flatMap((value) => {
		try {
			const url = new URL(value);
			if (/^(?:postgres(?:ql)?|mysql):$/.test(url.protocol)) return [value, decodeURIComponent(url.password)];
		} catch {
			// Passwords are usually not URLs. Their exact value still needs redaction.
		}
		return [value];
	});
	const secrets = [
		...new Set(
			values.filter(Boolean).flatMap((value) => {
				const encoded = encodeURIComponent(value.toWellFormed());
				const url = new URL("mysql://localhost");
				url.password = value;
				return [value, JSON.stringify(value).slice(1, -1), encoded, url.password];
			}),
		),
	].sort((left, right) => right.length - left.length);
	return (text: string): string => {
		let redacted = text.replace(
			/\b(?:postgres(?:ql)?|mysql):\/\/[^\s/]*@/gi,
			(prefix) => `${prefix.slice(0, prefix.indexOf("://") + 3)}[redacted]@`,
		);
		for (const secret of secrets) {
			const pattern = secret
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(
					/%([a-f0-9])([a-f0-9])/gi,
					(_, first: string, second: string) =>
						`%[${first.toLowerCase()}${first.toUpperCase()}][${second.toLowerCase()}${second.toUpperCase()}]`,
				);
			redacted = redacted.replace(new RegExp(pattern, "g"), "[redacted]");
		}
		return redacted.replace(/[a-f0-9]{64}/g, "[redacted]");
	};
};
