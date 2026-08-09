// Generates examples/drum-kit/: a playable drum kit expressed purely in glTF —
// procedural stylized kit geometry (CC0-by-construction), synthesized drum
// one-shots encoded as MP3 (KHR_audio_emitter base codec), a KHR_audio_graph
// processing graph (kick -> lowpass+gain, snare -> peaking EQ, crash ->
// highshelf, bound via inputs[]/outputs[]; the remaining drums are direct
// emitter paths, demonstrating rule-12 coexistence), per-drum positional
// emitters with environment sends (KHR_audio_environment), and a
// KHR_interactivity graph: event/onSelect on each drum -> pointer/set of the
// source's `playing` pointer (the viewer's E1 one-shot prototype).
//
// Usage: node scripts/make-drum-kit.mjs
// Play:  viewer.html?model=/examples/drum-kit/drum-kit.gltf  (enable Audio)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lamejs from "@breezystack/lamejs";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "drum-kit");
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Drum voice synthesis (44.1 kHz mono)
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 44100;

function envExp(t, rate) {
  return Math.exp(-t * rate);
}

function synth(duration, fn) {
  const n = Math.floor(SAMPLE_RATE * duration);
  const out = new Float64Array(n);
  const state = { phase: 0, prevNoise: 0 };
  for (let i = 0; i < n; i += 1) {
    out[i] = fn(i / SAMPLE_RATE, state);
  }
  // Gentle fade at the very end to avoid clicks.
  const fade = Math.min(256, n);
  for (let i = 0; i < fade; i += 1) {
    out[n - 1 - i] *= i / fade;
  }
  return out;
}

function pitchDrop(state, startHz, endHz, dropRate, t) {
  const freq = endHz + (startHz - endHz) * Math.exp(-t * dropRate);
  state.phase += (2 * Math.PI * freq) / SAMPLE_RATE;
  return Math.sin(state.phase);
}

const noise = () => Math.random() * 2 - 1;

function highpassNoise(state) {
  const white = noise();
  const value = white - state.prevNoise;
  state.prevNoise = white;
  return value;
}

// Inharmonic partial stack for metallic voices.
function metallic(t, partials, decayBase) {
  let value = 0;
  for (const [freq, amp, decay] of partials) {
    value += Math.sin(2 * Math.PI * freq * t) * amp * envExp(t, decayBase * decay);
  }
  return value;
}

const CYMBAL_PARTIALS = [
  [523, 0.4, 1.0], [837, 0.35, 1.1], [1218, 0.3, 1.25], [1745, 0.28, 1.4],
  [2439, 0.22, 1.6], [3361, 0.18, 1.8], [4522, 0.12, 2.1], [6133, 0.08, 2.4]
];

const VOICES = {
  kick: synth(0.5, (t, s) =>
    (pitchDrop(s, 130, 42, 24, t) * 0.95 + envExp(t, 350) * 0.5 * noise()) * envExp(t, 8.5)),
  snare: synth(0.32, (t, s) =>
    Math.sin(2 * Math.PI * 189 * t) * envExp(t, 26) * 0.45 +
    Math.sin(2 * Math.PI * 285 * t) * envExp(t, 30) * 0.2 +
    highpassNoise(s) * envExp(t, 16) * 0.75),
  tomHigh: synth(0.42, (t, s) =>
    (pitchDrop(s, 240, 165, 16, t) * 0.9 + noise() * envExp(t, 120) * 0.25) * envExp(t, 9)),
  tomMid: synth(0.5, (t, s) =>
    (pitchDrop(s, 185, 125, 14, t) * 0.9 + noise() * envExp(t, 110) * 0.25) * envExp(t, 7.5)),
  tomFloor: synth(0.62, (t, s) =>
    (pitchDrop(s, 135, 82, 12, t) * 0.92 + noise() * envExp(t, 100) * 0.22) * envExp(t, 6)),
  hihat: synth(0.14, (t, s) =>
    highpassNoise(s) * envExp(t, 50) * 0.8 + metallic(t, CYMBAL_PARTIALS, 40) * 0.06),
  crash: synth(1.9, (t, s) =>
    (highpassNoise(s) * 0.5 + metallic(t, CYMBAL_PARTIALS, 1.0) * 0.45) * envExp(t, 2.4) * 0.9),
  ride: synth(1.4, (t, s) =>
    Math.sin(2 * Math.PI * 1046 * t) * envExp(t, 3.5) * 0.3 +
    metallic(t, CYMBAL_PARTIALS, 1.6) * 0.35 * envExp(t, 2.2) +
    highpassNoise(s) * envExp(t, 9) * 0.15)
};

