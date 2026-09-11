import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript-parser";

const root = resolve(import.meta.dirname, "..");
const packages = resolve(root, "packages");
function checkInvariants() {
	const failures: string[] = [];

	function workspace(path: string) {
		const local = relative(packages, path);
		return local.startsWith(`..${sep}`) ? undefined : local.split(sep)[0];
	}

	function inspect(path: string) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const owner = workspace(path);
		function checkImport(specifier: string) {
			const label = relative(root, path);
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(path), specifier);
				const targetLabel = relative(root, target);
				// Cross-store failure fixtures exercise the real boot/server boundary without shipping these imports.
				const integrationFixture =
					label.startsWith(`packages${sep}server${sep}test${sep}fixtures${sep}`) &&
					(targetLabel.startsWith(`packages${sep}boot${sep}src${sep}`) ||
						targetLabel.startsWith(`packages${sep}boot${sep}test${sep}`));
				if (workspace(target) !== owner && !integrationFixture)
					failures.push(`${label}: relative import leaves package: ${specifier}`);
			}
			if (specifier.startsWith("@comms/")) {
				const dependency = specifier.split("/")[1];
				const allowed =
					(owner === "server" && dependency === "boot") ||
					(owner === "ui" && dependency === "server" && !label.startsWith(`packages${sep}ui${sep}src${sep}`));
				if (!allowed)
					failures.push(`${label}: unsupported workspace import: ${specifier}; expected ui launcher -> server -> boot`);
			}
			if (specifier.includes("repos/")) failures.push(`${label}: vendored references must not be imported`);
		}
		// Static ownership guard: interpolation remains opaque; this is not a SQL validator.
		function checkDomainSql(node: ts.Node, text: string) {
			if (!relative(root, path).startsWith(`packages${sep}boot${sep}src${sep}`)) return;
			const tokens =
				text.match(
					/--[^\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|'(?:''|[^'])*'|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[.;(),]/gi,
				) ?? [];
			const words = tokens.filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
			const identifier = (token: string) => token.replace(/^["'`[]|["'`\]]$/g, "").toLowerCase();
			let depth = 0;
			const fromDepths = new Set<number>();
			for (const [index, token] of words.entries()) {
				const keyword = token.toUpperCase();
				if (token === "(") depth++;
				if (token === ")") {
					fromDepths.delete(depth);
					depth--;
				}
				if (/^(WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|EXCEPT|INTERSECT|RETURNING|;)$/i.test(token))
					fromDepths.delete(depth);
				if (keyword === "FROM") fromDepths.add(depth);

				if (
					!["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "REFERENCES"].includes(keyword) &&
					!(token === "," && fromDepths.has(depth)) &&
					!(keyword === "ON" && words.slice(0, index).some((word) => /^(INDEX|TRIGGER)$/i.test(word)))
				)
					continue;
				let next = index + 1;
				while (/^(IF|NOT|EXISTS|OR|ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)$/i.test(words[next] ?? "")) next++;
				let grouped = 0;
				while (words[next] === "(") {
					grouped++;
					next++;
				}
				if (grouped && !/^(SELECT|WITH)$/i.test(words[next] ?? "")) fromDepths.add(depth + grouped);
				if (words[next + 1] === ".") next += 2;
				const table = identifier(words[next] ?? "");
				if (["topics", "messages", "reads", "agents"].includes(table)) {
					const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
					failures.push(`${relative(root, path)}:${line}: boot must not know app domain table ${table}`);
				}
			}
		}
		function visit(node: ts.Node) {
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) checkDomainSql(node, node.text);
			if (ts.isTemplateExpression(node))
				checkDomainSql(
					node,
					[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" __interpolation__ "),
				);

			if (ts.isImportTypeNode(node)) {
				failures.push(`${relative(root, path)}: use a top-level import type declaration instead of an inline import`);
			}
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
				if (ts.isStringLiteral(node.moduleSpecifier)) checkImport(node.moduleSpecifier.text);
			}
			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && node.expression.text === "require"))
			) {
				const argument = node.arguments[0];
				if (argument && ts.isStringLiteral(argument)) checkImport(argument.text);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}

	function walk(directory: string) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (["node_modules", "dist"].includes(entry.name)) continue;
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name)) inspect(path);
		}
	}

	walk(packages);
	if (failures.length > 0) {
		console.error(failures.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("Workspace import boundaries passed.");
	}
}

checkInvariants();
