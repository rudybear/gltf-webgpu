// Generates examples/audio-demo/: three "drum pad" cubes wired end-to-end
// through KHR_audio_emitter + KHR_audio_environment + KHR_interactivity.
// Clicking a pad fires event/onSelect -> pointer/set of the source's `playing`
// pointer, which the viewer's AudioSystem bridge turns into a one-shot.
// Sounds are synthesized WAVs (prototype only — a spec-conformant asset ships
// MP3/Opus; see KHR_audio_emitter codec discussion).
//
// Usage: node scripts/make-audio-demo.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "audio-demo");
fs.mkdirSync(outDir, { recursive: true });

// --- WAV synthesis ---------------------------------------------------------

const SAMPLE_RATE = 44100;

function writeWav(name, samples) {
  const dataLength = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path.join(outDir, name), buffer);
  console.log(`wrote ${name} (${(buffer.length / 1024).toFixed(1)} KiB)`);
}

function synthKick(duration = 0.45) {
  const n = Math.floor(SAMPLE_RATE * duration);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const freq = 40 + 80 * Math.exp(-t * 22); // pitch drop 120 -> 40 Hz
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    const env = Math.exp(-t * 9);
    const click = Math.exp(-t * 400) * 0.4 * (Math.random() * 2 - 1);
    out[i] = (Math.sin(phase) * 0.95 + click) * env;
  }
  return out;
}

function synthSnare(duration = 0.3) {
  const n = Math.floor(SAMPLE_RATE * duration);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const tone = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 25) * 0.5;
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * 18) * 0.7;
    out[i] = tone + noise;
  }
  return out;
}

function synthHihat(duration = 0.12) {
  const n = Math.floor(SAMPLE_RATE * duration);
  const out = new Float64Array(n);
  let previous = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const white = Math.random() * 2 - 1;
    const highpassed = white - previous; // crude one-zero high-pass
    previous = white;
    out[i] = highpassed * Math.exp(-t * 55) * 0.8;
  }
  return out;
}

writeWav("kick.wav", synthKick());
writeWav("snare.wav", synthSnare());
writeWav("hihat.wav", synthHihat());

// --- Cube mesh (positions, normals, indices) -------------------------------

const faces = [
  { normal: [0, 0, 1],  corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0],  corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0],  corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }
];

