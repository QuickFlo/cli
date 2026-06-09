/**
 * Shared filter / pagination helpers for commands that hit list endpoints.
 *
 * The CLI exposes three layers, in order of ergonomics → escape-hatchiness:
 *   1. Named flags (e.g. `-n, --name <substr>`)
 *   2. `--where <field>:<op>:<value>` — repeatable, maps to where[field][$op]=value
 *   3. `--raw-query <str>` — verbatim URLSearchParams passthrough
 */

const OPS = new Set([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  're',
  'like',
  'ilike',
]);

export interface FilterOptions {
  /** Substring match on name — shorthand for `where[name][$re]=<substr>`. */
  name?: string;
  /** Repeatable `<field>:<op>:<value>` expressions. */
  where?: string[];
  /** Raw URLSearchParams string appended verbatim. */
  rawQuery?: string;
}

export interface ListOptions extends FilterOptions {
  limit?: number;
  /** `<field>[:DIR]` — DIR defaults to ASC. */
  order?: string;
}

/**
 * Parse `<field>:<op>:<value>` into a `[key, value]` pair (or list of pairs
 * for `$in` / `$nin` values that are comma-separated).
 */
function parseWhereExpr(expr: string): Array<[string, string]> {
  const firstColon = expr.indexOf(':');
  const secondColon = expr.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    throw new Error(
      `Invalid --where "${expr}". Expected <field>:<op>:<value> (e.g. name:re:^Free)`,
    );
  }
  const field = expr.slice(0, firstColon);
  const op = expr.slice(firstColon + 1, secondColon);
  const value = expr.slice(secondColon + 1);
  if (!field || !op) {
    throw new Error(`Invalid --where "${expr}": empty field or op.`);
  }
  if (!OPS.has(op)) {
    throw new Error(
      `Invalid --where op "${op}". Supported: ${[...OPS].join(', ')}`,
    );
  }
  const key = `where[${field}][$${op}]`;
  if (op === 'in' || op === 'nin') {
    return value.split(',').map((v) => [key, v]);
  }
  return [[key, value]];
}

/** Build the `where[...]` portion of the query plus any raw passthrough. */
export function buildWhereParams(opts: FilterOptions): URLSearchParams {
  const params = new URLSearchParams();
  if (opts.name) {
    params.set('where[name][$re]', opts.name);
  }
  for (const expr of opts.where ?? []) {
    for (const [k, v] of parseWhereExpr(expr)) {
      params.append(k, v);
    }
  }
  if (opts.rawQuery) {
    const extra = new URLSearchParams(opts.rawQuery);
    for (const [k, v] of extra.entries()) {
      params.append(k, v);
    }
  }
  return params;
}

/**
 * Search-attribute operators. Executions index `x-searchable` inputs and the
 * return-step output under flat dot keys (e.g.
 * `return.webhookResponse.body.operation`). The server filters them via
 * `where[searchAttributes.<path>]=<value>` where the VALUE carries the
 * operator: bare = contains (ILIKE), `=` exact, `!=` not-equals, `!` not-contains.
 */
const ATTR_OP_PREFIX: Record<string, string> = {
  eq: '=',
  ne: '!=',
  contains: '',
  ncontains: '!',
};

/**
 * Parse a `--attr` expression into a `[paramKey, paramValue]` pair. Accepts
 * `<path>:<op>:<value>` (op in eq|ne|contains|ncontains) or the shorthand
 * `<path>:<value>` (defaults to `eq`, exact match). `<path>` is a dot-path into
 * the indexed attributes; values may themselves contain colons.
 *
 * A `<path>` of `*` is the UI's "search all attributes" form: it routes to the
 * server's broad operators — `$containsValue` (eq/contains) or
 * `$notContainsValue` (ne/ncontains) — matching what `*:value` / `*:!value` do
 * in the executions UI.
 */
