// Renders the build artwork SVGs to PNG with Electron's offscreen renderer:
//   build/icon.svg           → build/icon.png (1024×1024, electron-builder turns it into .icns)
//   build/dmg-background.svg → build/dmg-background.png (640×400) + @2x (1280×800)
// Usage: npm run icons
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const build = path.resolve(__dirname, "..", "build");
const jobs = [
  { src: "icon.svg", out: "icon.png", w: 1024, h: 1024, scale: 1 },
  { src: "dmg-background.svg", out: "dmg-background.png", w: 640, h: 400, scale: 1 },
  { src: "dmg-background.svg", out: "dmg-background@2x.png", w: 640, h: 400, scale: 2 },
];

async function render({ src, out, w, h, scale }) {
  const svg = fs.readFileSync(path.join(build, src), "utf8").replace(/width="\d+" height="\d+"/, `width="${w * scale}" height="${h * scale}"`);
  const win = new BrowserWindow({ show: false, width: w * scale, height: h * scale, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const tmp = path.join(require("node:os").tmpdir(), `bb-art-${process.pid}.html`);
  fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`);
  await win.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  await new Promise((r) => setTimeout(r, 400));
  let img = await win.webContents.capturePage({ x: 0, y: 0, width: w * scale, height: h * scale });
  if (img.getSize().width !== w * scale) img = img.resize({ width: w * scale, height: h * scale, quality: "best" });
  fs.writeFileSync(path.join(build, out), img.toPNG());
  win.destroy();
  console.log(`wrote build/${out}`, img.getSize());
}

app.dock?.hide();
app.on("window-all-closed", () => {}); // keep running between renders
app.whenReady().then(async () => {
  for (const j of jobs) await render(j);
  app.exit(0);
});
