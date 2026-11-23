// Host UI: sidebar, block library grid, open-block tabs, split view, create/modify dialogs, version history, AI & runtime settings.

interface BlockItem {
  id: string;
  ok: boolean;
  error?: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  mode?: "web" | "polyglot";
  language?: string | null;
  permissions: string[];
  open: boolean;
  building: boolean;
  thumb: string | null;
}
interface AgentInfo {
  id: string;
  label: string;
  kind?: string;
  path: string | null;
  detail?: string;
  custom?: boolean;
  config?: any;
}
interface RuntimeInfo {
  id: string;
  label: string;
  bin: string;
  path: string | null;
  version: string | null;
  install?: {
    summary: string;
    steps: { title: string; cmd?: string; note?: string }[];
    verifyCmd: string;
    docsUrl: string;
  };
}
interface HistoryEntry { ref: string; message: string; at: number }
interface BlockageReport {
  id: string;
  blockId: string;
  createdAt: number;
  request: string;
  agent: string;
  title: string;
  error: string;
  missingCapability: string;
  proposal: string;
  workaround?: string;
  problems?: { step: string; message: string; file?: string }[];
}
type AgentEvent =
  | { type: "status" | "text" | "tool" | "log"; text: string }
  | { type: "done"; ok: boolean; problems: { step: string; message: string; file?: string }[]; cancelled?: boolean; blockage?: BlockageReport };

declare const host: any;

// ---------------------------------------------------------------- state
const state = {
  blocks: [] as BlockItem[],
  open: [] as string[], // open block ids, in tab order
  view: "home" as "home" | string, // "home" or a block id
  splitView: null as string | null, // optional second block id shown side-by-side
  search: "",
  agents: [] as AgentInfo[],
  runtimes: [] as RuntimeInfo[],
  agent: "claude",
  logsOpen: false,
  modalOpen: false,
  metrics: {} as Record<string, { memoryMb: number; cpu: number }>,
  /** Per-block AI jobs, so a hidden progress dialog can be reopened. */
  jobs: new Map<string, { jobId: string; kind: "create" | "edit"; request: string; events: AgentEvent[]; done?: Extract<AgentEvent, { type: "done" }> }>(),
};

// ---------------------------------------------------------------- tiny DOM helper
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list") (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const svg = (path: string) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 20 20");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = path;
  return s;
};
const ICONS = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  sparkle: '<path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6zM15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  undo: '<path d="M7 5L3.5 8.5 7 12"/><path d="M4 8.5h7.5a4.5 4.5 0 010 9H9"/>',
  history: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.2l2.8 1.8"/>',
  split: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M10 4v12"/>',
  reload: '<path d="M16 10a6 6 0 11-1.8-4.3"/><path d="M16 3.5v3.7h-3.7"/>',
  logs: '<path d="M4 5h12M4 10h12M4 15h8"/>',
  more: '<circle cx="5" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l3.5 3.5"/>',
  check: '<path d="M4.5 10.5l3.5 3.5 7.5-8"/>',
  stop: '<rect x="5.5" y="5.5" width="9" height="9" rx="1.5"/>',
  chevron: '<path d="M8 5.5l4.5 4.5L8 14.5"/>',
  dot: '<circle cx="10" cy="10" r="2"/>',
  file: '<path d="M11.5 2.5H6a1.5 1.5 0 00-1.5 1.5v12A1.5 1.5 0 006 17.5h8a1.5 1.5 0 001.5-1.5V6.5z"/><path d="M11.5 2.5v4h4"/>',
  globe: '<circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3z"/>',
  clipboard: '<rect x="5" y="4" width="10" height="13.5" rx="1.5"/><path d="M7.5 4V3h5v1"/>',
  text: '<path d="M4 5h12M4 9h12M4 13h8"/>',
  image: '<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.3"/><path d="M17 13l-4-4-7 7"/>',
  cube: '<path d="M10 2.5l6.5 3.7v7.6L10 17.5l-6.5-3.7V6.2z"/><path d="M3.5 6.2L10 10l6.5-3.8M10 10v7.5"/>',
  square: '<rect x="4" y="4" width="12" height="12" rx="3"/>',
  terminal: '<path d="M4.5 6l3.5 4-3.5 4M10 14.5h5.5"/>',
  bolt: '<path d="M11 2.5L4.5 11H10l-1 6.5L15.5 9H10z"/>',
};
const bicon = (emoji: string, lg = false) => h("span", { class: `bicon ${lg ? "lg" : ""}`, "aria-hidden": "true" }, emoji);
const PERM_CHIPS: [RegExp, string, string][] = [
  [/^Run a? ?local/, "Polyglot", ICONS.terminal],
  [/^Read and write files/, "Files", ICONS.file],
  [/^Connect/, "Network", ICONS.globe],
  [/clipboard/, "Clipboard", ICONS.clipboard],
  [/camera/i, "Camera", ICONS.image],
  [/microphone/i, "Mic", ICONS.bolt],
  [/MIDI/i, "MIDI", ICONS.bolt],
  [/notifications/i, "Alerts", ICONS.sparkle],
  [/background/i, "Background", ICONS.history],
  [/bb\.ai/i, "AI", ICONS.sparkle],
];

function toast(msg: string, kind: "info" | "err" = "info") {
  const t = h("div", { class: `toast ${kind === "err" ? "err" : ""}`, title: msg }, msg);
  $("#toast-root").append(t);
  setTimeout(() => t.remove(), kind === "err" ? 6000 : 3200);
}
const nodes = (...c: Child[]) => c.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attempt(fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (e) {
    toast(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "err");
    return undefined;
  }
}
const blockById = (id: string) => state.blocks.find((b) => b.id === id);
const agentLabel = (id: string) => state.agents.find((a) => a.id === id)?.label ?? id;

// ---------------------------------------------------------------- data
async function refreshBlocks() {
  state.blocks = await host.listBlocks();
  state.open = state.open.filter((id) => state.blocks.some((b) => b.id === id && b.open));
  if (state.splitView && (!state.open.includes(state.splitView) || state.splitView === state.view)) {
    state.splitView = null;
  }
  if (state.view !== "home" && !state.open.includes(state.view)) {
    state.view = state.splitView ?? "home";
    state.splitView = null;
  }
  render();
}

// ---------------------------------------------------------------- navigation
async function openBlock(id: string, asSplit = false) {
  const res = await attempt(() => host.openBlock(id, asSplit));
  if (!res) return;
  if (!state.open.includes(id)) state.open.push(id);
  if (asSplit && state.view !== "home" && state.view !== id) {
    state.splitView = id;
  } else {
    state.view = id;
    if (state.splitView === id) state.splitView = null;
  }
  render();
  syncViewport();
}
function goHome() {
  state.view = "home";
  host.showBlock(null, null);
  render();
}
async function closeBlock(id: string) {
  await host.closeBlock(id);
  const idx = state.open.indexOf(id);
  state.open = state.open.filter((x) => x !== id);
  if (state.splitView === id) {
    state.splitView = null;
  }
  if (state.view === id) {
    if (state.splitView) {
      state.view = state.splitView;
      state.splitView = null;
    } else {
      const next = state.open[Math.min(idx, state.open.length - 1)];
      state.view = next ?? "home";
    }
  }
  render();
}

async function toggleSplitMenu() {
  if (state.view === "home") return;
  if (state.splitView) {
    state.splitView = null;
    render();
    syncViewport();
    return;
  }
  const candidates = state.blocks.filter((b) => b.id !== state.view && !b.building);
  if (!candidates.length) {
    toast("Create at least two blocks to use Split View.");
    return;
  }
  const choice = await host.popupMenu([
    ...candidates.map((b) => ({ id: b.id, label: `${b.icon}  ${b.name}` })),
  ]);
  if (choice) await openBlock(choice, true);
}