export function parseAttrExpr(expr: string): [string, string] {
  const firstColon = expr.indexOf(':');
  if (firstColon === -1) {
    throw new Error(
      `Invalid --attr "${expr}". Expected <path>:<op>:<value> or <path>:<value> ` +
        `(e.g. return.webhookResponse.body.operation:eq:DELETE, or *:DELETE for any field)`,
    );
  }
  const path = expr.slice(0, firstColon);
  if (!path) throw new Error(`Invalid --attr "${expr}": empty path.`);

  let op = 'eq';
  let value = expr.slice(firstColon + 1);
  const secondColon = value.indexOf(':');
  if (secondColon !== -1) {
    const maybeOp = value.slice(0, secondColon);
    if (Object.hasOwn(ATTR_OP_PREFIX, maybeOp)) {
      op = maybeOp;
      value = value.slice(secondColon + 1);
    }
  }

  if (path === '*') {
    // Any-field search: the broad operators take the raw term (no prefix).
    const broadKey = op === 'ne' || op === 'ncontains' ? '$notContainsValue' : '$containsValue';
    return [`where[searchAttributes][${broadKey}]`, value];
  }
  return [`where[searchAttributes.${path}]`, `${ATTR_OP_PREFIX[op]}${value}`];
}

/**
 * Apply `--attr` (per-path filters) and `--attr-contains` (match any indexed
 * value, server `$containsValue`) to a params object. Used by `executions list`.
 */
export function applySearchAttributeFilters(
  params: URLSearchParams,
  attrs: string[] | undefined,
  attrContains: string | undefined,
  attrNotContains?: string,
): void {
  for (const expr of attrs ?? []) {
    const [k, v] = parseAttrExpr(expr);
    params.append(k, v);
  }
  if (attrContains) {
    params.set('where[searchAttributes][$containsValue]', attrContains);
  }
  if (attrNotContains) {
    params.set('where[searchAttributes][$notContainsValue]', attrNotContains);
  }
}

/** Build query params for a single-page list request. */
export function buildListParams(opts: ListOptions): URLSearchParams {
  const params = buildWhereParams(opts);
  if (opts.limit !== undefined) {
    params.set('options[limit]', String(opts.limit));
  }
  if (opts.order) {
    const [field, dir = 'ASC'] = opts.order.split(':');
    params.set(`options[orderBy][${field}]`, dir.toUpperCase());
  }
  return params;
}

/** Filter for the `isTemplate` column. */
export type TemplateFilter = 'all' | 'only' | 'exclude';

export function applyTemplateFilter(
  params: URLSearchParams,
  filter: TemplateFilter,
): void {
  if (filter === 'only') {
    params.set('where[isTemplate][$eq]', 'true');
  } else if (filter === 'exclude') {
    params.set('where[isTemplate][$eq]', 'false');
  }
}

/**
 * Filter workflows by whether they were installed from a package. The default
 * is `exclude` (org-owned only) because pulling or listing package-installed
 * rows is almost never what the user wants — push refuses to clobber them
 * (see workflows-push.ts findWorkflowByName), so round-tripping them
 * through pull → edit → push just produces skip-with-error noise.
 */
export function applyPackageFilter(
  params: URLSearchParams,
  includePackages: boolean,
): void {
  if (!includePackages) {
    params.set('where[packageInstallId]', 'null');
  }
}

/** How to combine multiple tags: "any" = OR (overlap), "all" = AND (contains). */
export type TagsMode = 'any' | 'all';

export function applyTagsFilter(
  params: URLSearchParams,
  tags: string[],
  mode: TagsMode,
): void {
  if (tags.length === 0) return;
  if (mode === 'any') {
    tags.forEach((t, i) => {
      params.append(`where[$or][${i}][tags][$overlap][]`, t);
    });
  } else {
    for (const t of tags) {
      params.append('where[tags][$contains][]', t);
    }
  }
}

/** Normalize `--tags foo,bar` (or repeated `--tags`) into a clean string[]. */
export function parseTags(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
