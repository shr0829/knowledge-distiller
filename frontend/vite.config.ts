import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(folder, entry.name))
      : [join(folder, entry.name)],
  ).sort();
}
const buildId = createHash("sha256").update(
  Buffer.concat(sourceFiles("src").map((file) =>
    Buffer.concat([Buffer.from(file), readFileSync(file)]))),
).digest("hex").slice(0, 12);
writeFileSync("build-info.json", JSON.stringify({ build_id: buildId }));

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "mcp" ? [viteSingleFile()] : [])],
  define: { __LIBRARY_MCP_APP__: JSON.stringify(mode === "mcp"),
            __LIBRARY_BUILD_ID__: JSON.stringify(buildId) },
  build: { outDir: mode === "mcp" ? "dist-mcp" : "dist" },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8765" } },
}));
