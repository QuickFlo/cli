/**
 * Workflow canvas layout for CLI-authored definitions.
 *
 * This mirrors the workflow builder's auto-layout pipeline: flatten the
 * hierarchical definition into the same fork/container graph, run ELK's
 * rightward layered layout, then compact linear chains into short columns.
 * The resulting coordinates are persisted as `uiMetadata.nodePositions`.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import type {
  ELK as ElkInstance,
  ELKConstructorArguments,
  ElkExtendedEdge,
  ElkNode,
  ElkPort,
} from 'elkjs/lib/elk-api';
import type { WorkflowDefinition } from './workflows-save.ts';

interface WorkflowStep {
  stepId: string;
  stepType: string;
  input?: Record<string, unknown>;
}

interface LayoutNode {
  id: string;
  stepType: string;
  input: Record<string, unknown>;
}

interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

interface Position {
  x: number;
  y: number;
}

interface NodeDimensions {
  width: number;
  height: number;
}

interface LayoutOptions {
  maxNodesPerColumn?: number;
  horizontalSpacing?: number;
  verticalSpacing?: number;
}

interface Graph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

// Deno exposes elkjs's CommonJS default correctly at runtime, but models the
// import as the module namespace. Keep the interop cast isolated here.
const ElkConstructor = ELK as unknown as {
  new (args?: ELKConstructorArguments): ElkInstance;
};
function createElk(): ElkInstance {
  return new ElkConstructor({
    workerFactory: () =>
      new Worker(new URL('./elk-worker.ts', import.meta.url), { type: 'module' }),
  });
}

function normalizeStepType(stepType: string): string {
  return stepType.toLowerCase().replace(/__/g, '.');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStep(value: unknown): WorkflowStep | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const stepId = record['stepId'];
  const stepType = record['stepType'];
  if (typeof stepId !== 'string' || typeof stepType !== 'string') {
    return undefined;
  }
  return {
    stepId,
    stepType,
    input: asRecord(record['input']),
  };
}

function stepArray(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  const steps: WorkflowStep[] = [];
  for (const valueStep of value) {
    const step = asStep(valueStep);
    if (step) steps.push(step);
  }
  return steps;
}

function isTerminalStep(step: WorkflowStep | undefined): boolean {
  return step ? normalizeStepType(step.stepType) === 'core.return' : false;
}

/** Flatten the workflow using the builder's edge semantics. */
export function workflowDefinitionToGraph(steps: unknown[]): Graph {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const nodeIds = new Set<string>();
  let edgeSequence = 0;

  const addNode = (step: WorkflowStep): void => {
    if (nodeIds.has(step.stepId)) return;
    nodeIds.add(step.stepId);
    nodes.push({
      id: step.stepId,
      stepType: step.stepType,
      input: step.input ?? {},
    });
  };

  const addEdge = (source: string, target: string, sourceHandle: string): void => {
    edges.push({
      id: `e-${source}-${target}-${edgeSequence++}`,
      source,
      target,
      sourceHandle,
      targetHandle: 'input',
    });
  };

  const processSequence = (
    sequence: WorkflowStep[],
    previousStepId: string | null,
    sourceHandle = 'output',
    afterSequenceStep?: WorkflowStep,
  ): string | null => {
    let previous = previousStepId;
    let nextSourceHandle = sourceHandle;

    for (let index = 0; index < sequence.length; index++) {
      const step = sequence[index];
      if (!step) continue;
      const localNextStep = sequence[index + 1];
      const effectiveNextStep = localNextStep ?? afterSequenceStep;
      const normalized = normalizeStepType(step.stepType);

      addNode(step);
      if (previous) addEdge(previous, step.stepId, nextSourceHandle);

      if (normalized === 'core.if') {
        const thenSteps = stepArray(step.input?.['then']);
        const elseSteps = stepArray(step.input?.['else']);
        const branches: Array<{ handle: string; steps: WorkflowStep[] }> = [
          { handle: 'then', steps: thenSteps },
          { handle: 'else', steps: elseSteps },
        ];
        for (const branch of branches) {
          if (branch.steps.length === 0) {
            if (effectiveNextStep) addEdge(step.stepId, effectiveNextStep.stepId, branch.handle);
            continue;
          }
          const lastId = processSequence(
            branch.steps,
            step.stepId,
            branch.handle,
            effectiveNextStep,
          );
          const lastStep = branch.steps.at(-1);
          if (lastId && effectiveNextStep && !isTerminalStep(lastStep)) {
            addEdge(lastId, effectiveNextStep.stepId, 'output');
          }
        }
        previous = null;
      } else if (normalized === 'core.switch') {
        const branches: Array<{ handle: string; steps: WorkflowStep[] }> = [
          { handle: 'default', steps: stepArray(step.input?.['default']) },
        ];
        const cases = step.input?.['cases'];
        if (Array.isArray(cases)) {
          cases.forEach((caseValue, caseIndex) => {
            const caseRecord = asRecord(caseValue);
            branches.push({
              handle: `case-${caseIndex}`,
              steps: stepArray(caseRecord?.['steps']),
            });
          });
        }
        for (const branch of branches) {
          if (branch.steps.length === 0) {
            if (effectiveNextStep) addEdge(step.stepId, effectiveNextStep.stepId, branch.handle);
            continue;
          }
          const lastId = processSequence(
            branch.steps,
            step.stepId,
            branch.handle,
            effectiveNextStep,
          );
          const lastStep = branch.steps.at(-1);
          if (lastId && effectiveNextStep && !isTerminalStep(lastStep)) {
            addEdge(lastId, effectiveNextStep.stepId, 'output');
          }
        }
        previous = null;
      } else if (normalized === 'core.for-each' || normalized === 'core.parallel') {
        const nestedSteps = stepArray(step.input?.['steps']);
        if (nestedSteps.length > 0) {
          processSequence(nestedSteps, step.stepId, 'loop');
        }
        if (effectiveNextStep) addEdge(step.stepId, effectiveNextStep.stepId, 'done');
        previous = null;
      } else {
        previous = step.stepId;
      }

      nextSourceHandle = 'output';
    }

    return previous;
  };

  processSequence(stepArray(steps), null);
  return { nodes, edges };
}