/** Keep the native block view(s) glued to #block-viewport. */
function syncViewport() {
  const el = $("#block-viewport");
  const r = el.getBoundingClientRect();
  const hasSplit = Boolean(state.view !== "home" && state.splitView && state.splitView !== state.view);
  el.classList.toggle("split", hasSplit);
  if (hasSplit) {
    const half = Math.floor(r.width / 2);
    const primary = { x: r.left, y: r.top, width: half, height: r.height };
    const secondary = { x: r.left + half + 1, y: r.top, width: Math.max(0, r.width - half - 1), height: r.height };
    host.setViewBounds(primary, secondary);
    host.showBlock(!state.modalOpen ? state.view : null, !state.modalOpen ? state.splitView : null);
  } else {
    host.setViewBounds({ x: r.left, y: r.top, width: r.width, height: r.height }, null);
    host.showBlock(state.view !== "home" && !state.modalOpen ? state.view : null, null);
  }
}
new ResizeObserver(syncViewport).observe(document.body);

// ---------------------------------------------------------------- render
function render() {
  renderSidebar();
  renderTopbar();
  const inBlock = state.view !== "home";
  $("#home-view").hidden = inBlock;
  $("#block-view").hidden = !inBlock;
  $("#log-drawer").hidden = !(inBlock && state.logsOpen);
  if (!inBlock) renderHome();
  requestAnimationFrame(syncViewport);
}

function renderSidebar() {
  $("#nav-home").classList.toggle("active", state.view === "home");
  const openList = $("#open-list");
  openList.replaceChildren(
    ...state.open.map((id) => {
      const b = blockById(id);
      const isCurrent = state.view === id || state.splitView === id;
      return h(
        "li",
        { class: `side-row ${isCurrent ? "active" : ""}`, onclick: () => openBlock(id) },
        bicon(b?.icon ?? "▦"),
        h("span", { class: "label" }, b?.name ?? id),
        h("button", { class: "x", title: "Close", "aria-label": `Close ${b?.name ?? id}`, onclick: (e: Event) => (e.stopPropagation(), closeBlock(id)) }, svg(ICONS.close)),
      );
    }),
  );
  $("#open-empty").hidden = state.open.length > 0;
  $("#block-list").replaceChildren(
    ...state.blocks.map((b) =>
      h(
        "li",
        { class: "side-row", onclick: () => (b.building ? showProgress(b.id) : openBlock(b.id)), oncontextmenu: (e: Event) => (e.preventDefault(), blockMenu(b.id)) },
        bicon(b.icon),
        h("span", { class: "label" }, b.name),
        b.building ? h("span", { class: "spinner", title: "AI is working on this block" }) : !b.ok ? h("span", { class: "dot err", title: b.error }) : null,
      ),
    ),
  );
  const pill = $("#agent-pill");
  const agentOk = state.agents.some((a) => a.id === state.agent && a.path);
  pill.textContent = agentOk ? agentLabel(state.agent) : "No agent";
  pill.classList.toggle("off", !agentOk);
}

function topBtn(label: string, icon: string, onclick: () => void, opts: { primary?: boolean; title?: string; iconOnly?: boolean; disabled?: boolean } = {}) {
  return h(
    "button",
    { class: `btn ${opts.primary ? "primary" : "ghost"} ${opts.iconOnly ? "icon-btn" : ""}`, title: opts.title ?? label, "aria-label": label, onclick, disabled: opts.disabled },
    svg(icon),
    opts.iconOnly ? null : label,
  );
}

function renderTopbar() {
  const bar = $("#topbar");
  if (state.view === "home") {
    const input = h("input", {
      class: "search",
      type: "search",
      "aria-label": "Search blocks",
      placeholder: "Search blocks",
      value: state.search,
      oninput: (e: Event) => {
        state.search = (e.target as HTMLInputElement).value;
        renderHome();
      },
    });
    const search = h("label", { class: "search-wrap" }, svg(ICONS.search), input);
    const newBtn = topBtn("New block", ICONS.plus, () => showCreate(), { primary: true });
    newBtn.append(h("span", { class: "kbd" }, "⌘N"));
    bar.replaceChildren(
      ...nodes(
        h("h1", {}, "Blocks", state.blocks.length ? h("span", { class: "count num" }, ` ${state.blocks.length}`) : null),
        h("span", { class: "spacer" }),
        state.blocks.length ? search : null,
        newBtn,
      ),
    );
    return;
  }
  const id = state.view;
  const b = blockById(id);
  const splitB = state.splitView ? blockById(state.splitView) : null;
  const m = state.metrics[id];
  const busy = state.jobs.has(id) && !state.jobs.get(id)!.done;
  bar.replaceChildren(...nodes(
    h(
      "div",
      { class: "crumb" },
      bicon(b?.icon ?? "▦", true),
      h("span", { class: "name" }, b?.name ?? id),
      b?.language ? h("span", { class: "chip" }, b.language) : null,
      h("span", { class: "ver" }, b?.version ? `v${b.version}` : ""),
      splitB ? h("span", { class: "ver" }, ` · Split: ${splitB.icon} ${splitB.name}`) : null,
    ),
    m ? h("span", { class: "meter", title: "Memory used by this block's process" }, `${m.memoryMb} MB`) : null,
    h("span", { class: "spacer" }),
    busy
      ? h("button", { class: "btn ghost", onclick: () => showProgress(id) }, h("span", { class: "spinner" }), "AI working…")
      : topBtn("Modify with AI", ICONS.sparkle, () => showEdit(id)),
    h("span", { class: "divider", "aria-hidden": "true" }),
    topBtn(state.splitView ? "Exit Split View" : "Split View", ICONS.split, toggleSplitMenu, { iconOnly: true, title: state.splitView ? "Close Split View (⌘\\)" : "Split View Side-by-Side (⌘\\)" }),
    topBtn("Undo AI change", ICONS.undo, () => undoAi(id), { iconOnly: true, disabled: busy }),
    topBtn("Version History", ICONS.history, () => showHistory(id), { iconOnly: true, disabled: busy }),
    topBtn("Reload", ICONS.reload, () => host.reloadBlock(id), { iconOnly: true }),
    topBtn("Console", ICONS.logs, toggleLogs, { iconOnly: true }),
    topBtn("More", ICONS.more, () => blockMenu(id), { iconOnly: true }),
  ));
}

const EXAMPLES = [
  "A markdown editor with live word-frequency stats",
  "A Python CSV & dataset statistics analyzer",
  "A native Swift SHA-256 and benchmark utility",
  "A sprite-sheet slicer for game dev",
  "A color palette generator from an image",
  "A 3D STL model viewer",
];

function renderHome() {
  const root = $("#home-view");
  if (!state.blocks.length) {
    root.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("button", { class: "big-plus", title: "New block", "aria-label": "New block", onclick: () => showCreate() }, svg(ICONS.plus)),
        h("h2", {}, "Build your first block"),
        h("p", {}, "Describe a tool in plain words. Your AI agent picks the best language (Web, Python, Swift, Rust, C++, Go), BASS BLOCK validates it, and it opens right here."),
        h("div", { class: "examples" }, ...EXAMPLES.map((ex) => h("button", { class: "example", onclick: () => showCreate(ex) }, svg(ICONS.sparkle), ex))),
      ),
    );
    return;
  }
  const q = state.search.trim().toLowerCase();
  const list = state.blocks.filter((b) => !q || `${b.name} ${b.description} ${b.id} ${b.language ?? ""}`.toLowerCase().includes(q));
  root.replaceChildren(
    h(
      "div",
      { class: "grid" },
      !q ? h("button", { class: "tile new", onclick: () => showCreate() }, h("span", { class: "plus" }, svg(ICONS.plus)), h("strong", {}, "New block"), h("span", { class: "hint" }, "Describe it, AI builds it")) : null,
      ...list.map((b, i) => tile(b, i + 1)),
    ),
  );
}

