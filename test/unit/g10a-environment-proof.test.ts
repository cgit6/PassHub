import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'internal-g10a-environment-proof.mjs')).href;
const nodeImage = `node:24.21.0-bookworm-slim@sha256:${'a'.repeat(64)}`;
const compose = ['compose', '--project-name', 'passhub-g10a', '-f', 'infra/g04b-mongo-compose.yml'];

type ProofModule = Readonly<{
  collectG10aEnvironmentProof(input: { captureCommand: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>; nodeImage: string; compose: readonly string[] }): Promise<Record<string, unknown>>;
  parseG10aEnvironmentProofFromOutput(output: unknown): Record<string, unknown> | undefined;
  writeG10aEnvironmentProof(proof: unknown, write?: (line: string) => unknown): void;
}>;

describe('G10a closed integration environment proof', () => {
  test('reduces exact live Node and Mongo facts to a fixed safe proof', async () => {
    const proofModule = await loadProof();
    const calls: { command: string; args: readonly string[] }[] = [];
    const proof = await proofModule.collectG10aEnvironmentProof({
      nodeImage, compose,
      captureCommand: async (command, args) => {
        calls.push({ command, args });
        if (args.at(-1) === '--version') return { code: 0, stdout: 'v24.21.0\n' };
        return { code: 0, stdout: '{"version":"8.0.32","setName":"rs0","isWritablePrimary":true}\n' };
      },
    });
    expect(proof).toEqual({ format: 'passhub.g10a.environment-proof.v1', nodeVersion: '24.21.0', mongoVersion: '8.0.32', replicaSet: 'rs0', writablePrimary: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ command: 'docker', args: ['run', '--rm', '--network', 'host', nodeImage, 'node', '--version'] });
    expect(calls[1]?.args.some((argument) => argument.includes('buildInfo: 1'))).toBe(true);
    expect(JSON.stringify(proof)).not.toMatch(/mongodb|uri|secret|token|command|reply/iu);
  });

  test.each([
    ['Node mismatch', 'v24.21.1\n', '{"version":"8.0.32","setName":"rs0","isWritablePrimary":true}\n'],
    ['Mongo version mismatch', 'v24.21.0\n', '{"version":"8.0.33","setName":"rs0","isWritablePrimary":true}\n'],
    ['non-primary Mongo', 'v24.21.0\n', '{"version":"8.0.32","setName":"rs0","isWritablePrimary":false}\n'],
    ['unexpected Mongo reply field', 'v24.21.0\n', '{"version":"8.0.32","setName":"rs0","isWritablePrimary":true,"uri":"mongodb://secret"}\n'],
  ])('fails closed for %s without exposing captured output', async (_name, nodeOutput, mongoOutput) => {
    const proofModule = await loadProof();
    await expect(proofModule.collectG10aEnvironmentProof({
      nodeImage, compose,
      captureCommand: async (_command, args) => args.at(-1) === '--version'
        ? { code: 0, stdout: nodeOutput }
        : { code: 0, stdout: mongoOutput },
    })).rejects.toThrow(/environment proof could not verify/u);
  });

  test('accepts exactly one safe sentinel and rejects duplicate or expanded proof output', async () => {
    const proofModule = await loadProof();
    const lines: string[] = [];
    proofModule.writeG10aEnvironmentProof({ format: 'passhub.g10a.environment-proof.v1', nodeVersion: '24.21.0', mongoVersion: '8.0.32', replicaSet: 'rs0', writablePrimary: true }, (line) => { lines.push(line); });
    expect(proofModule.parseG10aEnvironmentProofFromOutput(`ordinary output containing mongodb://not-saved\n${lines[0]}`)).toEqual({ format: 'passhub.g10a.environment-proof.v1', nodeVersion: '24.21.0', mongoVersion: '8.0.32', replicaSet: 'rs0', writablePrimary: true });
    expect(proofModule.parseG10aEnvironmentProofFromOutput(`${lines[0]}${lines[0]}`)).toBeUndefined();
    expect(proofModule.parseG10aEnvironmentProofFromOutput('G10A_ENVIRONMENT_PROOF={"format":"passhub.g10a.environment-proof.v1","nodeVersion":"24.21.0","mongoVersion":"8.0.32","replicaSet":"rs0","writablePrimary":true,"uri":"mongodb://secret"}\n')).toBeUndefined();
  });
});

async function loadProof(): Promise<ProofModule> { return await import(moduleUrl) as ProofModule; }
