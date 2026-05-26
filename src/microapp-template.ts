/**
 * Templates for `quickflo microapp new`.
 *
 * `buildTemplate(opts)` returns a flat `{ relativePath -> contents }` map for a
 * Vite + TS micro-app pre-wired to `@quickflo/app-sdk` (auth + onboarding +
 * entitlement + webhook/form trigger clients). Two auth modes:
 *
 *   - `'supabase'` (default): identity comes from the shared QuickFlo Supabase
 *     project. The SDK's `getAuthToken` resolver reads the Supabase session
 *     access token. This is the path that makes a user's identity portable to
 *     quickflo.app (sign up here, later sign in there, same org).
 *   - `'none'`: no identity wiring — `getAuthToken` is a TODO returning null.
 *     For embedded / non-Supabase hosts (e.g. a Zoom app). NOT account-portable.
 *
 * Templates are inlined as strings (not read from disk) so they survive
 * `deno compile` into the distributed binary, where there is no source tree to
 * read from at runtime.
 */

export type MicroappAuthMode = 'supabase' | 'none';

export interface TemplateOptions {
  /** kebab-case app name (also the project directory name). */
  name: string;
  /** App SKU bound into the SDK + checked for entitlement. Defaults to `name`. */
  appId: string;
  /** Identity wiring. */
  authMode: MicroappAuthMode;
}

// Pinned to the currently-published majors. Bump when the SDK ships a new line.
const SDK_VERSION = '^0.6.0';
const ENTITLEMENT_SCHEMA_VERSION = '^0.5.0';
const SUPABASE_VERSION = '^2.45.0';
const VITE_VERSION = '^5.4.0';
const TYPESCRIPT_VERSION = '^5.5.0';

