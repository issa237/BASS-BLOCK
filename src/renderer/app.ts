// Host UI: sidebar, block library grid, open-block tabs, create/modify dialogs, AI settings.

interface BlockItem {
  id: string;
  ok: boolean;
  error?: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  permissions: string[];
  open: boolean;
  building: boolean;
  thumb: string | null;
}
interface AgentInfo { id: string; label: string; path: string | null }
type AgentEvent =
  | { type: "status" | "text" | "tool" | "log"; text: string }
  | { type: "done"; ok: boolean; problems: { step: string; message: string; file?: string }[]; cancelled?: boolean };

declare const host: any;

// ---------------------------------------------------------------- state
const state = {
  blocks: [] as BlockItem[],
  open: [] as string[], // open block ids, in tab order
  view: "home" as "home" | string, // "home" or a block id
  search: "",
  agents: [] as AgentInfo[],
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
  s.innerHTML = path;
  return s;
};
const ICONS = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  sparkle: '<path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6zM15.5 13l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  undo: '<path d="M7 5L3.5 8.5 7 12"/><path d="M4 8.5h7.5a4.5 4.5 0 010 9H9"/>',
  reload: '<path d="M16 10a6 6 0 11-1.8-4.3"/><path d="M16 3.5v3.7h-3.7"/>',
  logs: '<path d="M4 5h12M4 10h12M4 15h8"/>',
  more: '<circle cx="5" cy="10" r="1.2"/><circle cx="10" cy="10" r="1.2"/><circle cx="15" cy="10" r="1.2"/>',
  close: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
};

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
  if (state.view !== "home" && !state.open.includes(state.view)) state.view = "home";
  render();
}

// ---------------------------------------------------------------- navigation
async function openBlock(id: string) {
  const res = await attempt(() => host.openBlock(id));
  if (!res) return;
  if (!state.open.includes(id)) state.open.push(id);
  state.view = id;
  render();
  syncViewport();
}
function goHome() {
  state.view = "home";
  host.showBlock(null);
  render();
}
async function closeBlock(id: string) {
  await host.closeBlock(id);
  const idx = state.open.indexOf(id);
  state.open = state.open.filter((x) => x !== id);
  if (state.view === id) {
    const next = state.open[Math.min(idx, state.open.length - 1)];
    if (next) {
      state.view = next;
      host.showBlock(next);
    } else state.view = "home";
  }
  render();
}

/** Keep the native block view glued to #block-viewport. */
function syncViewport() {
  const el = $("#block-viewport");
  const r = el.getBoundingClientRect();
  host.setViewBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  host.showBlock(state.view !== "home" && !state.modalOpen ? state.view : null);
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
      return h(
        "li",
        { class: `side-row ${state.view === id ? "active" : ""}`, onclick: () => openBlock(id) },
        h("span", { class: "ico" }, b?.icon ?? "▦"),
        h("span", { class: "label" }, b?.name ?? id),
        h("button", { class: "x", title: "Close", onclick: (e: Event) => (e.stopPropagation(), closeBlock(id)) }, svg(ICONS.close)),
      );
    }),
  );
  $("#open-empty").hidden = state.open.length > 0;
  $("#block-list").replaceChildren(
    ...state.blocks.map((b) =>
      h(
        "li",
        { class: "side-row", onclick: () => (b.building ? showProgress(b.id) : openBlock(b.id)), oncontextmenu: (e: Event) => (e.preventDefault(), blockMenu(b.id)) },
        h("span", { class: "ico" }, b.icon),
        h("span", { class: "label" }, b.name),
        b.building ? h("span", { class: "spinner", title: "AI is working on this block" }) : !b.ok ? h("span", { class: "dot err", title: b.error }) : null,
      ),
    ),
  );
  $("#agent-pill").textContent = agentLabel(state.agent);
}

function topBtn(label: string, icon: string, onclick: () => void, opts: { primary?: boolean; title?: string; iconOnly?: boolean; disabled?: boolean } = {}) {
  return h(
    "button",
    { class: `btn ${opts.primary ? "primary" : "ghost"} ${opts.iconOnly ? "icon-btn" : ""}`, title: opts.title ?? label, onclick, disabled: opts.disabled },
    svg(icon),
    opts.iconOnly ? null : label,
  );
}

