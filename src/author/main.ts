import "../shared/ui.css";
import { loadGltfFromFiles } from "../gltf";
import { parseInteractivity, summarizeInteractivity } from "../extensions/interactivity";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">glTF Authoring</div>
      <div class="toolbar">
        <button class="primary" id="importButton">Import glTF/glb</button>
        <button id="exportButton">Export</button>
      </div>
    </header>
    <section class="panel workspace">
      <div class="toolbar">
        <button>Add Node</button>
        <button>Add Edge</button>
        <button>Validate</button>
        <span class="muted">KHR_interactivity graph</span>
      </div>
      <div class="canvas-wrap">
        <div class="muted">Graph editor canvas goes here.</div>
      </div>
    </section>
    <aside class="panel">
      <h2>Scene Bindings</h2>
      <div class="list" id="bindingsList">
        <div class="card">
          <strong>No asset loaded</strong>
          <p>Import a glTF to map nodes to behavior graph inputs.</p>
        </div>
      </div>
    </aside>
    <aside class="panel">
      <h2>Validation</h2>
      <div class="list" id="validationList">
        <div class="card">
          <strong>Rules</strong>
          <p>Ensure graph nodes reference valid scene targets and parameters.</p>
        </div>
      </div>
    </aside>
  </div>
`;

const importButton = document.querySelector<HTMLButtonElement>("#importButton");
const bindingsList = document.querySelector<HTMLDivElement>("#bindingsList");
const validationList = document.querySelector<HTMLDivElement>("#validationList");

if (!importButton || !bindingsList || !validationList) {
  throw new Error("Missing authoring UI elements.");
}

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".gltf,.glb,.bin";
fileInput.multiple = true;
fileInput.style.display = "none";
document.body.appendChild(fileInput);

importButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length === 0) {
    return;
  }

  try {
    const doc = await loadGltfFromFiles(files);
    const json = doc.json;
    const graph = parseInteractivity(json.extensions?.KHR_interactivity);
    const summary = summarizeInteractivity(graph);

    const primaryFile = files.find((item) =>
      item.name.toLowerCase().endsWith(".gltf") || item.name.toLowerCase().endsWith(".glb")
    ) ?? files[0];

    bindingsList.innerHTML = `
      <div class="card">
        <strong>${primaryFile.name}</strong>
        <p>Nodes: ${json.nodes?.length ?? 0}</p>
        <p>Meshes: ${json.meshes?.length ?? 0}</p>
        <p>Animations: ${json.animations?.length ?? 0}</p>
      </div>
    `;

    validationList.innerHTML = `
      <div class="card">
        <strong>KHR_interactivity</strong>
        <p>Nodes: ${summary.nodes}</p>
        <p>Edges: ${summary.edges}</p>
        <p>Variables: ${summary.variables}</p>
      </div>
    `;
  } catch (err) {
    bindingsList.innerHTML = `
      <div class="card">
        <strong>Import failed</strong>
        <p>${err instanceof Error ? err.message : "Unknown error"}</p>
      </div>
    `;
  } finally {
    fileInput.value = "";
  }
});
