import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Rectangle,
} from "electron";
import {
  createBlock,
  deleteBlockToTrash,
  describePermissions,
  history,
  listBlocks,
  needsApproval,
  permissionsHash,
  staticCheck,
  suggestTemplate,
  TEMPLATES,
  uniqueId,
  type BlockManifest,
  type TemplateName,
} from "../shared/blocks";
import { APP_ROOT, IS_PACKAGED, SKILL_PATH, bbHome, paths } from "../shared/paths";
import { detectAgents, runAgentJob, type AgentId, type AgentJob, type CustomAgentConfig } from "./agent";
import { clearBlockHandles, setBlockLogSink } from "./bbApi";
import { testDirectApi } from "./directAgent";
import { detectRuntimes, findBinary } from "./runtimes";
import { blockContexts, blockSession, blockUrl, blockWebPreferences, consoleDetails, lockNavigation, type BlockContext } from "./sandbox";
import { backendKey, ensureBackend, stopAllBackends, stopBackend } from "./supervisor";
import { validateBlock } from "./validate";

const DIST = path.join(APP_ROOT, "dist");
const BLOCK_PRELOAD = path.join(DIST, "preload-block.js");

interface OpenView {
  view: WebContentsView;
  ctx: BlockContext;
}

interface Settings {
  agent: AgentId;
  customAgents?: CustomAgentConfig[];
}

let win: BrowserWindow | null = null;
const views = new Map<string, OpenView>();
const opening = new Map<string, Promise<BlockManifest>>();
let activeId: string | null = null;
let splitId: string | null = null;
let primaryBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
let secondaryBounds: Rectangle | null = null;
const jobs = new Map<string, { job: AgentJob; blockId: string }>();
const logs = new Map<string, { at: number; level: string; text: string }[]>();
let jobSeq = 0;

// ---------------------------------------------------------------------------
// settings & approvals
// ---------------------------------------------------------------------------
function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function settings(): Settings {
  return readJson<Settings>(paths.settingsFile(), { agent: "claude", customAgents: [] });
}

async function ensureApproved(m: BlockManifest): Promise<boolean> {
  if (!needsApproval(m)) return true;
  const approvals = readJson<Record<string, string>>(paths.approvalsFile(), {});
  const hash = permissionsHash(m);
  if (approvals[m.id] === hash) return true;
  const opts = {
    type: "question" as const,
    message: `Allow “${m.name}” to:`,
    detail: describePermissions(m).map((l) => `•  ${l}`).join("\n") + "\n\nYou'll be asked again if the block's permissions or backend command change.",
    buttons: ["Allow", "Don’t Allow"],
    defaultId: 0,
    cancelId: 1,
  };
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (res.response !== 0) return false;
  approvals[m.id] = hash;
  writeJson(paths.approvalsFile(), approvals);
  return true;
}

// ---------------------------------------------------------------------------
// block views
// ---------------------------------------------------------------------------
function pushLog(id: string, level: string, text: string) {
  const list = logs.get(id) ?? [];
  list.push({ at: Date.now(), level, text });
  if (list.length > 500) list.splice(0, list.length - 500);
  logs.set(id, list);
  fs.promises.appendFile(path.join(paths.metaDir(id), "console.log"), `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`).catch(() => {});
  win?.webContents.send("host:block-log", { id, level, text });
}
setBlockLogSink(pushLog);

function viewBgColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0b1120" : "#ffffff";
}

function loadManifestOrThrow(id: string): BlockManifest {
  const { manifest, problems } = staticCheck(paths.codeDir(id), id);
  if (!manifest) throw new Error(problems.map((p) => p.message).join("; ") || "block.json is invalid");
  const fatal = problems.filter((p) => p.step === "manifest" || (p.step === "files" && /entry\.ui/.test(p.message)));
  if (fatal.length) throw new Error(fatal.map((p) => p.message).join("; "));
  return manifest;
}

