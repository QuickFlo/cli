/**
 * `quickflo dashboards get <ref>` — fetch one dashboard (with its widgets) by
 * UUID or name and print the full definition as JSON. Pass `--sources` to also
 * embed the referenced data-source definitions, which is what `pull` writes.
 */

import { type ApiClient, apiFetch } from './api.ts';
import {
  type DashboardDataSource,
  type DashboardWithWidgets,
  fetchDataSources,
  resolveDashboardRef,
} from './dashboards-refs.ts';
import { openSession } from './session.ts';

export interface DashboardsGetOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  sources?: boolean;
}

/** Collect every data-source id a dashboard's widgets reference (including join sources). */
export function collectSourceIds(dash: DashboardWithWidgets): string[] {
  const ids = new Set<string>();
  for (const w of dash.widgets ?? []) {
    if (w.dataSourceId) ids.add(w.dataSourceId);
    const joins = w.queryConfig?.['joins'] as Array<{ source?: string }> | undefined;
    for (const j of joins ?? []) {
      if (j.source) ids.add(j.source);
    }
  }
  for (const fc of dash.filterConfig ?? []) {
    if (fc.dataSourceId) ids.add(fc.dataSourceId);
    for (const b of fc.bindings ?? []) {
      if (b.dataSourceId) ids.add(b.dataSourceId);
    }
  }
  return [...ids];
}

export async function loadReferencedSources(
  client: ApiClient,
  dash: DashboardWithWidgets,
): Promise<DashboardDataSource[]> {
  const wanted = new Set(collectSourceIds(dash));
  if (wanted.size === 0) return [];
  const all = await fetchDataSources(client);
  return all.filter((d) => wanted.has(d.id));
}

export async function runDashboardsGet(opts: DashboardsGetOptions): Promise<void> {
  const { client } = await openSession(opts, 'dashboards get');
  const resolved = await resolveDashboardRef(client, opts.ref);
  const dash = await apiFetch<DashboardWithWidgets>(
    client,
    `/dashboards/${resolved.id}`,
  );
  if (opts.sources) {
    const dataSources = await loadReferencedSources(client, dash);
    console.log(JSON.stringify({ ...dash, dataSources }, null, 2));
    return;
  }
  console.log(JSON.stringify(dash, null, 2));
}
