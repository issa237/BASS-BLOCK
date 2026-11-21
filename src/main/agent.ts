/**
 * Drives installed coding-agent CLIs (Claude Code, Gemini CLI, Codex) in headless mode to
 * create or modify a block. The host owns the loop: snapshot → agent → validate → repair (max 3).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { history, type Problem } from "../shared/blocks";
import { paths, SKILL_PATH, TEMPLATES_DIR } from "../shared/paths";
import { findBinary, formatRuntimesForPrompt, userPath } from "./runtimes";

export type AgentId = "claude" | "gemini" | "codex";
export const AGENTS: { id: AgentId; label: string; bin: string }[] = [
  { id: "claude", label: "Claude Code", bin: "claude" },
  { id: "gemini", label: "Gemini CLI", bin: "gemini" },
  { id: "codex", label: "Codex", bin: "codex" },
];

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; text: string }
  | { type: "log"; text: string }
  | { type: "done"; ok: boolean; problems: Problem[]; summary?: string; cancelled?: boolean };

export function detectAgents(): { id: AgentId; label: string; path: string | null }[] {
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    path: findBinary(a.bin),
  }));
}

/**
 * A minimal environment: no host secrets. Each agent only gets its own vendor's variables,
 * and PATH has the bassblock CLI shim first.
 */
function agentEnv(agent: AgentId): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "TERM", "__CF_USER_TEXT_ENCODING"];
  const vendor: Record<AgentId, RegExp> = {
    claude: /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|AWS_|CLOUD_ML_REGION$|GOOGLE_APPLICATION_CREDENTIALS$|VERTEX_)/,
    gemini: /^(GEMINI_|GOOGLE_)/,
    codex: /^(OPENAI_|CODEX_)/,
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.includes(k) || vendor[agent].test(k)) env[k] = v;
  env.PATH = `${paths.binDir()}${path.delimiter}${userPath()}`;
  if (process.env.BASSBLOCK_HOME) env.BASSBLOCK_HOME = process.env.BASSBLOCK_HOME;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

function skillText(): string {
  return fs.readFileSync(SKILL_PATH, "utf8").replace(/^---[\s\S]*?---\s*/, "");
}

function buildPrompt(kind: "create" | "edit" | "repair", blockId: string, request: string, problems?: Problem[]): string {
  const runtimes = formatRuntimesForPrompt();
  const head = `You are working on a BASS BLOCK block (a sandboxed mini-app) in the current directory. Block id: ${blockId}.
Reference example blocks (read-only) are in: ${TEMPLATES_DIR}
${runtimes}
Follow the "bass-block-builder" rules in your instructions exactly. Only edit files in the current directory.`;
  if (kind === "create")
    return `${head}

The user wants this tool:
"""
${request}
"""

Choose the best execution mode and language for this tool ("mode": "web" for pure UI/Canvas/WebGL/TS tools, or "mode": "polyglot" with a local backend in Python, Swift, Rust, C++, Go or Node.js if backend compute, data analysis, native APIs or media processing fit best).
Replace the starter files with a complete, polished implementation of the request.
Update block.json: keep "id": "${blockId}", set a short "name", a one-line "description", an emoji "icon", configure "mode" (and "backend" if polyglot), and declare only the permissions you need.
When you are done, run \`bassblock validate\` and fix every problem it reports until it passes. Finish with a one or two sentence summary of what you built.`;
  if (kind === "edit")
    return `${head}

The user wants this change to the existing block:
"""
${request}
"""

Read the existing code first and make the change without breaking existing features or the user's saved data format (bb.storage keys / bb.data files).
You may switch the block to "mode": "polyglot" and add a backend in backend/ if the requested feature requires Python, Swift, Rust, C++, Go or Node.js.
Bump the patch version in block.json. When done, run \`bassblock validate\` and fix every problem it reports. Finish with a one or two sentence summary.`;
  return `${head}

The host ran \`bassblock validate\` on this block and it FAILED with these problems:
${(problems ?? []).map((p) => `- [${p.step}]${p.file ? ` ${p.file}:` : ""} ${p.message}`).join("\n")}

The original request was:
"""
${request}
"""

Fix the problems, then run \`bassblock validate\` again until it passes. Finish with a one sentence summary of the fix.`;
}

