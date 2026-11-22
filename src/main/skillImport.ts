/**
 * Skill Link & File Importer for BASS BLOCK.
 * Resolves skill links (GitHub blob/tree/repo URLs, raw https:// URLs, or local SKILL.md paths),
 * extracts YAML frontmatter (name, description) + instructions + any bundled helper scripts,
 * so BASS BLOCK can generate a working SoftwareBlock directly from an imported Skill.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ImportedSkill {
  name: string;
  description: string;
  source: string;
  content: string;
  scripts: { name: string; content: string }[];
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;

/** Parse YAML frontmatter (or fallback Markdown heading) from a SKILL.md document. */
export function parseSkillMarkdown(raw: string, fallbackName = "Imported Skill"): { name: string; description: string; body: string } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  let name = "";
  let description = "";
  let body = text;

  const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    const yaml = fm[1];
    body = fm[2].trim();
    const nameMatch = yaml.match(/^name:\s*(.+)$/m);
    const descMatch = yaml.match(/^description:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  if (!name) {
    const h1 = body.match(/^#\s+(.+)$/m);
    name = h1 ? h1[1].trim().replace(/[`*_]/g, "") : fallbackName;
  }
  if (!description) {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("```") && !l.startsWith("---"));
    description = (lines[0] ?? "Generated from imported skill").slice(0, 300);
  }

  return {
    name: name.slice(0, 60),
    description: description.slice(0, 350),
    body: text.slice(0, MAX_SKILL_BYTES),
  };
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "BASS-BLOCK/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, MAX_SKILL_BYTES);
  } catch {
    return null;
  }
}

/** Resolve a URL or local filesystem path into an `ImportedSkill`. */
export async function fetchSkillFromLink(input: string): Promise<ImportedSkill> {
  const rawInput = String(input ?? "").trim();
  if (!rawInput) throw new Error("Enter a skill link (https://...) or local SKILL.md path.");

  // 1. Local path (~, /, ./, or existing file/folder)
  const expanded = rawInput.startsWith("~/") ? path.join(os.homedir(), rawInput.slice(2)) : rawInput;
  if (!/^https?:\/\//i.test(rawInput) && fs.existsSync(expanded)) {
    const st = fs.statSync(expanded);
    let skillFile = expanded;
    let skillDir = path.dirname(expanded);
    if (st.isDirectory()) {
      skillDir = expanded;
      const candidates = ["SKILL.md", "skill.md", "README.md", "readme.md"];
      const found = candidates.map((c) => path.join(expanded, c)).find((p) => fs.existsSync(p));
      if (!found) throw new Error(`Folder '${rawInput}' does not contain a SKILL.md or README.md file.`);
      skillFile = found;
    }
    const raw = fs.readFileSync(skillFile, "utf8");
    const { name, description, body } = parseSkillMarkdown(raw, path.basename(skillDir));
    const scripts: { name: string; content: string }[] = [];
    const scriptsDir = path.join(skillDir, "scripts");
    if (fs.existsSync(scriptsDir) && fs.statSync(scriptsDir).isDirectory()) {
      for (const ent of fs.readdirSync(scriptsDir, { withFileTypes: true }).slice(0, 5)) {
        if (!ent.isFile()) continue;
        const p = path.join(scriptsDir, ent.name);
        const fst = fs.statSync(p);
        if (fst.size <= MAX_SCRIPT_BYTES && /\.(py|js|mjs|ts|sh|swift|rb|go|rs)$/i.test(ent.name)) {
          scripts.push({ name: ent.name, content: fs.readFileSync(p, "utf8") });
        }
      }
    }
    return { name, description, source: skillFile, content: body, scripts };
  }

  // 2. Remote URL (http:// or https://)
  let u: URL;
  try {
    u = new URL(rawInput);
  } catch {
    throw new Error("Invalid skill URL or local file path not found.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Skill links must use https:// (or point to a local SKILL.md file).");
  }

  const scripts: { name: string; content: string }[] = [];

  // 2a. GitHub blob URL: https://github.com/<owner>/<repo>/blob/<branch>/<path>
  const ghBlob = u.hostname === "github.com" && u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (ghBlob) {
    const [, owner, repo, branch, filePath] = ghBlob;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const text = await fetchText(rawUrl);
    if (!text) throw new Error(`Could not fetch skill file from ${rawUrl}`);
    const fallback = path.basename(path.dirname(filePath)) || repo;
    const { name, description, body } = parseSkillMarkdown(text, fallback);
    return { name, description, source: rawInput, content: body, scripts };
  }

  // 2b. GitHub tree (folder) URL: https://github.com/<owner>/<repo>/tree/<branch>/<dir>
  const ghTree = u.hostname === "github.com" && u.pathname.match(/^\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/);
  if (ghTree) {
    const [, owner, repo, branch, dirPath] = ghTree;
    let text: string | null = null;
    for (const candidate of ["SKILL.md", "skill.md", "README.md"]) {
      text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/${candidate}`);
      if (text) break;
    }
    if (!text) throw new Error(`No SKILL.md or README.md found in GitHub folder '${dirPath}'.`);
    const { name, description, body } = parseSkillMarkdown(text, path.basename(dirPath));
    return { name, description, source: rawInput, content: body, scripts };
  }

  // 2c. GitHub repo root URL: https://github.com/<owner>/<repo>
  const ghRepo = u.hostname === "github.com" && u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ghRepo) {
    const [, owner, repo] = ghRepo;
    let text: string | null = null;
    for (const candidate of ["SKILL.md", "skill.md", "README.md"]) {
      text = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${candidate}`);
      if (text) break;
    }
    if (!text) throw new Error(`Could not find SKILL.md or README.md in repository ${owner}/${repo}.`);
    const { name, description, body } = parseSkillMarkdown(text, repo);
    return { name, description, source: rawInput, content: body, scripts };
  }

  // 2d. Direct raw URL (raw.githubusercontent.com, gist, or any https:// link)
  const text = await fetchText(u.toString());
  if (!text) throw new Error(`Could not download skill from ${u.toString()}`);
  const fallback = path.basename(u.pathname, path.extname(u.pathname)) || u.hostname;
  const { name, description, body } = parseSkillMarkdown(text, fallback);
  return { name, description, source: rawInput, content: body, scripts };
}
