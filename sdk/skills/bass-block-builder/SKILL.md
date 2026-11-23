---
name: bass-block-builder
description: Build or modify a BASS BLOCK block — a sandboxed mini-app (Web UI + optional Polyglot Backend in Python, Swift, Rust, C++, Go, or Node.js) that runs inside the BASS BLOCK host. Use when asked to create, change or fix a block, or when working in a folder that contains a block.json with "schema": 1.
---

# Building BASS BLOCK blocks

A **block** is a focused app that runs inside BASS BLOCK in its own sandboxed view.
Every block has an HTML/CSS/JS (or TypeScript `.ts`) UI that talks to the host through the global `bb` object (the BASS BLOCK SDK).
For tasks that benefit from another programming language (data science, AI/ML, video/audio processing, native macOS APIs, heavy 3D/game compute), a block can run in **`"mode": "polyglot"`** with a supervised local backend in **Python, Swift, Rust, C++, Go, or Node.js**.

## Choosing the Best Mode & Language

Pick the mode and language that best fits the user's request (and matches the runtimes installed on the machine; run `bassblock runtimes` to check):

| Domain / Task | Recommended Mode & Language | Why |
| :--- | :--- | :--- |
| Text editors, Markdown, JSON/diff, timers, 2D canvas, sprite tools | `"mode": "web"` (JS / TypeScript `.ts` + HTML/CSS) | Instant startup, zero backend process needed |
| 3D viewers, STL/OBJ/glTF inspection, shaders, WebGL games | `"mode": "web"` + vendored `three.min.js` (copy from `three-viewer`) | Full GPU WebGL acceleration inside the view |
| Data analysis, CSV/Excel/PDF, AI/ML, image/video/audio processing (FFmpeg) | `"mode": "polyglot"` with **Python** (`"language": "python"`) | Direct access to Python standard library, statistics, file/media tools |
| High-speed native compute, macOS native APIs (Vision, CryptoKit, Metal, CoreAudio) | `"mode": "polyglot"` with **Swift** (`"language": "swift"`) | Compiled native binary (`swiftc -O`), maximum speed on macOS |
| Systems tools, simulations, fast parsers, concurrency | `"mode": "polyglot"` with **Rust**, **C++**, **Go**, or **Node.js** | Compiled or concurrent local backend via `bb.backend.call` |

## Workflow

1. Read `block.json` and the existing files first. When editing, keep features and saved-data formats working.
2. Write the block (rules below). Keep the UI clean (`index.html`, `style.css`, `main.js` or `main.ts`) and put backend code (if `mode` is `"polyglot"`) in `backend/`.
3. Run `bassblock validate`. It checks the manifest, scans files, compiles & starts the backend (if `"polyglot"`), launches the UI headless in the real sandbox, and reports errors or empty renders.
4. Fix every reported problem and run `bassblock validate` again until it prints `✓ … passed validation`.
5. Finish with a one or two sentence summary for the user.

Only edit files inside the block's `code/` folder. Don't create `data/`, `.meta/` or `.git` content: the host owns them.

## block.json (schema 1)

### Web Block (`"mode": "web"`)
```json
{
  "schema": 1,
  "id": "md-wordfreq",
  "name": "Markdown + Word Stats",
  "description": "One line that says what the tool does.",
  "icon": "📝",
  "version": "0.1.0",
  "mode": "web",
  "sdk": "^1.0",
  "entry": { "ui": "index.html" },
  "permissions": { "fs": "none", "network": false, "clipboard": false },
  "io": {
    "inputs":  [{ "name": "text",  "type": "text/markdown" }],
    "outputs": [{ "name": "stats", "type": "application/json" }]
  },
  "platform": { "os": "any", "arch": ["arm64", "x64"] }
}
```

### Polyglot Block (`"mode": "polyglot"`)
```json
{
  "schema": 1,
  "id": "py-analyzer",
  "name": "Python Data Analyzer",
  "description": "Analyzes datasets with a local Python 3 backend.",
  "icon": "🐍",
  "version": "0.1.0",
  "mode": "polyglot",
  "sdk": "^1.0",
  "entry": { "ui": "index.html" },
  "backend": {
    "language": "python",
    "protocol": "stdio",
    "run": ["python3", "-u", "backend/main.py"]
  },
  "permissions": { "fs": "user-picked-files", "network": false, "clipboard": false }
}
```

