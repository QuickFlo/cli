/**
 * Form-trigger cross-reference rewriting (Phase 2).
 *
 * A form trigger's `config.form` can point at *other* resources by id:
 *   - `prefill.workflowId`      — workflow run before the form renders
 *   - `confirmation.workflowId` — workflow run between submit and commit
 *   - `chat.endedWorkflowId`    — workflow run when a chat session ends
 *   - `auth.credentialIds[]`    — form-auth Connection ids (provider=credentials)
 *
 * Those ids are org-specific and don't survive a cross-org round-trip, so pull
 * rewrites every ref to a *name* and push resolves it back to an id in the
 * target org:
 *   - workflow refs: `workflowId` → `workflowName`, `endedWorkflowId` →
 *     `endedWorkflowName`
 *   - connection refs: `credentialIds` → `credentialNames`
 *
 * This makes a full org → prod migration self-remapping: push the workflows
 * and connections first (both keyed by name), then push the triggers and the
 * refs re-link by name automatically — no manual id surgery.
 *
 * Refs are *soft* on push: an unresolved name is dropped, not fatal. For
 * prefill/confirmation the whole block is dropped (its `workflowId` is required
 * within the block); `endedWorkflowName` is just cleared; unresolved credential
 * names are filtered out (and an empty result warns, since the server requires
 * at least one).
 *
 * Every function here is pure (no network) — the runners do the async
 * resolution and hand in plain maps — so the rewrite logic is unit-tested in
 * isolation (see trigger-form-refs.test.ts).
 */

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
}

function formOf(config: Obj | undefined): Obj | undefined {
  return asObj(config?.['form']);
}

// ─── Collection (pull reads ids; push reads names + credential ids) ──────────

/** Workflow ids referenced inside a form config — for batch id→name resolution on pull. */
export function collectFormWorkflowIds(config: Obj | undefined): string[] {
  const form = formOf(config);
  if (!form) return [];
  const ids: string[] = [];
  for (const key of ['prefill', 'confirmation'] as const) {
    const id = asObj(form[key])?.['workflowId'];
    if (typeof id === 'string') ids.push(id);
  }
  const ended = asObj(form['chat'])?.['endedWorkflowId'];
  if (typeof ended === 'string') ids.push(ended);
  return ids;
}

/** Workflow names referenced inside a form config — for name→id resolution on push. */
export function collectFormWorkflowNames(config: Obj | undefined): string[] {
  const form = formOf(config);
  if (!form) return [];
  const names: string[] = [];
  for (const key of ['prefill', 'confirmation'] as const) {
    const n = asObj(form[key])?.['workflowName'];
    if (typeof n === 'string') names.push(n);
  }
  const ended = asObj(form['chat'])?.['endedWorkflowName'];
  if (typeof ended === 'string') names.push(ended);
  return names;
}

/** form-auth Connection ids referenced by a credentials-provider form (pull). */
export function collectFormCredentialIds(config: Obj | undefined): string[] {
  const auth = asObj(formOf(config)?.['auth']);
  if (auth?.['provider'] !== 'credentials') return [];
  const ids = auth['credentialIds'];
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
}

/** form-auth Connection names referenced by a credentials-provider form (push). */
export function collectFormCredentialNames(config: Obj | undefined): string[] {
  const auth = asObj(formOf(config)?.['auth']);
  if (auth?.['provider'] !== 'credentials') return [];
  const names = auth['credentialNames'];
  return Array.isArray(names) ? names.filter((x): x is string => typeof x === 'string') : [];
}

// ─── Pull: ids → names ───────────────────────────────────────────────────────

export interface FormRefResult {
  config: Obj | undefined;
  warnings: string[];
}

export interface PullRefMaps {
  /** workflow id → name */
  workflowIdToName: Map<string, string>;
  /** connection id → name (for form-auth credential refs) */
  connectionIdToName: Map<string, string>;
}

/**
 * Rewrite a form config's id refs to name refs for serialization. Ids that
 * don't resolve to a name (e.g. a package/deleted workflow, a connection that
 * no longer exists) are left as-is with a warning — preserving the raw id is
 * safer than silently dropping the ref. Returns a deep clone; input untouched.
 */
