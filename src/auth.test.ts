import { assertEquals } from '@std/assert';
import { formatAuthUseConfirmation, type Profile } from './auth.ts';

const profile: Profile = {
  apiUrl: 'https://api.example.test/api',
  token: 'test-token',
  orgSuid: 'acme',
  orgName: 'Acme',
  savedAt: '2026-08-11T00:00:00.000Z',
};

const ansiPattern = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const stripAnsi = (value: string): string => value.replace(ansiPattern, '');

Deno.test('auth use confirmation includes the selected profile API URL', () => {
  assertEquals(
    formatAuthUseConfirmation('acme', profile).map(stripAnsi),
    [
      '✓ Active profile: acme',
      '  API: https://api.example.test/api',
      '  Acme (acme)',
    ],
  );
});
