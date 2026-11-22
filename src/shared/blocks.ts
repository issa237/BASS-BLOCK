import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import Ajv from "ajv";
import schema from "../../sdk/block.schema.json";
import { paths, TEMPLATES_DIR, safeJoin } from "./paths";

export type NetworkPermission = boolean | string[];
export type BackendLanguage = "python" | "swift" | "rust" | "cpp" | "go" | "node" | "custom";

export interface BlockPermissions {
  fs?: "none" | "user-picked-files";
  network?: NetworkPermission;
  clipboard?: boolean;
}

export interface BlockPort {
  name: string;
  type: string;
  description?: string;
}

export interface BlockBackend {
  language: BackendLanguage;
  protocol?: "stdio" | "http";
  build?: string | string[];
  run: string | string[];
  healthPath?: string;
}

export interface BlockManifest {
  schema: 1;
  id: string;
  name: string;
  description?: string;
  icon?: string;
  version: string;
  mode: "web" | "polyglot";
  sdk: string;
  entry: { ui: string };
  backend?: BlockBackend;
  permissions?: BlockPermissions;
  io?: { inputs?: BlockPort[]; outputs?: BlockPort[] };
  platform?: { os?: "macos" | "windows" | "linux" | "any"; arch?: ("arm64" | "x64")[] };
  limits?: { memoryMb?: number };
}

export interface BlockSummary {
  id: string;
  ok: boolean;
  manifest?: BlockManifest;
  error?: string;
  updatedAt: number;
}

