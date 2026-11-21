/**
 * Everything that isolates a block's web content from the rest of the machine:
 * - one session partition per block
 * - the block:// protocol, which only serves files from that block's code/ folder
 * - a strict CSP and a request filter that blocks every non-block:// request
 * - no Node, no remote content, no popups, no navigation, no browser permissions
 */
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { protocol, session, type Session, type WebContents, type WebPreferences } from "electron";
import type { BlockManifest } from "../shared/blocks";
import { safeJoin } from "../shared/paths";

export const BLOCK_SCHEME = "block";

/** Must run before app 'ready'. */
export function registerBlockScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: BLOCK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  ]);
}

export const BLOCK_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".stl": "model/stl",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

/** Which block a webContents belongs to. The renderer never gets to claim its own identity. */
export interface BlockContext {
  blockId: string;
  codeDir: string;
  dataDir: string;
  manifest: BlockManifest;
  /** true in headless validation runs: file pickers cancel, nothing is persisted for real. */
  validating: boolean;
  ready: boolean;
}

const contexts = new Map<number, BlockContext>();
export const blockContexts = {
  set: (wc: WebContents, ctx: BlockContext) => {
    contexts.set(wc.id, ctx);
    wc.once("destroyed", () => contexts.delete(wc.id));
  },
  get: (wc: WebContents) => contexts.get(wc.id),
  all: () => [...contexts.entries()],
};

const configured = new WeakSet<Session>();
const sessionDirs = new Map<string, { blockId: string; codeDir: string }>();

/**
 * Configure (once) the isolated session for a block. `codeDir` is updated in `sessionDirs`
 * and looked up dynamically on every request so recreated blocks or validation runs never use a stale path.
 */
export function blockSession(partition: string, blockId: string, codeDir: string): Session {
  sessionDirs.set(partition, { blockId, codeDir });
  const ses = session.fromPartition(partition, { cache: true });
  if (configured.has(ses)) return ses;
  configured.add(ses);

  ses.protocol.handle(BLOCK_SCHEME, async (req) => {
    const active = sessionDirs.get(partition) ?? { blockId, codeDir };
    const url = new URL(req.url);
    if (url.host !== active.blockId) return new Response("Forbidden: other block", { status: 403 });
    let rel = decodeURIComponent(url.pathname);
    if (rel.split("/").some((seg) => seg.startsWith(".") && seg !== ".bin")) return new Response("Forbidden", { status: 403 });
    let file = safeJoin(active.codeDir, rel);
    if (!file) return new Response("Forbidden", { status: 403 });
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      const ext = path.extname(file).toLowerCase();
      const raw = await fs.promises.readFile(file);
      const body = ext === ".ts" && typeof stripTypeScriptTypes === "function" ? Buffer.from(stripTypeScriptTypes(raw.toString("utf8")), "utf8") : raw;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-security-policy": BLOCK_CSP,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response(`Not found: ${rel}`, { status: 404 });
    }
  });

  // Hard network wall: the page may only load its own files. Network goes through bb.net.fetch or bb.backend.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const active = sessionDirs.get(partition) ?? { blockId, codeDir };
    const u = details.url;
    const allowed =
      u.startsWith(`${BLOCK_SCHEME}://${active.blockId}/`) || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("devtools://") || u.startsWith("chrome-extension://");
    cb({ cancel: !allowed });
  });

  // No camera, mic, geolocation, notifications, HID, etc. Those would come later as declared permissions.
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on("will-download", (e) => e.preventDefault());
  return ses;
}

/** Unregister protocol and webRequest handlers for temporary validation partitions. */
export async function cleanupBlockSession(partition: string): Promise<void> {
  sessionDirs.delete(partition);
  try {
    const ses = session.fromPartition(partition, { cache: false });
    if (ses.protocol.isProtocolHandled(BLOCK_SCHEME)) ses.protocol.unhandle(BLOCK_SCHEME);
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onErrorOccurred(null);
    await ses.clearStorageData();
  } catch {}
}

export function blockWebPreferences(partition: string, preload: string): WebPreferences {
  return {
    partition,
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    autoplayPolicy: "user-gesture-required",
  };
}

/** Lock navigation to the block's own origin and refuse popups. */
export function lockNavigation(wc: WebContents, blockId: string): void {
  const origin = `${BLOCK_SCHEME}://${blockId}`;
  wc.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin + "/")) e.preventDefault();
  });
  wc.on("will-redirect", (e, url) => {
    if (!url.startsWith(origin + "/")) e.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-attach-webview", (e) => e.preventDefault());
}

export function blockUrl(m: BlockManifest): string {
  return `${BLOCK_SCHEME}://${m.id}/${m.entry.ui.replace(/^\.?\//, "")}`;
}

/** Normalise Electron's console-message event across the old and new signatures. */
export function consoleDetails(args: unknown[]): { level: "debug" | "info" | "warning" | "error"; message: string; line?: number; source?: string } {
  const ev = args[0] as { level?: unknown; message?: string; lineNumber?: number; sourceId?: string };
  if (typeof ev?.level === "string") {
    return { level: ev.level as "info", message: ev.message ?? "", line: ev.lineNumber, source: ev.sourceId };
  }
  const levels = ["debug", "info", "warning", "error"] as const;
  return { level: levels[Number(args[1]) || 0] ?? "info", message: String(args[2] ?? ""), line: Number(args[3]), source: String(args[4] ?? "") };
}
