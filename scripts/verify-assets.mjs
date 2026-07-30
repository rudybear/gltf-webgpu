// Runs every model in external/glTF-Sample-Assets through the project's real
// glTF loader (loadGltf + buildRenderScene) headlessly in Node, and reports
// pass/fail per asset variant plus a roll-up by extension.
//
// Usage: node scripts/verify-assets.mjs [--filter <substring>] [--json <out.json>]

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { loadGltf, buildRenderScene, loadImageBitmaps } from "../src/gltf/index.ts";

const MODELS_ROOT = new URL("../external/glTF-Sample-Assets/Models/", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1");

// Node has no createImageBitmap; stub it with a magic-byte sniffer so
// loadImageBitmaps still validates that every referenced image resolves to a
// plausible payload. Unknown/empty payloads throw -> recorded as null bitmaps.
globalThis.createImageBitmap = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 12) throw new Error("image payload too small");
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const isKtx2 = bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58
    && bytes[4] === 0x20 && bytes[5] === 0x32 && bytes[6] === 0x30;
  if (!isPng && !isJpeg && !isWebp && !isKtx2) throw new Error("unrecognized image format");
  return { width: 1, height: 1, close() {} };
};

async function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full, base));
    } else {
      out.push({ full, rel: relative(base, full).split(sep).join("/") });
    }
  }
  return out;
}

async function buildFileMap(variantDir) {
  const fileMap = new Map();
  for (const { full, rel } of await walkFiles(variantDir)) {
    const data = await readFile(full);
    const file = new File([data], rel);
    // Register under every spelling a glTF URI might use for this file.
    const keys = new Set([rel, encodeURI(rel), encodeURIComponent(rel)]);
    try { keys.add(decodeURIComponent(rel)); } catch {}
    for (const key of keys) fileMap.set(key, file);
  }
  return fileMap;
}

function collectExtensions(json) {
  return {
    used: json.extensionsUsed ?? [],
    required: json.extensionsRequired ?? []
  };
}

async function testVariant(modelName, variantName, variantDir) {
  const entries = await readdir(variantDir);
  const glb = entries.find((f) => f.toLowerCase().endsWith(".glb"));
  const gltf = entries.find((f) => f.toLowerCase().endsWith(".gltf"));
  const record = {
    model: modelName,
    variant: variantName,
    file: glb ?? gltf ?? null,
    status: "ok",
    error: null,
    extensionsUsed: [],
    extensionsRequired: [],
    imageCount: 0,
    imageFailures: 0,
    primitives: 0,
    nodes: 0
  };
  if (!record.file) {
    record.status = "skip";
    record.error = "no .gltf/.glb file";
    return record;
  }
  try {
    let doc;
    let options = {};
    if (glb) {
      const data = await readFile(join(variantDir, glb));
      doc = await loadGltf(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else {
      const fileMap = await buildFileMap(variantDir);
      doc = await loadGltf(fileMap.get(gltf), { fileMap });
      options = { fileMap };
    }
    const ext = collectExtensions(doc.json);
    record.extensionsUsed = ext.used;
    record.extensionsRequired = ext.required;

    const scene = await buildRenderScene(doc, options);
    record.primitives = scene.primitives.length;
    record.nodes = scene.nodes.length;

    const bitmaps = await loadImageBitmaps(doc, options);
    record.imageCount = bitmaps.length;
    record.imageFailures = bitmaps.filter((b) => b === null).length;
    if (record.imageFailures > 0) {
      record.status = "image-fail";
    }
  } catch (err) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
  }
  return record;
}

const args = process.argv.slice(2);
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1].toLowerCase() : null;
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

const models = (await readdir(MODELS_ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => !filter || name.toLowerCase().includes(filter));

const results = [];
for (const model of models) {
  const modelDir = join(MODELS_ROOT, model);
  for (const entry of await readdir(modelDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("glTF")) continue;
    const variantDir = join(modelDir, entry.name);
    const record = await testVariant(model, entry.name, variantDir);
    results.push(record);
    const mark = record.status === "ok" ? "PASS" : record.status === "skip" ? "SKIP" : "FAIL";
    if (mark !== "PASS") {
      console.log(`${mark}  ${model}/${entry.name}  ${record.error ?? `${record.imageFailures}/${record.imageCount} images failed`}`);
    }
  }
}

const pass = results.filter((r) => r.status === "ok").length;
const fail = results.filter((r) => r.status === "error").length;
const imgFail = results.filter((r) => r.status === "image-fail").length;
const skip = results.filter((r) => r.status === "skip").length;
console.log(`\nTotal: ${results.length}  pass: ${pass}  load-fail: ${fail}  image-fail: ${imgFail}  skip: ${skip}`);

// Roll-up by extension: how many asset variants using each extension pass.
const byExt = new Map();
for (const r of results) {
  for (const ext of new Set([...r.extensionsUsed, ...r.extensionsRequired])) {
    if (!byExt.has(ext)) byExt.set(ext, { total: 0, pass: 0 });
    const s = byExt.get(ext);
    s.total += 1;
    if (r.status === "ok") s.pass += 1;
  }
}
console.log("\nPer-extension (variants using ext: pass/total):");
for (const [ext, s] of [...byExt.entries()].sort()) {
  console.log(`  ${s.pass === s.total ? " " : "!"} ${ext}: ${s.pass}/${s.total}`);
}

if (jsonOut) {
  await writeFile(jsonOut, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${jsonOut}`);
}