async function openBlock(id: string, asSplit = false): Promise<BlockManifest> {
  if (!win) throw new Error("no window");
  const existing = views.get(id);
  if (existing) {
    if (asSplit && activeId && activeId !== id) showBlock(activeId, id);
    else showBlock(id, splitId === id ? null : splitId);
    return existing.ctx.manifest;
  }
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;

  const p = (async () => {
    const manifest = loadManifestOrThrow(id);
    if (!(await ensureApproved(manifest))) throw new Error("You didn't allow this block's permissions, so it wasn't opened.");
    if (!win) throw new Error("no window");

    const partition = `persist:block-${id}`;
    const codeDir = paths.codeDir(id);
    const dataDir = paths.dataDir(id);
    blockSession(partition, id, codeDir);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(paths.metaDir(id), { recursive: true });

    const view = new WebContentsView({ webPreferences: blockWebPreferences(partition, BLOCK_PRELOAD) });
    view.setBackgroundColor(viewBgColor());
    const wc = view.webContents;
    const ctx: BlockContext = { blockId: id, codeDir, dataDir, manifest, validating: false, ready: false };
    blockContexts.set(wc, ctx);
    lockNavigation(wc, id);
    wc.on("console-message", (...args: unknown[]) => {
      const d = consoleDetails(args);
      if (/Electron Security Warning/.test(d.message)) return;
      pushLog(id, d.level === "warning" ? "warn" : d.level, d.message);
    });
    wc.on("render-process-gone", (_e, d) => {
      pushLog(id, "error", `Block process ended: ${d.reason}`);
      win?.webContents.send("host:block-crashed", { id, reason: d.reason });
    });
    wc.on("did-fail-load", (_e, code, desc, url) => {
      if (code !== -3) pushLog(id, "error", `Failed to load ${url}: ${desc}`);
    });

    // Record the view immediately so clicking the block while its backend compiles never opens a second view.
    views.set(id, { view, ctx });
    win.contentView.addChildView(view);
    if (asSplit && activeId && activeId !== id) showBlock(activeId, id);
    else showBlock(id, splitId === id ? null : splitId);
    applyViewBounds();

    if (manifest.mode === "polyglot" && manifest.backend) {
      try {
        await ensureBackend({ key: backendKey(id, wc.id, false), blockId: id, wcId: wc.id, codeDir, dataDir, manifest });
      } catch (e) {
        pushLog(id, "error", `Backend startup failed: ${(e as Error).message}`);
      }
    }

    if (views.get(id)?.view === view) {
      await wc.loadURL(blockUrl(manifest)).catch((e) => pushLog(id, "error", String(e.message ?? e)));
    }
    return manifest;
  })();

  opening.set(id, p);
  try {
    return await p;
  } finally {
    opening.delete(id);
  }
}

function applyViewBounds() {
  for (const [vid, v] of views) {
    if (vid === activeId) {
      v.view.setBounds(primaryBounds);
      v.view.setVisible(true);
    } else if (vid === splitId && secondaryBounds) {
      v.view.setBounds(secondaryBounds);
      v.view.setVisible(true);
    } else {
      v.view.setVisible(false);
    }
  }
}

function showBlock(id: string | null, nextSplitId?: string | null) {
  activeId = id && views.has(id) ? id : null;
  if (nextSplitId !== undefined) {
    splitId = nextSplitId && views.has(nextSplitId) && nextSplitId !== activeId ? nextSplitId : null;
  } else if (!activeId || splitId === activeId) {
    splitId = null;
  }
  applyViewBounds();
  if (activeId) views.get(activeId)!.view.webContents.focus();
}

function closeBlock(id: string) {
  const v = views.get(id);
  if (!v) return;
  stopBackend(backendKey(id, v.view.webContents.id, false));
  clearBlockHandles(id);
  win?.contentView.removeChildView(v.view);
  v.view.webContents.close();
  views.delete(id);
  if (activeId === id) {
    activeId = splitId;
    splitId = null;
  } else if (splitId === id) {
    splitId = null;
  }
  applyViewBounds();
}

