const textEl = document.getElementById("text");
const limitEl = document.getElementById("limit");
const metricsEl = document.getElementById("metrics");
const rawEl = document.getElementById("raw");
const sysEl = document.getElementById("sys");

async function runCompute() {
  try {
    const limit = Number(limitEl.value) || 250000;
    const text = textEl.value;
    const res = await bb.backend.call("compute", { text, limit });
    const items = [
      ["Execution Time", `${res.elapsedMs} ms`],
      ["Primes Found", res.primeCount.toLocaleString()],
      ["Largest Prime", res.lastPrime.toLocaleString()],
      ["Input Bytes", res.byteLength],
    ];
    metricsEl.replaceChildren(
      ...items.map(([k, v]) => {
        const d = document.createElement("div");
        d.className = "card";
        const s = document.createElement("span");
        s.textContent = k;
        const b = document.createElement("strong");
        b.textContent = String(v);
        d.append(s, b);
        return d;
      }),
    );
    rawEl.textContent = `SHA-256: ${res.sha256}\n\n` + JSON.stringify(res, null, 2);
    await bb.storage.set("state", { text, limit });
  } catch (e) {
    rawEl.textContent = `Swift backend error: ${e.message ?? e}`;
  }
}

document.getElementById("run").addEventListener("click", runCompute);
textEl.addEventListener("input", runCompute);
limitEl.addEventListener("change", runCompute);

const saved = await bb.storage.get("state");
if (saved) {
  if (saved.text) textEl.value = saved.text;
  if (saved.limit) limitEl.value = saved.limit;
}
try {
  const info = await bb.backend.call("info");
  sysEl.textContent = `Swift · ${info.cores} cores`;
} catch {}
await runCompute();
bb.ready();
