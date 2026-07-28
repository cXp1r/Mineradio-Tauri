import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	runConvergenceBaselineCli,
} from "./convergence-baseline.mjs";

const repositoryRoot = resolve(import.meta.dir, "../..");
const visualEngineSourceRoot = resolve(repositoryRoot, "packages/visual-engine/src");
const visualEngineRequire = createRequire(
	resolve(repositoryRoot, "packages/visual-engine/package.json"),
);
const ts: typeof import("typescript") = visualEngineRequire("typescript");

interface ModuleReference {
	readonly specifier: string;
	readonly node: import("typescript").Node;
}

function createSourceFile(relativePath: string): import("typescript").SourceFile {
	const absolutePath = resolve(repositoryRoot, relativePath);
	return createFixtureSourceFile(readFileSync(absolutePath, "utf8"), absolutePath);
}

function createFixtureSourceFile(
	source: string,
	fileName = "boundary-fixture.ts",
): import("typescript").SourceFile {
	return ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

function listSourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const absolutePath = resolve(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") files.push(...listSourceFiles(absolutePath));
			continue;
		}
		if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
		if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
		files.push(absolutePath);
	}
	return files.sort();
}

function collectModuleReferences(
	sourceFile: import("typescript").SourceFile,
): ModuleReference[] {
	const references: ModuleReference[] = [];
	const visit = (node: import("typescript").Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			&& node.moduleSpecifier
			&& ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			references.push({ specifier: node.moduleSpecifier.text, node });
		} else if (
			ts.isCallExpression(node)
			&& node.expression.kind === ts.SyntaxKind.ImportKeyword
			&& node.arguments.length === 1
			&& ts.isStringLiteralLike(node.arguments[0])
		) {
			references.push({ specifier: node.arguments[0].text, node });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return references;
}

function collectCallExpressions(
	sourceFile: import("typescript").SourceFile,
): import("typescript").CallExpression[] {
	const calls: import("typescript").CallExpression[] = [];
	const visit = (node: import("typescript").Node): void => {
		if (ts.isCallExpression(node)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return calls;
}

function formatReference(
	sourceFile: import("typescript").SourceFile,
	reference: ModuleReference,
): string {
	const position = sourceFile.getLineAndCharacterOfPosition(reference.node.getStart(sourceFile));
	return `${relative(repositoryRoot, sourceFile.fileName)}:${position.line + 1} -> ${reference.specifier}`;
}

function isForbiddenVisualEngineDependency(specifier: string): boolean {
	return specifier === "react"
		|| specifier.startsWith("react/")
		|| specifier === "react-dom"
		|| specifier.startsWith("react-dom/")
		|| specifier === "zustand"
		|| specifier.startsWith("zustand/")
		|| specifier.startsWith("@tauri-apps/")
		|| specifier === "@mineradio/shared"
		|| specifier.startsWith("@mineradio/");
}

function relativeImportEscapesRoot(importer: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const target = resolve(dirname(importer), specifier);
	const targetRelativeToRoot = relative(visualEngineSourceRoot, target);
	return targetRelativeToRoot === ".."
		|| targetRelativeToRoot.startsWith(`..${sep}`)
		|| isAbsolute(targetRelativeToRoot);
}

function importedLocalName(
	sourceFile: import("typescript").SourceFile,
	moduleSpecifier: string,
	importedName: string,
): string | null {
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text !== moduleSpecifier) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			if ((element.propertyName?.text ?? element.name.text) === importedName) {
				return element.name.text;
			}
		}
	}
	return null;
}

function isNamedCall(
	call: import("typescript").CallExpression,
	name: string,
): boolean {
	if (ts.isIdentifier(call.expression)) return call.expression.text === name;
	if (ts.isPropertyAccessExpression(call.expression)) {
		return call.expression.name.text === name;
	}
	return ts.isElementAccessExpression(call.expression)
		&& ts.isStringLiteralLike(call.expression.argumentExpression)
		&& call.expression.argumentExpression.text === name;
}

