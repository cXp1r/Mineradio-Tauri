import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDirectory, "../..");
const visualEngineRequire = createRequire(
	resolve(repositoryRoot, "packages/visual-engine/package.json"),
);
const ts = visualEngineRequire("typescript");
export const DEFAULT_SONIC_SOURCE_ROOT = resolve(
	repositoryRoot,
	"packages/visual-engine/src/sonic-topography",
);

const APPROVED_EXTERNAL_DEPENDENCIES = new Set(["bun:test", "three"]);
const APPROVED_SOURCE_EXTENSIONS = new Set([".ts"]);
const FORBIDDEN_ASSET_EXTENSIONS = new Set([
	".bin",
	".fbx",
	".frag",
	".gif",
	".glb",
	".glsl",
	".gltf",
	".hdr",
	".jpeg",
	".jpg",
	".ktx2",
	".mp3",
	".obj",
	".png",
	".svg",
	".vert",
	".wasm",
	".wav",
	".webp",
]);
const SOURCE_MARKERS = [
	{
		detail: "external-url",
		pattern: /(?:https?:\/\/|www\.|git(?:hub|lab)\.com)/iu,
	},
	{
		detail: "copied-reference",
		pattern: /(?:copied|ported|derived)\s+from|based\s+on\s+(?:source|shader|asset|implementation)|reference\s+(?:source|implementation)|upstream\s+(?:source|shader)|复制自|移植自|派生自|参考源码|参考实现|上游源码|上游着色器/iu,
	},
	{
		detail: "copyright",
		pattern: /(?:copyright|©|\(c\)\s*20\d{2})/iu,
	},
	{
		detail: "vendored-source",
		pattern: /(?:\bvendored?\b|\bthird[- ]party\b|第三方(?:源码|着色器|资产|代码))/iu,
	},
];
const PATH_MARKERS = [
	{
		detail: "vendor",
		pattern: /(?:^|[\\/])(?:vendor|vendored|third[-_ ]party|reference[-_ ]source|upstream[-_ ]source|copied)(?:[\\/]|$)/iu,
	},
];

function isRelativeModuleSpecifier(specifier) {
	return specifier.startsWith(".");
}

function packageRoot(specifier) {
	if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
	return specifier.split("/", 1)[0];
}

function importedAssetExtension(specifier) {
	const cleanSpecifier = specifier.split(/[?#]/u, 1)[0];
	return extname(cleanSpecifier).toLowerCase();
}

function collectModuleSpecifiers(path, source) {
	const sourceFile = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const specifiers = [];
	const addStringLiteral = (node) => {
		if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			addStringLiteral(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node)
			&& (
				node.expression.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(node.expression) && node.expression.text === "require")
			)
		) {
			addStringLiteral(node.arguments[0]);
		} else if (
			ts.isImportEqualsDeclaration(node)
			&& ts.isExternalModuleReference(node.moduleReference)
		) {
			addStringLiteral(node.moduleReference.expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
}

export function auditSonicSourceRecords(records) {
	const violations = [];
	for (const record of records) {
		const sourceExtension = extname(record.path).toLowerCase();
		if (!APPROVED_SOURCE_EXTENSIONS.has(sourceExtension)) {
			violations.push({
				path: record.path,
				kind: "file-type",
				detail: sourceExtension || "none",
			});
		}
		const containsNul = typeof record.content === "string"
			? record.content.includes("\0")
			: record.content.includes(0);
		if (containsNul) {
			violations.push({
				path: record.path,
				kind: "binary-content",
				detail: "nul-byte",
			});
		}
		const source = typeof record.content === "string"
			? record.content
			: new TextDecoder().decode(record.content);
		for (const marker of SOURCE_MARKERS) {
			if (!marker.pattern.test(source)) continue;
			violations.push({
				path: record.path,
				kind: "source-marker",
				detail: marker.detail,
			});
		}
		for (const marker of PATH_MARKERS) {
			if (!marker.pattern.test(record.path)) continue;
			violations.push({
				path: record.path,
				kind: "path-marker",
				detail: marker.detail,
			});
		}
		for (const specifier of collectModuleSpecifiers(record.path, source)) {
			if (isRelativeModuleSpecifier(specifier)) {
				if (FORBIDDEN_ASSET_EXTENSIONS.has(importedAssetExtension(specifier))) {
					violations.push({
						path: record.path,
						kind: "copied-asset-import",
						detail: specifier,
					});
				}
				continue;
			}
			const dependency = packageRoot(specifier);
			if (APPROVED_EXTERNAL_DEPENDENCIES.has(dependency)) continue;
			violations.push({
				path: record.path,
				kind: "external-dependency",
				detail: specifier,
			});
		}
	}
	return violations;
}

function collectDirectoryRecords(root, current = root) {
	const records = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const absolutePath = resolve(current, entry.name);
		if (entry.isDirectory()) {
			records.push(...collectDirectoryRecords(root, absolutePath));
			continue;
		}
		if (!entry.isFile()) continue;
		records.push({
			path: relative(root, absolutePath).replaceAll("\\", "/"),
			content: readFileSync(absolutePath),
		});
	}
	return records.sort((left, right) => left.path.localeCompare(right.path));
}

export function auditSonicSourceDirectory(root = DEFAULT_SONIC_SOURCE_ROOT) {
	return auditSonicSourceRecords(collectDirectoryRecords(root));
}

function runCli() {
	const requestedRoot = process.argv[2]
		? resolve(process.cwd(), process.argv[2])
		: DEFAULT_SONIC_SOURCE_ROOT;
	const violations = auditSonicSourceDirectory(requestedRoot);
	if (violations.length === 0) {
		console.log(`[sonic-source-isolation] PASS ${requestedRoot}`);
		return;
	}
	console.error(`[sonic-source-isolation] FAIL ${violations.length} violation(s)`);
	for (const violation of violations) {
		console.error(`- ${violation.path}: ${violation.kind} (${violation.detail})`);
	}
	process.exitCode = 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();