function renderTopbar() {
  const bar = $("#topbar");
  if (state.view === "home") {
    const search = h("input", {
      class: "search",
      type: "search",
      placeholder: "Search blocks",
      value: state.search,
      oninput: (e: Event) => {
        state.search = (e.target as HTMLInputElement).value;
        renderHome();
      },
    });
    bar.replaceChildren(...nodes(h("h1", {}, "Blocks"), h("span", { class: "spacer" }), state.blocks.length ? search : null, topBtn("New block", ICONS.plus, () => showCreate(), { primary: true })));
    return;
  }
  const id = state.view;
  const b = blockById(id);
  const m = state.metrics[id];
  const busy = state.jobs.has(id) && !state.jobs.get(id)!.done;
  bar.replaceChildren(...nodes(
    h("div", { class: "crumb" }, h("span", { class: "ico" }, b?.icon ?? "▦"), h("span", { class: "name" }, b?.name ?? id), h("span", { class: "ver" }, b?.version ? `v${b.version}` : "")),
    m ? h("span", { class: "meter", title: "Memory used by this block's process" }, `${m.memoryMb} MB`) : null,
    h("span", { class: "spacer" }),
    busy
      ? h("button", { class: "btn ghost", onclick: () => showProgress(id) }, h("span", { class: "spinner" }), "AI working…")
      : topBtn("Modify with AI", ICONS.sparkle, () => showEdit(id)),
    topBtn("Undo AI change", ICONS.undo, () => undoAi(id), { iconOnly: true, disabled: busy }),
    topBtn("Reload", ICONS.reload, () => host.reloadBlock(id), { iconOnly: true }),
    topBtn("Console", ICONS.logs, toggleLogs, { iconOnly: true }),
    topBtn("More", ICONS.more, () => blockMenu(id), { iconOnly: true }),
  ));
}

const EXAMPLES = [
  "A markdown editor with live word-frequency stats",
  "A sprite-sheet slicer for game dev",
  "A pomodoro timer with a daily log",
  "A JSON formatter and diff tool",
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
        h("button", { class: "big-plus", title: "New block", onclick: () => showCreate() }, svg(ICONS.plus)),
        h("h2", {}, "Build your first block"),
        h("p", {}, "Describe a tool in plain words. Your AI agent writes it, BASS BLOCK checks it runs, and it opens right here."),
        h("div", { class: "examples" }, ...EXAMPLES.map((ex) => h("button", { class: "example", onclick: () => showCreate(ex) }, ex))),
      ),
    );
    return;
  }
  const q = state.search.trim().toLowerCase();
  const list = state.blocks.filter((b) => !q || `${b.name} ${b.description} ${b.id}`.toLowerCase().includes(q));
  root.replaceChildren(
    h(
      "div",
      { class: "grid" },
      !q ? h("button", { class: "tile new", onclick: () => showCreate() }, h("span", { class: "plus" }, svg(ICONS.plus)), h("strong", {}, "New block"), h("span", { class: "hint" }, "Describe it, AI builds it")) : null,
      ...list.map(tile),
    ),
  );
}

function tile(b: BlockItem) {
  return h(
    "button",
    {
      class: "tile",
      onclick: () => (b.building ? showProgress(b.id) : openBlock(b.id)),
      oncontextmenu: (e: Event) => (e.preventDefault(), blockMenu(b.id)),
      title: b.description || b.name,
    },
    h("div", { class: "thumb" }, b.thumb ? h("img", { src: b.thumb, alt: "" }) : b.icon),
    h(
      "div",
      { class: "tile-body" },
      h("div", { class: "tile-title" }, h("span", {}, b.icon), h("span", { class: "t" }, b.name), b.open ? h("span", { class: "dot", title: "Open" }) : null),
      h("div", { class: "tile-desc" }, b.description || " "),
      h(
        "div",
        { class: "chips" },
        b.building ? h("span", { class: "chip busy" }, "AI building…") : null,
        !b.ok ? h("span", { class: "chip err", title: b.error }, "Needs repair") : null,
        b.version ? h("span", { class: "chip" }, `v${b.version}`) : null,
        ...b.permissions.map((p) => h("span", { class: "chip", title: p }, p.startsWith("Read and write files") ? "Files" : p.startsWith("Connect") ? "Network" : p.includes("clipboard") ? "Clipboard" : p)),
      ),
    ),
    h("span", { class: "btn small tile-menu icon-btn", onclick: (e: Event) => (e.stopPropagation(), blockMenu(b.id)) }, svg(ICONS.more)),
  );
}