function getNodeDimensions(node: LayoutNode): NodeDimensions {
  switch (normalizeStepType(node.stepType)) {
    case 'core.if':
      return { width: 220, height: 120 };
    case 'core.switch':
      return { width: 200, height: 140 };
    case 'core.for-each':
      return { width: 280, height: 220 };
    default:
      return { width: 200, height: 100 };
  }
}

function getNodeHandles(node: LayoutNode): { targets: string[]; sources: string[] } {
  switch (normalizeStepType(node.stepType)) {
    case 'core.if':
      return { targets: ['input'], sources: ['then', 'else'] };
    case 'core.switch': {
      const sources = ['default'];
      const cases = node.input['cases'];
      if (Array.isArray(cases)) {
        cases.forEach((_caseValue, index) => sources.push(`case-${index}`));
      }
      return { targets: ['input'], sources };
    }
    case 'core.for-each':
      return { targets: ['input'], sources: ['loop', 'done'] };
    case 'core.return':
      return { targets: ['input'], sources: [] };
    default:
      return { targets: ['input'], sources: ['output'] };
  }
}

function buildElkPorts(
  node: LayoutNode,
): { ports: ElkPort[]; portIdMap: Map<string, string> } {
  const handles = getNodeHandles(node);
  const ports: ElkPort[] = [];
  const portIdMap = new Map<string, string>();
  handles.targets.forEach((handleId, index) => {
    const portId = `${node.id}__${handleId}`;
    ports.push({
      id: portId,
      layoutOptions: { 'port.side': 'WEST', 'port.index': String(index) },
    });
    portIdMap.set(handleId, portId);
  });
  handles.sources.forEach((handleId, index) => {
    const portId = `${node.id}__${handleId}`;
    ports.push({
      id: portId,
      layoutOptions: { 'port.side': 'EAST', 'port.index': String(index) },
    });
    portIdMap.set(handleId, portId);
  });
  return { ports, portIdMap };
}

