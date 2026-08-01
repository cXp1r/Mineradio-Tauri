#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { evaluateM7Evidence } from "./evidence-model.mjs";

export function verifyM7EvidenceFile(filePath) {
	const evidence = JSON.parse(readFileSync(filePath, "utf8"));
	return { evidence, evaluation: evaluateM7Evidence(evidence) };
}

function main() {
	const file = process.argv[2];
	if (!file || process.argv.length !== 3) {
		throw new Error("用法: node scripts/parity/m7/verify-evidence.mjs <manifest.json>");
	}
	const { evaluation } = verifyM7EvidenceFile(path.resolve(file));
	for (const gate of evaluation.gates) {
		console.log(`[m7-evidence] ${gate.passed ? "PASS" : "FAIL"} ${gate.id}`);
	}
	if (!evaluation.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(`[m7-evidence] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
