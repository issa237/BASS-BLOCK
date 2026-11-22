/**
 * Language runtime & compiler detector for BASS BLOCK's Polyglot Engine.
 * Discovers which toolchains (Python, Swift, Rust, C++, Go, Node.js, FFmpeg) are installed
 * on the machine so the AI agent can pick the best available language for any block,
 * and provides step-by-step installation instructions for any missing toolchain.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface RuntimeInstallStep {
  title: string;
  cmd?: string;
  note?: string;
}

export interface RuntimeInstallGuide {
  summary: string;
  steps: RuntimeInstallStep[];
  verifyCmd: string;
  docsUrl: string;
}

export interface RuntimeInfo {
  id: "python" | "uv" | "swift" | "rust" | "cpp" | "go" | "node" | "ffmpeg";
  label: string;
  bin: string;
  path: string | null;
  version: string | null;
  install: RuntimeInstallGuide;
}

const SPECS: {
  id: RuntimeInfo["id"];
  label: string;
  bins: string[];
  versionArg: string;
  install: RuntimeInstallGuide;
}[] = [
  {
    id: "python",
    label: "Python 3",
    bins: ["python3", "python"],
    versionArg: "--version",
    install: {
      summary: "Required for Python polyglot blocks (data science, CSV/JSON analytics, AI/ML, and media scripting).",
      steps: [
        {
          title: "Option 1 — Install via Homebrew (Recommended)",
          cmd: "brew install python",
          note: "Installs the latest Python 3 and pip into /opt/homebrew/bin.",
        },
        {
          title: "Option 2 — Install Apple Command Line Tools",
          cmd: "xcode-select --install",
          note: "Includes Apple's bundled python3 along with git, clang++ and swiftc.",
        },
      ],
      verifyCmd: "python3 --version",
      docsUrl: "https://www.python.org/downloads/macos/",
    },
  },
  {
    id: "uv",
    label: "uv (Python manager)",
    bins: ["uv"],
    versionArg: "--version",
    install: {
      summary: "Ultra-fast Python package and virtual-environment manager for blocks that need third-party PyPI libraries.",
      steps: [
        {
          title: "Option 1 — Official Standalone Installer",
          cmd: "curl -LsSf https://astral.sh/uv/install.sh | sh",
          note: "Installs uv into ~/.local/bin/uv without requiring Homebrew.",
        },
        {
          title: "Option 2 — Install via Homebrew",
          cmd: "brew install uv",
        },
      ],
      verifyCmd: "uv --version",
      docsUrl: "https://docs.astral.sh/uv/getting-started/installation/",
    },
  },
  {
    id: "swift",
    label: "Swift (swiftc)",
    bins: ["swiftc"],
    versionArg: "--version",
    install: {
      summary: "Compiles native macOS Swift backends for high-speed computation and Apple frameworks (Foundation, CryptoKit, Vision, Metal).",
      steps: [
        {
          title: "Install Apple Xcode Command Line Tools",
          cmd: "xcode-select --install",
          note: "A macOS system prompt will appear; click Install and wait for it to finish.",
        },
      ],
      verifyCmd: "swiftc --version",
      docsUrl: "https://www.swift.org/install/macos/",
    },
  },
  {
    id: "rust",
    label: "Rust (cargo / rustc)",
    bins: ["cargo", "rustc"],
    versionArg: "--version",
    install: {
      summary: "Compiles high-performance native Rust backends and systems tools.",
      steps: [
        {
          title: "Option 1 — Official Rustup Installer (Recommended)",
          cmd: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
          note: "Installs rustc and cargo into ~/.cargo/bin.",
        },
        {
          title: "Option 2 — Install via Homebrew",
          cmd: "brew install rust",
        },
      ],
      verifyCmd: "cargo --version",
      docsUrl: "https://www.rust-lang.org/tools/install",
    },
  },
  {
    id: "go",
    label: "Go",
    bins: ["go"],
    versionArg: "version",
    install: {
      summary: "Compiles fast concurrent Go backends and networking utilities.",
      steps: [
        {
          title: "Install Go via Homebrew",
          cmd: "brew install go",
          note: "Or download the official macOS .pkg installer from go.dev/dl.",
        },
      ],
      verifyCmd: "go version",
      docsUrl: "https://go.dev/doc/install",
    },
  },
  {
    id: "cpp",
    label: "C++ (clang++ / g++)",
    bins: ["clang++", "g++"],
    versionArg: "--version",
    install: {
      summary: "Compiles native C++20 backends for simulations, DSP, 3D geometry and heavy algorithms.",
      steps: [
        {
          title: "Install Apple Xcode Command Line Tools",
          cmd: "xcode-select --install",
          note: "Provides Apple clang++ and the macOS system SDK headers.",
        },
      ],
      verifyCmd: "clang++ --version",
      docsUrl: "https://developer.apple.com/xcode/resources/",
    },
  },
  {
    id: "node",
    label: "Node.js",
    bins: ["node"],
    versionArg: "--version",
    install: {
      summary: "Runs JavaScript/TypeScript backend processes and CLI scripts.",
      steps: [
        {
          title: "Option 1 — Install via Homebrew",
          cmd: "brew install node",
          note: "Installs node and npm into /opt/homebrew/bin.",
        },
        {
          title: "Option 2 — Download Official macOS Installer",
          note: "Download the LTS .pkg installer from nodejs.org.",
        },
      ],
      verifyCmd: "node --version",
      docsUrl: "https://nodejs.org/en/download",
    },
  },
  {
    id: "ffmpeg",
    label: "FFmpeg (Media)",
    bins: ["ffmpeg"],
    versionArg: "-version",
    install: {
      summary: "Enables video editing, audio conversion, waveform extraction, and frame processing in media blocks.",
      steps: [
        {
          title: "Install FFmpeg via Homebrew",
          cmd: "brew install ffmpeg",
          note: "Installs ffmpeg and ffprobe with common audio/video codecs.",
        },
      ],
      verifyCmd: "ffmpeg -version",
      docsUrl: "https://ffmpeg.org/download.html",
    },
  },
];

let loginPath: string | undefined;

/** Apps started from Finder get a bare PATH; ask the login shell for the real one once. */
export function userPath(refresh = false): string {
  if (loginPath && !refresh) return loginPath;
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
  if (refresh) userPath(true);
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
    out.push({ id: spec.id, label: spec.label, bin: foundBin, path: foundPath, version, install: spec.install });
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
