// Run after `pnpm build`. Includes unique app component chunks, not Next/React
// framework chunks or separately loaded async chunks.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

const results = [];
for (const route of [
  "login",
  "admin/dashboard",
  "admin/reports",
  "employee/dashboard",
  "employee/profile",
]) {
  const context = { globalThis: {} };
  runInNewContext(
    readFileSync(
      `.next/server/app/${route}/page_client-reference-manifest.js`,
      "utf8",
    ),
    context,
  );
  const manifest = Object.values(context.globalThis.__RSC_MANIFEST)[0];
  const chunks = new Set(
    Object.entries(manifest.clientModules)
      .filter(([name]) => name.includes("src/components/"))
      .flatMap(([, module]) => module.chunks),
  );
  let raw = 0,
    gzip = 0;
  for (const chunk of chunks) {
    const bytes = readFileSync(`.next/${chunk.replace(/^\/_next\//, "")}`);
    raw += bytes.length;
    gzip += gzipSync(bytes).length;
  }
  results.push({ route: `/${route}`, raw, gzip });
}
console.log(JSON.stringify(results, null, 2));
