import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { MongoClient } from 'mongodb';

import { createHumanAuth } from '../../auth/application/index.js';
import { MongoHumanAccountReader, NodeScryptPasswordDeriver } from '../../auth/infrastructure/index.js';
import { G04bMongoPersistenceAdapter } from '../../infrastructure/mongo/g04b-persistence-adapter.js';
import { G04B_STARTUP_VECTORS, type G04bMetadataDocument, type G04bSourceDocument } from '../../infrastructure/mongo/g04b-schema.js';
import { activateG11bExistingSchema, readG11bExistingSchemaDatabase } from '../../infrastructure/mongo/internal/g11b-existing-schema-activation.js';
import { createAccessComposition } from '../../composition/access-composition.js';
import { createSourceAuthComposition } from '../../composition/internal/source-auth-composition.js';
import { createAdmissionWorkHandoffBundle } from '../../composition/internal/admission-work-handoff.js';
import { createHttpResponsePlanBundle } from '../../composition/internal/http-response-plan.js';
import { createG08aManagementComposition } from '../../composition/internal/g08a-management-composition.js';
import { createG08bRecognitionComposition } from '../../composition/internal/g08b-recognition-composition.js';
import { createG09aQueryComposition } from '../../composition/internal/g09a-query-composition.js';
import { createQueryApplication } from '../../access/application/query-application.js';
import { createSourceBoundRecognitionExecutorFactory } from '../../composition/internal/source-bound-recognition.js';
import { createWriterQuiescence } from '../../composition/internal/writer-quiescence.js';
import { createG07bRouteComposition } from '../../composition/internal/g07b-route-composition.js';
import { createUnknownRecognitionCoordinatorBundle } from '../../composition/internal/unknown-recognition-coordinator.js';
import { createG10aRuntimeOwner } from '../../composition/internal/g10a-runtime-owner.js';
import { createG10aRuntimeHttpApplication, type G10aRuntimeHttpApplication } from '../../composition/internal/g10a-runtime-http-application.js';
import { createG10aAdmissionRuntimeComposition, type G10aAdmissionRuntimeComposition } from '../../composition/internal/g10a-admission-runtime-composition.js';
import { createClaimedRuntimeBootstrap, completeClaimedRuntimeProductionComposition, createOrdinaryReadOnlyServiceGate, type LocalServiceGate } from '../../composition/internal/g11b-claimed-runtime-bootstrap.js';
import { RUNTIME_CONTROL_SOCKET_FILE_NAME } from '../../runtime/internal/runtime-control-socket-path.js';
import { createVerifiedComparisonPort, verifyStartupVectorsAndCreateComparisonCapability } from '../../access/application/comparison/index.js';
import { createVerifiedDatasetVerifier, readVerifiedDatasetForRuntime } from './g11b-dataset-verification.js';
import { createPersistentRunClaimer } from './g11b-persistent-run-claim.js';
import { readCanonicalProcessRunId } from './g11b-process-identity-intake.js';
import { consumeCanonicalRunTicket, RunTicketIntakeError } from './g11b-run-ticket-intake.js';
import { sameG11bProductionComparisonArtifact } from './g11b-production-comparison.js';
import { createG11bProductionLoginDelegate } from './g11b-production-login.js';

export class G11bProductionAuthorityError extends Error {
  constructor(readonly code: 'CLAIM_HELD' | 'EPOCH_MISMATCH' | 'METADATA_MISSING_OR_INVALID' | 'CLAIM_UNKNOWN') {
    super('PRODUCTION_AUTHORITY_UNAVAILABLE');
    this.name = 'G11bProductionAuthorityError';
  }
}

export interface G11bProductionApplication {
  readonly application: G10aRuntimeHttpApplication | null;
  readonly serviceGate: LocalServiceGate;
  close(): Promise<void>;
}

/** All budget/runtime owners share non-decreasing integer milliseconds. */
export function createG11bProductionMonotonicClock() {
  return Object.freeze({ nowMs: () => Math.floor(performance.now()) });
}