async function runElkLayout(
  elk: ElkInstance,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions,
): Promise<Map<string, Position>> {
  const { horizontalSpacing = 150, verticalSpacing = 80 } = options;
  const globalPortIdMap = new Map<string, string>();
  const children: ElkNode[] = nodes.map((node) => {
    const dimensions = getNodeDimensions(node);
    const { ports, portIdMap } = buildElkPorts(node);
    for (const [handleId, portId] of portIdMap) {
      globalPortIdMap.set(`${node.id}:${handleId}`, portId);
    }
    return {
      id: node.id,
      ...dimensions,
      ports,
      layoutOptions: { 'elk.portConstraints': 'FIXED_ORDER' },
    };
  });
  const elkEdges: ElkExtendedEdge[] = edges.map((edge) => ({
    id: edge.id,
    sources: [globalPortIdMap.get(`${edge.source}:${edge.sourceHandle}`) ?? edge.source],
    targets: [globalPortIdMap.get(`${edge.target}:${edge.targetHandle}`) ?? edge.target],
  }));
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(verticalSpacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(horizontalSpacing),
      'elk.spacing.edgeNode': '40',
      'elk.spacing.edgeEdge': '30',
      'elk.layered.spacing.edgeNodeBetweenLayers': '40',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '25',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children,
    edges: elkEdges,
  });
  const positions = new Map<string, Position>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}

function getMultiHandleNodeIds(edges: LayoutEdge[]): Set<string> {
  const handlesByNode = new Map<string, Set<string>>();
  for (const edge of edges) {
    const handles = handlesByNode.get(edge.source) ?? new Set<string>();
    handles.add(edge.sourceHandle || 'output');
    handlesByNode.set(edge.source, handles);
  }
  const result = new Set<string>();
  for (const [nodeId, handles] of handlesByNode) {
    if (handles.size > 1) result.add(nodeId);
  }
  return result;
}

function buildOutEdgeMap(edges: LayoutEdge[]): Map<string, LayoutEdge[]> {
  const result = new Map<string, LayoutEdge[]>();
  for (const edge of edges) {
    const nodeEdges = result.get(edge.source) ?? [];
    nodeEdges.push(edge);
    result.set(edge.source, nodeEdges);
  }
  return result;
}

