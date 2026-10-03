import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { G04B_STARTUP_VECTORS } from '../../src/infrastructure/mongo/g04b-schema.js';
import type { ConsumedRunTicket } from '../../src/deployment/internal/g11b-run-ticket-intake.js';
import type {
  VerifiedDataset,
  VerifiedDatasetVerifier,
} from '../../src/deployment/internal/g11b-dataset-verification.js';
import {
  BootstrapReceipt,
  ClaimedRuntimeBootstrap,
  ClaimedRuntimeBootstrapError,
  LocalServiceGate,
  ProductionCompositionProof,
  RegistryAuthority,
  RegistryCompositionReceipt,
  createClaimedRuntimeBootstrap,
  createOrdinaryReadOnlyServiceGate,
  completeClaimedRuntimeProductionComposition,
  type ClaimedRuntimeBootstrapClaim,
  type ClaimedRuntimeBootstrapClaimer,
  type RegistryCompositionOptions,
} from '../../src/composition/internal/g11b-claimed-runtime-bootstrap.js';
import { createG10aAdmissionRuntimeComposition, type G10aAdmissionRuntimeComposition } from '../../src/composition/internal/g10a-admission-runtime-composition.js';
import { createG10aRuntimeHttpApplication, type G10aRuntimeHttpApplication } from '../../src/composition/internal/g10a-runtime-http-application.js';
import { createG10aRuntimeOwner } from '../../src/composition/internal/g10a-runtime-owner.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../src/runtime/internal/runtime-control-socket-path.js';
import { createLegacyQueryAdmissionCapability } from '../../src/composition/internal/query-admission-binding.js';
import { createAdmissionWorkHandoffBundle, createHttpResponsePlanBundle, createUnknownRecognitionCoordinatorBundle } from '../../src/composition/internal/index.js';
import { createG11bProductionHttpHandler } from '../../src/deployment/internal/g11b-production-http-lifecycle.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createVerifiedDatasetVerifierForTest } from '../support/g11b-dataset-verification-test-support.js';
import {
  createPersistentRunClaimerForTest,
} from '../support/g11b-persistent-run-claim-test-support.js';
import { createG11bRunTicketIntakeForFsTest } from '../support/g11b-run-ticket-test-support.js';

const temporaryDirectories: string[] = [];
const applications: G10aRuntimeHttpApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
  const results = await Promise.allSettled(temporaryDirectories.splice(0).map(async (directory) => {
    if (!directory.startsWith(join(tmpdir(), 'passhub-b4-'))) throw new Error('unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'b4 temporary cleanup failed');
});

function metadata(epoch: string, runId: string) {
  return {
    _id: 'system', kind: 'system', datasetEpoch: epoch,
    comparisonReferenceId: '33333333-3333-4333-8333-333333333333', frameVersion: 'v2',
    startupVectors: G04B_STARTUP_VECTORS.map((vector) => ({ ...vector })),
    qrGuardVersion: 0, faceGuardVersion: 0, slotCount: 0,
    writeRunClaim: { runId, claimedAt: new Date(1234) },
  };
}

async function ticket(epoch: string, runId: string): Promise<{
  readonly consumed: ConsumedRunTicket;
  readonly ticketId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'passhub-b4-'));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const ticketId = randomUUID();
  const path = join(directory, 'bootstrap-ticket.json');
  await writeFile(path, `${JSON.stringify({
    v: 'g11b.run-ticket.v1', ticketId, datasetEpoch: epoch, processRunId: runId,
  })}\n`, { mode: 0o400 });
  await chmod(path, 0o400);
  return {
    consumed: await createG11bRunTicketIntakeForFsTest(directory)(runId),
    ticketId,
  };
}

interface ClaimContext {
  readonly target: object;
  readonly verifier: VerifiedDatasetVerifier;
  readonly verified: VerifiedDataset;
  readonly ticket: ConsumedRunTicket;
  readonly ticketId: string;
  readonly claimer: ClaimedRuntimeBootstrapClaimer;
  readonly claim: ClaimedRuntimeBootstrapClaim;
  readonly epoch: string;
  readonly runId: string;
}

