import { assert, assertEquals, assertThrows } from '@std/assert';
import type { ApiClient } from './api.ts';
import {
  canonicalizeSlug,
  type PackagesPublishDependencies,
  runPackagesPublish,
} from './packages-publish.ts';

const CLIENT: ApiClient = {
  apiUrl: 'https://api.example.test',
  accessToken: 'test-token',
  orgId: 'org-id',
};

const README = '# Package README\n\nPublished from the CLI.';

interface ApiCall {
  path: string;
  method: string;
  body?: unknown;
}

function publishResponse(packageId: string) {
  return {
    packageVersion: {
      id: 'version-id',
      packageId,
      version: '1.0.0',
    },
    manifest: { slug: '@quickflo/example', version: '1.0.0', resources: [] },
    artifactBytes: 1024,
    artifactDigest: 'digest',
    artifactUrl: 'https://artifacts.example.test/package.zip',
  };
}

function testDependencies(
  handler: (path: string, init: RequestInit) => unknown,
): PackagesPublishDependencies {
  return {
    openSession: () =>
      Promise.resolve({
        client: CLIENT,
        org: { id: 'org-id', suid: 'quickflo', name: 'QuickFlo' },
        apiUrl: CLIENT.apiUrl,
        profileName: null,
      }),
    apiFetch: <T>(_client: ApiClient, path: string, init: RequestInit = {}) =>
      Promise.resolve(handler(path, init) as T),
    readTextFile: () => Promise.resolve(README),
  };
}

function recordCall(calls: ApiCall[], path: string, init: RequestInit): void {
  calls.push({
    path,
    method: init.method ?? 'GET',
    ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
  });
}

Deno.test('canonicalizeSlug: bare name gets @<orgSuid>/ prefix', () => {
  assertEquals(canonicalizeSlug('lead-gen', 'quickflo'), '@quickflo/lead-gen');
});

Deno.test('canonicalizeSlug: already-canonical slug passes through', () => {
  assertEquals(
    canonicalizeSlug('@quickflo/lead-gen', 'quickflo'),
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: scoped slug with unknown org suid passes through', () => {
  assertEquals(
    canonicalizeSlug('@quickflo/lead-gen', undefined),
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: scoped slug for a different org throws with the canonical form', () => {
  assertThrows(
    () => canonicalizeSlug('@other/lead-gen', 'quickflo'),
    Error,
    '@quickflo/lead-gen',
  );
});

Deno.test('canonicalizeSlug: bare name without an org suid throws', () => {
  assertThrows(
    () => canonicalizeSlug('lead-gen', undefined),
    Error,
    'canonical slug',
  );
});

Deno.test('canonicalizeSlug: malformed scoped slugs throw', () => {
  assertThrows(() => canonicalizeSlug('@quickflo', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@/lead-gen', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@quickflo/a/b', 'quickflo'), Error);
  assertThrows(() => canonicalizeSlug('@quickflo/', 'quickflo'), Error);
});

Deno.test('packages publish updates an existing package README before publishing', async () => {
  const calls: ApiCall[] = [];
  const existingPackage = {
    id: 'package-id',
    organizationId: 'org-id',
    slug: '@quickflo/example',
    name: 'Example',
    visibility: 'private' as const,
  };
  const dependencies = testDependencies((path, init) => {
    recordCall(calls, path, init);
    if (path.startsWith('/packages?')) {
      return { data: [existingPackage], total: 1 };
    }
    if (path === '/packages/package-id' && init.method === 'PATCH') {
      return { ...existingPackage, readme: README };
    }
    if (path === '/packages/package-id/versions' && init.method === 'POST') {
      return publishResponse(existingPackage.id);
    }
    throw new Error(`Unexpected API call: ${init.method ?? 'GET'} ${path}`);
  });

  await runPackagesPublish({
    packageRef: 'example',
    version: '1.0.0',
    roots: ['workflow:workflow-id'],
    readmeFile: './README.md',
  }, dependencies);

  assertEquals(calls.map((call) => call.method), ['GET', 'PATCH', 'POST']);
  assertEquals(calls[1], {
    path: '/packages/package-id',
    method: 'PATCH',
    body: { readme: README },
  });
  assertEquals(calls[2].path, '/packages/package-id/versions');
  assertEquals(calls[2].body, {
    version: '1.0.0',
    roots: [{ kind: 'workflow', workflowTemplateId: 'workflow-id' }],
  });
});

Deno.test('packages publish stores README while auto-creating the package', async () => {
  const calls: ApiCall[] = [];
  const createdPackage = {
    id: 'package-id',
    organizationId: 'org-id',
    slug: '@quickflo/example',
    name: 'Example',
    visibility: 'private' as const,
    readme: README,
  };
  const dependencies = testDependencies((path, init) => {
    recordCall(calls, path, init);
    if (path.startsWith('/packages?')) {
      return { data: [], total: 0 };
    }
    if (path === '/packages' && init.method === 'POST') {
      return createdPackage;
    }
    if (path === '/packages/package-id/versions' && init.method === 'POST') {
      return publishResponse(createdPackage.id);
    }
    throw new Error(`Unexpected API call: ${init.method ?? 'GET'} ${path}`);
  });

  await runPackagesPublish({
    packageRef: 'example',
    name: 'Example',
    version: '1.0.0',
    roots: ['workflow:workflow-id'],
    readmeFile: './README.md',
  }, dependencies);

  const createCall = calls.find((call) => call.path === '/packages' && call.method === 'POST');
  assert(createCall);
  assertEquals(createCall.body, {
    slug: '@quickflo/example',
    name: 'Example',
    visibility: 'private',
    readme: README,
  });
  assertEquals(calls.filter((call) => call.method === 'PATCH').length, 0);

  const versionCall = calls.find((call) => call.path.endsWith('/versions'));
  assert(versionCall);
  assertEquals(versionCall.body, {
    version: '1.0.0',
    roots: [{ kind: 'workflow', workflowTemplateId: 'workflow-id' }],
  });
});