async function reloadBlock(id: string): Promise<void> {
  const v = views.get(id);
  if (!v) return;
  let manifest: BlockManifest;
  try {
    manifest = loadManifestOrThrow(id);
  } catch (e) {
    pushLog(id, "error", `Not reloaded: ${(e as Error).message}`);
    return;
  }
  if (permissionsHash(manifest) !== permissionsHash(v.ctx.manifest) && !(await ensureApproved(manifest))) {
    pushLog(id, "warn", "New permissions were not approved; closing the block.");
    closeBlock(id);
    win?.webContents.send("host:block-closed", { id });
    return;
  }
  const bKey = backendKey(id, v.view.webContents.id, false);
  stopBackend(bKey);
  v.ctx.manifest = manifest;
  v.ctx.ready = false;
  if (manifest.mode === "polyglot" && manifest.backend) {
    try {
      await ensureBackend({
        key: bKey,
        blockId: id,
        wcId: v.view.webContents.id,
        codeDir: v.ctx.codeDir,
        dataDir: v.ctx.dataDir,
        manifest,
      });
    } catch (e) {
      pushLog(id, "error", `Backend restart failed: ${(e as Error).message}`);
    }
  }
  await v.view.webContents.loadURL(blockUrl(manifest)).catch(() => {});
}

// ---------------------------------------------------------------------------
// block list for the UI (with cached thumbnails from the last validation screenshot)
// ---------------------------------------------------------------------------
const thumbCache = new Map<string, { mtime: number; url: string }>();
function thumbnail(id: string): string | null {
  const file = path.join(paths.metaDir(id), "screenshot.png");
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const c = thumbCache.get(id);
    if (c && c.mtime === mtime) return c.url;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const url = "data:image/jpeg;base64," + img.resize({ width: 480, quality: "good" }).toJPEG(78).toString("base64");
    thumbCache.set(id, { mtime, url });
    return url;
  } catch {
    return null;
  }
}

function blockList() {
  const running = new Set([...jobs.values()].map((j) => j.blockId));
  return listBlocks().map((b) => ({
    id: b.id,
    ok: b.ok,
    error: b.error,
    name: b.manifest?.name ?? b.id,
    description: b.manifest?.description ?? "",
    icon: b.manifest?.icon ?? "▦",
    version: b.manifest?.version ?? "",
    mode: b.manifest?.mode ?? "web",
    language: b.manifest?.backend?.language ?? null,
    permissions: b.manifest ? describePermissions(b.manifest) : [],
    open: views.has(b.id),
    building: running.has(b.id),
    thumb: thumbnail(b.id),
    updatedAt: b.updatedAt,
  }));
}

let notifyTimer: NodeJS.Timeout | undefined;
function notifyBlocksChanged() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => win?.webContents.send("host:blocks-changed"), 250);
}

// Live reload: when a block's code changes on disk (agent, CLI or a human), reload its open view.
const reloadTimers = new Map<string, NodeJS.Timeout>();
function watchBlocks() {
  fs.mkdirSync(paths.blocksDir(), { recursive: true });
  try {
    fs.watch(paths.blocksDir(), { recursive: true }, (_ev, file) => {
      if (!file) return;
      const parts = file.split(path.sep);
      const id = parts[0];
      if (parts[1] === "code" && parts[2] !== ".git" && parts[2] !== ".bin") {
        if (parts.length === 3 && parts[2] === "block.json") notifyBlocksChanged();
        if (views.has(id) && ![...jobs.values()].some((j) => j.blockId === id)) {
          clearTimeout(reloadTimers.get(id));
          reloadTimers.set(id, setTimeout(() => reloadBlock(id), 500));
        }
      } else if (parts.length <= 2) notifyBlocksChanged();
    });
  } catch (e) {
    console.warn("watch failed", e);
  }
}

