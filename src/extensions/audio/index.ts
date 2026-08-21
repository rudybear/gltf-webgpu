// KHR_audio_emitter + KHR_audio_graph + KHR_audio_environment support for the
// WebGPU viewer, realized with the Web Audio API: emitters map to PannerNode
// chains; document-level audio graphs (16 node kinds) process source signals
// before emission per the graph spec's inputs[]/outputs[] bindings (rule 12:
// a graph-bound emitter ignores its own sources[]); the environment layer adds
// a listener bus, preset/parametric reverb with zone crossfades, per-emitter
// direct/reverb sends, doppler, and distance/cone low-pass filtering.

import { mat4Invert, vec3TransformMat4, type Vec3 } from "../../renderer/math";
import {
  combineCutoffs,
  computeAirAbsorptionCutoff,
  computeConeCutoff,
  computeDopplerPitch,
  quatRotate,
  resolveReverbParams,
  sampleDistanceCurve,
  selectEnvironment,
  type DopplerProperties,
  type ReverbProperties,
  type ZoneBinding
} from "./spatial";

export type AudioUriResolver = (uri: string) => Promise<ArrayBuffer>;

export interface AudioSystemOptions {
  resolveUri: AudioUriResolver;
  getBufferView?: (bufferViewIndex: number) => ArrayBuffer | undefined;
}

interface AudioDataDef {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}

interface OscillatorData {
  type?: string;
  frequency?: number;
  detune?: number;
  pulseWidth?: number;
  periodicWave?: { real: number[]; imag: number[] };
}

interface SourceDef {
  audio?: number;
  gain?: number;
  autoplay?: boolean;
  loop?: boolean;
  playbackRate?: number;
  extensions?: {
    KHR_audio_graph?: {
      oscillator?: OscillatorData;
      when?: number;
      duration?: number;
    };
  };
}

interface PositionalDef {
  shapeType?: string;
  distanceModel?: string;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  coneInnerAngle?: number;
  coneOuterAngle?: number;
  coneOuterGain?: number;
  extensions?: {
    KHR_audio_environment?: {
      spatializationModel?: string;
      distanceCurve?: number[];
      airAbsorption?: { enabled?: boolean; cutoffAtMaxDistance?: number };
      coneOuterCutoff?: number;
      dopplerEnabled?: boolean;
    };
  };
}

interface EmitterDef {
  type: string;
  gain?: number;
  sources?: number[];
  positional?: PositionalDef;
  name?: string;
  extensions?: {
    KHR_audio_environment?: { directLevel?: number; reverbLevel?: number; environment?: number };
  };
}

interface ListenerDef {
  name?: string;
  gain?: number;
  spatializationModel?: string;
  interauralDistance?: number;
}

interface EnvironmentDef {
  name?: string;
  reverb?: ReverbProperties;
  doppler?: DopplerProperties;
}

interface GraphNodeDef {
  kind: string;
  params?: Record<string, unknown>;
  label?: string;
  bypass?: boolean;
}

interface GraphDef {
  name?: string;
  nodes: GraphNodeDef[];
  connections?: Array<{ from: { node: number; output?: number }; to: { node: number; input?: number } }>;
  inputs?: Array<{ source: number; node: number; input?: number }>;
  outputs?: Array<{ node: number; output?: number; emitter: number }>;
}

/** Attachment point where a KHR source's signal enters a graph. */
interface GraphSourceAttachment {
  node: AudioNode;
  input: number;
}

interface EmitterInstance {
  emitterIndex: number;
  nodeIndex: number | null; // null = scene-level global emitter
  def: EmitterDef;
  /** Rule 12: emitter is fed by a graph output; its own sources[] are ignored. */
  graphFed: boolean;
  input: GainNode;
  panner: PannerNode | null;
  filter: BiquadFilterNode | null;
  distanceGain: GainNode | null;
  directGain: GainNode;
  sendGain: GainNode;
  sources: Array<{ sourceIndex: number; node: AudioBufferSourceNode; gain: GainNode; basePlaybackRate: number }>;
  previousPosition: Vec3 | null;
}

interface EnvironmentBus {
  environmentIndex: number;
  def: EnvironmentDef;
  input: GainNode;
  gate: GainNode; // zone-weight tap from the shared send bus
  returnGain: GainNode; // reverb.mix
}

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Synthesize a stereo impulse response from the resolved parametric reverb
 * values: sparse early-reflection taps after reflectionsDelay, then an
 * exponentially decaying noise tail (RT60 = decayTime) low-passed per
 * decayHFRatio. ConvolverNode's default equal-power normalization keeps the
 * output level consistent across presets.
 */
