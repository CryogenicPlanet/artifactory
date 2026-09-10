import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript-parser";

const root = resolve(import.meta.dirname, "..");
const packages = resolve(root, "packages");
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
			if (workspace(target) !== owner) failures.push(`${label}: relative import leaves package: ${specifier}`);
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
	function visit(node: ts.Node) {
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
