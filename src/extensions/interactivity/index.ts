export type InteractivityNode = {
  id: number;
  type: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
};

export type InteractivityEdge = {
  from: number;
  to: number;
  fromPort?: string;
  toPort?: string;
};

export type InteractivityGraph = {
  nodes: InteractivityNode[];
  edges: InteractivityEdge[];
  variables?: unknown[];
};

export function parseInteractivity(payload: unknown): InteractivityGraph {
  if (!payload || typeof payload !== "object") {
    return { nodes: [], edges: [] };
  }

  const data = payload as {
    nodes?: Array<{ id?: number; type?: string }>;
    edges?: Array<{ from?: number; to?: number }>;
    variables?: unknown[];
  };

  const nodes = (data.nodes ?? []).map((node, index) => ({
    id: typeof node.id === "number" ? node.id : index,
    type: node.type ?? "unknown"
  }));

  const edges = (data.edges ?? []).map((edge) => ({
    from: edge.from ?? 0,
    to: edge.to ?? 0
  }));

  return { nodes, edges, variables: data.variables };
}

export function summarizeInteractivity(graph: InteractivityGraph) {
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    variables: graph.variables?.length ?? 0
  };
}