function packageJson(opts: TemplateOptions): string {
  const dependencies: Record<string, string> = {
    '@quickflo/app-sdk': SDK_VERSION,
    '@quickflo/entitlement-schema': ENTITLEMENT_SCHEMA_VERSION,
  };
  if (opts.authMode === 'supabase') {
    dependencies['@supabase/supabase-js'] = SUPABASE_VERSION;
  }
  const pkg = {
    name: opts.name,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview',
      typecheck: 'tsc --noEmit',
    },
    dependencies,
    devDependencies: {
      typescript: TYPESCRIPT_VERSION,
      vite: VITE_VERSION,
    },
  };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function tsconfig(): string {
  const cfg = {
    compilerOptions: {
      target: 'ES2022',
      useDefineForClassFields: true,
      module: 'ESNext',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      moduleResolution: 'bundler',
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      types: ['vite/client'],
    },
    include: ['src'],
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

function viteConfig(): string {
  return `import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
});
`;
}

function gitignore(): string {
  return `node_modules
dist
.env
.env.local
*.local
.DS_Store
`;
}

function envFile(opts: TemplateOptions): string {
  if (opts.authMode === 'supabase') {
    return `# QuickFlo identity (shared Supabase project)
# IMPORTANT: point these at the QuickFlo Supabase project, NOT your own.
# Using the QF project is what makes a user's identity portable to quickflo.app:
# sign up here, later sign in at quickflo.app, and see the same organization.
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# QuickFlo app binding
# The app SKU this micro-app installs into and checks entitlement against.
# Must match an entry in apps.config.ts in the workflows repo.
VITE_QF_APP_ID=${opts.appId}

# Optional host overrides (defaults: go.quickflo.app / run.quickflo.app)
# VITE_QF_API_BASE_URL=
# VITE_QF_TRIGGERS_BASE_URL=

# Optional: demo the form client.
# Create a form trigger in the workflow builder with auth.provider = 'qf-identity',
# then put its name here to exercise qf.forms.getFormSchema(...) on the dashboard.
# VITE_QF_FORM_NAME=
`;
  }
  return `# QuickFlo app binding
# The app SKU this micro-app installs into and checks entitlement against.
# Must match an entry in apps.config.ts in the workflows repo.
VITE_QF_APP_ID=${opts.appId}

# Optional host overrides (defaults: go.quickflo.app / run.quickflo.app)
# VITE_QF_API_BASE_URL=
# VITE_QF_TRIGGERS_BASE_URL=

# NOTE: --auth none was selected. Wire getAuthToken in src/quickflo.ts to your
# identity provider. Non-Supabase identity is NOT portable to quickflo.app.
`;
}

function indexHtml(opts: TemplateOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${opts.name} — QuickFlo micro-app</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main id="app"><p class="muted">Loading…</p></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function supabaseClient(): string {
  return `import { createClient } from '@supabase/supabase-js';

// Point these at the QuickFlo Supabase project (see .env + README). Using the
// QF project is what makes this user's identity portable to quickflo.app.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey);
`;
}

function quickfloClientSupabase(opts: TemplateOptions): string {
  return `import { createQuickFloClient } from '@quickflo/app-sdk';
import { supabase } from './supabase';

const appId = import.meta.env.VITE_QF_APP_ID ?? '${opts.appId}';

// The SDK is bring-your-own-JWT. In the shared-Supabase path the QuickFlo
// identity token IS the Supabase session access token.
export const qf = createQuickFloClient({
  appId,
  getAuthToken: async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  },
  apiBaseUrl: import.meta.env.VITE_QF_API_BASE_URL || undefined,
  triggersBaseUrl: import.meta.env.VITE_QF_TRIGGERS_BASE_URL || undefined,
  onUnauthenticated: () => {
    console.warn('[quickflo] no active session — sign in first.');
  },
  onPaywall: (entitlement) => {
    console.warn('[quickflo] entitlement inactive:', entitlement.status);
  },
});
`;
}

function quickfloClientNone(opts: TemplateOptions): string {
  return `import { createQuickFloClient } from '@quickflo/app-sdk';

const appId = import.meta.env.VITE_QF_APP_ID ?? '${opts.appId}';

export const qf = createQuickFloClient({
  appId,
  // TODO: return the current QuickFlo identity JWT, or null when signed out.
  // Embedded hosts (e.g. a Zoom app) resolve their own token here.
  // NOTE: non-Supabase identity is NOT portable to quickflo.app — see README.
  getAuthToken: async () => {
    return null;
  },
  apiBaseUrl: import.meta.env.VITE_QF_API_BASE_URL || undefined,
  triggersBaseUrl: import.meta.env.VITE_QF_TRIGGERS_BASE_URL || undefined,
});
`;
}

function mainSupabase(opts: TemplateOptions): string {
  return `import { qf } from './quickflo';
import { supabase } from './supabase';
import './style.css';

const app = document.querySelector('#app');

function render(html: string): void {
  if (app) {
    app.innerHTML = html;
  }
}

function wireSignOut(): void {
  const btn = document.querySelector('#signout');
  btn?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    qf.clearCache();
    void boot();
  });
}

async function showSignedIn(): Promise<void> {
  render('<p class="muted">Onboarding…</p>');

  const onboarded = await qf.ensureOnboarded();
  if (onboarded.error || !onboarded.data) {
    render(
      '<h1>Onboarding failed</h1>' +
        '<p class="error">' + (onboarded.error?.message ?? 'Unknown error') + '</p>' +
        '<button id="signout">Sign out</button>',
    );
    wireSignOut();
    return;
  }

  const { orgId, orgSuid, entitlement } = onboarded.data;
  const formName = import.meta.env.VITE_QF_FORM_NAME;
  const formNote = formName
    ? '<p class="muted">Form trigger configured: <code>' + formName + '</code></p>'
    : '<p class="muted">Set <code>VITE_QF_FORM_NAME</code> in .env to demo the form client.</p>';

  render(
    '<h1>Signed in</h1>' +
      '<dl>' +
      '<dt>Org</dt><dd><code>' + orgId + '</code> &middot; <code>@' + orgSuid + '</code></dd>' +
      '<dt>App</dt><dd><code>' + qf.config.appId + '</code></dd>' +
      '<dt>Tier</dt><dd><code>' + entitlement.tier + '</code></dd>' +
      '<dt>Entitlement</dt><dd>' + (entitlement.active ? '✓ active' : '✗ inactive') +
      ' (<code>' + entitlement.status + '</code>)</dd>' +
      '</dl>' +
      formNote +
      '<button id="signout">Sign out</button>',
  );
  wireSignOut();
}

// Sign-in is a one-time email CODE flow (not a magic-link redirect): the code
// is origin-independent, so it works on any micro-app domain with no Supabase
// redirect-URL allow-listing. Step 1 emails the code; step 2 verifies it.
function showEmailStep(): void {
  render(
    '<h1>${opts.name}</h1>' +
      '<p class="muted">Sign in with a one-time code sent to your email.</p>' +
      '<form id="email-form">' +
      '<input id="email" type="email" placeholder="you@example.com" required />' +
      '<button type="submit">Email me a code</button>' +
      '</form>' +
      '<p id="status" class="muted"></p>',
  );
  const form = document.querySelector('#email-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('#email');
    const status = document.querySelector('#status');
    const email = input instanceof HTMLInputElement ? input.value.trim() : '';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) {
      if (status) {
        status.textContent = error.message;
      }
      return;
    }
    showCodeStep(email);
  });
}

function showCodeStep(email: string): void {
  render(
    '<h1>${opts.name}</h1>' +
      '<p class="muted">Enter the 6-digit code sent to <strong>' + email + '</strong>.</p>' +
      '<form id="code-form">' +
      '<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required />' +
      '<button type="submit">Verify</button>' +
      '</form>' +
      '<p id="status" class="muted"></p>',
  );
  const form = document.querySelector('#code-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.querySelector('#code');
    const status = document.querySelector('#status');
    const token = input instanceof HTMLInputElement ? input.value.trim() : '';
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
    if (error) {
      if (status) {
        status.textContent = error.message;
      }
      return;
    }
    // Session established — onAuthStateChange also fires; render now.
    await showSignedIn();
  });
}

async function boot(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    await showSignedIn();
  } else {
    showEmailStep();
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (session) {
    void showSignedIn();
  }
});

void boot();
`;
}

function mainNone(opts: TemplateOptions): string {
  return `import { qf } from './quickflo';
import './style.css';

const app = document.querySelector('#app');

function render(html: string): void {
  if (app) {
    app.innerHTML = html;
  }
}

async function boot(): Promise<void> {
  render('<h1>${opts.name}</h1><p class="muted">Checking entitlement…</p>');

  const result = await qf.requireActiveEntitlement();
  if (result.error || !result.data) {
    render(
      '<h1>${opts.name}</h1>' +
        '<p class="error">' + (result.error?.message ?? 'No active entitlement') + '</p>' +
        '<p class="muted">Wire <code>getAuthToken</code> in <code>src/quickflo.ts</code> to your identity provider, then reload.</p>',
    );
    return;
  }

  const entitlement = result.data;
  render(
    '<h1>${opts.name}</h1>' +
      '<dl>' +
      '<dt>App</dt><dd><code>' + qf.config.appId + '</code></dd>' +
      '<dt>Tier</dt><dd><code>' + entitlement.tier + '</code></dd>' +
      '<dt>Entitlement</dt><dd>' + (entitlement.active ? '✓ active' : '✗ inactive') +
      ' (<code>' + entitlement.status + '</code>)</dd>' +
      '</dl>',
  );
}

void boot();
`;
}

function styleCss(): string {
  return `:root {
  color-scheme: light;
  --bg: #ffffff;
  --fg: #18181b;
  --muted: #71717a;
  --border: #e4e4e7;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --error: #dc2626;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  line-height: 1.5;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  display: grid;
  place-items: center;
  min-height: 100vh;
}

#app {
  width: min(34rem, 90vw);
  padding: 2rem;
}

h1 {
  font-size: 1.4rem;
  margin: 0 0 1rem;
}

.muted {
  color: var(--muted);
  font-size: 0.9rem;
}

.error {
  color: var(--error);
}

dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1rem;
  margin: 0 0 1rem;
}

dt {
  font-weight: 600;
  color: var(--muted);
}

dd {
  margin: 0;
}

code {
  font-family: ui-monospace, monospace;
  font-size: 0.85em;
}

form {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.75rem;
}

input,
button {
  font: inherit;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
}

input {
  flex: 1;
  background: var(--bg);
  color: var(--fg);
}

input:focus {
  outline: none;
  border-color: var(--accent);
}

button {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
  cursor: pointer;
}

button:hover {
  background: #1d4ed8;
}
`;
}

/**
 * Declarative Stripe spec consumed by `quickflo microapp stripe-sync`. One
 * paid tier with monthly + annual prices by default. `limits` / `features` are
 * stamped onto each price as metadata so the `*-core` Stripe webhook workflow
 * can read what a subscription grants. Free tier has no price (it's the
 * `defaultEntitlement` seed in apps.config.ts).
 */
function stripeConfig(opts: TemplateOptions): string {
  const cfg = {
    appId: opts.appId,
    productName: toDisplayName(opts.appId),
    currency: 'usd',
    tiers: [
      {
        tier: 'pro',
        limits: { runs_per_month: 10000 },
        features: ['priority-support'],
        prices: [
          { interval: 'month', amount: 4900 },
          { interval: 'year', amount: 49000 },
        ],
      },
    ],
  };
  return JSON.stringify(cfg, null, 2) + '\n';
}

/** kebab-case -> PascalCase display name (e.g. `acme-portal` -> `AcmePortal`). */
function toDisplayName(name: string): string {
  return name
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Paste-ready entry for the `APPS` registry in the workflows repo
 * (`libs/shared/src/lib/apps.config.ts`). Mirrors the `App` interface there:
 * `platformPkg(...)` is already imported in that file, so the snippet drops in
 * as-is. Shipped as markdown so no project tooling ever tries to compile the
 * fragment.
 */
function appConfigSnippet(opts: TemplateOptions): string {
  const displayName = toDisplayName(opts.appId);
  return `# apps.config.ts snippet

Register this app's SKU in the **workflows** repo so the onboarding endpoint
installs the right package and seeds a default entitlement.

1. Open \`libs/shared/src/lib/apps.config.ts\`.
2. Paste the entry below into the \`APPS\` object (\`platformPkg\` is already
   imported there).
3. Adjust \`packages\`, \`tier\`, and \`stripeProductIds\` to match your app, then
   commit.

\`\`\`ts
  '${opts.appId}': {
    id: '${opts.appId}',
    displayName: '${displayName}',
    packages: [platformPkg('${opts.appId}-core')],
    defaultEntitlement: {
      active: false,
      tier: 'free',
    },
    stripeProductIds: [],
  },
\`\`\`

The \`${opts.appId}-core\` package is the backend bundle (workflows + triggers +
data) this app installs on first launch. Author it with
\`quickflo package new\`, then publish + install it into your org.
`;
}

function readme(opts: TemplateOptions): string {
  const authSection = opts.authMode === 'supabase'
    ? `## Identity: shared QuickFlo Supabase project

This app authenticates against the **QuickFlo Supabase project** — not your own.
That is deliberate: a user who signs up here can later sign in at quickflo.app
and see the same organization, because QuickFlo finds-or-creates its identity by
Supabase user id. One shared project is what makes that portability work.

Fill in \`.env\`:

\`\`\`
VITE_SUPABASE_URL=        # the QuickFlo Supabase project URL
VITE_SUPABASE_ANON_KEY=   # the QuickFlo Supabase anon key
\`\`\`

\`src/quickflo.ts\` wires the SDK's \`getAuthToken\` resolver to the Supabase
session access token. \`src/main.ts\` demonstrates the full loop: one-time-code
sign-in (\`signInWithOtp\` → \`verifyOtp\`), \`ensureOnboarded()\`, and an
entitlement readout.

> **Why a code, not a magic link?** The shared QuickFlo Supabase email carries
> both, but the magic link only redirects to URLs allow-listed in the QF
> project (e.g. quickflo.app) — your micro-app's domain isn't, so the link
> won't return here. The 6-digit code is origin-independent and needs no
> Supabase config. To use magic links instead, add your app's domain to the QF
> project's Redirect URLs and switch \`src/main.ts\` to \`emailRedirectTo\`.`
    : `## Identity: bring your own (\`--auth none\`)

This app was scaffolded without Supabase wiring. \`src/quickflo.ts\` leaves
\`getAuthToken\` as a TODO that returns \`null\` — wire it to your identity
provider (e.g. an embedded host's token).

**Trade-off:** non-Supabase identity is **not** portable to quickflo.app. A user
signed in through a custom provider here will not automatically resolve to a
QuickFlo org at quickflo.app. Use the default (Supabase) mode if portability
matters.`;

  return `# ${opts.name}

A QuickFlo micro-app: a custom UI on top of QuickFlo auth + backend, scaffolded
with \`quickflo microapp new\`. Built on [\`@quickflo/app-sdk\`](https://www.npmjs.com/package/@quickflo/app-sdk).

## Develop

\`\`\`bash
pnpm install     # or npm install
pnpm dev         # vite dev server on http://localhost:5173
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc + vite build
\`\`\`

${authSection}

## Before it runs: wire up the backend

The scaffolder cannot provision your QuickFlo org for you. Complete these steps:

1. **Register the app SKU.** Copy the paste-ready entry in
   [\`apps.config.snippet.md\`](./apps.config.snippet.md) into the \`APPS\` object
   in \`libs/shared/src/lib/apps.config.ts\` (workflows repo) so onboarding +
   entitlement know about \`${opts.appId}\`.
2. **Author the backend package.** Run \`quickflo package new\` to create the
   \`${opts.appId}-core\` package (workflows + triggers + data the app needs),
   then publish + install it into your org.
3. **Point the env vars at QuickFlo.**${
    opts.authMode === 'supabase'
      ? ' Set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to the **QuickFlo** Supabase project (see above).'
      : ' Set `VITE_QF_APP_ID` and wire `getAuthToken` in `src/quickflo.ts`.'
  }
4. **Create a form trigger** in the workflow builder with
   \`auth.provider = 'qf-identity'\`, then set its name in \`.env\`:

   \`\`\`
   VITE_QF_FORM_NAME=<your-form-trigger-name>
   \`\`\`

   With \`qf-identity\`, the form trusts the QuickFlo identity token the SDK
   already carries — no second login. The dashboard exercises
   \`qf.forms.getFormSchema(...)\` when this is set.
5. **Provision Stripe billing.** Edit [\`stripe.config.json\`](./stripe.config.json)
   (tiers, prices, the limits/features each tier grants), then run:

   \`\`\`bash
   STRIPE_API_KEY=sk_test_… quickflo microapp stripe-sync
   \`\`\`

   This find-or-creates the Stripe product + prices (idempotent — safe to
   re-run) and writes the resulting IDs back into \`stripe.ids.json\` and the
   \`stripeProductIds\` line of \`apps.config.snippet.md\`. Pass \`--live\` to target
   live mode. Free tier needs no price — it's the \`defaultEntitlement\` seed.

## What the SDK gives you

The \`qf\` client in \`src/quickflo.ts\` exposes:

- \`qf.ensureOnboarded()\` — provision/lookup the user's org + entitlement (cached).
- \`qf.requireActiveEntitlement()\` — page guard; fires \`onUnauthenticated\` / \`onPaywall\`.
- \`qf.getCachedOnboarding()\` / \`qf.getCachedEntitlement()\` — sync cache reads.
- \`qf.webhooks.run(name, body, opts?)\` — call a webhook-triggered workflow (orgSuid auto-fills from onboarding).
- \`qf.forms.*\` — the full form lifecycle: \`getFormSchema\`, \`getFormPrefill\`,
  \`uploadFormFile\`, \`getFormConfirmation\`, \`submitForm\`, plus credentials/OTP/magic-link
  auth for external-user forms.

Every HTTP method returns \`{ data, error, response }\` — check \`error\` before
reading \`data\`.
`;
}

/** Actionable "before you go live" checklist, pre-filled for this app. */
function setupChecklist(opts: TemplateOptions): string {
  const identityStep = opts.authMode === 'supabase'
    ? "- [ ] Set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `.env` to the **QuickFlo** Supabase project (not your own — that's what makes identity portable to quickflo.app)."
    : '- [ ] Wire `getAuthToken` in `src/quickflo.ts` to your identity provider (`--auth none` was selected — non-Supabase identity is not portable to quickflo.app).';

  return `# Setup checklist — ${opts.name}

Everything left before \`${opts.name}\` is live. Generated by \`quickflo microapp new\`.

## Backend wiring (workflows repo)
- [ ] Register the SKU: paste the entry from \`apps.config.snippet.md\` into the \`APPS\` object in \`libs/shared/src/lib/apps.config.ts\`.
- [ ] Author the backend bundle: \`quickflo package new\` → build \`${opts.appId}-core\` (workflows + triggers + data), publish, and install it into your org.
- [ ] Create the form trigger in the workflow builder with \`auth.provider = 'qf-identity'\`, then set its name in \`.env\` as \`VITE_QF_FORM_NAME\`.

## Identity
${identityStep}

## Billing (Stripe)
- [ ] Review \`stripe.config.json\` — tiers, prices, and the limits/features each tier grants.
- [ ] \`quickflo microapp stripe-sync\` against test mode, then \`--live\` for production.
- [ ] Confirm \`stripeProductIds\` is populated in \`apps.config.snippet.md\` and \`VITE_QF_PRICE_*\` landed in \`.env\`.
- [ ] Wire checkout in the app using those price ids (or their lookup keys).

## Ship
- [ ] \`pnpm build\` succeeds.
- [ ] Deploy the static build to your host.
- [ ] Smoke test the full loop: sign in → onboarding → entitlement readout → submit a \`qf-identity\` form with no second login.
`;
}

export function buildTemplate(opts: TemplateOptions): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': packageJson(opts),
    'tsconfig.json': tsconfig(),
    'vite.config.ts': viteConfig(),
    '.gitignore': gitignore(),
    '.env': envFile(opts),
    '.env.example': envFile(opts),
    'index.html': indexHtml(opts),
    'README.md': readme(opts),
    'SETUP.md': setupChecklist(opts),
    'apps.config.snippet.md': appConfigSnippet(opts),
    'stripe.config.json': stripeConfig(opts),
    'src/style.css': styleCss(),
    'src/quickflo.ts': opts.authMode === 'supabase'
      ? quickfloClientSupabase(opts)
      : quickfloClientNone(opts),
    'src/main.ts': opts.authMode === 'supabase' ? mainSupabase(opts) : mainNone(opts),
  };
  if (opts.authMode === 'supabase') {
    files['src/supabase.ts'] = supabaseClient();
  }
  return files;
}
