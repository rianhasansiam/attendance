import { cp, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const buildDir = join(projectDir, ".next");
const standaloneDir = join(buildDir, "standalone");
const runtimeBuildDir = join(standaloneDir, ".next");
const publicDir = join(projectDir, "public");
const staticDir = join(buildDir, "static");

// Check the complete build before replacing either runtime asset directory.
const [buildId, standaloneBuildId, server, staticAssets, publicAssets] =
  await Promise.all([
    readFile(join(buildDir, "BUILD_ID"), "utf8"),
    readFile(join(runtimeBuildDir, "BUILD_ID"), "utf8"),
    stat(join(standaloneDir, "server.js")),
    stat(staticDir),
    stat(publicDir),
  ]);

if (
  !buildId.trim() ||
  buildId !== standaloneBuildId ||
  !server.isFile() ||
  !staticAssets.isDirectory() ||
  !publicAssets.isDirectory()
) {
  throw new Error(
    "Run a successful standalone Next.js build before packaging.",
  );
}

for (const [source, destination] of [
  [staticDir, join(runtimeBuildDir, "static")],
  [publicDir, join(standaloneDir, "public")],
]) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}

console.log(
  `Prepared standalone assets in ${relative(projectDir, standaloneDir)}`,
);
