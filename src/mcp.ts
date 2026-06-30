/**
 * `quickflo mcp` — a stdio MCP server exposing QuickFlo's workflow-building
 * surface to any MCP host (Claude Code, Claude Desktop, Cursor).
 *
 * THIN by design: every tool is one call to an existing HTTP endpoint via
 * `apiFetch`, or the shared `saveWorkflow` helper. No validation/schema logic
 * lives here — the server is the source of truth (mirrors the CLI).
 *
 * Tools: list_steps, get_step_schema, list_connections, resolve_step_options
 * (read/introspect), validate_workflow (the compiler), save_workflow_draft (persist as a draft —
 * NO triggers, NO execution). The MCP host's per-call approval is the
 * guardrail on the one mutating tool.
 *
 * CRITICAL: MCP stdio uses STDOUT for JSON-RPC. Nothing in a tool path may
 * write to stdout. Auth is resolved ONCE at startup (banner/errors go to
 * stderr); tool handlers only return values, which the SDK serializes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type ReadResourceRequest,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { colors } from '@cliffy/ansi/colors';
import { type ApiClient, apiFetch, type ResolvedOrg, resolveOrganization } from './api.ts';
import { probeToken, resolveSession } from './auth.ts';
import { saveWorkflow, type WorkflowDefinition } from './workflows-save.ts';
import { AGENT_GUIDE, BUILDING_WORKFLOWS } from './skill-guides.ts';

const SERVER_NAME = 'quickflo';
const SERVER_VERSION = '0.1.0';

// Concise, eager: shown to the model on connect. The full guides ride in
// resources (on-demand), so this stays short.
const SERVER_INSTRUCTIONS =
  'QuickFlo workflow tools — build, validate, and save workflows from your host.\n' +
  'Loop: discover steps (list_steps / get_step_schema) → write the definition → ' +
  'validate_workflow after every edit, fix until ok → save_workflow_draft ' +
  '(creates a draft; no triggers, no execution).\n' +
  'When get_step_schema shows a field has an "x-options-fetcher" (dynamic options, e.g. the ' +
  "analytics steps' dashboard/widget/field), call resolve_step_options to fetch real ids " +
  'instead of guessing — resolve parents first and pass them in params for dependent fields.\n' +
  'Read the `quickflo://agent-guide` resource for the full operating guide (auth, ' +
  'execution debugging, search-attribute filtering) and `quickflo://building-workflows` ' +
  'for the authoring guide (LiquidJS, step output fields, the tool-workflow contract).\n' +
  'Validation warnings (e.g. a connection that does not exist yet) are advisory, not blocking.';

// Embedded skill guides served as resources (see skill/bundle-guides.ts).
const RESOURCES = [
  {
    uri: 'quickflo://agent-guide',
    name: 'QuickFlo agent guide',
    description:
      'Operating guide: command surface, auth/org rules, the validate loop, execution debugging, search attributes.',
    mimeType: 'text/markdown',
    text: AGENT_GUIDE,
  },
  {
    uri: 'quickflo://building-workflows',
    name: 'QuickFlo workflow-authoring guide',
    description:
      'Deep guide for authoring/editing workflow JSON: definition format, LiquidJS, control flow, tool-workflow contract.',
    mimeType: 'text/markdown',
    text: BUILDING_WORKFLOWS,
  },
];

interface StepInfo {
  stepType: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  exampleInput?: unknown;
  ui?: { category?: string };
}

interface ConnectionRow {
  name: string;
  type: string;
}

// Auth is resolved once at startup; tool calls reuse the cache. Clients are
// cached per resolved org so a tool's optional `org` arg is cheap.
interface ResolvedAuth {
  apiUrl: string;
  token: string;
  orgs: ResolvedOrg[];
}
let auth: ResolvedAuth | null = null;
const clientByOrg = new Map<string, ApiClient>();

function getClient(orgArg?: string): ApiClient {
  if (!auth) throw new Error('MCP server auth not initialized.');
  const orgInput = orgArg || Deno.env.get('QF_ORG') || undefined;
  let org: ResolvedOrg;
  if (orgInput) {
    org = resolveOrganization(auth.orgs, orgInput);
  } else if (auth.orgs.length === 1) {
    org = auth.orgs[0];
  } else {
    const opts = auth.orgs.map((o) => o.suid ?? o.id).join(', ');
    throw new Error(
      `This token can access ${auth.orgs.length} orgs; pass "org" (or set QF_ORG). Options: ${opts}`,
    );
  }
  const cached = clientByOrg.get(org.id);
  if (cached) return cached;
  const client: ApiClient = {
    apiUrl: auth.apiUrl,
    orgId: org.id,
    accessToken: auth.token,
  };
  clientByOrg.set(org.id, client);
  return client;
}

function argString(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = args?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizeSteps(res: StepInfo[] | { steps?: StepInfo[]; data?: StepInfo[] }): StepInfo[] {
  if (Array.isArray(res)) return res;
  return res.steps ?? res.data ?? [];
}

/**
 * Walk a step's JSON Schema to find the `x-options-fetcher` endpoint for a named
 * field. Searches top-level properties first, then recurses into nested objects
 * and array `items` (so a filter-row field like `filters[].field` is found by
 * its bare name). Returns the first match. Mirrors the server's AI-builder tool.
 */
