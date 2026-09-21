import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';

import {
  createG07bAdmissionHandler,
  createHttpResponsePlanBundle,
  createAdmissionWorkHandoffBundle,
  createUnknownRecognitionCoordinatorBundle,
  type AdmissionValidationInput,
  type AdmissionValidationResult,
  type AdmissionWriterOutcome,
  type HttpResponsePlan,
} from '../../src/composition/internal/index.js';
import { createPassHubHttpApplication, type PassHubHttpApplication } from '../../src/composition/internal/http-application.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';

interface Result { readonly status: number; readonly body: Record<string, unknown>; }
interface Gate<T> { readonly promise: Promise<T>; resolve(value: T): void; }
function gate<T>(): Gate<T> { let resolve!: (value: T) => void; return { promise: new Promise<T>((r) => { resolve = r; }), resolve }; }

function send(port: number, method: string, path: string, body: Record<string, unknown> | null = null,
  extra: Record<string, string> = {}): Promise<Result> {
  const wire = body === null ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, agent: false, headers: {
      ...(wire === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(wire)) }), ...extra,
    } }, (res) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
    }); });
    req.once('error', reject); req.end(wire);
  });
}

interface Harness {
  readonly app: PassHubHttpApplication; readonly port: number;
  readonly calls: string[]; readonly unknown: ReturnType<typeof createUnknownRecognitionCoordinatorBundle>;
}

async function harness(options: {
  readonly validate?: (input: AdmissionValidationInput, standard: () => AdmissionValidationResult) => Promise<AdmissionValidationResult>;
  readonly recognitionDisposition?: AdmissionWriterOutcome['disposition'];
  readonly claim?: 'WRITABLE' | 'READ_ONLY';
} = {}): Promise<Harness> {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const unknown = createUnknownRecognitionCoordinatorBundle();
  const capabilities = createOperationRegistryCapabilityIssuer({ registryId: 'g07b', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner',
    sameArtifact: (a, b) => (a as { digest: string }).digest === (b as { digest: string }).digest });
  const registry = createOperationRegistry({ capabilities, writeRunClaim: capabilities.issueWriteRunClaim(options.claim ?? 'WRITABLE'),
    assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined });
  const calls: string[] = [];
  const ok = (kind: string, extra: Record<string, unknown> = {}): HttpResponsePlan => plans.business.issue(200, { kind, ...extra });
  const standard = (input: AdmissionValidationInput): AdmissionValidationResult => {
    const body = (input.accepted.body ?? {}) as Record<string, unknown>;
    if (input.routeId === 'AUTH_LOGIN') return Object.freeze({ kind: 'LOGIN', workInput: handoff.issuer.issue(input.routeId) });
    if (input.routeId === 'RECOGNITION_ATTEMPT') {
      const event = typeof body.externalEventId === 'string' ? body.externalEventId : 'event-default';
      const digest = typeof body.digest === 'string' ? body.digest : 'same';
      return Object.freeze({ kind: 'RECOGNITION', registryKey: capabilities.issueKey('source-1', event),
        comparisonArtifact: capabilities.issueComparisonArtifact(Object.freeze({ digest })), workInput: handoff.issuer.issue(input.routeId) });
    }
    if (input.routeId.startsWith('QUALIFICATION_') && ['QUALIFICATION_CREATE', 'QUALIFICATION_UPDATE', 'QUALIFICATION_REVOKE'].includes(input.routeId)) {
      return Object.freeze({ kind: 'MANAGEMENT', accountId: 'account-1', workInput: handoff.issuer.issue(input.routeId) });
    }
    return Object.freeze({ kind: 'QUERY', accountId: 'account-1', workInput: handoff.issuer.issue(input.routeId) });
  };
  const handler = createG07bAdmissionHandler({ currentDatasetEpoch: EPOCH, registry, registryCapabilities: capabilities, responsePlans: plans,
    workHandoff: handoff, unknownRecognition: unknown.handler,
    validator: { validate: (input) => options.validate?.(input, () => standard(input)) ?? Promise.resolve(standard(input)) },
    work: {
      login: () => { calls.push('login'); return Promise.resolve(ok('login')); },
      query: () => { calls.push('query'); return Promise.resolve(ok('query')); },
      management: (_token, context) => { calls.push(`management:${context.sequence}`); return Promise.resolve(Object.freeze({ disposition: 'BUSINESS_RESULT_PERSISTED', response: ok('management') })); },
      recognition: (_token, context) => { calls.push(`recognition:${context.sequence}`); const disposition = options.recognitionDisposition ?? 'BUSINESS_RESULT_PERSISTED';
        return Promise.resolve(Object.freeze({ disposition, response: ok('recognition', { disposition }) })); },
    } });
  const app = await createPassHubHttpApplication(handler); await app.nestApplication.listen(0, '127.0.0.1');
  const address = app.server.address(); if (address === null || typeof address === 'string') throw new Error('no port');
  return { app, port: address.port, calls, unknown };
}

