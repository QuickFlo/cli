/**
 * Tests for the portable export payload. The schema snapshot that travels
 * with each data source is what `dashboards import` reconciles onto the
 * target org's sources — if a computed-field family is missing here, import
 * cannot carry it and widgets referencing it break cross-org.
 */

import { assertEquals } from '@std/assert';
import { buildExportPayload } from './dashboards-export.ts';
import type { DashboardDataSource, DashboardWithWidgets } from './dashboards-refs.ts';

const SRC_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const source: DashboardDataSource = {
  id: SRC_ID,
  name: 'Five9 Call Log',
  type: 'data-store',
  dataStoreTableName: 'five9_call_log',
  recordSchema: {
    name: 'five9-call-log',
    fields: {
      DISPOSITION: { type: 'string', label: 'Disposition' },
      TIMESTAMP: { type: 'date', label: 'Timestamp', timeDimension: true },
    },
    calculatedFields: [{
      id: 'cf-1',
      name: 'contacted',
      label: 'Contacted',
      type: 'number',
      expression: { type: 'Literal', value: 1 },
      formula: 'IF(1, 1, 0)',
      measure: true,
    }],
    windowDimensions: [{
      id: 'wd-1',
      name: 'attempt',
      label: 'Attempt',
      function: 'row_number',
      partitionBy: ['DNIS'],
      orderBy: 'TIMESTAMP',
      direction: 'asc',
      semantic: 'lifetime',
    }],
  },
};

const dash: DashboardWithWidgets = {
  id: 'dash-1',
  name: 'Pack',
  layout: [],
  widgets: [{
    id: 'w1',
    title: 'By Attempt',
    chartType: 'bar',
    dataSourceId: SRC_ID,
    queryConfig: { measures: [`ds_${SRC_ID.replace(/-/g, '_')}.contactedSum`] },
  }],
};

Deno.test('schema snapshot carries both computed-field families, without server ids', () => {
  const payload = buildExportPayload(dash, [source]);
  const sources = payload['dataSources'] as Array<
    { schema: { calculatedFields?: unknown[]; windowDimensions?: unknown[] } }
  >;
  assertEquals(sources.length, 1);
  assertEquals(sources[0].schema.calculatedFields, [{
    name: 'contacted',
    label: 'Contacted',
    type: 'number',
    expression: { type: 'Literal', value: 1 },
    formula: 'IF(1, 1, 0)',
    measure: true,
  }]);
  assertEquals(sources[0].schema.windowDimensions, [{
    name: 'attempt',
    label: 'Attempt',
    function: 'row_number',
    partitionBy: ['DNIS'],
    orderBy: 'TIMESTAMP',
    direction: 'asc',
    semantic: 'lifetime',
  }]);
});
