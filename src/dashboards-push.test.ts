import { assertEquals } from '@std/assert';
import { widgetPayload } from './dashboards-push.ts';

Deno.test('native push preserves nested pivot measure display metadata', () => {
  const displayConfig = {
    pivotConfig: {
      measureFormats: { count: 'number', serviceLevelPercentAvg: 'percentValue' },
      heatmapTones: { count: 'neutral', serviceLevelPercentAvg: 'positive' },
    },
  };

  const payload = widgetPayload({
    title: 'Inbound Campaign Stats',
    chartType: 'pivot-table',
    dataSourceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    queryConfig: { measures: ['count', 'serviceLevelPercentAvg'] },
    displayConfig,
  });

  assertEquals(payload['displayConfig'], displayConfig);
});
