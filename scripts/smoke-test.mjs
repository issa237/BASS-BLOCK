// End-to-end smoke test in a throwaway BASSBLOCK_HOME:
//   all 6 templates (including polyglot Python & compiled Swift) create + validate,
//   TypeScript (.ts) block scripts work natively, <a href="https://..."> links pass staticCheck,
//   broken blocks are rejected, and multi-step AI undo + snapshot restore never touch data/.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const electron = require("electron");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-smoke-"));
const env = { ...process.env, BASSBLOCK_HOME: home, ELECTRON_RUN_AS_NODE: "1", BB_ELECTRON: electron };
const cli = (...args) => spawnSync(electron, [path.join(root, "dist/cli.js"), ...args], { env, encoding: "utf8" });

let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${extra}`}`);
  if (!ok) failed++;
};

// 1. Runtimes detection
const rtOut = cli("runtimes", "--json");
const runtimes = JSON.parse(rtOut.stdout || "[]");
check("detects local language runtimes", rtOut.status === 0 && Array.isArray(runtimes) && runtimes.some((r) => r.id === "python" && r.path));

// 2. All 6 templates (web + polyglot Python + polyglot compiled Swift)
for (const t of ["blank", "text-tool", "image-tool", "three-viewer", "python-tool", "swift-tool"]) {
  const c = cli("create", `s-${t}`, "--template", t);
  check(`create ${t}`, c.status === 0, c.stderr);
  const v = cli("validate", `s-${t}`, "--json");
  const r = JSON.parse(v.stdout || "{}");
  check(`validate ${t}`, v.status === 0 && r.ok, JSON.stringify(r.problems));
}

// 2b. Two concurrent backend calls at startup (while backend is compiling/starting) both succeed
const swiftCode = path.join(home, "blocks/s-swift-tool/code");
fs.rmSync(path.join(swiftCode, ".bin"), { recursive: true, force: true });
fs.writeFileSync(
  path.join(swiftCode, "main.js"),
  'const [a, b] = await Promise.all([bb.backend.call("info"), bb.backend.call("compute", { text: "parallel", limit: 5000 })]);\nif (!a?.cores || !b?.sha256) throw new Error("concurrent calls failed");\ndocument.getElementById("raw").textContent = b.sha256;\nbb.ready();\n',
);
const parV = cli("validate", "s-swift-tool", "--json");
const parR = JSON.parse(parV.stdout || "{}");
check("concurrent startup backend calls both succeed", parV.status === 0 && parR.ok, JSON.stringify(parR.problems));

// 3. Native TypeScript (.ts) script + <a href="https://..."> external link allowed in staticCheck
cli("create", "s-ts-link", "--template", "blank");
const tsDir = path.join(home, "blocks/s-ts-link/code");
fs.writeFileSync(
  path.join(tsDir, "index.html"),
  '<!doctype html><title>TS Block</title><body><h1 id="msg">Loading</h1><a href="https://example.com">Docs</a><script type="module" src="main.ts"></script></body>',
);
fs.writeFileSync(
  path.join(tsDir, "main.ts"),
  'interface Greeting { text: string; url: string }\nconst g: Greeting = { text: "TypeScript Ready", url: "https://example.com" };\ndocument.getElementById("msg")!.textContent = g.text;\n(window as any).bb.ready();\n',
);
fs.unlinkSync(path.join(tsDir, "main.js"));
const tsv = cli("validate", "s-ts-link", "--json");
const tsr = JSON.parse(tsv.stdout || "{}");
check("TypeScript (.ts) script & <a href='https://...'> pass validation", tsv.status === 0 && tsr.ok, JSON.stringify(tsr.problems));

// 4. Broken block must fail with actionable problems
cli("create", "s-broken", "--template", "blank");
const bd = path.join(home, "blocks/s-broken/code");
fs.writeFileSync(path.join(bd, "main.js"), "nope();\n");
fs.writeFileSync(path.join(bd, "index.html"), '<!doctype html><title>x</title><body onclick="x()"><script type="module" src="main.js"></script></body>');
const bv = cli("validate", "s-broken", "--json");
const br = JSON.parse(bv.stdout || "{}");
check("broken block fails", bv.status === 1 && !br.ok);
check("reports runtime error", br.problems?.some((p) => /nope is not defined/.test(p.message)), JSON.stringify(br.problems));
check("reports inline handler", br.problems?.some((p) => /Inline event handler/.test(p.message)));
check("reports empty render", br.problems?.some((p) => p.step === "render"));

// 5. Bad manifest
fs.writeFileSync(
  path.join(bd, "block.json"),
  JSON.stringify({ schema: 1, id: "s-broken", name: "x", version: "1", mode: "native", sdk: "^1.0", entry: { ui: "index.html" } }),
);
const mv = JSON.parse(cli("validate", "s-broken", "--json").stdout || "{}");
check(
  "schema errors reported",
  mv.problems?.some((p) => p.step === "manifest" && /mode/.test(p.message)) && mv.problems?.some((p) => /version/.test(p.message)),
  JSON.stringify(mv.problems),
);

// 6. History: multi-step AI undo + explicit snapshot restore; data/ survives
const lib = path.join(home, "lib.cjs");
await build({ entryPoints: [path.join(root, "src/shared/blocks.ts")], bundle: true, platform: "node", format: "cjs", outfile: lib, logLevel: "silent" });
process.env.BASSBLOCK_HOME = home;
const { history, describePermissions, readManifest } = require(lib);
history.snapshot("s-swift-tool", "After Swift build");
const trackedSwiftFiles = spawnSync("git", ["ls-files"], { cwd: swiftCode, encoding: "utf8" }).stdout || "";
check(".bin/ binaries excluded from block git history", !trackedSwiftFiles.split("\n").some((f) => f.startsWith(".bin/")));
const swiftPerms = describePermissions(readManifest(swiftCode).manifest);
check("polyglot permission prompt warns about full Mac access", swiftPerms.some((p) => /full access/i.test(p)), JSON.stringify(swiftPerms));
const id = "s-text-tool";
const code = path.join(home, "blocks", id, "code");
const data = path.join(home, "blocks", id, "data");
fs.writeFileSync(path.join(data, "storage.json"), '{"doc":"user work"}');
const before = fs.readFileSync(path.join(code, "main.js"), "utf8");
history.snapshot(id, "Before AI: add dark mode");
fs.writeFileSync(path.join(code, "main.js"), "// rewritten by AI\n");
fs.writeFileSync(path.join(code, "extra.js"), "// new file\n");
history.snapshot(id, "AI: add dark mode");
const undone = history.undoLastAiChange(id);
check("undo returns the AI change", undone === "AI: add dark mode", undone);
check("undo restores code", fs.readFileSync(path.join(code, "main.js"), "utf8") === before);
check("undo removes files the AI added", !fs.existsSync(path.join(code, "extra.js")));
check("data/ untouched", fs.readFileSync(path.join(data, "storage.json"), "utf8") === '{"doc":"user work"}');
check("second undo has nothing to undo", history.undoLastAiChange(id) === null);

// 7. Path safety
const plib = path.join(home, "paths.cjs");
await build({ entryPoints: [path.join(root, "src/shared/paths.ts")], bundle: true, platform: "node", format: "cjs", outfile: plib, logLevel: "silent" });
const { safeJoin } = require(plib);
check("safeJoin blocks traversal", safeJoin("/a/b", "../../etc/passwd") === null && safeJoin("/a/b", "x/y") === "/a/b/x/y");

fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