function encodeMp3(name, samples) {
  const int16 = new Int16Array(samples.length);
  let peak = 0;
  for (const v of samples) {
    peak = Math.max(peak, Math.abs(v));
  }
  const norm = peak > 0 ? 0.92 / peak : 1;
  for (let i = 0; i < samples.length; i += 1) {
    int16[i] = Math.round(Math.max(-1, Math.min(1, samples[i] * norm)) * 32767);
  }
  const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, 128);
  const chunks = [];
  for (let i = 0; i < int16.length; i += 1152) {
    const frame = encoder.encodeBuffer(int16.subarray(i, i + 1152));
    if (frame.length) {
      chunks.push(Buffer.from(frame));
    }
  }
  const tail = encoder.flush();
  if (tail.length) {
    chunks.push(Buffer.from(tail));
  }
  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(path.join(outDir, name), buffer);
  console.log(`wrote ${name} (${(buffer.length / 1024).toFixed(1)} KiB)`);
}

// ---------------------------------------------------------------------------
// Procedural geometry: Y-axis cylinders (drum shells, cymbal discs, stands)
// ---------------------------------------------------------------------------

function cylinder(radius, height, segments = 32) {
  const positions = [];
  const normals = [];
  const indices = [];
  const half = height / 2;
  // side
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    positions.push(radius * x, -half, radius * z, radius * x, half, radius * z);
    normals.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < segments; i += 1) {
    const b = i * 2;
    indices.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
  }
  // caps
  for (const side of [1, -1]) {
    const center = positions.length / 3;
    positions.push(0, half * side, 0);
    normals.push(0, side, 0);
    const ring = positions.length / 3;
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(radius * Math.cos(a), half * side, radius * Math.sin(a));
      normals.push(0, side, 0);
    }
    for (let i = 0; i < segments; i += 1) {
      if (side === 1) {
        indices.push(center, ring + i + 1, ring + i);
      } else {
        indices.push(center, ring + i, ring + i + 1);
      }
    }
  }
  return { positions, normals, indices };
}

function mergeGeometries(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const { geometry, offset } of parts) {
    const base = positions.length / 3;
    for (let i = 0; i < geometry.positions.length; i += 3) {
      positions.push(
        geometry.positions[i] + offset[0],
        geometry.positions[i + 1] + offset[1],
        geometry.positions[i + 2] + offset[2]
      );
    }
    normals.push(...geometry.normals);
    indices.push(...geometry.indices.map((index) => index + base));
  }
  return { positions, normals, indices };
}

function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

const rotX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const rotZ = (a) => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

// ---------------------------------------------------------------------------
// Kit layout: playable pieces + hardware
// ---------------------------------------------------------------------------

const MATERIALS = [
  { name: "ShellRed", pbrMetallicRoughness: { baseColorFactor: [0.55, 0.06, 0.09, 1], metallicFactor: 0.2, roughnessFactor: 0.35 } },
  { name: "SnareSteel", pbrMetallicRoughness: { baseColorFactor: [0.75, 0.76, 0.78, 1], metallicFactor: 0.9, roughnessFactor: 0.35 } },
  { name: "CymbalBronze", pbrMetallicRoughness: { baseColorFactor: [0.87, 0.68, 0.28, 1], metallicFactor: 1.0, roughnessFactor: 0.3 } },
  { name: "Chrome", pbrMetallicRoughness: { baseColorFactor: [0.6, 0.6, 0.62, 1], metallicFactor: 1.0, roughnessFactor: 0.25 } }
];
const MAT = { shell: 0, snare: 1, cymbal: 2, chrome: 3 };

