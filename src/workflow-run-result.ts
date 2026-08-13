/** Stable machine-readable result contract for a finite `workflows run`. */

export const WORKFLOW_RUN_RESULT_SCHEMA_VERSION = 1;

export interface CompactStepStatus {
  /** Compact execution status: s=success, f=failed, k=skipped, i=in progress. */
  s?: string;
  /** Step type. */
  t?: string;
  /** Nested statuses for control-flow steps. */
  n?: Record<string, CompactStepStatus>;
}

export interface ReturnStepRef {
  stepId: string;
  stepPath: string;
}

export interface WorkflowRunTrace {
  id: string;
  workflowId?: string;
  workflowName?: string;
  status?: string;
  durationMilliseconds?: number;
  error?: unknown;
  stepStatuses?: Record<string, CompactStepStatus>;
  stepPaths?: Record<string, string>;
}

export interface WorkflowRunResult {
  schemaVersion: 1;
  executionId: string;
  workflowId?: string;
  workflowName?: string;
  status: string;
  success: boolean;
  durationMilliseconds?: number;
  output?: unknown;
  steps?: Record<string, unknown>;
  error: unknown | null;
}

/**
 * Locate the one return branch that actually executed. Workflow definitions
 * may contain many core.return steps, but early-return semantics mean at most
 * one should have compact status `s` in a completed execution.
 */
export function findSuccessfulReturnStep(
  statuses: Record<string, CompactStepStatus> | undefined,
  paths: Record<string, string> | undefined,
): ReturnStepRef | undefined {
  if (!statuses) {
    return undefined;
  }

  for (const [stepId, status] of Object.entries(statuses)) {
    if (status.t === 'core.return' && status.s === 's') {
      return { stepId, stepPath: paths?.[stepId] ?? stepId };
    }

    const nested = findSuccessfulReturnStep(status.n, paths);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

/**
 * Mirror the platform's webhook response-body resolution without downloading
 * the full trace. The step-output endpoint already applies normal redaction.
 */
export function extractReturnResponseBody(returnStepOutput: unknown): unknown {
  if (
    !returnStepOutput || typeof returnStepOutput !== 'object' || Array.isArray(returnStepOutput)
  ) {
    return returnStepOutput;
  }

  const record = returnStepOutput as Record<string, unknown>;
  const webhookResponse = record['webhookResponse'];
  if (webhookResponse && typeof webhookResponse === 'object' && !Array.isArray(webhookResponse)) {
    return (webhookResponse as Record<string, unknown>)['body'];
  }

  if (record['body'] !== undefined) {
    return record['body'];
  }

  const {
    $input: _input,
    $meta: _meta,
    statusCode: _statusCode,
    formSubmission: _formSubmission,
    ...returnBody
  } = record;
  return returnBody;
}

export function buildWorkflowRunResult(
  trace: WorkflowRunTrace,
  output?: unknown,
  steps?: Record<string, unknown>,
): WorkflowRunResult {
  const status = trace.status ?? 'unknown';
  const result: WorkflowRunResult = {
    schemaVersion: WORKFLOW_RUN_RESULT_SCHEMA_VERSION,
    executionId: trace.id,
    workflowId: trace.workflowId,
    workflowName: trace.workflowName,
    status,
    success: status === 'success' || status === 'completed_with_errors',
    durationMilliseconds: trace.durationMilliseconds,
    output,
    steps,
    error: trace.error ?? null,
  };

  for (const key of Object.keys(result) as Array<keyof WorkflowRunResult>) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }

  return result;
}
