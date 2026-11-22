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
  saveCustomAgent: (cfg: unknown) => inv("saveCustomAgent", cfg),
  deleteCustomAgent: (id: string) => inv("deleteCustomAgent", id),
  testAgent: (cfg: unknown) => inv("testAgent", cfg),
  detectRuntimes: () => inv("detectRuntimes"),
  installSkill: () => inv("installSkill"),
  createFromTemplate: (name: string, template: string) => inv("createFromTemplate", name, template),
  openBlock: (id: string, asSplit?: boolean) => inv("openBlock", id, asSplit),
  closeBlock: (id: string) => inv("closeBlock", id),
  showBlock: (id: string | null, splitId?: string | null) => inv("showBlock", id, splitId),
  capturePreview: () => inv("capturePreview"),
  setViewBounds: (
    primary: { x: number; y: number; width: number; height: number },
    secondary?: { x: number; y: number; width: number; height: number } | null,
  ) => inv("setViewBounds", primary, secondary),
  reloadBlock: (id: string) => inv("reloadBlock", id),
  devtools: (id: string) => inv("devtools", id),
  logs: (id: string) => inv("logs", id),
  clearLogs: (id: string) => inv("clearLogs", id),
  history: (id: string) => inv("history", id),
  restoreHistory: (id: string, ref: string) => inv("restoreHistory", id, ref),
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
