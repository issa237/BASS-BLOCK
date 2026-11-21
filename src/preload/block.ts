/**
 * Preload for block views. Runs sandboxed; exposes exactly `window.bb` and nothing else.
 * Must stay self-contained (sandboxed preloads cannot require local modules).
 */
import { contextBridge, ipcRenderer } from "electron";

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("bb:call", method, ...args);

type Listener = (data: unknown, meta: { from: string }) => void;
const listeners = new Map<string, Set<Listener>>();
ipcRenderer.on("bb:event", (_e, msg: { from: string; name: string; data: unknown }) => {
  for (const fn of listeners.get(msg.name) ?? []) {
    try {
      fn(msg.data, { from: msg.from });
    } catch (err) {
      console.error(err);
    }
  }
  for (const fn of listeners.get("*") ?? []) fn({ name: msg.name, data: msg.data }, { from: msg.from });
});

// Forward uncaught errors to the host log panel so the user (and validator) can see them.
window.addEventListener("error", (ev) => {
  call("log", "error", `${ev.message} (${ev.filename?.split("/").pop()}:${ev.lineno})`).catch(() => {});
});
window.addEventListener("unhandledrejection", (ev) => {
  const r = ev.reason as { message?: string } | undefined;
  call("log", "error", `Unhandled promise rejection: ${r?.message ?? String(ev.reason)}`).catch(() => {});
});

const decoder = new TextDecoder();

const bb = {
  version: "1.0.0",
  info: () => call("info"),
  ready: () => call("ready"),
  log: (...args: unknown[]) => call("log", "info", args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),

  storage: {
    get: (key: string) => call("storage.get", key),
    set: (key: string, value: unknown) => call("storage.set", key, value),
    delete: (key: string) => call("storage.delete", key),
    keys: () => call("storage.keys"),
  },

  data: {
    read: (name: string, opts?: { encoding?: "utf8" }) => call("data.read", name, opts),
    readText: (name: string) => call("data.read", name, { encoding: "utf8" }),
    write: (name: string, data: string | Uint8Array | ArrayBuffer) => call("data.write", name, data),
    delete: (name: string) => call("data.delete", name),
    list: () => call("data.list"),
  },

  fs: {
    pickOpen: (opts?: { multiple?: boolean; title?: string; filters?: { name: string; extensions: string[] }[] }) => call("fs.pickOpen", opts ?? {}),
    pickSave: (opts?: { suggestedName?: string; title?: string; filters?: { name: string; extensions: string[] }[] }) => call("fs.pickSave", opts ?? {}),
    read: (handle: string, opts?: { encoding?: "utf8" }) => call("fs.read", handle, opts),
    readText: (handle: string) => call("fs.read", handle, { encoding: "utf8" }),
    write: (handle: string, data: string | Uint8Array | ArrayBuffer) => call("fs.write", handle, data),
  },

  clipboard: {
    readText: () => call("clipboard.readText"),
    writeText: (text: string) => call("clipboard.writeText", text),
  },

  net: {
    async fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }) {
      const r = (await call("net.fetch", url, init ?? {})) as { status: number; ok: boolean; url: string; headers: Record<string, string>; body: Uint8Array };
      return {
        status: r.status,
        ok: r.ok,
        url: r.url,
        headers: r.headers,
        bytes: () => r.body,
        text: () => decoder.decode(r.body),
        json: () => JSON.parse(decoder.decode(r.body)),
      };
    },
  },

  emit: (name: string, data?: unknown) => call("emit", name, data),
  on(name: string, fn: Listener) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
    return () => listeners.get(name)?.delete(fn);
  },
};

contextBridge.exposeInMainWorld("bb", bb);