async function claimContext(): Promise<ClaimContext> {
  const target = Object.freeze({ target: randomUUID() });
  const epoch = randomUUID();
  const runId = randomUUID();
  const verifier = createVerifiedDatasetVerifierForTest(target, () => metadata(epoch, runId));
  const verified = await verifier.verify();
  const issuedTicket = await ticket(epoch, runId);
  const claimer = createPersistentRunClaimerForTest(target, verifier, {
    compareAndSet: async () => metadata(epoch, runId),
    classifyAfterNoMatch: async () => null,
  });
  const outcome = await claimer.claimOnce(verified, issuedTicket.consumed);
  if (outcome.status !== 'CLAIMED') throw new Error('claim fixture failed');
  return {
    target, verifier, verified, ticket: issuedTicket.consumed, ticketId: issuedTicket.ticketId,
    claimer, claim: outcome.claim, epoch, runId,
  };
}

function createBootstrap(ctx: ClaimContext) {
  return createClaimedRuntimeBootstrap(
    ctx.claimer, ctx.claim, ctx.target, ctx.verifier, ctx.verified, ctx.ticket,
  );
}

function registryOptions(overrides: Partial<RegistryCompositionOptions> = {}): RegistryCompositionOptions {
  return {
    registryId: `registry-${randomUUID()}`,
    ownerId: `owner-${randomUUID()}`,
    sameArtifact: (left, right) => left === right,
    assertOwnerCurrent: () => undefined,
    assertContinuationEvidence: () => undefined,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('expected bootstrap error');
  } catch (error) {
    expect(error).toBeInstanceOf(ClaimedRuntimeBootstrapError);
    expect(error).toMatchObject({ code, message: code });
    expect(error).not.toHaveProperty('cause');
  }
}

function compose(bundle: ReturnType<typeof createBootstrap>) {
  return bundle.bootstrap.takeRegistryAuthority().composeRegistry(registryOptions());
}