function tile(b: BlockItem, i = 0) {
  return h(
    "button",
    {
      class: "tile",
      style: `--i:${Math.min(i, 12)}`,
      onclick: () => (b.building ? showProgress(b.id) : openBlock(b.id)),
      oncontextmenu: (e: Event) => (e.preventDefault(), blockMenu(b.id)),
      title: b.description || b.name,
    },
    h("div", { class: "thumb" }, b.thumb ? h("img", { src: b.thumb, alt: "" }) : b.icon),
    h(
      "div",
      { class: "tile-body" },
      h("div", { class: "tile-title" }, bicon(b.icon), h("span", { class: "t" }, b.name), b.open ? h("span", { class: "dot", title: "Open", "aria-label": "Open" }) : null),
      h("div", { class: "tile-desc" }, b.description || " "),
      h(
        "div",
        { class: "chips" },
        b.building ? h("span", { class: "chip busy" }, h("span", { class: "spinner", style: "width:9px;height:9px;border-width:1.5px" }), "AI building") : null,
        !b.ok ? h("span", { class: "chip err", title: b.error }, "Needs repair") : null,
        b.language ? h("span", { class: "chip ok" }, b.language) : null,
        b.version ? h("span", { class: "chip num" }, `v${b.version}`) : null,
        ...b.permissions.map((p) => {
          const m = PERM_CHIPS.find(([re]) => re.test(p));
          return h("span", { class: "chip", title: p }, m ? svg(m[2]) : null, m ? m[1] : p);
        }),
      ),
    ),
    h("span", { class: "btn small tile-menu icon-btn", role: "button", "aria-label": `More actions for ${b.name}`, onclick: (e: Event) => (e.stopPropagation(), blockMenu(b.id)) }, svg(ICONS.more)),
  );
}

async function blockMenu(id: string) {
  const b = blockById(id);
  const isOpen = state.open.includes(id);
  const canSplit = state.view !== "home" && state.view !== id;
  const choice = await host.popupMenu([
    { id: "open", label: "Open" },
    ...(canSplit ? [{ id: "split", label: "Open Side-by-Side (Split View)" }] : []),
    { id: "edit", label: "Modify with AI…" },
    { id: "undo", label: "Undo last AI change" },
    { id: "history", label: "Version History…" },
    { separator: true },
    { id: "validate", label: "Run validation" },
    { id: "report", label: "Report Blockage / Proposal…" },
    { id: "devtools", label: "Toggle Developer Tools", enabled: isOpen },
    { id: "reveal", label: "Show in Finder" },
    { separator: true },
    { id: "close", label: "Close", enabled: isOpen },
    { id: "delete", label: "Move to Trash…" },
  ]);
  switch (choice) {
    case "open": return openBlock(id);
    case "split": return openBlock(id, true);
    case "edit": return showEdit(id);
    case "undo": return undoAi(id);
    case "history": return showHistory(id);
    case "validate": {
      toast(`Validating ${b?.name ?? id}…`);
      const r = await attempt(() => host.validate(id));
      if (r) toast(r.ok ? `✓ ${b?.name} passed validation` : `✗ ${r.problems.length} problem(s): ${r.problems[0]?.message}`, r.ok ? "info" : "err");
      return;
    }
    case "report":
      return showBlockageModal({
        blockId: id,
        request: b?.description || `Enhancement for ${b?.name ?? id}`,
        agent: state.agent,
        title: `Capability request for ${b?.name ?? id}`,
        error: b?.error || "",
      });
    case "devtools": return host.devtools(id);
    case "reveal": return host.reveal(id);
    case "close": return closeBlock(id);
    case "delete": {
      const gone = await attempt(() => host.deleteBlock(id));
      if (gone) {
        state.open = state.open.filter((x) => x !== id);
        if (state.splitView === id) state.splitView = null;
        if (state.view === id) state.view = state.splitView ?? "home";
        await refreshBlocks();
      }
    }
  }
}

async function undoAi(id: string) {
  const undone = await attempt(() => host.undoAi(id));
  if (undone === undefined) return;
  toast(undone ? `Undid: ${String(undone).replace(/^AI: /, "")}` : "No AI change to undo");
  refreshBlocks();
}

