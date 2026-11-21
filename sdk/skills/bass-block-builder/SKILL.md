---
name: bass-block-builder
description: Build or modify a BASS BLOCK block — a sandboxed mini-app (HTML/CSS/JS + the bb SDK) that runs inside the BASS BLOCK macOS host. Use when asked to create, change or fix a block, or when working in a folder that contains a block.json with "schema": 1.
---

# Building BASS BLOCK blocks

A **block** is a small, focused app that runs inside BASS BLOCK in its own sandboxed web view.
You write plain HTML, CSS and JavaScript. The page talks to the outside world only through the
global `bb` object (the BASS BLOCK SDK). There is no Node.js, no npm at runtime, no internet,
and no access to files the user didn't pick.

## Workflow

1. Read `block.json` and the existing files first. When editing, keep features and saved-data formats working.
2. Write the block (rules below). Keep it in a few files: `index.html`, `style.css`, `main.js`, plus any modules or vendored libraries.
3. Run `bassblock validate`. It checks the manifest, scans files, launches the block headless in the real
   sandbox, and reports console errors, blocked requests and empty renders.
4. Fix every reported problem and run `bassblock validate` again until it prints `✓ … passed validation`.
5. Finish with a one or two sentence summary for the user.

Only edit files inside the block's folder. Don't create `data/`, `.meta/` or `.git` content: the host owns them.

## block.json (schema 1)

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
  "platform": { "os": "macos", "arch": ["arm64", "x64"] }
}
```

- `id` must stay exactly as given (it matches the folder). Never change it.
- `mode` must be `"web"`. `backend` is not supported yet: do all work in the page (JS, WebAssembly, Web Workers, WebGL, Web Audio, Canvas all work).
- Bump `version` (patch) whenever you change a block.
- **Permissions: declare the minimum.** The user approves them before the block opens, and is asked again if they change.
  - `"fs": "user-picked-files"`: needed for `bb.fs.*` (open/save dialogs). Drag-and-drop of files into the page needs no permission.
  - `"network"`: `false` (default), or a list of hostnames like `["api.github.com"]`, or `true` for any HTTPS host. Only needed for `bb.net.fetch`.
  - `"clipboard": true`: needed for `bb.clipboard.*`.
- `io` describes events this block sends (`outputs`, via `bb.emit`) and accepts (`inputs`, via `bb.on`). Types are MIME-style.

## Hard sandbox rules (validation fails otherwise)

- **No remote resources.** No CDN `<script src="https://…">`, no Google Fonts, no remote images, no `import … from "https://…"`.
  If you need a library, write the code yourself or vendor a small file into the block folder (for example `vendor/lib.js`).
  `three.js` is available to copy from the `three-viewer` example block (`vendor/three.min.js`).
- **No inline scripts.** All JS goes in `.js` files loaded with `<script type="module" src="main.js"></script>`.
  No `onclick="…"` attributes; use `addEventListener`.
- No `eval` / `new Function`. WebAssembly is allowed.
- `fetch()` works only for the block's own files (relative URLs). For the internet, use `bb.net.fetch` with a declared permission.
- Don't use `localStorage`/`IndexedDB` for user data: use `bb.storage` / `bb.data` so data lives in the block's data folder and survives code changes.
- `alert`, `confirm` and `prompt` are discouraged; build inline UI instead.
- Popups (`window.open`) and navigating away are blocked. Use one page (or swap views in JS).

## The bb SDK (global `bb`, all methods async unless noted)

```js
await bb.info()                    // { id, name, version, sdk, permissions }
bb.ready()                         // call once your UI is rendered (helps validation)
bb.log("message", obj)             // shows in the host console panel

// Small JSON key/value store (≤10 MB total) in the block's data folder
await bb.storage.get(key)          // → value or null
await bb.storage.set(key, value)   // JSON-serialisable value
await bb.storage.delete(key)
await bb.storage.keys()

// Private files in the block's data folder (any size up to 512 MB each)
await bb.data.write("exports/a.png", uint8ArrayOrString)
await bb.data.read("exports/a.png")            // → Uint8Array or null
await bb.data.readText("notes.txt")            // → string or null
await bb.data.list()                           // → [{ name, size, modified }]
await bb.data.delete("exports/a.png")

// User-picked files — needs "fs": "user-picked-files"
const files = await bb.fs.pickOpen({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg"] }] })
// → [{ handle, name, size }]  (empty array if cancelled)
await bb.fs.read(files[0].handle)              // → Uint8Array
await bb.fs.readText(files[0].handle)          // → string
const out = await bb.fs.pickSave({ suggestedName: "result.png" })   // → { handle, name } or null
await bb.fs.write(out.handle, uint8ArrayOrString)                   // only save-handles are writable

// Clipboard — needs "clipboard": true
await bb.clipboard.readText()
await bb.clipboard.writeText("hi")

// Network — needs "network": [...hosts] or true. HTTPS only.
const res = await bb.net.fetch("https://api.example.com/x", { method: "GET", headers: {} })
res.status; res.ok; res.headers; res.text(); res.json(); res.bytes()   // (these three are sync)

// Events between open blocks
bb.emit("stats", { words: 120 })                 // to every other open block
const off = bb.on("text", (data, { from }) => {})  // returns an unsubscribe function
```

Binary data crosses the bridge as `Uint8Array`. To get an image from bytes: `createImageBitmap(new Blob([bytes]))`.
To save a canvas: `new Uint8Array(await (await new Promise(r => canvas.toBlob(r, "image/png"))).arrayBuffer())`.

Top-level `await` works in module scripts. Load saved state on start, save after each change (debounce typing).

## Quality bar

- It must do what the user asked, completely. No placeholders, no "TODO", no lorem ipsum.
- Look like a polished macOS utility: system font (`-apple-system`), comfortable spacing, a clear primary action,
  sensible empty state, and support for both light and dark mode via `prefers-color-scheme`.
- Fill the view: the block gets the whole content area of the window and should be resizable without breaking.
- Handle errors visibly (inline message), not only in the console.
- Persist the user's work and settings with `bb.storage` / `bb.data` so reopening the block restores it.
- Keep it fast: no huge dependencies; vendor only what you need.

## Example blocks

Look at the example blocks for working patterns before writing your own:
- `blank`: minimal starter with `bb.storage`
- `text-tool`: editor + live stats, autosave, open/save files, emits `stats`, accepts `text`
- `image-tool`: open/drop an image, canvas filters, export PNG
- `three-viewer`: three.js scene, STL parsing, custom orbit controls, drag-and-drop

## CLI reference

```
bassblock validate [dir|id] [--json]   validate (run it from the block folder with no args)
bassblock create <id> --template text-tool --name "Name"
bassblock run <id>                      open it in the BASS BLOCK app
bassblock reload <id>                   reload it if it's open
bassblock docs | schema                 print this guide | the block.json JSON Schema
```
