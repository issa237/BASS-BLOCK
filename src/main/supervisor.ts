/**
 * Polyglot Backend Supervisor.
 * Compiles (when `backend.build` is configured) and manages per-block backend processes
 * written in any language (Python, Swift, Rust, C++, Go, Node.js, etc.).
 *
 * Supports two protocols:
 * - "stdio" (default): zero-dependency line-delimited JSON-RPC over stdin/stdout
 * - "http": local loopback HTTP server on 127.0.0.1:$BB_PORT
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { BlockManifest } from "../shared/blocks";
import { userPath, findBinary } from "./runtimes";

export type BackendLogFn = (blockId: string, level: "info" | "warn" | "error", text: string) => void;
export type BackendEventFn = (wcId: number, event: string, data: unknown) => void;

let logFn: BackendLogFn = () => {};
let eventFn: BackendEventFn = () => {};

export function setSupervisorCallbacks(opts: { onLog: BackendLogFn; onEvent: BackendEventFn }) {
  logFn = opts.onLog;
  eventFn = opts.onEvent;
}

interface PendingCall {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface BackendInstance {
  key: string;
  blockId: string;
  wcId: number;
  protocol: "stdio" | "http";
  port?: number;
  child: ChildProcess | null;
  ready: Promise<void>;
  pending: Map<number, PendingCall>;
  nextId: number;
  stopped: boolean;
  lastError?: string;
}

const instances = new Map<string, BackendInstance>();
const crashHistory = new Map<string, { times: number[]; lastError?: string }>();
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 10000;

export function backendKey(blockId: string, wcId: number, validating: boolean): string {
  return validating ? `val:${wcId}:${blockId}` : `live:${blockId}`;
}

function backendEnv(blockId: string, codeDir: string, dataDir: string, port?: number): NodeJS.ProcessEnv {
  const keep = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "__CF_USER_TEXT_ENCODING"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.PATH = userPath();
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.NO_COLOR = "1";
  env.BB_BLOCK_ID = blockId;
  env.BB_CODE_DIR = codeDir;
  env.BB_DATA_DIR = dataDir;
  if (port) env.BB_PORT = String(port);
  return env;
}

function parseCommand(cmd: string | string[]): { bin: string; args: string[]; shell: boolean } {
  if (Array.isArray(cmd)) {
    const [first, ...rest] = cmd;
    const resolved = (!first.includes("/") && !first.includes("\\") && findBinary(first)) || first;
    return { bin: resolved, args: rest, shell: false };
  }
  return { bin: cmd, args: [], shell: true };
}

/** Hash source files in `codeDir` + build command so compiled languages (Swift, Rust, C++, Go) only recompile when changed. */
function computeBuildHash(codeDir: string, buildCmd: string | string[]): string {
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(buildCmd));
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === ".git" || ent.name === ".bin" || ent.name === "node_modules" || ent.name === "target" || ent.name === "__pycache__") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const st = fs.statSync(p);
        h.update(`${path.relative(codeDir, p)}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    }
  };
  walk(codeDir);
  return h.digest("hex").slice(0, 24);
}

async function runBuildStep(blockId: string, codeDir: string, dataDir: string, buildCmd: string | string[]): Promise<void> {
  const binDir = path.join(codeDir, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  const hashFile = path.join(binDir, ".build-hash");
  const currentHash = computeBuildHash(codeDir, buildCmd);

  // Check if all target files inside .bin already exist and match the source hash
  const existingBins = fs.readdirSync(binDir).filter((f) => !f.startsWith("."));
  if (existingBins.length > 0 && fs.existsSync(hashFile) && fs.readFileSync(hashFile, "utf8").trim() === currentHash) {
    return;
  }

  logFn(blockId, "info", `Compiling backend (${Array.isArray(buildCmd) ? buildCmd.join(" ") : buildCmd})…`);
  const { bin, args, shell } = parseCommand(buildCmd);
  const env = backendEnv(blockId, codeDir, dataDir);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: codeDir,
      env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error("Backend compilation timed out after 180s"));
    }, 180000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to run build command '${bin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          fs.writeFileSync(hashFile, currentHash);
        } catch {}
        resolve();
      } else {
        reject(new Error(`Backend build failed (exit ${code}):\n${out.trim().slice(0, 1500)}`));
      }
    });
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("Could not allocate port"))));
    });
    srv.on("error", reject);
  });
}

async function waitForHttpBackend(port: number, healthPath: string, inst: BackendInstance, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}${healthPath}`;
  while (Date.now() < deadline) {
    if (inst.stopped || !inst.child || inst.child.exitCode !== null) {
      throw new Error(inst.lastError || `HTTP backend exited before listening on port ${port}`);
    }
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`HTTP backend did not respond on 127.0.0.1:${port}${healthPath} within ${timeoutMs}ms`);
}

