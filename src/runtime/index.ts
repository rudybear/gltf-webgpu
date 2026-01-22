import type { InteractivityGraph } from "../extensions/interactivity";

export type InteractivityEvent =
  | { type: "tick"; dt: number }
  | { type: "pointermove"; x: number; y: number }
  | { type: "pointerdown"; x: number; y: number }
  | { type: "pointerup"; x: number; y: number };

export type SceneAdapter = {
  setNodeVisibility(nodeIndex: number, visible: boolean): void;
  setNodeSelectable(nodeIndex: number, selectable: boolean): void;
  setNodeHoverable(nodeIndex: number, hoverable: boolean): void;
  playAnimationPointer(animationIndex: number, time: number): void;
};

export class InteractivityRuntime {
  private graph: InteractivityGraph;
  private adapter: SceneAdapter | null = null;
  private events: InteractivityEvent[] = [];
  private lastEvent: InteractivityEvent | null = null;

  constructor(graph: InteractivityGraph) {
    this.graph = graph;
  }

  bindAdapter(adapter: SceneAdapter) {
    this.adapter = adapter;
  }

  queueEvent(event: InteractivityEvent) {
    this.events.push(event);
  }

  tick(dtSeconds: number) {
    this.queueEvent({ type: "tick", dt: dtSeconds });
    while (this.events.length > 0) {
      const event = this.events.shift();
      if (!event) {
        break;
      }
      this.lastEvent = event;
      this.evaluateEvent(event);
    }
  }

  getDiagnostics() {
    return {
      nodes: this.graph.nodes.length,
      edges: this.graph.edges.length,
      lastEvent: this.lastEvent?.type ?? "none"
    };
  }

  private evaluateEvent(_event: InteractivityEvent) {
    void this.adapter;
  }
}
