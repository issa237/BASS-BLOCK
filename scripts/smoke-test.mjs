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

// 1. Runtimes detection + install guides
const rtOut = cli("runtimes", "--json");
const runtimes = JSON.parse(rtOut.stdout || "[]");
check("detects local language runtimes", rtOut.status === 0 && Array.isArray(runtimes) && runtimes.some((r) => r.id === "python" && r.path));
check(
  "every language runtime includes install guide steps & commands",
  Array.isArray(runtimes) && runtimes.length >= 8 && runtimes.every((r) => r.install?.steps?.length > 0 && r.install?.verifyCmd && r.install?.docsUrl),
);

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

// 8. Universal AI Agents: Custom CLI agent (OpenClaude style) + Built-in Direct API runner (Ollama / OpenRouter style)
const alib = path.join(root, "dist/test-agent.cjs");
await build({ entryPoints: [path.join(root, "src/main/agent.ts")], bundle: true, platform: "node", format: "cjs", outfile: alib, logLevel: "silent" });
const { detectAgents, runAgentJob } = require(alib);

// 8a. Custom CLI agent test
const mockCli = path.join(home, "mock-openclaude.sh");
fs.writeFileSync(
  mockCli,
  '#!/bin/sh\ncat > main.js <<\'EOF\'\ndocument.getElementById("title").textContent = "Built by OpenClaude CLI";\nbb.ready();\nEOF\necho \'{"type":"result","result":"Updated block via custom CLI"}\'\n',
  { mode: 0o755 },
);
const customCliCfg = { id: "custom-openclaude", label: "OpenClaude Free", kind: "cli", command: mockCli, argsTemplate: "--prompt-file {{prompt_file}}" };
const detected = await detectAgents([customCliCfg]);
const cliDesc = detected.find((a) => a.id === "custom-openclaude");
check("detects custom linked CLI agent", Boolean(cliDesc && cliDesc.path === mockCli));

const cliJob = runAgentJob({
  agent: cliDesc,
  blockId: "s-blank",
  kind: "edit",
  request: "Update title with OpenClaude",
  validate: async () => ({ ok: true, problems: [] }),
  onEvent: () => {},
});
const cliRes = await cliJob.done;
check(
  "custom CLI agent edits block and passes validation",
  cliRes.ok && fs.readFileSync(path.join(home, "blocks/s-blank/code/main.js"), "utf8").includes("Built by OpenClaude CLI"),
);

// 8b. Built-in Direct API agent test (local OpenAI-compatible server)
const http = require("node:http");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '<<<FILE: main.js>>>\ndocument.getElementById("title").textContent = "Built by Free API Model";\nbb.ready();\n<<<END_FILE>>>\n<<<SUMMARY>>>\nUpdated via Direct API.\n<<<END_SUMMARY>>>',
            },
          },
        ],
      }),
    );
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const apiPort = srv.address().port;
const apiCfg = {
  id: "custom-free-api",
  label: "Local Free Model",
  kind: "api",
  baseUrl: `http://127.0.0.1:${apiPort}/v1`,
  model: "qwen2.5-coder:free",
};
const apiDesc = (await detectAgents([apiCfg])).find((a) => a.id === "custom-free-api");
const apiJob = runAgentJob({
  agent: apiDesc,
  blockId: "s-blank",
  kind: "edit",
  request: "Update title with Free API model",
  validate: async () => ({ ok: true, problems: [] }),
  onEvent: () => {},
});
const apiRes = await apiJob.done;
srv.close();
check(
  "direct API agent writes block files and passes validation",
  apiRes.ok && fs.readFileSync(path.join(home, "blocks/s-blank/code/main.js"), "utf8").includes("Built by Free API Model"),
);

// 9. Skill importer (local skill folder + remote skill link)
const slib = path.join(home, "skill.cjs");
await build({ entryPoints: [path.join(root, "src/main/skillImport.ts")], bundle: true, platform: "node", format: "cjs", outfile: slib, logLevel: "silent" });
const { fetchSkillFromLink } = require(slib);

const sampleSkillDir = path.join(home, "sample-skill");
fs.mkdirSync(path.join(sampleSkillDir, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(sampleSkillDir, "SKILL.md"),
  "---\nname: Sprite Sheet Slicer\ndescription: Slice 2D game sprite sheets into individual frames.\n---\n\n# Sprite Sheet Slicer\n\nInstructions for slicing sprite sheets.\n",
);
fs.writeFileSync(path.join(sampleSkillDir, "scripts", "slice.py"), "print('slicing')\n");
const importedLocal = await fetchSkillFromLink(sampleSkillDir);
check(
  "imports skill from local folder with frontmatter and scripts",
  importedLocal.name === "Sprite Sheet Slicer" &&
    importedLocal.description.includes("Slice 2D game sprite sheets") &&
    importedLocal.scripts.length === 1 &&
    importedLocal.scripts[0].name === "slice.py",
);

const skillSrv = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/markdown" });
  res.end("---\nname: Audio Spectrum Analyzer\ndescription: Real-time FFT audio spectrum visualizer.\n---\n# Audio Spectrum\nUse Web Audio API.");
});
await new Promise((r) => skillSrv.listen(0, "127.0.0.1", r));
const skillPort = skillSrv.address().port;
const importedRemote = await fetchSkillFromLink(`http://127.0.0.1:${skillPort}/SKILL.md`);
skillSrv.close();
check(
  "imports skill from remote URL link",
  importedRemote.name === "Audio Spectrum Analyzer" && importedRemote.description.includes("Real-time FFT"),
);

fs.rmSync(alib, { force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