export interface Problem {
  step: "manifest" | "files" | "backend" | "load" | "runtime" | "render";
  message: string;
  file?: string;
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const TEMPLATES = ["blank", "text-tool", "image-tool", "three-viewer", "python-tool", "swift-tool"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

export function effectivePermissions(m: BlockManifest): Required<BlockPermissions> {
  return {
    fs: m.permissions?.fs ?? "none",
    network: m.permissions?.network ?? false,
    clipboard: m.permissions?.clipboard ?? false,
  };
}

/** Stable hash of a block's permissions + backend command; approvals are tied to it so edits re-prompt. */
export function permissionsHash(m: BlockManifest): string {
  const p = effectivePermissions(m);
  const b = m.mode === "polyglot" && m.backend
    ? { language: m.backend.language, protocol: m.backend.protocol ?? "stdio", build: m.backend.build ?? null, run: m.backend.run }
    : null;
  const norm = JSON.stringify({
    fs: p.fs,
    network: Array.isArray(p.network) ? [...p.network].sort() : p.network,
    clipboard: p.clipboard,
    backend: b,
  });
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

export function needsApproval(m: BlockManifest): boolean {
  const p = effectivePermissions(m);
  return p.fs !== "none" || p.network !== false || p.clipboard || (m.mode === "polyglot" && !!m.backend);
}

export function describePermissions(m: BlockManifest): string[] {
  const p = effectivePermissions(m);
  const out: string[] = [];
  if (m.mode === "polyglot" && m.backend) {
    const cmd = Array.isArray(m.backend.run) ? m.backend.run.join(" ") : m.backend.run;
    out.push(`Run a local ${m.backend.language} backend (${cmd}) — runs outside the web sandbox with full access to your Mac's files and network`);
  }
  if (p.fs === "user-picked-files") out.push("Read and write files that you pick in a file dialog");
  if (p.network === true) out.push("Connect to any HTTPS website");
  else if (Array.isArray(p.network) && p.network.length) out.push(`Connect to: ${p.network.join(", ")}`);
  if (p.clipboard) out.push("Read and write the clipboard");
  return out;
}

/** Read + schema-check a manifest. Returns problems instead of throwing. */
export function readManifest(codeDir: string): { manifest?: BlockManifest; problems: Problem[] } {
  const file = path.join(codeDir, "block.json");
  if (!fs.existsSync(file)) return { problems: [{ step: "manifest", message: "block.json is missing", file: "block.json" }] };
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { problems: [{ step: "manifest", message: `block.json is not valid JSON: ${(e as Error).message}`, file: "block.json" }] };
  }
  if (!validateSchema(json)) {
    const problems = (validateSchema.errors ?? []).map<Problem>((err) => ({
      step: "manifest",
      file: "block.json",
      message: `${err.instancePath || "(root)"} ${err.message}${err.params && "allowedValues" in err.params ? `: ${(err.params as { allowedValues: unknown[] }).allowedValues.join(", ")}` : ""}${err.params && "additionalProperty" in err.params ? ` ('${(err.params as { additionalProperty: string }).additionalProperty}')` : ""}`,
    }));
    return { problems };
  }
  const manifest = json as unknown as BlockManifest;
  const problems: Problem[] = [];
  if (manifest.mode === "polyglot" && !manifest.backend) {
    problems.push({ step: "manifest", file: "block.json", message: "'mode' is 'polyglot' but 'backend' configuration is missing in block.json." });
  } else if (manifest.mode === "web" && manifest.backend !== undefined) {
    problems.push({ step: "manifest", file: "block.json", message: "'backend' is defined in block.json, so 'mode' must be set to 'polyglot' (or remove 'backend' for a pure web block)." });
  }
  return { manifest, problems };
}

/** Static checks that don't need to run the block. */
export function staticCheck(codeDir: string, expectedId?: string): { manifest?: BlockManifest; problems: Problem[] } {
  const { manifest, problems } = readManifest(codeDir);
  if (!manifest) return { problems };
  if (expectedId && manifest.id !== expectedId) {
    problems.push({ step: "manifest", file: "block.json", message: `id is '${manifest.id}' but the block folder is '${expectedId}'. They must match.` });
  }
  const entry = safeJoin(codeDir, manifest.entry.ui);
  if (!entry || !fs.existsSync(entry)) {
    problems.push({ step: "files", file: manifest.entry.ui, message: `entry.ui file '${manifest.entry.ui}' does not exist` });
  }

  // Remote sub-resources are blocked by the sandbox; catch them early without flagging <a href="https://..."> links.
  for (const f of walk(codeDir)) {
    if (!/\.(html|css|js|mjs|ts)$/.test(f)) continue;
    const rel = path.relative(codeDir, f);
    if (rel.startsWith("backend" + path.sep) || rel.startsWith(".bin" + path.sep)) continue;
    const text = fs.readFileSync(f, "utf8");

    if (/\.html$/.test(f)) {
      const noComments = text.replace(/<!--[\s\S]*?-->/g, "");
      const remoteSub = noComments.match(
        /<(?:script|img|iframe|audio|video|source|embed|track)\b[^>]*\bsrc\s*=\s*["'](https?:)?\/\/[^"']+["']|<link\b[^>]*\bhref\s*=\s*["'](https?:)?\/\/[^"']+["']/i,
      );
      if (remoteSub) {
        problems.push({
          step: "files",
          file: rel,
          message: `Loads a remote resource (${remoteSub[0].slice(0, 80)}). Blocks run offline in a sandbox: vendor the file into the block folder instead.`,
        });
      }
      if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(noComments)) {
        problems.push({
          step: "files",
          file: rel,
          message: "Inline <script> is blocked by the block Content Security Policy. Move the code into a .js file and load it with <script src>.",
        });
      }
      // Check actual HTML start tags for inline event attributes (onclick=...)
      const withoutScriptsAndStyles = noComments.replace(/<(script|style|code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
      if (/<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\son[a-z]+\s*=\s*["']/i.test(withoutScriptsAndStyles)) {
        problems.push({
          step: "files",
          file: rel,
          message: "Inline event handler attributes (onclick=...) are blocked by the CSP. Use addEventListener in a .js file.",
        });
      }
    } else if (/\.css$/.test(f)) {
      const remoteCss = text.match(/@import\s+(?:url\(\s*)?["']?(https?:)?\/\/[^"')\s]+|url\(\s*["']?(https?:)?\/\/[^"')\s]+/i);
      if (remoteCss) {
        problems.push({
          step: "files",
          file: rel,
          message: `Loads a remote CSS resource (${remoteCss[0].slice(0, 80)}). Vendor fonts/styles into the block folder instead.`,
        });
      }
    } else if (/\.(js|mjs|ts)$/.test(f)) {
      const remoteImport = text.match(/\bfrom\s+["'](https?:)?\/\/[^"']+["']|\bimport\s*\(\s*["'](https?:)?\/\/[^"']+["']/);
      if (remoteImport) {
        problems.push({
          step: "files",
          file: rel,
          message: `Imports a remote module (${remoteImport[0].slice(0, 80)}). Vendor the library into the block folder instead.`,
        });
      }
    }
  }
  return { manifest, problems };
}

function* walk(dir: string): Generator<string> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".bin" || ent.name === "__pycache__" || ent.name === "target") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && fs.statSync(p).size < 5_000_000) yield p;
  }
}

export function listBlocks(): BlockSummary[] {
  const dir = paths.blocksDir();
  if (!fs.existsSync(dir)) return [];
  const out: BlockSummary[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !ID_PATTERN.test(ent.name)) continue;
    const codeDir = paths.codeDir(ent.name);
    const { manifest, problems } = readManifest(codeDir);
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(path.join(codeDir, "block.json")).mtimeMs;
    } catch {}
    out.push({ id: ent.name, ok: !!manifest && problems.length === 0, manifest, error: problems[0]?.message, updatedAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length >= 2 ? s : `block-${crypto.randomBytes(3).toString("hex")}`;
}

export function uniqueId(base: string): string {
  let id = slugify(base);
  let n = 2;
  while (fs.existsSync(paths.blockDir(id))) id = `${slugify(base).slice(0, 44)}-${n++}`;
  return id;
}

/** Pick the best starter template based on a natural-language prompt. */
export function suggestTemplate(request: string, hasPython = true, hasSwift = true): TemplateName {
  const q = request.toLowerCase();
  if (/\b(swift|macos native|appkit|metal|coreaudio|vision framework|apple)\b/.test(q) && hasSwift) return "swift-tool";
  if (/\b(python|opencv|ffmpeg|video|audio|whisper|pytorch|numpy|pandas|csv|data science|ocr|ai|ml|scrape|pdf)\b/.test(q) && hasPython) return "python-tool";
  if (/\b(3d|stl|obj|gltf|mesh|webgl|three\.?js|shader|voxel|orbit|cad|model viewer)\b/.test(q)) return "three-viewer";
  if (/\b(image|photo|pixel|sprite|color|palette|filter|crop|resize|lut|png|jpg|canvas)\b/.test(q)) return "image-tool";
  if (/\b(markdown|text|note|word|editor|writer|json|yaml|diff|log|regex)\b/.test(q)) return "text-tool";
  return "blank";
}

export function createBlock(opts: { id: string; name?: string; description?: string; template?: TemplateName }): BlockManifest {
  const { id } = opts;
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid block id '${id}'. Use 2-48 lowercase letters, digits and dashes.`);
  if (fs.existsSync(paths.blockDir(id))) throw new Error(`A block named '${id}' already exists`);
  const template = opts.template ?? "blank";
  const src = path.join(TEMPLATES_DIR, template);
  if (!fs.existsSync(src)) throw new Error(`Unknown template '${template}'. Available: ${TEMPLATES.join(", ")}`);

  fs.mkdirSync(paths.dataDir(id), { recursive: true });
  fs.mkdirSync(paths.metaDir(id), { recursive: true });
  fs.cpSync(src, paths.codeDir(id), { recursive: true });

  const file = path.join(paths.codeDir(id), "block.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as unknown as BlockManifest;
  manifest.id = id;
  if (opts.name) manifest.name = opts.name.slice(0, 60);
  if (opts.description) manifest.description = opts.description.slice(0, 400);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  history.snapshot(id, `Create block from template '${template}'`);
  return manifest;
}

export function deleteBlockToTrash(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("bad id");
  const trash = path.join(paths.stateDir(), "trash");
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${id}-${Date.now()}`);
  fs.renameSync(paths.blockDir(id), dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Code history: git when available (Xcode CLT installed), plain snapshots otherwise.
// Only code/ is versioned. data/ is never touched by history operations.
// ---------------------------------------------------------------------------

let gitOk: boolean | undefined;
function hasGit(): boolean {
  if (gitOk !== undefined) return gitOk;
  if (process.platform === "darwin") {
    // Calling /usr/bin/git without Command Line Tools pops an install dialog, so check first.
    const sel = spawnSync("xcode-select", ["-p"], { stdio: "ignore" });
    gitOk = sel.status === 0 && spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } else {
    gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return gitOk;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=BASS BLOCK", "-c", "user.email=host@bassblock.local", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface HistoryEntry {
  ref: string;
  message: string;
  at: number;
}

const BLOCK_GITIGNORE = ".bin/\ntarget/\n__pycache__/\n*.pyc\n.DS_Store\n";

function ensureBlockGitignore(codeDir: string): void {
  const file = path.join(codeDir, ".gitignore");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, BLOCK_GITIGNORE, "utf8");
    return;
  }
  const cur = fs.readFileSync(file, "utf8");
  if (!cur.split(/\r?\n/).some((l) => l.trim() === ".bin" || l.trim() === ".bin/")) {
    fs.writeFileSync(file, cur.replace(/\s*$/, "\n") + ".bin/\n", "utf8");
  }
}

function isIgnoredBuildArtifact(codeDir: string, srcPath: string): boolean {
  const rel = path.relative(codeDir, srcPath);
  if (!rel) return false;
  const first = rel.split(path.sep)[0];
  return first === ".bin" || first === ".git" || first === "target" || first === "__pycache__";
}

export const history = {
  snapshot(id: string, message: string): void {
    const code = paths.codeDir(id);
    if (!fs.existsSync(code)) return;
    ensureBlockGitignore(code);
    if (hasGit()) {
      if (!fs.existsSync(path.join(code, ".git"))) git(code, ["init", "-q", "-b", "main"]);
      git(code, ["add", "-A"]);
      git(code, ["commit", "-q", "--allow-empty", "-m", message]);
      return;
    }
    const dir = path.join(paths.metaDir(id), "snapshots", `${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(code, path.join(dir, "code"), {
      recursive: true,
      filter: (src) => !isIgnoredBuildArtifact(code, src),
    });
    fs.writeFileSync(path.join(dir, "message.txt"), message);
  },

  list(id: string): HistoryEntry[] {
    const code = paths.codeDir(id);
    if (!fs.existsSync(code)) return [];
    if (hasGit() && fs.existsSync(path.join(code, ".git"))) {
      const out = git(code, ["log", "--format=%H%x09%ct%x09%s", "-n", "50"]).trim();
      return out
        ? out.split("\n").map((l) => {
            const [ref, ct, ...msg] = l.split("\t");
            return { ref, at: Number(ct) * 1000, message: msg.join("\t") };
          })
        : [];
    }
    const dir = path.join(paths.metaDir(id), "snapshots");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .sort()
      .reverse()
      .map((ts) => ({
        ref: ts,
        at: Number(ts),
        message: fs.readFileSync(path.join(dir, ts, "message.txt"), "utf8"),
      }));
  },

  /**
   * Undo the most recent AI change that hasn't been undone yet.
   * AI edits are recorded as a "Before AI: ..." snapshot followed by an "AI: ..." snapshot;
   * undo restores the "Before AI" state and records it as a new entry.
   */
  undoLastAiChange(id: string): string | null {
    const entries = history.list(id); // newest first
    const undone = new Set(
      entries
        .filter((e) => e.message.startsWith("Undo AI change "))
        .map((e) => e.message.slice("Undo AI change ".length).split(" ")[0]),
    );
    // If a snapshot was restored explicitly, don't reach past that restore point for automatic AI undo.
    const restoreIdx = entries.findIndex((e) => e.message.startsWith("Restore snapshot "));
    const searchSpace = restoreIdx >= 0 ? entries.slice(0, restoreIdx) : entries;

    const idx = searchSpace.findIndex((e) => e.message.startsWith("AI: ") && !undone.has(e.ref.slice(0, 12)));
    if (idx < 0) return null;
    const target = searchSpace[idx];
    const before = entries.slice(idx + 1).find((e) => e.message.startsWith("Before AI: "));
    if (!before) return null;
    history.restore(id, before.ref);
    history.snapshot(id, `Undo AI change ${target.ref.slice(0, 12)} (${target.message.slice(4, 80)})`);
    return target.message;
  },

  /** Restore a specific snapshot from the history UI and record a commit. */
  restoreTo(id: string, ref: string): HistoryEntry | null {
    const entries = history.list(id);
    const target = entries.find((e) => e.ref === ref || e.ref.startsWith(ref));
    if (!target) return null;
    history.restore(id, target.ref);
    history.snapshot(id, `Restore snapshot ${target.ref.slice(0, 12)} (${target.message.slice(0, 60)})`);
    return target;
  },

  restore(id: string, ref: string): void {
    const code = paths.codeDir(id);
    if (hasGit() && fs.existsSync(path.join(code, ".git"))) {
      git(code, ["rm", "-r", "-q", "--cached", "."]);
      git(code, ["checkout", ref, "--", "."]);
      git(code, ["clean", "-fdq"]);
      return;
    }
    const snap = path.join(paths.metaDir(id), "snapshots", ref, "code");
    for (const ent of fs.readdirSync(code)) fs.rmSync(path.join(code, ent), { recursive: true, force: true });
    fs.cpSync(snap, code, { recursive: true });
  },
};
