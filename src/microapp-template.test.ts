import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { buildTemplate } from './microapp-template.ts';

Deno.test('buildTemplate (supabase) wires Supabase identity', () => {
  const files = buildTemplate({ name: 'my-app', appId: 'my-app', authMode: 'supabase' });

  // Supabase client module is present in the default path.
  assert('src/supabase.ts' in files, 'expected src/supabase.ts in supabase mode');

  // package.json is valid JSON, names the app, and pulls all three deps.
  const pkg = JSON.parse(files['package.json']);
  assertEquals(pkg.name, 'my-app');
  assert('@quickflo/app-sdk' in pkg.dependencies);
  assert('@quickflo/entitlement-schema' in pkg.dependencies);
  assert('@supabase/supabase-js' in pkg.dependencies);
  assertEquals(pkg.scripts.typecheck, 'tsc --noEmit');

  // The auth-token resolver reads the Supabase session.
  assertStringIncludes(files['src/quickflo.ts'], 'supabase.auth.getSession()');

  // .env documents the shared-project requirement.
  assertStringIncludes(files['.env'], 'VITE_SUPABASE_URL=');
  assertStringIncludes(files['.env'], 'VITE_QF_APP_ID=my-app');
});

Deno.test('buildTemplate (none) drops Supabase and stubs getAuthToken', () => {
  const files = buildTemplate({ name: 'embedded', appId: 'embedded', authMode: 'none' });

  assert(!('src/supabase.ts' in files), 'src/supabase.ts must be absent in none mode');

  const pkg = JSON.parse(files['package.json']);
  assert(!('@supabase/supabase-js' in pkg.dependencies), 'supabase-js must be absent in none mode');

  // getAuthToken is left as a returning-null TODO for the consumer to wire.
  assertStringIncludes(files['src/quickflo.ts'], 'return null;');
  assertStringIncludes(files['.env'], 'NOT portable to quickflo.app');
});

Deno.test('buildTemplate emits a paste-ready apps.config snippet', () => {
  const files = buildTemplate({ name: 'acme-portal', appId: 'acme-portal', authMode: 'supabase' });
  const snippet = files['apps.config.snippet.md'];

  assertStringIncludes(snippet, "'acme-portal': {");
  assertStringIncludes(snippet, "id: 'acme-portal',");
  // kebab -> PascalCase display name.
  assertStringIncludes(snippet, "displayName: 'AcmePortal',");
  assertStringIncludes(snippet, "packages: [platformPkg('acme-portal-core')],");
  assertStringIncludes(snippet, 'stripeProductIds: [],');
});

Deno.test('buildTemplate emits a valid stripe.config.json', () => {
  const files = buildTemplate({ name: 'acme-portal', appId: 'acme-portal', authMode: 'supabase' });
  const cfg = JSON.parse(files['stripe.config.json']);

  assertEquals(cfg.appId, 'acme-portal');
  assertEquals(cfg.productName, 'AcmePortal');
  assertEquals(cfg.currency, 'usd');
  assert(Array.isArray(cfg.tiers) && cfg.tiers.length > 0, 'expected at least one tier');
  assertEquals(cfg.tiers[0].prices.length, 2, 'expected monthly + annual prices');
});

Deno.test('buildTemplate honors a custom appId distinct from the dir name', () => {
  const files = buildTemplate({ name: 'my-app', appId: 'acme-portal', authMode: 'supabase' });

  // Project dir / package name follow `name`; the SKU follows `appId`.
  assertEquals(JSON.parse(files['package.json']).name, 'my-app');
  assertStringIncludes(files['.env'], 'VITE_QF_APP_ID=acme-portal');
  assertStringIncludes(files['apps.config.snippet.md'], "'acme-portal': {");
});
