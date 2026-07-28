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
	return ts.createSourceFile(
		absolutePath,
		readFileSync(absolutePath, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
	const references = collectModuleReferences(sourceFile);
	const useVisualEngineLocalName = importedLocalName(
		sourceFile,
		"./useVisualEngine",
		"useVisualEngine",
	);
	const forbiddenReferences = references.filter(({ specifier }) => {
		return specifier === "three"
			|| specifier.startsWith("three/")
			|| specifier === "gsap"
			|| specifier.startsWith("gsap/")
			|| specifier.startsWith("@mineradio/visual-engine/")
			|| /(?:^|\/)(?:renderer-setup|render-loop|render-step-slot)(?:$|[./])/.test(specifier);
	});

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

test("useVisualEngine binds the root facade and remains a thin lifecycle adapter", () => {
	const sourceFile = createSourceFile("apps/web/src/visual/useVisualEngine.ts");
	const references = collectModuleReferences(sourceFile);
	const calls = collectCallExpressions(sourceFile);
	const createVisualEngineLocalName = importedLocalName(
		sourceFile,
		"@mineradio/visual-engine",
		"createVisualEngine",
	);
	const forbiddenFactoryImports = new Set([
		"createBackCoverLayer",
		"createConnectorParticles",
		"createHomeParticleField",
		"createHomeRipples",
		"createHomeVisual",
		"createLyricParticles",
		"createRenderer",
		"createRenderLoop",
		"createShelfManager",
		"createShelfManagerWithThree",
		"createShelfStep",
		"createStageLyricsLifecycle",
	]);
	const importedForbiddenFactories: string[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const element of bindings.elements) {
			const importedName = element.propertyName?.text ?? element.name.text;
			if (forbiddenFactoryImports.has(importedName)) importedForbiddenFactories.push(importedName);
		}
	}
	const forbiddenReferences = references.filter(({ specifier }) => (
		/(?:^|\/)(?:renderer-setup|render-loop)(?:$|[./])/.test(specifier)
		|| /(?:^|\/)(?:home-visual|particles|shelf|stage-lyrics)(?:\/|$)/.test(specifier)
	));
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
	expect(importedForbiddenFactories).toEqual([]);
	expect(forbiddenReferences.map((reference) => formatReference(sourceFile, reference))).toEqual([]);
	expect(
		references.some(({ specifier }) => specifier === "./runtime/create-legacy-visual-composition"),
	).toBe(true);
});

test("visual engine contract contains no provider, Sidecar, URL, or route coupling", () => {
	const sourceFile = createSourceFile(
		"packages/visual-engine/src/runtime/visual-engine-contract.ts",
	);
	const forbiddenIdentifiers: string[] = [];
	const forbiddenStrings: string[] = [];
	const visit = (node: import("typescript").Node): void => {
		if (
			ts.isIdentifier(node)
			&& (node.text === "ProviderId" || node.text === "sidecarBaseUrl")
		) {
			forbiddenIdentifiers.push(node.text);
		}
		if (
			ts.isStringLiteralLike(node)
			&& (/^https?:\/\//i.test(node.text) || /^\/[A-Za-z0-9]/.test(node.text))
		) {
			forbiddenStrings.push(node.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	expect(forbiddenIdentifiers).toEqual([]);
	expect(forbiddenStrings).toEqual([]);
});

test("real parity documents retain the frozen convergence API markers", async () => {
	const result = await runConvergenceBaselineCli(repositoryRoot);
	expect(result.errors).toEqual([]);
});