export function findFieldOptionsFetcher(
  schema: unknown,
  fieldName: string,
): { endpoint: string } | null {
  if (!schema || typeof schema !== 'object') return null;
  const node = schema as Record<string, unknown>;
  const props = node['properties'];
  if (props && typeof props === 'object') {
    const propsRec = props as Record<string, unknown>;
    const target = propsRec[fieldName];
    if (target && typeof target === 'object') {
      const fetcher = (target as Record<string, unknown>)['x-options-fetcher'];
      if (fetcher && typeof fetcher === 'object') {
        const endpoint = (fetcher as Record<string, unknown>)['endpoint'];
        if (typeof endpoint === 'string') return { endpoint };
      }
    }
    for (const key of Object.keys(propsRec)) {
      const found = findFieldOptionsFetcher(propsRec[key], fieldName);
      if (found) return found;
    }
  }
  const items = node['items'];
  if (items) {
    const found = findFieldOptionsFetcher(items, fieldName);
    if (found) return found;
  }
  return null;
}

// --- tool definitions (JSON Schema; no zod import → no version skew) ---
const TOOLS = [
  {
    name: 'list_steps',
    description:
      "List available workflow step types (the building blocks). Returns compact { stepType, description, category }. Call get_step_schema for a step's full input/output schema before configuring it.",
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by step category (e.g. core, ai, data).' },
        search: {
          type: 'string',
          description: 'Case-insensitive substring match on stepType/description.',
        },
        org: {
          type: 'string',
          description: 'Org SUID/UUID. Defaults to QF_ORG or the only accessible org.',
        },
      },
    },
  },
  {
    name: 'get_step_schema',
    description:
      'Get the full input schema, output schema, and example input for one step type. Use this to know exactly what fields a step takes and what it outputs before writing it.',
    inputSchema: {
      type: 'object',
      properties: {
        stepType: { type: 'string', description: 'The step type, e.g. "core.http".' },
        org: { type: 'string' },
      },
      required: ['stepType'],
    },
  },
  {
    name: 'list_connections',
    description:
      'List the connections (auth credentials) configured in the org, as { name, type }. Reference one in step config via {{ $connections.<name> }}.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by connection type (e.g. smtp, five9).' },
        org: { type: 'string' },
      },
    },
  },
  {
    name: 'resolve_step_options',
    description:
      'Resolve the real, selectable options for a step field whose values come from a dynamic source ' +
      '(get_step_schema shows it has an "x-options-fetcher"). Call this after get_step_schema whenever a ' +
      "field has dynamic options, so you reference REAL ids instead of guessing — e.g. the analytics steps' " +
      'dashboard, widget, and filter field. For dependent fields, pass parent selections in params: resolve ' +
      '"dashboard" first, then "widget" with params { dashboard: "<id>" }, then a filter "field" with params ' +
      '{ widget: "<id>" }. Returns { items: [{ value, label, description }], hint? }; value is the id/ref to use. ' +
      "If the field's options depend on a connection that is an $env template (e.g. a TTS/LLM voice/model list " +
      'whose connection is "{{ $env.OPENAI }}"), also pass `environment` (an environment name) so it resolves; ' +
      'defaults to the QF_ENV env var.',
    inputSchema: {
      type: 'object',
      properties: {
        stepType: { type: 'string', description: 'The step type, e.g. "analytics.query".' },
        field: {
          type: 'string',
          description:
            'The field whose options to resolve, e.g. "dashboard", "widget", or a filter-row "field".',
        },
        params: {
          type: 'object',
          description:
            'Values for fields this one depends on, e.g. { dashboard: "<id>" } when resolving "widget", ' +
            'or { provider: "openai", connection: "<name>" } for a TTS voice list.',
          additionalProperties: { type: 'string' },
        },
        environment: {
          type: 'string',
          description:
            'Environment name used to resolve $env-templated connection names in the lookup. ' +
            'Only needed when the field depends on such a connection. Defaults to QF_ENV.',
        },
        org: { type: 'string' },
      },
      required: ['stepType', 'field'],
    },
  },
  {
    name: 'validate_workflow',
    description:
      'Validate a workflow definition WITHOUT saving or running it (the compiler). Returns { ok, errors, warnings }: undefined/forward step references, unknown filters, unknown output fields, tier issues, and missing connections (warning). Run this after every edit; fix until ok. It never flags templated values on type grounds.',
    inputSchema: {
      type: 'object',
      properties: {
        definition: {
          type: 'object',
          description:
            'The full workflow definition (top-level name + steps[], optional initial/options).',
        },
        org: { type: 'string' },
      },
      required: ['definition'],
    },
  },
  {
    name: 'save_workflow_draft',
    description:
      'Create or update a workflow as a draft (org-owned). Does NOT create triggers and does NOT execute it. The server validates on save and rejects errors. Upserts by name (or by id if the definition has one). Returns { id, name, action, validationWarnings }.',
    inputSchema: {
      type: 'object',
      properties: {
        definition: {
          type: 'object',
          description: 'The full workflow definition (must include name + steps).',
        },
        org: { type: 'string' },
      },
      required: ['definition'],
    },
  },
];