function isPropertyAccess(
	node: import("typescript").Expression,
	objectName: string,
	propertyName: string,
): boolean {
	return ts.isPropertyAccessExpression(node)
		&& ts.isIdentifier(node.expression)
		&& node.expression.text === objectName
		&& node.name.text === propertyName;
}

function collectHostForbiddenImportReferences(
	sourceFile: import("typescript").SourceFile,
): ModuleReference[] {
	const violations = collectModuleReferences(sourceFile).filter(({ specifier }) => {
		return specifier === "three"
			|| specifier.startsWith("three/")
			|| specifier === "gsap"
			|| specifier.startsWith("gsap/")
			|| specifier.startsWith("@mineradio/visual-engine/")
			|| /(?:^|\/)(?:renderer-setup|render-loop|render-step-slot)(?:$|[./])/.test(specifier);
	});
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text !== "@mineradio/visual-engine") continue;
		const importClause = statement.importClause;
		if (importClause?.isTypeOnly) continue;
		const hasDefaultValueImport = importClause?.name !== undefined;
		const bindings = importClause?.namedBindings;
		const hasNamespaceValueImport = bindings !== undefined && ts.isNamespaceImport(bindings);
		const hasNamedValueImport = bindings !== undefined
			&& ts.isNamedImports(bindings)
			&& bindings.elements.some((element) => !element.isTypeOnly);
		if (!importClause || hasDefaultValueImport || hasNamespaceValueImport || hasNamedValueImport) {
			violations.push({ specifier: statement.moduleSpecifier.text, node: statement });
		}
	}
	return violations;
}

function collectHookForbiddenImports(
	sourceFile: import("typescript").SourceFile,
): string[] {
	const violations: string[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
		if (statement.moduleSpecifier.text !== "@mineradio/visual-engine") continue;
		const importClause = statement.importClause;
		if (importClause?.isTypeOnly) continue;
		if (!importClause) {
			violations.push("root-package side-effect import");
			continue;
		}
		if (importClause.name) violations.push(`root-package default import:${importClause.name.text}`);
		const bindings = importClause.namedBindings;
		if (!bindings) continue;
		if (ts.isNamespaceImport(bindings)) {
			violations.push(`root-package namespace import:${bindings.name.text}`);
			continue;
		}
		for (const element of bindings.elements) {
			if (element.isTypeOnly) continue;
			const importedName = element.propertyName?.text ?? element.name.text;
			if (importedName !== "createVisualEngine") {
				violations.push(`root-package value import:${importedName}`);
			}
		}
	}
	for (const reference of collectModuleReferences(sourceFile)) {
		if (
			/(?:^|\/)(?:renderer-setup|render-loop)(?:$|[./])/.test(reference.specifier)
			|| /(?:^|\/)(?:home-visual|particles|shelf|stage-lyrics)(?:\/|$)/.test(reference.specifier)
		) {
			violations.push(formatReference(sourceFile, reference));
		}
	}
	return violations;
}

function isDeclarationOrMemberName(node: import("typescript").Identifier): boolean {
	const parent = node.parent;
	if (!("name" in parent) || parent.name !== node) return false;
	return ts.isBindingElement(parent)
		|| ts.isClassDeclaration(parent)
		|| ts.isClassExpression(parent)
		|| ts.isEnumDeclaration(parent)
		|| ts.isEnumMember(parent)
		|| ts.isFunctionDeclaration(parent)
		|| ts.isFunctionExpression(parent)
		|| ts.isInterfaceDeclaration(parent)
		|| ts.isMethodDeclaration(parent)
		|| ts.isMethodSignature(parent)
		|| ts.isParameter(parent)
		|| ts.isPropertyAssignment(parent)
		|| ts.isPropertyDeclaration(parent)
		|| ts.isPropertySignature(parent)
		|| ts.isShorthandPropertyAssignment(parent)
		|| ts.isTypeAliasDeclaration(parent)
		|| ts.isTypeParameterDeclaration(parent)
		|| ts.isVariableDeclaration(parent)
		|| ts.isGetAccessorDeclaration(parent)
		|| ts.isSetAccessorDeclaration(parent);
}