function agentArgs(agent: AgentId, prompt: string, codeDir: string): string[] {
  switch (agent) {
    case "claude":
      return [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read,Write,Edit,MultiEdit,Glob,Grep,LS,TodoWrite,Bash(bassblock validate:*),Bash(bassblock validate),Bash(bassblock runtimes)",
        "--disallowedTools", "WebFetch,WebSearch",
        "--add-dir", TEMPLATES_DIR,
        "--append-system-prompt", skillText(),
      ];
    case "gemini":
      return [
        "-p", `${skillText()}\n\n---\n\n${prompt}`,
        "--approval-mode", "auto_edit",
        "--allowed-tools", "run_shell_command(bassblock validate)",
        "--include-directories", TEMPLATES_DIR,
        "-o", "stream-json",
      ];
    case "codex":
      return ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--json", "--cd", codeDir, `${skillText()}\n\n---\n\n${prompt}`];
  }
}

/** Hash all source files in `codeDir` (excluding `.git`) to detect whether an agent actually modified anything. */
function dirContentHash(codeDir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === ".git" || ent.name === ".bin") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        h.update(path.relative(codeDir, p) + ":");
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(codeDir);
  return h.digest("hex");
}

/** Turn one line of agent output into something readable for the progress panel. */
function parseLine(line: string): AgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let o: any;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return { type: "log", text: trimmed.slice(0, 500) };
  }
  // Claude Code stream-json
  if (o.type === "assistant" && o.message?.content) {
    const parts = o.message.content as any[];
    const tool = parts.find((c) => c.type === "tool_use");
    if (tool) return { type: "tool", text: describeTool(tool.name, tool.input) };
    const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text ? { type: "text", text } : null;
  }
  if (o.type === "result") return { type: "text", text: typeof o.result === "string" ? o.result : "Agent finished." };
  if (o.type === "system" && o.subtype === "init") return { type: "status", text: `Agent started (${o.model ?? "default model"})` };
  // Gemini CLI stream-json
  if (o.type === "tool_use") return { type: "tool", text: describeTool(o.tool_name ?? o.name, o.parameters ?? o.input) };
  if (o.type === "message" && o.role === "assistant" && typeof o.content === "string" && !o.delta) return { type: "text", text: o.content };
  if (o.type === "init") return { type: "status", text: `Agent started (${o.model ?? "default model"})` };
  // Codex --json
  if (o.type === "item.completed" && o.item) {
    if (o.item.type === "agent_message") return { type: "text", text: o.item.text };
    if (o.item.type === "command_execution") return { type: "tool", text: `$ ${o.item.command}` };
    if (o.item.type === "file_change") return { type: "tool", text: `Edited ${(o.item.changes ?? []).map((c: any) => c.path).join(", ")}` };
  }
  return null;
}

function describeTool(name: string, input: any): string {
  const file = input?.file_path ?? input?.path ?? input?.absolute_path;
  const short = (p: string) => String(p).split("/code/").pop();
  if (/^(Write|write_file)$/.test(name)) return `Writing ${short(file)}`;
  if (/^(Edit|MultiEdit|replace|edit)$/.test(name)) return `Editing ${short(file)}`;
  if (/^(Read|read_file|read_many_files)$/.test(name)) return `Reading ${short(file ?? "")}`;
  if (/^(Bash|run_shell_command)$/.test(name)) return `$ ${input?.command ?? ""}`;
  if (/^(Glob|Grep|LS|glob|search_file_content|list_directory)$/.test(name)) return `Searching files`;
  if (name === "TodoWrite") return "Planning";
  return name;
}

export interface AgentJob {
  cancel(): void;
  done: Promise<{ ok: boolean; problems: Problem[]; cancelled?: boolean }>;
}