export async function ensureBackend(opts: {
  key: string;
  blockId: string;
  wcId: number;
  codeDir: string;
  dataDir: string;
  manifest: BlockManifest;
}): Promise<BackendInstance> {
  const existing = instances.get(opts.key);
  if (existing && !existing.stopped && (!existing.child || existing.child.exitCode === null)) {
    existing.wcId = opts.wcId;
    await existing.ready;
    return existing;
  }
  if (existing) stopBackend(opts.key, false);

  const crashes = crashHistory.get(opts.key);
  if (crashes) {
    const now = Date.now();
    crashes.times = crashes.times.filter((t) => now - t < CRASH_WINDOW_MS);
    if (crashes.times.length >= MAX_CRASHES_IN_WINDOW) {
      throw new Error(
        `Backend crashed ${crashes.times.length} times in ${CRASH_WINDOW_MS / 1000}s${crashes.lastError ? ` (${crashes.lastError})` : ""}. Reload the block after fixing the backend.`,
      );
    }
  }

  const backend = opts.manifest.backend;
  if (opts.manifest.mode !== "polyglot" || !backend) {
    throw new Error(`Block '${opts.blockId}' does not declare a polyglot backend in block.json`);
  }

  const protocol = backend.protocol ?? "stdio";
  const inst: BackendInstance = {
    key: opts.key,
    blockId: opts.blockId,
    wcId: opts.wcId,
    protocol,
    child: null,
    ready: Promise.resolve(),
    pending: new Map(),
    nextId: 1,
    stopped: false,
  };
  instances.set(opts.key, inst);

  inst.ready = (async () => {
    fs.mkdirSync(path.join(opts.dataDir, "files"), { recursive: true });
    if (backend.build) {
      await runBuildStep(opts.blockId, opts.codeDir, opts.dataDir, backend.build);
    }
    if (inst.stopped) return;

    if (protocol === "http") {
      inst.port = await getFreePort();
    }

    const { bin, args, shell } = parseCommand(backend.run);
    const resolvedBin =
      !shell && (bin.startsWith("./") || bin.startsWith(".bin/"))
        ? path.join(opts.codeDir, bin)
        : bin;

    const child = spawn(resolvedBin, args, {
      cwd: opts.codeDir,
      env: backendEnv(opts.blockId, opts.codeDir, opts.dataDir, inst.port),
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    inst.child = child;

    let stdoutBuf = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBuf += d.toString("utf8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        if (protocol === "stdio" && line.startsWith("{")) {
          try {
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown; event?: string; data?: unknown };
            if (typeof msg.id === "number" && inst.pending.has(msg.id)) {
              const p = inst.pending.get(msg.id)!;
              inst.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.error !== undefined && msg.error !== null) {
                const errText = typeof msg.error === "string" ? msg.error : (msg.error as { message?: string })?.message ?? JSON.stringify(msg.error);
                p.reject(new Error(errText));
              } else {
                p.resolve(msg.result ?? null);
              }
              continue;
            }
            if (typeof msg.event === "string") {
              eventFn(inst.wcId, msg.event, msg.data ?? null);
              continue;
            }
          } catch {}
        }
        logFn(opts.blockId, "info", `[backend] ${line}`);
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8").trim();
      if (!text) return;
      inst.lastError = text.slice(0, 800);
      for (const line of text.split("\n")) {
        logFn(opts.blockId, "warn", `[backend] ${line}`);
      }
    });

    child.on("error", (err) => {
      inst.lastError = err.message;
      logFn(opts.blockId, "error", `[backend] Failed to start '${resolvedBin}': ${err.message}`);
      for (const [, p] of inst.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Backend process failed to start: ${err.message}`));
      }
      inst.pending.clear();
    });

    child.on("close", (code, sig) => {
      for (const [, p] of inst.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(inst.lastError || `Backend exited (code ${code ?? sig})`));
      }
      inst.pending.clear();
      if (!inst.stopped && code !== 0 && code !== null) {
        const rec = crashHistory.get(opts.key) ?? { times: [] };
        rec.times.push(Date.now());
        rec.lastError = inst.lastError || `exit code ${code}`;
        crashHistory.set(opts.key, rec);
        logFn(opts.blockId, "error", `[backend] Process exited with code ${code}${inst.lastError ? `: ${inst.lastError}` : ""}`);
      }
    });

    if (protocol === "http" && inst.port) {
      await waitForHttpBackend(inst.port, backend.healthPath ?? "/health", inst);
    } else {
      // Give stdio process a brief moment to fail immediately if command/syntax is invalid
      await new Promise((r) => setTimeout(r, 80));
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(inst.lastError || `Backend process exited immediately with code ${child.exitCode}`);
      }
    }
  })();

  try {
    await inst.ready;
    return inst;
  } catch (e) {
    stopBackend(opts.key, false);
    throw e;
  }
}

/** Call a JSON-RPC method on a `stdio` polyglot backend. */
export async function callBackend(
  opts: { key: string; blockId: string; wcId: number; codeDir: string; dataDir: string; manifest: BlockManifest },
  method: string,
  params: unknown,
  timeoutMs = 30000,
): Promise<unknown> {
  const inst = await ensureBackend(opts);
  if (inst.protocol !== "stdio") {
    throw new Error("bb.backend.call() is for 'stdio' protocol backends. Use bb.backend.fetch() for 'http' backends.");
  }
  if (!inst.child || !inst.child.stdin || inst.child.exitCode !== null) {
    throw new Error(inst.lastError || "Backend process is not running");
  }
  const id = inst.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inst.pending.delete(id);
      reject(new Error(`Backend call '${method}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    inst.pending.set(id, { resolve, reject, timer });
    const payload = JSON.stringify({ id, method, params: params ?? {} }) + "\n";
    inst.child!.stdin!.write(payload, (err) => {
      if (err) {
        clearTimeout(timer);
        inst.pending.delete(id);
        reject(new Error(`Failed to write to backend stdin: ${err.message}`));
      }
    });
  });
}

/** Proxy an HTTP request to a local `http` polyglot backend running on 127.0.0.1:$BB_PORT. */
export async function fetchBackend(
  opts: { key: string; blockId: string; wcId: number; codeDir: string; dataDir: string; manifest: BlockManifest },
  reqPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
): Promise<{ status: number; ok: boolean; headers: Record<string, string>; body: Uint8Array }> {
  const inst = await ensureBackend(opts);
  if (inst.protocol !== "http" || !inst.port) {
    throw new Error("bb.backend.fetch() is for 'http' protocol backends. Use bb.backend.call() for 'stdio' backends.");
  }
  const cleanPath = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const url = `http://127.0.0.1:${inst.port}${cleanPath}`;
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, ok: res.ok, headers, body };
}

export function stopBackend(key: string, resetCrashHistory = true): void {
  if (resetCrashHistory) crashHistory.delete(key);
  const inst = instances.get(key);
  if (!inst) return;
  inst.stopped = true;
  instances.delete(key);
  for (const [, p] of inst.pending) {
    clearTimeout(p.timer);
    p.reject(new Error("Backend stopped"));
  }
  inst.pending.clear();
  const c = inst.child;
  if (c?.pid) {
    try {
      c.stdin?.end();
    } catch {}
    try {
      if (process.platform === "win32") c.kill();
      else process.kill(-c.pid, "SIGTERM");
    } catch {
      try {
        c.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => {
      try {
        if (c.exitCode === null && c.pid) {
          if (process.platform === "win32") c.kill("SIGKILL");
          else process.kill(-c.pid, "SIGKILL");
        }
      } catch {}
    }, 1500);
  }
}

export function stopAllBackends(): void {
  for (const key of [...instances.keys()]) stopBackend(key);
}
