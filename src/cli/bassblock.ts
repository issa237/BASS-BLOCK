/**
 * bassblock CLI — the interface agents (and people) use to build blocks.
 *
 *   bassblock create <id> [--name "…"] [--template blank|text-tool|image-tool|three-viewer]
 *   bassblock validate [dir|id] [--json]
 *   bassblock run <id>
 *   bassblock reload <id>
 *   bassblock list [--json]
 *   bassblock docs | schema
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createBlock, listBlocks, TEMPLATES, ID_PATTERN, type TemplateName, type Problem } from "../shared/blocks";
import { APP_ARGS, SDK_DIR, SKILL_PATH, bbHome, paths } from "../shared/paths";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "true";
}

function die(msg: string, code = 1): never {
  process.stderr.write(`bassblock: ${msg}\n`);
  process.exit(code);
}

function electronBinary(): string {
  if (process.env.BB_ELECTRON) return process.env.BB_ELECTRON;
  if (process.versions.electron) return process.execPath;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("electron") as unknown as string;
}

function sendToHost(msg: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(paths.hostSocket());
    let buf = "";
    c.on("connect", () => c.write(JSON.stringify(msg) + "\n"));
    c.on("data", (d) => (buf += d.toString()));
    c.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error("bad reply from host"));
      }
    });
    c.on("error", reject);
    c.setTimeout(20000, () => c.destroy(new Error("host did not answer")));
  });
}

/** Resolve a dir-or-id argument to a code dir, plus the block id if it lives in the BASS BLOCK home. */
function resolveTarget(arg?: string): { codeDir: string; id?: string } {
  let dir: string;
  if (!arg) dir = process.cwd();
  else if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) dir = path.resolve(arg);
  else if (ID_PATTERN.test(arg) && fs.existsSync(paths.codeDir(arg))) dir = paths.codeDir(arg);
  else die(`'${arg}' is neither a folder nor a known block id`);
  // Allow pointing at blocks/<id> instead of blocks/<id>/code
  if (!fs.existsSync(path.join(dir, "block.json")) && fs.existsSync(path.join(dir, "code", "block.json"))) dir = path.join(dir, "code");
  const blocks = path.resolve(paths.blocksDir());
  const rel = path.relative(blocks, dir).split(path.sep);
  const id = rel.length === 2 && rel[1] === "code" && !rel[0].startsWith("..") ? rel[0] : undefined;
  return { codeDir: dir, id };
}

