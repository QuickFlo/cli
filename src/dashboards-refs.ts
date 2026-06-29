/**
 * Shared types + ref resolution for the `dashboards` command group.
 *
 * A dashboard `<ref>` is a UUID or a name. The list endpoint (`GET
 * /dashboards`) returns the whole org-scoped set with no server-side filter,
 * so name lookup is a client-side match against that list. UUIDs are fetched
 * directly. Data sources resolve the same way against `GET
 * /dashboards/data-sources`.
 */

import { type ApiClient, apiFetch } from './api.ts';
import { UserError } from './errors.ts';
import { detectLookup, UUID_RE } from './refs.ts';

export interface DashboardLayoutItem {
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  [key: string]: unknown;
}

export interface DashboardFilterBinding {
  dataSourceId: string;
  dimension: string;
}

export interface DashboardFilterConfig {
  id: string;
  dataSourceId: string;
  dimension: string;
  label: string;
  bindings?: DashboardFilterBinding[];
  [key: string]: unknown;
}

export interface Dashboard {
  id: string;
  organizationId?: string;
  packageInstallId?: string | null;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  layout: DashboardLayoutItem[];
  filterConfig?: DashboardFilterConfig[] | null;
  filterDefaults?: Record<string, string[]> | null;
  timezone?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface DashboardWidget {
  id: string;
  organizationId?: string;
  dashboardId?: string;
  title: string;
  chartType: string;
  dataSourceId: string;
  queryConfig: Record<string, unknown>;
  displayConfig?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface DashboardWithWidgets extends Dashboard {
  widgets: DashboardWidget[];
}

export interface DataFeedField {
  type: 'string' | 'number' | 'boolean' | 'date';
  label: string;
  measure?: boolean;
  timeDimension?: boolean;
}

export interface CalculatedField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  expression: Record<string, unknown>;
  formula?: string;
  measure?: boolean;
}

export interface DataFeedRecordSchema {
  name: string;
  fields: Record<string, DataFeedField>;
  calculatedFields?: CalculatedField[];
}

export interface DashboardDataSource {
  id: string;
  organizationId?: string;
  packageInstallId?: string | null;
  name: string;
  type: string;
  connectionId?: string | null;
  connectionName?: string | null;
  dataStoreTableName: string;
  recordSchema: DataFeedRecordSchema;
  syncConfig?: Record<string, unknown>;
  enabled?: boolean;
  servingEngine?: string;
  schemaRefreshedAt?: string;
  [key: string]: unknown;
}

export async function fetchDashboardList(
  client: ApiClient,
): Promise<Dashboard[]> {
  return await apiFetch<Dashboard[]>(client, '/dashboards');
}

export async function fetchDashboard(
  client: ApiClient,
  id: string,
): Promise<DashboardWithWidgets> {
  return await apiFetch<DashboardWithWidgets>(client, `/dashboards/${id}`);
}

export async function fetchDataSources(
  client: ApiClient,
): Promise<DashboardDataSource[]> {
  return await apiFetch<DashboardDataSource[]>(
    client,
    '/dashboards/data-sources',
  );
}

/**
 * Resolve a dashboard `<ref>` (UUID or name) to its id. UUIDs hit the get
 * endpoint directly; names are matched against the org's dashboard list and
 * must be unambiguous.
 */
export async function resolveDashboardRef(
  client: ApiClient,
  ref: string,
): Promise<Dashboard> {
  if (detectLookup(ref) === 'id') {
    return await fetchDashboard(client, ref);
  }
  const all = await fetchDashboardList(client);
  const matches = all.filter((d) => d.name === ref);
  if (matches.length === 0) {
    throw new UserError(`No dashboard named "${ref}" in this org.`);
  }
  if (matches.length > 1) {
    throw new UserError(
      `"${ref}" matches ${matches.length} dashboards. Use the UUID instead:\n` +
        matches.map((d) => `  ${d.id}`).join('\n'),
    );
  }
  return matches[0];
}

/**
 * Resolve a data source `<ref>` (UUID or name) to its full record. Name
 * matches must be unambiguous within the org.
 */
export async function resolveDataSourceRef(
  client: ApiClient,
  ref: string,
): Promise<DashboardDataSource> {
  if (UUID_RE.test(ref)) {
    return await apiFetch<DashboardDataSource>(
      client,
      `/dashboards/data-sources/${ref}`,
    );
  }
  const all = await fetchDataSources(client);
  const matches = all.filter((d) => d.name === ref);
  if (matches.length === 0) {
    throw new UserError(`No data source named "${ref}" in this org.`);
  }
  if (matches.length > 1) {
    throw new UserError(
      `"${ref}" matches ${matches.length} data sources. Use the UUID instead:\n` +
        matches.map((d) => `  ${d.id}`).join('\n'),
    );
  }
  return matches[0];
}