/** Fixed private production root. Caller provides already validated deployment secrets only. */
export async function createG11bProductionApplication(
  mongo: MongoClient,
  jwtKey: Buffer,
  comparisonKey: Buffer,
): Promise<G11bProductionApplication> {
  const monotonicClock = createG11bProductionMonotonicClock();
  const run = await readCanonicalProcessRunId();
  const adapter = new G04bMongoPersistenceAdapter(mongo, 'passhub_demo', { nowMs: Date.now });
  const database = readG11bExistingSchemaDatabase(adapter);
  const verifier = createVerifiedDatasetVerifier(database);
  const verified = await verifier.verify();
  const facts = readVerifiedDatasetForRuntime(verifier, verified, database);
  let ticket;
  try {
    ticket = await consumeCanonicalRunTicket(run);
  } catch (error) {
    if (!(error instanceof RunTicketIntakeError) || error.code !== 'TICKET_NOT_PROVEN') throw error;
    return Object.freeze({ application: null, serviceGate: createOrdinaryReadOnlyServiceGate(), close: async () => undefined });
  }
  const claimer = createPersistentRunClaimer(database, verifier);
  const claimed = await claimer.claimOnce(verified, ticket);
  if (claimed.status !== 'CLAIMED') throw new G11bProductionAuthorityError(claimed.status);
  const bundle = createClaimedRuntimeBootstrap(claimer, claimed.claim, database, verifier, verified, ticket);
  let ownedApplication: G10aRuntimeHttpApplication | undefined;
  try {
  activateG11bExistingSchema(adapter, verifier, verified);
  const metadata = await database.collection<G04bMetadataDocument>('metadata').findOne({ _id: 'system' }, {
    readConcern: { level: 'majority' }, readPreference: 'primary', timeoutMS: 2_000,
  });
  if (metadata === null || metadata.datasetEpoch !== facts.datasetEpoch) throw new Error('production metadata unavailable');
  const vectorInputs = [
    { kind: 'QR_SCANNED', token: 'A' },
    { kind: 'FACE_MATCHED', provider: 'DemoFace', externalSubjectId: '中😀' },
    { kind: 'FACE_UNKNOWN' },
  ];
  const comparison = createVerifiedComparisonPort(verifyStartupVectorsAndCreateComparisonCapability({
    hmacKey: comparisonKey, comparisonReferenceId: metadata.comparisonReferenceId,
    vectors: G04B_STARTUP_VECTORS.map((vector, index) => ({ ...vector, input: vectorInputs[index] })),
  }));
  const auth = createHumanAuth({
    accountReader: new MongoHumanAccountReader(database.collection('users')),
    passwordDeriver: new NodeScryptPasswordDeriver(), jwtKey,
  });
  const sourceAuth = createSourceAuthComposition(database.collection<G04bSourceDocument>('sources')).sourceAuth;
  const plans = createHttpResponsePlanBundle({ currentDatasetEpoch: facts.datasetEpoch });
  const handoff = createAdmissionWorkHandoffBundle();
  const registry = bundle.bootstrap.takeRegistryAuthority().composeRegistry({
    registryId: randomUUID(), ownerId: randomUUID(),
    sameArtifact: sameG11bProductionComparisonArtifact,
    assertOwnerCurrent: () => {
      if (bundle.serviceGate.getState() === 'SHUTDOWN' || bundle.serviceGate.getState() === 'FAILED') throw new Error('production owner unavailable');
    },
    assertContinuationEvidence: () => undefined,
  });
  const quiescence = createWriterQuiescence({ clock: monotonicClock });
  const access = createAccessComposition({ management: adapter, query: adapter, epoch: facts.datasetEpoch });
  const management = createG08aManagementComposition({ auth, manageQualifications: access.manageQualifications, responsePlans: plans, workHandoff: handoff });
  const query = createG09aQueryComposition({
    auth, currentDatasetEpoch: facts.datasetEpoch, responsePlans: plans, workHandoff: handoff, writerQuiescence: quiescence,
    queryApplication: createQueryApplication({ data: adapter, writerQuiescence: quiescence, epoch: facts.datasetEpoch }),
  });
  const recognition = createG08bRecognitionComposition({
    sourceAuth, comparison, registryCapabilities: registry.capabilities, responsePlans: plans, workHandoff: handoff,
    recognizeAttempt: createSourceBoundRecognitionExecutorFactory({ recognition: adapter, sourceFacts: adapter, epoch: facts.datasetEpoch, comparison }),
  });
  const routes = createG07bRouteComposition({
    login: createG11bProductionLoginDelegate(auth, plans, handoff),
    query,
    management: { validate: management.validator.validate, management: management.work.management },
    recognition: { validate: recognition.validator.validate, recognition: recognition.work.recognition },
  });
  const owner = createG10aRuntimeOwner({
    epoch: facts.datasetEpoch, run, logDirectory: '/run/passhub/api/logs', controlDirectory: '/run/passhub/api/control',
    controlSocketPath: join('/run/passhub/api/control', RUNTIME_CONTROL_SOCKET_FILE_NAME),
    monotonicClock, awaitObservation: (remaining) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 10))),
  });
  let admission!: G10aAdmissionRuntimeComposition;
  const application = await createG10aRuntimeHttpApplication({
    runtimeOwner: owner,
    createAcceptedHandler: (runtime) => {
      admission = createG10aAdmissionRuntimeComposition({
        epoch: facts.datasetEpoch, run, runtime, g10cMongoAdapter: adapter,
        monotonicClock, awaitObservation: (remaining) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 10))),
        admission: {
          currentDatasetEpoch: facts.datasetEpoch, registry: registry.registry, registryCapabilities: registry.capabilities,
          monotonicClock,
          responsePlans: plans, workHandoff: handoff, validator: routes.validator, work: routes.work,
          writerQuiescence: quiescence, unknownRecognition: createUnknownRecognitionCoordinatorBundle().handler,
        },
      });
      return admission.handler;
    },
  });
  ownedApplication = application;
  try {
    const proof = completeClaimedRuntimeProductionComposition(bundle.bootstrap, registry.registryReceipt, admission, application);
    const receipt = bundle.bootstrap.markCompositionComplete(proof);
    bundle.bootstrap.authorizeReady(receipt);
  } catch (error) {
    bundle.serviceGate.beginShutdown();
    await application.close().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    application, serviceGate: bundle.serviceGate,
    async close() {
      bundle.serviceGate.beginShutdown();
      await application.close();
    },
  });
  } catch {
    bundle.serviceGate.beginShutdown();
    await ownedApplication?.close().catch(() => undefined);
    return Object.freeze({
      application: null, serviceGate: bundle.serviceGate, close: async () => undefined,
    });
  }
}
