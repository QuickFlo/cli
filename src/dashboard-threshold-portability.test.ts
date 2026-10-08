import { assertEquals } from '@std/assert';
import { buildExportPayload } from './dashboards-export.ts';
import { buildFileShape } from './dashboards-pull.ts';
import { widgetPayload } from './dashboards-push.ts';
import { toValidatePayload } from './dashboards-check.ts';
import type { DashboardDataSource, DashboardWithWidgets } from './dashboards-refs.ts';

// Golden pair produced by workflows' canonical semantic reference remapper.
// Mirrored in libs/dashboards/src/test/threshold-portability.json there.
const fixture = JSON.parse(
  Deno.readTextFileSync(new URL('./test-fixtures/threshold-portability.json', import.meta.url)),
) as {
  source: DashboardDataSource;
  dashboard: DashboardWithWidgets;
  portableDisplay: Record<string, unknown>;
};
Deno.test('real-time thresholds survive native pull/check/push and portable export', () => {
  const original = structuredClone(fixture.dashboard);
  const pulled = buildFileShape(original, new Map([[fixture.source.id, fixture.source]]));
  const widget = (pulled['widgets'] as Array<Record<string, unknown>>)[0];
  assertEquals(widget['displayConfig'], original.widgets[0].displayConfig);
  assertEquals(widgetPayload(widget).displayConfig, original.widgets[0].displayConfig);
  assertEquals(
    toValidatePayload({ widgets: [widget] }).widgets[0].displayConfig,
    original.widgets[0].displayConfig,
  );
  const portable = buildExportPayload(original, [fixture.source]);
  const exported = (portable['widgets'] as Array<Record<string, unknown>>)[0];
  assertEquals(exported['displayConfig'], fixture.portableDisplay);
  assertEquals(original, fixture.dashboard);
});
