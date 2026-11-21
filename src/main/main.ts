/**
 * Electron entry. Two modes:
 *   (default)                     the BASS BLOCK host app
 *   --bb-validate <codeDir>       headless validation run used by `bassblock validate`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { APP_ROOT } from "../shared/paths";
import { installBBApi } from "./bbApi";
import { registerBlockScheme } from "./sandbox";
import { startHost } from "./host";
import { validateBlock } from "./validate";

const argv = process.argv;
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

app.setName("BASS BLOCK");
registerBlockScheme();
installBBApi();

const validateDir = arg("--bb-validate");
const snapshot = arg("--bb-snapshot");

if (validateDir || snapshot) {
  // Separate profile so these runs never collide with (or lock out) the user's running host.
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "bb-run-")));
}

if (validateDir) {
  app.dock?.hide();
  app.whenReady().then(async () => {
    const codeDir = path.resolve(validateDir);
    const expectedId = arg("--bb-expect-id");
    const screenshotPath = arg("--bb-screenshot");
    const result = await validateBlock(codeDir, {
      blockPreload: path.join(APP_ROOT, "dist", "preload-block.js"),
      expectedId,
      screenshotPath,
      timeoutMs: Number(arg("--bb-timeout")) || 15000,
    }).catch((e) => ({ ok: false, problems: [{ step: "load" as const, message: String(e?.message ?? e) }], warnings: [] }));
    process.stdout.write(`\nBBRESULT:${JSON.stringify(result)}\n`);
    app.exit(result.ok ? 0 : 1);
  });
  app.on("window-all-closed", () => {});
} else {
  startHost({ openId: arg("--bb-open"), snapshot });
}
