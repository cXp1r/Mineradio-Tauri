#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { evaluateM6Evidence } from "./evidence-model.mjs";

export function verifyM6EvidenceFile(filePath) {
	const evidence = JSON.parse(readFileSync(filePath, "utf8"));
	const evaluation = evaluateM6Evidence(evidence);
	return { evidence, evaluation };
}

function main() {
	const value = process.argv[2];
	if (!value || process.argv.length !== 3) {
		throw new Error("用法: node scripts/parity/m6/verify-evidence.mjs <manifest.json>");
	}
	const filePath = path.resolve(value);
	const { evaluation } = verifyM6EvidenceFile(filePath);
	for (const gate of evaluation.gates) console.log(`[m6-evidence] ${gate.passed ? "PASS" : "FAIL"} ${gate.id}`);
	if (!evaluation.passed) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	try { main(); } catch (error) { console.error(`[m6-evidence] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
