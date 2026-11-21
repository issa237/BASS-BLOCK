// STL viewer built on a vendored three.js (blocks can't load from CDNs).
import * as THREE from "./vendor/three.min.js";

const container = document.getElementById("view");
const info = document.getElementById("info");
const dark = matchMedia("(prefers-color-scheme: dark)").matches;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
container.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(dark ? 0x151412 : 0xeceae6);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x222222 : 0x999999, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 5, 4);
scene.add(sun);
const grid = new THREE.GridHelper(10, 20, dark ? 0x444444 : 0xbbbbbb, dark ? 0x2a2a2a : 0xd6d6d6);
scene.add(grid);

const material = new THREE.MeshStandardMaterial({ color: 0xff8a3d, metalness: 0.1, roughness: 0.45, flatShading: false });
let mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.32, 220, 32), material);
scene.add(mesh);

// --- minimal orbit controls ------------------------------------------------
const orbit = { theta: 0.8, phi: 1.1, radius: 6, target: new THREE.Vector3() };
function placeCamera() {
  const { theta, phi, radius, target } = orbit;
  camera.position.set(target.x + radius * Math.sin(phi) * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * Math.sin(phi) * Math.cos(theta));
  camera.lookAt(target);
}
let drag = null;
renderer.domElement.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.pan) {
    const s = orbit.radius * 0.0015;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
  } else {
    orbit.theta -= dx * 0.008;
    orbit.phi = Math.min(Math.PI - 0.05, Math.max(0.05, orbit.phi - dy * 0.008));
  }
  placeCamera();
});
renderer.domElement.addEventListener("pointerup", () => (drag = null));
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("wheel", (e) => {
  e.preventDefault();
  orbit.radius = Math.max(0.05, orbit.radius * Math.exp(e.deltaY * 0.0012));
  placeCamera();
}, { passive: false });

// --- STL parsing (binary + ASCII) ------------------------------------------
function parseSTL(buffer) {
  const view = new DataView(buffer);
  const isBinary = buffer.byteLength >= 84 && 84 + view.getUint32(80, true) * 50 === buffer.byteLength;
  const positions = [];
  if (isBinary) {
    const n = view.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) positions.push(view.getFloat32(o + v * 12, true), view.getFloat32(o + v * 12 + 4, true), view.getFloat32(o + v * 12 + 8, true));
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m;
    while ((m = re.exec(text))) positions.push(+m[1], +m[2], +m[3]);
  }
  if (!positions.length) throw new Error("No triangles found. Is this an STL file?");
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  g.rotateX(-Math.PI / 2); // STL is usually Z-up
  g.userData.loaded = true; // stop the demo spin
  return g;
}

function fit() {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  mesh.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  const r = Math.max(size.x, size.y, size.z) || 1;
  orbit.target.set(0, size.y / 2, 0);
  orbit.radius = r * 2.2;
  grid.scale.setScalar(r / 4);
  camera.near = r / 1000;
  camera.far = r * 100;
  camera.updateProjectionMatrix();
  placeCamera();
}

function show(geometry, label) {
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(0, 0, 0);
  scene.add(mesh);
  fit();
  const s = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  info.textContent = `${label} · ${(geometry.attributes.position.count / 3).toLocaleString()} triangles · ${s.x.toFixed(1)} × ${s.z.toFixed(1)} × ${s.y.toFixed(1)}`;
}

async function loadBuffer(buffer, name) {
  try {
    show(parseSTL(buffer), name);
    await bb.storage.set("lastFile", name);
  } catch (e) {
    info.textContent = e.message;
  }
}

document.getElementById("open").addEventListener("click", async () => {
  const [file] = await bb.fs.pickOpen({ filters: [{ name: "STL", extensions: ["stl"] }] });
  if (!file) return;
  const bytes = await bb.fs.read(file.handle);
  await loadBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), file.name);
});
document.getElementById("wire").addEventListener("change", (e) => (material.wireframe = e.target.checked));
document.getElementById("fit").addEventListener("click", fit);
addEventListener("dragover", (e) => (e.preventDefault(), document.body.classList.add("over")));
addEventListener("dragleave", () => document.body.classList.remove("over"));
addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("over");
  const f = [...e.dataTransfer.files].find((f) => /\.stl$/i.test(f.name));
  if (f) await loadBuffer(await f.arrayBuffer(), f.name);
});

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / Math.max(1, innerHeight);
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();
fit();
renderer.setAnimationLoop(() => {
  if (!drag && !mesh.geometry.userData.loaded) mesh.rotation.y += 0.003;
  renderer.render(scene, camera);
});
bb.ready();
