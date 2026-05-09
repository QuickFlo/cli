/**
 * Static analysis of sub-workflow dependencies for the CLI push command.
 *
 * The engine resolves `core.sub-workflow` refs at execution time (see
 * libs/workflow-engine/src/lib/steps/core/sub-workflow.step.ts). On first-time
 * push, however, upload order matters: a caller must land *after* its callee,
 * and — when the caller references by `workflowTemplateId` — the callee must
 * already exist in the target org with a stable UUID, otherwise the reference
 * dangles.
 *
 * This module walks workflow definitions (including nested control-flow
 * containers: core.for-each, core.if, core.switch) to extract every local
 * sub-workflow reference, then topo-sorts a set of files so callees are
 * uploaded before their callers. External refs (@common/..., @org_suid/...,
 * or names not in the push set) and dynamic liquid refs ({{ ... }}) are
 * excluded from the graph.
 */

export interface StepLike {
  stepId?: string;
  stepType?: string;
  input?: Record<string, unknown>;
}

export interface WorkflowDefinitionLike {
  steps?: unknown[];
}

export interface DynamicRefWarning {
  kind: 'name' | 'id';
  value: string;
  stepPath: string;
}

export interface ExtractedRefs {
  /** Local (non-namespaced, non-dynamic) template names referenced. */
  names: Set<string>;
  /** Template IDs referenced directly. */
  ids: Set<string>;
  /** Refs that contain liquid templating and can't be resolved statically. */
  dynamic: DynamicRefWarning[];
  /** Namespaced refs (@common/..., @org_suid/...) — excluded from graph. */
  external: string[];
}

export interface FileDefinition {
  id?: string;
  name?: string;
  steps?: unknown[];
  [k: string]: unknown;
}

export interface PushFileNode {
  filename: string;
  def: FileDefinition;
  refs: ExtractedRefs;
}

export interface TopoResult {
  /** Files in dependency-safe upload order. */
  order: PushFileNode[];
  /**
   * Unresolved refs — pointed at templates not in the push set. Caller
   * should surface as informational notes (likely fine; user is expected
   * to have them in the target org already).
   */
  unresolved: Array<{ filename: string; kind: 'name' | 'id'; value: string }>;
  /**
   * Cycles detected in the dep graph. Not an error — the engine has a
   * runtime depth guard that aborts recursive sub-workflow calls. Cycle
   * members are appended to `order` in alphabetical order (no valid
   * topological ordering exists for them). Surface as a warning.
   */
  cycles: string[][];
}

export class DuplicateKeyError extends Error {
  constructor(
    public readonly kind: 'id' | 'name',
    public readonly value: string,
    public readonly files: string[],
  ) {
    super(
      `Duplicate workflow ${kind} "${value}" across files: ${files.join(', ')}`,
    );
    this.name = 'DuplicateKeyError';
  }
}

