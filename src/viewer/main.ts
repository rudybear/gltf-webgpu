import "../shared/ui.css";
import {
  applyAnimationFrame,
  applyInteractivityPointer,
  buildRenderScene,
  loadGltfFromFiles,
  loadImageBitmaps,
  refreshInstanceMatrices,
  updateSkinMatrices,
  updateWorldMatrices,
  type RenderScene
} from "../gltf";
import { parseInteractivity, summarizeInteractivity } from "../extensions/interactivity";
import { InteractivityRuntime } from "../runtime";
import { initWebGpu } from "../shared/webgpu";
import { OrbitCamera } from "../renderer/camera";
import { mat4Invert, vec3Normalize, vec3TransformDirection, vec3TransformMat4, type Vec3 } from "../renderer/math";
import { Renderer } from "../renderer/renderer";
import fieldDiffuseUrl from "../assets/ibl/field/diffuse.ktx2?url";
import fieldSpecularUrl from "../assets/ibl/field/specular.ktx2?url";
import fieldSheenUrl from "../assets/ibl/field/sheen.ktx2?url";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">glTF Viewer</div>
      <div class="toolbar">
        <button class="primary" id="loadButton">Load glTF/glb</button>
        <button id="resetButton">Reset View</button>
      </div>
    </header>
    <section class="panel workspace">
      <div class="toolbar">
        <button id="playButton">Play</button>
        <button id="pauseButton">Pause</button>
        <button id="stepButton">Step</button>
        <select id="animationSelect"></select>
        <button id="uvDebugButton">UV Debug</button>
        <button id="ignoreTextureButton">Ignore Texture</button>
        <button id="textureDebugButton">Texture Debug</button>
        <button id="textureCenterButton">Texture Center</button>
        <button id="textureProbeButton">Probe Texture</button>
        <button id="flipVButton">Flip V</button>
        <button id="iblOnlyButton">IBL Only</button>
        <button id="iblToggleButton">IBL On</button>
        <button id="iblLoadButton">Load IBL</button>
        <button id="sheenOnlyButton">Sheen Only</button>
        <button id="sheenDataButton">Sheen Data</button>
        <label class="muted">IBL
          <input id="iblIntensity" type="range" min="0" max="2" step="0.05" value="1">
        </label>
        <label class="muted">Sheen
          <input id="sheenBoost" type="range" min="0" max="4" step="0.1" value="1">
        </label>
        <span class="muted">Interactivity: idle</span>
      </div>
      <div class="canvas-wrap">
        <canvas id="viewerCanvas"></canvas>
      </div>
    </section>
    <aside class="panel">
      <h2>Scene</h2>
      <div class="list" id="sceneList">
        <div class="card">
          <strong>No asset loaded</strong>
          <p>Load a glTF or glb file to inspect nodes and animations.</p>
        </div>
      </div>
    </aside>
    <aside class="panel">
      <h2>Diagnostics</h2>
      <div class="list" id="diagnosticsList">
        <div class="card">
          <strong>Renderer</strong>
          <p id="rendererStatus">Waiting for WebGPU...</p>
          <p id="rendererDetail">Diagnostics pending...</p>
        </div>
        <div class="card" id="interactivityCard">
          <strong>Extensions</strong>
          <p>KHR_interactivity (supported)</p>
          <p>KHR_node_visibility (supported)</p>
          <p>KHR_node_selectability (supported)</p>
          <p>KHR_node_hoverability (supported)</p>
          <p>KHR_animation_pointer (supported)</p>
        </div>
      </div>
    </aside>
  </div>