function generateReverbImpulse(
  context: BaseAudioContext,
  params: {
    decayTime: number;
    decayHFRatio: number;
    reflectionsGain: number;
    reflectionsDelay: number;
    reverbGain: number;
    reverbDelay: number;
    diffusion: number;
    density: number;
  }
): AudioBuffer {
  const rate = context.sampleRate;
  const tailStart = params.reflectionsDelay + params.reverbDelay;
  const length = Math.max(rate * 0.05, Math.floor(rate * (tailStart + params.decayTime)));
  const buffer = context.createBuffer(2, length, rate);
  const decayRate = 6.908 / Math.max(params.decayTime, 0.05); // -60 dB over decayTime
  const cutoff = Math.min(Math.max(20000 * params.decayHFRatio, 200), rate * 0.45);
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / rate);
  // density thins the tail's sample occupancy; diffusion smooths tap polarity.
  const occupancy = 0.3 + 0.7 * params.density;

  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    // Early reflections: a handful of decaying taps, decorrelated per channel.
    const tapCount = 6;
    for (let k = 0; k < tapCount; k += 1) {
      const at = Math.floor(rate * (params.reflectionsDelay + k * 0.0063 * (1 + channel * 0.17)));
      if (at < length) {
        const polarity = (k + channel) % 2 === 0 ? 1 : -1;
        data[at] += polarity * params.reflectionsGain * 0.7 * (1 - k / tapCount);
      }
    }
    // Late tail: low-passed decaying noise.
    let lowpassState = 0;
    const start = Math.floor(rate * tailStart);
    for (let i = start; i < length; i += 1) {
      const t = (i - start) / rate;
      if (Math.random() > occupancy) {
        continue;
      }
      const white = Math.random() * 2 - 1;
      lowpassState += alpha * (white - lowpassState);
      data[i] += lowpassState * Math.exp(-t * decayRate) * params.reverbGain;
    }
  }
  return buffer;
}

function matrixPosition(matrix: Float32Array): Vec3 {
  return [matrix[12], matrix[13], matrix[14]];
}