async function completedComposition() {
  const ctx = await claimContext();
  const bundle = createBootstrap(ctx);
  const registry = compose(bundle);
  const directory = await mkdtemp(join(tmpdir(), 'passhub-b4-'));
  temporaryDirectories.push(directory);
  const owner = createG10aRuntimeOwner({
    epoch: ctx.epoch, run: ctx.runId,
    logDirectory: join(directory, 'logs'), controlDirectory: join(directory, 'control'),
    controlSocketPath: join(directory, 'control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
    monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
  });
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: ctx.epoch });
  const handoff = createAdmissionWorkHandoffBundle();
  const query = createLegacyQueryAdmissionCapability({
    validate: async () => ({ kind: 'REJECTED', response: plans.technical.issue('INVALID_REQUEST') }),
    query: async () => plans.technical.issue('INVALID_REQUEST'),
  });
  let admission!: G10aAdmissionRuntimeComposition;
  const application = await createG10aRuntimeHttpApplication({
    runtimeOwner: owner,
    createAcceptedHandler(runtime) {
      admission = createG10aAdmissionRuntimeComposition({
        epoch: ctx.epoch, run: ctx.runId, runtime,
        monotonicClock: { nowMs: () => performance.now() }, awaitObservation: () => undefined,
        admission: {
          currentDatasetEpoch: ctx.epoch, registry: registry.registry, registryCapabilities: registry.capabilities,
          responsePlans: plans, workHandoff: handoff, validator: query.validator,
          unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
          work: {
            query: query.work.query,
            login: async () => plans.technical.issue('INVALID_REQUEST'),
            management: async () => ({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
            recognition: async () => ({ disposition: 'KNOWN_NO_EFFECT', response: plans.technical.issue('INVALID_REQUEST') }),
          },
        },
      });
      return admission.handler;
    },
  });
  applications.push(application);
  return { ctx, bundle, registry, admission, application, owner,
    proof: () => completeClaimedRuntimeProductionComposition(bundle.bootstrap, registry.registryReceipt, admission, application) };
}

describe('G11b-b4a claimed provenance and nominal G05c bridge', () => {
  test('exact six-element provenance produces one genuine WRITABLE registry authority', async () => {
    const ctx = await claimContext();
    const bundle = createBootstrap(ctx);
    expect(bundle.bootstrap).toBeInstanceOf(ClaimedRuntimeBootstrap);
    expect(bundle.serviceGate).toBeInstanceOf(LocalServiceGate);
    expect(bundle.serviceGate.getState()).toBe('COMPOSING');
    expect(bundle.serviceGate.isOpen()).toBe(false);

    const authority = bundle.bootstrap.takeRegistryAuthority();
    expect(authority).toBeInstanceOf(RegistryAuthority);
    const composition = authority.composeRegistry(registryOptions());
    expect(composition.registry.snapshot()).toMatchObject({
      datasetEpoch: ctx.epoch,
      processRunId: ctx.runId,
      claimDisposition: 'WRITABLE',
    });
    expect(composition.registry.assertComposition(composition.capabilities)).toMatchObject({
      datasetEpoch: ctx.epoch,
      claimDisposition: 'WRITABLE',
    });
    expect(composition.registryReceipt).toBeInstanceOf(RegistryCompositionReceipt);
    expect(JSON.stringify(composition)).not.toContain(ctx.ticketId);
  });

  test('each foreign or forged member of the exact six-element provenance is rejected', async () => {
    const first = await claimContext();
    const second = await claimContext();
    const valid = [first.claimer, first.claim, first.target, first.verifier, first.verified, first.ticket] as const;
    const invalidRows: readonly unknown[][] = [
      [second.claimer, ...valid.slice(1)],
      [first.claimer, second.claim, ...valid.slice(2)],
      [first.claimer, first.claim, second.target, ...valid.slice(3)],
      [first.claimer, first.claim, first.target, second.verifier, first.verified, first.ticket],
      [first.claimer, first.claim, first.target, first.verifier, second.verified, first.ticket],
      [first.claimer, first.claim, first.target, first.verifier, first.verified, second.ticket],
      [first.claimer, Object.freeze({}), first.target, first.verifier, first.verified, first.ticket],
    ];
    for (const row of invalidRows) {
      expectCode(() => createClaimedRuntimeBootstrap(...row as Parameters<typeof createClaimedRuntimeBootstrap>),
        'CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
    }
    expect(createBootstrap(first).serviceGate.getState()).toBe('COMPOSING');
  });

  test('a claimed capability is globally one-use for bootstrap construction', async () => {
    const ctx = await claimContext();
    createBootstrap(ctx);
    expectCode(() => createBootstrap(ctx), 'CLAIMED_RUNTIME_BOOTSTRAP_ALREADY_USED');
  });

  test('authority take and registry composition are each exact once and fail closed', async () => {
    const first = createBootstrap(await claimContext());
    first.bootstrap.takeRegistryAuthority();
    expectCode(() => first.bootstrap.takeRegistryAuthority(), 'REGISTRY_AUTHORITY_ALREADY_USED');
    expect(first.serviceGate.getState()).toBe('FAILED');

    const second = createBootstrap(await claimContext());
    const authority = second.bootstrap.takeRegistryAuthority();
    authority.composeRegistry(registryOptions());
    expectCode(() => authority.composeRegistry(registryOptions()), 'REGISTRY_AUTHORITY_ALREADY_USED');
    expect(second.serviceGate.getState()).toBe('FAILED');
  });

  test('registry construction failures are sanitized and permanently close the gate', async () => {
    const secret = 'not-for-errors';
    const bundle = createBootstrap(await claimContext());
    const authority = bundle.bootstrap.takeRegistryAuthority();
    try {
      authority.composeRegistry(registryOptions({ registryId: secret, ownerId: '' }));
      throw new Error('expected composition failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'REGISTRY_COMPOSITION_FAILED', message: 'REGISTRY_COMPOSITION_FAILED' });
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
    expect(bundle.serviceGate.getState()).toBe('FAILED');
  });
});

describe('G11b-b4b bootstrap receipt and local service gate', () => {
  test('production raw gate returns 503 until authorizeReady, then real business response, and closes on shutdown', async () => {
    const composed = await completedComposition();
    const business = jest.fn((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(200);
      response.end(JSON.stringify({ business: true }));
    });
    const handler = createG11bProductionHttpHandler(composed.bundle.serviceGate, business, '172.31.211.10');
    const invoke = (url: string, peer = '127.0.0.1') => {
      let status = 0;
      let wire = '';
      const response = {
        writeHead: (code: number) => { status = code; }, end: (body: string) => { wire = body; },
      } as unknown as ServerResponse;
      handler({ url, headers: {}, socket: { remoteAddress: peer } } as IncomingMessage, response);
      return { status, body: JSON.parse(wire) as Record<string, unknown> };
    };
    expect(invoke('/internal/ready').status).toBe(503);
    expect(invoke('/qualifications').status).toBe(503);
    const receipt = composed.bundle.bootstrap.markCompositionComplete(composed.proof());
    expect(invoke('/internal/ready').status).toBe(503);
    composed.bundle.bootstrap.authorizeReady(receipt);
    expect(invoke('/internal/ready')).toEqual({ status: 200, body: { ready: true } });
    expect(invoke('/internal/ready', '172.31.211.10').status).toBe(404);
    expect(invoke('/qualifications')).toEqual({ status: 200, body: { business: true } });
    expect(business).toHaveBeenCalledTimes(1);
    composed.bundle.serviceGate.beginShutdown();
    expect(invoke('/internal/ready').status).toBe(503);
    expect(invoke('/qualifications').status).toBe(503);
    expect(business).toHaveBeenCalledTimes(1);
  });
  test('genuine completed composition issues opaque proof and receipt and opens exactly once', async () => {
    const composed = await completedComposition();
    const proof = composed.proof();
    expect(proof).toBeInstanceOf(ProductionCompositionProof);
    expect(composed.bundle.serviceGate.getState()).toBe('COMPOSING');
    const receipt = composed.bundle.bootstrap.markCompositionComplete(proof);
    expect(receipt).toBeInstanceOf(BootstrapReceipt);
    expect(composed.bundle.serviceGate.getState()).toBe('AUTHORIZABLE');
    for (const token of [proof, receipt]) {
      expect(Object.isFrozen(token)).toBe(true);
      expect(Reflect.ownKeys(token)).toEqual([]);
      expect(JSON.stringify(token)).toBe('{}');
    }
    composed.bundle.bootstrap.authorizeReady(receipt);
    expect(composed.bundle.serviceGate.isOpen()).toBe(true);
    expectCode(() => composed.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(composed.bundle.serviceGate.isOpen()).toBe(false);
  });

  test.each(['registry', 'admission', 'application'] as const)(
    'completion refuses foreign %s provenance against a fresh COMPOSING bootstrap', async (member) => {
    const first = await completedComposition();
    const foreign = await completedComposition();
    expect(first.bundle.serviceGate.getState()).toBe('COMPOSING');
    expectCode(() => completeClaimedRuntimeProductionComposition(
      first.bundle.bootstrap,
      member === 'registry' ? foreign.registry.registryReceipt : first.registry.registryReceipt,
      member === 'admission' ? foreign.admission : first.admission,
      member === 'application' ? foreign.application : first.application,
    ), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(first.bundle.serviceGate.getState()).toBe('FAILED');
    expect(foreign.bundle.serviceGate.getState()).toBe('COMPOSING');
  });

  test('completion refuses structural HTTP application against fresh COMPOSING bootstrap', async () => {
    const foreign = await completedComposition();
    expectCode(() => completeClaimedRuntimeProductionComposition(
      foreign.bundle.bootstrap, foreign.registry.registryReceipt, foreign.admission,
      { application: foreign.application.application, close: foreign.application.close },
    ), 'BOOTSTRAP_LIFECYCLE_INVALID');
  });

  test('genuine foreign proofs and receipts cannot open another bootstrap', async () => {
    const first = await completedComposition();
    const second = await completedComposition();
    const proof = first.proof();
    expectCode(() => second.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    const receipt = first.bundle.bootstrap.markCompositionComplete(proof);
    const third = await completedComposition();
    third.bundle.bootstrap.markCompositionComplete(third.proof());
    expect(third.bundle.serviceGate.getState()).toBe('AUTHORIZABLE');
    expectCode(() => third.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(third.bundle.serviceGate.getState()).toBe('FAILED');
    expect(first.bundle.serviceGate.getState()).toBe('AUTHORIZABLE');
    first.bundle.bootstrap.authorizeReady(receipt);
    expect(first.bundle.serviceGate.isOpen()).toBe(true);
  });

  test('proof mint and mark are one-use and genuine receipt remains stale after shutdown', async () => {
    const first = await completedComposition();
    first.proof();
    expectCode(first.proof, 'BOOTSTRAP_LIFECYCLE_INVALID');
    const second = await completedComposition();
    const proof = second.proof();
    const receipt = second.bundle.bootstrap.markCompositionComplete(proof);
    expectCode(() => second.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expectCode(() => second.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    const third = await completedComposition();
    const stale = third.bundle.bootstrap.markCompositionComplete(third.proof());
    third.bundle.serviceGate.beginShutdown();
    expectCode(() => third.bundle.bootstrap.authorizeReady(stale), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(third.bundle.serviceGate.getState()).toBe('SHUTDOWN');
  });

  test('actual HTTP application shutdown invalidates pending proof, receipt and open readiness', async () => {
    const pendingProof = await completedComposition();
    const proof = pendingProof.proof();
    await pendingProof.application.close();
    expectCode(() => pendingProof.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    const pendingReceipt = await completedComposition();
    const receipt = pendingReceipt.bundle.bootstrap.markCompositionComplete(pendingReceipt.proof());
    await pendingReceipt.application.close();
    expectCode(() => pendingReceipt.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    const open = await completedComposition();
    open.bundle.bootstrap.authorizeReady(open.bundle.bootstrap.markCompositionComplete(open.proof()));
    expect(open.bundle.serviceGate.isOpen()).toBe(true);
    const closing = open.application.close();
    expect(open.bundle.serviceGate.getState()).toBe('SHUTDOWN');
    await closing;
    const closed = await completedComposition();
    await closed.application.close();
    expectCode(closed.proof, 'BOOTSTRAP_LIFECYCLE_INVALID');
  });

  test.each(['nest', 'owner'] as const)('direct %s close invalidates a genuine pending proof', async (closer) => {
    const composed = await completedComposition();
    const proof = composed.proof();
    const closing = closer === 'nest'
      ? composed.application.application.nestApplication.close()
      : composed.owner.close();
    expectCode(() => composed.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(composed.bundle.serviceGate.isOpen()).toBe(false);
    await closing;
  });

  test.each(['nest', 'owner'] as const)('direct %s close invalidates a genuine AUTHORIZABLE receipt', async (closer) => {
    const composed = await completedComposition();
    const receipt = composed.bundle.bootstrap.markCompositionComplete(composed.proof());
    const closing = closer === 'nest'
      ? composed.application.application.nestApplication.close()
      : composed.owner.close();
    expectCode(() => composed.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    await closing;
  });

  test.each(['proof', 'receipt'] as const)('maintenance after %s issuance prevents authorization', async (stage) => {
    const composed = await completedComposition();
    const proof = composed.proof();
    const receipt = stage === 'receipt' ? composed.bundle.bootstrap.markCompositionComplete(proof) : undefined;
    const current = composed.admission.control.snapshot();
    await composed.admission.control.drain({
      requestControlId: randomUUID(), epoch: composed.ctx.epoch, run: composed.ctx.runId,
      expectedRevision: current.revision, timeoutMs: 100,
    });
    expect(composed.admission.control.snapshot().maintenance.active).toBe(true);
    if (receipt === undefined) {
      expectCode(() => composed.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    } else {
      expectCode(() => composed.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    }
    expect(composed.bundle.serviceGate.isOpen()).toBe(false);
  });

  test.each(['proof', 'receipt', 'open'] as const)('direct HTTP server close invalidates %s lifecycle', async (stage) => {
    const composed = await completedComposition();
    await composed.application.application.nestApplication.listen(0, '127.0.0.1');
    const proof = composed.proof();
    const receipt = stage !== 'proof' ? composed.bundle.bootstrap.markCompositionComplete(proof) : undefined;
    if (stage === 'open' && receipt !== undefined) composed.bundle.bootstrap.authorizeReady(receipt);
    const closing = new Promise<void>((resolve, reject) => {
      composed.application.application.server.close((error) => error === undefined ? resolve() : reject(error));
    });
    if (stage === 'proof') {
      expectCode(() => composed.bundle.bootstrap.markCompositionComplete(proof), 'BOOTSTRAP_LIFECYCLE_INVALID');
    } else if (stage === 'receipt' && receipt !== undefined) {
      expectCode(() => composed.bundle.bootstrap.authorizeReady(receipt), 'BOOTSTRAP_LIFECYCLE_INVALID');
    } else {
      expect(composed.bundle.serviceGate.getState()).toBe('SHUTDOWN');
    }
    expect(composed.bundle.serviceGate.isOpen()).toBe(false);
    await closing;
  });
  test('registry-only receipt cannot mark production composition complete or authorize ready', async () => {
    const bundle = createBootstrap(await claimContext());
    const composition = compose(bundle);
    expect(bundle.serviceGate.getState()).toBe('COMPOSING');
    expect(composition.registryReceipt).toBeInstanceOf(RegistryCompositionReceipt);
    expectCode(() => bundle.bootstrap.markCompositionComplete(
      composition.registryReceipt as unknown as ProductionCompositionProof,
    ), 'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(bundle.serviceGate.getState()).toBe('FAILED');
    expect(bundle.serviceGate.isOpen()).toBe(false);
  });

  test('forged, structural, and prototype-only production composition proofs reject permanently', async () => {
    for (const forged of [Object.freeze({}), Object.create(ProductionCompositionProof.prototype)]) {
      const bundle = createBootstrap(await claimContext());
      compose(bundle);
      expectCode(() => bundle.bootstrap.markCompositionComplete(forged as ProductionCompositionProof),
        'BOOTSTRAP_LIFECYCLE_INVALID');
      expect(bundle.serviceGate.getState()).toBe('FAILED');
      expect(bundle.serviceGate.isOpen()).toBe(false);
    }
    expectCode(() => new ProductionCompositionProof(Symbol('forged')), 'CLAIMED_RUNTIME_BOOTSTRAP_INVALID');
  });

  test('genuine unused registry receipt rejects on early authorize and remains stale after shutdown', async () => {
    const early = createBootstrap(await claimContext());
    const earlyReceipt = compose(early).registryReceipt;
    expectCode(() => early.bootstrap.authorizeReady(earlyReceipt as unknown as BootstrapReceipt),
      'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(early.serviceGate.getState()).toBe('FAILED');
    expect(early.serviceGate.isOpen()).toBe(false);

    const stale = createBootstrap(await claimContext());
    const staleReceipt = compose(stale).registryReceipt;
    stale.serviceGate.beginShutdown();
    expectCode(() => stale.bootstrap.authorizeReady(staleReceipt as unknown as BootstrapReceipt),
      'BOOTSTRAP_LIFECYCLE_INVALID');
    expect(stale.serviceGate.getState()).toBe('SHUTDOWN');
    expect(stale.serviceGate.isOpen()).toBe(false);
  });

  test('beginShutdown is synchronous, idempotent, and irreversible', async () => {
    const composing = createBootstrap(await claimContext());
    composing.serviceGate.beginShutdown();
    expect(composing.serviceGate.getState()).toBe('SHUTDOWN');
    composing.serviceGate.beginShutdown();
    expectCode(() => composing.bootstrap.takeRegistryAuthority(), 'REGISTRY_AUTHORITY_ALREADY_USED');
    expect(composing.serviceGate.getState()).toBe('SHUTDOWN');
  });

  test('ordinary boot exposes only a permanently closed read-only gate', () => {
    const gate = createOrdinaryReadOnlyServiceGate();
    expect(gate).toBeInstanceOf(LocalServiceGate);
    expect(gate.getState()).toBe('FAILED');
    expect(gate.isOpen()).toBe(false);
    expect(Reflect.ownKeys(gate)).toEqual([]);
    gate.beginShutdown();
    expect(gate.getState()).toBe('SHUTDOWN');
    expect(gate.isOpen()).toBe(false);
  });

  test('all authority tokens are frozen, opaque, and carry no claim facts', async () => {
    const ctx = await claimContext();
    const bundle = createBootstrap(ctx);
    const authority = bundle.bootstrap.takeRegistryAuthority();
    const composition = authority.composeRegistry(registryOptions());
    for (const token of [bundle.bootstrap, bundle.serviceGate, authority, composition.registryReceipt]) {
      expect(Object.isFrozen(token)).toBe(true);
      expect(Reflect.ownKeys(token)).toEqual([]);
      expect(JSON.stringify(token)).toBe('{}');
      expect(JSON.stringify(token)).not.toContain(ctx.ticketId);
      expect(JSON.stringify(token)).not.toContain(ctx.runId);
      expect(JSON.stringify(token)).not.toContain(ctx.epoch);
    }
  });
});

describe('G11b-b4 private boundaries', () => {
  test('engine, fixed production composition importers, public barrels and sole WRITABLE mint are locked', async () => {
    const engineName = ['g11b', 'claimed', 'runtime', 'bootstrap', 'engine'].join('-');
    const facadeName = ['g11b', 'claimed', 'runtime', 'bootstrap'].join('-');
    const importers: string[] = [];
    for (const rootName of ['src', 'test']) {
      const root = join(process.cwd(), rootName);
      for (const name of (await readdir(root, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
        if ((await readFile(join(root, name), 'utf8')).includes(engineName)) importers.push(`${rootName}/${name}`);
      }
    }
    expect(importers).toEqual(['src/composition/internal/g11b-claimed-runtime-bootstrap.ts']);
    const productionFacadeImporters: string[] = [];
    const writableMinters: Array<{ readonly path: string; readonly count: number }> = [];
    const sourceRoot = join(process.cwd(), 'src');
    for (const name of (await readdir(sourceRoot, { recursive: true })).filter((entry) => entry.endsWith('.ts'))) {
      const source = await readFile(join(sourceRoot, name), 'utf8');
      if (source.includes(`${facadeName}.js`)) productionFacadeImporters.push(`src/${name}`);
      const count = source.split('.issueWriteRunClaim(').length - 1;
      if (count > 0) writableMinters.push({ path: `src/${name}`, count });
    }
    expect(productionFacadeImporters.sort()).toEqual([
      'src/deployment/internal/g11b-production-application.ts',
      'src/deployment/internal/g11b-production-http-lifecycle.ts',
    ]);
    expect(writableMinters).toEqual([{
      path: 'src/composition/internal/g11b-claimed-runtime-bootstrap.ts', count: 1,
    }]);
    const facade = await readFile(
      join(process.cwd(), 'src/composition/internal/g11b-claimed-runtime-bootstrap.ts'),
      'utf8',
    );
    expect(facade.split(".issueWriteRunClaim('WRITABLE')").length - 1).toBe(1);
    for (const barrel of [
      'src/index.ts', 'src/composition/index.ts', 'src/composition/internal/index.ts',
      'src/infrastructure/mongo/index.ts', 'src/access/application/internal/index.ts',
    ]) {
      const source = await readFile(join(process.cwd(), barrel), 'utf8');
      expect(source).not.toContain(facadeName);
      expect(source).not.toContain('ClaimedRuntimeBootstrap');
    }
    const productionMain = await readFile(join(process.cwd(), 'src/deployment/production-main.ts'), 'utf8');
    expect(productionMain).not.toContain(facadeName);
    expect(productionMain).not.toContain('authorizeReady');
    const engine = await readFile(
      join(process.cwd(), `src/composition/internal/${engineName}.ts`), 'utf8',
    );
    expect(engine.split('productionProofStates.set').length - 1).toBe(1);
    expect(engine.split('new ProductionCompositionProof').length - 1).toBe(1);
  });

  test('engine has no Mongo, HTTP, ready route, reset, ticket parsing, or arbitrary WRITABLE mint', async () => {
    const engineName = ['g11b', 'claimed', 'runtime', 'bootstrap', 'engine'].join('-');
    const source = await readFile(
      join(process.cwd(), `src/composition/internal/${engineName}.ts`),
      'utf8',
    );
    for (const forbidden of [
      'MongoClient', 'findOneAndUpdate', 'ensureG04bSchema', 'deleteMany', 'createServer',
      '/internal/ready', 'bootstrap-ticket.json', "issueWriteRunClaim('WRITABLE')",
    ]) expect(source).not.toContain(forbidden);
  });
});