`;

const loadButton = document.querySelector<HTMLButtonElement>("#loadButton");
const playButton = document.querySelector<HTMLButtonElement>("#playButton");
const pauseButton = document.querySelector<HTMLButtonElement>("#pauseButton");
const stepButton = document.querySelector<HTMLButtonElement>("#stepButton");
const animationSelect = document.querySelector<HTMLSelectElement>("#animationSelect");
const uvDebugButton = document.querySelector<HTMLButtonElement>("#uvDebugButton");
const ignoreTextureButton = document.querySelector<HTMLButtonElement>("#ignoreTextureButton");
const textureDebugButton = document.querySelector<HTMLButtonElement>("#textureDebugButton");
const textureCenterButton = document.querySelector<HTMLButtonElement>("#textureCenterButton");
const textureProbeButton = document.querySelector<HTMLButtonElement>("#textureProbeButton");
const flipVButton = document.querySelector<HTMLButtonElement>("#flipVButton");
const iblOnlyButton = document.querySelector<HTMLButtonElement>("#iblOnlyButton");
const iblToggleButton = document.querySelector<HTMLButtonElement>("#iblToggleButton");
const iblLoadButton = document.querySelector<HTMLButtonElement>("#iblLoadButton");
const sheenOnlyButton = document.querySelector<HTMLButtonElement>("#sheenOnlyButton");
const sheenDataButton = document.querySelector<HTMLButtonElement>("#sheenDataButton");
const iblIntensity = document.querySelector<HTMLInputElement>("#iblIntensity");
const sheenBoost = document.querySelector<HTMLInputElement>("#sheenBoost");
const canvas = document.querySelector<HTMLCanvasElement>("#viewerCanvas");
const rendererStatus = document.querySelector<HTMLParagraphElement>("#rendererStatus");
const rendererDetail = document.querySelector<HTMLParagraphElement>("#rendererDetail");
const scenePanel = document.querySelector<HTMLDivElement>("#sceneList");
const interactivityCard = document.querySelector<HTMLDivElement>("#interactivityCard");

if (
  !canvas ||
  !rendererStatus ||
  !rendererDetail ||
  !loadButton ||
  !playButton ||
  !pauseButton ||
  !stepButton ||
  !animationSelect ||
  !uvDebugButton ||
  !ignoreTextureButton ||
  !textureDebugButton ||
  !textureCenterButton ||
  !textureProbeButton ||
  !flipVButton ||
  !iblOnlyButton ||
  !iblToggleButton ||
  !iblLoadButton ||
  !sheenOnlyButton ||
  !sheenDataButton ||
  !iblIntensity ||
  !sheenBoost ||
  !scenePanel ||
  !interactivityCard
) {
  throw new Error("Missing viewer UI elements.");
}

canvas.width = 1280;
canvas.height = 720;

const camera = new OrbitCamera();

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".gltf,.glb,.bin";
fileInput.multiple = true;
fileInput.style.display = "none";
document.body.appendChild(fileInput);

const iblInput = document.createElement("input");
iblInput.type = "file";
iblInput.accept = ".ktx2";
iblInput.multiple = true;
iblInput.style.display = "none";
document.body.appendChild(iblInput);

let interactivityRuntime: InteractivityRuntime | null = null;
let renderer: Renderer | null = null;
let pendingScene: RenderScene | null = null;
let pendingImages: Array<ImageBitmap | null> | null = null;
let animationTime = 0;
let lastFrameTime = performance.now();
let animationPaused = false;
let currentAnimationIndex = 0;
let uvDebugEnabled = false;
let ignoreTextureEnabled = false;
let textureDebugMode = 0;
let textureProbeText = "";
let flipVEnabled = true;
let iblEnabled = true;
let iblIntensityValue = 1;
let sheenBoostValue = 1;
let interactivityDirty = false;
let hoveredNodeIndex = -1;

loadButton.addEventListener("click", () => fileInput.click());
iblLoadButton.addEventListener("click", () => iblInput.click());
playButton.addEventListener("click", () => {
  animationPaused = false;
  lastFrameTime = performance.now();
});
pauseButton.addEventListener("click", () => {
  animationPaused = true;
});
stepButton.addEventListener("click", () => {
  if (!renderer || !pendingScene || pendingScene.animations.length === 0) {
    return;
  }
  animationTime += 1 / 60;
  applyAnimationFrame(pendingScene, animationTime, currentAnimationIndex);
  renderer.updateInstanceBuffers(pendingScene.primitives);
});
animationSelect.addEventListener("change", () => {
  currentAnimationIndex = Number.parseInt(animationSelect.value, 10) || 0;
  animationTime = 0;
  lastFrameTime = performance.now();
});
uvDebugButton.addEventListener("click", () => {
  uvDebugEnabled = !uvDebugEnabled;
  uvDebugButton.textContent = uvDebugEnabled ? "UV Debug On" : "UV Debug";
  renderer?.setDebugUv(uvDebugEnabled);
});
ignoreTextureButton.addEventListener("click", () => {
  ignoreTextureEnabled = !ignoreTextureEnabled;
  ignoreTextureButton.textContent = ignoreTextureEnabled ? "Ignore Texture On" : "Ignore Texture";
  renderer?.setIgnoreTexture(ignoreTextureEnabled);
});
textureDebugButton.addEventListener("click", () => {
  textureDebugMode = textureDebugMode === 1 ? 0 : 1;
  textureDebugButton.textContent = textureDebugMode === 1 ? "Texture Debug On" : "Texture Debug";
  if (textureDebugMode === 1) {
    textureCenterButton.textContent = "Texture Center";
  }
  renderer?.setShowTextureMode(textureDebugMode);
});
textureCenterButton.addEventListener("click", () => {
  textureDebugMode = textureDebugMode === 2 ? 0 : 2;
  textureCenterButton.textContent = textureDebugMode === 2 ? "Texture Center On" : "Texture Center";
  if (textureDebugMode === 2) {
    textureDebugButton.textContent = "Texture Debug";
    iblOnlyButton.textContent = "IBL Only";
    sheenOnlyButton.textContent = "Sheen Only";
  }
  renderer?.setShowTextureMode(textureDebugMode);
});
iblOnlyButton.addEventListener("click", () => {
  textureDebugMode = textureDebugMode === 3 ? 0 : 3;
  iblOnlyButton.textContent = textureDebugMode === 3 ? "IBL Only On" : "IBL Only";
  if (textureDebugMode === 3) {
    textureDebugButton.textContent = "Texture Debug";
    textureCenterButton.textContent = "Texture Center";
    sheenOnlyButton.textContent = "Sheen Only";
  }
  renderer?.setShowTextureMode(textureDebugMode);
});
sheenOnlyButton.addEventListener("click", () => {
  textureDebugMode = textureDebugMode === 4 ? 0 : 4;
  sheenOnlyButton.textContent = textureDebugMode === 4 ? "Sheen Only On" : "Sheen Only";
  if (textureDebugMode === 4) {
    textureDebugButton.textContent = "Texture Debug";
    textureCenterButton.textContent = "Texture Center";
    iblOnlyButton.textContent = "IBL Only";
  }
  renderer?.setShowTextureMode(textureDebugMode);
});
sheenDataButton.addEventListener("click", () => {
  textureDebugMode = textureDebugMode === 5 ? 0 : 5;
  sheenDataButton.textContent = textureDebugMode === 5 ? "Sheen Data On" : "Sheen Data";
  if (textureDebugMode === 5) {
    textureDebugButton.textContent = "Texture Debug";
    textureCenterButton.textContent = "Texture Center";
    iblOnlyButton.textContent = "IBL Only";
    sheenOnlyButton.textContent = "Sheen Only";
  }
  renderer?.setShowTextureMode(textureDebugMode);
});
textureProbeButton.addEventListener("click", async () => {
  const probeEl = document.querySelector<HTMLParagraphElement>("#textureProbeText");
  if (!renderer || !pendingScene) {
    if (probeEl) {
      probeEl.textContent = "Texture probe: no scene loaded.";
    }
    return;
  }
  const material = pendingScene.materials[0];
  const index = material?.baseColorTexture?.imageIndex ?? null;
  if (index === null) {
    if (probeEl) {
      probeEl.textContent = "Texture probe: no baseColor texture.";
    }
    return;
  }
  const image = pendingImages?.[index];
  const centerX = image ? Math.floor(image.width / 2) : 0;
  const centerY = image ? Math.floor(image.height / 2) : 0;
  const rgba = await renderer.probeTexturePixel(index, centerX, centerY);
  if (probeEl) {
    probeEl.textContent = rgba
      ? `Texture probe: center rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3]})`
      : "Texture probe: unavailable.";
  }
});
flipVButton.addEventListener("click", () => {
  flipVEnabled = !flipVEnabled;
  flipVButton.textContent = flipVEnabled ? "Flip V On" : "Flip V";
  renderer?.setFlipV(flipVEnabled);
});
iblToggleButton.addEventListener("click", () => {
  iblEnabled = !iblEnabled;
  iblToggleButton.textContent = iblEnabled ? "IBL On" : "IBL Off";
  renderer?.setIblEnabled(iblEnabled);
});
iblIntensity.addEventListener("input", () => {
  iblIntensityValue = Number.parseFloat(iblIntensity.value);
  renderer?.setIblIntensity(iblIntensityValue);
});
sheenBoost.addEventListener("input", () => {
  sheenBoostValue = Number.parseFloat(sheenBoost.value);
  renderer?.setSheenBoost(sheenBoostValue);
});

iblInput.addEventListener("change", async () => {
  const files = Array.from(iblInput.files ?? []);
  if (!renderer || files.length === 0) {
    return;
  }
  const diffuse = files.find((file) => file.name.toLowerCase().includes("diffuse"));
  const specular = files.find((file) => file.name.toLowerCase().includes("specular"));
  const sheen = files.find((file) => file.name.toLowerCase().includes("sheen"));
  if (!diffuse || !specular) {
    rendererDetail.textContent = "IBL load failed: need diffuse.ktx2 and specular.ktx2.";
    iblInput.value = "";
    return;
  }
  const diffuseUrl = URL.createObjectURL(diffuse);
  const specularUrl = URL.createObjectURL(specular);
  const sheenUrl = sheen ? URL.createObjectURL(sheen) : null;
  try {
    await renderer.loadIblFromKtx2Urls(diffuseUrl, specularUrl, sheenUrl ?? undefined);
  } catch {
    rendererDetail.textContent = "IBL load failed: unable to read KTX2.";
  } finally {
    URL.revokeObjectURL(diffuseUrl);
    URL.revokeObjectURL(specularUrl);
    if (sheenUrl) {
      URL.revokeObjectURL(sheenUrl);
    }
    iblInput.value = "";
  }
});
const loadModelFiles = async (files: File[]) => {
  const doc = await loadGltfFromFiles(files);
  const json = doc.json;
  const ext = json.extensions?.KHR_interactivity;
  const graph = parseInteractivity(ext);
  interactivityRuntime = graph ? new InteractivityRuntime(graph, json) : null;
  const summary = summarizeInteractivity(graph);
  const scene = await buildRenderScene(doc, {
    fileMap: new Map(files.map((file) => [file.name, file]))
  });
  const images = await loadImageBitmaps(doc, {
    fileMap: new Map(files.map((file) => [file.name, file]))
  });
  pendingScene = scene;
  pendingImages = images;
  animationTime = 0;
  lastFrameTime = performance.now();
  if (scene.bounds) {
    camera.setTarget(scene.bounds.center);
    const radius = Math.max(0.01, scene.bounds.radius);
    camera.setDistance(radius * 2.6);
  }
  if (renderer) {
    renderer.setScene(scene, images);
  }
  if (interactivityRuntime) {
    interactivityRuntime.bindAdapter({
      applyPointer: (pointer, value) => {
        const normalized = Array.isArray(value) ? value.map(Number) : [Number(value)];
        if (applyInteractivityPointer(scene, pointer, normalized)) {
          interactivityDirty = true;
        }
      },
      setNodeVisibility: (nodeIndex, visible) => {
        const node = scene.nodes[nodeIndex];
        if (node) {
          node.visible = visible;
          interactivityDirty = true;
        }
      },
      setNodeSelectable: (nodeIndex, selectable) => {
        const node = scene.nodes[nodeIndex];
        if (node) {
          node.selectable = selectable;
        }
      },
      setNodeHoverable: (nodeIndex, hoverable) => {
        const node = scene.nodes[nodeIndex];
        if (node) {
          node.hoverable = hoverable;
        }
      }
    });
    interactivityRuntime.start();
    interactivityDirty = true;
  }

  const instanceCount = scene.primitives.reduce(
    (total, primitive) => total + (primitive.instances.length ? primitive.instances.length / 16 : 1),
    0
  );

  const primaryFile = files.find((item) =>
    item.name.toLowerCase().endsWith(".gltf") || item.name.toLowerCase().endsWith(".glb")
  ) ?? files[0];

  const materialRows = scene.materials.map((material, index) => {
    const tex = material.baseColorTexture?.imageIndex ?? null;
    const texLabel = tex === null ? "none" : `image ${tex}`;
    return `<p>Material ${index + 1}: baseColor ${texLabel}</p>`;
  }).join("");

  const imageRows = images.map((image, index) => {
    if (!image) {
      return `<p>Image ${index}: failed</p>`;
    }
    return `<p>Image ${index}: ${image.width}x${image.height}</p>`;
  }).join("");

  scenePanel.innerHTML = `
    <div class="card">
      <strong>${primaryFile.name}</strong>
      <p>Nodes: ${json.nodes?.length ?? 0}</p>
      <p>Meshes: ${json.meshes?.length ?? 0}</p>
      <p>Primitives: ${scene.primitives.length}</p>
      <p>Instances: ${instanceCount}</p>
      <p>Animations: ${scene.animations.length}</p>
      <p>Extensions: ${(json.extensionsUsed ?? []).join(", ") || "none"}</p>
      <p>Images: ${(json.images?.length ?? 0)}</p>
      <p>Textures: ${(json.textures?.length ?? 0)}</p>
      ${materialRows}
      ${imageRows}
      <p id="textureProbeText">${textureProbeText}</p>
      <div id="imagePreview"></div>
    </div>
  `;

  const preview = document.querySelector<HTMLDivElement>("#imagePreview");
  if (preview && images[0]) {
    const canvas = document.createElement("canvas");
    const bitmap = images[0];
    const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.floor(bitmap.width * scale);
    canvas.height = Math.floor(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      preview.appendChild(canvas);
    }
  }

  animationSelect.innerHTML = "";
  if (scene.animations.length === 0) {
    const option = document.createElement("option");
    option.value = "0";
    option.textContent = "No animations";
    animationSelect.appendChild(option);
    animationSelect.disabled = true;
  } else {
    scene.animations.forEach((animation, index) => {
      const option = document.createElement("option");
      option.value = `${index}`;
      option.textContent = animation.name ?? `Animation ${index + 1}`;
      animationSelect.appendChild(option);
    });
    animationSelect.disabled = false;
    currentAnimationIndex = 0;
  }

  interactivityCard.innerHTML = `
    <strong>KHR_interactivity</strong>
    <p>Nodes: ${summary.nodes}</p>
    <p>Edges: ${summary.edges}</p>
    <p>Variables: ${summary.variables}</p>
    <p>KHR_node_visibility: supported</p>
    <p>KHR_node_selectability: supported</p>
    <p>KHR_node_hoverability: supported</p>
    <p>KHR_animation_pointer: supported</p>
  `;
};

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length === 0) {
    return;
  }

  try {
    await loadModelFiles(files);
  } catch (err) {
    scenePanel.innerHTML = `
      <div class="card">
        <strong>Load failed</strong>
        <p>${err instanceof Error ? err.message : "Unknown error"}</p>
      </div>
    `;
  } finally {
    fileInput.value = "";
  }
});

initWebGpu(canvas)
  .then((ctx) => {
    renderer = new Renderer(ctx);
    renderer.setViewProjectionProvider(() => ({
      viewProj: camera.getViewProjection(),
      cameraPos: camera.getEyePosition()
    }));
    renderer.setFlipV(flipVEnabled);
    renderer.setIblEnabled(iblEnabled);
    renderer.setIblIntensity(iblIntensityValue);
    renderer.setSheenBoost(sheenBoostValue);
    renderer.loadIblFromKtx2Urls(fieldDiffuseUrl, fieldSpecularUrl, fieldSheenUrl).catch(() => {
      rendererDetail.textContent = "IBL load failed (field).";
    });
    renderer.start();
    rendererStatus.textContent = "WebGPU ready.";
    if (pendingScene) {
      renderer.setScene(pendingScene, pendingImages ?? []);
    }
    setInterval(() => {
      if (!renderer) {
        return;
      }
      const info = renderer.getDiagnostics();
      rendererDetail.textContent = `Meshes: ${info.meshCount} | Instances: ${info.instanceCount} | Textures: ${info.textureCount} | IBL loaded: ${info.iblLoaded} | IBL LOD: ${info.iblMaxLod} | Error: ${info.lastError} | Pipeline: ${info.pipelineError} | BindGroup: ${info.bindGroupError} | Device lost: ${info.deviceLost}`;
    }, 500);
  })
  .catch((err) => {
    rendererStatus.textContent = err instanceof Error ? err.message : "WebGPU init failed.";
  });

const resizeCanvas = () => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  camera.setAspect(rect.width / rect.height);
  renderer?.resize();
};

resizeCanvas();
window.addEventListener("resize", resizeCanvas);
const resizeObserver = new ResizeObserver(() => resizeCanvas());
resizeObserver.observe(canvas);

type Ray = { origin: Vec3; direction: Vec3 };

const transformVec4 = (m: Float32Array, x: number, y: number, z: number, w: number): [number, number, number, number] => {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w
  ];
};

const buildRayFromScreen = (x: number, y: number): Ray | null => {
  const invViewProj = mat4Invert(camera.getViewProjection());
  if (!invViewProj) {
    return null;
  }
  const ndcX = x * 2 - 1;
  const ndcY = 1 - y * 2;
  const near = transformVec4(invViewProj, ndcX, ndcY, -1, 1);
  const far = transformVec4(invViewProj, ndcX, ndcY, 1, 1);
  const nearW = near[3] || 1;
  const farW = far[3] || 1;
  const nearPos: Vec3 = [near[0] / nearW, near[1] / nearW, near[2] / nearW];
  const farPos: Vec3 = [far[0] / farW, far[1] / farW, far[2] / farW];
  const dir = vec3Normalize([farPos[0] - nearPos[0], farPos[1] - nearPos[1], farPos[2] - nearPos[2]]);
  return { origin: nearPos, direction: dir };
};

const intersectRayAabb = (
  origin: Vec3,
  direction: Vec3,
  min: [number, number, number],
  max: [number, number, number]
): number | null => {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const o = origin[i];
    const d = direction[i];
    const minVal = min[i];
    const maxVal = max[i];
    if (Math.abs(d) < 1e-6) {
      if (o < minVal || o > maxVal) {
        return null;
      }
      continue;
    }
    const inv = 1 / d;
    let t1 = (minVal - o) * inv;
    let t2 = (maxVal - o) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmax < tmin) {
      return null;
    }
  }
  return tmin >= 0 ? tmin : tmax >= 0 ? tmax : null;
};

const pickNode = (
  scene: RenderScene,
  ray: Ray,
  mode: "hover" | "select"
): { nodeIndex: number; point: Vec3 } | null => {
  let best: { nodeIndex: number; point: Vec3; distance: number } | null = null;
  for (const primitive of scene.primitives) {
    const bounds = primitive.bounds;
    for (const nodeIndex of primitive.nodeIndices) {
      const node = scene.nodes[nodeIndex];
      if (!node || !node.visible) {
        continue;
      }
      if (mode === "select" && !node.selectable) {
        continue;
      }
      if (mode === "hover" && !node.hoverable) {
        continue;
      }
      const inv = mat4Invert(node.worldMatrix);
      if (!inv) {
        continue;
      }
      const originLocal = vec3TransformMat4(inv, ray.origin);
      const dirLocal = vec3Normalize(vec3TransformDirection(inv, ray.direction));
      const hitT = intersectRayAabb(originLocal, dirLocal, bounds.min, bounds.max);
      if (hitT === null) {
        continue;
      }
      const hitLocal: Vec3 = [
        originLocal[0] + dirLocal[0] * hitT,
        originLocal[1] + dirLocal[1] * hitT,
        originLocal[2] + dirLocal[2] * hitT
      ];
      const hitWorld = vec3TransformMat4(node.worldMatrix, hitLocal);
      const dx = hitWorld[0] - ray.origin[0];
      const dy = hitWorld[1] - ray.origin[1];
      const dz = hitWorld[2] - ray.origin[2];
      const dist = Math.hypot(dx, dy, dz);
      if (!best || dist < best.distance) {
        best = { nodeIndex, point: hitWorld, distance: dist };
      }
    }
  }
  if (!best) {
    return null;
  }
  return { nodeIndex: best.nodeIndex, point: best.point };
};

canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  camera.onPointerDown(event.clientX, event.clientY);
  const rect = canvas.getBoundingClientRect();
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  interactivityRuntime?.queueEvent({ type: "pointerdown", x, y });
  if (pendingScene && interactivityRuntime) {
    const ray = buildRayFromScreen(x, y);
    if (ray) {
      const hit = pickNode(pendingScene, ray, "select");
      const nodeIndex = hit ? hit.nodeIndex : -1;
      const point = hit ? hit.point : [NaN, NaN, NaN];
      interactivityRuntime.setSelection(nodeIndex, point as Vec3);
      interactivityDirty = true;
    }
  }
});

canvas.addEventListener("pointermove", (event) => {
  camera.onPointerMove(event.clientX, event.clientY);
  const rect = canvas.getBoundingClientRect();
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  interactivityRuntime?.queueEvent({ type: "pointermove", x, y });
  if (pendingScene && interactivityRuntime) {
    const ray = buildRayFromScreen(x, y);
    if (ray) {
      const hit = pickNode(pendingScene, ray, "hover");
      const nextIndex = hit ? hit.nodeIndex : -1;
      if (nextIndex !== hoveredNodeIndex) {
        hoveredNodeIndex = nextIndex;
        const point = hit ? hit.point : [NaN, NaN, NaN];
        interactivityRuntime.setHover(hoveredNodeIndex, point as Vec3);
        interactivityDirty = true;
      }
    }
  }
});

canvas.addEventListener("pointerup", (event) => {
  canvas.releasePointerCapture(event.pointerId);
  camera.onPointerUp();
  const rect = canvas.getBoundingClientRect();
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
  interactivityRuntime?.queueEvent({ type: "pointerup", x, y });
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  camera.onWheel(event.deltaY);
}, { passive: false });

const animationLoop = (time: number) => {
  const delta = Math.max(0, (time - lastFrameTime) / 1000);
  lastFrameTime = time;
  let needsRefresh = false;
  if (renderer && pendingScene && pendingScene.animations.length > 0 && !animationPaused) {
    animationTime += delta;
    applyAnimationFrame(pendingScene, animationTime, currentAnimationIndex);
    needsRefresh = true;
  }
  if (interactivityRuntime) {
    interactivityRuntime.setActiveCamera(camera.getEyePosition(), camera.getRotation());
    interactivityRuntime.tick(delta);
    if (interactivityRuntime.consumeDirty()) {
      interactivityDirty = true;
    }
  }
  if (renderer && pendingScene && (needsRefresh || interactivityDirty)) {
    updateWorldMatrices(pendingScene.nodes, pendingScene.json);
    refreshInstanceMatrices(pendingScene);
    updateSkinMatrices(pendingScene.primitives, pendingScene.nodes, pendingScene.skins);
    renderer.updateInstanceBuffers(pendingScene.primitives);
    renderer.updateMaterialUniforms(pendingScene.materials);
    renderer.updateSkinBuffers(pendingScene.primitives);
    interactivityDirty = false;
  }
  requestAnimationFrame(animationLoop);
};

requestAnimationFrame(animationLoop);

// Automation hook: load a model from a URL (e.g. viewer.html?model=/external/...).
// External .gltf resources are fetched relative to the model URL and fed through
// the same fileMap path the file-input flow uses.
const loadModelFromUrl = async (url: string) => {
  const slash = url.lastIndexOf("/");
  const base = url.slice(0, slash + 1);
  const name = decodeURIComponent(url.slice(slash + 1));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch model: ${response.status}`);
  }
  if (name.toLowerCase().endsWith(".glb")) {
    await loadModelFiles([new File([await response.arrayBuffer()], name)]);
    return;
  }
  const text = await response.text();
  const json = JSON.parse(text) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
  const uris = new Set<string>();
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (item.uri && !item.uri.startsWith("data:")) {
      uris.add(item.uri);
    }
  }
  const files: File[] = [new File([text], name)];
  await Promise.all([...uris].map(async (uri) => {
    const res = await fetch(base + uri);
    if (!res.ok) {
      throw new Error(`Failed to fetch resource ${uri}: ${res.status}`);
    }
    files.push(new File([await res.arrayBuffer()], uri));
  }));
  await loadModelFiles(files);
};

type HarnessLoadResult = { status: "ok" | "error"; error: string | null };

declare global {
  interface Window {
    __loadModel?: (url: string) => Promise<HarnessLoadResult>;
    __lastLoad?: HarnessLoadResult | null;
    __rendererDiagnostics?: () => unknown;
  }
}

window.__loadModel = async (url: string) => {
  window.__lastLoad = null;
  try {
    await loadModelFromUrl(url);
    window.__lastLoad = { status: "ok", error: null };
  } catch (err) {
    window.__lastLoad = { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  return window.__lastLoad;
};
window.__rendererDiagnostics = () => renderer?.getDiagnostics() ?? null;

const modelParam = new URLSearchParams(window.location.search).get("model");
if (modelParam) {
  void window.__loadModel(modelParam);
}
