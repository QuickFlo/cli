import { assertEquals } from '@std/assert';
import { findFieldOptionsFetcher } from './mcp.ts';

/**
 * findFieldOptionsFetcher backs the `resolve_step_options` MCP tool: given a step's
 * JSON Schema and a field name, it locates that field's x-options-fetcher endpoint
 * (the AI then hits it for real ids instead of guessing). Mirrors the server tool.
 */

const ANALYTICS_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    dashboard: {
      type: 'string',
      'x-options-fetcher': { endpoint: '/api/step-options/analytics/dashboards' },
    },
    widget: {
      type: 'string',
      'x-options-fetcher': { endpoint: '/api/step-options/analytics/widgets' },
    },
    filters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            'x-options-fetcher': { endpoint: '/api/step-options/analytics/widget-fields' },
          },
          operator: { type: 'string' },
        },
      },
    },
    limit: { type: 'number' },
  },
};

Deno.test('findFieldOptionsFetcher: top-level field', () => {
  assertEquals(findFieldOptionsFetcher(ANALYTICS_QUERY_SCHEMA, 'dashboard'), {
    endpoint: '/api/step-options/analytics/dashboards',
  });
  assertEquals(findFieldOptionsFetcher(ANALYTICS_QUERY_SCHEMA, 'widget'), {
    endpoint: '/api/step-options/analytics/widgets',
  });
});

Deno.test('findFieldOptionsFetcher: field nested inside an array item, by bare name', () => {
  assertEquals(findFieldOptionsFetcher(ANALYTICS_QUERY_SCHEMA, 'field'), {
    endpoint: '/api/step-options/analytics/widget-fields',
  });
});

Deno.test('findFieldOptionsFetcher: field without a fetcher → null', () => {
  assertEquals(findFieldOptionsFetcher(ANALYTICS_QUERY_SCHEMA, 'limit'), null);
  assertEquals(findFieldOptionsFetcher(ANALYTICS_QUERY_SCHEMA, 'nope'), null);
});

Deno.test('findFieldOptionsFetcher: non-object schema → null', () => {
  assertEquals(findFieldOptionsFetcher(undefined, 'dashboard'), null);
  assertEquals(findFieldOptionsFetcher(null, 'dashboard'), null);
  assertEquals(findFieldOptionsFetcher('nope', 'dashboard'), null);
});

Deno.test('endpoint /api-prefix strip matches the apiFetch base convention', () => {
  // apiUrl carries the "/api" prefix, so the server-absolute endpoint is stripped.
  const stripped = '/api/step-options/analytics/dashboards'.replace(/^\/api(?=\/|$)/, '');
  assertEquals(stripped, '/step-options/analytics/dashboards');
});