function matrixForward(matrix: Float32Array): Vec3 {
  // glTF emitters and cameras face -Z in local space.
  const x = -matrix[8];
  const y = -matrix[9];
  const z = -matrix[10];
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

export class AudioSystem {
  static hasAudio(json: { extensions?: Record<string, unknown> }): boolean {
    return Boolean(json.extensions?.KHR_audio_emitter);
  }

  private readonly json: any;
  private readonly options: AudioSystemOptions;
  private context: AudioContext | null = null;
  private listenerBus: GainNode | null = null;
  private sendBus: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private emitterInstances: EmitterInstance[] = [];
  private environmentBuses = new Map<number, EnvironmentBus>();
  private zones: ZoneBinding[] = [];
  private graphSources = new Map<number, GraphSourceAttachment[]>();
  private graphFedEmitters = new Set<number>();
  private defaultEnvironmentIndex: number | undefined;
  private listenerDef: ListenerDef | undefined;
  private previousListenerPosition: Vec3 | null = null;
  private started = false;
  private lastTrigger = "none";

  constructor(json: unknown, options: AudioSystemOptions) {
    this.json = json;
    this.options = options;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Must be called from a user gesture (autoplay policy). */
  async start(): Promise<void> {
    if (this.started) {
      await this.context?.resume();
      return;
    }
    const emitterExt = this.json.extensions?.KHR_audio_emitter;
    if (!emitterExt) {
      return;
    }
    const envExt = this.json.extensions?.KHR_audio_environment ?? {};
    this.context = new AudioContext();
    const context = this.context;

    // Listener: spec 1.3 — a declared listener supplies gain/model; the viewer
    // camera supplies the pose (it is the active camera of rule 2/4).
    this.listenerDef = this.selectListener(envExt.listeners as ListenerDef[] | undefined);
    this.listenerBus = context.createGain();
    this.listenerBus.gain.value = this.listenerDef?.gain ?? 1.0;
    this.listenerBus.connect(context.destination);

    // Environments: shared send bus tapped per environment by a zone-weight gate.
    this.sendBus = context.createGain();
    const environments = (envExt.environments ?? []) as EnvironmentDef[];
    for (let i = 0; i < environments.length; i += 1) {
      this.environmentBuses.set(i, await this.buildEnvironmentBus(i, environments[i]));
    }
    this.collectZonesAndDefault();

    await this.decodeAudioData(emitterExt.audio ?? []);

    // KHR_audio_graph: emitters bound via a graph's outputs[] ignore their own
    // sources[] (rule 12) — mark them before building emitter chains.
    const graphs = (this.json.extensions?.KHR_audio_graph?.graphs ?? []) as GraphDef[];
    for (const graph of graphs) {
      for (const output of graph.outputs ?? []) {
        this.graphFedEmitters.add(output.emitter);
      }
    }

    this.buildEmitterInstances(emitterExt);
    let graphNodeCount = 0;
    for (const graph of graphs) {
      graphNodeCount += this.buildGraph(graph, emitterExt.sources ?? []);
    }
    this.started = true;
    console.info(
      `KHR_audio: started — context=${context.state}, sampleRate=${context.sampleRate}, ` +
      `buffers=${this.buffers.size}/${(emitterExt.audio ?? []).length}, ` +
      `emitters=${this.emitterInstances.length}, graphs=${graphs.length} (${graphNodeCount} nodes), ` +
      `environments=${this.environmentBuses.size}, zones=${this.zones.length}`
    );
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch {
        // fall through to input-driven resume
      }
    }
    if ((context.state as string) !== "running") {
      console.warn(
        `KHR_audio: AudioContext is "${context.state}" — will retry on the next click/keypress. ` +
        `Firefox: allow autoplay for this site (address-bar permissions icon -> Autoplay -> Allow Audio and Video).`
      );
      const resumeOnInput = () => {
        void context.resume().then(() => {
          if ((context.state as string) === "running") {
            console.info("KHR_audio: AudioContext resumed");
            window.removeEventListener("pointerdown", resumeOnInput);
            window.removeEventListener("keydown", resumeOnInput);
          }
        });
      };
      window.addEventListener("pointerdown", resumeOnInput);
      window.addEventListener("keydown", resumeOnInput);
    }
    // Audible confirmation blip through the listener bus: if you hear this,
    // the output path works and any remaining silence is asset/trigger-side.
    const blip = context.createOscillator();
    blip.frequency.value = 880;
    const blipGain = context.createGain();
    blipGain.gain.value = 0.08;
    blipGain.gain.setTargetAtTime(0, context.currentTime + 0.06, 0.02);
    blip.connect(blipGain);
    blipGain.connect(this.listenerBus!);
    blip.start();
    blip.stop(context.currentTime + 0.25);
  }

  getDiagnostics(): string {
    if (!this.started || !this.context) {
      return "audio idle";
    }
    return `audio ${this.context.state}, ${this.buffers.size} buffers, ${this.emitterInstances.length} emitters, last trigger: ${this.lastTrigger}`;
  }

  dispose(): void {
    for (const instance of this.emitterInstances) {
      for (const source of instance.sources) {
        try {
          source.node.stop();
        } catch {
          // never started
        }
      }
    }
    this.emitterInstances = [];
    this.environmentBuses.clear();
    this.graphSources.clear();
    this.graphFedEmitters.clear();
    this.buffers.clear();
    void this.context?.close();
    this.context = null;
    this.started = false;
  }

  /**
   * Per-frame update: listener pose from the viewer camera, emitter poses from
   * node world matrices, zone crossfade, doppler, air-absorption/cone filters.
   */
  update(
    deltaSeconds: number,
    cameraEye: Vec3,
    cameraRotation: [number, number, number, number],
    nodes: Array<{ worldMatrix: Float32Array }>
  ): void {
    if (!this.started || !this.context) {
      return;
    }
    const context = this.context;
    const dt = Math.max(deltaSeconds, 1e-4);

    // Listener pose.
    const forward = quatRotate([0, 0, -1], cameraRotation);
    const up = quatRotate([0, 1, 0], cameraRotation);
    const listener = context.listener;
    if ("positionX" in listener) {
      listener.positionX.value = cameraEye[0];
      listener.positionY.value = cameraEye[1];
      listener.positionZ.value = cameraEye[2];
      listener.forwardX.value = forward[0];
      listener.forwardY.value = forward[1];
      listener.forwardZ.value = forward[2];
      listener.upX.value = up[0];
      listener.upY.value = up[1];
      listener.upZ.value = up[2];
    }
    const listenerVelocity: Vec3 = this.previousListenerPosition
      ? [
          (cameraEye[0] - this.previousListenerPosition[0]) / dt,
          (cameraEye[1] - this.previousListenerPosition[1]) / dt,
          (cameraEye[2] - this.previousListenerPosition[2]) / dt
        ]
      : [0, 0, 0];
    this.previousListenerPosition = [...cameraEye];

    // Zone selection follows the listener (spec 2.3).
    const selection = selectEnvironment(this.zones, this.defaultEnvironmentIndex, cameraEye, (zone, world) => {
      const node = nodes[zone.nodeIndex];
      if (!node) {
        return world;
      }
      const inverse = mat4Invert(node.worldMatrix);
      return inverse ? vec3TransformMat4(inverse, world) : world;
    });
    const activeDoppler = typeof selection.environmentIndex === "number"
      ? this.environmentBuses.get(selection.environmentIndex)?.def.doppler
      : undefined;
    for (const [index, bus] of this.environmentBuses) {
      let weight = 0;
      if (index === selection.environmentIndex) {
        weight = 1 - selection.blendToOutside;
      }
      if (index === selection.outsideEnvironmentIndex && selection.blendToOutside > 0) {
        weight = Math.max(weight, selection.blendToOutside);
      }
      bus.gate.gain.setTargetAtTime(weight, context.currentTime, 0.05);
    }

    // Emitter poses, doppler, filtering.
    for (const instance of this.emitterInstances) {
      if (instance.nodeIndex === null) {
        continue; // scene-level global emitter: nothing positional to update
      }
      const node = nodes[instance.nodeIndex];
      if (!node) {
        continue;
      }
      const position = matrixPosition(node.worldMatrix);
      const forwardDir = matrixForward(node.worldMatrix);
      if (instance.panner && "positionX" in instance.panner) {
        instance.panner.positionX.value = position[0];
        instance.panner.positionY.value = position[1];
        instance.panner.positionZ.value = position[2];
        instance.panner.orientationX.value = forwardDir[0];
        instance.panner.orientationY.value = forwardDir[1];
        instance.panner.orientationZ.value = forwardDir[2];
      }

      const positional = instance.def.positional;
      const envProps = positional?.extensions?.KHR_audio_environment;
      const dx = cameraEye[0] - position[0];
      const dy = cameraEye[1] - position[1];
      const dz = cameraEye[2] - position[2];
      const distance = Math.hypot(dx, dy, dz);

      // Custom distance curve (spec 3.3).
      if (instance.distanceGain && envProps?.distanceCurve && positional) {
        const gain = sampleDistanceCurve(
          envProps.distanceCurve,
          positional.refDistance ?? 1,
          positional.maxDistance ?? 0,
          distance
        );
        instance.distanceGain.gain.setTargetAtTime(gain, context.currentTime, 0.03);
      }

      // Air absorption + cone low-pass (spec 3.4).
      if (instance.filter && positional) {
        let cutoff = 20000;
        const air = envProps?.airAbsorption;
        if (air?.enabled) {
          cutoff = combineCutoffs(
            cutoff,
            computeAirAbsorptionCutoff(
              positional.refDistance ?? 1,
              positional.maxDistance ?? 0,
              air.cutoffAtMaxDistance ?? 5000,
              distance
            )
          );
        }
        if (typeof envProps?.coneOuterCutoff === "number" && positional.shapeType === "cone" && distance > 0) {
          const toListener: Vec3 = [dx / distance, dy / distance, dz / distance];
          const dot = forwardDir[0] * toListener[0] + forwardDir[1] * toListener[1] + forwardDir[2] * toListener[2];
          const offAxis = Math.acos(Math.min(Math.max(dot, -1), 1));
          cutoff = combineCutoffs(
            cutoff,
            computeConeCutoff(
              positional.coneInnerAngle ?? Math.PI * 2,
              positional.coneOuterAngle ?? Math.PI * 2,
              envProps.coneOuterCutoff,
              offAxis
            )
          );
        }
        instance.filter.frequency.setTargetAtTime(cutoff, context.currentTime, 0.03);
      }

      // Doppler (spec 2.5): environment settings, per-emitter opt-out.
      const dopplerEnabled = activeDoppler?.enabled && envProps?.dopplerEnabled !== false && instance.def.type === "positional";
      const emitterVelocity: Vec3 = instance.previousPosition
        ? [
            (position[0] - instance.previousPosition[0]) / dt,
            (position[1] - instance.previousPosition[1]) / dt,
            (position[2] - instance.previousPosition[2]) / dt
          ]
        : [0, 0, 0];
      instance.previousPosition = position;
      const pitch = dopplerEnabled
        ? computeDopplerPitch(activeDoppler, cameraEye, listenerVelocity, position, emitterVelocity)
        : 1.0;
      for (const source of instance.sources) {
        source.node.playbackRate.setTargetAtTime(source.basePlaybackRate * pitch, context.currentTime, 0.05);
      }
    }
  }

  /** glTF Object Model bridge for KHR_interactivity / animation pointers. */
  applyPointer(pointer: string, value: number[]): boolean {
    if (!this.started || !this.context || value.length === 0) {
      return false;
    }
    const scalar = value[0];
    const time = this.context.currentTime;

    let match = pointer.match(/^\/extensions\/KHR_audio_emitter\/emitters\/(\d+)\/gain$/);
    if (match) {
      const index = Number(match[1]);
      for (const instance of this.emitterInstances) {
        if (instance.emitterIndex === index) {
          instance.input.gain.setTargetAtTime(scalar, time, 0.02);
        }
      }
      return true;
    }
    // One-shot trigger: `playing` is not (yet) in the base spec — this is the
    // KHR_interactivity playback prototype for feedback item E1. Setting it
    // true (re)fires the source on every emitter that references it.
    match = pointer.match(/^\/extensions\/KHR_audio_emitter\/sources\/(\d+)\/playing$/);
    if (match) {
      const fired = this.triggerSource(Number(match[1]), scalar > 0.5);
      this.lastTrigger = `source ${match[1]} (${fired} voices)`;
      console.debug(`KHR_audio: trigger source ${match[1]} -> ${fired} voice(s)`);
      return true;
    }
    match = pointer.match(/^\/extensions\/KHR_audio_emitter\/sources\/(\d+)\/(gain|playbackRate)$/);
    if (match) {
      const index = Number(match[1]);
      const property = match[2];
      for (const instance of this.emitterInstances) {
        for (const source of instance.sources) {
          if (source.sourceIndex !== index) {
            continue;
          }
          if (property === "gain") {
            source.gain.gain.setTargetAtTime(scalar, time, 0.02);
          } else {
            source.basePlaybackRate = scalar;
            source.node.playbackRate.setTargetAtTime(scalar, time, 0.02);
          }
        }
      }
      return true;
    }
    match = pointer.match(/^\/extensions\/KHR_audio_emitter\/emitters\/(\d+)\/extensions\/KHR_audio_environment\/(directLevel|reverbLevel)$/);
    if (match) {
      const index = Number(match[1]);
      const property = match[2];
      for (const instance of this.emitterInstances) {
        if (instance.emitterIndex === index) {
          const target = property === "directLevel" ? instance.directGain : instance.sendGain;
          target.gain.setTargetAtTime(scalar, time, 0.02);
        }
      }
      return true;
    }
    match = pointer.match(/^\/extensions\/KHR_audio_environment\/environments\/(\d+)\/reverb\/mix$/);
    if (match) {
      const bus = this.environmentBuses.get(Number(match[1]));
      if (bus) {
        bus.returnGain.gain.setTargetAtTime(scalar, time, 0.02);
        return true;
      }
      return false;
    }
    match = pointer.match(/^\/extensions\/KHR_audio_environment\/listeners\/(\d+)\/gain$/);
    if (match && this.listenerBus) {
      this.listenerBus.gain.setTargetAtTime(scalar, time, 0.02);
      return true;
    }
    return false;
  }

  /**
   * Instantiate one KHR_audio_graph graph: create a Web Audio node per graph
   * node, wire connections (with port indices), register inputs[] as source
   * attachment points (autoplay sources start immediately; others are fired by
   * triggerSource), and route outputs[] into the bound emitters' chains.
   * Returns the number of nodes created.
   */
  private buildGraph(graph: GraphDef, sources: SourceDef[]): number {
    const context = this.context!;
    const FILTERS = new Set(["lowpass", "highpass", "bandpass", "lowshelf", "highshelf", "peaking", "notch", "allpass"]);
    const built: AudioNode[] = [];

    for (const nodeDef of graph.nodes) {
      const params = nodeDef.params ?? {};
      let node: AudioNode;
      if (nodeDef.bypass) {
        node = context.createGain(); // pass-through realization of bypass
      } else if (FILTERS.has(nodeDef.kind)) {
        const filter = context.createBiquadFilter();
        filter.type = nodeDef.kind as BiquadFilterType;
        if (typeof params.frequency === "number") filter.frequency.value = params.frequency;
        if (typeof params.qualityFactor === "number") filter.Q.value = params.qualityFactor;
        if (typeof params.gain === "number") filter.gain.value = params.gain; // dB (shelf/peaking)
        node = filter;
      } else {
        switch (nodeDef.kind) {
          case "gain": {
            const gain = context.createGain();
            if (typeof params.gain === "number") gain.gain.value = params.gain;
            node = gain;
            break;
          }
          case "delay": {
            const delay = context.createDelay(typeof params.maxDelayTime === "number" ? params.maxDelayTime : 1.0);
            if (typeof params.delayTime === "number") delay.delayTime.value = params.delayTime;
            node = delay;
            break;
          }
          case "waveshaper": {
            const shaper = context.createWaveShaper();
            if (Array.isArray(params.curve)) {
              shaper.curve = new Float32Array(params.curve as number[]);
            } else if (typeof params.amount === "number") {
              // amount -> curve mapping (informative in the spec): tanh drive
              const n = 1024;
              const curve = new Float32Array(n);
              const drive = 1 + params.amount * 20;
              for (let i = 0; i < n; i += 1) {
                const x = (i / (n - 1)) * 2 - 1;
                curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
              }
              shaper.curve = curve;
            }
            if (params.oversample === "2x" || params.oversample === "4x") {
              shaper.oversample = params.oversample;
            }
            node = shaper;
            break;
          }
          case "oscillator": {
            console.warn('KHR_audio_graph: "oscillator" is not a graph node kind (r2); declare it as source data via source.extensions.KHR_audio_graph.oscillator');
            const osc = context.createOscillator();
            const type = params.type as string;
            if (type === "sine" || type === "square" || type === "triangle" || type === "sawtooth") {
              osc.type = type;
            }
            if (typeof params.frequency === "number") osc.frequency.value = params.frequency;
            if (typeof params.detune === "number") osc.detune.value = params.detune;
            osc.start();
            node = osc;
            break;
          }
          case "splitter": {
            let maxPort = 0;
            const index = built.length;
            for (const c of graph.connections ?? []) {
              if (c.from.node === index) maxPort = Math.max(maxPort, c.from.output ?? 0);
            }
            node = context.createChannelSplitter(maxPort + 1); // rule 9 (r2): connection-derived
            break;
          }
          case "channelmerger": {
            let maxPort = 0;
            const index = built.length;
            for (const c of graph.connections ?? []) {
              if (c.to.node === index) maxPort = Math.max(maxPort, c.to.input ?? 0);
            }
            for (const inp of graph.inputs ?? []) {
              if (inp.node === index) maxPort = Math.max(maxPort, inp.input ?? 0);
            }
            node = context.createChannelMerger(maxPort + 1); // rule 10 (r2): connection-derived
            break;
          }
          case "channelmixer": {
            const mixer = context.createGain();
            if (typeof params.outputChannels === "number") {
              mixer.channelCount = params.outputChannels;
              mixer.channelCountMode = "explicit";
            }
            if (params.channelInterpretation === "discrete" || params.channelInterpretation === "speakers") {
              mixer.channelInterpretation = params.channelInterpretation;
            }
            node = mixer;
            break;
          }
          case "audiomixer":
          default: {
            if (nodeDef.kind !== "audiomixer") {
              console.warn(`KHR_audio_graph: unknown node kind "${nodeDef.kind}" — treating as pass-through gain`);
            }
            node = context.createGain();
            break;
          }
        }
      }
      built.push(node);
    }

    for (const connection of graph.connections ?? []) {
      const from = built[connection.from.node];
      const to = built[connection.to.node];
      if (from && to) {
        from.connect(to, connection.from.output ?? 0, connection.to.input ?? 0);
      }
    }

    for (const input of graph.inputs ?? []) {
      const target = built[input.node];
      const source = sources[input.source];
      if (!target || !source) {
        continue;
      }
      const attachment: GraphSourceAttachment = { node: target, input: input.input ?? 0 };
      const existing = this.graphSources.get(input.source) ?? [];
      existing.push(attachment);
      this.graphSources.set(input.source, existing);
      if (source.autoplay && typeof source.audio === "number") {
        this.startPlayerInto(source, attachment);
      }
    }

    for (const output of graph.outputs ?? []) {
      const from = built[output.node];
      for (const instance of this.emitterInstances) {
        if (instance.emitterIndex === output.emitter && from) {
          from.connect(instance.input, output.output ?? 0, 0);
        }
      }
    }
    return built.length;
  }

  /** Start a player (buffer clip or oscillator source) into a graph attachment point. */
  private startPlayerInto(source: SourceDef, attachment: GraphSourceAttachment): AudioScheduledSourceNode | null {
    const context = this.context!;
    const ext = source.extensions?.KHR_audio_graph;

    // Oscillator source (r2): waveform data on the source, uniform scheduling.
    if (ext?.oscillator && typeof source.audio !== "number") {
      const osc = context.createOscillator();
      const data = ext.oscillator;
      if (data.type === "sine" || data.type === "square" || data.type === "triangle" || data.type === "sawtooth") {
        osc.type = data.type;
      }
      if (typeof data.frequency === "number") osc.frequency.value = data.frequency;
      if (typeof data.detune === "number") osc.detune.value = data.detune;
      if (data.periodicWave?.real && data.periodicWave.imag) {
        try {
          osc.setPeriodicWave(context.createPeriodicWave(
            new Float32Array(data.periodicWave.real),
            new Float32Array(data.periodicWave.imag)
          ));
        } catch {
          // backend without PeriodicWave support
        }
      }
      const gain = context.createGain();
      gain.gain.value = source.gain ?? 1.0;
      osc.connect(gain);
      gain.connect(attachment.node, 0, attachment.input);
      const when = context.currentTime + Math.max(0, ext.when ?? 0);
      osc.start(when);
      if (typeof ext.duration === "number") {
        osc.stop(when + ext.duration);
      }
      osc.onended = () => gain.disconnect();
      return osc;
    }

    const buffer = typeof source.audio === "number" ? this.buffers.get(source.audio) : undefined;
    if (!buffer) {
      return null;
    }
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = source.loop ?? false;
    node.playbackRate.value = source.playbackRate ?? 1.0;
    const gain = context.createGain();
    gain.gain.value = source.gain ?? 1.0;
    node.connect(gain);
    gain.connect(attachment.node, 0, attachment.input);
    node.start();
    node.onended = () => gain.disconnect();
    return node;
  }

  /** (Re)fire or stop every instance of a source — one-shot drum-pad semantics. */
  private triggerSource(sourceIndex: number, play: boolean): number {
    const context = this.context!;
    let fired = 0;
    const sources = (this.json.extensions?.KHR_audio_emitter?.sources ?? []) as SourceDef[];
    const def = sources[sourceIndex];
    if (!def || typeof def.audio !== "number") {
      console.warn(`KHR_audio: trigger for unknown source ${sourceIndex}`);
      return fired;
    }
    const buffer = this.buffers.get(def.audio);
    if (play && !buffer) {
      console.warn(`KHR_audio: source ${sourceIndex} has no decoded buffer (audio[${def.audio}])`);
    }
    // Graph-bound sources: fire a player into each registered attachment point.
    for (const attachment of this.graphSources.get(sourceIndex) ?? []) {
      if (play && this.startPlayerInto(def, attachment)) {
        fired += 1;
      }
    }
    for (const instance of this.emitterInstances) {
      if (instance.graphFed || !(instance.def.sources ?? []).includes(sourceIndex)) {
        continue; // rule 12: graph-fed emitters ignore their own sources[]
      }
      // Oscillator source (r2): fire a fresh scheduled oscillator (phase resets).
      if (def.extensions?.KHR_audio_graph?.oscillator && typeof def.audio !== "number") {
        if (play && this.startPlayerInto(def, { node: instance.input, input: 0 })) {
          fired += 1;
        }
        continue;
      }
      for (let i = instance.sources.length - 1; i >= 0; i -= 1) {
        const existing = instance.sources[i];
        if (existing.sourceIndex !== sourceIndex) {
          continue;
        }
        if (!play) {
          try {
            existing.node.stop();
          } catch {
            // never started
          }
        }
      }
      if (play && buffer) {
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.loop = def.loop ?? false;
        const basePlaybackRate = def.playbackRate ?? 1.0;
        node.playbackRate.value = basePlaybackRate;
        const gain = context.createGain();
        gain.gain.value = def.gain ?? 1.0;
        node.connect(gain);
        gain.connect(instance.input);
        node.start();
        fired += 1;
        instance.sources.push({ sourceIndex, node, gain, basePlaybackRate });
        node.onended = () => {
          const at = instance.sources.findIndex((s) => s.node === node);
          if (at >= 0) {
            instance.sources.splice(at, 1);
          }
          gain.disconnect();
        };
      }
    }
    return fired;
  }

  // -------------------------------------------------------------------------

  private selectListener(listeners: ListenerDef[] | undefined): ListenerDef | undefined {
    if (!listeners || listeners.length === 0) {
      return undefined;
    }
    const scenes = this.json.scenes ?? [];
    const sceneIndex = this.json.scene ?? 0;
    const pinned = scenes[sceneIndex]?.extensions?.KHR_audio_environment?.activeListener;
    if (typeof pinned === "number" && listeners[pinned]) {
      return listeners[pinned];
    }
    const nodes = this.json.nodes ?? [];
    let firstBinding: ListenerDef | undefined;
    for (const node of nodes) {
      const index = node.extensions?.KHR_audio_environment?.listener;
      if (typeof index !== "number" || !listeners[index]) {
        continue;
      }
      if (typeof node.camera === "number") {
        return listeners[index]; // rule 2: camera binding wins
      }
      firstBinding = firstBinding ?? listeners[index];
    }
    return firstBinding ?? listeners[0];
  }

  private collectZonesAndDefault(): void {
    const scenes = this.json.scenes ?? [];
    const sceneIndex = this.json.scene ?? 0;
    const sceneEnv = scenes[sceneIndex]?.extensions?.KHR_audio_environment?.environment;
    this.defaultEnvironmentIndex = typeof sceneEnv === "number" ? sceneEnv : undefined;

    const nodes = this.json.nodes ?? [];
    for (let i = 0; i < nodes.length; i += 1) {
      const binding = nodes[i].extensions?.KHR_audio_environment;
      if (!binding || typeof binding.environment !== "number" || !binding.shape) {
        continue;
      }
      this.zones.push({
        nodeIndex: i,
        environmentIndex: binding.environment,
        shape: binding.shape,
        blendDistance: binding.blendDistance ?? 0,
        priority: binding.priority ?? 0
      });
    }
  }

  private async buildEnvironmentBus(index: number, def: EnvironmentDef): Promise<EnvironmentBus> {
    const context = this.context!;
    const params = resolveReverbParams(def.reverb);
    const input = context.createGain();
    const gate = context.createGain();
    gate.gain.value = 0;
    this.sendBus!.connect(gate);
    gate.connect(input);
    const returnGain = context.createGain();
    returnGain.gain.value = params.mix;
    returnGain.connect(this.listenerBus!);

    if (def.reverb?.type === "impulseResponse" && typeof def.reverb.audio === "number") {
      const convolver = context.createConvolver();
      if (typeof def.reverb.normalize === "boolean") {
        convolver.normalize = def.reverb.normalize;
      }
      const buffer = await this.decodeSingle(def.reverb.audio);
      if (buffer) {
        convolver.buffer = buffer;
      }
      input.connect(convolver);
      convolver.connect(returnGain);
      return { environmentIndex: index, def, input, gate, returnGain };
    }

    // Parametric reverb realized as a generated impulse response + convolution
    // (the spec's sanctioned realization). Convolution is unconditionally
    // stable — no feedback topology, no runaway.
    const convolver = context.createConvolver();
    convolver.buffer = generateReverbImpulse(context, params);
    input.connect(convolver);
    convolver.connect(returnGain);
    return { environmentIndex: index, def, input, gate, returnGain };
  }

  private async decodeAudioData(audio: AudioDataDef[]): Promise<void> {
    await Promise.all(audio.map(async (_, index) => {
      await this.decodeSingle(index);
    }));
  }

  private async decodeSingle(index: number): Promise<AudioBuffer | undefined> {
    const cached = this.buffers.get(index);
    if (cached) {
      return cached;
    }
    const context = this.context!;
    const audio = (this.json.extensions?.KHR_audio_emitter?.audio ?? [])[index] as AudioDataDef | undefined;
    if (!audio) {
      return undefined;
    }
    try {
      let raw: ArrayBuffer | undefined;
      if (audio.uri) {
        raw = await this.options.resolveUri(audio.uri);
      } else if (typeof audio.bufferView === "number") {
        raw = this.options.getBufferView?.(audio.bufferView);
      }
      if (!raw) {
        return undefined;
      }
      const buffer = await context.decodeAudioData(raw.slice(0));
      this.buffers.set(index, buffer);
      return buffer;
    } catch (error) {
      console.warn(`KHR_audio: failed to decode audio[${index}]`, error);
      return undefined;
    }
  }

  private buildEmitterInstances(emitterExt: { sources?: SourceDef[]; emitters?: EmitterDef[] }): void {
    const bindings: Array<{ emitterIndex: number; nodeIndex: number | null }> = [];
    const nodes = this.json.nodes ?? [];
    for (let i = 0; i < nodes.length; i += 1) {
      const ext = nodes[i].extensions?.KHR_audio_emitter;
      if (!ext) {
        continue;
      }
      const list: number[] = Array.isArray(ext.emitters)
        ? ext.emitters
        : typeof ext.emitter === "number" ? [ext.emitter] : [];
      for (const emitterIndex of list) {
        bindings.push({ emitterIndex, nodeIndex: i });
      }
    }
    const scenes = this.json.scenes ?? [];
    const sceneExt = scenes[this.json.scene ?? 0]?.extensions?.KHR_audio_emitter;
    for (const emitterIndex of sceneExt?.emitters ?? []) {
      bindings.push({ emitterIndex, nodeIndex: null });
    }

    for (const binding of bindings) {
      const def = (emitterExt.emitters ?? [])[binding.emitterIndex];
      if (!def) {
        continue;
      }
      const instance = this.buildEmitterChain(binding.emitterIndex, binding.nodeIndex, def, emitterExt.sources ?? []);
      if (instance) {
        this.emitterInstances.push(instance);
      }
    }
  }

  private buildEmitterChain(
    emitterIndex: number,
    nodeIndex: number | null,
    def: EmitterDef,
    sources: SourceDef[]
  ): EmitterInstance | null {
    const context = this.context!;
    const input = context.createGain();
    input.gain.value = def.gain ?? 1.0;

    let tail: AudioNode = input;
    let filter: BiquadFilterNode | null = null;
    let distanceGain: GainNode | null = null;
    let panner: PannerNode | null = null;

    if (def.type === "positional") {
      const positional = def.positional ?? {};
      const envProps = positional.extensions?.KHR_audio_environment;
      if (envProps?.airAbsorption?.enabled || typeof envProps?.coneOuterCutoff === "number") {
        filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 20000;
        tail.connect(filter);
        tail = filter;
      }
      panner = context.createPanner();
      const model = envProps?.spatializationModel ?? this.listenerDef?.spatializationModel ?? "equalpower";
      panner.panningModel = model === "HRTF" ? "HRTF" : "equalpower";
      if (positional.distanceModel === "custom" && envProps?.distanceCurve) {
        // Neutralize the panner's attenuation; a per-frame gain drives the curve.
        panner.distanceModel = "linear";
        panner.rolloffFactor = 0;
        distanceGain = context.createGain();
      } else if (positional.distanceModel === "linear" || positional.distanceModel === "exponential") {
        panner.distanceModel = positional.distanceModel;
      } else {
        panner.distanceModel = "inverse";
      }
      panner.refDistance = positional.refDistance ?? 1;
      // Web Audio treats maxDistance 0 as invalid; spec sentinel 0 = unlimited.
      panner.maxDistance = positional.maxDistance && positional.maxDistance > 0 ? positional.maxDistance : 1e6;
      if (panner.rolloffFactor !== 0) {
        panner.rolloffFactor = positional.rolloffFactor ?? 1;
      }
      if (positional.shapeType === "cone") {
        panner.coneInnerAngle = (positional.coneInnerAngle ?? Math.PI * 2) * RAD_TO_DEG;
        panner.coneOuterAngle = (positional.coneOuterAngle ?? Math.PI * 2) * RAD_TO_DEG;
        panner.coneOuterGain = positional.coneOuterGain ?? 0;
      }
      tail.connect(panner);
      tail = panner;
      if (distanceGain) {
        tail.connect(distanceGain);
        tail = distanceGain;
      }
    }

    // Per-emitter direct/reverb sends (spec 3.1).
    const sendProps = def.extensions?.KHR_audio_environment ?? {};
    const directGain = context.createGain();
    directGain.gain.value = sendProps.directLevel ?? 1.0;
    tail.connect(directGain);
    directGain.connect(this.listenerBus!);

    const sendGain = context.createGain();
    sendGain.gain.value = sendProps.reverbLevel ?? (def.type === "positional" ? 1.0 : 0.0);
    tail.connect(sendGain);
    if (typeof sendProps.environment === "number" && this.environmentBuses.has(sendProps.environment)) {
      sendGain.connect(this.environmentBuses.get(sendProps.environment)!.input); // forced env
    } else {
      sendGain.connect(this.sendBus!);
    }

    // Sources (skipped entirely for graph-fed emitters — rule 12).
    const graphFed = this.graphFedEmitters.has(emitterIndex);
    const instanceSources: EmitterInstance["sources"] = [];
    for (const sourceIndex of graphFed ? [] : def.sources ?? []) {
      const source = sources[sourceIndex];
      if (!source) {
        continue;
      }
      // Oscillator source on a direct emitter path (r2): scheduled like a clip.
      if (source.extensions?.KHR_audio_graph?.oscillator && typeof source.audio !== "number") {
        if (source.autoplay) {
          this.startPlayerInto(source, { node: input, input: 0 });
        }
        continue;
      }
      if (typeof source.audio !== "number") {
        continue;
      }
      const buffer = this.buffers.get(source.audio);
      if (!buffer) {
        continue;
      }
      const node = this.context!.createBufferSource();
      node.buffer = buffer;
      node.loop = source.loop ?? false;
      const basePlaybackRate = source.playbackRate ?? 1.0;
      node.playbackRate.value = basePlaybackRate;
      const gain = this.context!.createGain();
      gain.gain.value = source.gain ?? 1.0;
      node.connect(gain);
      gain.connect(input);
      if (source.autoplay) {
        node.start();
      }
      instanceSources.push({ sourceIndex, node, gain, basePlaybackRate });
    }

    return {
      emitterIndex,
      nodeIndex,
      def,
      graphFed,
      input,
      panner,
      filter,
      distanceGain,
      directGain,
      sendGain,
      sources: instanceSources,
      previousPosition: null
    };
  }
}
