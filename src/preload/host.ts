/** Preload for the host UI (sidebar, grid, dialogs). Exposes `window.host`. */
import { contextBridge, ipcRenderer } from "electron";

const inv = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(`host:${ch}`, ...args);
const on = (ch: string) => (fn: (data: any) => void) => {
  const h = (_e: unknown, d: unknown) => fn(d);
  ipcRenderer.on(`host:${ch}`, h);
  return () => ipcRenderer.removeListener(`host:${ch}`, h);
};

contextBridge.exposeInMainWorld("host", {
  info: () => inv("info"),
  listBlocks: () => inv("listBlocks"),
  getSettings: () => inv("getSettings"),
  setSettings: (patch: unknown) => inv("setSettings", patch),
  detectAgents: () => inv("detectAgents"),
  createFromTemplate: (name: string, template: string) => inv("createFromTemplate", name, template),
  openBlock: (id: string) => inv("openBlock", id),
  closeBlock: (id: string) => inv("closeBlock", id),
  showBlock: (id: string | null) => inv("showBlock", id),
  setViewBounds: (r: { x: number; y: number; width: number; height: number }) => inv("setViewBounds", r),
  reloadBlock: (id: string) => inv("reloadBlock", id),
  devtools: (id: string) => inv("devtools", id),
  logs: (id: string) => inv("logs", id),
  clearLogs: (id: string) => inv("clearLogs", id),
  history: (id: string) => inv("history", id),
  undoAi: (id: string) => inv("undoAi", id),
  reveal: (id: string) => inv("reveal", id),
  revealHome: () => inv("revealHome"),
  deleteBlock: (id: string) => inv("deleteBlock", id),
  metrics: () => inv("metrics"),
  validate: (id: string) => inv("validate", id),
  startAgent: (req: unknown) => inv("startAgent", req),
  cancelAgent: (jobId: string) => inv("cancelAgent", jobId),
  popupMenu: (items: unknown[]) => inv("popupMenu", items),

  onBlocksChanged: on("blocks-changed"),
  onAgentEvent: on("agent-event"),
  onBlockLog: on("block-log"),
  onBlockCrashed: on("block-crashed"),
  onBlockClosed: on("block-closed"),
  onNavigate: on("navigate"),
  onMenu: on("menu"),
});