async function showHistory(id: string) {
  const b = blockById(id);
  const entries = (await attempt(() => host.history(id))) as HistoryEntry[] | undefined;
  if (!entries) return;
  const list = h("ul", { class: "history-list" });
  const m = modal({
    title: h("span", {}, "Version History — ", h("strong", {}, b?.name ?? id)),
    body: [
      h("p", { class: "hint", style: "margin:0" }, "Every AI change and template creation is snapshotted automatically. Restoring a version never alters your saved block data."),
      entries.length
        ? list
        : h("p", { class: "hint" }, "No snapshots recorded yet."),
    ],
    foot: [h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => m.close() }, "Close")],
  });
  list.replaceChildren(
    ...entries.map((entry, idx) =>
      h(
        "li",
        { class: "history-row" },
        h("span", { class: "h-meta" }, new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })),
        h("span", { class: "h-msg", title: entry.message }, entry.message),
        idx === 0
          ? h("span", { class: "chip ok" }, "Current")
          : h(
              "button",
              {
                class: "btn small",
                onclick: async () => {
                  const res = await attempt(() => host.restoreHistory(id, entry.ref));
                  if (res) {
                    toast(`Restored: ${entry.message.slice(0, 50)}`);
                    m.close();
                    await refreshBlocks();
                  }
                },
              },
              "Restore",
            ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- logs
async function toggleLogs() {
  state.logsOpen = !state.logsOpen;
  if (state.logsOpen && state.view !== "home") {
    const entries = await host.logs(state.view);
    $("#log-list").replaceChildren(...entries.map(logRow));
    scrollLogs();
  }
  render();
}
function logRow(e: { at?: number; level: string; text: string }) {
  const t = new Date(e.at ?? Date.now()).toLocaleTimeString([], { hour12: false });
  return h("li", { class: e.level }, h("span", { class: "when" }, t), e.text);
}
function scrollLogs() {
  const l = $("#log-list");
  l.scrollTop = l.scrollHeight;
}
$("#log-close").addEventListener("click", toggleLogs);
$("#log-clear").addEventListener("click", () => {
  if (state.view !== "home") host.clearLogs(state.view);
  $("#log-list").replaceChildren();
});

// ---------------------------------------------------------------- modals
let activeModalEsc: ((e: KeyboardEvent) => void) | null = null;

function modal(opts: { title: Child; body: Node[]; foot: Node[]; onClose?: () => void; head?: Node[] }) {
  closeModal();
  state.modalOpen = true;

  // Capture or show the active block's preview behind the blurred modal backdrop instead of a blank screen
  if (state.view !== "home") {
    const vp = $("#block-viewport");
    const fallbackThumb = blockById(state.view)?.thumb;
    if (fallbackThumb) vp.style.backgroundImage = `url("${fallbackThumb}")`;
    host.capturePreview().then((dataUrl: string | null) => {
      if (state.modalOpen && dataUrl) vp.style.backgroundImage = `url("${dataUrl}")`;
    }).catch(() => {});
  }
  host.showBlock(null, null);

  const close = () => {
    closeModal();
    opts.onClose?.();
  };
  const el = h(
    "div",
    { class: "backdrop", onmousedown: (e: Event) => e.target === el && close() },
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true" },
      h("div", { class: "modal-head" }, h("h3", {}, opts.title as any), h("span", { class: "spacer" }), ...(opts.head ?? []), h("button", { class: "btn ghost icon-btn", title: "Close", onclick: close }, svg(ICONS.close))),
      h("div", { class: "modal-body" }, ...opts.body),
      h("div", { class: "modal-foot" }, ...opts.foot),
    ),
  );
  $("#modal-root").replaceChildren(el);
  activeModalEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", activeModalEsc);
  return { el, close };
}

function closeModal() {
  if (activeModalEsc) {
    document.removeEventListener("keydown", activeModalEsc);
    activeModalEsc = null;
  }
  if (!state.modalOpen) return;
  state.modalOpen = false;
  $("#block-viewport").style.backgroundImage = "";
  $("#modal-root").replaceChildren();
  syncViewport();
}

function agentSelect() {
  const sel = h(
    "select",
    { class: "input", title: "Which coding agent builds the block" },
    ...state.agents.map((a) => h("option", { value: a.id, selected: a.id === state.agent, disabled: !a.path }, `${a.label}${a.path ? "" : " (not installed)"}`)),
  );
  return sel;
}

const TEMPLATE_ICONS: Record<string, string> = {
  "blank": ICONS.square,
  "text-tool": ICONS.text,
  "image-tool": ICONS.image,
  "three-viewer": ICONS.cube,
  "python-tool": ICONS.terminal,
  "swift-tool": ICONS.bolt,
};
const TEMPLATE_INFO: Record<string, [string, string]> = {
  "blank": ["Blank (Web)", "Minimal page with the bb SDK wired up"],
  "text-tool": ["Text tool (Web)", "Editor with live stats, saves with bb.storage & bb.fs"],
  "image-tool": ["Image tool (Web)", "Open, edit on a canvas, export PNG"],
  "three-viewer": ["3D viewer (WebGL)", "three.js scene with an STL loader"],
  "python-tool": ["Python Data Lab (Polyglot)", "Python 3 stdio JSON-RPC backend + analysis UI"],
  "swift-tool": ["Swift Native Engine (Polyglot)", "Compiled native Swift backend + benchmark UI"],
};

function showCreate(prefill = "") {
  let tab: "ai" | "skill" | "template" = "ai";
  let template = "text-tool";
  const prompt = h("textarea", {
    class: "prompt",
    placeholder: "Describe the tool you want. The AI can build it with Web/Canvas/Three.js, or with a local backend in Python, Swift, Rust, C++, Go or Node.js.",
    value: prefill,
  });
  const sel = agentSelect();
  const nameInput = h("input", { class: "input", placeholder: "Block name", value: "" });
  const tplGrid = h("div", { class: "tpl-grid" });
  const drawTpls = () =>
    tplGrid.replaceChildren(
      ...Object.entries(TEMPLATE_INFO).map(([k, [t, d]]) =>
        h(
          "button",
          { class: `tpl ${template === k ? "on" : ""}`, "aria-pressed": String(template === k), onclick: () => ((template = k), drawTpls()) },
          h("span", { class: "tpl-ico" }, svg(TEMPLATE_ICONS[k] ?? ICONS.square)),
          h("span", {}, h("strong", {}, t), h("span", {}, d)),
        ),
      ),
    );
  drawTpls();
  const noAgent = !state.agents.some((a) => a.path);
  const aiPane = h(
    "div",
    { class: "field" },
    prompt,
    h("div", { class: "examples", style: "justify-content:flex-start" }, ...EXAMPLES.slice(0, 4).map((ex) => h("button", { class: "example", onclick: () => ((prompt.value = ex), prompt.focus()) }, svg(ICONS.sparkle), ex))),
    noAgent ? h("p", { class: "hint" }, "No coding agent found. Link an AI agent or free model in AI Settings, or start from a template.") : null,
  );

  // ---- "From skill" tab ----
  const skillInput = h("input", {
    class: "input",
    style: "flex:1",
    placeholder: "Paste a skill link (https://github.com/.../SKILL.md) or local SKILL.md path…",
    value: "",
  });
  const skillPreviewBox = h("div", { class: "field" });
  const skillExtraPrompt = h("textarea", {
    class: "prompt",
    style: "min-height:84px",
    placeholder: "Optional: add specific instructions for how the SoftwareBlock should look or behave (leave blank to generate a complete UI for the skill).",
  });

  async function loadSkillPreview(source: string) {
    const src = source.trim();
    if (!src) return;
    skillPreviewBox.replaceChildren(h("p", { class: "hint" }, "Fetching skill…"));
    const info = await attempt(() => host.previewSkill(src));
    if (!info) {
      skillPreviewBox.replaceChildren();
      return;
    }
    skillInput.value = info.source || src;
    skillPreviewBox.replaceChildren(
      h(
        "div",
        { class: "skill-card" },
        h("div", { class: "row" }, svg(ICONS.sparkle), h("strong", {}, info.name), h("span", { class: "spacer" }), h("span", { class: "chip ok" }, info.scripts?.length ? `${info.scripts.length} script(s)` : "SKILL.md")),
        h("p", {}, info.description),
      ),
    );
  }

  const skillPane = h(
    "div",
    { class: "field", hidden: true },
    h(
      "div",
      { class: "field" },
      h("label", {}, "Skill Link (GitHub URL / Raw URL) or Local File"),
      h(
        "div",
        { class: "row" },
        skillInput,
        h("button", { class: "btn", onclick: () => loadSkillPreview(skillInput.value) }, "Fetch Skill"),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const info = await attempt(() => host.pickSkillFile());
              if (info) {
                skillInput.value = info.source;
                skillPreviewBox.replaceChildren(
                  h(
                    "div",
                    { class: "skill-card" },
                    h("div", { class: "row" }, svg(ICONS.sparkle), h("strong", {}, info.name), h("span", { class: "spacer" }), h("span", { class: "chip ok" }, info.scripts?.length ? `${info.scripts.length} script(s)` : "SKILL.md")),
                    h("p", {}, info.description),
                  ),
                );
              }
            },
          },
          "Browse…",
        ),
      ),
    ),
    skillPreviewBox,
    h("div", { class: "field" }, h("label", {}, "Custom Instructions (optional)"), skillExtraPrompt),
  );

  const tplPane = h("div", { class: "field", hidden: true }, h("div", { class: "field" }, h("label", {}, "Name"), nameInput), h("label", { class: "label" }, "Template"), tplGrid);
  const tabs = h("div", { class: "tabs" });
  const go = h("button", { class: "btn primary", onclick: () => submit() }, svg(ICONS.sparkle), "Build block");
  const shortcut = h("span", { class: "kbd" }, "⌘↩ to build");
  const drawTabs = () => {
    shortcut.textContent = tab === "template" ? "⌘↩ to create" : "⌘↩ to build";
    tabs.replaceChildren(
      h("button", { class: tab === "ai" ? "on" : "", onclick: () => ((tab = "ai"), drawTabs()) }, "Describe it"),
      h("button", { class: tab === "skill" ? "on" : "", onclick: () => ((tab = "skill"), drawTabs()) }, "From skill"),
      h("button", { class: tab === "template" ? "on" : "", onclick: () => ((tab = "template"), drawTabs()) }, "From template"),
    );
    aiPane.hidden = tab !== "ai";
    skillPane.hidden = tab !== "skill";
    tplPane.hidden = tab !== "template";
    sel.hidden = tab === "template";
    go.replaceChildren(
      ...(tab === "ai"
        ? [svg(ICONS.sparkle), "Build block"]
        : tab === "skill"
          ? [svg(ICONS.sparkle), "Build from skill"]
          : [svg(ICONS.plus), "Create"]),
    );
  };
  drawTabs();

  const m = modal({
    title: "New block",
    head: [tabs],
    body: [aiPane, skillPane, tplPane],
    foot: [shortcut, h("span", { class: "spacer" }), sel, go],
  });
  prompt.addEventListener("keydown", (e) => e.key === "Enter" && e.metaKey && submit());
  skillInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey ? submit() : loadSkillPreview(skillInput.value)));
  skillExtraPrompt.addEventListener("keydown", (e) => e.key === "Enter" && e.metaKey && submit());
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || tab === "template") && submit());
  setTimeout(() => prompt.focus(), 30);

  async function submit() {
    if (tab === "template") {
      const r = await attempt(() => host.createFromTemplate(nameInput.value.trim() || TEMPLATE_INFO[template][0], template));
      if (!r) return;
      m.close();
      await refreshBlocks();
      openBlock(r.id);
      return;
    }
    if (tab === "skill") {
      const skillSource = skillInput.value.trim();
      if (!skillSource) return skillInput.focus();
      const extra = skillExtraPrompt.value.trim();
      state.agent = sel.value;
      host.setSettings({ agent: sel.value });
      const r = await attempt(() => host.startAgent({ kind: "create", skillSource, request: extra, agent: sel.value }));
      if (!r) return;
      state.jobs.set(r.blockId, { jobId: r.jobId, kind: "create", request: `Import skill: ${skillSource}`, events: [] });
      await refreshBlocks();
      showProgress(r.blockId);
      return;
    }
    const request = prompt.value.trim();
    if (request.length < 3) return prompt.focus();
    state.agent = sel.value;
    host.setSettings({ agent: sel.value });
    const r = await attempt(() => host.startAgent({ kind: "create", request, agent: sel.value }));
    if (!r) return;
    state.jobs.set(r.blockId, { jobId: r.jobId, kind: "create", request, events: [] });
    await refreshBlocks();
    showProgress(r.blockId);
  }
}