// ---------------------------------------------------------------------------
// CLI bridge: a Unix socket (or Windows Named Pipe) so `bassblock run/reload` reach the running host
// ---------------------------------------------------------------------------
function startSocketServer() {
  const sock = paths.hostSocket();
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    try {
      fs.unlinkSync(sock);
    } catch {}
  }
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", async (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      let reply: unknown;
      try {
        const msg = JSON.parse(buf.slice(0, i)) as { cmd: string; id?: string };
        reply = await handleCli(msg);
      } catch (e) {
        reply = { ok: false, error: (e as Error).message };
      }
      c.end(JSON.stringify(reply) + "\n");
    });
  });
  server.on("error", (e) => console.error(`[bassblock] CLI socket unavailable at ${sock}: ${e.message}`));
  server.listen(sock, () => {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(sock, 0o600);
      } catch {}
    }
  });
  app.on("will-quit", () => {
    server.close();
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(sock);
      } catch {}
    }
  });
}

async function handleCli(msg: { cmd: string; id?: string }) {
  switch (msg.cmd) {
    case "ping":
      return { ok: true, pid: process.pid };
    case "open":
      if (!msg.id) throw new Error("missing id");
      focusWindow();
      await openBlock(msg.id);
      win?.webContents.send("host:navigate", { id: msg.id });
      notifyBlocksChanged();
      return { ok: true };
    case "reload":
      if (!msg.id) throw new Error("missing id");
      notifyBlocksChanged();
      if (!views.has(msg.id)) return { ok: true, note: "block is not open; nothing to reload" };
      await reloadBlock(msg.id);
      return { ok: true };
    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Put a `bassblock` command where agents (and the user) can find it. Runs the CLI with this app's Electron. */
export function installCliShim(): string {
  fs.mkdirSync(paths.binDir(), { recursive: true });
  const cliJs = path.join(DIST, "cli.js");
  if (process.platform === "win32") {
    const cmdFile = path.join(paths.binDir(), "bassblock.cmd");
    const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset BB_ELECTRON=${process.execPath}\r\n"${process.execPath}" "${cliJs}" %*\r\n`;
    if (!fs.existsSync(cmdFile) || fs.readFileSync(cmdFile, "utf8") !== content) {
      fs.writeFileSync(cmdFile, content);
    }
    return cmdFile;
  }
  const bin = path.join(paths.binDir(), "bassblock");
  const script = `#!/bin/sh
# Generated by BASS BLOCK. Runs the bassblock CLI using the app's bundled runtime.
ELECTRON_RUN_AS_NODE=1 BB_ELECTRON="${process.execPath}" exec "${process.execPath}" "${cliJs}" "$@"
`;
  if (!fs.existsSync(bin) || fs.readFileSync(bin, "utf8") !== script) {
    fs.writeFileSync(bin, script, { mode: 0o755 });
  }
  return bin;
}

/**
 * Install the `bass-block-builder` skill and `bassblock` CLI shim into standard external
 * agent discovery directories (Antigravity, Claude Code, and ~/.local/bin).
 */
export function installExternalSkill(): { installed: string[] } {
  const binShim = installCliShim();
  const home = os.homedir();
  const installed: string[] = [binShim];

  const skillTargets = [
    path.join(home, ".gemini", "antigravity", "skills", "bass-block-builder", "SKILL.md"),
    path.join(home, ".claude", "skills", "bass-block-builder", "SKILL.md"),
  ];
  const skillContent = fs.readFileSync(SKILL_PATH, "utf8");
  for (const target of skillTargets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, skillContent, "utf8");
      installed.push(target);
    } catch {}
  }

  if (process.platform !== "win32") {
    const localBin = path.join(home, ".local", "bin", "bassblock");
    try {
      fs.mkdirSync(path.dirname(localBin), { recursive: true });
      let canReplace = false;
      try {
        const st = fs.lstatSync(localBin);
        if (st.isSymbolicLink()) {
          const target = fs.readlinkSync(localBin);
          if (target === binShim || /bassblock/i.test(target)) {
            fs.unlinkSync(localBin);
            canReplace = true;
          }
        }
      } catch {
        // Does not exist yet
        canReplace = true;
      }
      if (canReplace) {
        fs.symlinkSync(binShim, localBin);
        installed.push(localBin);
      }
    } catch {}
  }
  return { installed };
}

// ---------------------------------------------------------------------------
// host IPC
// ---------------------------------------------------------------------------
function hostHandle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!win || e.sender !== win.webContents) throw new Error("denied");
    return fn(...args);
  });
}

function guessName(request: string): string {
  const words = request
    .replace(/^(a|an|the|make|create|build|me|i want|i need)\s+/gi, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4);
  const s = words.join(" ");
  return s ? s[0].toUpperCase() + s.slice(1) : "New block";
}

function installHostIpc() {
  hostHandle("host:info", () => ({
    home: bbHome(),
    version: app.getVersion(),
    templates: TEMPLATES,
    platform: process.platform,
    arch: process.arch,
  }));
  hostHandle("host:listBlocks", () => blockList());
  hostHandle("host:getSettings", () => settings());
  hostHandle("host:setSettings", (patch: Partial<Settings>) => {
    const cur = settings();
    const next: Settings = {
      ...cur,
      ...patch,
      agent: typeof patch.agent === "string" && patch.agent.trim() ? patch.agent.trim() : cur.agent,
    };
    writeJson(paths.settingsFile(), next);
    return next;
  });
  hostHandle("host:detectAgents", () => detectAgents(settings().customAgents ?? []));
  hostHandle("host:saveCustomAgent", async (cfg: CustomAgentConfig) => {
    if (!cfg || typeof cfg.label !== "string" || !cfg.label.trim()) throw new Error("Agent name is required.");
    const cur = settings();
    const list = [...(cur.customAgents ?? [])];
    const id = cfg.id?.trim() || `custom-${Date.now().toString(36)}`;
    let entry: CustomAgentConfig;
    if (cfg.kind === "cli") {
      if (!cfg.command?.trim()) throw new Error("CLI command or binary path is required.");
      entry = {
        id,
        label: cfg.label.trim().slice(0, 60),
        kind: "cli",
        command: cfg.command.trim(),
        argsTemplate: cfg.argsTemplate?.trim() || undefined,
        env: cfg.env,
      };
    } else if (cfg.kind === "api") {
      if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) throw new Error("Base URL and Model name are required.");
      entry = {
        id,
        label: cfg.label.trim().slice(0, 60),
        kind: "api",
        baseUrl: cfg.baseUrl.trim(),
        model: cfg.model.trim(),
        apiKey: cfg.apiKey?.trim() || undefined,
      };
    } else {
      throw new Error("Invalid agent kind");
    }
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    const next: Settings = { ...cur, agent: id, customAgents: list };
    writeJson(paths.settingsFile(), next);
    const agents = await detectAgents(list);
    return { settings: next, agents };
  });
  hostHandle("host:deleteCustomAgent", async (id: string) => {
    const cur = settings();
    const list = (cur.customAgents ?? []).filter((a) => a.id !== id);
    const agents = await detectAgents(list);
    const nextAgent = cur.agent === id ? (agents.find((a) => a.path)?.id ?? "claude") : cur.agent;
    const next: Settings = { ...cur, agent: nextAgent, customAgents: list };
    writeJson(paths.settingsFile(), next);
    return { settings: next, agents };
  });
  hostHandle("host:testAgent", async (cfg: CustomAgentConfig) => {
    if (cfg.kind === "cli") {
      const cmd = cfg.command?.trim() ?? "";
      if (!cmd) return { ok: false, message: "Enter a command or binary path." };
      const found = cmd.includes("/") || cmd.includes("\\") ? (fs.existsSync(cmd) ? cmd : null) : findBinary(cmd);
      return found ? { ok: true, message: `Found binary at ${found}` } : { ok: false, message: `Binary '${cmd}' not found on PATH` };
    }
    return testDirectApi({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
  });
  hostHandle("host:detectRuntimes", () => detectRuntimes(true));
  hostHandle("host:installSkill", () => installExternalSkill());
  hostHandle("host:createFromTemplate", (name: string, template: TemplateName) => {
    const id = uniqueId(name || template);
    createBlock({ id, name: name || undefined, template });
    notifyBlocksChanged();
    return { id };
  });
  hostHandle("host:openBlock", async (id: string, asSplit = false) => {
    const m = await openBlock(id, Boolean(asSplit));
    notifyBlocksChanged();
    return { id: m.id, name: m.name, icon: m.icon ?? "▦", version: m.version };
  });
  hostHandle("host:closeBlock", (id: string) => {
    closeBlock(id);
    notifyBlocksChanged();
  });
  hostHandle("host:showBlock", (id: string | null, nextSplitId?: string | null) => showBlock(id, nextSplitId));
  hostHandle("host:capturePreview", async () => {
    if (!activeId || !views.has(activeId)) return null;
    try {
      const img = await views.get(activeId)!.view.webContents.capturePage();
      if (img.isEmpty()) return null;
      return "data:image/jpeg;base64," + img.toJPEG(82).toString("base64");
    } catch {
      return null;
    }
  });
  hostHandle("host:setViewBounds", (primary: Rectangle, secondary?: Rectangle | null) => {
    primaryBounds = {
      x: Math.round(primary.x),
      y: Math.round(primary.y),
      width: Math.max(0, Math.round(primary.width)),
      height: Math.max(0, Math.round(primary.height)),
    };
    secondaryBounds = secondary
      ? {
          x: Math.round(secondary.x),
          y: Math.round(secondary.y),
          width: Math.max(0, Math.round(secondary.width)),
          height: Math.max(0, Math.round(secondary.height)),
        }
      : null;
    applyViewBounds();
  });
  hostHandle("host:reloadBlock", (id: string) => reloadBlock(id));
  hostHandle("host:devtools", (id: string) => views.get(id)?.view.webContents.toggleDevTools());
  hostHandle("host:logs", (id: string) => logs.get(id) ?? []);
  hostHandle("host:clearLogs", (id: string) => logs.set(id, []));
  hostHandle("host:history", (id: string) => history.list(id));
  hostHandle("host:restoreHistory", async (id: string, ref: string) => {
    const restored = history.restoreTo(id, ref);
    if (restored) {
      await reloadBlock(id);
      notifyBlocksChanged();
    }
    return restored;
  });
  hostHandle("host:undoAi", async (id: string) => {
    const undone = history.undoLastAiChange(id);
    if (undone) {
      await reloadBlock(id);
      notifyBlocksChanged();
    }
    return undone;
  });
  hostHandle("host:reveal", (id: string) => shell.showItemInFolder(paths.codeDir(id)));
  hostHandle("host:revealHome", () => shell.openPath(bbHome()));
  hostHandle("host:deleteBlock", async (id: string) => {
    const m = listBlocks().find((b) => b.id === id)?.manifest;
    const res = await dialog.showMessageBox(win!, {
      type: "warning",
      message: `Move “${m?.name ?? id}” to the BASS BLOCK trash?`,
      detail: `Its code and data move to ${path.join(paths.stateDir(), "trash")}. You can restore them by moving the folder back.`,
      buttons: ["Move to Trash", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (res.response !== 0) return false;
    closeBlock(id);
    deleteBlockToTrash(id);
    notifyBlocksChanged();
    return true;
  });
  hostHandle("host:metrics", () => {
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
    const out: Record<string, { memoryMb: number; cpu: number }> = {};
    for (const [id, v] of views) {
      const m = byPid.get(v.view.webContents.getOSProcessId());
      if (m) out[id] = { memoryMb: Math.round(m.memory.workingSetSize / 1024), cpu: Math.round(m.cpu.percentCPUUsage) };
    }
    return out;
  });

  hostHandle("host:startAgent", async (req: { kind: "create" | "edit"; id?: string; request: string; agent?: AgentId }) => {
    const request = String(req.request ?? "").trim();
    if (request.length < 3) throw new Error("Describe what you want first.");
    const curSettings = settings();
    const agentId = req.agent ?? curSettings.agent;
    const allAgents = await detectAgents(curSettings.customAgents ?? []);
    const agent = allAgents.find((a) => a.id === agentId);
    if (!agent?.path) throw new Error(`${agent?.label ?? agentId} isn't installed or configured.`);
    let blockId = req.id;
    if (req.kind === "create") {
      const runtimes = detectRuntimes();
      const hasPython = Boolean(runtimes.find((r) => r.id === "python")?.path);
      const hasSwift = Boolean(runtimes.find((r) => r.id === "swift")?.path);
      const template = suggestTemplate(request, hasPython, hasSwift);
      blockId = uniqueId(guessName(request));
      createBlock({ id: blockId, name: guessName(request), description: request.slice(0, 400), template });
      notifyBlocksChanged();
    }
    if (!blockId || !fs.existsSync(paths.codeDir(blockId))) throw new Error("Block not found");
    if ([...jobs.values()].some((j) => j.blockId === blockId)) throw new Error("An AI job is already running for this block.");
    const jobId = `job-${++jobSeq}`;
    const id = blockId;
    const isNewCreate = req.kind === "create";
    const job = runAgentJob({
      agent,
      blockId: id,
      kind: req.kind,
      request,
      validate: () =>
        validateBlock(paths.codeDir(id), {
          blockPreload: BLOCK_PRELOAD,
          expectedId: id,
          screenshotPath: path.join(paths.metaDir(id), "screenshot.png"),
        }),
      onEvent: (event) => win?.webContents.send("host:agent-event", { jobId, blockId: id, event }),
    });
    jobs.set(jobId, { job, blockId: id });
    job.done.then(
      async (res) => {
        jobs.delete(jobId);
        if (isNewCreate && res.cancelled) {
          closeBlock(id);
          try {
            fs.rmSync(paths.blockDir(id), { recursive: true, force: true });
          } catch {}
        } else if (views.has(id)) {
          await reloadBlock(id);
        }
        notifyBlocksChanged();
      },
      () => {
        jobs.delete(jobId);
        notifyBlocksChanged();
      },
    );
    notifyBlocksChanged();
    return { jobId, blockId: id };
  });

  // Native menus: they draw above block views, which HTML popovers can't.
  hostHandle("host:popupMenu", (items: { id?: string; label?: string; separator?: boolean; enabled?: boolean }[]) =>
    new Promise<string | null>((resolve) => {
      const menu = Menu.buildFromTemplate(
        items.map((i) =>
          i.separator ? { type: "separator" as const } : { label: i.label ?? "", enabled: i.enabled !== false, click: () => resolve(i.id ?? null) },
        ),
      );
      menu.popup({ window: win!, callback: () => setTimeout(() => resolve(null), 30) });
    }),
  );
  hostHandle("host:cancelAgent", (jobId: string) => jobs.get(jobId)?.job.cancel());
  hostHandle("host:validate", (id: string) =>
    validateBlock(paths.codeDir(id), {
      blockPreload: BLOCK_PRELOAD,
      expectedId: id,
      screenshotPath: path.join(paths.metaDir(id), "screenshot.png"),
    }).then((r) => {
      notifyBlocksChanged();
      return r;
    }),
  );
}

// ---------------------------------------------------------------------------
export function startHost(opts: { openId?: string; snapshot?: string }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", (_e, argv) => {
    focusWindow();
    const i = argv.indexOf("--bb-open");
    if (i >= 0 && argv[i + 1]) handleCli({ cmd: "open", id: argv[i + 1] }).catch(() => {});
  });

  app.whenReady().then(async () => {
    if (opts.snapshot && (process.env.BB_THEME === "light" || process.env.BB_THEME === "dark")) nativeTheme.themeSource = process.env.BB_THEME;
    if (!IS_PACKAGED) {
      const devIcon = path.join(APP_ROOT, "build", "icon.png");
      if (fs.existsSync(devIcon)) app.dock?.setIcon(devIcon);
    }
    fs.mkdirSync(paths.blocksDir(), { recursive: true });
    installCliShim();
    installHostIpc();
    startSocketServer();
    watchBlocks();

    nativeTheme.on("updated", () => {
      const bg = viewBgColor();
      for (const v of views.values()) v.view.setBackgroundColor(bg);
    });

    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 560,
      title: "BASS BLOCK",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
      visualEffectState: "followWindow",
      backgroundColor: process.platform === "darwin" ? "#00000000" : viewBgColor(),
      show: !opts.snapshot,
      webPreferences: {
        preload: path.join(DIST, "preload-host.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("closed", () => {
      win = null;
      stopAllBackends();
      for (const id of [...views.keys()]) views.delete(id);
    });
    process.env.BB_DEBUG && process.stderr.write("[host] ready\n");
    installAppMenu();
    win.webContents.on("did-finish-load", () => process.env.BB_DEBUG && process.stderr.write("[host] did-finish-load\n"));
    win.webContents.on("console-message", (...a: unknown[]) => process.env.BB_DEBUG && process.stderr.write(`[renderer] ${consoleDetails(a).message}\n`));
    win.webContents.on("did-fail-load", (_e, c, d) => process.env.BB_DEBUG && process.stderr.write(`[host] fail ${c} ${d}\n`));
    await win.loadFile(path.join(DIST, "renderer", "index.html")).catch((e) => process.stderr.write(`[host] loadFile error ${e}\n`));
    process.env.BB_DEBUG && process.stderr.write("[host] loaded\n");

    if (opts.openId) {
      await openBlock(opts.openId).catch((e) => console.error(e));
      win.webContents.send("host:navigate", { id: opts.openId });
    }
    if (opts.snapshot) await takeSnapshot(opts.snapshot);
  });

  app.on("activate", () => focusWindow());
  app.on("window-all-closed", () => {
    for (const { job } of jobs.values()) job.cancel();
    stopAllBackends();
    app.quit();
  });
  app.on("before-quit", () => {
    for (const { job } of jobs.values()) job.cancel();
    stopAllBackends();
  });
}