async function handleTool(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  switch (name) {
    case 'list_steps': {
      const client = getClient(argString(args, 'org'));
      const res = await apiFetch<StepInfo[] | { steps?: StepInfo[]; data?: StepInfo[] }>(
        client,
        '/workflows/steps/info',
      );
      let steps = normalizeSteps(res);
      const category = argString(args, 'category')?.toLowerCase();
      const search = argString(args, 'search')?.toLowerCase();
      if (category) steps = steps.filter((s) => s.ui?.category?.toLowerCase() === category);
      if (search) {
        steps = steps.filter(
          (s) =>
            s.stepType.toLowerCase().includes(search) ||
            (s.description ?? '').toLowerCase().includes(search),
        );
      }
      return steps.map((s) => ({
        stepType: s.stepType,
        description: s.description,
        category: s.ui?.category,
      }));
    }
    case 'get_step_schema': {
      const stepType = argString(args, 'stepType');
      if (!stepType) throw new Error('stepType is required.');
      const client = getClient(argString(args, 'org'));
      const res = await apiFetch<StepInfo[] | { steps?: StepInfo[]; data?: StepInfo[] }>(
        client,
        '/workflows/steps/info',
      );
      const step = normalizeSteps(res).find((s) => s.stepType === stepType);
      if (!step) throw new Error(`Unknown step type "${stepType}".`);
      return {
        stepType: step.stepType,
        description: step.description,
        inputSchema: step.inputSchema,
        outputSchema: step.outputSchema,
        exampleInput: step.exampleInput,
      };
    }
    case 'list_connections': {
      const client = getClient(argString(args, 'org'));
      const params = new URLSearchParams();
      params.set('where[organizationId][$eq]', client.orgId);
      params.set('options[limit]', '200');
      const res = await apiFetch<{ data?: ConnectionRow[] } | ConnectionRow[]>(
        client,
        `/connections?${params.toString()}`,
      );
      let rows = Array.isArray(res) ? res : res.data ?? [];
      const type = argString(args, 'type');
      if (type) rows = rows.filter((c) => c.type === type);
      return rows.map((c) => ({ name: c.name, type: c.type }));
    }
    case 'resolve_step_options': {
      const stepType = argString(args, 'stepType');
      if (!stepType) throw new Error('stepType is required.');
      const field = argString(args, 'field');
      if (!field) throw new Error('field is required.');
      const client = getClient(argString(args, 'org'));
      const res = await apiFetch<StepInfo[] | { steps?: StepInfo[]; data?: StepInfo[] }>(
        client,
        '/workflows/steps/info',
      );
      const step = normalizeSteps(res).find((s) => s.stepType === stepType);
      if (!step) throw new Error(`Unknown step type "${stepType}".`);
      const fetcher = findFieldOptionsFetcher(step.inputSchema, field);
      if (!fetcher) {
        throw new Error(
          `Field "${field}" on ${stepType} has no dynamic options (no x-options-fetcher). Fill it directly from the schema.`,
        );
      }
      // The schema endpoint is server-absolute ("/api/step-options/..."); apiUrl
      // already carries the "/api" prefix, so strip the leading segment.
      const path = fetcher.endpoint.replace(/^\/api(?=\/|$)/, '');
      const search = new URLSearchParams();
      const rawParams = args?.['params'];
      if (rawParams && typeof rawParams === 'object') {
        for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
          if (typeof v === 'string' && v.length > 0) search.set(k, v);
        }
      }
      // Mirror the UI options-fetcher: forward an environment name so the
      // endpoint can resolve $env-templated connection names. Explicit arg
      // wins; otherwise fall back to QF_ENV (like org falls back to QF_ORG).
      const environment = argString(args, 'environment') || Deno.env.get('QF_ENV') || undefined;
      if (environment && !search.has('environment')) search.set('environment', environment);
      const qs = search.toString();
      const result = await apiFetch<{ items?: unknown[]; hint?: string }>(
        client,
        qs ? `${path}?${qs}` : path,
      );
      return {
        items: result.items ?? [],
        ...(result.hint ? { hint: result.hint } : {}),
      };
    }
    case 'validate_workflow': {
      const definition = args?.['definition'];
      if (!definition || typeof definition !== 'object') {
        throw new Error('definition (object) is required.');
      }
      const client = getClient(argString(args, 'org'));
      return await apiFetch(client, '/workflows/validate', {
        method: 'POST',
        body: JSON.stringify(definition),
      });
    }
    case 'save_workflow_draft': {
      const definition = args?.['definition'];
      if (!definition || typeof definition !== 'object') {
        throw new Error('definition (object) is required.');
      }
      const client = getClient(argString(args, 'org'));
      const { workflow, action } = await saveWorkflow(
        client,
        definition as WorkflowDefinition,
      );
      return {
        id: workflow.id,
        name: workflow.name,
        action,
        validationWarnings: (workflow as { validationWarnings?: unknown }).validationWarnings ?? [],
      };
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

export async function runMcp(): Promise<void> {
  // Resolve auth ONCE, at startup, before binding stdio. A server with no
  // usable credentials can't function, so failing fast here (to stderr) is
  // correct. resolveSession itself exits the process on missing creds.
  try {
    const { token, apiUrl } = await resolveSession();
    const { organizations } = await probeToken(apiUrl, token);
    if (organizations.length === 0) {
      throw new Error(
        'Token has no accessible organizations. Run `quickflo auth login`.',
      );
    }
    auth = { apiUrl, token, orgs: organizations };
  } catch (err) {
    console.error(
      colors.red(
        `quickflo mcp: failed to start — ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    Deno.exit(1);
  }

  console.error(
    colors.dim(`quickflo mcp: ready (${auth.apiUrl}, ${auth.orgs.length} org(s))`),
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: {}, resources: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: RESOURCES.map(({ text: _text, ...meta }) => meta),
  }));

  server.setRequestHandler(
    ReadResourceRequestSchema,
    (req: ReadResourceRequest) => {
      const match = RESOURCES.find((r) => r.uri === req.params.uri);
      if (!match) {
        throw new Error(`Unknown resource "${req.params.uri}".`);
      }
      return {
        contents: [
          { uri: match.uri, mimeType: match.mimeType, text: match.text },
        ],
      };
    },
  );

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await handleTool(name, args as Record<string, unknown> | undefined);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
