import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript-parser";

const root = resolve(import.meta.dirname, "..");
const packages = resolve(root, "packages");
function checkInvariants() {
	const failures: string[] = [];
	const appTables = new Set<string>();
	// These are shared recovery records, not editable product tables. Keep exceptions table- and file-specific.
	const recoveryAccess: Readonly<Record<string, ReadonlyArray<string>>> = {
		"app-recovery.ts": ["kernel_writer", "mutation_batches", "outbox"],
		"app-kernel-schema.ts": ["kernel_writer", "mutation_batches", "outbox"],
		"transfer-kernel-initialize.ts": ["kernel_writer", "mutation_batches", "outbox"],
		"db-ops.ts": ["kernel_writer"],
		"remote-db-ops.ts": ["kernel_writer"],
	};

	function workspace(path: string) {
		const local = relative(packages, path);
		return local.startsWith(`..${sep}`) ? undefined : local.split(sep)[0];
	}

	function inspect(path: string, collectTables = false) {
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const owner = workspace(path);
		const transferMetadata =
			relative(root, path) === `packages${sep}server${sep}src${sep}transfer${sep}derived-schema.ts`;

		function checkImport(specifier: string) {
			const label = relative(root, path);
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(path), specifier);
				const targetLabel = relative(root, target);
				// Failure fixtures exercise the real boot/server boundary and relocated optional policies without shipping imports.
				const integrationFixture =
					label.startsWith(`packages${sep}server${sep}test${sep}fixtures${sep}`) &&
					(targetLabel.startsWith(`packages${sep}boot${sep}src${sep}`) ||
						targetLabel.startsWith(`packages${sep}boot${sep}test${sep}`) ||
						targetLabel.startsWith(`examples${sep}extensions${sep}`));
				if (workspace(target) !== owner && !integrationFixture)
					failures.push(`${label}: relative import leaves package: ${specifier}`);
			}
			if (specifier.startsWith("@comms/")) {
				const dependency = specifier.split("/")[1];
				const allowed =
					((owner === "boot" || owner === "server") && dependency === "storage") ||
					((owner === "server" || owner === "ui") && dependency === "protocol") ||
					(owner === "server" &&
						dependency === "boot" &&
						(label === `packages${sep}server${sep}src${sep}start.ts` ||
							label === `packages${sep}server${sep}src${sep}store-transfer.ts` ||
							label === `packages${sep}server${sep}src${sep}store-transfer-worker.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}worker.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}configuration.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}outer.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}endpoint.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}source-preflight.ts` ||
							label === `packages${sep}server${sep}src${sep}transfer${sep}source-session.ts` ||
							label.startsWith(`packages${sep}server${sep}test${sep}fixtures${sep}`))) ||
					(owner === "ui" && dependency === "server" && !label.startsWith(`packages${sep}ui${sep}src${sep}`));
				if (!allowed)
					failures.push(`${label}: unsupported workspace import: ${specifier}; expected ui launcher -> server -> boot`);
			}
			if (specifier.includes("repos/")) failures.push(`${label}: vendored references must not be imported`);
		}
		// Static ownership guard: interpolation remains opaque; this is not a SQL validator.
		function checkDomainSql(node: ts.Node, text: string) {
			// This exported constant compares catalog text; it never creates an app table.
			// Only its direct literal initializer is exempt, and any local reference fails below.
			if (
				collectTables &&
				transferMetadata &&
				ts.isVariableDeclaration(node.parent) &&
				ts.isIdentifier(node.parent.name) &&
				node.parent.name.text === "sqliteEventsDefinition" &&
				node.parent.initializer === node &&
				ts.isStringLiteral(node)
			)
				return;
			if (!collectTables && !relative(root, path).startsWith(`packages${sep}boot${sep}src${sep}`)) return;
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
				if (
					collectTables &&
					(keyword !== "TABLE" || !words.slice(0, index).some((word) => word.toUpperCase() === "CREATE"))
				)
					continue;
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
				if (collectTables) {
					if (table && table !== "__interpolation__") appTables.add(table);
					continue;
				}
				const bootFile = relative(resolve(packages, "boot/src"), path);
				if (appTables.has(table) && !recoveryAccess[bootFile]?.includes(table)) {
					const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
					failures.push(`${relative(root, path)}:${line}: boot must not know app domain table ${table}`);
				}
			}
		}
		function visit(node: ts.Node) {
			if (
				collectTables &&
				transferMetadata &&
				ts.isIdentifier(node) &&
				node.text === "sqliteEventsDefinition" &&
				!(
					ts.isVariableDeclaration(node.parent) &&
					node.parent.name === node &&
					node.parent.initializer &&
					ts.isStringLiteral(node.parent.initializer)
				)
			)
				failures.push(`${relative(root, path)}: trusted transfer DDL must remain an unreferenced literal definition`);

			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) checkDomainSql(node, node.text);
			if (ts.isTemplateExpression(node))
				checkDomainSql(
					node,
					[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" __interpolation__ "),
				);

			if (collectTables) {
				ts.forEachChild(node, visit);
				return;
			}

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

	function walk(directory: string, collectTables = false) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (["node_modules", "dist"].includes(entry.name)) continue;
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) walk(path, collectTables);
			else if (/\.tsx?$/.test(entry.name)) inspect(path, collectTables);
		}
	}

	walk(resolve(packages, "server/src"), true);
	// The shared app-store initialization schema is boot-owned on the SQLite base branch.
	inspect(resolve(packages, "boot/src/app-recovery.ts"), true);
	walk(packages);
	if (failures.length > 0) {
		console.error(failures.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("Workspace import boundaries passed.");
	}
}

checkInvariants();
