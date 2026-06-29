/**
 * `quickflo dashboards export <ref>` — export a dashboard to the portable JSON
 * format the UI's "Export" button produces and `dashboards import` consumes.
 *
 * Unlike `pull` (native, real ids, same-org), this format is source-agnostic:
 * real data-source ids and their `ds_<uuid>` query aliases are rewritten to
 * stable export ids (`ds-0`, `w-0`, `f-0`), and each source's schema travels
 * with it. Import then maps those export ids onto data sources in the target
 * org. Use this to move a dashboard between orgs.
 *
 * The rewrite logic mirrors apps/ui exportDashboardJson so exports interop with
 * the in-app importer.
 */

import { colors } from '@cliffy/ansi/colors';
import {
  type DashboardDataSource,
  type DashboardWithWidgets,
  fetchDashboard,
  fetchDataSources,
  resolveDashboardRef,
} from './dashboards-refs.ts';
import { info } from './log.ts';
import { openSession } from './session.ts';

function sourceAlias(id: string): string {
  return `ds_${id.replace(/-/g, '_')}`;
}

export function buildExportPayload(
  dash: DashboardWithWidgets,
  allSources: DashboardDataSource[],
): Record<string, unknown> {
  const widgets = dash.widgets ?? [];
  const sourcesById = new Map(allSources.map((s) => [s.id, s]));

  // 1. Unique data-source ids referenced by widgets (incl. join sources).
  const idSet = new Set<string>();
  for (const w of widgets) {
    idSet.add(w.dataSourceId);
    const joins = w.queryConfig?.['joins'] as Array<{ source?: string }> | undefined;
    for (const j of joins ?? []) {
      if (j.source) idSet.add(j.source);
    }
  }
  const dataSourceIds = [...idSet];

  // 2. Alias maps.
  const idToExportId = new Map<string, string>();
  const aliasToExportId = new Map<string, string>();
  dataSourceIds.forEach((id, i) => {
    const exportId = `ds-${i}`;
    idToExportId.set(id, exportId);
    aliasToExportId.set(sourceAlias(id), exportId);
  });

  // 3. Widget id map.
  const widgetIdToExportId = new Map<string, string>();
  widgets.forEach((w, i) => widgetIdToExportId.set(w.id, `w-${i}`));

  const rewriteAliasString = (value: string): string => {
    let result = value;
    for (const [realAlias, exportAlias] of aliasToExportId) {
      result = result.split(`${realAlias}.`).join(`${exportAlias}.`);
    }
    return result;
  };

  const rewriteAst = (node: Record<string, unknown>): Record<string, unknown> => {
    if (!node || typeof node !== 'object') return node;
    const result: Record<string, unknown> = { ...node };
    if (result['type'] === 'Identifier' && typeof result['name'] === 'string') {
      result['name'] = rewriteAliasString(result['name']);
    }
    for (const key of ['left', 'right', 'argument', 'test', 'consequent', 'alternate', 'callee']) {
      if (result[key] && typeof result[key] === 'object') {
        result[key] = rewriteAst(result[key] as Record<string, unknown>);
      }
    }
    if (Array.isArray(result['arguments'])) {
      result['arguments'] = (result['arguments'] as Record<string, unknown>[]).map(rewriteAst);
    }
    return result;
  };

  const rewriteQueryConfig = (qc: Record<string, unknown>): Record<string, unknown> => {
    const result = JSON.parse(JSON.stringify(qc)) as Record<string, unknown>;
    for (const key of ['measures', 'dimensions']) {
      const arr = result[key];
      if (Array.isArray(arr)) {
        result[key] = (arr as string[]).map((v) => rewriteAliasString(v));
      }
    }
    const timeDims = result['timeDimensions'];
    if (Array.isArray(timeDims)) {
      result['timeDimensions'] = (timeDims as Record<string, unknown>[]).map((td) => ({
        ...td,
        dimension: typeof td['dimension'] === 'string'
          ? rewriteAliasString(td['dimension'] as string)
          : td['dimension'],
      }));
    }
    const filters = result['filters'];
    if (Array.isArray(filters)) {
      result['filters'] = (filters as Record<string, unknown>[]).map((f) => ({
        ...f,
        member: typeof f['member'] === 'string'
          ? rewriteAliasString(f['member'] as string)
          : f['member'],
        dimension: typeof f['dimension'] === 'string'
          ? rewriteAliasString(f['dimension'] as string)
          : f['dimension'],
      }));
    }
    const joins = result['joins'];
    if (Array.isArray(joins)) {
      result['joins'] = (joins as Record<string, unknown>[]).map((j) => ({
        ...j,
        source: typeof j['source'] === 'string'
          ? (idToExportId.get(j['source'] as string) ?? j['source'])
          : j['source'],
        leftField: typeof j['leftField'] === 'string'
          ? rewriteAliasString(j['leftField'] as string)
          : j['leftField'],
        rightField: typeof j['rightField'] === 'string'
          ? rewriteAliasString(j['rightField'] as string)
          : j['rightField'],
      }));
    }
    const order = result['order'];
    if (order && typeof order === 'object' && !Array.isArray(order)) {
      const newOrder: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(order as Record<string, unknown>)) {
        newOrder[rewriteAliasString(key)] = value;
      }
      result['order'] = newOrder;
    }
    if (typeof result['filterFormula'] === 'string') {
      result['filterFormula'] = rewriteAliasString(result['filterFormula'] as string);
    }
    if (result['filterExpression'] && typeof result['filterExpression'] === 'object') {
      result['filterExpression'] = rewriteAst(
        result['filterExpression'] as Record<string, unknown>,
      );
    }
    return result;
  };

  const rewriteDisplayConfig = (
    displayConfig: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | undefined => {
    if (!displayConfig) return undefined;
    const result = JSON.parse(JSON.stringify(displayConfig)) as Record<string, unknown>;
    const tableConfig = result['tableConfig'] as Record<string, unknown> | undefined;
    if (tableConfig) {
      const defaultSort = tableConfig['defaultSort'] as Record<string, unknown> | undefined;
      if (defaultSort && typeof defaultSort['field'] === 'string') {
        defaultSort['field'] = rewriteAliasString(defaultSort['field'] as string);
      }
      const hiddenColumns = tableConfig['hiddenColumns'];
      if (Array.isArray(hiddenColumns)) {
        tableConfig['hiddenColumns'] = (hiddenColumns as string[]).map((c) =>
          rewriteAliasString(c)
        );
      }
    }
    const pivotConfig = result['pivotConfig'] as Record<string, unknown> | undefined;
    if (pivotConfig) {
      for (const key of ['rowDimension', 'columnDimension']) {
        if (typeof pivotConfig[key] === 'string') {
          pivotConfig[key] = rewriteAliasString(pivotConfig[key] as string);
        }
      }
      const cellDisplay = pivotConfig['cellDisplay'] as Record<string, unknown> | undefined;
      if (cellDisplay) {
        for (const key of ['numerator', 'denominator']) {
          if (typeof cellDisplay[key] === 'string') {
            cellDisplay[key] = rewriteAliasString(cellDisplay[key] as string);
          }
        }
      }
    }
    return result;
  };

  // 4. Filter id map.
  const filterIdMap = new Map<string, string>();
  const filterConfig = dash.filterConfig ?? [];
  filterConfig.forEach((fc, i) => filterIdMap.set(fc.id, `f-${i}`));

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    dashboard: {
      name: dash.name,
      description: dash.description,
      timezone: dash.timezone,
      layout: (dash.layout ?? []).map((item) => ({
        ...item,
        widgetId: widgetIdToExportId.get(item.widgetId) ?? item.widgetId,
      })),
      filterConfig: filterConfig.map((fc) => ({
        id: filterIdMap.get(fc.id) ?? fc.id,
        dataSourceId: idToExportId.get(fc.dataSourceId) ?? fc.dataSourceId,
        dimension: rewriteAliasString(fc.dimension),
        label: fc.label,
        bindings: fc.bindings?.map((b) => ({
          dataSourceId: idToExportId.get(b.dataSourceId) ?? b.dataSourceId,
          dimension: rewriteAliasString(b.dimension),
        })),
      })),
      filterDefaults: dash.filterDefaults
        ? Object.fromEntries(
          Object.entries(dash.filterDefaults).map(([k, v]) => [filterIdMap.get(k) ?? k, v]),
        )
        : undefined,
    },
    dataSources: dataSourceIds.map((id) => {
      const ds = sourcesById.get(id);
      return {
        exportId: idToExportId.get(id) ?? id,
        name: ds?.name ?? 'Unknown',
        schema: ds
          ? {
            name: ds.recordSchema.name,
            fields: ds.recordSchema.fields,
            calculatedFields: ds.recordSchema.calculatedFields?.map((cf) => ({
              name: cf.name,
              label: cf.label,
              type: cf.type,
              expression: cf.expression,
              formula: cf.formula,
              measure: cf.measure,
            })),
          }
          : { name: 'Unknown', fields: {} },
      };
    }),
    widgets: widgets.map((w) => ({
      exportWidgetId: widgetIdToExportId.get(w.id) ?? w.id,
      title: w.title,
      chartType: w.chartType,
      dataSourceExportId: idToExportId.get(w.dataSourceId) ?? w.dataSourceId,
      queryConfig: rewriteQueryConfig(w.queryConfig),
      displayConfig: rewriteDisplayConfig(w.displayConfig),
    })),
  };
}

export interface DashboardsExportOptions {
  ref: string;
  apiUrl?: string;
  orgId?: string;
  out?: string;
}

export async function runDashboardsExport(
  opts: DashboardsExportOptions,
): Promise<void> {
  const { client } = await openSession(opts, 'dashboards export');
  const resolved = await resolveDashboardRef(client, opts.ref);
  const dash = await fetchDashboard(client, resolved.id);
  const allSources = await fetchDataSources(client);
  const payload = buildExportPayload(dash, allSources);
  const json = JSON.stringify(payload, null, 2) + '\n';

  if (opts.out) {
    await Deno.writeTextFile(opts.out, json);
    info(`${colors.green('✓')} exported ${colors.bold(dash.name)} → ${opts.out}`);
    return;
  }
  console.log(json);
}
