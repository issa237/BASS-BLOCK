/**
 * Full validation of a web block: static checks, then a headless launch in the same sandbox
 * the real host uses, collecting load failures, console errors, crashes and a screenshot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow } from "electron";
import { staticCheck, type Problem } from "../shared/blocks";
import { blockContexts, blockSession, blockUrl, blockWebPreferences, consoleDetails, lockNavigation } from "./sandbox";

export interface ValidationResult {
  ok: boolean;
  id?: string;
  problems: Problem[];
  warnings: string[];
  screenshot?: string;
  loadMs?: number;
}

export async function validateBlock(codeDir: string, opts: { blockPreload: string; screenshotPath?: string; expectedId?: string; timeoutMs?: number }): Promise<ValidationResult> {
  const { manifest, problems } = staticCheck(codeDir, opts.expectedId);
  const warnings: string[] = [];
  if (!manifest || problems.some((p) => p.step === "manifest")) return { ok: false, id: manifest?.id, problems, warnings };

  // Throwaway session + data dir: validation never touches the user's real data.
  const partition = `bb-validate-${crypto.randomBytes(6).toString("hex")}`;
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "bb-validate-"));
  blockSession(partition, manifest.id, codeDir);

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    paintWhenInitiallyHidden: true,
    webPreferences: blockWebPreferences(partition, opts.blockPreload),
  });
  const wc = win.webContents;
  const ctx = { blockId: manifest.id, codeDir, dataDir: tmpData, manifest, validating: true, ready: false };
  blockContexts.set(wc, ctx);
  lockNavigation(wc, manifest.id);

  const seen = new Set<string>();
  const runtime = (message: string) => {
    if (seen.has(message)) return;
    seen.add(message);
    problems.push({ step: "runtime", message });
  };
  wc.on("console-message", (...args: unknown[]) => {
    const d = consoleDetails(args);
    const where = d.source ? ` (${d.source.replace(`block://${manifest.id}/`, "")}:${d.line})` : "";
    if (d.level === "error") runtime(`console error: ${d.message}${where}`);
    else if (d.level === "warning" && !/Electron Security Warning/.test(d.message)) warnings.push(`${d.message}${where}`);
  });
  wc.on("did-fail-load", (_e, code, desc, url) => {
    if (code !== -3) problems.push({ step: "load", message: `Failed to load ${url.replace(`block://${manifest.id}/`, "")}: ${desc} (${code})` });
  });
  wc.on("render-process-gone", (_e, d) => problems.push({ step: "runtime", message: `Renderer crashed: ${d.reason}` }));
  wc.on("preload-error", (_e, _p, err) => problems.push({ step: "runtime", message: `Preload error: ${err.message}` }));
  wc.on("did-fail-provisional-load", (_e, code, desc, url) => {
    if (code !== -3) problems.push({ step: "load", message: `Blocked request ${url}: ${desc}` });
  });
  wc.session.webRequest.onErrorOccurred(({ url, error }) => {
    if (error === "net::ERR_BLOCKED_BY_CLIENT") runtime(`Blocked request to ${url}. Blocks can't load remote resources; use bb.net.fetch for data or vendor the file.`);
  });

  const timeoutMs = opts.timeoutMs ?? 15000;
  const t0 = Date.now();
  let loadMs: number | undefined;
  try {
    await Promise.race([
      wc.loadURL(blockUrl(manifest)).then(() => (loadMs = Date.now() - t0)),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`Page did not finish loading within ${timeoutMs} ms`)), timeoutMs)),
    ]);
    // Give scripts a moment to run (or to call bb.ready()).
    const settleUntil = Date.now() + 2500;
    while (Date.now() < settleUntil && !ctx.ready) await new Promise((r) => setTimeout(r, 100));
    if (!ctx.ready) await new Promise((r) => setTimeout(r, 300));

    const rendered = (await wc.executeJavaScript(
      `(() => { const b = document.body; if (!b) return { size: 0 }; const r = b.getBoundingClientRect(); return { size: b.innerText.trim().length + b.querySelectorAll('canvas,svg,img,video,input,textarea,button').length, w: r.width, h: r.height, title: document.title }; })()`,
      true,
    )) as { size: number; title?: string };
    if (!rendered.size) problems.push({ step: "render", message: "The page rendered nothing visible (empty <body>, no text, no controls). Check that your script runs and builds the UI." });
    if (!rendered.title) warnings.push("Set a <title> in the entry HTML.");

    if (opts.screenshotPath) {
      const img = await wc.capturePage();
      fs.mkdirSync(path.dirname(opts.screenshotPath), { recursive: true });
      fs.writeFileSync(opts.screenshotPath, img.toPNG());
    }
  } catch (e) {
    problems.push({ step: "load", message: (e as Error).message });
  } finally {
    win.destroy();
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, id: manifest.id, problems, warnings, screenshot: opts.screenshotPath, loadMs };
}
