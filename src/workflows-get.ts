/**
 * `quickflo workflows get <ref>` — print one workflow's pushable JSON
 * definition to stdout. Pipe-friendly: `quickflo workflows get abcd > wf.json`.
 */

import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch } from './api.ts';
import { detectLookup, type Lookup } from './refs.ts';
import { openSession } from './session.ts';

interface WorkflowRecord {
  id: string;
  suid?: string;
  name: string;
  description?: string;
  definition?: {
    steps?: unknown[];
    initial?: Record<string, unknown>;
    environment?: string;
  };
}

interface WorkflowListResponse {
  data: WorkflowRecord[];
}

async function fetchOne(
  client: ApiClient,
  ref: string,
  by: Lookup,
): Promise<WorkflowRecord | null> {
  const params = new URLSearchParams();
  params.set('where[organizationId][$eq]', client.orgId);
  params.set(`where[${by}][$eq]`, ref);
  params.set('options[limit]', '1');
  const res = await apiFetch<WorkflowListResponse>(
    client,
    `/workflows?${params.toString()}`,
  );
  return res.data?.[0] ?? null;
}

function toPushableShape(wf: WorkflowRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { name: wf.name };
  if (wf.description) out['description'] = wf.description;
  if (wf.definition?.environment) {
    out['environment'] = wf.definition.environment;
  }
  if (wf.definition?.initial !== undefined) {
    out['initial'] = wf.definition.initial;
  }
  out['steps'] = wf.definition?.steps ?? [];
  return out;
}

export interface WorkflowsGetOptions {
  ref: string;
  by?: Lookup;
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runWorkflowsGet(
  opts: WorkflowsGetOptions,
): Promise<void> {
  const { client, org } = await openSession(opts, 'get');

  const by = opts.by ?? detectLookup(opts.ref);
  const wf = await fetchOne(client, opts.ref, by);
  if (!wf) {
    console.error(
      colors.red(`No workflow found where ${by}="${opts.ref}" in ${org.name}.`),
    );
    Deno.exit(1);
  }

  // Stdout is reserved for the JSON payload so `get <ref> > file.json` works.
  const output = opts.json ? wf : toPushableShape(wf);
  console.log(JSON.stringify(output, null, 2));
}