function showEdit(id: string) {
  const b = blockById(id);
  const prompt = h("textarea", {
    class: "prompt",
    placeholder: `What should change in “${b?.name ?? id}”? For example: “Add a Python backend for CSV statistics” or “Add a dark mode toggle.”`,
  });
  const sel = agentSelect();
  const go = h("button", { class: "btn primary", onclick: () => submit() }, svg(ICONS.sparkle), "Apply change");
  modal({
    title: h("span", {}, "Modify ", h("strong", {}, b?.name ?? id)),
    body: [prompt, h("p", { class: "hint" }, "The AI only edits this block's code. Your saved data is never touched, and you can undo or restore any snapshot in Version History.")],
    foot: [h("span", { class: "kbd" }, "⌘↩ to apply"), h("span", { class: "spacer" }), sel, go],
  });
  prompt.addEventListener("keydown", (e) => e.key === "Enter" && e.metaKey && submit());
  setTimeout(() => prompt.focus(), 30);
  async function submit() {
    const request = prompt.value.trim();
    if (request.length < 3) return prompt.focus();
    state.agent = sel.value;
    host.setSettings({ agent: sel.value });
    const r = await attempt(() => host.startAgent({ kind: "edit", id, request, agent: sel.value }));
    if (!r) return;
    state.jobs.set(id, { jobId: r.jobId, kind: "edit", request, events: [] });
    showProgress(id);
    refreshBlocks();
  }
}

let progressFor: string | null = null;
let progressRedraw: (() => void) | null = null;

function showProgress(blockId: string) {
  const job = state.jobs.get(blockId);
  if (!job) return toast("This block is being built in another window.");
  const b = blockById(blockId);
  const status = h("div", { class: "status-line" });
  const steps = h("ol", { class: "steps" });
  const extra = h("div", { class: "field" });
  const foot = h("div", { class: "row", style: "flex:1" });
  progressFor = blockId;

  const draw = () => {
    const done = job.done;
    const last = [...job.events].reverse().find((e) => e.type === "status") as { text: string } | undefined;
    status.replaceChildren(
      ...(done
        ? done.ok
          ? [h("span", { class: "mark ok" }, svg(ICONS.check)), job.kind === "create" ? "Your block is ready" : "Change applied"]
          : done.cancelled
            ? [h("span", { class: "mark err" }, svg(ICONS.stop)), "Cancelled"]
            : [h("span", { class: "mark err" }, svg(ICONS.close)), "The block still has problems"]
        : [h("span", { class: "spinner" }), last?.text ?? "Starting agent…"]),
    );
    steps.replaceChildren(
      ...job.events
        .filter((e) => e.type !== "done")
        .map((e) => {
          const ev = e as { type: string; text: string };
          return h("li", { class: ev.type }, h("span", { class: "k" }, ev.type === "tool" ? svg(ICONS.terminal) : ev.type === "status" ? svg(ICONS.chevron) : ev.type === "log" ? svg(ICONS.dot) : ""), h("span", {}, ev.text));
        }),
    );
    steps.scrollTop = steps.scrollHeight;
    extra.replaceChildren();
    foot.replaceChildren();
    if (!done) {
      foot.append(
        h("span", { class: "hint" }, `${agentLabel(state.agent)} is working. You can hide this and keep using BASS BLOCK.`),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => host.cancelAgent(job.jobId) }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => m.close() }, "Hide"),
      );
    } else if (done.ok) {
      if (done.blockage) {
        extra.append(
          h(
            "div",
            { class: "skill-card" },
            h("div", { class: "row" }, svg(ICONS.bolt), h("strong", {}, `Blockage Reported: ${done.blockage.title}`), h("span", { class: "spacer" }), h("span", { class: "chip busy" }, done.blockage.missingCapability)),
            h("p", {}, done.blockage.error),
          ),
        );
      }
      foot.append(
        ...nodes(
          done.blockage
            ? h("button", { class: "btn", onclick: () => showBlockageModal(done.blockage!) }, svg(ICONS.bolt), "Report Blockage & Proposal…")
            : null,
          h("span", { class: "spacer" }),
          h("button", { class: "btn", onclick: () => m.close() }, "Done"),
          h("button", { class: "btn primary", onclick: () => (m.close(), openBlock(blockId)) }, "Open block"),
        ),
      );
    } else if (done.cancelled && job.kind === "create") {
      foot.append(h("span", { class: "spacer" }), h("button", { class: "btn primary", onclick: () => m.close() }, "Close"));
    } else {
      if (done.blockage) {
        extra.append(
          h(
            "div",
            { class: "skill-card" },
            h("div", { class: "row" }, svg(ICONS.bolt), h("strong", {}, done.blockage.title), h("span", { class: "spacer" }), h("span", { class: "chip err" }, done.blockage.missingCapability)),
            h("p", {}, done.blockage.error),
          ),
        );
      } else if (done.problems.length) {
        extra.append(h("ol", { class: "problems" }, ...done.problems.slice(0, 8).map((p) => h("li", {}, `${p.file ? p.file + ": " : ""}${p.message}`))));
      }
      const more = h("textarea", { class: "prompt", style: "min-height:72px", placeholder: "Add more detail for the next try (optional)" });
      if (!done.cancelled) extra.append(more);
      const reportPayload: Partial<BlockageReport> = done.blockage ?? {
        blockId,
        request: job.request,
        agent: state.agent,
        title: `Cannot build: ${job.request.slice(0, 56)}`,
        error: done.problems.map((p) => `[${p.step}] ${p.message}`).join("\n"),
        missingCapability: "Host / SDK Extension",
        proposal: `Implement support in BASS BLOCK host / bb SDK to resolve: ${done.problems.map((p) => p.message).join("; ")}`,
        problems: done.problems,
      };
      foot.append(
        h("button", { class: "btn", onclick: () => showBlockageModal(reportPayload) }, svg(ICONS.bolt), "Report Blockage & Proposal…"),
        h("span", { class: "spacer" }),
        h("button", { class: "btn", onclick: () => (m.close(), openBlock(blockId)) }, "Open anyway"),
        h(
          "button",
          {
            class: "btn primary",
            onclick: async () => {
              const detail = more.value.trim();
              const request = done.cancelled ? job.request : `${job.request}${detail ? `\n\nMore detail: ${detail}` : ""}\n\nThe previous attempt left these problems: ${done.problems.map((p) => p.message).join("; ")}`;
              const r = await attempt(() => host.startAgent({ kind: "edit", id: blockId, request, agent: state.agent }));
              if (!r) return;
              state.jobs.set(blockId, { jobId: r.jobId, kind: job.kind, request: job.request, events: [] });
              showProgress(blockId);
            },
          },
          svg(ICONS.sparkle),
          "Try again",
        ),
      );
    }
  };
  progressRedraw = draw;
  const m = modal({
    title: h("span", {}, job.kind === "create" ? "Building " : "Modifying ", h("strong", {}, b?.name ?? blockId)),
    body: [h("div", { class: "progress" }, status, steps, extra)],
    foot: [foot],
    onClose: () => {
      progressFor = null;
      progressRedraw = null;
    },
  });
  draw();
}