For compiled backends (Swift, Rust, C++, Go), add `"build"` so BASS BLOCK compiles the binary into `.bin/` automatically (and caches it until source files change):
- **Swift**: `"build": ["swiftc", "-O", "backend/main.swift", "-o", ".bin/server"]`, `"run": [".bin/server"]`
- **C++**: `"build": ["clang++", "-O2", "-std=c++20", "backend/main.cpp", "-o", ".bin/server"]`, `"run": [".bin/server"]`
- **Go**: `"build": ["go", "build", "-o", ".bin/server", "backend/main.go"]`, `"run": [".bin/server"]`
- **Rust**: `"build": ["rustc", "-O", "backend/main.rs", "-o", ".bin/server"]`, `"run": [".bin/server"]`
- **Node.js**: `"run": ["node", "backend/main.js"]`

If a Python or Node.js backend needs third-party packages, list them in `"dependencies"` inside `"backend"` (for example `"dependencies": ["pillow", "numpy"]`). BASS BLOCK automatically installs them into an isolated environment in `code/.bin/` before starting the backend.

### Manifest Rules
- `id` must stay exactly as given (it matches the folder). Never change it.
- Bump `version` (patch) whenever you change a block.
- **Permissions: declare the minimum.** The user approves them before the block opens, and is asked again if they change.
  - `"fs": "user-picked-files"`: needed for `bb.fs.*` (open/save files, directory pickers, streaming URLs, and backend file paths). Drag-and-drop of files into the page needs no permission.
  - `"network"`: `false` (default), or a list of hostnames like `["api.github.com"]`, or `true` for any HTTPS host. Only needed for `bb.net.fetch`.
  - `"clipboard": true`: needed for `bb.clipboard.*`.
  - `"ai": true`: needed for `bb.ai.complete()` and `bb.ai.chat()` (reuses the user's linked AI model in BASS BLOCK).
  - `"camera": true`, `"microphone": true`, `"midi": true`: needed for `navigator.mediaDevices.getUserMedia` or WebMIDI.
  - `"notifications": true`: needed for `bb.notify()`.
  - `"background": true`: allows the block to keep running in the background while other blocks are active.

## Polyglot Backend Protocol (`stdio` and `http`)

### 1. `"protocol": "stdio"` (Recommended — Zero Dependencies)
The host spawns `backend.run` with `BB_BLOCK_ID`, `BB_CODE_DIR`, and `BB_DATA_DIR` in its environment.
When the UI calls `await bb.backend.call("myMethod", { a: 1 })`, the host writes one JSON line to the backend's `stdin`:
```json
{"id": 1, "method": "myMethod", "params": {"a": 1}}
```
The backend processes it and prints one JSON line to `stdout` (remember to flush `stdout`!):
```json
{"id": 1, "result": {"answer": 42}}
```
Or on error:
```json
{"id": 1, "error": "What went wrong"}
```
The backend can also push asynchronous events to the UI at any time by printing:
```json
{"event": "progress", "data": {"percent": 75}}
```
which the UI receives with `bb.backend.onEvent("progress", (data) => ...)`.

### 2. `"protocol": "http"` (Loopback HTTP Server)
If `"protocol": "http"` is set, the host assigns a free port in `process.env.BB_PORT` (`os.environ["BB_PORT"]`), waits for `GET http://127.0.0.1:$BB_PORT/health` (or `backend.healthPath`) to respond, and proxies `await bb.backend.fetch("/api/...", { method: "POST", body: ... })` from the UI.

## Hard Sandbox Rules for the UI (Validation Fails Otherwise)

- **No remote sub-resources.** No CDN `<script src="https://…">`, no Google Fonts, no remote `<img src="https://…">`, no `import … from "https://…"`. Normal external clickable links (`<a href="https://…">`) are allowed and open in the user's browser.
  If you need a JS library, write the code yourself or vendor a small file into the block folder (`vendor/lib.js`). `three.js` is available to copy from the `three-viewer` template (`vendor/three.min.js`).
- **No inline scripts.** All JS/TS goes in `.js` or `.ts` files loaded with `<script type="module" src="main.js"></script>` (or `main.ts` — BASS BLOCK uses Node's built-in type stripping on `.ts` files, so standard TypeScript type annotations, interfaces, and type aliases work out of the box; do not use `enum`, `namespace`, or `.tsx`/JSX, and always spell out the `.ts` or `.js` file extension in relative `import` paths).
  No `onclick="…"` attributes in HTML; use `addEventListener`.
- No `eval` / `new Function`. WebAssembly is allowed.
- `fetch()` in the UI works only for the block's own files (relative URLs). For the internet, use `bb.net.fetch` with a declared permission. For a local backend, use `bb.backend.call` or `bb.backend.fetch`.
- Don't use `localStorage`/`IndexedDB` for user data: use `bb.storage` / `bb.data` so data lives in the block's data folder and survives code changes and AI undo.

## The bb SDK (global `bb`, all methods async unless noted)

```js
await bb.info()                    // { id, name, version, mode, backend, sdk, permissions }
bb.ready()                         // call once your UI is rendered (helps validation)
bb.log("message", obj)             // shows in the host console panel

// Small JSON key/value store (≤10 MB total) in the block's data folder
await bb.storage.get(key)          // → value or null
await bb.storage.set(key, value)   // JSON-serialisable value
await bb.storage.delete(key)
await bb.storage.keys()

// Private files in the block's data folder (up to 512 MB each)
await bb.data.write("exports/a.png", uint8ArrayOrString)
await bb.data.read("exports/a.png")            // → Uint8Array or null
await bb.data.readText("notes.txt")            // → string or null
await bb.data.list()                           // → [{ name, size, modified }]
await bb.data.delete("exports/a.png")

// User-picked files & folders — needs "fs": "user-picked-files"
const files = await bb.fs.pickOpen({
  multiple: false,
  writable: true,                              // pass writable: true to allow saving back to the same handle!
  filters: [{ name: "Images", extensions: ["png", "jpg"] }]
})                                             // → [{ handle, name, size, writable }]
await bb.fs.read(files[0].handle)              // → Uint8Array
await bb.fs.readText(files[0].handle)          // → string
await bb.fs.write(files[0].handle, data)       // works when opened with writable: true or via pickSave()
const streamUrl = await bb.fs.url(files[0].handle)   // → block://<id>/__fs__/<handle> (zero-copy byte-range streaming for <video>/<audio>/<img>)
const diskPath = await bb.fs.path(files[0].handle)   // → real OS path to pass to your polyglot backend (FFmpeg/Python/Swift)
const out = await bb.fs.pickSave({ suggestedName: "result.png" })   // → { handle, name } or null
await bb.fs.write(out.handle, uint8ArrayOrString)

// User-picked project directories — needs "fs": "user-picked-files"
const dir = await bb.fs.pickDirectory({ writable: true })           // → { handle, name, writable } or null
const entries = await bb.fs.listDir(dir.handle, "subfolder")        // → [{ name, isDirectory, size, modified }]
const text = await bb.fs.readDirText(dir.handle, "subfolder/a.txt")
const bytes = await bb.fs.readDirFile(dir.handle, "model.stl")
await bb.fs.writeDirFile(dir.handle, "output/result.json", "{}")

// Polyglot Backend Bridge — requires "mode": "polyglot" and "backend" in block.json
const result = await bb.backend.call("analyze", { text: "hello" })  // for "protocol": "stdio"
const offEvt = bb.backend.onEvent("progress", (data) => {})         // push events (or live viewport frames) from backend
const resp = await bb.backend.fetch("/api/run", { method: "POST", body: "{}" }) // for "protocol": "http"

// In-Block AI — needs "ai": true (uses the AI agent/model linked in BASS BLOCK)
const summary = await bb.ai.complete("Summarize: ...", { system: "Be concise." })
const reply = await bb.ai.chat([{ role: "user", content: "Hello" }])

// Desktop Notifications — needs "notifications": true
await bb.notify({ title: "Render Complete", body: "Exported 120 frames." })

// Clipboard — needs "clipboard": true
await bb.clipboard.readText()
await bb.clipboard.writeText("hi")

// Network — needs "network": [...hosts] or true. HTTPS only.
const res = await bb.net.fetch("https://api.example.com/x", { method: "GET", headers: {} })
res.status; res.ok; res.headers; res.text(); res.json(); res.bytes()   // (these three are sync)

// Events between open blocks (binary-safe: Uint8Array & ArrayBuffer transfer without corruption!)
bb.emit("stats", { words: 120 })                 // to every other open block
const off = bb.on("text", (data, { from }) => {})  // returns an unsubscribe function
```

## Example blocks

Look at the templates for working patterns before writing your own:
- `blank`: minimal web starter with `bb.storage`
- `text-tool`: markdown editor + live stats, autosave, writable open/save files, emits `stats`, accepts `text`
- `image-tool`: open/drop an image, canvas filters, export PNG
- `three-viewer`: three.js 3D scene, STL parsing, orbit controls, drag-and-drop
- `python-tool`: polyglot Python 3 `stdio` JSON-RPC backend + data analysis UI
- `swift-tool`: polyglot compiled native Swift `stdio` JSON-RPC backend + benchmark/hash UI

## CLI reference

```
bassblock validate [dir|id] [--json]   validate (run it from the block folder with no args)
bassblock create <id> --template blank|text-tool|image-tool|three-viewer|python-tool|swift-tool --name "Name"
bassblock run <id>                     open it in the BASS BLOCK app
bassblock reload <id>                  reload it if it's open
bassblock runtimes [--json]            list compilers & language runtimes installed on this machine
bassblock install-skill                install the bass-block-builder skill & CLI for Antigravity/Claude
bassblock docs | schema                print this guide | the block.json JSON Schema
```
