import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildTemplate } from './microapp-template.ts';

Deno.test('buildTemplate (supabase) wires Supabase identity', () => {
  const files = buildTemplate({
    name: 'my-app',
    appId: 'my-app',
    authMode: 'supabase',
    freeTier: false,
  });

  // Supabase client module is present in the default path.
  assert('src/supabase.ts' in files, 'expected src/supabase.ts in supabase mode');

  // package.json is valid JSON, names the app, and pulls all three deps.
  const pkg = JSON.parse(files['package.json']);
  assertEquals(pkg.name, 'my-app');
  assert('@quickflo/app-sdk' in pkg.dependencies);
  assert('@quickflo/entitlement-schema' in pkg.dependencies);
  assert('@supabase/supabase-js' in pkg.dependencies);
  assertEquals(pkg.scripts.typecheck, 'tsc --noEmit');
  // Pinned to the SDK line that ships qf.billing + unwrap.
  assertStringIncludes(pkg.dependencies['@quickflo/app-sdk'], '0.7');

  // The auth-token resolver reads the Supabase session.
  assertStringIncludes(files['src/quickflo.ts'], 'supabase.auth.getSession()');

  // .env documents the shared-project requirement.
  assertStringIncludes(files['.env'], 'VITE_SUPABASE_URL=');
  assertStringIncludes(files['.env'], 'VITE_QF_APP_ID=my-app');
});

Deno.test('buildTemplate (none) drops Supabase and stubs getAuthToken', () => {
  const files = buildTemplate({
    name: 'embedded',
    appId: 'embedded',
    authMode: 'none',
    freeTier: false,
  });

  assert(!('src/supabase.ts' in files), 'src/supabase.ts must be absent in none mode');

  const pkg = JSON.parse(files['package.json']);
  assert(!('@supabase/supabase-js' in pkg.dependencies), 'supabase-js must be absent in none mode');

  // getAuthToken is left as a returning-null TODO for the consumer to wire.
  assertStringIncludes(files['src/quickflo.ts'], 'return null;');
  assertStringIncludes(files['.env'], 'NOT portable to quickflo.app');
});

Deno.test('buildTemplate wires the platform org for billing (both auth modes)', () => {
  for (const authMode of ['supabase', 'none'] as const) {
    const files = buildTemplate({
      name: 'my-app',
      appId: 'my-app',
      authMode,
      freeTier: false,
    });
    const client = files['src/quickflo.ts'];
    // PLATFORM_ORG_SUID const + passed to createQuickFloClient as platformOrgSuid.
    assertStringIncludes(client, 'PLATFORM_ORG_SUID');
    assertStringIncludes(client, 'VITE_QF_PLATFORM_ORG_SUID');
    assertStringIncludes(client, 'platformOrgSuid: PLATFORM_ORG_SUID');
    // .env documents the override knob.
    assertStringIncludes(files['.env'], 'VITE_QF_PLATFORM_ORG_SUID');
  }
});

Deno.test('buildTemplate emits anon free-demo helpers only with freeTier', () => {
  const withFlag = buildTemplate({
    name: 'my-app',
    appId: 'my-app',
    authMode: 'supabase',
    freeTier: true,
  });
  const client = withFlag['src/quickflo.ts'];
  assertStringIncludes(client, 'export async function ensureAnonSession');
  assertStringIncludes(client, 'export function isAnonSession');
  assertStringIncludes(client, 'export function platformOpts');
  assertStringIncludes(client, 'signInAnonymously()');
  // SETUP documents the Supabase precondition.
  assertStringIncludes(withFlag['SETUP.md'], 'Allow anonymous sign-ins');

  const without = buildTemplate({
    name: 'my-app',
    appId: 'my-app',
    authMode: 'supabase',
    freeTier: false,
  });
  assert(
    !without['src/quickflo.ts'].includes('ensureAnonSession'),
    'anon helpers must be absent without --free-tier',
  );
  assert(
    !without['SETUP.md'].includes('Allow anonymous sign-ins'),
    'anon precondition must be absent without --free-tier',
  );
});

Deno.test('buildTemplate README documents qf.billing + unwrap + trigger naming', () => {
  const files = buildTemplate({
    name: 'acme-portal',
    appId: 'acme-portal',
    authMode: 'supabase',
    freeTier: false,
  });
  const readme = files['README.md'];
  assertStringIncludes(readme, 'qf.billing.checkout');
  assertStringIncludes(readme, 'unwrap');
  assertStringIncludes(readme, '## Trigger naming');
  // The dotted route example is namespaced to the app id.
  assertStringIncludes(readme, 'acme-portal.start-job');
});

Deno.test('buildTemplate emits a paste-ready apps.config snippet', () => {
  const files = buildTemplate({
    name: 'acme-portal',
    appId: 'acme-portal',
    authMode: 'supabase',
    freeTier: false,
  });
  const snippet = files['apps.config.snippet.md'];

  assertStringIncludes(snippet, "'acme-portal': {");
  assertStringIncludes(snippet, "id: 'acme-portal',");
  // kebab -> PascalCase display name.
  assertStringIncludes(snippet, "displayName: 'AcmePortal',");
  assertStringIncludes(snippet, "packages: [platformPkg('acme-portal-core')],");
  assertStringIncludes(snippet, 'stripeProductIds: [],');
});

Deno.test('buildTemplate emits a SETUP.md checklist with real steps', () => {
  const supa = buildTemplate({
    name: 'my-app',
    appId: 'my-app',
    authMode: 'supabase',
    freeTier: false,
  });
  assert('SETUP.md' in supa, 'expected SETUP.md');
  assertStringIncludes(supa['SETUP.md'], 'Setup checklist — my-app');
  assertStringIncludes(supa['SETUP.md'], '- [ ]');
  assertStringIncludes(supa['SETUP.md'], 'stripe-sync');
  assertStringIncludes(supa['SETUP.md'], 'qf.billing.checkout');
  // Identity step is mode-specific.
  assertStringIncludes(supa['SETUP.md'], 'QuickFlo** Supabase project');

  const none = buildTemplate({
    name: 'embedded',
    appId: 'embedded',
    authMode: 'none',
    freeTier: false,
  });
  assertStringIncludes(none['SETUP.md'], 'Wire `getAuthToken`');
});

Deno.test('buildTemplate emits a valid stripe.config.json', () => {
  const files = buildTemplate({
    name: 'acme-portal',
    appId: 'acme-portal',
    authMode: 'supabase',
    freeTier: false,
  });
  const cfg = JSON.parse(files['stripe.config.json']);

  assertEquals(cfg.appId, 'acme-portal');
  assertEquals(cfg.productName, 'AcmePortal');
  assertEquals(cfg.currency, 'usd');
  assert(Array.isArray(cfg.tiers) && cfg.tiers.length > 0, 'expected at least one tier');
  assertEquals(cfg.tiers[0].prices.length, 2, 'expected monthly + annual prices');
});

Deno.test('buildTemplate honors a custom appId distinct from the dir name', () => {
  const files = buildTemplate({
    name: 'my-app',
    appId: 'acme-portal',
    authMode: 'supabase',
    freeTier: false,
  });

  // Project dir / package name follow `name`; the SKU follows `appId`.
  assertEquals(JSON.parse(files['package.json']).name, 'my-app');
  assertStringIncludes(files['.env'], 'VITE_QF_APP_ID=acme-portal');
  assertStringIncludes(files['apps.config.snippet.md'], "'acme-portal': {");
});
