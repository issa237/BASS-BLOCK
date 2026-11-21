// Markdown editor with live word-frequency stats.
// Data: the document is autosaved with bb.storage ("doc"); files are opened/saved with bb.fs.
const STOP = new Set("a an and are as at be but by for from has have he her his i if in into is it its me my not of on or our she so that the their them then there they this to was we were what when which who will with you your".split(" "));

const editor = document.getElementById("editor");
const savedEl = document.getElementById("saved");
const fileEl = document.getElementById("file");

function stats(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const freq = new Map();
  for (const w of words) if (w.length > 1 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { words: words.length, chars: text.length, minutes: Math.max(words.length ? 1 : 0, Math.round(words.length / 230)), top };
}

function render() {
  const s = stats(editor.value);
  document.getElementById("words").textContent = s.words.toLocaleString();
  document.getElementById("chars").textContent = s.chars.toLocaleString();
  document.getElementById("read").textContent = s.minutes;
  const max = s.top[0]?.[1] ?? 1;
  document.getElementById("top").replaceChildren(
    ...s.top.map(([w, n]) => {
      const li = document.createElement("li");
      const word = document.createElement("span");
      word.textContent = w;
      const count = document.createElement("span");
      count.className = "n";
      count.textContent = n;
      const bar = document.createElement("span");
      bar.className = "bar-fill";
      bar.style.width = `${(n / max) * 100}%`;
      li.append(word, count, bar);
      return li;
    }),
  );
  bb.emit("stats", { words: s.words, chars: s.chars, top: s.top });
}

let timer;
editor.addEventListener("input", () => {
  render();
  savedEl.textContent = "Editing…";
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await bb.storage.set("doc", editor.value);
    savedEl.textContent = "Saved";
  }, 400);
});

let currentHandle = null;

document.getElementById("open").addEventListener("click", async () => {
  const [file] = await bb.fs.pickOpen({ writable: true, filters: [{ name: "Text", extensions: ["md", "markdown", "txt"] }] });
  if (!file) return;
  currentHandle = file.handle;
  editor.value = await bb.fs.readText(file.handle);
  fileEl.textContent = file.name;
  editor.dispatchEvent(new Event("input"));
});

document.getElementById("save").addEventListener("click", async () => {
  if (currentHandle) {
    await bb.fs.write(currentHandle, editor.value);
    savedEl.textContent = "Saved to file";
    return;
  }
  const file = await bb.fs.pickSave({ suggestedName: fileEl.textContent || "document.md" });
  if (!file) return;
  currentHandle = file.handle;
  await bb.fs.write(file.handle, editor.value);
  fileEl.textContent = file.name;
  savedEl.textContent = "Saved to file";
});

// Other blocks can send text in.
bb.on("text", (text) => {
  if (typeof text !== "string") return;
  editor.value = text;
  editor.dispatchEvent(new Event("input"));
});

editor.value = (await bb.storage.get("doc")) ?? "# Hello\n\nStart writing. Word statistics update as you type.\n";
render();
editor.focus();
bb.ready();
