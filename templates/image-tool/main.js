// Image adjust: open (picker or drag-and-drop), adjust with canvas filters, export PNG.
// Remembers the last slider settings with bb.storage.
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const stage = document.getElementById("stage");
const drop = document.getElementById("drop");
const exportBtn = document.getElementById("export");
const sliders = ["brightness", "contrast", "saturate", "grayscale", "blur"];
const units = { blur: "px" };
const defaults = { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, blur: 0 };
let image = null;
let name = "image";

function values() {
  return Object.fromEntries(sliders.map((s) => [s, Number(document.getElementById(s).value)]));
}

function draw() {
  const v = values();
  for (const s of sliders) document.getElementById(`o-${s}`).textContent = `${v[s]}${units[s] ?? "%"}`;
  if (!image) return;
  canvas.width = image.width;
  canvas.height = image.height;
  ctx.filter = `brightness(${v.brightness}%) contrast(${v.contrast}%) saturate(${v.saturate}%) grayscale(${v.grayscale}%) blur(${v.blur}px)`;
  ctx.drawImage(image, 0, 0);
}

async function load(blob, fileName) {
  image = await createImageBitmap(blob);
  name = fileName.replace(/\.[^.]+$/, "");
  canvas.hidden = false;
  drop.hidden = true;
  exportBtn.disabled = false;
  document.getElementById("meta").textContent = `${fileName} · ${image.width} × ${image.height}`;
  draw();
}

let saveTimer;
for (const s of sliders) {
  document.getElementById(s).addEventListener("input", () => {
    draw();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => bb.storage.set("settings", values()), 300);
  });
}

document.getElementById("reset").addEventListener("click", () => {
  for (const s of sliders) document.getElementById(s).value = defaults[s];
  draw();
  bb.storage.set("settings", values());
});

document.getElementById("open").addEventListener("click", async () => {
  const [file] = await bb.fs.pickOpen({ filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
  if (!file) return;
  const bytes = await bb.fs.read(file.handle);
  await load(new Blob([bytes]), file.name);
});

exportBtn.addEventListener("click", async () => {
  const file = await bb.fs.pickSave({ suggestedName: `${name}-edited.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
  if (!file) return;
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  await bb.fs.write(file.handle, new Uint8Array(await blob.arrayBuffer()));
});

// Drag and drop needs no permission: the user handed the file over explicitly.
stage.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("over");
});
stage.addEventListener("dragleave", () => stage.classList.remove("over"));
stage.addEventListener("drop", async (e) => {
  e.preventDefault();
  stage.classList.remove("over");
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
  if (f) await load(f, f.name);
});

const saved = await bb.storage.get("settings");
if (saved) for (const s of sliders) if (s in saved) document.getElementById(s).value = saved[s];
draw();
bb.ready();