const positions = [];
const normals = [];
const indices = [];
for (const face of faces) {
  const base = positions.length / 3;
  for (const corner of face.corners) {
    positions.push(corner[0] * 0.5, corner[1] * 0.5, corner[2] * 0.5);
    normals.push(...face.normal);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

const positionBytes = Buffer.from(new Float32Array(positions).buffer);
const normalBytes = Buffer.from(new Float32Array(normals).buffer);
const indexBytes = Buffer.from(new Uint16Array(indices).buffer);
const bin = Buffer.concat([positionBytes, normalBytes, indexBytes]);
fs.writeFileSync(path.join(outDir, "drum-pads.bin"), bin);

// --- glTF document ---------------------------------------------------------

const PADS = [
  { name: "KickPad", translation: [-1.6, 0, 0], color: [0.85, 0.2, 0.2, 1], source: 0 },
  { name: "SnarePad", translation: [0, 0, 0], color: [0.2, 0.6, 0.85, 1], source: 1 },
  { name: "HihatPad", translation: [1.6, 0, 0], color: [0.9, 0.8, 0.25, 1], source: 2 }
];

const interactivityNodes = [];
const declarations = [{ op: "event/onSelect" }, { op: "pointer/set" }];
PADS.forEach((pad, index) => {
  const selectNodeId = interactivityNodes.length;
  interactivityNodes.push({
    declaration: 0,
    configuration: { nodeIndex: { value: [index] }, stopPropagation: { value: [true] } },
    flows: { out: { node: selectNodeId + 1, socket: "in" } }
  });
  interactivityNodes.push({
    declaration: 1,
    configuration: {
      pointer: { value: [`/extensions/KHR_audio_emitter/sources/${pad.source}/playing`] },
      type: { value: [0] }
    },
    values: { value: { value: [1], type: 0 } }
  });
});

const gltf = {
  asset: { version: "2.0", generator: "make-audio-demo.mjs" },
  extensionsUsed: ["KHR_audio_emitter", "KHR_audio_environment", "KHR_interactivity"],
  extensions: {
    KHR_audio_emitter: {
      audio: [
        { uri: "kick.wav" },
        { uri: "snare.wav" },
        { uri: "hihat.wav" }
      ],
      sources: [
        { name: "kick", audio: 0, gain: 1.0 },
        { name: "snare", audio: 1, gain: 0.9 },
        { name: "hihat", audio: 2, gain: 0.7 }
      ],
      emitters: PADS.map((pad, index) => ({
        name: `${pad.name}Emitter`,
        type: "positional",
        gain: 1.0,
        sources: [pad.source],
        positional: {
          shapeType: "omnidirectional",
          distanceModel: "inverse",
          refDistance: 1.0,
          maxDistance: 40.0,
          rolloffFactor: 1.0,
          extensions: {
            KHR_audio_environment: {
              airAbsorption: { enabled: true, cutoffAtMaxDistance: 6000.0 }
            }
          }
        },
        extensions: {
          KHR_audio_environment: { directLevel: 1.0, reverbLevel: 0.6 }
        }
      }))
    },
    KHR_audio_environment: {
      listeners: [{ name: "Player", gain: 1.0, spatializationModel: "HRTF" }],
      environments: [{ name: "Studio", reverb: { preset: "mediumRoom", mix: 0.3 } }]
    },
    KHR_interactivity: {
      graph: 0,
      graphs: [{
        types: [{ signature: "float" }],
        declarations,
        nodes: interactivityNodes,
        variables: []
      }]
    }
  },
  scenes: [{
    name: "DrumPads",
    nodes: [0, 1, 2, 3],
    extensions: { KHR_audio_environment: { environment: 0, activeListener: 0 } }
  }],
  scene: 0,
  nodes: [
    ...PADS.map((pad, index) => ({
      name: pad.name,
      mesh: 0,
      translation: pad.translation,
      extensions: { KHR_audio_emitter: { emitters: [index] } }
    })),
    {
      name: "ListenerCamera",
      camera: 0,
      translation: [0, 1.2, 4],
      extensions: { KHR_audio_environment: { listener: 0 } }
    }
  ],
  cameras: [{ type: "perspective", perspective: { yfov: 0.8, znear: 0.05, zfar: 100 } }],
  meshes: [{
    name: "Pad",
    primitives: PADS.map((pad, index) => ({
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: 2,
      material: index,
      mode: 4
    })).slice(0, 1)
  }],
  materials: PADS.map((pad) => ({
    name: `${pad.name}Material`,
    pbrMetallicRoughness: { baseColorFactor: pad.color, metallicFactor: 0.1, roughnessFactor: 0.6 }
  })),
  buffers: [{ uri: "drum-pads.bin", byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
    { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 },
    { buffer: 0, byteOffset: positionBytes.length + normalBytes.length, byteLength: indexBytes.length, target: 34963 }
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5]
    },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR" }
  ]
};

// Give each pad its own material by duplicating the mesh per material.
gltf.meshes = PADS.map((pad, index) => ({
  name: `${pad.name}Mesh`,
  primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: index, mode: 4 }]
}));
gltf.nodes.forEach((node, index) => {
  if (index < PADS.length) {
    node.mesh = index;
  }
});

fs.writeFileSync(path.join(outDir, "drum-pads.gltf"), JSON.stringify(gltf, null, 2));
console.log(`wrote drum-pads.gltf (${interactivityNodes.length} interactivity nodes)`);
console.log("Open: viewer.html?model=/examples/audio-demo/drum-pads.gltf — enable Audio, click the pads.");
