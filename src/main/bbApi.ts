/**
 * The bb.* API: the only bridge a block has to the outside world.
 * Every call is resolved to a block by the *sender's* webContents (never by anything the
 * page says), and checked against the permissions declared in block.json and approved by the user.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow, clipboard, dialog, ipcMain, net, webContents, type IpcMainInvokeEvent } from "electron";
import { effectivePermissions } from "../shared/blocks";
import { safeJoin } from "../shared/paths";
import { blockContexts, type BlockContext } from "./sandbox";
import { backendKey, callBackend, fetchBackend, setSupervisorCallbacks } from "./supervisor";

const STORAGE_LIMIT = 10 * 1024 * 1024;
const FILE_LIMIT = 512 * 1024 * 1024;

type Handle = { path: string; canWrite: boolean; isDir?: boolean };
/** File/directory handles from pickers, per block (or validation run). */
const handles = new Map<string, Map<string, Handle>>();

export function clearBlockHandles(blockId: string) {
  handles.delete(`live:${blockId}`);
}

export type BlockLogSink = (blockId: string, level: string, message: string) => void;
let logSink: BlockLogSink = () => {};
export function setBlockLogSink(sink: BlockLogSink) {
  logSink = sink;
}

class BBError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory cached + async-flushed storage (prevents main-thread UI freezes)
// ---------------------------------------------------------------------------
const storageCache = new Map<string, Record<string, unknown>>();
const storageQueues = new Map<string, Promise<void>>();
let tmpSeq = 0;

function storageFile(ctx: BlockContext) {
  return path.join(ctx.dataDir, "storage.json");
}

function readStorage(ctx: BlockContext): Record<string, unknown> {
  const cached = storageCache.get(ctx.dataDir);
  if (cached) return cached;
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(fs.readFileSync(storageFile(ctx), "utf8"));
  } catch {
    obj = {};
  }
  storageCache.set(ctx.dataDir, obj);
  return obj;
}