function isContractCouplingName(name: string): boolean {
	const normalized = name.toLowerCase();
	return normalized.includes("route")
		|| normalized.includes("endpoint")
		|| normalized.includes("baseurl")
		|| normalized.includes("apiurl")
		|| normalized.includes("httpurl")
		|| (normalized.includes("sidecar") && normalized.includes("url"));
}

function isHttpUrlOrApiRoute(value: string): boolean {
	return /https?:\/\//i.test(value) || /\/api(?:\/|$)/i.test(value);
}

function collectContractCouplingViolations(
	sourceFile: import("typescript").SourceFile,
): string[] {
	const violations: string[] = [];
	const visit = (node: import("typescript").Node): void => {
		if (
			ts.isIdentifier(node)
			&& (
				node.text === "ProviderId"
				|| node.text === "sidecarBaseUrl"
				|| (isDeclarationOrMemberName(node) && isContractCouplingName(node.text))
			)
		) {
			violations.push(`identifier:${node.text}`);
		}
		if (
			ts.isStringLiteralLike(node)
			&& isHttpUrlOrApiRoute(node.text)
		) {
			violations.push(`literal:${node.text}`);
		}
		if (
			(ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
			&& isHttpUrlOrApiRoute(node.text)
		) {
			violations.push(`template:${node.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return violations;
}

test("visual-engine package source stays framework and application independent", () => {
	const violations: string[] = [];
	for (const absolutePath of listSourceFiles(visualEngineSourceRoot)) {
		const sourceFile = ts.createSourceFile(
			absolutePath,
			readFileSync(absolutePath, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		for (const reference of collectModuleReferences(sourceFile)) {
			if (
				isForbiddenVisualEngineDependency(reference.specifier)
				|| relativeImportEscapesRoot(absolutePath, reference.specifier)
			) {
				violations.push(formatReference(sourceFile, reference));
			}
		}
	}

	expect(violations).toEqual([]);
});

test("VisualEngineHost delegates facade lifecycle to useVisualEngine", () => {
	const sourceFile = createSourceFile("apps/web/src/visual/VisualEngineHost.tsx");
	const useVisualEngineLocalName = importedLocalName(
		sourceFile,
		"./useVisualEngine",
		"useVisualEngine",
	);
	const forbiddenReferences = collectHostForbiddenImportReferences(sourceFile);

	expect(useVisualEngineLocalName).not.toBeNull();
	expect(
		collectCallExpressions(sourceFile).some((call) => (
			useVisualEngineLocalName !== null
			&& ts.isIdentifier(call.expression)
			&& call.expression.text === useVisualEngineLocalName
		)),
	).toBe(true);
	expect(forbiddenReferences.map((reference) => formatReference(sourceFile, reference))).toEqual([]);
});

test("VisualEngineHost root package imports stay type-only", () => {
	const typeOnlyFixture = createFixtureSourceFile([
		'import type { FxState } from "@mineradio/visual-engine";',
		'import { type ShelfItem as VisualShelfItem } from "@mineradio/visual-engine";',
	].join("\n"));
	const valueLeafFixture = createFixtureSourceFile(
		'import { createHomeVisual } from "@mineradio/visual-engine";',
	);

	expect(collectHostForbiddenImportReferences(typeOnlyFixture)).toEqual([]);
	expect(collectHostForbiddenImportReferences(valueLeafFixture)).not.toEqual([]);
});

test("useVisualEngine binds the root facade and remains a thin lifecycle adapter", () => {
	const sourceFile = createSourceFile("apps/web/src/visual/useVisualEngine.ts");
	const references = collectModuleReferences(sourceFile);
	const calls = collectCallExpressions(sourceFile);
	const createVisualEngineLocalName = importedLocalName(
		sourceFile,
		"@mineradio/visual-engine",
		"createVisualEngine",
	);
	const forbiddenImports = collectHookForbiddenImports(sourceFile);
	let hasProductionDefaultChain = false;
	const visit = (node: import("typescript").Node): void => {
		if (
			ts.isBinaryExpression(node)
			&& node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
			&& isPropertyAccess(node.left, "dependencies", "createFacade")
			&& createVisualEngineLocalName !== null
			&& ts.isIdentifier(node.right)
			&& node.right.text === createVisualEngineLocalName
		) {
			hasProductionDefaultChain = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	expect(createVisualEngineLocalName).not.toBeNull();
	expect(hasProductionDefaultChain).toBe(true);
	expect(calls.some((call) => isPropertyAccess(call.expression, "resolved", "createFacade"))).toBe(true);
	expect(calls.filter((call) => isNamedCall(call, "registerStep"))).toEqual([]);
	expect(forbiddenImports).toEqual([]);
	expect(
		references.some(({ specifier }) => specifier === "./runtime/create-legacy-visual-composition"),
	).toBe(true);
});

test("useVisualEngine root package rejects namespace and default value imports", () => {
	const allowedFixture = createFixtureSourceFile([
		'import { createVisualEngine as createFacade, type VisualEngineFacade } from "@mineradio/visual-engine";',
		'import type VisualEngineTypes from "@mineradio/visual-engine";',
	].join("\n"));
	const namespaceFixture = createFixtureSourceFile(
		'import * as visual from "@mineradio/visual-engine";',
	);
	const defaultFixture = createFixtureSourceFile(
		'import visualEngine from "@mineradio/visual-engine";',
	);
	const namedLeafFixture = createFixtureSourceFile(
		'import { createHomeVisual } from "@mineradio/visual-engine";',
	);
	const leafSubpathFixture = createFixtureSourceFile(
		'import type { HomeVisual } from "@mineradio/visual-engine/home-visual/home-visual";',
	);

	expect(collectHookForbiddenImports(allowedFixture)).toEqual([]);
	expect(collectHookForbiddenImports(namespaceFixture)).not.toEqual([]);
	expect(collectHookForbiddenImports(defaultFixture)).not.toEqual([]);
	expect(collectHookForbiddenImports(namedLeafFixture)).not.toEqual([]);
	expect(collectHookForbiddenImports(leafSubpathFixture)).not.toEqual([]);
});

test("visual engine contract contains no provider, Sidecar, URL, or route coupling", () => {
	const sourceFile = createSourceFile(
		"packages/visual-engine/src/runtime/visual-engine-contract.ts",
	);

	expect(collectContractCouplingViolations(sourceFile)).toEqual([]);
});

test("visual engine contract rejects route, endpoint, URL names and template routes", () => {
	const fixture = createFixtureSourceFile([
		"interface LeakyContract {",
		"\treadonly apiRoute: string;",
		"\treadonly httpEndpoint: string;",
		"\treadonly mediaBaseUrl: string;",
		"\treadonly apiUrl: string;",
		"\treadonly httpUrl: string;",
		"\treadonly visualSidecarUrl: string;",
		"}",
		"const endpoint = `https://${host}/api/visual`;",
		'const remoteOrigin = "http://localhost:3000";',
		'const apiPath = "/api/visual";',
	].join("\n"));
	const violations = collectContractCouplingViolations(fixture);
	const safeFixture = createFixtureSourceFile([
		'export type VisualRuntimeMode = "foreground" | "background";',
		"export interface VisualRuntimeState {",
		"\treadonly runtimeMode: VisualRuntimeMode;",
		"}",
	].join("\n"));

	expect(violations).toContain("identifier:apiRoute");
	expect(violations).toContain("identifier:httpEndpoint");
	expect(violations).toContain("identifier:mediaBaseUrl");
	expect(violations).toContain("identifier:apiUrl");
	expect(violations).toContain("identifier:httpUrl");
	expect(violations).toContain("identifier:visualSidecarUrl");
	expect(violations).toContain("template:https://");
	expect(violations).toContain("template:/api/visual");
	expect(violations).toContain("literal:http://localhost:3000");
	expect(violations).toContain("literal:/api/visual");
	expect(collectContractCouplingViolations(safeFixture)).toEqual([]);
});

test("real parity documents retain the frozen convergence API markers", async () => {
	const result = await runConvergenceBaselineCli(repositoryRoot);
	expect(result.errors).toEqual([]);
});
