import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

function resolveBuildCommit(): string {
  const override = process.env.MINERADIO_BUILD_COMMIT?.trim();
  if (override) return override;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unversioned";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __MINERADIO_BUILD_COMMIT__: JSON.stringify(resolveBuildCommit())
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