async function writeStorage(ctx: BlockContext, obj: Record<string, unknown>): Promise<void> {
  const text = JSON.stringify(obj);
  if (text.length > STORAGE_LIMIT) throw new BBError("quota", "bb.storage is limited to 10 MB. Use bb.data for large content.");
  storageCache.set(ctx.dataDir, obj);

  const prev = storageQueues.get(ctx.dataDir) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(ctx.dataDir, { recursive: true });
      const target = storageFile(ctx);
      const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`;
      await fs.promises.writeFile(tmp, text, "utf8");
      await fs.promises.rename(tmp, target);
    });
  storageQueues.set(ctx.dataDir, next);
  await next;
}

function dataPath(ctx: BlockContext, name: unknown): string {
  if (typeof name !== "string" || !name || name.length > 200) throw new BBError("invalid", "file name must be a non-empty string");
  if (name.split(/[\\/]/).some((s) => s.startsWith("."))) throw new BBError("invalid", "file names may not start with '.'");
  const p = safeJoin(path.join(ctx.dataDir, "files"), name);
  if (!p) throw new BBError("invalid", "file name escapes the block's data folder");
  return p;
}

function toBuffer(data: unknown): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  throw new BBError("invalid", "data must be a string, Uint8Array or ArrayBuffer");
}

function readOut(buf: Buffer, opts: unknown): string | Uint8Array {
  const enc = (opts as { encoding?: string } | undefined)?.encoding;
  if (enc === "utf8" || enc === "text") return buf.toString("utf8");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function requireFs(ctx: BlockContext) {
  if (effectivePermissions(ctx.manifest).fs !== "user-picked-files")
    throw new BBError("permission", `This block did not declare "permissions": { "fs": "user-picked-files" } in block.json`);
}

function hostAllowed(ctx: BlockContext, url: URL): boolean {
  const netPerm = effectivePermissions(ctx.manifest).network;
  if (netPerm === true) return true;
  if (!Array.isArray(netPerm)) return false;
  return netPerm.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

function ownerWindow(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows().find((w) => w.isVisible());
}

function handleMap(ctx: BlockContext, e: IpcMainInvokeEvent) {
  const key = ctx.validating ? `val:${e.sender.id}` : `live:${ctx.blockId}`;
  let m = handles.get(key);
  if (!m) {
    m = new Map();
    handles.set(key, m);
    if (ctx.validating) {
      e.sender.once("destroyed", () => handles.delete(key));
    }
  }
  return m;
}

type Method = (ctx: BlockContext, e: IpcMainInvokeEvent, ...args: any[]) => unknown;

const methods: Record<string, Method> = {
  "info": (ctx) => ({
    id: ctx.manifest.id,
    name: ctx.manifest.name,
    version: ctx.manifest.version,
    mode: ctx.manifest.mode,
    backend: ctx.manifest.backend ? { language: ctx.manifest.backend.language, protocol: ctx.manifest.backend.protocol ?? "stdio" } : null,
    sdk: "1.0.0",
    permissions: effectivePermissions(ctx.manifest),
  }),
  "ready": (ctx) => {
    ctx.ready = true;
    return true;
  },
  "log": (ctx, _e, level: string, message: string) => {
    logSink(ctx.blockId, ["info", "warn", "error"].includes(level) ? level : "info", String(message).slice(0, 4000));
  },

  // ---- storage: small JSON key/value, persisted in data/storage.json ----
  "storage.get": (ctx, _e, key: string) => readStorage(ctx)[String(key)] ?? null,
  "storage.set": async (ctx, _e, key: string, value: unknown) => {
    const s = { ...readStorage(ctx) };
    s[String(key)] = value === undefined ? null : JSON.parse(JSON.stringify(value));
    await writeStorage(ctx, s);
    return true;
  },
  "storage.delete": async (ctx, _e, key: string) => {
    const s = { ...readStorage(ctx) };
    delete s[String(key)];
    await writeStorage(ctx, s);
    return true;
  },
  "storage.keys": (ctx) => Object.keys(readStorage(ctx)),

  // ---- data: the block's private file area, data/files/ ----
  "data.read": async (ctx, _e, name: string, opts) => {
    const p = dataPath(ctx, name);
    if (!fs.existsSync(p)) return null;
    return readOut(await fs.promises.readFile(p), opts);
  },
  "data.write": async (ctx, _e, name: string, data: unknown) => {
    const p = dataPath(ctx, name);
    const buf = toBuffer(data);
    if (buf.length > FILE_LIMIT) throw new BBError("quota", "files are limited to 512 MB");
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, buf);
    return true;
  },
  "data.delete": async (ctx, _e, name: string) => {
    await fs.promises.rm(dataPath(ctx, name), { force: true });
    return true;
  },
  "data.list": async (ctx) => {
    const root = path.join(ctx.dataDir, "files");
    if (!fs.existsSync(root)) return [];
    const out: { name: string; size: number; modified: number }[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else {
          const st = fs.statSync(p);
          out.push({ name: path.relative(root, p).split(path.sep).join("/"), size: st.size, modified: st.mtimeMs });
        }
      }
    };
    walk(root);
    return out;
  },

  // ---- fs: user-picked files & directories ----
  "fs.pickOpen": async (
    ctx,
    e,
    opts: { multiple?: boolean; writable?: boolean; filters?: { name: string; extensions: string[] }[]; title?: string } = {},
  ) => {
    requireFs(ctx);
    if (ctx.validating) return [];
    const win = ownerWindow(e);
    const props: ("openFile" | "multiSelections")[] = ["openFile"];
    if (opts.multiple) props.push("multiSelections");
    const res = win
      ? await dialog.showOpenDialog(win, { title: opts.title, properties: props, filters: opts.filters })
      : await dialog.showOpenDialog({ title: opts.title, properties: props, filters: opts.filters });
    if (res.canceled) return [];
    const m = handleMap(ctx, e);
    return res.filePaths.map((p) => {
      const handle = crypto.randomUUID();
      m.set(handle, { path: p, canWrite: Boolean(opts.writable) });
      return { handle, name: path.basename(p), size: fs.statSync(p).size, writable: Boolean(opts.writable) };
    });
  },
  "fs.pickSave": async (ctx, e, opts: { suggestedName?: string; filters?: { name: string; extensions: string[] }[]; title?: string } = {}) => {
    requireFs(ctx);
    if (ctx.validating) return null;
    const win = ownerWindow(e);
    const o = { title: opts.title, defaultPath: opts.suggestedName ? path.basename(opts.suggestedName) : undefined, filters: opts.filters };
    const res = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
    if (res.canceled || !res.filePath) return null;
    const handle = crypto.randomUUID();
    handleMap(ctx, e).set(handle, { path: res.filePath, canWrite: true });
    return { handle, name: path.basename(res.filePath) };
  },
  "fs.pickDirectory": async (ctx, e, opts: { writable?: boolean; title?: string } = {}) => {
    requireFs(ctx);
    if (ctx.validating) return null;
    const win = ownerWindow(e);
    const props: ("openDirectory" | "createDirectory")[] = ["openDirectory"];
    if (opts.writable) props.push("createDirectory");
    const res = win
      ? await dialog.showOpenDialog(win, { title: opts.title, properties: props })
      : await dialog.showOpenDialog({ title: opts.title, properties: props });
    if (res.canceled || !res.filePaths[0]) return null;
    const dirPath = res.filePaths[0];
    const handle = crypto.randomUUID();
    handleMap(ctx, e).set(handle, { path: dirPath, canWrite: Boolean(opts.writable), isDir: true });
    return { handle, name: path.basename(dirPath), writable: Boolean(opts.writable) };
  },
  "fs.read": async (ctx, e, handle: string, opts) => {
    requireFs(ctx);
    const h = handleMap(ctx, e).get(String(handle));
    if (!h || h.isDir) throw new BBError("invalid", "unknown file handle (handles only last while the block is open)");
    return readOut(await fs.promises.readFile(h.path), opts);
  },
  "fs.write": async (ctx, e, handle: string, data: unknown) => {
    requireFs(ctx);
    const h = handleMap(ctx, e).get(String(handle));
    if (!h || h.isDir) throw new BBError("invalid", "unknown file handle");
    if (!h.canWrite) throw new BBError("permission", "this handle is read-only. Pass { writable: true } to bb.fs.pickOpen() or use bb.fs.pickSave().");
    await fs.promises.writeFile(h.path, toBuffer(data));
    return true;
  },
  "fs.listDir": async (ctx, e, dirHandle: string, relDir = "") => {
    requireFs(ctx);
    const h = handleMap(ctx, e).get(String(dirHandle));
    if (!h || !h.isDir) throw new BBError("invalid", "unknown directory handle");
    const target = relDir ? safeJoin(h.path, String(relDir)) : h.path;
    if (!target || !fs.existsSync(target)) throw new BBError("invalid", "directory path does not exist or escapes picked folder");
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    return entries
      .filter((ent) => !ent.name.startsWith("."))
      .map((ent) => {
        const full = path.join(target, ent.name);
        let size = 0;
        let modified = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          modified = st.mtimeMs;
        } catch {}
        return { name: ent.name, isDirectory: ent.isDirectory(), size, modified };
      });
  },
  "fs.readDirFile": async (ctx, e, dirHandle: string, relPath: string, opts) => {
    requireFs(ctx);
    const h = handleMap(ctx, e).get(String(dirHandle));
    if (!h || !h.isDir) throw new BBError("invalid", "unknown directory handle");
    const target = safeJoin(h.path, String(relPath));
    if (!target || !fs.existsSync(target)) throw new BBError("invalid", "file path does not exist or escapes picked folder");
    return readOut(await fs.promises.readFile(target), opts);
  },
  "fs.writeDirFile": async (ctx, e, dirHandle: string, relPath: string, data: unknown) => {
    requireFs(ctx);
    const h = handleMap(ctx, e).get(String(dirHandle));
    if (!h || !h.isDir) throw new BBError("invalid", "unknown directory handle");
    if (!h.canWrite) throw new BBError("permission", "directory was opened read-only. Pass { writable: true } to bb.fs.pickDirectory().");
    const target = safeJoin(h.path, String(relPath));
    if (!target) throw new BBError("invalid", "file path escapes picked folder");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, toBuffer(data));
    return true;
  },

  // ---- clipboard ----
  "clipboard.readText": (ctx) => {
    if (!effectivePermissions(ctx.manifest).clipboard) throw new BBError("permission", `This block did not declare "clipboard": true`);
    return ctx.validating ? "" : clipboard.readText();
  },
  "clipboard.writeText": (ctx, _e, text: string) => {
    if (!effectivePermissions(ctx.manifest).clipboard) throw new BBError("permission", `This block did not declare "clipboard": true`);
    if (!ctx.validating) clipboard.writeText(String(text));
    return true;
  },

  // ---- network: HTTPS only, to hosts declared in block.json ----
  "net.fetch": async (ctx, _e, url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      throw new BBError("invalid", "bb.net.fetch needs an absolute https:// URL");
    }
    if (u.protocol !== "https:") throw new BBError("permission", "only https:// URLs are allowed");
    if (!hostAllowed(ctx, u)) throw new BBError("permission", `host '${u.hostname}' is not listed in "permissions.network" in block.json`);
    const res = await net.fetch(u.toString(), {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body),
      credentials: "omit",
      redirect: "follow",
    } as RequestInit);
    const body = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, ok: res.ok, url: res.url, headers, body };
  },

  // ---- polyglot backend bridge (Python, Swift, Rust, C++, Go, Node.js) ----
  "backend.info": (ctx) => ({
    enabled: ctx.manifest.mode === "polyglot" && !!ctx.manifest.backend,
    language: ctx.manifest.backend?.language ?? null,
    protocol: ctx.manifest.backend?.protocol ?? "stdio",
  }),
  "backend.call": async (ctx, e, method: string, params?: unknown, timeoutMs?: number) => {
    if (ctx.manifest.mode !== "polyglot" || !ctx.manifest.backend) {
      throw new BBError("permission", `This block is not in "mode": "polyglot" with a "backend" in block.json`);
    }
    if (typeof method !== "string" || !method) throw new BBError("invalid", "method name must be a non-empty string");
    const key = backendKey(ctx.blockId, e.sender.id, ctx.validating);
    return callBackend(
      { key, blockId: ctx.blockId, wcId: e.sender.id, codeDir: ctx.codeDir, dataDir: ctx.dataDir, manifest: ctx.manifest },
      method,
      params,
      typeof timeoutMs === "number" ? timeoutMs : 30000,
    );
  },
  "backend.fetch": async (ctx, e, reqPath: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {}) => {
    if (ctx.manifest.mode !== "polyglot" || !ctx.manifest.backend) {
      throw new BBError("permission", `This block is not in "mode": "polyglot" with a "backend" in block.json`);
    }
    const key = backendKey(ctx.blockId, e.sender.id, ctx.validating);
    return fetchBackend(
      { key, blockId: ctx.blockId, wcId: e.sender.id, codeDir: ctx.codeDir, dataDir: ctx.dataDir, manifest: ctx.manifest },
      String(reqPath),
      init,
    );
  },

  // ---- event bus between open blocks ----
  "emit": (ctx, e, name: string, data: unknown) => {
    if (typeof name !== "string" || !/^[a-zA-Z][\w.-]{0,63}$/.test(name)) throw new BBError("invalid", "event name must be a short identifier");
    const payload = JSON.parse(JSON.stringify(data ?? null));
    for (const [wcId, other] of blockContexts.all()) {
      if (wcId === e.sender.id || other.validating) continue;
      webContents.fromId(wcId)?.send("bb:event", { from: ctx.blockId, name, data: payload });
    }
    return true;
  },
};

export function installBBApi(): void {
  setSupervisorCallbacks({
    onLog: (blockId, level, text) => logSink(blockId, level, text),
    onEvent: (wcId, event, data) => {
      webContents.fromId(wcId)?.send("bb:backend-event", { event, data });
    },
  });
  ipcMain.handle("bb:call", async (e, method: string, ...args: unknown[]) => {
    const ctx = blockContexts.get(e.sender);
    if (!ctx) throw new BBError("denied", "not a block");
    const fn = methods[method];
    if (!fn) throw new BBError("invalid", `unknown bb method '${method}'`);
    return fn(ctx, e, ...args);
  });
}
