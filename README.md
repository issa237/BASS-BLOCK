# BASS BLOCK

One host app for AI-generated mini-apps called **blocks**. Describe a tool, your installed coding agent
(Antigravity, Claude Code, Gemini CLI or Codex) writes it in the best language for the job (Web/JS/TypeScript, Python, Swift, Rust, C++, Go, or Node.js), BASS BLOCK validates it in its sandbox and opens it.

Status: **Phase 2: Web & Polyglot Blocks (Python, Swift, Rust, C++, Go, Node.js, TypeScript/WebGL).**

## Download Installers (macOS `.dmg` & Windows `.exe`)

Pre-built installers are available on the [**GitHub Releases page**](https://github.com/issa237/BASS-BLOCK/releases/latest):

- **macOS (Apple Silicon `.dmg`)**: [`BASS-BLOCK-0.1.0-arm64.dmg`](https://github.com/issa237/BASS-BLOCK/releases/download/v0.1.0/BASS-BLOCK-0.1.0-arm64.dmg)
- **macOS (Apple Silicon `.zip`)**: [`BASS-BLOCK-0.1.0-arm64.zip`](https://github.com/issa237/BASS-BLOCK/releases/download/v0.1.0/BASS-BLOCK-0.1.0-arm64.zip)
- **Windows (64-bit `.exe` Installer)**: [`BASS-BLOCK-0.1.0-x64.exe`](https://github.com/issa237/BASS-BLOCK/releases/download/v0.1.0/BASS-BLOCK-0.1.0-x64.exe)

## Get Started from Source (Clone & Run)

```bash
git clone https://github.com/issa237/BASS-BLOCK.git
cd BASS-BLOCK
npm install
npm start          # build + launch BASS BLOCK
```

### Verify & Test

```bash
npm test           # build + run end-to-end smoke tests (throwaway BASSBLOCK_HOME)
npm run typecheck  # TypeScript check
```

## Build the macOS app (.dmg) or Windows installer (.exe)

```bash
npm run dist          # → release/BASS-BLOCK-<version>-arm64.dmg (+ .zip), ad-hoc signed
npm run pack          # → release/mac-arm64/BASS BLOCK.app only (faster, for testing)
npm run dist:win      # → release/BASS-BLOCK-<version>-x64.exe (NSIS + portable)
npm run icons         # re-render build/icon.png and the DMG background from the SVGs
```

The `.dmg` opens to a "drag BASS BLOCK into Applications" window. Templates and the SDK ship as plain
folders in `BASS BLOCK.app/Contents/Resources/` (outside `app.asar`) so agents can read them.

**Ad-hoc builds run on this Mac only.** On another Mac, Gatekeeper blocks a downloaded copy
("can't be opened"), unless the user right-clicks the app and chooses Open, or runs `xattr -dr com.apple.quarantine "/Applications/BASS BLOCK.app"`.

### Signed + notarized release (for distribution)

1. Join the Apple Developer Program and create a **Developer ID Application** certificate in Xcode
   (Settings → Accounts → Manage Certificates). An "Apple Development" certificate is not enough.
2. Create an app-specific password at appleid.apple.com.
3. Build:
   ```bash
   APPLE_ID="you@example.com" APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" APPLE_TEAM_ID="ABCDE12345" npm run dist:release
   ```
   This signs with Developer ID + Hardened Runtime ([entitlements](build/entitlements.mac.plist)), notarizes with Apple,
   staples the ticket, and produces arm64 and x64 `.dmg` files that open with no warnings.

Electron's binary download is an install script; npm 11 needs it approved once (`npm approve-scripts electron`, already recorded in package.json).

## Layout

```
src/main/main.ts       entry: host app, or `--bb-validate <dir>` headless validation
src/main/host.ts       window, sidebar/tabs/split-view IPC, block views, permission prompts, CLI socket, live reload
src/main/sandbox.ts    per-block session, block:// protocol (with native .ts support), CSP, network wall, navigation lock
src/main/bbApi.ts      the bb.* API (storage, data, fs files & directories, clipboard, net, backend, events)
src/main/supervisor.ts polyglot backend compiler & process supervisor (stdio JSON-RPC + loopback HTTP)
src/main/runtimes.ts   detects installed compilers & runtimes (Python, Swift, Rust, C++, Go, Node.js, FFmpeg)
src/main/validate.ts   headless launch: manifest, files, backend build/start, load/console errors, render, screenshot
src/main/agent.ts      headless agent runner: snapshot → agent → validate → repair (max 3)
src/preload/           host preload (window.host) and block preload (window.bb)
src/renderer/          host UI (library grid, split view, version history, AI & runtime settings)
src/cli/bassblock.ts   create | validate | run | reload | list | runtimes | install-skill | docs | schema
sdk/block.schema.json  block.json schema v1 (web + polyglot modes)
sdk/skills/bass-block-builder/SKILL.md   the guide agents follow
templates/             blank, text-tool, image-tool, three-viewer, python-tool, swift-tool
```

## On disk

```
~/BassBlock/blocks/<id>/code/    AI edits this (git-versioned; "Undo AI change" restores it)
~/BassBlock/blocks/<id>/data/    the block's data via bb.storage / bb.data; never touched by AI or undo
~/BassBlock/blocks/<id>/.meta/   host-owned: screenshot, console log, agent transcripts
~/BassBlock/state/               settings, permission approvals, CLI socket, trash
~/BassBlock/bin/bassblock        CLI shim (runs with the app's bundled Electron)
```

Override the home folder with `BASSBLOCK_HOME`.

## Security model (Phase 1)

- Each block: its own `WebContentsView`, `sandbox: true`, `contextIsolation`, no Node, own session partition.
- Served from `block://<id>/` with a strict CSP; every non-`block://` request is cancelled. No popups or navigation away, and browser permissions (camera etc.) are denied.
- Only bridge: `window.bb`. Calls are tied to the sending view, and `fs` / `network` / `clipboard` need declared permissions plus user approval (asked again when they change).
- Agents run with a minimal environment (only their own vendor's variables), inside the block's `code/` folder, with file-edit tools and `bassblock validate` only.

## Not yet (later phases)

Mode 2 backends (uv, supervisor, Unix sockets), Keychain, memory limits/suspension, pipe view between
blocks, signed import/export, Developer ID signing + notarization, native blocks.
