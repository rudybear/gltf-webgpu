export type InteractivityGraph = {
  types?: Array<{ signature?: string }>;
  variables?: unknown[];
  declarations?: Array<{ op?: string }>;
  nodes?: Array<{
    declaration?: number;
    flows?: Record<string, { node: number; socket: string }>;
  }>;
};

export function parseInteractivity(payload: unknown): InteractivityGraph | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const data = payload as { graphs?: InteractivityGraph[] };
  const graph = data.graphs?.[0];
  return graph ?? null;
}

export function summarizeInteractivity(graph: InteractivityGraph | null) {
  const nodeCount = graph?.nodes?.length ?? 0;
  const variableCount = graph?.variables?.length ?? 0;
  const edgeCount = graph?.nodes?.reduce((total, node) => {
    const flows = node.flows ? Object.keys(node.flows).length : 0;
    return total + flows;
  }, 0) ?? 0;
  return {
    nodes: nodeCount,
    edges: edgeCount,
    variables: variableCount
  };
}