describe('G07b true HTTP admission composition', () => {
  const apps: PassHubHttpApplication[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.nestApplication.close())); });
  const use = async (options?: Parameters<typeof harness>[0]): Promise<Harness> => { const h = await harness(options); apps.push(h.app); return h; };

  test('route/method/trailing slash and write epoch are rejected before validation', async () => {
    const h = await use();
    expect((await send(h.port, 'POST', '/qualifications', {})).body.code).toBe('INVALID_DATASET_EPOCH');
    expect((await send(h.port, 'POST', '/qualifications', {}, { 'PassHub-Dataset-Epoch': 'bad' })).body.code).toBe('INVALID_DATASET_EPOCH');
    expect((await send(h.port, 'POST', '/qualifications', {}, { 'PassHub-Dataset-Epoch': '22222222-2222-4222-8222-222222222222' })).body.code).toBe('DATASET_EPOCH_MISMATCH');
    expect((await send(h.port, 'POST', '/qualifications/', {}, { 'PassHub-Dataset-Epoch': EPOCH })).status).toBe(404);
    expect(h.calls).toEqual([]);
  });

  test('slow writer validation remains FIFO while a nonwriter completes independently', async () => {
    const standards: AdmissionValidationResult[] = []; const gates = [gate<AdmissionValidationResult>(), gate<AdmissionValidationResult>()]; let index = 0;
    const h = await use({ validate: (input, standard) => { if (input.routeId !== 'QUALIFICATION_CREATE') return Promise.resolve(standard()); standards.push(standard()); return gates[index++]!.promise; } });
    const a = send(h.port, 'POST', '/qualifications', { n: 1 }, { 'PassHub-Dataset-Epoch': EPOCH });
    const b = send(h.port, 'POST', '/qualifications', { n: 2 }, { 'PassHub-Dataset-Epoch': EPOCH });
    await new Promise((r) => setTimeout(r, 20)); gates[1]!.resolve(standards[1]!); await new Promise((r) => setTimeout(r, 10));
    const query = await send(h.port, 'GET', '/events'); expect(query.body.kind).toBe('query');
    expect(h.calls).toEqual(['query']); gates[0]!.resolve(standards[0]!); await Promise.all([a, b]);
    expect(h.calls).toEqual(['query', 'management:0', 'management:1']);
  });

  test('normal recognition registers canonical result; same content replays and conflict returns 409', async () => {
    const h = await use(); const headers = { 'PassHub-Dataset-Epoch': EPOCH };
    const first = await send(h.port, 'POST', '/recognition/attempts', { externalEventId: 'event-1', digest: 'a' }, headers);
    const replay = await send(h.port, 'POST', '/recognition/attempts', { externalEventId: 'event-1', digest: 'a' }, headers);
    const conflict = await send(h.port, 'POST', '/recognition/attempts', { externalEventId: 'event-1', digest: 'b' }, headers);
    expect(first.body).toMatchObject({ kind: 'recognition', disposition: 'BUSINESS_RESULT_PERSISTED', currentDatasetEpoch: EPOCH });
    expect(replay.body).toEqual(first.body); expect(conflict).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(h.calls).toEqual(['recognition:0']);
  });

  test('existing-only never creates work and observes PAUSED_UNKNOWN after unknown original', async () => {
    const h = await use({ recognitionDisposition: 'UNKNOWN_EFFECT' }); const normal = { 'PassHub-Dataset-Epoch': EPOCH };
    const first = await send(h.port, 'POST', '/recognition/attempts', { externalEventId: 'event-u', digest: 'a' }, normal);
    expect(first).toMatchObject({ status: 503, body: { code: 'REQUEST_STATUS_UNCONFIRMED' } });
    const retry = await send(h.port, 'POST', '/recognition/attempts', { externalEventId: 'event-u', digest: 'a' }, { ...normal, 'PassHub-Retry-Mode': 'existing-only' });
    expect(retry).toMatchObject({ status: 202, body: { externalEventId: 'event-u', stage: 'PAUSED_UNKNOWN', confirmationState: 'NOT_STARTED', control: 'NONE' } });
    expect(h.calls).toEqual(['recognition:0']); expect(h.unknown.drain.drain()).toHaveLength(1);
  });

  test('client disconnect after handoff does not cancel admitted work', async () => {
    const validation = gate<AdmissionValidationResult>(); let standard!: AdmissionValidationResult;
    const h = await use({ validate: (input, make) => { if (input.routeId === 'QUALIFICATION_CREATE') { standard = make(); return validation.promise; } return Promise.resolve(make()); } });
    const socket = createConnection({ host: '127.0.0.1', port: h.port });
    socket.write(`POST /qualifications HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nPassHub-Dataset-Epoch: ${EPOCH}\r\n\r\n{}`);
    await new Promise((r) => setTimeout(r, 30)); socket.destroy(); validation.resolve(standard);
    for (let i = 0; i < 50 && h.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(h.calls).toEqual(['management:0']);
  });
});