// voice key, geometry, material, transform, source gain, reverb send
const PIECES = [
  {
    name: "Kick", voice: "kick", material: MAT.shell, gain: 1.0, reverbLevel: 0.35,
    geometry: cylinder(0.32, 0.42, 40),
    translation: [0, 0.34, 0.1], rotation: rotX(Math.PI / 2)
  },
  {
    name: "Snare", voice: "snare", material: MAT.snare, gain: 0.9, reverbLevel: 0.55,
    geometry: cylinder(0.18, 0.14, 36),
    translation: [-0.34, 0.62, 0.42]
  },
  {
    name: "TomHigh", voice: "tomHigh", material: MAT.shell, gain: 0.85, reverbLevel: 0.5,
    geometry: cylinder(0.14, 0.16, 32),
    translation: [-0.17, 0.85, 0.14], rotation: rotX(0.28)
  },
  {
    name: "TomMid", voice: "tomMid", material: MAT.shell, gain: 0.85, reverbLevel: 0.5,
    geometry: cylinder(0.16, 0.18, 32),
    translation: [0.18, 0.85, 0.13], rotation: rotX(0.28)
  },
  {
    name: "TomFloor", voice: "tomFloor", material: MAT.shell, gain: 0.9, reverbLevel: 0.5,
    geometry: cylinder(0.2, 0.32, 36),
    translation: [0.56, 0.45, 0.4]
  },
  {
    name: "HiHat", voice: "hihat", material: MAT.cymbal, gain: 0.7, reverbLevel: 0.5,
    geometry: mergeGeometries([
      { geometry: cylinder(0.17, 0.012, 40), offset: [0, 0, 0] },
      { geometry: cylinder(0.17, 0.012, 40), offset: [0, -0.035, 0] }
    ]),
    translation: [-0.68, 0.85, 0.35]
  },
  {
    name: "Crash", voice: "crash", material: MAT.cymbal, gain: 0.8, reverbLevel: 0.8,
    geometry: cylinder(0.25, 0.01, 44),
    translation: [-0.5, 1.18, -0.02], rotation: quatMul(rotZ(0.18), rotX(-0.2))
  },
  {
    name: "Ride", voice: "ride", material: MAT.cymbal, gain: 0.75, reverbLevel: 0.7,
    geometry: cylinder(0.28, 0.012, 44),
    translation: [0.58, 1.12, -0.05], rotation: quatMul(rotZ(-0.15), rotX(-0.18))
  }
];

const rod = (height) => cylinder(0.014, height, 10);
const HARDWARE = mergeGeometries([
  { geometry: rod(0.62), offset: [-0.34, 0.28, 0.42] },   // snare stand
  { geometry: rod(0.85), offset: [-0.68, 0.42, 0.35] },   // hi-hat stand
  { geometry: rod(1.18), offset: [-0.5, 0.59, -0.02] },   // crash stand
  { geometry: rod(1.12), offset: [0.58, 0.56, -0.05] },   // ride stand
  { geometry: rod(0.3), offset: [0.44, 0.14, 0.3] },      // floor tom legs
  { geometry: rod(0.3), offset: [0.68, 0.14, 0.3] },
  { geometry: rod(0.3), offset: [0.56, 0.14, 0.52] }
]);

// ---------------------------------------------------------------------------
// Pack geometry into one buffer
// ---------------------------------------------------------------------------

const binChunks = [];
const bufferViews = [];
const accessors = [];
let binOffset = 0;

function align4(buffer) {
  const pad = (4 - (buffer.length % 4)) % 4;
  return pad ? Buffer.concat([buffer, Buffer.alloc(pad)]) : buffer;
}

