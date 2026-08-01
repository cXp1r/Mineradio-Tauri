import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runConvergenceBaselineCli } from "./convergence-baseline.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const result = await runConvergenceBaselineCli(repositoryRoot);
if (result.errors.length > 0) {
	for (const error of result.errors) console.error(error);
	process.exitCode = 1;
} else {
	for (const relativePath of result.paths) console.log(`verified: ${relativePath}`);
}