export function runAgentJob(opts: {
  agent: AgentId;
  agentPath: string;
  blockId: string;
  kind: "create" | "edit";
  request: string;
  validate: () => Promise<{ ok: boolean; problems: Problem[] }>;
  onEvent: (e: AgentEvent) => void;
  maxRepairs?: number;
}): AgentJob {
  const codeDir = paths.codeDir(opts.blockId);
  const transcript = path.join(paths.metaDir(opts.blockId), `agent-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const log = fs.createWriteStream(transcript);
  let child: ChildProcess | null = null;
  let cancelled = false;
  let lastStderr = "";
  const emit = (e: AgentEvent) => {
    log.write(JSON.stringify(e) + "\n");
    opts.onEvent(e);
  };

  const runOnce = (prompt: string) =>
    new Promise<number>((resolve) => {
      lastStderr = "";
      child = spawn(opts.agentPath, agentArgs(opts.agent, prompt, codeDir), {
        cwd: codeDir,
        env: agentEnv(opts.agent),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const ev = parseLine(line);
          if (ev) emit(ev);
        }
      });
      child.stderr!.on("data", (d: Buffer) => {
        const t = d.toString().trim();
        if (!t) return;
        log.write(`[stderr] ${t}\n`);
        lastStderr = (lastStderr ? lastStderr + "\n" : "") + t;
        for (const line of t.split("\n").slice(0, 6)) {
          if (line.trim()) emit({ type: "log", text: line.trim().slice(0, 400) });
        }
      });
      child.on("error", (err) => {
        emit({ type: "log", text: `Could not start ${opts.agent}: ${err.message}` });
        resolve(-1);
      });
      child.on("close", (code) => {
        if (buf.trim()) {
          const ev = parseLine(buf);
          if (ev) emit(ev);
        }
        child = null;
        resolve(code ?? -1);
      });
    });

  const done = (async () => {
    const initialHash = dirContentHash(codeDir);
    history.snapshot(opts.blockId, `Before AI: ${opts.request.slice(0, 200)}`);
    const beforeRef = history.list(opts.blockId)[0]?.ref;
    const maxRepairs = opts.maxRepairs ?? 3;
    let result: { ok: boolean; problems: Problem[] } = { ok: false, problems: [] };
    try {
      emit({ type: "status", text: opts.kind === "create" ? "Building your block…" : "Applying your change…" });
      let code = await runOnce(buildPrompt(opts.kind, opts.blockId, opts.request));
      for (let attempt = 0; !cancelled; attempt++) {
        const changed = dirContentHash(codeDir) !== initialHash;
        if (code !== 0 && !changed) {
          const errMsg = lastStderr.split("\n").filter(Boolean).slice(-3).join(" — ") || `Agent CLI exited with code ${code} before making any changes.`;
          result = { ok: false, problems: [{ step: "runtime", message: errMsg }] };
          emit({ type: "log", text: `Agent failed: ${errMsg}` });
          break;
        }
        if (code !== 0) emit({ type: "log", text: `Agent exited with code ${code}` });
        emit({ type: "status", text: "Validating…" });
        result = await opts.validate();
        if (result.ok || attempt >= maxRepairs || cancelled) break;
        emit({ type: "status", text: `Validation found ${result.problems.length} problem(s). Repair attempt ${attempt + 1} of ${maxRepairs}…` });
        code = await runOnce(buildPrompt("repair", opts.blockId, opts.request, result.problems));
      }
    } finally {
      const changed = dirContentHash(codeDir) !== initialHash;
      if (cancelled) {
        if (opts.kind === "edit" && beforeRef) {
          try {
            history.restore(opts.blockId, beforeRef);
          } catch {}
        }
      } else if (changed) {
        history.snapshot(opts.blockId, `AI: ${opts.request.slice(0, 200)}`);
      }
      emit({ type: "done", ok: result.ok && !cancelled, problems: result.problems, cancelled });
      log.end();
    }
    return { ...result, cancelled };
  })();

  return {
    cancel() {
      cancelled = true;
      const c = child as ChildProcess | null;
      if (c?.pid) {
        try {
          if (process.platform === "win32") c.kill();
          else process.kill(-c.pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            if (c.pid) {
              if (process.platform === "win32") c.kill("SIGKILL");
              else process.kill(-c.pid, "SIGKILL");
            }
          } catch {}
        }, 3000);
      }
    },
    done,
  };
}