async function showSettings() {
  const [agents, runtimes, info] = await Promise.all([host.detectAgents(), host.detectRuntimes(), host.info()]);
  state.agents = agents;
  state.runtimes = runtimes;
  const list = h("div", { class: "field", role: "radiogroup", "aria-label": "Coding agent" });
  const draw = () =>
    list.replaceChildren(
      ...state.agents.map((a) =>
        h(
          "div",
          {
            class: `agent-opt ${state.agent === a.id ? "on" : ""} ${!a.path ? "disabled" : ""}`,
            role: "radio",
            tabIndex: a.path ? 0 : -1,
            "aria-checked": String(state.agent === a.id),
            onclick: async () => {
              if (!a.path) return;
              state.agent = a.id;
              await host.setSettings({ agent: a.id });
              draw();
              renderSidebar();
            },
          },
          h("span", { class: "radio", "aria-hidden": "true" }),
          h("div", { class: "field", style: "gap:1px;flex:1;min-width:0" }, h("strong", {}, a.label), h("span", { class: "meta", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, a.detail ?? a.path ?? "Not installed")),
          a.path ? h("span", { class: "chip ok" }, state.agent === a.id ? "Default" : a.kind === "ollama" ? "Local Free" : a.custom ? "Linked" : "Installed") : h("span", { class: "chip" }, "Not found"),
          a.custom
            ? h(
                "button",
                {
                  class: "btn ghost small icon-btn",
                  title: `Remove ${a.label}`,
                  onclick: async (e: Event) => {
                    e.stopPropagation();
                    const res = await attempt(() => host.deleteCustomAgent(a.id));
                    if (res) {
                      state.agents = res.agents;
                      state.agent = res.settings.agent;
                      draw();
                      renderSidebar();
                      toast(`Removed ${a.label}`);
                    }
                  },
                },
                svg(ICONS.close),
              )
            : null,
        ),
      ),
    );
  draw();

  const runtimeGrid = h(
    "div",
    { class: "runtime-grid" },
    ...state.runtimes.map((rt) =>
      h(
        "button",
        {
          class: `runtime-item ${rt.path ? "" : "missing"}`,
          title: rt.path ? `${rt.label} (${rt.path}) — click for details` : `Click to view installation instructions for ${rt.label}`,
          onclick: () => showRuntimeInstallModal(rt),
        },
        h("span", { class: `dot ${rt.path ? "" : "err"}` }),
        h("strong", {}, rt.label),
        h("span", { class: "r-ver" }, rt.path ? (rt.version ?? rt.bin) : "Install →"),
      ),
    ),
  );

  modal({
    title: "AI & Polyglot Runtime Settings",
    head: [
      h(
        "button",
        {
          class: "btn small",
          onclick: () => showSavedBlockageReports(),
        },
        svg(ICONS.bolt),
        "Blockage Proposals",
      ),
      h(
        "button",
        {
          class: "btn primary small",
          onclick: () => showLinkAgent(),
        },
        svg(ICONS.plus),
        "Link AI Agent / Free Model",
      ),
    ],
    body: [
      h("p", { class: "hint", style: "margin:0" }, "Choose any installed coding CLI (Claude Code, Gemini CLI, Codex, OpenClaude, OpenCode, Aider, Goose) or link any free/local/cloud model (Ollama, OpenRouter Free, Gemini API, LM Studio, or a custom CLI)."),
      list,
      h("div", { class: "field" }, h("label", {}, "Detected Polyglot Language Toolchains (click any missing toolchain to install)"), runtimeGrid),
      h(
        "div",
        { class: "field" },
        h("label", {}, "External Agent Skill & CLI (Antigravity / Claude Code)"),
        h(
          "div",
          { class: "row" },
          h("code", { class: "selectable" }, `${info.home}/bin/bassblock`),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "btn small",
              onclick: async () => {
                const res = await attempt(() => host.installSkill());
                if (res) toast(`Installed skill & CLI (${res.installed.length} paths synced)`);
              },
            },
            "Sync Skill & CLI",
          ),
          h("button", { class: "btn small", onclick: () => host.revealHome() }, "Show in Finder"),
        ),
      ),
    ],
    foot: [h("span", { class: "hint" }, `BASS BLOCK ${info.version} · ${info.platform}/${info.arch}`), h("span", { class: "spacer" })],
  });
}

function copyCmdRow(cmd: string) {
  return h(
    "div",
    { class: "cmd-row" },
    h("code", {}, cmd),
    h(
      "button",
      {
        class: "btn small",
        onclick: () => {
          navigator.clipboard?.writeText(cmd);
          toast(`Copied: ${cmd}`);
        },
      },
      svg(ICONS.clipboard),
      "Copy",
    ),
  );
}

function showBlockageModal(initial: Partial<BlockageReport> = {}) {
  const titleIn = h("input", {
    class: "input",
    placeholder: "Short summary of what could not be built",
    value: initial.title ?? "",
  });
  const capIn = h("input", {
    class: "input",
    placeholder: "Missing BASS BLOCK capability or system requirement (e.g. WebUSB API, custom native bridge)",
    value: initial.missingCapability ?? "Host / SDK Extension",
  });
  const errIn = h("textarea", {
    class: "prompt",
    style: "min-height:84px;font-size:12.5px",
    placeholder: "Describe the error or limitation encountered…",
    value: initial.error ?? "",
  });
  const propIn = h("textarea", {
    class: "prompt",
    style: "min-height:130px;font-size:12.5px",
    placeholder: "Technical proposal for how BASS BLOCK should implement this capability…",
    value:
      initial.proposal ??
      "1. Expose the missing capability in src/main/bbApi.ts and src/preload/block.ts.\n2. Gate it behind a declared permission in sdk/block.schema.json.\n3. Document usage in sdk/skills/bass-block-builder/SKILL.md.",
  });

  function buildReport(): Partial<BlockageReport> {
    return {
      ...initial,
      title: titleIn.value.trim() || "Blockage Report & Feature Proposal",
      missingCapability: capIn.value.trim() || "Host / SDK Extension",
      error: errIn.value.trim(),
      proposal: propIn.value.trim(),
    };
  }

  const m = modal({
    title: "Report Blockage & Feature Proposal",
    head: [
      h("button", { class: "btn small", onclick: () => showSavedBlockageReports() }, "Saved Reports"),
    ],
    body: [
      h(
        "p",
        { class: "hint", style: "margin:0" },
        "When a block requests a capability BASS BLOCK doesn't support yet, this report logs the error and sends an implementation proposal so we can add it to BASS BLOCK.",
      ),
      h("div", { class: "field" }, h("label", {}, "What Could Not Be Built"), titleIn),
      h("div", { class: "field" }, h("label", {}, "Missing Capability / SDK Feature"), capIn),
      h("div", { class: "field" }, h("label", {}, "Error / Limitation Details"), errIn),
      h("div", { class: "field" }, h("label", {}, "Proposed BASS BLOCK Implementation (Editable)"), propIn),
    ],
    foot: [
      h("button", { class: "btn ghost", onclick: () => m.close() }, "Close"),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            const res = await attempt(() => host.submitBlockageReport(buildReport(), "save"));
            if (res) {
              navigator.clipboard?.writeText(res.markdown);
              toast("Saved report & copied proposal Markdown to clipboard");
              m.close();
            }
          },
        },
        svg(ICONS.clipboard),
        "Save & Copy Proposal",
      ),
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            const res = await attempt(() => host.submitBlockageReport(buildReport(), "github"));
            if (res) {
              navigator.clipboard?.writeText(res.markdown);
              toast("Opened GitHub Issue & saved proposal locally");
              m.close();
            }
          },
        },
        svg(ICONS.globe),
        "Send Proposal to GitHub ↗",
      ),
    ],
  });
}

