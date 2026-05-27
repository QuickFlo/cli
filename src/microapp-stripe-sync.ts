/**
 * `quickflo microapp stripe-sync [config]` — provision a micro-app's Stripe
 * product + prices from a declarative `stripe.config.json`, idempotently.
 *
 * Find-or-create semantics so re-runs never duplicate:
 *   - product: reuse the id cached in `stripe.ids.json` if it still resolves,
 *     else search by `metadata['qf_app_id']`, else create.
 *   - prices: looked up by a deterministic `lookup_key`
 *     (`<appId>_<tier>_<interval>`); create only when absent.
 *
 * On success the resolved ids are written back to `stripe.ids.json` and the
 * `stripeProductIds` line of a sibling `apps.config.snippet.md` (if present),
 * so there's no copy-paste step.
 *
 * Stripe's API is form-encoded, not JSON — see `encodeStripeForm`.
 */

import { colors } from '@cliffy/ansi/colors';
import { dirname, join, resolve } from '@std/path';
import { ApiError, UserError, ValidationError } from './errors.ts';
import { info } from './log.ts';
import { confirm } from './tty.ts';

const STRIPE_API = 'https://api.stripe.com/v1';

export interface StripePriceSpec {
  interval: 'day' | 'week' | 'month' | 'year';
  amount: number;
}

export interface StripeTierSpec {
  tier: string;
  prices: StripePriceSpec[];
  limits?: Record<string, number>;
  features?: string[];
}

/**
 * What buying a one-time SKU grants the org (read by the central webhook). All
 * keys are app-defined so this stays generic across micro-apps.
 */
export interface OneTimeGrant {
  /** Consumable credits added to the org's balance, e.g. `{ cleans: 1 }`. */
  credits?: Record<string, number>;
  /** Per-use limits while a credit is consumed, e.g. `{ maxRecordsPerList: 50000 }`. */
  limits?: Record<string, number>;
  /** Features unlocked for the granted use(s). */
  features?: string[];
  /** Credit expiry in days (omit = never expires). */
  expiresInDays?: number;
}

/**
 * A one-time (non-recurring) purchase, e.g. a single pay-per-use scan. Created
 * as a Stripe one-time price (no `recurring`); checkout runs in `payment` mode,
 * not `subscription`. The `grants` are stamped onto the price metadata so the
 * central billing webhook can turn a purchase into a consumable credit.
 */
export interface OneTimeSpec {
  sku: string;
  name: string;
  amount: number;
  grants?: OneTimeGrant;
}

export interface StripeConfig {
  appId: string;
  productName: string;
  currency: string;
  tiers: StripeTierSpec[];
  oneTime?: OneTimeSpec[];
}

interface ResolvedPrice {
  tier: string;
  interval: string;
  priceId: string;
  lookupKey: string;
}

interface ResolvedOneTime {
  sku: string;
  priceId: string;
  lookupKey: string;
}

interface StripeIds {
  productId: string;
  prices: ResolvedPrice[];
  oneTime?: ResolvedOneTime[];
}

interface StripeProduct {
  id: string;
}

interface StripePrice {
  id: string;
  lookup_key?: string | null;
  unit_amount?: number | null;
}

export interface MicroappStripeSyncOptions {
  /** Path to the config (default `./stripe.config.json`). */
  config?: string;
  /** Stripe secret key. Falls back to `STRIPE_API_KEY` / `STRIPE_SECRET_KEY`. */
  key?: string;
  /** Required to target live mode with an `sk_live` / `rk_live` key. */
  live?: boolean;
  /** Print the intended objects without calling Stripe or writing files. */
  dryRun?: boolean;
  /** Skip the live-mode confirmation prompt (for CI). */
  yes?: boolean;
}

/** True when the key targets the Stripe live dataset (vs test/sandbox). */
function isLiveKey(key: string): boolean {
  return key.startsWith('sk_live') || key.startsWith('rk_live');
}

