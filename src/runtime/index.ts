import type { InteractivityGraph } from "../extensions/interactivity";
import { advanceTime, createRuntime, executeFlow, type Graph, type RuntimeGraph } from "./interactivity-runtime";

export type InteractivityEvent =
  | { type: "pointermove"; x: number; y: number }
  | { type: "pointerdown"; x: number; y: number }
  | { type: "pointerup"; x: number; y: number };

export type SceneAdapter = {
  applyPointer(pointer: string, value: number[] | boolean[] | number | boolean): void;
  setNodeVisibility(nodeIndex: number, visible: boolean): void;
  setNodeSelectable(nodeIndex: number, selectable: boolean): void;
  setNodeHoverable(nodeIndex: number, hoverable: boolean): void;
};

export class InteractivityRuntime {
  private runtime: RuntimeGraph;
  private graph: Graph;
  private adapter: SceneAdapter | null = null;
  private events: InteractivityEvent[] = [];
  private lastEvent: string = "none";
  private eventNodes: Map<string, number[]> = new Map();
  private dirty = false;

  constructor(graph: InteractivityGraph, gltf: unknown) {
    if (!graph) {
      throw new Error("Missing KHR_interactivity graph.");
    }
    this.graph = graph as Graph;
    this.runtime = createRuntime(this.graph, gltf, {
      onPointerSet: (pointer, value) => {
        this.adapter?.applyPointer(pointer, value);
        this.dirty = true;
      },
      onDirty: () => {
        this.dirty = true;
      }
    });
    this.buildEventIndex();
  }

  bindAdapter(adapter: SceneAdapter) {
    this.adapter = adapter;
  }

  start() {
    this.triggerEvent("event/onStart");
  }

  queueEvent(event: InteractivityEvent) {
    this.events.push(event);
  }

  tick(dtSeconds: number) {
    advanceTime(this.runtime, dtSeconds);
    this.triggerEvent("event/onTick");
    while (this.events.length > 0) {
      const event = this.events.shift();
      if (!event) {
        break;
      }
      this.lastEvent = event.type;
      const op = this.eventOpFromEvent(event);
      if (op) {
        this.runtime.pointerX = event.x;
        this.runtime.pointerY = event.y;
        this.triggerEvent(op);
      }
    }
  }

  consumeDirty() {
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  getDiagnostics() {
    return {
      nodes: this.graph.nodes.length,
      edges: this.graph.nodes.reduce((total, node) => total + (node.flows ? Object.keys(node.flows).length : 0), 0),
      lastEvent: this.lastEvent
    };
  }

  private eventOpFromEvent(event: InteractivityEvent) {
    if (event.type === "pointermove") {
      return "event/onPointerMove";
    }
    if (event.type === "pointerdown") {
      return "event/onPointerDown";
    }
    if (event.type === "pointerup") {
      return "event/onPointerUp";
    }
    return null;
  }

  private triggerEvent(op: string) {
    const nodes = this.eventNodes.get(op);
    if (!nodes || nodes.length === 0) {
      return;
    }
    for (const nodeId of nodes) {
      executeFlow(this.runtime, nodeId, "in");
    }
  }

  private buildEventIndex() {
    this.eventNodes.clear();
    this.graph.nodes.forEach((node, index) => {
      const op = this.graph.declarations[node.declaration]?.op;
      if (!op || !op.startsWith("event/")) {
        return;
      }
      const list = this.eventNodes.get(op) ?? [];
      list.push(index);
      this.eventNodes.set(op, list);
    });
  }
}