async function showSavedBlockageReports() {
  const reports = ((await attempt(() => host.listBlockageReports())) as BlockageReport[] | undefined) ?? [];
  const list = h("ul", { class: "history-list" });
  list.replaceChildren(
    ...reports.map((r) =>
      h(
        "li",
        { class: "history-row" },
        h("span", { class: "h-meta" }, new Date(r.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })),
        h("span", { class: "chip busy" }, r.missingCapability),
        h("span", { class: "h-msg", title: r.error }, r.title),
        h("button", { class: "btn small", onclick: () => showBlockageModal(r) }, "Open Proposal"),
      ),
    ),
  );
  modal({
    title: "Blockage Reports & Implementation Proposals",
    head: [
      h("button", { class: "btn small", onclick: () => host.revealReports() }, "Show Folder in Finder"),
      h("button", { class: "btn primary small", onclick: () => showBlockageModal() }, svg(ICONS.plus), "New Proposal"),
    ],
    body: [
      h("p", { class: "hint", style: "margin:0" }, "All reported blockages and AI implementation proposals are saved as Markdown in ~/BassBlock/state/reports/."),
      reports.length ? list : h("p", { class: "hint" }, "No blockage reports recorded yet."),
    ],
    foot: [
      h("button", { class: "btn ghost", onclick: () => showSettings() }, "← Back to AI Settings"),
      h("span", { class: "spacer" }),
    ],
  });
}

function showRuntimeInstallModal(rt: RuntimeInfo) {
  const guide = rt.install;
  const statusBanner = h(
    "div",
    { class: "row", style: "padding:10px 12px;border-radius:var(--r-sm);background:var(--surface-2);border:1px solid var(--border)" },
    h("span", { class: `dot ${rt.path ? "" : "err"}` }),
    h("strong", {}, rt.path ? `Installed: ${rt.version ?? rt.bin}` : `${rt.label} is not installed yet`),
    h("span", { class: "spacer" }),
    rt.path ? h("code", {}, rt.path) : h("span", { class: "chip err" }, "Missing on PATH"),
  );

  const stepsNodes = (guide?.steps ?? []).map((step, i) =>
    h(
      "div",
      { class: "install-step" },
      h("strong", {}, `${i + 1}. ${step.title}`),
      step.cmd ? copyCmdRow(step.cmd) : null,
      step.note ? h("span", { class: "hint" }, step.note) : null,
    ),
  );

  const verifyNode = guide?.verifyCmd
    ? h(
        "div",
        { class: "install-step" },
        h("strong", {}, "Verify in Terminal"),
        copyCmdRow(guide.verifyCmd),
        h("span", { class: "hint" }, "After running the install command in Terminal, click “Re-check Installation” below."),
      )
    : null;

  modal({
    title: h("span", {}, rt.path ? "Toolchain Details — " : "Install ", h("strong", {}, rt.label)),
    body: nodes(
      statusBanner,
      guide?.summary ? h("p", { class: "hint", style: "margin:0" }, guide.summary) : null,
      ...stepsNodes,
      verifyNode,
    ) as Node[],
    foot: nodes(
      h("button", { class: "btn ghost", onclick: () => showSettings() }, "← Back to AI Settings"),
      h("span", { class: "spacer" }),
      guide?.docsUrl
        ? h("button", { class: "btn", onclick: () => host.openExternal(guide.docsUrl) }, svg(ICONS.globe), "Official Website ↗")
        : null,
      h(
        "button",
        {
          class: "btn primary",
          onclick: async () => {
            const updated = (await attempt(() => host.detectRuntimes())) as RuntimeInfo[] | undefined;
            if (!updated) return;
            state.runtimes = updated;
            const found = updated.find((r) => r.id === rt.id);
            if (found?.path) {
              toast(`✓ ${found.label} detected (${found.version ?? found.path})`);
              showSettings();
            } else {
              toast(`${rt.label} is still not detected on PATH.`, "err");
              if (found) showRuntimeInstallModal(found);
            }
          },
        },
        svg(ICONS.reload),
        "Re-check Installation",
      ),
    ) as Node[],
  });
}

