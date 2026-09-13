/** Table-name screening only; transaction guards remain authoritative for indirect writes and DDL. */
export const sqlTableTargets = (statement: string) => {
	const tokens =
		statement.match(/"(?:""|[^"])*"|'(?:''|[^'])*'|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[.;(),]/gi) ?? [];
	const targets: string[] = [];
	for (const [index, token] of tokens.entries()) {
		if (
			!/^(INTO|UPDATE|TABLE|REFERENCES)$/i.test(token) &&
			!(token.toUpperCase() === "FROM" && tokens[index - 1]?.toUpperCase() === "DELETE") &&
			!(token.toUpperCase() === "ON" && tokens.slice(0, index).some((word) => /^INDEX$/i.test(word)))
		)
			continue;
		let next = index + 1;
		while (/^(IF|NOT|EXISTS|OR|ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)$/i.test(tokens[next] ?? "")) next++;
		while (tokens[next + 1] === ".") next += 2;
		while (tokens[next]) {
			while (tokens[next + 1] === ".") next += 2;
			const name = tokens[next];
			if (name) targets.push(name.replace(/^["'`[]|["'`\]]$/g, "").toLowerCase());
			if (token.toUpperCase() !== "TABLE" || tokens[index - 1]?.toUpperCase() !== "DROP" || tokens[next + 1] !== ",")
				break;
			next += 2;
		}
	}
	return targets;
};