async function blockMenu(id: string) {
  const b = blockById(id);
  const isOpen = state.open.includes(id);
  const choice = await host.popupMenu([
    { id: "open", label: "Open" },
    { id: "edit", label: "Modify with AI…" },
    { id: "undo", label: "Undo last AI change" },
    { separator: true },
    { id: "validate", label: "Run validation" },
    { id: "devtools", label: "Toggle Developer Tools", enabled: isOpen },
    { id: "reveal", label: "Show in Finder" },
    { separator: true },
    { id: "close", label: "Close", enabled: isOpen },
    { id: "delete", label: "Move to Trash…" },
  ]);
  switch (choice) {
    case "open": return openBlock(id);
    case "edit": return showEdit(id);
    case "undo": return undoAi(id);
    case "validate": {
      toast(`Validating ${b?.name ?? id}…`);
      const r = await attempt(() => host.validate(id));
      if (r) toast(r.ok ? `✓ ${b?.name} passed validation` : `✗ ${r.problems.length} problem(s): ${r.problems[0]?.message}`, r.ok ? "info" : "err");
      return;
    }
    case "devtools": return host.devtools(id);
    case "reveal": return host.reveal(id);
    case "close": return closeBlock(id);
    case "delete": {
      const gone = await attempt(() => host.deleteBlock(id));
      if (gone) {
        state.open = state.open.filter((x) => x !== id);
        if (state.view === id) state.view = "home";
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
function modal(opts: { title: Child; body: Node[]; foot: Node[]; onClose?: () => void; head?: Node[] }) {
  closeModal();
  state.modalOpen = true;
  host.showBlock(null);
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
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey, { once: true });
  return { el, close };
}
function closeModal() {
  if (!state.modalOpen) return;
  state.modalOpen = false;
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

const TEMPLATE_INFO: Record<string, [string, string]> = {
  "blank": ["Blank", "Minimal page with the bb SDK wired up"],
  "text-tool": ["Text tool", "Editor with live stats, saves with bb.storage"],
  "image-tool": ["Image tool", "Open, edit on a canvas, export PNG"],
  "three-viewer": ["3D viewer", "three.js scene with an STL loader"],
};

function showCreate(prefill = "") {
  let tab: "ai" | "template" = "ai";
  let template = "text-tool";
  const prompt = h("textarea", { class: "prompt", placeholder: "Describe the tool you want. For example: “A markdown editor with live word-frequency stats and a dark theme.”", value: prefill });
  const sel = agentSelect();
  const nameInput = h("input", { class: "input", placeholder: "Block name", value: "" });
  const tplGrid = h("div", { class: "tpl-grid" });
  const drawTpls = () =>
    tplGrid.replaceChildren(
      ...Object.entries(TEMPLATE_INFO).map(([k, [t, d]]) =>
        h("button", { class: `tpl ${template === k ? "on" : ""}`, onclick: () => ((template = k), drawTpls()) }, h("strong", {}, t), h("span", {}, d)),
      ),
    );
  drawTpls();
  const noAgent = !state.agents.some((a) => a.path);
  const aiPane = h(
    "div",
    { class: "field" },
    prompt,
    h("div", { class: "examples", style: "justify-content:flex-start" }, ...EXAMPLES.slice(0, 4).map((ex) => h("button", { class: "example", onclick: () => ((prompt.value = ex), prompt.focus()) }, ex))),
    noAgent ? h("p", { class: "hint" }, "No coding agent found. Install Claude Code, Gemini CLI or Codex, or start from a template instead.") : null,
  );
  const tplPane = h("div", { class: "field", hidden: true }, h("div", { class: "field" }, h("label", {}, "Name"), nameInput), h("label", { class: "label" }, "Template"), tplGrid);
  const tabs = h("div", { class: "tabs" });
  const go = h("button", { class: "btn primary", onclick: () => submit() }, svg(ICONS.sparkle), "Build block");
  const drawTabs = () => {
    tabs.replaceChildren(
      h("button", { class: tab === "ai" ? "on" : "", onclick: () => ((tab = "ai"), drawTabs()) }, "Describe it"),
      h("button", { class: tab === "template" ? "on" : "", onclick: () => ((tab = "template"), drawTabs()) }, "From template"),
    );
    aiPane.hidden = tab !== "ai";
    tplPane.hidden = tab !== "template";
    sel.hidden = tab !== "ai";
    go.replaceChildren(...(tab === "ai" ? [svg(ICONS.sparkle), "Build block"] : [svg(ICONS.plus), "Create"]));
  };
  drawTabs();

  const m = modal({
    title: "New block",
    head: [tabs],
    body: [aiPane, tplPane],
    foot: [h("span", { class: "kbd" }, "⌘↩ to build"), h("span", { class: "spacer" }), sel, go],
  });
  prompt.addEventListener("keydown", (e) => e.key === "Enter" && e.metaKey && submit());
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
  const prompt = h("textarea", { class: "prompt", placeholder: `What should change in “${b?.name ?? id}”? For example: “Add a dark mode toggle and remember the choice.”` });
  const sel = agentSelect();
  const go = h("button", { class: "btn primary", onclick: () => submit() }, svg(ICONS.sparkle), "Apply change");
  modal({
    title: h("span", {}, "Modify ", h("strong", {}, b?.name ?? id)),
    body: [prompt, h("p", { class: "hint" }, "The AI only edits this block's code. Your saved data is never touched, and you can undo the change afterwards.")],
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
          ? [h("span", { class: "okmark" }, "✓"), job.kind === "create" ? "Your block is ready" : "Change applied"]
          : done.cancelled
            ? [h("span", { class: "errmark" }, "■"), "Cancelled"]
            : [h("span", { class: "errmark" }, "✗"), "The block still has problems"]
        : [h("span", { class: "spinner" }), last?.text ?? "Starting agent…"]),
    );
    steps.replaceChildren(
      ...job.events
        .filter((e) => e.type !== "done")
        .map((e) => {
          const ev = e as { type: string; text: string };
          return h("li", { class: ev.type }, h("span", { class: "k" }, ev.type === "tool" ? "›" : ev.type === "status" ? "•" : ev.type === "log" ? "·" : ""), h("span", {}, ev.text));
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
      foot.append(h("span", { class: "spacer" }), h("button", { class: "btn", onclick: () => m.close() }, "Done"), h("button", { class: "btn primary", onclick: () => (m.close(), openBlock(blockId)) }, "Open block"));
    } else {
      if (done.problems.length) extra.append(h("ol", { class: "problems" }, ...done.problems.slice(0, 8).map((p) => h("li", {}, `${p.file ? p.file + ": " : ""}${p.message}`))));
      const more = h("textarea", { class: "prompt", style: "min-height:72px", placeholder: "Add more detail for the next try (optional)" });
      if (!done.cancelled) extra.append(more);
      foot.append(
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
  state.agents = await host.detectAgents();
  const info = await host.info();
  const list = h("div", { class: "field" });
  const draw = () =>
    list.replaceChildren(
      ...state.agents.map((a) =>
        h(
          "div",
          {
            class: `agent-opt ${state.agent === a.id ? "on" : ""} ${a.path ? "" : "off"}`,
            onclick: async () => {
              if (!a.path) return;
              state.agent = a.id;
              await host.setSettings({ agent: a.id });
              draw();
              renderSidebar();
            },
          },
          h("div", { class: "field", style: "gap:1px;flex:1" }, h("strong", {}, a.label), h("span", { class: "meta" }, a.path ?? "Not installed")),
          state.agent === a.id ? h("span", { class: "chip busy" }, "Default") : null,
        ),
      ),
    );
  draw();
  modal({
    title: "AI settings",
    body: [
      h("p", { class: "hint", style: "margin:0" }, "BASS BLOCK uses the coding agent you already have installed, in headless mode, inside each block's own folder. It gets no other API keys from BASS BLOCK and can only run ", h("code", {}, "bassblock validate"), "."),
      list,
      h("div", { class: "field" }, h("label", {}, "BASS BLOCK folder"), h("div", { class: "row" }, h("code", { class: "selectable" }, info.home), h("span", { class: "spacer" }), h("button", { class: "btn small", onclick: () => host.revealHome() }, "Show in Finder"))),
      h("p", { class: "hint", style: "margin:0" }, `Agents can also build blocks from a terminal: `, h("code", {}, `${info.home}/bin/bassblock help`)),
    ],
    foot: [h("span", { class: "hint" }, `BASS BLOCK ${info.version} · ${info.arch}`), h("span", { class: "spacer" })],
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
    if (progressFor !== blockId) toast(event.ok ? `✓ ${blockById(blockId)?.name ?? blockId} is ready` : `${blockById(blockId)?.name ?? blockId} needs attention`, event.ok ? "info" : "err");
  } else job.events.push(event);
  if (progressFor === blockId) progressRedraw?.();
  if (state.view === blockId) renderTopbar();
});
host.onBlockLog(({ id, level, text }: { id: string; level: string; text: string }) => {
  if (state.logsOpen && state.view === id) {
    $("#log-list").append(logRow({ level, text }));
    scrollLogs();
  }
});
host.onBlockCrashed(({ id, reason }: { id: string; reason: string }) => toast(`${blockById(id)?.name ?? id} stopped (${reason}). Reload to restart it.`, "err"));
host.onBlockClosed(({ id }: { id: string }) => {
  state.open = state.open.filter((x) => x !== id);
  if (state.view === id) state.view = "home";
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
  const [agents, settings] = await Promise.all([host.detectAgents(), host.getSettings()]);
  state.agents = agents;
  state.agent = agents.find((a: AgentInfo) => a.id === settings.agent && a.path) ? settings.agent : agents.find((a: AgentInfo) => a.path)?.id ?? settings.agent;
  await refreshBlocks();
})();