function showLinkAgent() {
  let tab: "cli" | "api" = "cli";
  const cliName = h("input", { class: "input", placeholder: "e.g. OpenClaude (Free)", value: "OpenClaude (Free)" });
  const cliCmd = h("input", { class: "input", placeholder: "Binary name or path (e.g. openclaude, claude, opencode, aider)", value: "openclaude" });
  const cliArgs = h("input", { class: "input", placeholder: "Optional args template (leave blank for default, or e.g. -p {{prompt}})", value: "" });
  const cliEnv = h("textarea", {
    class: "prompt",
    style: "min-height:76px;font-family:var(--mono);font-size:12px",
    placeholder: "Optional ENV variables (KEY=VALUE, one per line):\ne.g. ANTHROPIC_BASE_URL=http://127.0.0.1:11434\nANTHROPIC_AUTH_TOKEN=ollama",
  });

  const apiName = h("input", { class: "input", placeholder: "e.g. Ollama Local (Qwen Coder)", value: "Ollama · Qwen 2.5 Coder (Free)" });
  const apiUrl = h("input", { class: "input", placeholder: "OpenAI-compatible Base URL (e.g. http://127.0.0.1:11434/v1)", value: "http://127.0.0.1:11434/v1" });
  const apiModel = h("input", { class: "input", placeholder: "Model ID (e.g. qwen2.5-coder:7b)", value: "qwen2.5-coder:7b" });
  const apiKey = h("input", { class: "input", type: "password", placeholder: "Optional for local Ollama/LM Studio; required for OpenRouter/Gemini", value: "" });

  const CLI_PRESETS: [string, string, string, string, string][] = [
    ["OpenClaude CLI", "OpenClaude", "openclaude", "", ""],
    ["Claude CLI + Local Ollama (Free)", "Claude + Ollama (Free)", "claude", "", "ANTHROPIC_BASE_URL=http://127.0.0.1:11434\nANTHROPIC_AUTH_TOKEN=ollama"],
    ["OpenCode CLI", "OpenCode", "opencode", "run {{prompt}}", ""],
    ["Aider + Local Ollama (Free)", "Aider + Ollama (Free)", "aider", "--model ollama_chat/qwen2.5-coder:7b --yes-always --no-git --message-file {{prompt_file}}", ""],
  ];

  const API_PRESETS: [string, string, string, string][] = [
    ["Ollama (Local Free)", "Ollama · Qwen 2.5 Coder (Free)", "http://127.0.0.1:11434/v1", "qwen2.5-coder:7b"],
    ["OpenRouter (Free Cloud)", "OpenRouter Free (Qwen Coder)", "https://openrouter.ai/api/v1", "qwen/qwen3-coder:free"],
    ["Gemini API (Free Tier)", "Google Gemini 2.5 Flash", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"],
    ["LM Studio (Local Free)", "LM Studio Local Model", "http://127.0.0.1:1234/v1", "local-model"],
  ];

  const cliPane = h(
    "div",
    { class: "field" },
    h(
      "div",
      { class: "examples", style: "justify-content:flex-start;margin-top:0" },
      ...CLI_PRESETS.map(([btnLabel, name, cmd, args, envStr]) =>
        h(
          "button",
          {
            class: "example",
            onclick: () => {
              cliName.value = name;
              cliCmd.value = cmd;
              cliArgs.value = args;
              cliEnv.value = envStr;
            },
          },
          svg(ICONS.terminal),
          btnLabel,
        ),
      ),
    ),
    h("div", { class: "field" }, h("label", {}, "Display Name"), cliName),
    h("div", { class: "field" }, h("label", {}, "CLI Command or Binary Path"), cliCmd),
    h("div", { class: "field" }, h("label", {}, "Arguments Template (optional — placeholders: {{prompt}}, {{prompt_file}}, {{code_dir}})"), cliArgs),
    h("div", { class: "field" }, h("label", {}, "Custom Environment Variables (optional — e.g. point OpenClaude/Claude at a free endpoint)"), cliEnv),
  );

  const apiPane = h(
    "div",
    { class: "field", hidden: true },
    h(
      "div",
      { class: "examples", style: "justify-content:flex-start;margin-top:0" },
      ...API_PRESETS.map(([btnLabel, name, url, model]) =>
        h(
          "button",
          {
            class: "example",
            onclick: () => {
              apiName.value = name;
              apiUrl.value = url;
              apiModel.value = model;
            },
          },
          svg(ICONS.sparkle),
          btnLabel,
        ),
      ),
    ),
    h("div", { class: "field" }, h("label", {}, "Display Name"), apiName),
    h("div", { class: "field" }, h("label", {}, "OpenAI-Compatible Base URL"), apiUrl),
    h("div", { class: "field" }, h("label", {}, "Model ID"), apiModel),
    h("div", { class: "field" }, h("label", {}, "API Key (leave empty for local Ollama / LM Studio)"), apiKey),
  );

  const tabs = h("div", { class: "tabs" });
  const drawTabs = () => {
    tabs.replaceChildren(
      h("button", { class: tab === "cli" ? "on" : "", onclick: () => ((tab = "cli"), drawTabs()) }, "Link CLI Agent (OpenClaude, etc.)"),
      h("button", { class: tab === "api" ? "on" : "", onclick: () => ((tab = "api"), drawTabs()) }, "Link Free / Local Model API"),
    );
    cliPane.hidden = tab !== "cli";
    apiPane.hidden = tab !== "api";
  };
  drawTabs();

  function buildPayload() {
    if (tab === "cli") {
      const env: Record<string, string> = {};
      for (const line of cliEnv.value.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return {
        kind: "cli",
        label: cliName.value.trim(),
        command: cliCmd.value.trim(),
        argsTemplate: cliArgs.value.trim() || undefined,
        env: Object.keys(env).length ? env : undefined,
      };
    }
    return {
      kind: "api",
      label: apiName.value.trim(),
      baseUrl: apiUrl.value.trim(),
      model: apiModel.value.trim(),
      apiKey: apiKey.value.trim() || undefined,
    };
  }

  const testBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const res = await attempt(() => host.testAgent(buildPayload()));
        if (res) toast(res.message, res.ok ? "info" : "err");
      },
    },
    "Test Connection",
  );
  const saveBtn = h(
    "button",
    {
      class: "btn primary",
      onclick: async () => {
        const res = await attempt(() => host.saveCustomAgent(buildPayload()));
        if (!res) return;
        state.agents = res.agents;
        state.agent = res.settings.agent;
        renderSidebar();
        toast(`Linked ${buildPayload().label}`);
        showSettings();
      },
    },
    svg(ICONS.check),
    "Save & Link Agent",
  );

  modal({
    title: "Link AI Agent or Free Model",
    head: [tabs],
    body: [cliPane, apiPane],
    foot: [
      h("button", { class: "btn ghost", onclick: () => showSettings() }, "← Back to AI Settings"),
      h("span", { class: "spacer" }),
      testBtn,
      saveBtn,
    ],
  });
}

// ---------------------------------------------------------------- events from main
host.onBlocksChanged(() => refreshBlocks());
host.onNavigate(async ({ id }: { id: string }) => {
  await refreshBlocks();
  if (!state.open.includes(id)) state.open.push(id);
  state.view = id;
  render();
});
host.onAgentEvent(({ blockId, event }: { jobId: string; blockId: string; event: AgentEvent }) => {
  const job = state.jobs.get(blockId);
  if (!job) return;
  if (event.type === "done") {
    job.done = event;
    refreshBlocks();
    if (progressFor !== blockId && !event.cancelled) {
      toast(event.ok ? `✓ ${blockById(blockId)?.name ?? blockId} is ready` : `${blockById(blockId)?.name ?? blockId} needs attention`, event.ok ? "info" : "err");
    }
  } else job.events.push(event);
  if (progressFor === blockId) progressRedraw?.();
  if (state.view === blockId) renderTopbar();
});
host.onBlockLog(({ id, level, text }: { id: string; level: string; text: string }) => {
  if (state.logsOpen && (state.view === id || state.splitView === id)) {
    $("#log-list").append(logRow({ level, text }));
    scrollLogs();
  }
});
host.onBlockCrashed(({ id, reason }: { id: string; reason: string }) => toast(`${blockById(id)?.name ?? id} stopped (${reason}). Reload to restart it.`, "err"));
host.onBlockClosed(({ id }: { id: string }) => {
  state.open = state.open.filter((x) => x !== id);
  if (state.splitView === id) state.splitView = null;
  if (state.view === id) state.view = state.splitView ?? "home";
  render();
});

$("#nav-home").addEventListener("click", goHome);
$("#nav-new").addEventListener("click", () => showCreate());
$("#btn-settings").addEventListener("click", showSettings);
host.onMenu(({ action }: { action: string }) => {
  const id = state.view !== "home" ? state.view : null;
  if (action === "new") return showCreate();
  if (action === "home") return goHome();
  if (!id) return;
  if (action === "close") closeBlock(id);
  else if (action === "reload") host.reloadBlock(id);
  else if (action === "edit") showEdit(id);
  else if (action === "undo") undoAi(id);
  else if (action === "history") showHistory(id);
  else if (action === "split") toggleSplitMenu();
  else if (action === "logs") toggleLogs();
  else if (action === "devtools") host.devtools(id);
});

setInterval(async () => {
  if (state.view === "home") return;
  state.metrics = await host.metrics();
  const meter = document.querySelector("#topbar .meter");
  const m = state.metrics[state.view];
  if (meter && m) meter.textContent = `${m.memoryMb} MB`;
  else if (!meter && m) renderTopbar();
}, 3000);

(async () => {
  const [agents, runtimes, settings] = await Promise.all([host.detectAgents(), host.detectRuntimes(), host.getSettings()]);
  state.agents = agents;
  state.runtimes = runtimes;
  state.agent = agents.find((a: AgentInfo) => a.id === settings.agent && a.path) ? settings.agent : agents.find((a: AgentInfo) => a.path)?.id ?? settings.agent;
  await refreshBlocks();
})();