export function formRefsToNames(
  config: Obj | undefined,
  maps: PullRefMaps,
): FormRefResult {
  const warnings: string[] = [];
  if (!config) return { config, warnings };
  const out = structuredClone(config);
  const form = formOf(out);
  if (!form) return { config: out, warnings };

  for (const key of ['prefill', 'confirmation'] as const) {
    const block = asObj(form[key]);
    const id = block?.['workflowId'];
    if (block && typeof id === 'string') {
      const name = maps.workflowIdToName.get(id);
      if (name) {
        block['workflowName'] = name;
        delete block['workflowId'];
      } else {
        warnings.push(`form.${key}.workflowId ${id} could not be named — left as a raw id`);
      }
    }
  }

  const chat = asObj(form['chat']);
  const endedId = chat?.['endedWorkflowId'];
  if (chat && typeof endedId === 'string') {
    const name = maps.workflowIdToName.get(endedId);
    if (name) {
      chat['endedWorkflowName'] = name;
      delete chat['endedWorkflowId'];
    } else {
      warnings.push(`form.chat.endedWorkflowId ${endedId} could not be named — left as a raw id`);
    }
  }

  // form-auth credential ids → names (connections are keyed by name cross-org).
  const auth = asObj(form['auth']);
  if (auth?.['provider'] === 'credentials' && Array.isArray(auth['credentialIds'])) {
    const ids = auth['credentialIds'] as string[];
    const names: string[] = [];
    for (const id of ids) {
      const name = maps.connectionIdToName.get(id);
      if (name) {
        names.push(name);
      } else {
        warnings.push(`form.auth.credentialIds ${id} could not be named — dropped`);
      }
    }
    auth['credentialNames'] = names;
    delete auth['credentialIds'];
  }

  return { config: out, warnings };
}

// ─── Push: names → ids, and credential-id filtering ──────────────────────────

export interface PushRefMaps {
  /** workflow name → resolved org-owned id, or null when unresolved/ambiguous. */
  workflowNameToId: Map<string, string | null>;
  /** connection name → resolved org-owned id, or null when unresolved/ambiguous. */
  connectionNameToId: Map<string, string | null>;
}

/**
 * Rewrite a form config's name refs back to target-org ids. Soft semantics:
 *   - prefill / confirmation: unresolved name → drop the whole block (its
 *     `workflowId` is required, so a partial block is invalid).
 *   - chat.endedWorkflowName: unresolved → just remove the field.
 *   - credentialNames: resolve each to a connection id; drop unresolved (warn);
 *     an empty result is still emitted so the server surfaces the min-1
 *     violation on that one file rather than us silently changing auth.
 * Returns a deep clone; the input is not mutated.
 */
export function formRefsToIds(
  config: Obj | undefined,
  maps: PushRefMaps,
): FormRefResult {
  const warnings: string[] = [];
  if (!config) return { config, warnings };
  const out = structuredClone(config);
  const form = formOf(out);
  if (!form) return { config: out, warnings };

  for (const key of ['prefill', 'confirmation'] as const) {
    const block = asObj(form[key]);
    if (!block) continue;
    const name = block['workflowName'];
    if (typeof name === 'string') {
      const id = maps.workflowNameToId.get(name);
      if (id) {
        block['workflowId'] = id;
        delete block['workflowName'];
      } else {
        warnings.push(
          `form.${key}: workflow "${name}" not found in target org — dropping the ${key} block`,
        );
        delete form[key];
      }
    }
    // A block carrying a raw workflowId (no name) passes through untouched.
  }

  const chat = asObj(form['chat']);
  if (chat) {
    const name = chat['endedWorkflowName'];
    if (typeof name === 'string') {
      const id = maps.workflowNameToId.get(name);
      if (id) {
        chat['endedWorkflowId'] = id;
        delete chat['endedWorkflowName'];
      } else {
        warnings.push(
          `form.chat: endedWorkflow "${name}" not found in target org — clearing endedWorkflow`,
        );
        delete chat['endedWorkflowName'];
      }
    }
  }

  const auth = asObj(form['auth']);
  if (auth?.['provider'] === 'credentials' && Array.isArray(auth['credentialNames'])) {
    const names = auth['credentialNames'] as string[];
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const name of names) {
      const id = maps.connectionNameToId.get(name);
      if (id) kept.push(id);
      else dropped.push(name);
    }
    if (dropped.length > 0) {
      warnings.push(
        `form.auth: ${dropped.length} credential connection(s) not found in target org, dropped: ${
          dropped.join(', ')
        }`,
      );
    }
    if (kept.length === 0) {
      warnings.push(
        `form.auth: no credential connections resolved in the target org — the server will reject this form (credentials auth requires at least one). Push the connections first.`,
      );
    }
    auth['credentialIds'] = kept;
    delete auth['credentialNames'];
  }

  return { config: out, warnings };
}
