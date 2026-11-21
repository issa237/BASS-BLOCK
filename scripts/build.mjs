// Bundles main, preloads, CLI and host UI with esbuild, and vendors three.js into the 3D template.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "renderer"), { recursive: true });

const node = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], sourcemap: "linked", logLevel: "warning" };

await Promise.all([
  build({ ...node, entryPoints: [path.join(root, "src/main/main.ts")], outfile: path.join(dist, "main.js") }),
  build({ ...node, entryPoints: [path.join(root, "src/preload/host.ts")], outfile: path.join(dist, "preload-host.js"), sourcemap: false }),
  build({ ...node, entryPoints: [path.join(root, "src/preload/block.ts")], outfile: path.join(dist, "preload-block.js"), sourcemap: false }),
  build({ ...node, entryPoints: [path.join(root, "src/cli/bassblock.ts")], outfile: path.join(dist, "cli.js"), banner: { js: "#!/usr/bin/env node" } }),
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    entryPoints: [path.join(root, "src/renderer/app.ts")],
    outfile: path.join(dist, "renderer", "app.js"),
    sourcemap: "linked",
    logLevel: "warning",
  }),
]);
fs.chmodSync(path.join(dist, "cli.js"), 0o755);
for (const f of ["index.html", "styles.css"]) fs.copyFileSync(path.join(root, "src/renderer", f), path.join(dist, "renderer", f));

// Vendor a single minified ESM build of three.js for the 3D template (blocks can't load from a CDN).
const threeOut = path.join(root, "templates/three-viewer/vendor/three.min.js");
if (!fs.existsSync(threeOut)) {
  await build({
    stdin: { contents: "export * from 'three';", resolveDir: root, loader: "js" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "chrome130",
    outfile: threeOut,
    legalComments: "inline",
    logLevel: "warning",
  });
}
console.log("built →", path.relative(process.cwd(), dist));
