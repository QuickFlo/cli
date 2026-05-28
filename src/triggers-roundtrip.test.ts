/**
 * Roundtrip tests for the trigger pull → push serialization. These exercise
 * the pure helpers (no network): the pull-side `buildFileShape` and the
 * push-side `buildPayload`, asserting that server-managed fields are stripped,
 * the workflow link is name-based, and secrets / runtime state never leak.
 */

import { assertEquals } from '@std/assert';
import { buildFileShape, type RemoteTrigger } from './triggers-pull.ts';
import { buildPayload, type TriggerFile } from './triggers-push.ts';

function webhookTrigger(): RemoteTrigger {
  return {
    id: 'b1c2d3e4-0000-0000-0000-000000000001',
    workflowId: 'aaaaaaaa-0000-0000-0000-000000000001',
    organizationId: 'org-1',
    packageInstallId: null,
    orgSuid: 'acme',
    type: 'webhook',
    name: 'order-received',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    lastTriggeredAt: '2026-01-03T00:00:00Z',
    lastTriggerExecutionId: 'exec-9',
    triggerCount: 42,
    // Computed-in-DTO fields the API echoes back:
    webhookUrl: 'https://w.example.com/w/@acme/order-received',
    config: {
      webhook: {
        method: 'POST',
        authType: 'token',
        timeout: 30000,
        exposeErrors: true,
        // Server-owned, must not land on disk:
        path: 'w_abc123def456',
        secret: 'whs_supersecretplaintext',
      },
    },
  };
}

Deno.test('pull: webhook file shape is name-keyed and secret-free', () => {
  const { shape: file } = buildFileShape(webhookTrigger(), 'Order Handler');

  // Association is by workflow NAME, not the server UUID.
  assertEquals(file['workflow'], 'Order Handler');
  assertEquals('workflowId' in file, false);

  // id is preserved for same-org rename-stable matching.
  assertEquals(file['id'], 'b1c2d3e4-0000-0000-0000-000000000001');

  // User-authored fields survive.
  assertEquals(file['type'], 'webhook');
  assertEquals(file['name'], 'order-received');
  assertEquals(file['enabled'], true);

  // Server-managed top-level fields are gone.
  for (
    const k of [
      'organizationId',
      'packageInstallId',
      'orgSuid',
      'createdAt',
      'updatedAt',
      'lastTriggeredAt',
      'lastTriggerExecutionId',
      'triggerCount',
      'webhookUrl',
    ]
  ) {
    assertEquals(k in file, false, `expected ${k} to be stripped`);
  }

  // Secret + auto-generated path never touch disk; the rest of webhook config does.
  const webhook = (file['config'] as Record<string, Record<string, unknown>>)['webhook'];
  assertEquals('secret' in webhook, false);
  assertEquals('path' in webhook, false);
  assertEquals(webhook['method'], 'POST');
  assertEquals(webhook['authType'], 'token');
  assertEquals(webhook['timeout'], 30000);
});

Deno.test('pull: does not mutate the source trigger', () => {
  const src = webhookTrigger();
  buildFileShape(src, 'Order Handler');
  // The original (and its nested config) is untouched — structuredClone guard.
  assertEquals(
    (src.config as Record<string, Record<string, unknown>>)['webhook']['secret'],
    'whs_supersecretplaintext',
  );
});

Deno.test('pull: schedule trigger drops QStash runtime state', () => {
  const trigger: RemoteTrigger = {
    id: 'sched-1',
    workflowId: 'wf-1',
    type: 'schedule',
    name: 'nightly-sync',
    config: {
      schedule: {
        cron: '0 9 * * *',
        timezone: 'America/New_York',
        initialData: { reportType: 'daily' },
        qstashScheduleId: 'scd_xyz',
        nextRun: '2026-06-01T09:00:00Z',
      },
    },
  };
  const { shape: file } = buildFileShape(trigger, 'Nightly Report');
  const schedule = (file['config'] as Record<string, Record<string, unknown>>)['schedule'];
  assertEquals(schedule['cron'], '0 9 * * *');
  assertEquals(schedule['timezone'], 'America/New_York');
  assertEquals(schedule['initialData'], { reportType: 'daily' });
  assertEquals('qstashScheduleId' in schedule, false);
  assertEquals('nextRun' in schedule, false);
});

Deno.test('push: payload omits id/workflow and re-strips secret', () => {
  // Simulate a file that still carries a secret (e.g. hand-edited) — push must
  // never forward it, so create autogenerates and update leaves it untouched.
  const file: TriggerFile = {
    id: 'trig-1',
    workflow: 'Order Handler',
    type: 'webhook',
    name: 'order-received',
    enabled: false,
    config: {
      webhook: {
        method: 'POST',
        authType: 'token',
        path: 'leftover-path',
        secret: 'should-not-be-sent',
      },
    },
  };
  const payload = buildPayload(file);

  // Association keys are resolved via the request path, not the body.
  assertEquals('id' in payload, false);
  assertEquals('workflow' in payload, false);
  assertEquals('workflowId' in payload, false);

  // Type + user fields are sent.
  assertEquals(payload['type'], 'webhook');
  assertEquals(payload['name'], 'order-received');
  assertEquals(payload['enabled'], false);

  const webhook = (payload['config'] as Record<string, Record<string, unknown>>)['webhook'];
  assertEquals('secret' in webhook, false);
  assertEquals('path' in webhook, false);
  assertEquals(webhook['method'], 'POST');
});

Deno.test('roundtrip: pull output feeds straight into push payload', () => {
  const { shape } = buildFileShape(webhookTrigger(), 'Order Handler');
  const payload = buildPayload(shape as unknown as TriggerFile);

  // The workflow name carried through the file is dropped from the wire body
  // (it's resolved to an id in the request path instead).
  assertEquals('workflow' in payload, false);
  assertEquals(payload['type'], 'webhook');
  assertEquals(payload['name'], 'order-received');
  assertEquals(payload['enabled'], true);
  const webhook = (payload['config'] as Record<string, Record<string, unknown>>)['webhook'];
  assertEquals('secret' in webhook, false);
  assertEquals(webhook['authType'], 'token');
});