async function validate() {
  const json = flag("json") !== undefined;
  const shotFlag = flag("screenshot");
  const { codeDir, id } = resolveTarget(rest[0]);
  const screenshot = shotFlag && shotFlag !== "true" ? path.resolve(shotFlag) : id ? path.join(paths.metaDir(id), "screenshot.png") : undefined;

  const args = [...APP_ARGS, "--bb-validate", codeDir];
  if (id) args.push("--bb-expect-id", id);
  if (screenshot) args.push("--bb-screenshot", screenshot);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const out = await new Promise<string>((resolve) => {
    const child = spawn(electronBinary(), args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    child.stdout.on("data", (d) => (s += d));
    child.stderr.on("data", () => {});
    const t = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", () => {
      clearTimeout(t);
      resolve(s);
    });
  });
  const line = out.split("\n").find((l) => l.startsWith("BBRESULT:"));
  if (!line) die("validator did not produce a result (Electron failed to start?)");
  const result = JSON.parse(line.slice("BBRESULT:".length)) as { ok: boolean; id?: string; problems: Problem[]; warnings: string[]; screenshot?: string; loadMs?: number };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    process.stdout.write(`✓ Block '${result.id}' passed validation${result.loadMs ? ` (loaded in ${result.loadMs} ms)` : ""}.\n`);
    if (result.screenshot) process.stdout.write(`  Screenshot: ${result.screenshot}\n`);
    for (const w of result.warnings.slice(0, 10)) process.stdout.write(`  warning: ${w}\n`);
  } else {
    process.stdout.write(`✗ Validation failed with ${result.problems.length} problem(s):\n`);
    result.problems.forEach((p, i) => process.stdout.write(`  ${i + 1}. [${p.step}]${p.file ? ` ${p.file}:` : ""} ${p.message}\n`));
    for (const w of result.warnings.slice(0, 10)) process.stdout.write(`  warning: ${w}\n`);
    process.stdout.write(`\nFix these problems and run \`bassblock validate\` again.\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

async function main() {
  switch (cmd) {
    case "create": {
      const id = rest.shift();
      if (!id) die("usage: bassblock create <id> [--name \"Name\"] [--template " + TEMPLATES.join("|") + "]");
      const template = (flag("template") ?? "blank") as TemplateName;
      const name = flag("name");
      const description = flag("description");
      const m = createBlock({ id, name, template, description });
      process.stdout.write(`Created block '${m.id}' from template '${template}'\n  code: ${paths.codeDir(m.id)}\n  data: ${paths.dataDir(m.id)}\n`);
      break;
    }
    case "validate":
      return validate();
    case "run":
    case "reload": {
      const id = rest[0];
      if (!id || !ID_PATTERN.test(id)) die(`usage: bassblock ${cmd} <id>`);
      try {
        const r = await sendToHost({ cmd: cmd === "run" ? "open" : "reload", id });
        if (!r.ok) die(r.error);
        process.stdout.write(cmd === "run" ? `Opened '${id}' in BASS BLOCK\n` : `Reloaded '${id}'${r.note ? ` (${r.note})` : ""}\n`);
      } catch {
        if (cmd === "reload") {
          process.stdout.write("BASS BLOCK is not running; nothing to reload.\n");
          return;
        }
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        spawn(electronBinary(), [...APP_ARGS, "--bb-open", id], { env, detached: true, stdio: "ignore" }).unref();
        process.stdout.write(`Starting BASS BLOCK with '${id}'…\n`);
      }
      break;
    }
    case "list": {
      const blocks = listBlocks();
      if (flag("json") !== undefined) {
        process.stdout.write(JSON.stringify(blocks.map((b) => ({ id: b.id, ok: b.ok, name: b.manifest?.name, version: b.manifest?.version, error: b.error })), null, 2) + "\n");
        break;
      }
      if (!blocks.length) process.stdout.write(`No blocks yet in ${paths.blocksDir()}\n`);
      for (const b of blocks) process.stdout.write(`${b.ok ? "●" : "✗"} ${b.id.padEnd(28)} ${b.manifest?.name ?? ""} ${b.manifest?.version ?? ""}${b.error ? `  (${b.error})` : ""}\n`);
      break;
    }
    case "docs":
      process.stdout.write(fs.readFileSync(SKILL_PATH, "utf8"));
      break;
    case "schema":
      process.stdout.write(fs.readFileSync(path.join(SDK_DIR, "block.schema.json"), "utf8"));
      break;
    case "home":
      process.stdout.write(bbHome() + "\n");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`bassblock — build and manage BASS BLOCK blocks

  bassblock create <id> [--name "Name"] [--template ${TEMPLATES.join("|")}]
  bassblock validate [dir|id] [--json] [--screenshot file.png]
                                 schema + files + headless launch in the real sandbox
  bassblock run <id>             open a block in the BASS BLOCK app
  bassblock reload <id>          reload a block that is open in the app
  bassblock list [--json]        list installed blocks
  bassblock docs                 print the block-building guide (SKILL.md)
  bassblock schema               print the block.json JSON Schema
  bassblock home                 print the BASS BLOCK home folder (${bbHome()})
`);
      break;
    default:
      die(`unknown command '${cmd}'. Run 'bassblock help'.`);
  }
}

main().catch((e) => die(e?.message ?? String(e)));
