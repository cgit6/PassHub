import { readFile } from 'node:fs/promises';

test('G10a Mongo runner has bounded cleanup and never creates root-owned build output', async () => {
  const source = await readFile('scripts/test-g10a-integration.mjs', 'utf8');
  expect(source).toContain('const totalDeadlineMs = 300_000');
  expect(source).toContain('const cleanupDeadlineMs = 30_000');
  expect(source).toContain("'run', '--rm', '--name', nodeContainerName");
  expect(source).toContain("'--user', `${uid}:${gid}`");
  expect(source).toContain("'HOME=/tmp/passhub-g10a/home'");
  expect(source).toContain("'NPM_CONFIG_CACHE=/tmp/passhub-g10a/npm-cache'");
  expect(source).toContain('npm run clean && npm run build');
  expect(source).toContain('await removeNamedContainer(cleanupRemainingMs())');
    expect(source).toContain("await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']");
    expect(source).toContain("await run('docker', ['rm', '-f', nodeContainerName]");
  expect(source).toContain('assertOwnedTree');
});