function addGeometry(geometry) {
  const posBuf = align4(Buffer.from(new Float32Array(geometry.positions).buffer));
  const nrmBuf = align4(Buffer.from(new Float32Array(geometry.normals).buffer));
  const idx32 = geometry.positions.length / 3 > 65535;
  const idxBuf = align4(Buffer.from(idx32
    ? new Uint32Array(geometry.indices).buffer
    : new Uint16Array(geometry.indices).buffer));

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < geometry.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], geometry.positions[i + axis]);
      max[axis] = Math.max(max[axis], geometry.positions[i + axis]);
    }
  }

  const entries = [
    { buf: posBuf, target: 34962, accessor: { componentType: 5126, count: geometry.positions.length / 3, type: "VEC3", min, max } },
    { buf: nrmBuf, target: 34962, accessor: { componentType: 5126, count: geometry.normals.length / 3, type: "VEC3" } },
    { buf: idxBuf, target: 34963, accessor: { componentType: idx32 ? 5125 : 5123, count: geometry.indices.length, type: "SCALAR" } }
  ];
  const ids = [];
  for (const entry of entries) {
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: entry.buf.length, target: entry.target });
    binChunks.push(entry.buf);
    binOffset += entry.buf.length;
    accessors.push({ bufferView: bufferViews.length - 1, ...entry.accessor });
    ids.push(accessors.length - 1);
  }
  return { position: ids[0], normal: ids[1], indices: ids[2] };
}

const meshes = [];
const nodes = [];

PIECES.forEach((piece) => {
  const acc = addGeometry(piece.geometry);
  meshes.push({
    name: `${piece.name}Mesh`,
    primitives: [{ attributes: { POSITION: acc.position, NORMAL: acc.normal }, indices: acc.indices, material: piece.material, mode: 4 }]
  });
  const node = {
    name: piece.name,
    mesh: meshes.length - 1,
    translation: piece.translation,
    extensions: { KHR_audio_emitter: { emitters: [nodes.length] } }
  };
  if (piece.rotation) {
    node.rotation = piece.rotation;
  }
  nodes.push(node);
});

const hardwareAcc = addGeometry(HARDWARE);
meshes.push({
  name: "HardwareMesh",
  primitives: [{ attributes: { POSITION: hardwareAcc.position, NORMAL: hardwareAcc.normal }, indices: hardwareAcc.indices, material: MAT.chrome, mode: 4 }]
});
nodes.push({
  name: "Hardware",
  mesh: meshes.length - 1,
  extensions: { KHR_node_selectability: { selectable: false } }
});

const cameraNodeIndex = nodes.length;
nodes.push({
  name: "ListenerCamera",
  camera: 0,
  translation: [0, 1.35, 2.4],
  extensions: { KHR_audio_environment: { listener: 0 } }
});

const bin = Buffer.concat(binChunks);
fs.writeFileSync(path.join(outDir, "drum-kit.bin"), bin);

// ---------------------------------------------------------------------------
// Audio + interactivity extensions
// ---------------------------------------------------------------------------

Object.entries(VOICES).forEach(([name, samples]) => encodeMp3(`${name}.mp3`, samples));

const voiceNames = Object.keys(VOICES);
const audio = voiceNames.map((name) => ({ uri: `${name}.mp3`, mimeType: "audio/mpeg" }));
const sources = PIECES.map((piece) => ({
  name: piece.voice,
  audio: voiceNames.indexOf(piece.voice),
  gain: piece.gain
}));
const emitters = PIECES.map((piece) => ({
  name: `${piece.name}Emitter`,
  type: "positional",
  gain: 1.0,
  sources: [sources.findIndex((source) => source.name === piece.voice)],
  positional: {
    shapeType: "omnidirectional",
    distanceModel: "inverse",
    refDistance: 0.6,
    maxDistance: 30.0,
    rolloffFactor: 1.0,
    extensions: {
      KHR_audio_environment: {
        airAbsorption: { enabled: true, cutoffAtMaxDistance: 7000.0 }
      }
    }
  },
  extensions: {
    KHR_audio_environment: { directLevel: 1.0, reverbLevel: piece.reverbLevel }
  }
}));