/** Deterministic, human-readable price handle stable across recreation. */
export function buildLookupKey(appId: string, tier: string, interval: string): string {
  return `${appId}_${tier}_${interval}`;
}

/**
 * Encode a params object into Stripe's bracketed form-urlencoded shape:
 * `{ recurring: { interval: 'month' } }` -> `recurring[interval]=month`.
 * Nested objects and arrays recurse; null/undefined are skipped.
 */
export function encodeStripeForm(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const indexedKey = `${fullKey}[${index}]`;
        if (item !== null && typeof item === 'object') {
          parts.push(encodeStripeForm(item as Record<string, unknown>, indexedKey));
        } else {
          parts.push(`${encodeURIComponent(indexedKey)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof value === 'object') {
      parts.push(encodeStripeForm(value as Record<string, unknown>, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter((p) => p.length > 0).join('&');
}

/**
 * Rewrite the `stripeProductIds: [...]` array in an apps.config snippet to
 * carry the resolved product id. Returns the snippet unchanged when the line
 * is absent.
 */
export function injectProductId(snippet: string, productId: string): string {
  return snippet.replace(
    /stripeProductIds: \[[^\]]*\]/,
    `stripeProductIds: ['${productId}']`,
  );
}

const ENV_BLOCK_START = '# --- quickflo:stripe (managed by `quickflo microapp stripe-sync`) ---';
const ENV_BLOCK_END = '# --- end quickflo:stripe ---';

function envNorm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Env var name for a subscription price, e.g. (pro, month) -> `VITE_QF_PRICE_PRO_MONTH`. */
export function priceEnvVar(tier: string, interval: string): string {
  return `VITE_QF_PRICE_${envNorm(tier)}_${envNorm(interval)}`;
}

/** Env var name for a one-time price, e.g. (single-scan) -> `VITE_QF_PRICE_ONETIME_SINGLE_SCAN`. */
export function oneTimeEnvVar(sku: string): string {
  return `VITE_QF_PRICE_ONETIME_${envNorm(sku)}`;
}

/**
 * Upsert a managed block of `VITE_QF_PRICE_*=<priceId>` lines into a `.env`.
 * Entries are `{ name, value }` pairs the caller builds from resolved prices
 * (subscription + one-time). The block is delimited by markers and rewritten
 * wholesale each run, so it's idempotent and never disturbs the user's own env
 * lines. Price IDs are not secret (client-side Stripe.js), so `.env` is fine.
 */
export function upsertEnvPrices(
  envContent: string,
  entries: Array<{ name: string; value: string }>,
): string {
  const block = [
    ENV_BLOCK_START,
    ...entries.map((e) => `${e.name}=${e.value}`),
    ENV_BLOCK_END,
  ].join('\n');

  const start = envContent.indexOf(ENV_BLOCK_START);
  if (start === -1) {
    const sep = envContent.length === 0 ? '' : envContent.endsWith('\n') ? '\n' : '\n\n';
    return `${envContent}${sep}${block}\n`;
  }
  const end = envContent.indexOf(ENV_BLOCK_END, start);
  if (end === -1) {
    return envContent.slice(0, start) + block + '\n';
  }
  return envContent.slice(0, start) + block + envContent.slice(end + ENV_BLOCK_END.length);
}

function parseConfig(raw: string): StripeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('stripe.config.json is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationError('stripe.config.json must be a JSON object.');
  }
  const cfg = parsed as Partial<StripeConfig>;
  if (!cfg.appId || typeof cfg.appId !== 'string') {
    throw new ValidationError('stripe.config.json: `appId` (string) is required.');
  }
  if (!cfg.productName || typeof cfg.productName !== 'string') {
    throw new ValidationError('stripe.config.json: `productName` (string) is required.');
  }
  if (!cfg.currency || typeof cfg.currency !== 'string') {
    throw new ValidationError('stripe.config.json: `currency` (string) is required.');
  }
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length === 0) {
    throw new ValidationError('stripe.config.json: `tiers` must be a non-empty array.');
  }
  if (cfg.oneTime !== undefined && !Array.isArray(cfg.oneTime)) {
    throw new ValidationError('stripe.config.json: `oneTime` must be an array when present.');
  }
  return cfg as StripeConfig;
}

function resolveKey(opts: MicroappStripeSyncOptions): string {
  const key = opts.key ?? Deno.env.get('STRIPE_API_KEY') ?? Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) {
    throw new UserError(
      'No Stripe key. Pass --key sk_… or set STRIPE_API_KEY / STRIPE_SECRET_KEY.',
    );
  }
  if (isLiveKey(key) && !opts.live) {
    throw new UserError(
      'Refusing to target Stripe LIVE mode without --live. Re-run with --live to confirm.',
    );
  }
  return key;
}

async function stripeRequest<T>(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  const init: RequestInit = { method, headers };
  if (params && method === 'POST') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeStripeForm(params);
  }
  const res = await fetch(`${STRIPE_API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errBody = body as { error?: { message?: string; code?: string } };
    throw new ApiError(
      res.status,
      path,
      errBody.error?.message ?? `Stripe API returned ${res.status}`,
      { code: errBody.error?.code },
    );
  }
  return body as T;
}

// ── Plan ─────────────────────────────────────────────────────────────────────
// stripe-sync is non-destructive by construction: Stripe prices are immutable,
// so we never edit one. We compute a plan (create / reuse / conflict) and apply
// only the creates. A "conflict" — a live price whose amount differs from the
// config — halts the run rather than silently reusing the stale price.

interface ProductPlan {
  action: 'create' | 'reuse';
  /** Set when reusing an existing product. */
  id?: string;
}

interface PricePlan {
  tier: string;
  interval: string;
  lookupKey: string;
  configAmount: number;
  action: 'create' | 'reuse' | 'conflict';
  /** Set when reusing or conflicting. */
  existing?: StripePrice;
}

interface OneTimePlan {
  sku: string;
  lookupKey: string;
  configAmount: number;
  action: 'create' | 'reuse' | 'conflict';
  /** Set when reusing or conflicting. */
  existing?: StripePrice;
}

interface SyncPlan {
  product: ProductPlan;
  prices: PricePlan[];
  oneTime: OneTimePlan[];
}

async function planProduct(
  key: string,
  config: StripeConfig,
  cachedId: string | undefined,
): Promise<ProductPlan> {
  if (cachedId) {
    try {
      const product = await stripeRequest<StripeProduct>(key, 'GET', `/products/${cachedId}`);
      return { action: 'reuse', id: product.id };
    } catch {
      // Cached id no longer resolves (deleted, wrong mode) — fall through.
    }
  }
  const query = encodeURIComponent(`metadata['qf_app_id']:'${config.appId}'`);
  const search = await stripeRequest<{ data: StripeProduct[] }>(
    key,
    'GET',
    `/products/search?query=${query}`,
  );
  if (search.data.length > 0) {
    return { action: 'reuse', id: search.data[0].id };
  }
  return { action: 'create' };
}

async function planPrices(key: string, config: StripeConfig): Promise<PricePlan[]> {
  const plans: PricePlan[] = [];
  for (const tier of config.tiers) {
    for (const spec of tier.prices) {
      const lookupKey = buildLookupKey(config.appId, tier.tier, spec.interval);
      const found = await stripeRequest<{ data: StripePrice[] }>(
        key,
        'GET',
        `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
      );
      const existing = found.data[0];
      let action: PricePlan['action'] = 'create';
      if (existing) {
        action = existing.unit_amount === spec.amount ? 'reuse' : 'conflict';
      }
      plans.push({
        tier: tier.tier,
        interval: spec.interval,
        lookupKey,
        configAmount: spec.amount,
        action,
        existing,
      });
    }
  }
  return plans;
}

async function planOneTime(key: string, config: StripeConfig): Promise<OneTimePlan[]> {
  const plans: OneTimePlan[] = [];
  for (const spec of config.oneTime ?? []) {
    const lookupKey = buildLookupKey(config.appId, 'onetime', spec.sku);
    const found = await stripeRequest<{ data: StripePrice[] }>(
      key,
      'GET',
      `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=1`,
    );
    const existing = found.data[0];
    let action: OneTimePlan['action'] = 'create';
    if (existing) {
      action = existing.unit_amount === spec.amount ? 'reuse' : 'conflict';
    }
    plans.push({ sku: spec.sku, lookupKey, configAmount: spec.amount, action, existing });
  }
  return plans;
}

function priceMetadata(tier: StripeTierSpec): Record<string, string> {
  const metadata: Record<string, string> = { qf_kind: 'subscription', qf_tier: tier.tier };
  if (tier.limits) {
    metadata['qf_limits'] = JSON.stringify(tier.limits);
  }
  if (tier.features) {
    metadata['qf_features'] = JSON.stringify(tier.features);
  }
  return metadata;
}

/** Stamp the grant spec onto a one-time price so the webhook can issue a credit. */
function oneTimeMetadata(spec: OneTimeSpec): Record<string, string> {
  const metadata: Record<string, string> = { qf_kind: 'one_time' };
  const grants = spec.grants;
  if (grants?.credits) {
    metadata['qf_grant_credits'] = JSON.stringify(grants.credits);
  }
  if (grants?.limits) {
    metadata['qf_grant_limits'] = JSON.stringify(grants.limits);
  }
  if (grants?.features) {
    metadata['qf_grant_features'] = JSON.stringify(grants.features);
  }
  if (grants?.expiresInDays !== undefined) {
    metadata['qf_grant_expires_days'] = String(grants.expiresInDays);
  }
  return metadata;
}

function tierFor(config: StripeConfig, tierName: string): StripeTierSpec {
  const match = config.tiers.find((t) => t.tier === tierName);
  if (!match) {
    throw new ValidationError(`No tier "${tierName}" in config (internal plan mismatch).`);
  }
  return match;
}

function oneTimeSpecFor(config: StripeConfig, sku: string): OneTimeSpec {
  const match = (config.oneTime ?? []).find((o) => o.sku === sku);
  if (!match) {
    throw new ValidationError(`No one-time SKU "${sku}" in config (internal plan mismatch).`);
  }
  return match;
}

function fmtAmount(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

function printPlan(config: StripeConfig, plan: SyncPlan, live: boolean): void {
  const tag = (action: string): string =>
    action === 'create'
      ? colors.green('create')
      : action === 'conflict'
      ? colors.red('conflict')
      : colors.dim('reuse');
  info(colors.bold(`Stripe plan (${live ? colors.red('LIVE') : 'test'} mode)`));
  info(`  ${tag(plan.product.action)}  product ${colors.bold(config.productName)}`);
  for (const price of plan.prices) {
    const detail = price.action === 'conflict'
      ? colors.red(
        `config ${fmtAmount(price.configAmount, config.currency)} != existing ${
          fmtAmount(price.existing?.unit_amount ?? 0, config.currency)
        }`,
      )
      : `${fmtAmount(price.configAmount, config.currency)} ${colors.dim(price.lookupKey)}`;
    info(
      `  ${tag(price.action)}  price ${colors.bold(`${price.tier}/${price.interval}`)} ${detail}`,
    );
  }
  for (const ot of plan.oneTime) {
    const detail = ot.action === 'conflict'
      ? colors.red(
        `config ${fmtAmount(ot.configAmount, config.currency)} != existing ${
          fmtAmount(ot.existing?.unit_amount ?? 0, config.currency)
        }`,
      )
      : `${fmtAmount(ot.configAmount, config.currency)} ${colors.dim(ot.lookupKey)}`;
    info(`  ${tag(ot.action)}  one-time ${colors.bold(ot.sku)} ${detail}`);
  }
  info('');
}

async function readCachedIds(path: string): Promise<StripeIds | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as StripeIds;
  } catch {
    return undefined;
  }
}

async function writeBack(dir: string, ids: StripeIds): Promise<void> {
  await Deno.writeTextFile(join(dir, 'stripe.ids.json'), JSON.stringify(ids, null, 2) + '\n');

  const snippetPath = join(dir, 'apps.config.snippet.md');
  try {
    const snippet = await Deno.readTextFile(snippetPath);
    await Deno.writeTextFile(snippetPath, injectProductId(snippet, ids.productId));
  } catch {
    // No snippet alongside the config — nothing to patch.
  }

  // Make price ids available to the front-end (checkout) via VITE_ env vars.
  const envPath = join(dir, '.env');
  try {
    const env = await Deno.readTextFile(envPath);
    const entries = [
      ...ids.prices.map((p) => ({ name: priceEnvVar(p.tier, p.interval), value: p.priceId })),
      ...(ids.oneTime ?? []).map((o) => ({ name: oneTimeEnvVar(o.sku), value: o.priceId })),
    ];
    await Deno.writeTextFile(envPath, upsertEnvPrices(env, entries));
  } catch {
    // No .env alongside the config — skip (don't create a bare one).
  }
}

/** Offline preview (no key, no network): just the objects the config declares. */
function printDryRun(config: StripeConfig, live: boolean): void {
  info(colors.yellow(`dry run — no Stripe calls (${live ? 'LIVE' : 'test'} mode)`));
  info(`product: ${colors.bold(config.productName)} ${colors.dim(`(qf_app_id=${config.appId})`)}`);
  for (const tier of config.tiers) {
    for (const spec of tier.prices) {
      const lookupKey = buildLookupKey(config.appId, tier.tier, spec.interval);
      info(
        `  price ${colors.bold(tier.tier)}/${spec.interval} ` +
          `${fmtAmount(spec.amount, config.currency)} ` +
          colors.dim(`lookup_key=${lookupKey}`),
      );
    }
  }
  for (const spec of config.oneTime ?? []) {
    const lookupKey = buildLookupKey(config.appId, 'onetime', spec.sku);
    info(
      `  one-time ${colors.bold(spec.sku)} ` +
        `${fmtAmount(spec.amount, config.currency)} ` +
        colors.dim(`lookup_key=${lookupKey}`),
    );
  }
}

export async function runMicroappStripeSync(opts: MicroappStripeSyncOptions): Promise<void> {
  const configPath = resolve(opts.config ?? 'stripe.config.json');
  let raw: string;
  try {
    raw = await Deno.readTextFile(configPath);
  } catch {
    throw new UserError(
      `No config at ${configPath}. Run \`quickflo microapp new\` first, or pass a path.`,
    );
  }
  const config = parseConfig(raw);
  const dir = dirname(configPath);

  if (opts.dryRun) {
    printDryRun(config, opts.live ?? false);
    return;
  }

  const key = resolveKey(opts);
  const live = isLiveKey(key);
  const cached = await readCachedIds(join(dir, 'stripe.ids.json'));

  // 1. Compute the plan against Stripe's current state, then show it.
  const plan: SyncPlan = {
    product: await planProduct(key, config, cached?.productId),
    prices: await planPrices(key, config),
    oneTime: await planOneTime(key, config),
  };
  printPlan(config, plan, live);

  // 2. Halt on drift — never silently reuse a price whose amount no longer
  //    matches the config. Stripe prices are immutable; the user must decide.
  const conflicts = [
    ...plan.prices
      .filter((p) => p.action === 'conflict')
      .map((c) => `  - ${c.tier}/${c.interval} (${c.lookupKey})`),
    ...plan.oneTime
      .filter((o) => o.action === 'conflict')
      .map((c) => `  - one-time ${c.sku} (${c.lookupKey})`),
  ];
  if (conflicts.length > 0) {
    throw new UserError(
      `${conflicts.length} price(s) already exist with a different amount:\n${
        conflicts.join('\n')
      }\n` +
        'Stripe prices are immutable. Either match stripe.config.json to the existing amounts, ' +
        'or archive the old prices in the Stripe dashboard and re-run to create new ones.',
    );
  }

  // 3. Nothing to do? Don't prompt, don't rewrite files for a no-op.
  const creates = plan.prices.filter((p) => p.action === 'create').length +
    plan.oneTime.filter((o) => o.action === 'create').length +
    (plan.product.action === 'create' ? 1 : 0);
  if (creates === 0) {
    info(colors.dim('Everything already exists — nothing to create.'));
  }

  // 4. Confirm before any LIVE creation. Test/sandbox proceeds unprompted.
  if (live && creates > 0) {
    const ok = await confirm(
      colors.red(`About to create ${creates} object(s) in your Stripe LIVE account. Continue?`),
      opts.yes,
    );
    if (!ok) {
      info('Aborted — no Stripe objects created.');
      return;
    }
  }

  // 5. Apply: create the product if needed, then the missing prices.
  const productId = plan.product.id ??
    (await stripeRequest<StripeProduct>(key, 'POST', '/products', {
      name: config.productName,
      metadata: { qf_app_id: config.appId },
    })).id;

  const prices: ResolvedPrice[] = [];
  for (const pricePlan of plan.prices) {
    if (pricePlan.existing) {
      prices.push({
        tier: pricePlan.tier,
        interval: pricePlan.interval,
        priceId: pricePlan.existing.id,
        lookupKey: pricePlan.lookupKey,
      });
      continue;
    }
    const created = await stripeRequest<StripePrice>(key, 'POST', '/prices', {
      product: productId,
      currency: config.currency,
      unit_amount: pricePlan.configAmount,
      recurring: { interval: pricePlan.interval },
      lookup_key: pricePlan.lookupKey,
      metadata: priceMetadata(tierFor(config, pricePlan.tier)),
    });
    prices.push({
      tier: pricePlan.tier,
      interval: pricePlan.interval,
      priceId: created.id,
      lookupKey: pricePlan.lookupKey,
    });
  }

  // One-time prices: no `recurring` field; grants ride on the metadata.
  const oneTime: ResolvedOneTime[] = [];
  for (const otPlan of plan.oneTime) {
    if (otPlan.existing) {
      oneTime.push({ sku: otPlan.sku, priceId: otPlan.existing.id, lookupKey: otPlan.lookupKey });
      continue;
    }
    const created = await stripeRequest<StripePrice>(key, 'POST', '/prices', {
      product: productId,
      currency: config.currency,
      unit_amount: otPlan.configAmount,
      lookup_key: otPlan.lookupKey,
      metadata: oneTimeMetadata(oneTimeSpecFor(config, otPlan.sku)),
    });
    oneTime.push({ sku: otPlan.sku, priceId: created.id, lookupKey: otPlan.lookupKey });
  }

  // 6. Write the resolved ids back so there's no copy-paste.
  await writeBack(dir, { productId, prices, oneTime });

  info(`${colors.green('✓')} synced Stripe ${colors.dim(`(${live ? 'LIVE' : 'test'} mode)`)}`);
  info(`  product ${colors.bold(productId)}`);
  for (const price of prices) {
    info(`  price ${colors.bold(`${price.tier}/${price.interval}`)} ${colors.dim(price.priceId)}`);
  }
  for (const ot of oneTime) {
    info(`  one-time ${colors.bold(ot.sku)} ${colors.dim(ot.priceId)}`);
  }
  info('');
  info(
    colors.dim(
      'Wrote stripe.ids.json, patched stripeProductIds in apps.config.snippet.md, and set VITE_QF_PRICE_* in .env.',
    ),
  );
}