function identifyBranchInteriorNodes(
  edges: LayoutEdge[],
  outEdgeMap: Map<string, LayoutEdge[]>,
): Set<string> {
  const branchInterior = new Set<string>();
  for (const forkId of getMultiHandleNodeIds(edges)) {
    const handleTargets = new Map<string, string[]>();
    for (const edge of edges) {
      if (edge.source !== forkId) continue;
      const targets = handleTargets.get(edge.sourceHandle) ?? [];
      targets.push(edge.target);
      handleTargets.set(edge.sourceHandle, targets);
    }

    const reachableByHandle = new Map<string, Set<string>>();
    for (const [handle, startTargets] of handleTargets) {
      const reachable = new Set<string>();
      const queue = [...startTargets];
      const visited = new Set(startTargets);
      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) break;
        reachable.add(nodeId);
        for (const edge of outEdgeMap.get(nodeId) ?? []) {
          if (visited.has(edge.target)) continue;
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
      reachableByHandle.set(handle, reachable);
    }

    const reachCount = new Map<string, number>();
    for (const reachable of reachableByHandle.values()) {
      for (const nodeId of reachable) {
        reachCount.set(nodeId, (reachCount.get(nodeId) ?? 0) + 1);
      }
    }
    const convergenceNodes = new Set(
      [...reachCount].filter(([, count]) => count > 1).map(([nodeId]) => nodeId),
    );

    for (const startTargets of handleTargets.values()) {
      const queue = [...startTargets];
      const visited = new Set(startTargets);
      while (queue.length > 0) {
        const nodeId = queue.shift();
        if (!nodeId) break;
        if (convergenceNodes.has(nodeId)) continue;
        branchInterior.add(nodeId);
        for (const edge of outEdgeMap.get(nodeId) ?? []) {
          if (visited.has(edge.target)) continue;
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
  }
  return branchInterior;
}

function getBranchesForFork(
  forkId: string,
  edges: LayoutEdge[],
  outEdgeMap: Map<string, LayoutEdge[]>,
): Array<{ nodes: Set<string> }> {
  const handleTargets = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source !== forkId) continue;
    const targets = handleTargets.get(edge.sourceHandle) ?? [];
    targets.push(edge.target);
    handleTargets.set(edge.sourceHandle, targets);
  }
  if (handleTargets.size < 2) return [];

  const reachableByHandle = new Map<string, Set<string>>();
  for (const [handle, startTargets] of handleTargets) {
    const reachable = new Set<string>();
    const queue = [...startTargets];
    const visited = new Set(startTargets);
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) break;
      reachable.add(nodeId);
      for (const edge of outEdgeMap.get(nodeId) ?? []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
    reachableByHandle.set(handle, reachable);
  }

  const reachCount = new Map<string, number>();
  for (const reachable of reachableByHandle.values()) {
    for (const nodeId of reachable) {
      reachCount.set(nodeId, (reachCount.get(nodeId) ?? 0) + 1);
    }
  }
  const convergenceNodes = new Set(
    [...reachCount].filter(([, count]) => count > 1).map(([nodeId]) => nodeId),
  );

  const branches: Array<{ nodes: Set<string> }> = [];
  for (const startTargets of handleTargets.values()) {
    const branchNodes = new Set<string>();
    const queue = [...startTargets];
    const visited = new Set(startTargets);
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) break;
      if (convergenceNodes.has(nodeId)) continue;
      branchNodes.add(nodeId);
      for (const edge of outEdgeMap.get(nodeId) ?? []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
    if (branchNodes.size > 0) branches.push({ nodes: branchNodes });
  }
  return branches;
}

/** The builder's post-ELK short-column compaction and branch-overlap pass. */
function compactLinearChains(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  positions: Map<string, Position>,
  options: LayoutOptions,
): Map<string, Position> {
  const { maxNodesPerColumn = 4, horizontalSpacing = 150, verticalSpacing = 80 } = options;
  if (maxNodesPerColumn <= 1) return positions;

  const inEdgeMap = new Map<string, LayoutEdge[]>();
  const outEdgeMap = buildOutEdgeMap(edges);
  for (const edge of edges) {
    const nodeEdges = inEdgeMap.get(edge.target) ?? [];
    nodeEdges.push(edge);
    inEdgeMap.set(edge.target, nodeEdges);
  }
  const multiHandleIds = getMultiHandleNodeIds(edges);
  const branchInterior = identifyBranchInteriorNodes(edges, outEdgeMap);
  const isCompactable = (nodeId: string): boolean => {
    if (multiHandleIds.has(nodeId)) return false;
    return inEdgeMap.get(nodeId)?.length === 1 && outEdgeMap.get(nodeId)?.length === 1;
  };

  const visited = new Set<string>();
  const chains: string[][] = [];
  const sortedNodeIds = [...nodes]
    .sort((left, right) => (positions.get(left.id)?.x ?? 0) - (positions.get(right.id)?.x ?? 0))
    .map((node) => node.id);
  for (const nodeId of sortedNodeIds) {
    if (visited.has(nodeId) || !isCompactable(nodeId)) continue;
    let start = nodeId;
    while (true) {
      const previousEdge = inEdgeMap.get(start)?.length === 1
        ? inEdgeMap.get(start)?.[0]
        : undefined;
      if (
        !previousEdge || visited.has(previousEdge.source) || !isCompactable(previousEdge.source)
      ) {
        break;
      }
      start = previousEdge.source;
    }
    const chain: string[] = [];
    let current: string | undefined = start;
    while (current) {
      if (visited.has(current) || (chain.length > 0 && !isCompactable(current))) break;
      chain.push(current);
      visited.add(current);
      const nextEdge: LayoutEdge | undefined = outEdgeMap.get(current)?.length === 1
        ? outEdgeMap.get(current)?.[0]
        : undefined;
      if (!nextEdge || !isCompactable(nextEdge.target)) break;
      current = nextEdge.target;
    }
    if (chain.length > 1) chains.push(chain);
  }
  if (chains.length === 0) return positions;

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map([...positions].map(([id, position]) => [id, { ...position }]));
  const chainMembership = new Map<string, { chainIndex: number; position: number }>();
  chains.sort((left, right) =>
    (result.get(left[0] ?? '')?.x ?? 0) - (result.get(right[0] ?? '')?.x ?? 0)
  );

  for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
    const chain = chains[chainIndex];
    if (!chain) continue;
    chain.sort((left, right) => (result.get(left)?.x ?? 0) - (result.get(right)?.x ?? 0));
    chain.forEach((nodeId, position) => {
      chainMembership.set(nodeId, { chainIndex, position });
    });
    const firstPosition = result.get(chain[0] ?? '');
    if (!firstPosition) continue;
    const effectiveMax = chain.some((nodeId) => branchInterior.has(nodeId))
      ? Math.min(maxNodesPerColumn, 3)
      : maxNodesPerColumn;
    let columnX = firstPosition.x;
    let columnY = firstPosition.y;
    let nodesInColumn = 0;
    let maxColumnWidth = 0;
    for (const nodeId of chain) {
      const dimensions = getNodeDimensions(
        nodeMap.get(nodeId) ?? {
          id: nodeId,
          stepType: '',
          input: {},
        },
      );
      if (nodesInColumn >= effectiveMax) {
        columnX += maxColumnWidth + horizontalSpacing;
        columnY = firstPosition.y;
        nodesInColumn = 0;
        maxColumnWidth = 0;
      }
      result.set(nodeId, { x: columnX, y: columnY });
      columnY += dimensions.height + verticalSpacing;
      maxColumnWidth = Math.max(maxColumnWidth, dimensions.width);
      nodesInColumn++;
    }
  }

  for (let iteration = 0; iteration < 5; iteration++) {
    let changed = false;
    for (const forkId of multiHandleIds) {
      const branchBoxes = getBranchesForFork(forkId, edges, outEdgeMap).map((branch) => {
        let minY = Infinity;
        let maxY = -Infinity;
        for (const nodeId of branch.nodes) {
          const position = result.get(nodeId);
          if (!position) continue;
          const dimensions = getNodeDimensions(
            nodeMap.get(nodeId) ?? {
              id: nodeId,
              stepType: '',
              input: {},
            },
          );
          minY = Math.min(minY, position.y);
          maxY = Math.max(maxY, position.y + dimensions.height);
        }
        return { ...branch, minY, maxY };
      }).sort((left, right) => left.minY - right.minY);
      for (let index = 1; index < branchBoxes.length; index++) {
        const previous = branchBoxes[index - 1];
        const current = branchBoxes[index];
        if (!previous || !current) continue;
        const requiredMinY = previous.maxY + verticalSpacing;
        if (current.minY >= requiredMinY) continue;
        const delta = requiredMinY - current.minY;
        for (const nodeId of current.nodes) {
          const position = result.get(nodeId);
          if (position) result.set(nodeId, { x: position.x, y: position.y + delta });
        }
        current.minY += delta;
        current.maxY += delta;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const inDegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...inDegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  const topologicalOrder: string[] = [];
  const topologicalVisited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || topologicalVisited.has(nodeId)) continue;
    topologicalVisited.add(nodeId);
    topologicalOrder.push(nodeId);
    for (const edge of outEdgeMap.get(nodeId) ?? []) {
      const degree = (inDegree.get(edge.target) ?? 0) - 1;
      inDegree.set(edge.target, degree);
      if (degree <= 0 && !topologicalVisited.has(edge.target)) queue.push(edge.target);
    }
  }

  for (const nodeId of topologicalOrder) {
    const membership = chainMembership.get(nodeId);
    if (membership && membership.position > 0) continue;
    const incoming = inEdgeMap.get(nodeId) ?? [];
    if (incoming.length === 0) continue;
    let maxPredecessorRight = -Infinity;
    for (const edge of incoming) {
      const predecessorPosition = result.get(edge.source);
      if (!predecessorPosition) continue;
      const predecessorMembership = chainMembership.get(edge.source);
      if (predecessorMembership) {
        for (const chainNodeId of chains[predecessorMembership.chainIndex] ?? []) {
          const chainPosition = result.get(chainNodeId);
          if (!chainPosition) continue;
          const dimensions = getNodeDimensions(
            nodeMap.get(chainNodeId) ?? {
              id: chainNodeId,
              stepType: '',
              input: {},
            },
          );
          maxPredecessorRight = Math.max(
            maxPredecessorRight,
            chainPosition.x + dimensions.width,
          );
        }
      } else {
        const dimensions = getNodeDimensions(
          nodeMap.get(edge.source) ?? {
            id: edge.source,
            stepType: '',
            input: {},
          },
        );
        maxPredecessorRight = Math.max(
          maxPredecessorRight,
          predecessorPosition.x + dimensions.width,
        );
      }
    }
    if (maxPredecessorRight === -Infinity) continue;
    const desiredX = maxPredecessorRight + horizontalSpacing;
    const currentPosition = result.get(nodeId);
    if (!currentPosition || desiredX >= currentPosition.x) continue;
    const delta = currentPosition.x - desiredX;
    if (membership) {
      for (const chainNodeId of chains[membership.chainIndex] ?? []) {
        const position = result.get(chainNodeId);
        if (position) result.set(chainNodeId, { x: position.x - delta, y: position.y });
      }
    } else {
      result.set(nodeId, { x: desiredX, y: currentPosition.y });
    }
  }
  return result;
}

async function layoutWorkflowStepsWithElk(
  elk: ElkInstance,
  steps: unknown[],
  options: LayoutOptions = {},
): Promise<Record<string, Position>> {
  const { nodes, edges } = workflowDefinitionToGraph(steps);
  if (nodes.length === 0) return {};
  const elkPositions = await runElkLayout(elk, nodes, edges, options);
  const positions = compactLinearChains(nodes, edges, elkPositions, options);
  return Object.fromEntries(positions);
}

export async function layoutWorkflowSteps(
  steps: unknown[],
  options: LayoutOptions = {},
): Promise<Record<string, Position>> {
  const elk = createElk();
  try {
    return await layoutWorkflowStepsWithElk(elk, steps, options);
  } finally {
    elk.terminateWorker();
  }
}

export interface WorkflowLayoutEngine {
  layoutWorkflowSteps(
    steps: unknown[],
    options?: LayoutOptions,
  ): Promise<Record<string, Position>>;
  dispose(): void;
}

/** Reuse one ELK worker across every file in a bulk push. */
export function createWorkflowLayoutEngine(): WorkflowLayoutEngine {
  const elk = createElk();
  return {
    layoutWorkflowSteps: (steps, options = {}) => layoutWorkflowStepsWithElk(elk, steps, options),
    dispose: () => elk.terminateWorker(),
  };
}

function existingNodePositions(definition: WorkflowDefinition): Record<string, Position> {
  const metadata = asRecord(definition['uiMetadata']);
  const positions = asRecord(metadata?.['nodePositions']);
  if (!positions) return {};
  const valid: Record<string, Position> = {};
  for (const [stepId, value] of Object.entries(positions)) {
    const position = asRecord(value);
    if (typeof position?.['x'] !== 'number' || typeof position['y'] !== 'number') continue;
    valid[stepId] = { x: position['x'], y: position['y'] };
  }
  return valid;
}

/**
 * Add builder-compatible coordinates without overwriting positions a human
 * already arranged. Other uiMetadata keys and non-step positions (such as
 * saved trigger nodes) survive the merge as well.
 */
export async function formatWorkflowForPush(
  definition: WorkflowDefinition,
  engine?: WorkflowLayoutEngine,
): Promise<WorkflowDefinition> {
  const generated = engine
    ? await engine.layoutWorkflowSteps(definition.steps)
    : await layoutWorkflowSteps(definition.steps);
  const existing = existingNodePositions(definition);
  const metadata = asRecord(definition['uiMetadata']) ?? {};
  return {
    ...definition,
    uiMetadata: {
      ...metadata,
      nodePositions: { ...generated, ...existing },
    },
  };
}