const declarations = [{ op: "event/onSelect" }, { op: "pointer/set" }];
const graphNodes = [];
PIECES.forEach((piece, index) => {
  const triggerId = graphNodes.length + 1;
  graphNodes.push({
    declaration: 0,
    configuration: { nodeIndex: { value: [index] }, stopPropagation: { value: [true] } },
    flows: { out: { node: triggerId, socket: "in" } }
  });
  graphNodes.push({
    declaration: 1,
    configuration: {
      pointer: { value: [`/extensions/KHR_audio_emitter/sources/${index}/playing`] },
      type: { value: [0] }
    },
    values: { value: { value: [1], type: 0 } }
  });
});

// KHR_audio_graph: processing chains for three of the drums. Their emitters
// are bound via outputs[] (rule 12: the emitters' own sources[] are ignored;
// the graph supplies the signal). The other five drums stay direct-fed.
const pieceIndex = (name) => PIECES.findIndex((p) => p.name === name);
const audioGraph = {
  graphs: [{
    name: "drum-processing",
    nodes: [
      { kind: "lowpass", params: { frequency: 3200, qualityFactor: 0.7 }, label: "kickWarmth" },
      { kind: "gain", params: { gain: 1.15 }, label: "kickMakeup" },
      { kind: "peaking", params: { frequency: 1800, qualityFactor: 1.0, gain: 3.0 }, label: "snareCrack" },
      { kind: "highshelf", params: { frequency: 6000, gain: 2.5 }, label: "crashAir" }
    ],
    connections: [
      { from: { node: 0 }, to: { node: 1 } }
    ],
    inputs: [
      { source: pieceIndex("Kick"), node: 0 },
      { source: pieceIndex("Snare"), node: 2 },
      { source: pieceIndex("Crash"), node: 3 }
    ],
    outputs: [
      { node: 1, emitter: pieceIndex("Kick") },
      { node: 2, emitter: pieceIndex("Snare") },
      { node: 3, emitter: pieceIndex("Crash") }
    ]
  }]
};

const gltf = {
  asset: {
    version: "2.0",
    generator: "make-drum-kit.mjs",
    copyright: "CC0 — procedurally generated demo asset for the glTF layered audio proposals"
  },
  extensionsUsed: ["KHR_audio_emitter", "KHR_audio_graph", "KHR_audio_environment", "KHR_interactivity", "KHR_node_selectability"],
  extensions: {
    KHR_audio_emitter: { audio, sources, emitters },
    KHR_audio_graph: audioGraph,
    KHR_audio_environment: {
      listeners: [{ name: "Player", gain: 1.0, spatializationModel: "HRTF" }],
      environments: [{ name: "Studio", reverb: { preset: "smallRoom", mix: 0.28 } }]
    },
    KHR_interactivity: {
      graph: 0,
      graphs: [{
        types: [{ signature: "float" }],
        declarations,
        nodes: graphNodes,
        variables: []
      }]
    }
  },
  scene: 0,
  scenes: [{
    name: "DrumKit",
    nodes: nodes.map((_, index) => index),
    extensions: { KHR_audio_environment: { environment: 0, activeListener: 0 } }
  }],
  nodes,
  cameras: [{ type: "perspective", perspective: { yfov: 0.75, znear: 0.05, zfar: 100 } }],
  meshes,
  materials: MATERIALS,
  buffers: [{ uri: "drum-kit.bin", byteLength: bin.length }],
  bufferViews,
  accessors
};

fs.writeFileSync(path.join(outDir, "drum-kit.gltf"), JSON.stringify(gltf, null, 2));
console.log(`wrote drum-kit.gltf: ${PIECES.length} playable pieces, ${audioGraph.graphs[0].nodes.length} audio-graph nodes, ${graphNodes.length} interactivity nodes, bin ${(bin.length / 1024).toFixed(1)} KiB`);
console.log(`camera/listener node: ${cameraNodeIndex}`);
console.log("Open: viewer.html?model=/examples/drum-kit/drum-kit.gltf — enable Audio, click the drums.");
