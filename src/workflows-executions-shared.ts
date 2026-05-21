/**
 * Shared helpers for the `workflows executions` command tree:
 *   - parseDuration: shorthand for `--since 30m` style flags
 *   - applyExecutionFilters: layer --workflow/--status/--since/--where onto a
 *     URLSearchParams the same way `executions list` does
 *   - fetchMatchingTraceIds: paginate /execution-traces and pluck IDs (used by
 *     bulk cancel/delete/restore when --workflow/--status/etc. is passed
 *     instead of explicit IDs)
 *   - bulkExecutionAction: chunked POST to a /execution-traces/bulk/<verb>
 *     endpoint, summing the server-reported counts
 */

import { type ApiClient, apiFetch } from './api.ts';
import { buildListParams, type ListOptions } from './filters.ts';
import { UserError } from './errors.ts';
import { resolveWorkflowRef } from './workflow-refs.ts';
import { type Lookup } from './refs.ts';

const DURATION_RE = /^(\d+)\s*(s|m|h|d)$/i;

export function parseDuration(s: string): number {
  const m = DURATION_RE.exec(s.trim());
  if (!m) throw new UserError(`Invalid --since "${s}". Expected forms: 30s, 5m, 2h, 1d.`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

export interface ExecutionFilterOptions extends ListOptions {
  workflow?: string;
  by?: Lookup;
  status?: string;
  since?: string;
}

/**
 * Apply the executions-list filter flags onto a URLSearchParams. The
 * `--workflow` ref is resolved against the API (UUID / SUID / name) and
 * folded down to a `workflowId` equality filter.
 */
export async function applyExecutionFilters(
  client: ApiClient,
  opts: ExecutionFilterOptions,
  params: URLSearchParams,
): Promise<void> {
  if (opts.workflow) {
    const wf = await resolveWorkflowRef(client, opts.workflow, opts.by);
    params.set('where[workflowId][$eq]', wf.id);
  }
  if (opts.status) {
    params.set('where[status][$eq]', opts.status);
  }
  if (opts.since) {
    const cutoff = new Date(Date.now() - parseDuration(opts.since)).toISOString();
    params.set('where[startedAt][$gte]', cutoff);
  }
}

interface TraceRow {
  id: string;
  workflowName?: string;
  status?: string;
  startedAt?: string;
}

interface TracesResponse {
  data: TraceRow[];
}

/** Maximum IDs per /execution-traces/bulk/<verb> request (server caps at 500). */
export const BULK_CHUNK_SIZE = 500;

/**
 * Paginate /execution-traces with the given filters and collect every matching
 * row. `cap` is an optional client-side stop (mirrors a user's `--limit`).
 */
export async function fetchMatchingTraces(
  client: ApiClient,
  opts: ExecutionFilterOptions,
  cap?: number,
): Promise<TraceRow[]> {
  const baseParams = buildListParams({ ...opts, limit: undefined });
  await applyExecutionFilters(client, opts, baseParams);

  const pageSize = 100;
  const rows: TraceRow[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams(baseParams);
    params.set('options[offset]', String(offset));
    params.set('options[limit]', String(pageSize));
    const res = await apiFetch<TracesResponse>(
      client,
      `/execution-traces?${params.toString()}`,
    );
    const batch = res.data ?? [];
    rows.push(...batch);
    if (cap !== undefined && rows.length >= cap) return rows.slice(0, cap);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * POST `ids` to /execution-traces/bulk/<verb> in chunks of BULK_CHUNK_SIZE,
 * summing the server-reported count. The server is honest about what changed
 * (e.g. cancel returns the number actually transitioned, not the input size),
 * so we faithfully propagate that.
 */
export async function bulkExecutionAction(
  client: ApiClient,
  endpoint:
    | '/execution-traces/bulk/cancel'
    | '/execution-traces/bulk/archive'
    | '/execution-traces/bulk/unarchive',
  ids: string[],
  countKey: 'cancelled' | 'archived' | 'unarchived',
): Promise<number> {
  let total = 0;
  for (const batch of chunk(ids, BULK_CHUNK_SIZE)) {
    const res = await apiFetch<Record<string, number>>(client, endpoint, {
      method: 'POST',
      body: JSON.stringify({ ids: batch }),
    });
    total += res[countKey] ?? 0;
  }
  return total;
}