const LIQUID_PATTERN = /\{\{|\{%/;

function isDynamic(value: string): boolean {
  return LIQUID_PATTERN.test(value);
}

function isExternal(name: string): boolean {
  return name.startsWith('@');
}

/**
 * Recursively walk a step list, invoking `onSubWorkflow` for every
 * `core.sub-workflow` step found. `pathPrefix` is a dotted path string
 * used for diagnostics (e.g. `steps[3].input.then[0]`).
 */
function walkSteps(
  steps: unknown[] | undefined,
  pathPrefix: string,
  onSubWorkflow: (step: StepLike, path: string) => void,
): void {
  if (!Array.isArray(steps)) return;
  steps.forEach((rawStep, idx) => {
    if (!rawStep || typeof rawStep !== 'object') return;
    const step = rawStep as StepLike;
    const stepPath = `${pathPrefix}[${idx}]`;
    const stepType = step.stepType;
    const input = step.input;

    if (stepType === 'core.sub-workflow') {
      onSubWorkflow(step, stepPath);
      return;
    }

    if (!input || typeof input !== 'object') return;

    // ai.agent binds tools to workflow templates by id. Each entry in
    // input.tools[] is the same kind of dependency as a core.sub-workflow
    // call — the agent invokes the template at runtime via LLM tool-calling.
    if (stepType === 'ai.agent') {
      const tools = (input as Record<string, unknown>)['tools'];
      if (Array.isArray(tools)) {
        tools.forEach((rawTool, toolIdx) => {
          if (!rawTool || typeof rawTool !== 'object') return;
          const toolPath = `${stepPath}.input.tools[${toolIdx}]`;
          const templateId = (rawTool as Record<string, unknown>)['templateId'];
          if (typeof templateId !== 'string' || templateId.length === 0) {
            return;
          }
          // Synthesize a StepLike so onSubWorkflow can handle it uniformly;
          // templateId maps to workflowTemplateId since it's the same kind of
          // reference (a workflow template UUID).
          onSubWorkflow(
            { input: { workflowTemplateId: templateId } },
            toolPath,
          );
        });
      }
      return;
    }

    if (stepType === 'core.for-each') {
      const nested = (input as Record<string, unknown>)['steps'];
      walkSteps(nested as unknown[], `${stepPath}.input.steps`, onSubWorkflow);
      return;
    }

    if (stepType === 'core.if') {
      const thenSteps = (input as Record<string, unknown>)['then'];
      const elseSteps = (input as Record<string, unknown>)['else'];
      walkSteps(
        thenSteps as unknown[],
        `${stepPath}.input.then`,
        onSubWorkflow,
      );
      walkSteps(
        elseSteps as unknown[],
        `${stepPath}.input.else`,
        onSubWorkflow,
      );
      return;
    }

    if (stepType === 'core.switch') {
      const cases = (input as Record<string, unknown>)['cases'];
      if (Array.isArray(cases)) {
        cases.forEach((rawCase, caseIdx) => {
          if (!rawCase || typeof rawCase !== 'object') return;
          const caseSteps = (rawCase as Record<string, unknown>)['steps'];
          walkSteps(
            caseSteps as unknown[],
            `${stepPath}.input.cases[${caseIdx}].steps`,
            onSubWorkflow,
          );
        });
      }
      const defaultSteps = (input as Record<string, unknown>)['default'];
      walkSteps(
        defaultSteps as unknown[],
        `${stepPath}.input.default`,
        onSubWorkflow,
      );
      return;
    }
  });
}

/**
 * Extract every sub-workflow reference from a workflow definition.
 * Walks nested control-flow containers. Classifies each ref as local,
 * external (namespaced), or dynamic (liquid-templated).
 */
export function extractSubWorkflowRefs(
  def: WorkflowDefinitionLike,
): ExtractedRefs {
  const names = new Set<string>();
  const ids = new Set<string>();
  const dynamic: DynamicRefWarning[] = [];
  const external: string[] = [];

  walkSteps(def.steps, 'steps', (step, stepPath) => {
    const input = step.input ?? {};
    const nameRef = input['workflowTemplateName'];
    const idRef = input['workflowTemplateId'];

    if (typeof nameRef === 'string' && nameRef.length > 0) {
      if (isDynamic(nameRef)) {
        dynamic.push({ kind: 'name', value: nameRef, stepPath });
      } else if (isExternal(nameRef)) {
        external.push(nameRef);
      } else {
        names.add(nameRef);
      }
    }

    if (typeof idRef === 'string' && idRef.length > 0) {
      if (isDynamic(idRef)) {
        dynamic.push({ kind: 'id', value: idRef, stepPath });
      } else {
        ids.add(idRef);
      }
    }
  });

  return { names, ids, dynamic, external };
}

/**
 * Build the dependency graph for a set of files and return a topologically
 * sorted order (callees before callers). Files whose refs don't match any
 * file in the set are left as dependency-free nodes; the unresolved refs
 * are reported back so callers can warn the user.
 *
 * Stable ordering: independent nodes are ordered by filename.
 *
 * Throws:
 *  - `DuplicateKeyError` if two files declare the same id or name
 *  - `DependencyCycleError` if the graph has a cycle
 */
export function topoSortFiles(nodes: PushFileNode[]): TopoResult {
  // Index by name and id for O(1) ref resolution, catching duplicates.
  const byName = new Map<string, PushFileNode>();
  const byId = new Map<string, PushFileNode>();
  for (const node of nodes) {
    if (node.def.id) {
      const prev = byId.get(node.def.id);
      if (prev) {
        throw new DuplicateKeyError('id', node.def.id, [
          prev.filename,
          node.filename,
        ]);
      }
      byId.set(node.def.id, node);
    }
    if (node.def.name) {
      const prev = byName.get(node.def.name);
      if (prev) {
        throw new DuplicateKeyError('name', node.def.name, [
          prev.filename,
          node.filename,
        ]);
      }
      byName.set(node.def.name, node);
    }
  }

  // Edges: dependency → dependent (if A references B, then B → A).
  const dependents = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  const unresolved: TopoResult['unresolved'] = [];
  for (const node of nodes) {
    dependents.set(node.filename, new Set());
    inDegree.set(node.filename, 0);
  }

  const addEdge = (targetFile: string, dependentFile: string): void => {
    const deps = dependents.get(targetFile);
    if (!deps) return;
    if (deps.has(dependentFile)) return;
    deps.add(dependentFile);
    inDegree.set(dependentFile, (inDegree.get(dependentFile) ?? 0) + 1);
  };

  for (const node of nodes) {
    for (const name of node.refs.names) {
      const target = byName.get(name);
      if (!target) {
        unresolved.push({ filename: node.filename, kind: 'name', value: name });
        continue;
      }
      if (target.filename === node.filename) continue; // self-ref, skip
      addEdge(target.filename, node.filename);
    }
    for (const id of node.refs.ids) {
      const target = byId.get(id);
      if (!target) {
        unresolved.push({ filename: node.filename, kind: 'id', value: id });
        continue;
      }
      if (target.filename === node.filename) continue;
      addEdge(target.filename, node.filename);
    }
  }

  // Kahn's with deterministic tie-break (alphabetical by filename).
  const ready: string[] = [];
  for (const [filename, degree] of inDegree) {
    if (degree === 0) ready.push(filename);
  }
  ready.sort();

  const byFilename = new Map(nodes.map((n) => [n.filename, n]));
  const order: PushFileNode[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    const node = byFilename.get(next);
    if (!node) continue;
    order.push(node);
    const children = [...(dependents.get(next) ?? [])].sort();
    for (const child of children) {
      const remaining = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) {
        const pos = lowerBound(ready, child);
        ready.splice(pos, 0, child);
      }
    }
  }

  const cycles: string[][] = [];
  if (order.length !== nodes.length) {
    // Remaining nodes are in one or more cycles. The engine catches recursive
    // sub-workflow calls at runtime via a depth guard, so a cycle here isn't
    // fatal at push time — we record it as a warning and append the cycle
    // members in alphabetical order (no valid topo order exists for them).
    const unprocessed = new Set(
      nodes
        .filter((n) => (inDegree.get(n.filename) ?? 0) > 0)
        .map((n) => n.filename),
    );
    while (unprocessed.size > 0) {
      const cycle = findCycle(unprocessed, dependents);
      cycles.push(cycle);
      for (const member of cycle) unprocessed.delete(member);
    }
    const appended = cycles.flat().filter((f, i, arr) => arr.indexOf(f) === i);
    appended.sort();
    for (const filename of appended) {
      const node = byFilename.get(filename);
      if (node) order.push(node);
    }
  }

  return { order, unresolved, cycles };
}

function lowerBound(arr: string[], value: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * DFS from any unprocessed node until we revisit a node on the current
 * stack — that's the cycle. Returned path starts and ends with the same
 * filename for readability (a → b → a).
 */
function findCycle(
  unprocessed: Set<string>,
  dependents: Map<string, Set<string>>,
): string[] {
  const onStack = new Set<string>();
  const stack: string[] = [];

  const start = [...unprocessed].sort()[0];
  const visited = new Set<string>();

  function dfs(node: string): string[] | null {
    if (onStack.has(node)) {
      const idx = stack.indexOf(node);
      return [...stack.slice(idx), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    for (const next of dependents.get(node) ?? []) {
      if (!unprocessed.has(next)) continue;
      const found = dfs(next);
      if (found) return found;
    }
    onStack.delete(node);
    stack.pop();
    return null;
  }

  return dfs(start) ?? [start];
}
