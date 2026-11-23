/**
 * Built-in Direct Model Runner for BASS BLOCK.
 * Connects directly to free/local/cloud OpenAI-compatible endpoints (Ollama, LM Studio,
 * OpenRouter free models, Google Gemini API free tier, Groq, DeepSeek, or custom URLs)
 * without requiring any external CLI binary.
 */
import fs from "node:fs";
import path from "node:path";
import { safeJoin } from "../shared/paths";

export interface DirectApiConfig {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface DirectStepEvent {
  type: "status" | "text" | "tool" | "log";
  text: string;
}

/** Auto-detect local Ollama models (100% free, offline) if Ollama is running on 127.0.0.1:11434. */
export async function detectOllamaModels(): Promise<DirectApiConfig[]> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      method: "GET",
      signal: AbortSignal.timeout(600),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? [])
      .map((m) => m.name?.trim())
      .filter((name): name is string => Boolean(name))
      .map((name) => ({
        id: `ollama:${name}`,
        label: `Ollama · ${name} (Local Free)`,
        baseUrl: "http://127.0.0.1:11434/v1",
        model: name,
      }));
  } catch {
    return [];
  }
}

/** Quick connectivity check for the "Test & Save" button in AI Settings. */
export async function testDirectApi(cfg: { baseUrl: string; model: string; apiKey?: string }): Promise<{ ok: boolean; message: string }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey?.trim()) headers["Authorization"] = `Bearer ${cfg.apiKey.trim()}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: cfg.model.trim(),
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_tokens: 12,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, message: `HTTP ${res.status}: ${errText || res.statusText}` };
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = json.choices?.[0]?.message?.content?.trim() ?? "Connected";
    return { ok: true, message: `Connected to ${cfg.model} (${reply.slice(0, 40)})` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Collect existing files in `codeDir` for model context (skipping huge vendored libraries and .bin). */
function readCurrentFiles(codeDir: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === ".git" || ent.name === ".bin" || ent.name === "node_modules" || ent.name === "target" || ent.name === "__pycache__") continue;
      const p = path.join(dir, ent.name);
      const rel = path.relative(codeDir, p).split(path.sep).join("/");
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        const st = fs.statSync(p);
        if (rel.startsWith("vendor/") || st.size > 60_000) {
          out.push(`---EXISTING FILE: ${rel} (${st.size} bytes, binary/vendor omitted)---`);
        } else {
          out.push(`<<<EXISTING_FILE: ${rel}>>>\n${fs.readFileSync(p, "utf8")}\n<<<END_EXISTING_FILE>>>`);
        }
      }
    }
  };
  walk(codeDir);
  return out.join("\n\n");
}

/** Parse files from model output (supports <<<FILE: path>>> blocks and JSON fallback). */
export function parseGeneratedFiles(raw: string): { files: Map<string, string>; summary: string } {
  const files = new Map<string, string>();
  let summary = "";

  // 1. Primary format: <<<FILE: path>>> ... <<<END_FILE>>>
  const fileRe = /<<<FILE:\s*([^\n>]+?)>>>\r?\n([\s\S]*?)<<<END_FILE>>>/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(raw)) !== null) {
    const rel = m[1].trim().replace(/^["'`]|["'`]$/g, "").replace(/^\.?\//, "");
    if (rel) files.set(rel, m[2]);
  }
  const sumMatch = raw.match(/<<<SUMMARY>>>\s*([\s\S]*?)\s*<<<END_SUMMARY>>>/);
  if (sumMatch) summary = sumMatch[1].trim();

  // 2. Fallback: JSON object { "files": { "path": "content" }, "summary": "..." }
  if (files.size === 0) {
    const jsonCandidate = raw.match(/\{[\s\S]*"files"\s*:\s*\{[\s\S]*\}[\s\S]*\}/);
    if (jsonCandidate) {
      try {
        const parsed = JSON.parse(jsonCandidate[0]) as { files?: Record<string, string>; summary?: string };
        if (parsed.files && typeof parsed.files === "object") {
          for (const [k, v] of Object.entries(parsed.files)) {
            const rel = k.trim().replace(/^\.?\//, "");
            if (rel && typeof v === "string") files.set(rel, v);
          }
        }
        if (typeof parsed.summary === "string") summary = parsed.summary;
      } catch {}
    }
  }

  // 3. Fallback: Markdown fenced code blocks with file header (e.g. ### `index.html` \n ```html ... ```)
  if (files.size === 0) {
    const mdRe = /(?:^|\n)(?:#+\s*|File:\s*|\*\*)`?([A-Za-z0-9_./-]+\.(?:json|html|css|js|mjs|ts|py|swift|rs|go|cpp))`?\*\*?[ \t]*\r?\n```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/g;
    while ((m = mdRe.exec(raw)) !== null) {
      const rel = m[1].trim().replace(/^\.?\//, "");
      if (rel) files.set(rel, m[2]);
    }
  }

  return { files, summary };
}

export async function runDirectApiStep(opts: {
  config: DirectApiConfig;
  blockId: string;
  codeDir: string;
  skillText: string;
  prompt: string;
  signal: AbortSignal;
  onEvent: (e: DirectStepEvent) => void;
}): Promise<number> {
  const { config, blockId, codeDir, skillText, prompt, signal, onEvent } = opts;
  const existingFiles = readCurrentFiles(codeDir);

  const systemPrompt = `${skillText}

---
IMPORTANT OUTPUT FORMAT FOR DIRECT MODEL RUNNER:
You do not have a bash shell tool in this mode; BASS BLOCK will write your files and run \`bassblock validate\` for you automatically.
Output every file you want to create or update inside the block's code/ folder using this exact delimiter format (no markdown fences around the delimiters):

<<<FILE: block.json>>>
{
  "schema": 1,
  "id": "${blockId}",
  ...
}
<<<END_FILE>>>

<<<FILE: index.html>>>
<!doctype html>
...
<<<END_FILE>>>

<<<FILE: style.css>>>
...
<<<END_FILE>>>

<<<FILE: main.js>>>
...
<<<END_FILE>>>

<<<SUMMARY>>>
One or two sentence summary of what you built or fixed.
<<<END_SUMMARY>>>

Rules:
- Always keep "id": "${blockId}" in block.json.
- Output complete file contents for every file you touch (never use "// ... existing code ...").
- If any part of the user's request cannot be built due to a missing BASS BLOCK capability or sandbox limit, also output <<<FILE: BLOCKAGE.json>>> with { "title", "error", "missingCapability", "proposal", "workaround" } and a working fallback UI.`;

  const userContent = `${prompt}\n\nCurrent files in the block directory:\n\n${existingFiles}`;

  onEvent({ type: "status", text: `Calling ${config.label} (${config.model})…` });
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey?.trim()) headers["Authorization"] = `Bearer ${config.apiKey.trim()}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
      }),
      signal,
    });

    if (!res.ok) {
      const errBody = (await res.text().catch(() => "")).slice(0, 500);
      onEvent({ type: "log", text: `API error (${res.status}): ${errBody || res.statusText}` });
      return 1;
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    if (data.error?.message) {
      onEvent({ type: "log", text: `API error: ${data.error.message}` });
      return 1;
    }
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      onEvent({ type: "log", text: "Model returned an empty response." });
      return 1;
    }

    const { files, summary } = parseGeneratedFiles(content);
    if (files.size === 0) {
      onEvent({ type: "log", text: "Model response did not contain any <<<FILE: ...>>> blocks." });
      return 1;
    }

    for (const [relPath, fileContent] of files) {
      if (relPath.startsWith(".git") || relPath.startsWith(".meta") || relPath.startsWith("data/")) continue;
      const target = safeJoin(codeDir, relPath);
      if (!target) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let finalContent = fileContent;
      if (relPath === "block.json") {
        try {
          const parsed = JSON.parse(fileContent);
          parsed.id = blockId;
          finalContent = JSON.stringify(parsed, null, 2) + "\n";
        } catch {}
      }
      fs.writeFileSync(target, finalContent, "utf8");
      onEvent({ type: "tool", text: `Writing ${relPath}` });
    }

    if (summary) {
      onEvent({ type: "text", text: summary });
    } else {
      onEvent({ type: "text", text: `Updated ${files.size} file(s).` });
    }
    return 0;
  } catch (e) {
    if (signal.aborted) return -1;
    onEvent({ type: "log", text: `Request failed: ${(e as Error).message}` });
    return 1;
  }
}
