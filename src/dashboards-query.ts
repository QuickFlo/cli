/**
 * `quickflo dashboards query` / `meta` — run the analytics engine directly.
 *
 * This is what every widget runs under the hood: an AnalyticsQuery of
 * measures, dimensions, time dimensions and filters against one or more data
 * sources. For an agent it's the verification loop — author a widget's
 * queryConfig, run it here, confirm it returns rows before saving.
 *
 * Field refs are source-namespaced as `ds_<uuid-with-underscores>.<field>`.
 * When you pass `--source <ref>`, bare `--measure`/`--dimension` field names
 * (those without a `.`) are auto-prefixed with that source's alias; refs that
 * already carry a `ds_...` prefix pass through untouched, so multi-source/join
 * queries still work.
 */

import { apiFetch } from './api.ts';
import { resolveDataSourceRef } from './dashboards-refs.ts';
import { UserError } from './errors.ts';
import { openSession } from './session.ts';

interface AnalyticsQueryResult {
  data: Record<string, unknown>[];
  annotation?: Record<string, unknown>;
  query?: Record<string, unknown>;
  comparisonData?: Record<string, unknown>[];
  comparisonDateRange?: [string, string];
}

interface AnalyticsMetaEntry {
  name: string;
  title: string;
  measures: Array<{ name: string; title: string; type: string; calculated?: boolean }>;
  dimensions: Array<{ name: string; title: string; type: string; calculated?: boolean }>;
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new UserError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new UserError(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

function sourceAlias(id: string): string {
  return `ds_${id.replace(/-/g, '_')}`;
}

/** Prefix a bare field name with the source alias; pass through if already namespaced. */
function qualify(field: string, alias: string | undefined): string {
  if (!alias) return field;
  return field.includes('.') ? field : `${alias}.${field}`;
}

// ── query ───────────────────────────────────────────────────────────────

export interface DashboardsQueryOptions {
  apiUrl?: string;
  orgId?: string;
  file?: string;
  source?: string;
  measure?: string[];
  dimension?: string[];
  filter?: string[];
  timeDimension?: string;
  granularity?: string;
  dateRange?: string;
  order?: string;
  limit?: number;
  timezone?: string;
  raw?: boolean;
}

const FILTER_OPS: Record<string, string> = {
  eq: 'equals',
  ne: 'notEquals',
  contains: 'contains',
  ncontains: 'notContains',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  set: 'set',
  notset: 'notSet',
};

function buildQueryFromFlags(
  opts: DashboardsQueryOptions,
  alias: string | undefined,
): Record<string, unknown> {
  const query: Record<string, unknown> = {};

  const measures = (opts.measure ?? []).map((m) => qualify(m, alias));
  const dimensions = (opts.dimension ?? []).map((d) => qualify(d, alias));
  if (measures.length) query['measures'] = measures;
  if (dimensions.length) query['dimensions'] = dimensions;

  if (opts.timeDimension) {
    query['timeDimensions'] = [{
      dimension: qualify(opts.timeDimension, alias),
      ...(opts.granularity ? { granularity: opts.granularity } : {}),
      ...(opts.dateRange ? { dateRange: opts.dateRange } : {}),
    }];
  }

  if (opts.filter && opts.filter.length) {
    query['filters'] = opts.filter.map((expr) => {
      // field:op:value (value optional for set/notset)
      const firstColon = expr.indexOf(':');
      if (firstColon === -1) {
        throw new UserError(`Bad --filter "${expr}". Use field:op[:value].`);
      }
      const field = expr.slice(0, firstColon);
      const rest = expr.slice(firstColon + 1);
      const secondColon = rest.indexOf(':');
      const opKey = (secondColon === -1 ? rest : rest.slice(0, secondColon)).toLowerCase();
      const rawValue = secondColon === -1 ? undefined : rest.slice(secondColon + 1);
      const operator = FILTER_OPS[opKey];
      if (!operator) {
        throw new UserError(
          `Unknown filter op "${opKey}". One of: ${Object.keys(FILTER_OPS).join(', ')}.`,
        );
      }
      const values = rawValue === undefined ? undefined : rawValue.split(',').map((v) => v.trim());
      return {
        dimension: qualify(field, alias),
        operator,
        ...(values ? { values } : {}),
      };
    });
  }

  if (opts.order) {
    // field[:asc|desc], repeatable via comma
    const order: Record<string, string> = {};
    for (const spec of opts.order.split(',')) {
      const colon = spec.lastIndexOf(':');
      const field = colon === -1 ? spec : spec.slice(0, colon);
      const dir = colon === -1 ? 'asc' : spec.slice(colon + 1);
      order[qualify(field.trim(), alias)] = dir.toLowerCase() === 'desc' ? 'desc' : 'asc';
    }
    query['order'] = order;
  }

  if (opts.limit !== undefined) query['limit'] = opts.limit;
  if (opts.timezone) query['timezone'] = opts.timezone;
  return query;
}

export async function runDashboardsQuery(
  opts: DashboardsQueryOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards query');

  let alias: string | undefined;
  if (opts.source) {
    const ds = await resolveDataSourceRef(client, opts.source);
    alias = sourceAlias(ds.id);
  }

  let query: Record<string, unknown>;
  if (opts.file) {
    const parsed = await readJsonFile(opts.file);
    // Accept either a bare AnalyticsQuery or a { query } envelope.
    query = (parsed['query'] as Record<string, unknown>) ?? parsed;
  } else {
    query = buildQueryFromFlags(opts, alias);
  }

  if (
    !query['measures'] && !query['dimensions'] && !query['timeDimensions']
  ) {
    throw new UserError(
      'Empty query. Pass --measure/--dimension/--time-dimension (with --source), or -f <query.json>.',
    );
  }

  const result = await apiFetch<AnalyticsQueryResult>(
    client,
    '/dashboards/analytics/query',
    { method: 'POST', body: JSON.stringify({ query }) },
  );

  if (opts.raw) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result.data ?? [], null, 2));
}

// ── meta ────────────────────────────────────────────────────────────────

export interface DashboardsMetaOptions {
  apiUrl?: string;
  orgId?: string;
  json?: boolean;
}

export async function runDashboardsMeta(
  opts: DashboardsMetaOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards meta');
  const meta = await apiFetch<AnalyticsMetaEntry[]>(
    client,
    '/dashboards/analytics/meta',
  );

  if (opts.json) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  for (const src of meta) {
    console.log(`\n${src.title} (${src.name})`);
    for (const m of src.measures) {
      console.log(`  measure   ${m.name}${m.calculated ? ' *' : ''}  — ${m.title}`);
    }
    for (const d of src.dimensions) {
      console.log(`  dimension ${d.name}${d.calculated ? ' *' : ''}  — ${d.title}`);
    }
  }
}
