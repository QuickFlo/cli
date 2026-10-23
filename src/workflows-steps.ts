/**
 * `quickflo workflows steps list|get|library` — discovery surface that wraps
 * `/workflows/steps/info`. Useful for humans browsing what's available and
 * for AI agents that need machine-readable schemas before authoring a
 * workflow.
 */

import { colors } from '@cliffy/ansi/colors';
import { apiFetch } from './api.ts';
import { openSession } from './session.ts';
import { UserError } from './errors.ts';

interface StepInfo {
  stepType: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  exampleInput?: unknown;
  ui?: { category?: string; displayName?: string };
}

// The server (`GET /workflows/steps/info`) wraps the array under `steps`.
// Tolerate `data` and a bare array too, in case the endpoint shape shifts.
type StepInfoResponse = StepInfo[] | { steps?: StepInfo[]; data?: StepInfo[] };

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function fetchAll(client: Parameters<typeof apiFetch>[0]): Promise<StepInfo[]> {
  const res = await apiFetch<StepInfoResponse>(client, `/workflows/steps/info`);
  return Array.isArray(res) ? res : (res.steps ?? res.data ?? []);
}

export interface WorkflowsStepsListOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsStepsList(opts: WorkflowsStepsListOptions): Promise<void> {
  const { client } = await openSession(opts, 'workflows steps list');
  const items = await fetchAll(client);
  items.sort((a, b) => {
    const ac = a.ui?.category ?? '';
    const bc = b.ui?.category ?? '';
    if (ac !== bc) return ac.localeCompare(bc);
    return a.stepType.localeCompare(b.stepType);
  });
  if (opts.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log(colors.dim('(no step types returned)'));
    return;
  }
  const typeWidth = Math.min(28, Math.max(8, ...items.map((s) => s.stepType.length)));
  const catWidth = Math.min(16, Math.max(8, ...items.map((s) => (s.ui?.category ?? '').length)));
  const header = [
    'STEP'.padEnd(typeWidth),
    'CATEGORY'.padEnd(catWidth),
    'DESCRIPTION',
  ].join('  ');
  console.log(colors.bold(header));
  console.log(colors.dim('─'.repeat(header.length)));
  for (const s of items) {
    console.log([
      truncate(s.stepType, typeWidth).padEnd(typeWidth),
      truncate(s.ui?.category ?? '—', catWidth).padEnd(catWidth),
      truncate(s.description ?? '', 72),
    ].join('  '));
  }
}

export interface WorkflowsStepsGetOptions {
  type: string;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsStepsGet(opts: WorkflowsStepsGetOptions): Promise<void> {
  const { client } = await openSession(opts, 'workflows steps get');
  const items = await fetchAll(client);
  const match = items.find((s) => s.stepType === opts.type);
  if (!match) {
    throw new UserError(`No step type "${opts.type}" in the catalog.`);
  }
  if (opts.json) {
    console.log(JSON.stringify(match, null, 2));
    return;
  }
  console.log(colors.bold(`stepType: ${match.stepType}`));
  if (match.ui?.category) console.log(`  category:    ${match.ui.category}`);
  if (match.ui?.displayName) console.log(`  displayName: ${match.ui.displayName}`);
  if (match.description) console.log(`  description: ${match.description}`);
  if (match.inputSchema) {
    console.log('');
    console.log(colors.bold('inputSchema:'));
    console.log(JSON.stringify(match.inputSchema, null, 2));
  }
  if (match.outputSchema) {
    console.log('');
    console.log(colors.bold('outputSchema:'));
    console.log(JSON.stringify(match.outputSchema, null, 2));
  }
  if (match.exampleInput !== undefined) {
    console.log('');
    console.log(colors.bold('exampleInput:'));
    console.log(JSON.stringify(match.exampleInput, null, 2));
  }
}

interface WorkflowLibraryStep {
  workflowId: string;
  workflowName: string;
  displayName: string;
  group?: string;
  description?: string;
  icon: string | null;
}

export interface WorkflowStepLibrary {
  workspace: Array<WorkflowLibraryStep & { revision: string }>;
  items: Array<
    WorkflowLibraryStep & {
      packageInstallId: string;
      packageName: string;
      packageSlug: string;
      packageVersion: string;
    }
  >;
  unavailable: Array<{
    packageInstallId: string;
    packageName: string;
    workflowName: string;
  }>;
}

// Discovery, version selection, and access checks belong to the server.
export async function fetchWorkflowStepLibrary(
  client: Parameters<typeof apiFetch>[0],
): Promise<WorkflowStepLibrary> {
  return await apiFetch<WorkflowStepLibrary>(client, '/workflows/library/steps');
}

export async function runWorkflowsStepsLibrary(opts: WorkflowsStepsListOptions): Promise<void> {
  const { client } = await openSession(opts, 'workflows steps library');
  const library = await fetchWorkflowStepLibrary(client);
  if (opts.json) {
    console.log(JSON.stringify(library, null, 2));
    return;
  }
  const rows = [
    ...library.workspace.map((step) => ({ step, folder: 'Workspace' })),
    ...library.items.map((step) => ({
      step,
      folder: `Packages / ${step.packageName} (${step.packageVersion})`,
    })),
  ];
  for (const { step, folder } of rows) {
    const path = [folder, step.group, step.displayName].filter(Boolean).join(' / ');
    console.log(`${path}  ${step.workflowId}  (${step.workflowName})`);
  }
  for (const step of library.unavailable) {
    console.log(
      `Unavailable: ${step.packageName} / ${step.workflowName} (install ${step.packageInstallId})`,
    );
  }
  if (rows.length === 0 && library.unavailable.length === 0) {
    console.log(colors.dim('(no workflow steps available)'));
  }
}
