/**
 * Language runtime & compiler detector for BASS BLOCK's Polyglot Engine.
 * Discovers which toolchains (Python, Swift, Rust, C++, Go, Node.js, FFmpeg) are installed
 * on the machine so the AI agent can pick the best available language for any block.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface RuntimeInfo {
  id: "python" | "uv" | "swift" | "rust" | "cpp" | "go" | "node" | "ffmpeg";
  label: string;
  bin: string;
  path: string | null;
  version: string | null;
}

const SPECS: { id: RuntimeInfo["id"]; label: string; bins: string[]; versionArg: string }[] = [
  { id: "python", label: "Python 3", bins: ["python3", "python"], versionArg: "--version" },
  { id: "uv", label: "uv (Python manager)", bins: ["uv"], versionArg: "--version" },
  { id: "swift", label: "Swift (swiftc)", bins: ["swiftc"], versionArg: "--version" },
  { id: "rust", label: "Rust (cargo / rustc)", bins: ["cargo", "rustc"], versionArg: "--version" },
  { id: "go", label: "Go", bins: ["go"], versionArg: "version" },
  { id: "cpp", label: "C++ (clang++ / g++)", bins: ["clang++", "g++"], versionArg: "--version" },
  { id: "node", label: "Node.js", bins: ["node"], versionArg: "--version" },
  { id: "ffmpeg", label: "FFmpeg (Media)", bins: ["ffmpeg"], versionArg: "-version" },
];

let loginPath: string | undefined;

/** Apps started from Finder get a bare PATH; ask the login shell for the real one once. */
export function userPath(): string {
  if (loginPath) return loginPath;
  if (process.platform === "win32") {
    loginPath = process.env.PATH ?? "";
    return loginPath;
  }
  const home = process.env.HOME ?? "";
  const fallback = [
    path.join(home, ".local/bin"),
    path.join(home, ".cargo/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", 'printf "__BBPATH__%s__BBPATH__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/__BBPATH__(.*)__BBPATH__/);
    loginPath = [m?.[1] ?? "", ...fallback].filter(Boolean).join(path.delimiter);
  } catch {
    loginPath = [process.env.PATH ?? "", ...fallback].filter(Boolean).join(path.delimiter);
  }
  return loginPath;
}

export function findBinary(bin: string): string | null {
  const dirs = userPath().split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, bin + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

let cachedRuntimes: RuntimeInfo[] | undefined;

export function detectRuntimes(refresh = false): RuntimeInfo[] {
  if (cachedRuntimes && !refresh) return cachedRuntimes;
  const out: RuntimeInfo[] = [];
  for (const spec of SPECS) {
    let foundBin = spec.bins[0];
    let foundPath: string | null = null;
    for (const b of spec.bins) {
      const p = findBinary(b);
      if (p) {
        foundBin = b;
        foundPath = p;
        break;
      }
    }
    let version: string | null = null;
    if (foundPath) {
      try {
        const raw = execFileSync(foundPath, [spec.versionArg], {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        version = raw.split("\n")[0]?.replace(/^swift-driver version:[^\n]*?(Apple Swift version [^\n(]+).*/, "$1")?.slice(0, 64) || null;
      } catch {}
    }
    out.push({ id: spec.id, label: spec.label, bin: foundBin, path: foundPath, version });
  }
  cachedRuntimes = out;
  return out;
}

/** Summarise installed toolchains so the AI agent knows which languages work on this machine. */
export function formatRuntimesForPrompt(): string {
  const list = detectRuntimes().filter((r) => r.path);
  if (!list.length) return "Available runtimes: Web (HTML/CSS/JS/WASM) only.";
  return (
    "Installed language toolchains on this machine (available for mode: 'polyglot' backends):\n" +
    list.map((r) => `- ${r.label}: command \`${r.bin}\` (${r.version ?? r.path})`).join("\n")
  );
}
