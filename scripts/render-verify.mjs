// Renders sample assets in the real viewer (Chrome + WebGPU, headless) and
// records load status, renderer diagnostics, console errors, and a canvas
// screenshot per model. Produces reports/render/report.json plus PNGs and a
// side-by-side gallery (our render vs the official Khronos screenshot).
//
// Usage: node scripts/render-verify.mjs [--filter <substring>] [--headful]

import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MODELS_ROOT = join(ROOT, "external/glTF-Sample-Assets/Models");
const OUT_DIR = join(ROOT, "reports/render");
const PORT = 5199;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const args = process.argv.slice(2);
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1].toLowerCase() : null;
const headful = args.includes("--headful");

const exists = (p) => access(p).then(() => true, () => false);

async function pickVariantFile(modelDir) {
  for (const variant of ["glTF", "glTF-Binary", "glTF-Embedded"]) {
    const dir = join(modelDir, variant);
    if (!await exists(dir)) continue;
    const entries = await readdir(dir);
    const file = entries.find((f) => f.toLowerCase().endsWith(".gltf"))
      ?? entries.find((f) => f.toLowerCase().endsWith(".glb"));
    if (file) return { variant, file };
  }
  return null;
}

async function findScreenshot(modelDir) {
  const dir = join(modelDir, "screenshot");
  if (!await exists(dir)) return null;
  const entries = await readdir(dir);
  const shot = entries.find((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
  return shot ? join(dir, shot) : null;
}

async function serverResponds() {
  try {
    const res = await fetch(`http://localhost:${PORT}/viewer.html`);
    return res.ok;
  } catch {
    return false;
  }
}

async function startVite() {
  if (await serverResponds()) {
    console.log("reusing dev server already on port", PORT);
    return null;
  }
  const proc = spawn("npx.cmd", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await serverResponds()) return proc;
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error("vite start timeout");
}

await mkdir(OUT_DIR, { recursive: true });
const vite = await startVite();
console.log(`vite up on :${PORT}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: headful ? false : "new",
  args: ["--window-size=1500,900"]
});

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 900 });

// Quick probe: does WebGPU produce an adapter in this configuration?
await page.goto(`http://localhost:${PORT}/viewer.html`);
const hasAdapter = await page.evaluate(async () => {
  if (!navigator.gpu) return false;
  const adapter = await navigator.gpu.requestAdapter();
  return adapter !== null;
});
if (!hasAdapter) {
  console.error("No WebGPU adapter available in this browser configuration.");
  await browser.close();
  vite?.kill();
  process.exit(2);
}
console.log("WebGPU adapter OK");

// Baseline: JPEG size of the empty (no model) canvas at the standard capture
// size. A capture within 2% of this is considered blank.
await page.addStyleTag({
  content: [
    ".app-shell{display:block!important;padding:8px!important}",
    "aside.panel,header.topbar,.workspace .toolbar{display:none!important}",
    ".canvas-wrap{width:1024px!important;height:768px!important;min-height:768px!important}",
    ".canvas-wrap canvas{width:1024px!important;height:768px!important}"
  ].join("")
});
await new Promise((r) => setTimeout(r, 600));
const baselineCanvas = await page.$("#viewerCanvas");
const baselineJpeg = await baselineCanvas.screenshot({ type: "jpeg", quality: 70 });
const blankThreshold = baselineJpeg.length * 1.02;
console.log(`blank baseline: ${baselineJpeg.length} bytes`);

const models = (await readdir(MODELS_ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => !filter || name.toLowerCase().includes(filter));

const results = [];
for (const model of models) {
  const modelDir = join(MODELS_ROOT, model);
  const picked = await pickVariantFile(modelDir);
  if (!picked) {
    results.push({ model, status: "skip", reason: "no core glTF/glTF-Binary variant" });
    continue;
  }
  const modelUrl = `/external/glTF-Sample-Assets/Models/${encodeURIComponent(model)}/${picked.variant}/${encodeURIComponent(picked.file)}`;
  const record = {
    model,
    variant: picked.variant,
    file: picked.file,
    status: "ok",
    loadError: null,
    consoleErrors: [],
    diagnostics: null,
    blank: false,
    screenshot: null,
    reference: null
  };
  const consoleErrors = [];
  const onConsole = (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  };
  page.on("console", onConsole);
  const onPageError = (err) => consoleErrors.push(String(err).slice(0, 300));
  page.on("pageerror", onPageError);
  try {
    await page.goto(`http://localhost:${PORT}/viewer.html?model=${modelUrl}`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content: [
        ".app-shell{display:block!important;padding:8px!important}",
        "aside.panel,header.topbar,.workspace .toolbar{display:none!important}",
        ".canvas-wrap{width:1024px!important;height:768px!important;min-height:768px!important}",
        ".canvas-wrap canvas{width:1024px!important;height:768px!important}"
      ].join("")
    });
    await page.waitForFunction(() => window.__lastLoad !== null && window.__lastLoad !== undefined, { timeout: 45000 });
    const loadResult = await page.evaluate(() => window.__lastLoad);
    if (loadResult.status !== "ok") {
      record.status = "load-error";
      record.loadError = loadResult.error;
    } else {
      // Let a few frames render (IBL may still be uploading on first load).
      await new Promise((r) => setTimeout(r, 1200));
      record.diagnostics = await page.evaluate(() => window.__rendererDiagnostics?.() ?? null);
      const shotPath = join(OUT_DIR, `${model}.png`);
      const canvasEl = await page.$("#viewerCanvas");
      await canvasEl.screenshot({ path: shotPath });
      record.screenshot = `${model}.png`;
      // Blank detection: compare compressed size against the empty-canvas baseline.
      const jpeg = await canvasEl.screenshot({ type: "jpeg", quality: 70 });
      record.blank = jpeg.length <= blankThreshold;
      if (record.blank) record.status = "blank";
      const d = record.diagnostics;
      const healthy = (v, ok) => v === undefined || v === null || v === ok;
      if (d && !(healthy(d.lastError, "none") && healthy(d.pipelineError, "none") && healthy(d.bindGroupError, "none") && healthy(d.deviceLost, "no"))) {
        record.status = "gpu-error";
      }
    }
  } catch (err) {
    record.status = "timeout";
    record.loadError = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  record.consoleErrors = consoleErrors;
  if (consoleErrors.length && record.status === "ok") record.status = "console-error";

  const ref = await findScreenshot(modelDir);
  if (ref) {
    const ext = ref.slice(ref.lastIndexOf("."));
    const refName = `${model}.ref${ext}`;
    await copyFile(ref, join(OUT_DIR, refName));
    record.reference = refName;
  }
  results.push(record);
  if (record.status !== "ok") {
    console.log(`${record.status.toUpperCase().padEnd(13)} ${model}  ${record.loadError ?? record.consoleErrors[0] ?? ""}`);
  }
}

await browser.close();
vite?.kill();

const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log("\nSummary:", JSON.stringify(counts));

await writeFile(join(OUT_DIR, "report.json"), JSON.stringify(results, null, 2));

const rows = results.filter((r) => r.status !== "skip").map((r) => `
  <tr class="${r.status}">
    <td>${r.model}<br><small>${r.variant} · ${r.status}${r.loadError ? `<br>${r.loadError}` : ""}${r.consoleErrors.length ? `<br>${r.consoleErrors.length} console error(s)` : ""}</small></td>
    <td>${r.screenshot ? `<img src="${r.screenshot}" loading="lazy">` : "-"}</td>
    <td>${r.reference ? `<img src="${r.reference}" loading="lazy">` : "-"}</td>
  </tr>`).join("");
await writeFile(join(OUT_DIR, "gallery.html"), `<!doctype html>
<meta charset="utf-8"><title>Render verification gallery</title>
<style>
 body{font-family:system-ui;margin:16px;background:#111;color:#eee}
 table{border-collapse:collapse;width:100%}
 td{border:1px solid #333;padding:6px;vertical-align:top}
 img{max-width:420px;max-height:280px;display:block}
 tr.blank td:first-child, tr.gpu-error td:first-child, tr.timeout td:first-child, tr.load-error td:first-child{background:#5a1f1f}
 tr.console-error td:first-child{background:#5a4a1f}
</style>
<h1>Ours (WebGPU viewer) vs official Khronos screenshot</h1>
<table><tr><th>Model</th><th>Ours</th><th>Reference</th></tr>${rows}</table>`);
console.log(`Wrote ${join(OUT_DIR, "report.json")} and gallery.html`);
