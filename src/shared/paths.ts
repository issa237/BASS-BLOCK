import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * App root. Bundles live in <root>/dist, so the root is one level up.
 * In the packaged .app that is ".../Contents/Resources/app.asar".
 */
export const APP_ROOT = path.resolve(__dirname, "..");
/** True inside the packaged BASS BLOCK.app (code is read from app.asar). */
export const IS_PACKAGED = APP_ROOT.endsWith(".asar");
/**
 * Templates and the SDK ship as plain folders next to app.asar (electron-builder extraResources),
 * so agents can read them and fs.cpSync can copy them. In development they sit in the repo.
 */
const RESOURCES = IS_PACKAGED ? path.dirname(APP_ROOT) : APP_ROOT;
export const TEMPLATES_DIR = path.join(RESOURCES, "templates");
export const SDK_DIR = path.join(RESOURCES, "sdk");
/** Arguments that make the Electron binary start this app: the repo folder in dev, nothing when packaged. */
export const APP_ARGS = IS_PACKAGED ? [] : [APP_ROOT];
export const SKILL_PATH = path.join(SDK_DIR, "skills", "bass-block-builder", "SKILL.md");

/** Where user blocks and host state live. Override with BASSBLOCK_HOME (used by tests). */
export function bbHome(): string {
  return process.env.BASSBLOCK_HOME || path.join(os.homedir(), "BassBlock");
}

export const paths = {
  blocksDir: () => path.join(bbHome(), "blocks"),
  stateDir: () => path.join(bbHome(), "state"),
  binDir: () => path.join(bbHome(), "bin"),
  settingsFile: () => path.join(bbHome(), "state", "settings.json"),
  approvalsFile: () => path.join(bbHome(), "state", "approvals.json"),
  /** Unix socket the running host listens on so the CLI can talk to it. */
  hostSocket: () => {
    // macOS caps Unix socket paths at 104 bytes; fall back to a short per-home path in the temp dir.
    const p = path.join(bbHome(), "state", "host.sock");
    if (Buffer.byteLength(p) < 100) return p;
    const hash = crypto.createHash("sha256").update(bbHome()).digest("hex").slice(0, 12);
    return path.join(os.tmpdir(), `bassblock-${hash}.sock`);
  },

  blockDir: (id: string) => path.join(bbHome(), "blocks", id),
  /** AI may edit this. Versioned with git. */
  codeDir: (id: string) => path.join(bbHome(), "blocks", id, "code"),
  /** AI never touches this. Exposed to the block only through bb.storage / bb.data. */
  dataDir: (id: string) => path.join(bbHome(), "blocks", id, "data"),
  /** Host-owned: logs, validation screenshots, agent transcripts. */
  metaDir: (id: string) => path.join(bbHome(), "blocks", id, ".meta"),
};

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string | null {
  const resolved = path.resolve(root, "." + path.sep + rel);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}
