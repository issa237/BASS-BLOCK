# BASS BLOCK (macOS)

One host app for AI-generated mini-apps called **blocks**. Describe a tool, your installed coding agent
(Claude Code, Gemini CLI or Codex) writes it, BASS BLOCK validates it in its sandbox and opens it.

Status: **Phase 1 MVP: web blocks only.**

## Run

```bash
npm install
npm start          # build + launch
npm test           # build + smoke tests (throwaway BASSBLOCK_HOME)
npm run typecheck
```

## Build the macOS app (.dmg)

```bash
npm run dist          # → release/BASS-BLOCK-<version>-arm64.dmg (+ .zip), ad-hoc signed
npm run pack          # → release/mac-arm64/BASS BLOCK.app only (faster, for testing)
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
src/main/host.ts       window, sidebar/tabs IPC, block views, permission prompts, CLI socket, live reload
src/main/sandbox.ts    per-block session, block:// protocol, CSP, network wall, navigation lock
src/main/bbApi.ts      the bb.* API (storage, data, fs handles, clipboard, net, events), permission-checked
src/main/validate.ts   headless launch: load errors, console errors, empty render, screenshot
src/main/agent.ts      headless agent runner: snapshot → agent → validate → repair (max 3)
src/preload/           host preload (window.host) and block preload (window.bb)
src/renderer/          host UI
src/cli/bassblock.ts   create | validate | run | reload | list | docs | schema
sdk/block.schema.json  block.json schema v1
sdk/skills/bass-block-builder/SKILL.md   the guide agents follow
templates/             blank, text-tool, image-tool, three-viewer
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
