import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { createG07bAdmissionHandler } from '../../src/composition/internal/g07b-admission-handler.js';
import { createAdmissionWorkHandoffBundle } from '../../src/composition/internal/admission-work-handoff.js';
import { createHttpResponsePlanBundle } from '../../src/composition/internal/http-response-plan.js';
import { createUnknownRecognitionCoordinatorBundle } from '../../src/composition/internal/unknown-recognition-coordinator.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import { createFixedMinuteRateLedger } from '../../src/composition/internal/fixed-minute-rate-ledger.js';
import { bindTrustedIngressClientAddress, readTrustedIngressClientAddress } from '../../src/composition/internal/trusted-ingress-client-address.js';
import { LocalServiceGate, createOrdinaryReadOnlyServiceGate } from '../../src/composition/internal/g11b-claimed-runtime-bootstrap.js';
import { createOperationRegistry, createOperationRegistryCapabilityIssuer } from '../../src/access/application/internal/operation-registry.js';
import { createG11bProductionHttpHandler } from '../../src/deployment/internal/g11b-production-http-lifecycle.js';

const EPOCH = '11111111-1111-4111-8111-111111111111';
const PROXY = '172.31.211.10';

class Response extends EventEmitter {
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  readonly finished: Promise<void>;
  constructor() {
    super();
    this.finished = new Promise((resolve) => this.once('finish', resolve));
  }
  setHeader(): void { /* response metadata does not change rate identity */ }
  end(): void { this.writableEnded = true; this.emit('finish'); }
}

function loginAdmission() {
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: EPOCH });
  const handoff = createAdmissionWorkHandoffBundle();
  const capabilities = createOperationRegistryCapabilityIssuer({
    registryId: 'address-test', datasetEpoch: EPOCH, processRunId: 'run', ownerId: 'owner', sameArtifact: () => false,
  });
  const registry = createOperationRegistry({
    capabilities, writeRunClaim: capabilities.issueWriteRunClaim('READ_ONLY'),
    assertOwnerCurrent: () => undefined, assertContinuationEvidence: () => undefined,
  });
  const rejected = () => plans.technical.issue('INVALID_REQUEST');
  const query = createLegacyQueryAdmissionCapability({
    validate: async () => ({ kind: 'REJECTED', response: rejected() }), query: async () => rejected(),
  });
  const rates = createFixedMinuteRateLedger({ clock: { nowMs: () => 0 } });
  const handler = createG07bAdmissionHandler({
    currentDatasetEpoch: EPOCH, registry, registryCapabilities: capabilities, responsePlans: plans,
    workHandoff: handoff, unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
    validator: query.validator, rates,
    work: {
      query: query.work.query, login: async () => rejected(),
      management: async () => ({ disposition: 'KNOWN_NO_EFFECT', response: rejected() }),
      recognition: async () => ({ disposition: 'KNOWN_NO_EFFECT', response: rejected() }),
    },
  });
  const business = (request: IncomingMessage, response: ServerResponse) => handler(
    { method: 'POST', body: null, query: [], headers: {} }, request as never, response as never, () => undefined,
  );
  return { business, rates };
}

function request(peer: string, forwarded: string | string[] | undefined): IncomingMessage {
  return { url: '/auth/login', originalUrl: '/auth/login', headers: { 'x-forwarded-for': forwarded },
    socket: { remoteAddress: peer } } as unknown as IncomingMessage;
}

afterEach(() => jest.restoreAllMocks());

describe('G11b private trusted ingress address reaches login rate identity', () => {
  test.each([
    [PROXY, '198.51.100.1', '198.51.100.1'],
    [`::ffff:${PROXY}`, '2001:db8::1', '2001:db8::1'],
    ['198.51.100.2', '198.51.100.1', '198.51.100.2'],
    [PROXY, 'invalid', PROXY],
    [PROXY, '198.51.100.1,198.51.100.2', PROXY],
    [PROXY, ['198.51.100.1'], PROXY],
    [PROXY, undefined, PROXY],
  ])('peer=%s forwarded=%s uses verified rate key %s', async (peer, forwarded, expected) => {
    const admission = loginAdmission();
    // Exercise address plumbing independently of the claimed-bootstrap lifecycle.
    jest.spyOn(LocalServiceGate.prototype, 'isOpen').mockReturnValue(true);
    const wrapper = createG11bProductionHttpHandler(createOrdinaryReadOnlyServiceGate(), admission.business, PROXY);
    for (let index = 0; index < 6; index += 1) {
      const incoming = request(peer, forwarded);
      const response = new Response();
      wrapper(incoming, response as unknown as ServerResponse);
      await response.finished;
      expect(readTrustedIngressClientAddress(incoming)).toBe(expected);
      expect(incoming.socket.remoteAddress).toBe(peer);
      expect(response.statusCode).toBe(index < 5 ? 400 : 429);
    }
    expect(admission.rates.snapshot().login.keyCount).toBe(1);
  });

  test('two trusted clients get separate five-request quotas behind one proxy', async () => {
    const admission = loginAdmission();
    jest.spyOn(LocalServiceGate.prototype, 'isOpen').mockReturnValue(true);
    const wrapper = createG11bProductionHttpHandler(createOrdinaryReadOnlyServiceGate(), admission.business, PROXY);
    for (const client of ['198.51.100.1', '198.51.100.2']) {
      for (let index = 0; index < 6; index += 1) {
        const response = new Response();
        wrapper(request(PROXY, client), response as unknown as ServerResponse);
        await response.finished;
        expect(response.statusCode).toBe(index < 5 ? 400 : 429);
      }
    }
    expect(admission.rates.snapshot().login.keyCount).toBe(2);
  });

  test('standalone admission ignores forwarding headers and retains direct-peer quota', async () => {
    const admission = loginAdmission();
    for (let index = 0; index < 6; index += 1) {
      const incoming = request('198.51.100.3', `198.51.100.${index + 10}`);
      const response = new Response();
      admission.business(incoming, response as unknown as ServerResponse);
      await response.finished;
      expect(readTrustedIngressClientAddress(incoming)).toBeUndefined();
      expect(response.statusCode).toBe(index < 5 ? 400 : 429);
    }
    expect(admission.rates.snapshot().login.keyCount).toBe(1);
  });

  test('address provenance binds one exact request and rejects rebinding', () => {
    const incoming = request(PROXY, '198.51.100.1');
    bindTrustedIngressClientAddress(incoming, '198.51.100.1');
    expect(readTrustedIngressClientAddress({ ...incoming })).toBeUndefined();
    expect(() => bindTrustedIngressClientAddress(incoming, '198.51.100.2')).toThrow('already bound');
    expect(readTrustedIngressClientAddress(incoming)).toBe('198.51.100.1');
  });

  test('address authority stays private to the outer ingress and admission consumer', async () => {
    const root = join(process.cwd(), 'src');
    const importers: string[] = [];
    for (const file of (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.ts'))) {
      if ((await readFile(join(root, file), 'utf8')).includes('trusted-ingress-client-address.js')) importers.push(file);
    }
    expect(importers.sort()).toEqual([
      'composition/internal/g07b-admission-handler.ts',
      'deployment/internal/g11b-production-http-lifecycle.ts',
    ]);
    for (const file of ['index.ts', 'composition/index.ts', 'composition/internal/index.ts']) {
      const source = await readFile(join(root, file), 'utf8');
      expect(source).not.toMatch(/trusted-ingress-client-address|bindTrustedIngressClientAddress|readTrustedIngressClientAddress/u);
    }
  });
});
