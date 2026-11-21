// Starter block. `bb` is the BASS BLOCK SDK (see SKILL.md). It is always available as a global.
const info = await bb.info();
document.getElementById("title").textContent = info.name;

const btn = document.getElementById("count");
let count = (await bb.storage.get("count")) ?? 0;
const draw = () => (btn.textContent = `Clicked ${count} time${count === 1 ? "" : "s"}`);
draw();
btn.addEventListener("click", async () => {
  count++;
  draw();
  await bb.storage.set("count", count);
});

bb.ready();
