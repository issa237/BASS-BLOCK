const input = document.getElementById("input");
const output = document.getElementById("output");
const cards = document.getElementById("cards");
const runtimeEl = document.getElementById("runtime");

const SAMPLE = `Dataset metrics:
Q1 Revenue: 142.5, Q2 Revenue: 168.0, Q3 Revenue: 195.4, Q4 Revenue: 230.8
Active blocks: 12, 18, 25, 31, 44
Python backend processes numeric and text analytics automatically.`;

async function analyze() {
  try {
    const res = await bb.backend.call("analyze", { text: input.value });
    const n = res.numbers;
    const stats = [
      ["Words", res.words],
      ["Numbers", n ? n.count : 0],
      ["Mean", n ? n.mean : "—"],
      ["Median", n ? n.median : "—"],
      ["Min / Max", n ? `${n.min} / ${n.max}` : "—"],
      ["Std Dev", n ? n.stdev : "—"],
    ];
    cards.replaceChildren(
      ...stats.map(([label, val]) => {
        const div = document.createElement("div");
        div.className = "card";
        const s = document.createElement("span");
        s.textContent = label;
        const b = document.createElement("strong");
        b.textContent = String(val);
        div.append(s, b);
        return div;
      }),
    );
    output.textContent = JSON.stringify(res, null, 2);
  } catch (e) {
    output.textContent = `Backend error: ${e.message ?? e}`;
  }
}

document.getElementById("run").addEventListener("click", analyze);
document.getElementById("open").addEventListener("click", async () => {
  const [f] = await bb.fs.pickOpen({ filters: [{ name: "Data / Text", extensions: ["txt", "csv", "json", "md", "log"] }] });
  if (!f) return;
  input.value = await bb.fs.readText(f.handle);
  await bb.storage.set("input", input.value);
  await analyze();
});

let timer;
input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await bb.storage.set("input", input.value);
    await analyze();
  }, 250);
});

input.value = (await bb.storage.get("input")) ?? SAMPLE;
try {
  const info = await bb.backend.call("info");
  runtimeEl.textContent = `Python ${info.python}`;
} catch {}
await analyze();
bb.ready();