/** App menu. Block shortcuts go to the host UI (the focused block view would swallow keydowns). */
function installAppMenu() {
  const send = (action: string) => () => win?.webContents.send("host:menu", { action });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          { label: "New Block…", accelerator: "CmdOrCtrl+N", click: send("new") },
          { label: "All Blocks", accelerator: "CmdOrCtrl+Shift+H", click: send("home") },
          { type: "separator" },
          { label: "Close Block", accelerator: "CmdOrCtrl+W", click: send("close") },
        ],
      },
      { role: "editMenu" },
      {
        label: "Block",
        submenu: [
          { label: "Reload Block", accelerator: "CmdOrCtrl+R", click: send("reload") },
          { label: "Modify with AI…", accelerator: "CmdOrCtrl+E", click: send("edit") },
          { label: "Undo Last AI Change", click: send("undo") },
          { label: "Version History…", accelerator: "CmdOrCtrl+Y", click: send("history") },
          { type: "separator" },
          { label: "Toggle Split View…", accelerator: "CmdOrCtrl+\\", click: send("split") },
          { label: "Show Console", accelerator: "CmdOrCtrl+Alt+C", click: send("logs") },
          { label: "Block Developer Tools", accelerator: "CmdOrCtrl+Alt+I", click: send("devtools") },
        ],
      },
      {
        label: "View",
        submenu: [{ role: "togglefullscreen" }, { type: "separator" }, { label: "Host Developer Tools", click: () => win?.webContents.toggleDevTools() }],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** Test hook: render the window offscreen, save PNGs of the host UI (and active block), quit. */
async function takeSnapshot(file: string) {
  const dbg = (m: string) => process.env.BB_DEBUG && process.stderr.write(`[snapshot] ${m}\n`);
  dbg("start");
  if (process.env.BB_SNAPSHOT_JS) {
    await win!.webContents.executeJavaScript(process.env.BB_SNAPSHOT_JS).catch((e) => dbg(`script failed: ${e}`));
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 1800));
  dbg("capturing");
  const img = await win!.webContents.capturePage();
  dbg("captured");
  fs.writeFileSync(file, img.toPNG());
  if (activeId) {
    const v = views.get(activeId)!;
    const bimg = await v.view.webContents.capturePage().catch(() => null);
    if (bimg) fs.writeFileSync(file.replace(/\.png$/, "-block.png"), bimg.toPNG());
  }
  app.exit(0);
}
