import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	auditSonicSourceDirectory,
	auditSonicSourceRecords,
} from "./sonic-source-isolation.mjs";

test("clean Sonic TypeScript using approved dependencies passes source isolation", () => {
	const violations = auditSonicSourceRecords([
		{
			path: "sonic-clean.ts",
			content: [
				'import { Group } from "three";',
				'import type { FrameContext } from "../runtime/frame-context";',
				"export function createCleanRuntime(frame: FrameContext): Group {",
				"\tvoid frame;",
				"\treturn new Group();",
				"}",
			].join("\n"),
		},
	]);

	expect(violations).toEqual([]);
});

test("Sonic source isolation rejects packages outside the dependency allowlist", () => {
	const violations = auditSonicSourceRecords([
		{
			path: "sonic-vendored.ts",
			content: 'import shaderRuntime from "restricted-shader-runtime";',
		},
	]);

	expect(violations).toEqual([
		{
			path: "sonic-vendored.ts",
			kind: "external-dependency",
			detail: "restricted-shader-runtime",
		},
	]);
});

test("Sonic source isolation rejects external URLs and copied-reference markers", () => {
	const violations = auditSonicSourceRecords([
		{
			path: "sonic-reference.ts",
			content: "// copied from https://example.invalid/reference-shader",
		},
	]);

	expect(violations).toEqual([
		{
			path: "sonic-reference.ts",
			kind: "source-marker",
			detail: "external-url",
		},
		{
			path: "sonic-reference.ts",
			kind: "source-marker",
			detail: "copied-reference",
		},
	]);
});

test("Sonic source isolation rejects copyright and vendored-source markers", () => {
	const violations = auditSonicSourceRecords([
		{
			path: "vendor/sonic-shader.ts",
			content: "/* Copyright 2025 Example Author; third-party shader */",
		},
	]);

	expect(violations).toEqual([
		{
			path: "vendor/sonic-shader.ts",
			kind: "source-marker",
			detail: "copyright",
		},
		{
			path: "vendor/sonic-shader.ts",
			kind: "source-marker",
			detail: "vendored-source",
		},
		{
			path: "vendor/sonic-shader.ts",
			kind: "path-marker",
			detail: "vendor",
		},
	]);
});

test("Sonic source isolation rejects binary files and imported shader or asset payloads", () => {
	const violations = auditSonicSourceRecords([
		{
			path: "sonic-reference.png",
			content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]),
		},
		{
			path: "sonic-loader.ts",
			content: 'import fragmentShader from "./reference.frag?raw";',
		},
	]);

	expect(violations).toEqual([
		{
			path: "sonic-reference.png",
			kind: "file-type",
			detail: ".png",
		},
		{
			path: "sonic-reference.png",
			kind: "binary-content",
			detail: "nul-byte",
		},
		{
			path: "sonic-loader.ts",
			kind: "copied-asset-import",
			detail: "./reference.frag?raw",
		},
	]);
});

test("the checked-in Sonic directory satisfies the executable source-isolation guard", () => {
	expect(auditSonicSourceDirectory()).toEqual([]);
});

test("the Sonic provenance template preserves non-inclusion and exposure warnings", () => {
	const document = readFileSync(
		resolve(import.meta.dir, "../../docs/parity/sonic-clean-room-provenance.md"),
		"utf8",
	);
	const requiredMarkers = [
		"状态：未通过",
		"Non-inclusion",
		"既有 exposure 风险",
		"不能消除",
		"可观察证据",
		"实现者声明",
		"审查 commit",
		"node scripts/architecture/sonic-source-isolation.mjs",
	];

	expect(requiredMarkers.filter((marker) => !document.includes(marker))).toEqual([]);
});
